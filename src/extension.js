/* extension.js — Cardwire GPU Mode Quick Settings toggle
 *
 * Talks to the cardwired system daemon over D-Bus:
 *   bus name : com.github.opengamingcollective.cardwire
 *   path     : /com/github/opengamingcollective/cardwire
 *   iface    : com.github.opengamingcollective.cardwire
 *
 * Methods used:
 *   GetMode() -> s         (returns "Current Mode: Integrated"-style string)
 *   SetMode(s)             (accepts lowercase "integrated" | "hybrid" | "manual")
 *
 * Reactive updates:
 *   Primary   : Gio.FileMonitor on /var/lib/cardwire/cardwire.toml
 *   Fallback  : poll GetMode every POLL_FALLBACK_SECONDS if the file isn't readable
 *
 * No Polkit / pkexec required — cardwired's D-Bus policy is open to the system bus.
 */

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { QuickMenuToggle, SystemIndicator } from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const BUS_NAME      = 'com.github.opengamingcollective.cardwire';
const OBJECT_PATH   = '/com/github/opengamingcollective/cardwire';
const INTERFACE     = 'com.github.opengamingcollective.cardwire';

const STATE_FILE    = '/var/lib/cardwire/cardwire.toml';
const POLL_FALLBACK_SECONDS = 5;

/* Three modes the daemon supports. Order here is the order they appear in the
 * sub-menu. Keep ids lowercase — that's what SetMode wants. */
const MODES = [
    { id: 'integrated', label: _('Integrated'), icon: 'cardwire-integrated-symbolic' },
    { id: 'hybrid',     label: _('Hybrid'),     icon: 'cardwire-hybrid-symbolic'     },
    { id: 'manual',     label: _('Manual'),     icon: 'cardwire-manual-symbolic'     },
];

/* cardwire is inconsistent about casing and prefixes:
 *   GetMode D-Bus return : "Current Mode: Integrated"
 *   TOML state file      : mode = "Hybrid"
 *   SetMode input        : "integrated"
 * Normalize everything to lowercase ids. */
function parseMode(text) {
    if (!text) return null;
    const m = String(text).match(/(integrated|hybrid|manual)/i);
    return m ? m[1].toLowerCase() : null;
}

