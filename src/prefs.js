/* prefs.js — Cardwire GPU Toggle preferences
 *
 * Exposes cardwired's Config interface as a native GNOME preferences
 * window. Talks directly to the daemon over D-Bus — no privileged write
 * to /etc/cardwire/cardwire.toml needed.
 *
 * cardwired Config interface (com.github.opengamingcollective.cardwire.Config):
 *   AutoApplyGpuState        (bool, property, read/write)
 *   BatteryAutoSwitch        (bool, property, read/write)
 *   BatteryAutoSwitchMode    (u32, property,  read/write)
 *   ExperimentalNvidiaBlock  (bool, property, read/write)
 *   SaveToFile()             (method, persists in-memory config to disk)
 *
 * Mode enum used for BatteryAutoSwitchMode (matches the main Mode property):
 *   0 = Integrated   1 = Hybrid   2 = Manual   3 = Smart
 *
 * Changes apply immediately and are persisted to disk via SaveToFile.
 */

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ }
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const BUS_NAME    = 'com.github.opengamingcollective.cardwire';
const OBJECT_PATH = '/com/github/opengamingcollective/cardwire';
const CONFIG_IFACE = 'com.github.opengamingcollective.cardwire.Config';

/* Mode enum — must match the values used by extension.js / cardwired */
const MODE_INTEGRATED = 0;
const MODE_HYBRID     = 1;
const MODE_MANUAL     = 2;
const MODE_SMART      = 3;

/* Display order for the battery-mode dropdown. Index in this array is the
 * Gtk.StringList position; .value is the underlying u32 sent to D-Bus.
 *
 * Returned by a function (not a const) because gettext (`_`) can only be
 * called from inside extension methods, not at module load time. */
function getBatteryModeChoices() {
    return [
        { value: MODE_INTEGRATED, label: _('Integrated') },
        { value: MODE_HYBRID,     label: _('Hybrid')     },
        { value: MODE_MANUAL,     label: _('Manual')     },
        { value: MODE_SMART,      label: _('Smart')      },
    ];
}

/* Three boolean properties shown as switches. Function for the same reason
 * as above — _() must be called after the extension is instantiated. */
function getConfigSwitches() {
    return [
        {
            property: 'AutoApplyGpuState',
            title:    _('Auto-apply GPU state'),
            subtitle: _('Apply the saved GPU mode automatically when the daemon starts.'),
        },
        {
            property: 'BatteryAutoSwitch',
            title:    _('Auto-switch mode on battery'),
            subtitle: _('Switch to a chosen mode automatically when running on battery.'),
        },
        {
            property: 'ExperimentalNvidiaBlock',
            title:    _('Experimental Nvidia block'),
            subtitle: _('Enable extra blocking paths for Nvidia GPUs. May affect stability.'),
        },
    ];
}

