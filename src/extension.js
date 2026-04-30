/* extension.js — Cardwire GPU Mode Quick Settings toggle
 *
 * Talks to the cardwired system daemon over D-Bus:
 *   bus name : com.github.opengamingcollective.cardwire
 *   path     : /com/github/opengamingcollective/cardwire
 *   iface    : com.github.opengamingcollective.cardwire
 *
 * Methods used:
 *   GetMode() -> s         (returns "Current Mode: Integrated"-style or JSON)
 *   SetMode(s)             (accepts lowercase "integrated" | "hybrid" | "manual")
 *
 * Reactive updates:
 *   Future   : dbus event watcher
 *   Primary  : poll GetMode every POLL_INTERVAL_SECONDS if the file isn't readable
 *
 * No Polkit / pkexec required — cardwired's D-Bus policy is open to the system bus.
 */

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    Extension,
    gettext as _
} from 'resource:///org/gnome/shell/extensions/extension.js';
import {
    QuickMenuToggle,
    SystemIndicator
} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const BUS_NAME = 'com.github.opengamingcollective.cardwire';
const OBJECT_PATH = '/com/github/opengamingcollective/cardwire';
const INTERFACE = 'com.github.opengamingcollective.cardwire';

const POLL_INTERVAL_SECONDS = 5;

function getModes() {
    return [{
            id: 'integrated',
            label: _('Integrated'),
            icon: 'cardwire-integrated-symbolic'
        },
        {
            id: 'hybrid',
            label: _('Hybrid'),
            icon: 'cardwire-hybrid-symbolic'
        },
        {
            id: 'manual',
            label: _('Manual'),
            icon: 'cardwire-manual-symbolic'
        },
    ];
}

/* cardwire's GetMode return is inconsistent across versions.
 * 0.5.0  : "Current Mode: Integrated"
 * Normalize all of these to lowercase ids. */
function parseMode(text) {
    if (!text) return null;
    const m = String(text).match(/(integrated|hybrid|manual)/i);
    return m ? m[1].toLowerCase() : null;
}

/* Build a Gio.Icon for a custom icon name by resolving the SVG file
 * inside the extension's icons/ directory.  This bypasses GNOME's
 * icon-theme search path and works reliably regardless of theme. */
function makeCustomIcon(extensionPath, iconBaseName) {
    const path = GLib.build_filenamev(
        [extensionPath, 'icons', `${iconBaseName}.svg`]);
    return Gio.FileIcon.new(Gio.File.new_for_path(path));
}

const CardwireToggle = GObject.registerClass(
    class CardwireToggle extends QuickMenuToggle {
        _init(extensionPath) {
            super._init({
                title: _('GPU Mode'),
                // Use a stock icon as the initial placeholder; replaced on first refresh.
                iconName: 'preferences-system-symbolic',
                toggleMode: false,
            });

            this._extensionPath = extensionPath;
            this._currentMode = null;
            this._proxy = null;
            this._pollSourceId = 0;
            this._ownerChangedId = 0;
            this._inFlight = false;
            this._modeItems = new Map();

            // Pre-build gicons for each mode so we're not constructing on every refresh
            this._modeIcons = new Map();
            for (const m of getModes()) {
                this._modeIcons.set(m.id,
                    makeCustomIcon(extensionPath, m.icon));
            }

            this.menu.setHeader('preferences-system-symbolic', _('GPU Mode'));

            // Mode menu items (radio-style with ornament dots)
            for (const m of getModes()) {
                const item = new PopupMenu.PopupMenuItem(m.label);
                item.connect('activate', () => {
                    this.menu.close();
                    this._setMode(m.id);
                });
                this.menu.addMenuItem(item);
                this._modeItems.set(m.id, item);
            }

            // Click on toggle body cycles integrated <-> hybrid.
            // Manual is reachable only via the sub-menu.
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
                        try {
                            resolve(Gio.DBusProxy.new_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    });
            });

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

        /* ---- state watching ---- */

        _startWatching() {
            // Cardwire doesnt expose a dbus event to watch and the state filechange watcher didnt work
            this._startPolling();
        }

        _stopWatching() {
            if (this._pollSourceId) {
                GLib.Source.remove(this._pollSourceId);
                this._pollSourceId = 0;
            }
        }

        _startPolling() {
            if (this._pollSourceId) return;
            this._pollSourceId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                POLL_INTERVAL_SECONDS,
                () => {
                    this._refresh();
                    return GLib.SOURCE_CONTINUE;
                });
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
                        this._applyMode(mode); // optimistic
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
            // "checked" lit means dGPU is active (Hybrid uses both; Integrated blocks dGPU).
            this.checked = (mode === 'hybrid');

            // Swap to the custom icon for this mode
            const gicon = this._modeIcons.get(mode);
            if (gicon) this.gicon = gicon;

            // Update radio dots in the sub-menu
            for (const [id, item] of this._modeItems) {
                item.setOrnament(id === mode ?
                    PopupMenu.Ornament.DOT :
                    PopupMenu.Ornament.NONE);
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
        _init(extensionPath) {
            super._init();
            this._toggle = new CardwireToggle(extensionPath);
            this.quickSettingsItems.push(this._toggle);
        }
    });

export default class CardwireExtension extends Extension {
    enable() {
        // `this.path` is the absolute path to the extension's directory —
        // we forward it down so child widgets can resolve icons/ files.
        this._indicator = new CardwireIndicator(this.path);
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