const CardwireToggle = GObject.registerClass(
class CardwireToggle extends QuickMenuToggle {
    _init() {
        super._init({
            title: _('GPU Mode'),
            iconName: 'video-display-symbolic',
            toggleMode: false,   // we drive `checked` from daemon state, not the click
        });

        this._currentMode  = null;
        this._proxy        = null;
        this._fileMonitor  = null;
        this._fileMonitorChangedId = 0;
        this._pollSourceId = 0;
        this._ownerChangedId = 0;
        this._inFlight     = false;   // suppress click-spam during a SetMode round-trip
        this._modeItems    = new Map();

        // Header on the sub-menu — opens when the user clicks the right-side arrow
        this.menu.setHeader('video-display-symbolic', _('GPU Mode'),
            _('Switch between integrated and discrete GPU modes'));

        // Radio-style mode items
        for (const m of MODES) {
            const item = new PopupMenu.PopupMenuItem(m.label);
            item.connect('activate', () => {
                this.menu.close();
                this._setMode(m.id);
            });
            this.menu.addMenuItem(item);
            this._modeItems.set(m.id, item);
        }

        // Click on the toggle body (not the arrow) cycles integrated <-> hybrid.
        // Manual is reachable only via the sub-menu — it's a power-user mode.
        this.connect('clicked', () => {
            if (this._inFlight) return;
            const next = this._currentMode === 'integrated' ? 'hybrid' : 'integrated';
            this._setMode(next);
        });

        this._initProxy().catch(e => logError(e, 'cardwire: initProxy failed'));
    }

    async _initProxy() {
        this._proxy = await new Promise((resolve, reject) => {
            Gio.DBusProxy.new(
                Gio.DBus.system,
                Gio.DBusProxyFlags.NONE,
                null,
                BUS_NAME, OBJECT_PATH, INTERFACE,
                null,
                (src, res) => {
                    try { resolve(Gio.DBusProxy.new_finish(res)); }
                    catch (e) { reject(e); }
                });
        });

        // Daemon may come and go (e.g. cardwired restart); track ownership
        this._ownerChangedId = this._proxy.connect(
            'notify::g-name-owner', () => this._onOwnerChanged());
        this._onOwnerChanged();
    }

    _onOwnerChanged() {
        const present = this._proxy.g_name_owner !== null;
        this.visible = present;

        if (present) {
            this._refresh();
            this._startWatching();
        } else {
            this._stopWatching();
            this._currentMode = null;
            this.subtitle = _('Daemon not running');
        }
    }

    /* ---- state watching: file monitor preferred, polling as fallback ---- */

    _startWatching() {
        // Try a FileMonitor first — event-driven, zero idle cost.
        try {
            const file = Gio.File.new_for_path(STATE_FILE);
            this._fileMonitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._fileMonitorChangedId = this._fileMonitor.connect(
                'changed', (_mon, _f, _other, eventType) => {
                    // CHANGES_DONE_HINT fires when an editor finishes writing;
                    // CHANGED handles atomic-rename style writes too.
                    if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT ||
                        eventType === Gio.FileMonitorEvent.CHANGED ||
                        eventType === Gio.FileMonitorEvent.CREATED) {
                        this._refresh();
                    }
                });
        } catch (e) {
            log(`cardwire: FileMonitor unavailable, falling back to polling: ${e.message}`);
            this._startPolling();
        }
    }

    _stopWatching() {
        if (this._fileMonitorChangedId && this._fileMonitor) {
            this._fileMonitor.disconnect(this._fileMonitorChangedId);
            this._fileMonitorChangedId = 0;
        }
        if (this._fileMonitor) {
            this._fileMonitor.cancel();
            this._fileMonitor = null;
        }
        if (this._pollSourceId) {
            GLib.Source.remove(this._pollSourceId);
            this._pollSourceId = 0;
        }
    }

    _startPolling() {
        if (this._pollSourceId) return;
        this._pollSourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            POLL_FALLBACK_SECONDS,
            () => { this._refresh(); return GLib.SOURCE_CONTINUE; });
    }

    /* ---- D-Bus calls ---- */

    _refresh() {
        if (!this._proxy || this._proxy.g_name_owner === null) return;

        this._proxy.call(
            'GetMode', null, Gio.DBusCallFlags.NONE, -1, null,
            (proxy, res) => {
                try {
                    const reply = proxy.call_finish(res);
                    const [text] = reply.deep_unpack();
                    const mode = parseMode(text);
                    if (mode) this._applyMode(mode);
                } catch (e) {
                    logError(e, 'cardwire: GetMode failed');
                }
            });
    }

    _setMode(mode) {
        if (mode === this._currentMode || this._inFlight) return;
        this._inFlight = true;

        this._proxy.call(
            'SetMode',
            new GLib.Variant('(s)', [mode]),
            Gio.DBusCallFlags.NONE, -1, null,
            (proxy, res) => {
                this._inFlight = false;
                try {
                    proxy.call_finish(res);
                    // Optimistic update — file monitor / poll will reconcile shortly
                    this._applyMode(mode);
                } catch (e) {
                    Main.notifyError(_('Cardwire'),
                        _('Failed to set mode: %s').format(e.message));
                    this._refresh();
                }
            });
    }

    /* ---- UI sync ---- */

    _applyMode(mode) {
        if (mode === this._currentMode) return;
        this._currentMode = mode;

        this.subtitle = mode.charAt(0).toUpperCase() + mode.slice(1);
        // "checked" lit means dGPU is active. Hybrid uses both; integrated blocks dGPU.
        this.checked = (mode === 'hybrid');

        // Swap the toggle's icon to reflect mode at a glance
        const modeDef = MODES.find(m => m.id === mode);
        if (modeDef) this.iconName = modeDef.icon;

        // Update radio dots in the sub-menu
        for (const [id, item] of this._modeItems) {
            item.setOrnament(id === mode
                ? PopupMenu.Ornament.DOT
                : PopupMenu.Ornament.NONE);
        }
    }

    destroy() {
        this._stopWatching();
        if (this._ownerChangedId && this._proxy) {
            this._proxy.disconnect(this._ownerChangedId);
            this._ownerChangedId = 0;
        }
        this._proxy = null;
        super.destroy();
    }
});

const CardwireIndicator = GObject.registerClass(
class CardwireIndicator extends SystemIndicator {
    _init() {
        super._init();
        this._toggle = new CardwireToggle();
        this.quickSettingsItems.push(this._toggle);
    }
});

export default class CardwireExtension extends Extension {
    enable() {
        this._indicator = new CardwireIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.quickSettingsItems.forEach(i => i.destroy());
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