export default class CardwirePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const page = new Adw.PreferencesPage({
            title:    _('Daemon'),
            iconName: 'preferences-system-symbolic',
        });
        window.add(page);

        // Status banner shown while loading or when daemon is absent
        this._statusPage = new Adw.StatusPage({
            iconName:    'preferences-system-symbolic',
            title:       _('Connecting to cardwire'),
            description: _('Reading current configuration from the daemon…'),
        });

        this._statusGroup = new Adw.PreferencesGroup();
        this._statusGroup.add(this._statusPage);
        page.add(this._statusGroup);

        this._switchGroup = new Adw.PreferencesGroup({
            title:       _('Daemon configuration'),
            description: _('Changes apply immediately and are saved to /etc/cardwire/cardwire.toml.'),
            visible:     false,
        });
        page.add(this._switchGroup);

        this._switchRows     = new Map();
        this._batteryModeRow = null;
        this._proxy          = null;
        this._propsChangedId = 0;
        this._ownerChangedId = 0;
        this._suppressWrite  = false; // guard against echo loops

        // Build boolean rows
        for (const def of getConfigSwitches()) {
            const row = new Adw.SwitchRow({
                title:    def.title,
                subtitle: def.subtitle,
                active:   false,
                sensitive: false,
            });

            row.connect('notify::active', () => {
                if (this._suppressWrite) return;
                this._writeBoolProperty(def.property, row.get_active());
            });

            this._switchGroup.add(row);
            this._switchRows.set(def.property, row);
        }

        // Build battery-mode dropdown
        const batteryModeChoices = getBatteryModeChoices();
        const modeList = new Gtk.StringList();
        for (const c of batteryModeChoices) modeList.append(c.label);

        this._batteryModeRow = new Adw.ComboRow({
            title:     _('Battery mode'),
            subtitle:  _('Mode to use when auto-switch on battery is enabled.'),
            model:     modeList,
            selected:  0,
            sensitive: false,
        });

        this._batteryModeRow.connect('notify::selected', () => {
            if (this._suppressWrite) return;
            const idx = this._batteryModeRow.get_selected();
            const choice = batteryModeChoices[idx];
            if (choice) this._writeUintProperty('BatteryAutoSwitchMode', choice.value);
        });

        this._switchGroup.add(this._batteryModeRow);

        this._initProxy().catch(e => logError(e, 'cardwire prefs: initProxy failed'));

        window.connect('close-request', () => {
            this._teardown();
            return false;
        });
    }

    async _initProxy() {
        try {
            this._proxy = await new Promise((resolve, reject) => {
                Gio.DBusProxy.new(
                    Gio.DBus.system,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    BUS_NAME, OBJECT_PATH, CONFIG_IFACE,
                    null,
                    (src, res) => {
                        try { resolve(Gio.DBusProxy.new_finish(res)); }
                        catch (e) { reject(e); }
                    });
            });
        } catch (e) {
            this._showError(_('Failed to connect to cardwire daemon: %s').format(e.message));
            return;
        }

        this._ownerChangedId = this._proxy.connect(
            'notify::g-name-owner', () => this._onOwnerChanged());

        // Reflect external changes (e.g. from `cardwire config ...` cli)
        this._propsChangedId = this._proxy.connect(
            'g-properties-changed', (proxy, changed, _invalidated) => {
                for (const def of getConfigSwitches()) {
                    const v = changed.lookup_value(def.property, null);
                    if (v) this._applyBool(def.property, v.unpack());
                }
                const m = changed.lookup_value('BatteryAutoSwitchMode', null);
                if (m) this._applyBatteryMode(m.unpack());
            });

        this._onOwnerChanged();
    }

    _onOwnerChanged() {
        const present = this._proxy.g_name_owner !== null;
        if (!present) {
            this._showError(_('cardwired is not running.'));
            return;
        }

        // Populate from cache; if empty, do an explicit GetAll
        let anyCached = false;
        for (const def of getConfigSwitches()) {
            const cached = this._proxy.get_cached_property(def.property);
            if (cached) {
                this._applyBool(def.property, cached.unpack());
                anyCached = true;
            }
        }
        const cachedMode = this._proxy.get_cached_property('BatteryAutoSwitchMode');
        if (cachedMode) {
            this._applyBatteryMode(cachedMode.unpack());
            anyCached = true;
        }

        if (anyCached) {
            this._showSwitches();
        } else {
            this._readAllExplicit().catch(e => {
                logError(e, 'cardwire prefs: explicit read failed');
                this._showError(_('Could not read daemon configuration.'));
            });
        }
    }

    async _readAllExplicit() {
        const reply = await new Promise((resolve, reject) => {
            this._proxy.call(
                'org.freedesktop.DBus.Properties.GetAll',
                new GLib.Variant('(s)', [CONFIG_IFACE]),
                Gio.DBusCallFlags.NONE, -1, null,
                (proxy, res) => {
                    try { resolve(proxy.call_finish(res)); }
                    catch (e) { reject(e); }
                });
        });

        const [dict] = reply.deep_unpack();
        for (const def of getConfigSwitches()) {
            const v = dict[def.property];
            if (v !== undefined) this._applyBool(def.property, v.deep_unpack());
        }
        const modeVariant = dict['BatteryAutoSwitchMode'];
        if (modeVariant !== undefined) {
            this._applyBatteryMode(modeVariant.deep_unpack());
        }

        this._showSwitches();
    }

    /* ---- Writes ---- */

    _writeBoolProperty(name, value) {
        this._writeProperty(name, new GLib.Variant('b', value));
    }

    _writeUintProperty(name, value) {
        this._writeProperty(name, new GLib.Variant('u', value));
    }

    _writeProperty(name, valueVariant) {
        if (!this._proxy || this._proxy.g_name_owner === null) return;

        this._proxy.call(
            'org.freedesktop.DBus.Properties.Set',
            new GLib.Variant('(ssv)', [CONFIG_IFACE, name, valueVariant]),
            Gio.DBusCallFlags.NONE, -1, null,
            (proxy, res) => {
                try {
                    proxy.call_finish(res);
                    this._saveToFile();
                } catch (e) {
                    logError(e, `cardwire prefs: Set ${name} failed`);
                    // Revert the widget to whatever the daemon actually has
                    const cached = this._proxy.get_cached_property(name);
                    if (!cached) return;
                    if (valueVariant.get_type_string() === 'b') {
                        this._applyBool(name, cached.unpack());
                    } else {
                        this._applyBatteryMode(cached.unpack());
                    }
                }
            });
    }

    _saveToFile() {
        this._proxy.call(
            'SaveToFile', null, Gio.DBusCallFlags.NONE, -1, null,
            (proxy, res) => {
                try { proxy.call_finish(res); }
                catch (e) { logError(e, 'cardwire prefs: SaveToFile failed'); }
            });
    }

    /* ---- UI sync ---- */

    _applyBool(property, value) {
        const row = this._switchRows.get(property);
        if (!row) return;

        this._suppressWrite = true;
        try {
            row.set_active(Boolean(value));
            row.set_sensitive(true);
        } finally {
            this._suppressWrite = false;
        }
    }

    _applyBatteryMode(intVal) {
        if (!this._batteryModeRow) return;

        const idx = getBatteryModeChoices().findIndex(c => c.value === intVal);
        if (idx < 0) {
            log(`cardwire prefs: unknown battery mode ${intVal}`);
            return;
        }

        this._suppressWrite = true;
        try {
            this._batteryModeRow.set_selected(idx);
            this._batteryModeRow.set_sensitive(true);
        } finally {
            this._suppressWrite = false;
        }
    }

    _showSwitches() {
        this._statusGroup.visible = false;
        this._switchGroup.visible = true;
    }

    _showError(message) {
        this._statusPage.set_icon_name('dialog-error-symbolic');
        this._statusPage.set_title(_('Configuration unavailable'));
        this._statusPage.set_description(message);
        this._statusGroup.visible = true;
        this._switchGroup.visible = false;
    }

    _teardown() {
        if (this._propsChangedId && this._proxy) {
            this._proxy.disconnect(this._propsChangedId);
            this._propsChangedId = 0;
        }
        if (this._ownerChangedId && this._proxy) {
            this._proxy.disconnect(this._ownerChangedId);
            this._ownerChangedId = 0;
        }
        this._proxy = null;
    }
}
