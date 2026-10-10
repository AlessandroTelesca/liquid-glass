import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import { hexToColorArray } from '../animation/colors.js';
import { accentColors, watchAccentColor } from '../shellVersion.js';
import { IconStyleEffect, iconStylePipeline } from './iconEffect.js';
import { IconMaps } from './iconMaps.js';
import { iconStyleColors } from './styleColors.js';
// The id the Show Apps button goes by in the application lists.
export const SHOW_APPS_ID = 'show-apps';
// Icons are looked up at the size their maps are taken from.
const LOOKUP_SIZE = 128;
const EFFECT_NAME = 'liquid-glass-icon-style';
const KEYS = ['icon-style-dock', 'icon-style-launcher', 'icon-style-mode', 'icon-style-use-accent', 'icon-style-color',
    'icon-style-symbol-opacity', 'icon-style-light-symbol', 'icon-style-all-apps', 'icon-style-whitelist',
    'icon-style-blacklist'];

function appIdOf(icon) {
    // The shell's and Dash to Dock's Show Apps buttons, whatever icon they show.
    if (icon.has_style_class_name('show-apps-icon'))
        return SHOW_APPS_ID;
    for (let actor = icon.get_parent(); actor; actor = actor.get_parent()) {
        const app = actor.app;
        if (app instanceof Shell.App)
            return app.get_id();
    }
    return null;
}

export class IconStyler {
    _settings;
    _logger;
    _maps;
    _shader;
    _pipeline = null;
    _theme = new St.IconTheme();
    _styled = new Map();
    // Per dock, the actors in it watched for children, by the handler on each.
    _docks = new Map();
    _scanId = 0;
    _settingsIds = [];
    _themeId = 0;
    _unwatchAccent = () => { };
    _cancellable = new Gio.Cancellable();

    constructor(extensionPath, _settings, _logger) {
        this._settings = _settings;
        this._logger = _logger;
        this._maps = new IconMaps(extensionPath, _logger);
        const file = Gio.File.new_for_path(`${extensionPath}/shaders/icon-style.frag`);
        this._shader = new Promise((resolve, reject) => {
            file.load_contents_async(this._cancellable, (_f, res) => {
                try {
                    resolve(new TextDecoder().decode(file.load_contents_finish(res)[1]));
                }
                catch (e) {
                    reject(e);
                }
            });
        });
        this._shader.catch(e => {
            if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
                this._logger.error(`[Liquid Glass] Could not read the icon shader: ${e}`);
        });
    }

    setup() {
        this._settingsIds = KEYS.map(key => this._settings.connect(`changed::${key}`, () => this._restyleAll()));
        this._themeId = St.TextureCache.get_default().connect('icon-theme-changed', () => {
            this._theme = new St.IconTheme();
            this._restyleAll();
        });
        this._unwatchAccent = watchAccentColor(() => this._recolorAll());
    }

    cleanup() {
        this._cancellable.cancel();
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        if (this._themeId)
            St.TextureCache.get_default().disconnect(this._themeId);
        this._themeId = 0;
        this._unwatchAccent();
        if (this._scanId)
            global.compositor.get_laters().remove(this._scanId);
        this._scanId = 0;
        for (const dock of [...this._docks.keys()])
            this.unwatchDock(dock);
        for (const icon of [...this._styled.keys()])
            this._forget(icon);
        this._maps.destroy();
        this._pipeline = null;
    }

    /** Styles the application icons in a Dash to Dock dock, and those it adds later. */
    watchDock(dock) {
        if (this._docks.has(dock))
            return;
        this._docks.set(dock, new Map());
        this._scanSoon();
    }

    unwatchDock(dock) {
        const watched = this._docks.get(dock);
        if (!watched)
            return;
        this._docks.delete(dock);
        for (const [actor, ids] of watched)
            ids.forEach(id => actor.disconnect(id));
        for (const [icon, styled] of [...this._styled]) {
            if (styled.surface === 'dock' && dock.contains(icon))
                this._forget(icon);
        }
    }

    /** Styles a launcher result's icon, which goes away with its row. */
    styleLauncherIcon(icon, appId) {
        this._style(icon, appId, 'launcher');
    }

