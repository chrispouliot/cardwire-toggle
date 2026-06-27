/* extension.js — Cardwire GPU Mode Quick Settings toggle
 *
 * Talks to the cardwired system daemon over D-Bus:
 *   bus name : com.github.opengamingcollective.cardwire
 *   path     : /com/github/opengamingcollective/cardwire
 *   iface    : com.github.opengamingcollective.cardwire.Mode
 *
 * Mode property (u, read/write, emits-change):
 *     0 = Integrated   — dGPU blocked, iGPU only
 *     1 = Hybrid       — both GPUs available
 *     2 = Manual       — explicit per-GPU control via cardwire
 *     3 = Smart        — daemon decides per-app whether to allow dGPU access
 *
 * Reactive updates come for free via PropertiesChanged: no polling,
 * no file-watching. Mode changes from any client (CLI, this extension,
 * other tools) propagate to the UI within milliseconds.
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

const BUS_NAME    = 'com.github.opengamingcollective.cardwire';
const OBJECT_PATH = '/com/github/opengamingcollective/cardwire';
const INTERFACE   = 'com.github.opengamingcollective.cardwire.Mode';

const MODE_INTEGRATED = 0;
const MODE_HYBRID     = 1;
const MODE_MANUAL     = 2;
const MODE_SMART      = 3;

const MODE_ID_BY_INT = {
    [MODE_INTEGRATED]: 'integrated',
    [MODE_HYBRID]:     'hybrid',
    [MODE_MANUAL]:     'manual',
    [MODE_SMART]:      'smart',
};

const MODE_INT_BY_ID = {
    integrated: MODE_INTEGRATED,
    hybrid:     MODE_HYBRID,
    manual:     MODE_MANUAL,
    smart:      MODE_SMART,
};

/* Custom icons in icons/<basename>.svg. If a mode uses a stock theme icon
 * instead, set `stockIcon` (and omit the custom icon file). */
function getModes() {
    return [
        { id: 'integrated', label: _('Integrated'), icon: 'cardwire-integrated-symbolic' },
        { id: 'hybrid',     label: _('Hybrid'),     icon: 'cardwire-hybrid-symbolic'     },
        { id: 'manual',     label: _('Manual'),     icon: 'cardwire-manual-symbolic'     },
        { id: 'smart',      label: _('Smart'),      icon: 'cardwire-smart-symbolic' },
    ];
}

/* Build a Gio.Icon for a custom icon name by resolving the SVG file
 * inside the extension's icons/ directory. This bypasses GNOME's
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
            iconName: 'preferences-system-symbolic',
            toggleMode: false,
        });

        this._extensionPath  = extensionPath;
        this._currentMode    = null;
        this._proxy          = null;
        this._ownerChangedId = 0;
        this._propsChangedId = 0;
        this._inFlight       = false;
        this._modeItems      = new Map();

        // Pre-build gicons (custom file-backed or stock themed) for each mode
        this._modeIcons = new Map();
        for (const m of getModes()) {
            if (m.icon) {
                this._modeIcons.set(m.id, makeCustomIcon(extensionPath, m.icon));
            } else if (m.stockIcon) {
                this._modeIcons.set(m.id, new Gio.ThemedIcon({ name: m.stockIcon }));
            }
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
        // Manual and Smart are reachable only via the sub-menu — they're
        // intentional choices, not something to accidentally land on.
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

        // Track daemon presence so the toggle can hide itself if cardwired exits.
        this._ownerChangedId = this._proxy.connect(
            'notify::g-name-owner', () => this._onOwnerChanged());

        // PropertiesChanged fires automatically whenever any client sets Mode.
        this._propsChangedId = this._proxy.connect(
            'g-properties-changed', (proxy, changed, _invalidated) => {
                const v = changed.lookup_value('Mode', null);
                if (v) this._applyModeFromInt(v.unpack());
            });

        this._onOwnerChanged();
    }

    _onOwnerChanged() {
        const present = this._proxy.g_name_owner !== null;
        this.visible = present;

        if (present) {
            this._refresh();
        } else {
            this._currentMode = null;
            this.subtitle = _('Daemon not running');
        }
    }

    /* ---- D-Bus property access ---- */

    /* Read the currently-cached Mode value from the proxy. The proxy keeps
     * the property value in sync automatically once it's connected, so this
     * is a local lookup, not a D-Bus round trip. */
    _refresh() {
        if (!this._proxy || this._proxy.g_name_owner === null) return;

        // Cache first, dbus get fallback
        const cached = this._proxy.get_cached_property('Mode');
        if (cached) {
            this._applyModeFromInt(cached.unpack());
            return;
        }

        // Cache not populated yet, like initial login
        this._proxy.call(
            'org.freedesktop.DBus.Properties.Get',
            new GLib.Variant('(ss)', [INTERFACE, 'Mode']),
            Gio.DBusCallFlags.NONE, -1, null,
            (proxy, res) => {
                try {
                    const reply = proxy.call_finish(res);
                    const [variant] = reply.deep_unpack();
                    this._applyModeFromInt(variant.deep_unpack());
                } catch (e) {
                    logError(e, 'cardwire: initial Properties.Get failed');
                }
            });
    }

    _setMode(modeId) {
        if (modeId === this._currentMode || this._inFlight) return;
        const intVal = MODE_INT_BY_ID[modeId];
        if (intVal === undefined) return;

        this._inFlight = true;

        // Set the property via the standard org.freedesktop.DBus.Properties.Set
        // interface. The daemon will emit PropertiesChanged on success, which
        // our handler picks up and reflects in the UI.
        this._proxy.call(
            'org.freedesktop.DBus.Properties.Set',
            new GLib.Variant('(ssv)', [
                INTERFACE,
                'Mode',
                new GLib.Variant('u', intVal),
            ]),
            Gio.DBusCallFlags.NONE, -1, null,
            (proxy, res) => {
                this._inFlight = false;
                try {
                    proxy.call_finish(res);
                    // PropertiesChanged will arrive shortly with the new value;
                    // optimistic update keeps the click feeling instant.
                    this._applyModeFromInt(intVal);
                } catch (e) {
                    Main.notifyError(_('Cardwire'),
                        _('Failed to set mode: %s').format(e.message));
                }
            });
    }

    /* ---- UI sync ---- */

    _applyModeFromInt(intVal) {
        const id = MODE_ID_BY_INT[intVal];
        if (!id) {
            log(`cardwire: unknown mode int ${intVal}`);
            return;
        }
        this._applyMode(id);
    }

    _applyMode(mode) {
        if (mode === this._currentMode) return;
        this._currentMode = mode;

        this.subtitle = mode.charAt(0).toUpperCase() + mode.slice(1);
        // "checked" lit means dGPU is reachable.
        // Hybrid: dGPU always available.
        // Smart: dGPU is conditionally available per-app, so we light up too.
        // Integrated: dGPU blocked.
        // Manual: ambiguous — defer to off; the sub-menu dot still shows the active mode.
        this.checked = (mode === 'hybrid' || mode === 'smart');

        // Swap to the icon for this mode (custom or stock)
        const gicon = this._modeIcons.get(mode);
        if (gicon) this.gicon = gicon;

        // Update radio dots in the sub-menu
        for (const [id, item] of this._modeItems) {
            item.setOrnament(id === mode
                ? PopupMenu.Ornament.DOT
                : PopupMenu.Ornament.NONE);
        }
    }

    destroy() {
        if (this._propsChangedId && this._proxy) {
            this._proxy.disconnect(this._propsChangedId);
            this._propsChangedId = 0;
        }
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