    // Before the next frame, so that icons a dock adds are not drawn as they are first.
    _scanSoon() {
        if (this._scanId)
            return;
        this._scanId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._scanId = 0;
            for (const [dock, watched] of this._docks)
                this._scan(dock, watched);
            return GLib.SOURCE_REMOVE;
        });
    }

    _scan(actor, watched) {
        if (actor instanceof St.Icon) {
            const appId = appIdOf(actor);
            if (appId && !this._styled.has(actor))
                this._style(actor, appId, 'dock');
            return;
        }
        if (!watched.has(actor)) {
            watched.set(actor, [
                actor.connect('child-added', () => this._scanSoon()),
                actor.connect('destroy', () => watched.delete(actor)),
            ]);
        }
        for (const child of actor.get_children())
            this._scan(child, watched);
    }

    _style(icon, appId, surface) {
        if (!this._styled.has(icon)) {
            const restyle = () => this._apply(icon);
            this._styled.set(icon, {
                appId, surface, effect: null, serial: 0,
                ids: [icon.connect('destroy', () => this._styled.delete(icon)), icon.connect('notify::gicon', restyle),
                    icon.connect('notify::fallback-gicon', restyle)],
            });
        }
        this._apply(icon);
    }

    _forget(icon) {
        const styled = this._styled.get(icon);
        if (!styled)
            return;
        this._styled.delete(icon);
        styled.ids.forEach(id => icon.disconnect(id));
        if (styled.effect)
            icon.remove_effect(styled.effect);
    }

    _wanted(styled) {
        const s = this._settings;
        if (!s.get_boolean(`icon-style-${styled.surface}`))
            return false;
        return s.get_boolean('icon-style-all-apps') ? !s.get_strv('icon-style-blacklist').includes(styled.appId)
            : s.get_strv('icon-style-whitelist').includes(styled.appId);
    }

    // The file the icon is drawn from, falling back the way St.Icon does when its own icon is not in the theme.
    _file(icon) {
        const named = (name) => (name ? new Gio.ThemedIcon({ name }) : null);
        for (const gicon of [icon.gicon ?? named(icon.icon_name), icon.fallback_gicon ?? named(icon.fallback_icon_name)]) {
            if (gicon instanceof Gio.FileIcon)
                return gicon.get_file().get_path();
            const file = gicon ? this._theme.lookup_by_gicon(gicon, LOOKUP_SIZE, 0)?.get_filename() : null;
            if (file)
                return file;
        }
        return null;
    }

    _colors() {
        const s = this._settings;
        const accent = s.get_boolean('icon-style-use-accent') ? accentColors() : null;
        const tint = accent ? [accent[0].red / 255, accent[0].green / 255, accent[0].blue / 255]
            : hexToColorArray(s.get_string('icon-style-color'));
        const mode = s.get_string('icon-style-mode');
        return iconStyleColors((['mono', 'clear'].includes(mode) ? mode : 'tinted'), tint, s.get_double('icon-style-symbol-opacity'), s.get_boolean('icon-style-light-symbol'));
    }

    _apply(icon) {
        const styled = this._styled.get(icon);
        if (!styled)
            return;
        const serial = ++styled.serial;
        const file = this._wanted(styled) ? this._file(icon) : null;
        if (!file) {
            this._unstyle(icon, styled);
            return;
        }
        Promise.all([this._maps.get(file), this._shader]).then(([map, shader]) => {
            if (this._styled.get(icon) !== styled || styled.serial !== serial)
                return;
            if (!map) {
                this._unstyle(icon, styled);
                return;
            }
            this._pipeline ??= iconStylePipeline(shader);
            const effect = styled.effect ?? new IconStyleEffect();
            effect.prepare(this._pipeline.copy(), map, this._colors());
            if (!styled.effect) {
                styled.effect = effect;
                icon.add_effect_with_name(EFFECT_NAME, effect);
            }
        }).catch(e => {
            if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
                this._logger.log(`[Liquid Glass] Could not style the icon of ${styled.appId}: ${e}`);
        });
    }

    _unstyle(icon, styled) {
        if (!styled.effect)
            return;
        icon.remove_effect(styled.effect);
        styled.effect = null;
    }

    _restyleAll() {
        for (const icon of [...this._styled.keys()])
            this._apply(icon);
    }

    _recolorAll() {
        const colors = this._colors();
        for (const styled of this._styled.values())
            styled.effect?.setColors(colors);
    }
}
