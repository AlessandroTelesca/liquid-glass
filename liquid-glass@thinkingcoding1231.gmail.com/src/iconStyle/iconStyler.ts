// Redraws application icons in the dock (Dash to Dock) and in the launcher as
// glass plates under a one-colour symbol (see iconEffect.ts), for the
// applications the settings pick.
import Cogl from 'gi://Cogl';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import type { Logger } from '../logger.js';
import { hexToColorArray } from '../animation/colors.js';
import { accentColors, watchAccentColor } from '../shellVersion.js';
import { IconStyleEffect, iconStylePipeline } from './iconEffect.js';
import { IconMaps } from './iconMaps.js';
import { iconStyleColors, type IconStyleColors, type IconStyleMode } from './styleColors.js';

export type IconSurface = 'dock' | 'launcher';

// The id the Show Apps button goes by in the application lists.
export const SHOW_APPS_ID = 'show-apps';
// Icons are looked up at the size their maps are taken from.
const LOOKUP_SIZE = 128;
const EFFECT_NAME = 'liquid-glass-icon-style';

interface Styled {
  appId: string;
  surface: IconSurface;
  effect: IconStyleEffect | null;
  // Advanced on every restyle, so that a map that comes late for an older look is dropped.
  serial: number;
  ids: number[];
}

const KEYS = ['icon-style-dock', 'icon-style-launcher', 'icon-style-mode', 'icon-style-use-accent', 'icon-style-color',
  'icon-style-tint-strength', 'icon-style-size', 'icon-style-symbol-opacity', 'icon-style-all-apps',
  'icon-style-whitelist', 'icon-style-blacklist'];

function appIdOf(icon: St.Icon): string | null {
  // The shell's and Dash to Dock's Show Apps buttons, whatever icon they show.
  if (icon.has_style_class_name('show-apps-icon')) return SHOW_APPS_ID;
  for (let actor: Clutter.Actor | null = icon.get_parent(); actor; actor = actor.get_parent()) {
    const app = (actor as any).app;
    if (app instanceof Shell.App) return app.get_id();
  }
  return null;
}

export class IconStyler {
  private _maps: IconMaps;
  private _shader: Promise<string>;
  private _pipeline: Cogl.Pipeline | null = null;
  private _theme = new St.IconTheme();
  private _styled = new Map<St.Icon, Styled>();
  // Per dock, the actors in it watched for children, by the handler on each.
  private _docks = new Map<Clutter.Actor, Map<Clutter.Actor, number[]>>();
  private _scanId = 0;
  private _settingsIds: number[] = [];
  private _themeId = 0;
  private _unwatchAccent: () => void = () => {};
  private _cancellable = new Gio.Cancellable();

  constructor(extensionPath: string, private _settings: Gio.Settings, private _logger: Logger) {
    this._maps = new IconMaps(extensionPath, _logger);
    const file = Gio.File.new_for_path(`${extensionPath}/shaders/icon-style.frag`);
    this._shader = new Promise((resolve, reject) => {
      file.load_contents_async(this._cancellable, (_f, res) => {
        try {
          resolve(new TextDecoder().decode(file.load_contents_finish(res)[1]));
        } catch (e) {
          reject(e);
        }
      });
    });
    this._shader.catch(e => {
      if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
        this._logger.error(`[Liquid Glass] Could not read the icon shader: ${e}`);
    });
  }

  setup(): void {
    this._settingsIds = KEYS.map(key => this._settings.connect(`changed::${key}`, () => this._restyleAll()));
    this._themeId = St.TextureCache.get_default().connect('icon-theme-changed', () => {
      this._theme = new St.IconTheme();
      this._restyleAll();
    });
    this._unwatchAccent = watchAccentColor(() => this._recolorAll());
  }

  cleanup(): void {
    this._cancellable.cancel();
    for (const id of this._settingsIds) this._settings.disconnect(id);
    this._settingsIds = [];
    if (this._themeId) St.TextureCache.get_default().disconnect(this._themeId);
    this._themeId = 0;
    this._unwatchAccent();
    if (this._scanId) global.compositor.get_laters().remove(this._scanId);
    this._scanId = 0;
    for (const dock of [...this._docks.keys()]) this.unwatchDock(dock);
    for (const icon of [...this._styled.keys()]) this._forget(icon);
    this._maps.destroy();
    this._pipeline = null;
  }

  /** Styles the application icons in a Dash to Dock dock, and those it adds later. */
  watchDock(dock: Clutter.Actor): void {
    if (this._docks.has(dock)) return;
    this._docks.set(dock, new Map());
    this._scanSoon();
  }

  unwatchDock(dock: Clutter.Actor): void {
    const watched = this._docks.get(dock);
    if (!watched) return;
    this._docks.delete(dock);
    for (const [actor, ids] of watched) ids.forEach(id => actor.disconnect(id));
    for (const [icon, styled] of [...this._styled]) {
      if (styled.surface === 'dock' && dock.contains(icon)) this._forget(icon);
    }
  }

  /** Styles a launcher result's icon, which goes away with its row. */
  styleLauncherIcon(icon: St.Icon, appId: string): void {
    this._style(icon, appId, 'launcher');
  }

  // Before the next frame, so that icons a dock adds are not drawn as they are first.
  private _scanSoon(): void {
    if (this._scanId) return;
    this._scanId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
      this._scanId = 0;
      for (const [dock, watched] of this._docks) this._scan(dock, watched);
      return GLib.SOURCE_REMOVE;
    });
  }

  private _scan(actor: Clutter.Actor, watched: Map<Clutter.Actor, number[]>): void {
    if (actor instanceof St.Icon) {
      const appId = appIdOf(actor);
      if (appId && !this._styled.has(actor)) this._style(actor, appId, 'dock');
      return;
    }
    if (!watched.has(actor)) {
      watched.set(actor, [
        actor.connect('child-added', () => this._scanSoon()),
        actor.connect('destroy', () => watched.delete(actor)),
      ]);
    }
    for (const child of actor.get_children()) this._scan(child, watched);
  }

  private _style(icon: St.Icon, appId: string, surface: IconSurface): void {
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

  private _forget(icon: St.Icon): void {
    const styled = this._styled.get(icon);
    if (!styled) return;
    this._styled.delete(icon);
    styled.ids.forEach(id => icon.disconnect(id));
    this._unstyle(icon, styled);
  }

  private _wanted(styled: Styled): boolean {
    const s = this._settings;
    if (!s.get_boolean(`icon-style-${styled.surface}`)) return false;
    return s.get_boolean('icon-style-all-apps') ? !s.get_strv('icon-style-blacklist').includes(styled.appId)
      : s.get_strv('icon-style-whitelist').includes(styled.appId);
  }

  // The file the icon is drawn from, falling back the way St.Icon does when its own icon is not in the theme.
  private _file(icon: St.Icon): string | null {
    const named = (name: string | null) => (name ? new Gio.ThemedIcon({ name }) : null);
    for (const gicon of [icon.gicon ?? named(icon.icon_name), icon.fallback_gicon ?? named(icon.fallback_icon_name)]) {
      if (gicon instanceof Gio.FileIcon) return gicon.get_file().get_path();
      const file = gicon ? this._theme.lookup_by_gicon(gicon, LOOKUP_SIZE, 0)?.get_filename() : null;
      if (file) return file;
    }
    return null;
  }

  private _colors(): IconStyleColors {
    const s = this._settings;
    const accent = s.get_boolean('icon-style-use-accent') ? accentColors() : null;
    const tint = accent ? [accent[0].red / 255, accent[0].green / 255, accent[0].blue / 255]
      : hexToColorArray(s.get_string('icon-style-color'));
    const mode = s.get_string('icon-style-mode');
    return iconStyleColors((['mono', 'clear'].includes(mode) ? mode : 'tinted') as IconStyleMode, tint,
      s.get_double('icon-style-tint-strength'), s.get_double('icon-style-symbol-opacity'));
  }

  private _apply(icon: St.Icon): void {
    const styled = this._styled.get(icon);
    if (!styled) return;
    const serial = ++styled.serial;
    const file = this._wanted(styled) ? this._file(icon) : null;
    if (!file) {
      this._unstyle(icon, styled);
      return;
    }
    Promise.all([this._maps.get(file), this._shader]).then(([map, shader]) => {
      if (this._styled.get(icon) !== styled || styled.serial !== serial) return;
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
      // Scaled as an actor rather than drawn past its box, so that Clutter keeps what it redraws and culls right.
      const size = this._settings.get_double('icon-style-size');
      icon.set_pivot_point(0.5, 0.5);
      icon.set_scale(size, size);
    }).catch(e => {
      if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
        this._logger.log(`[Liquid Glass] Could not style the icon of ${styled.appId}: ${e}`);
    });
  }

  private _unstyle(icon: St.Icon, styled: Styled): void {
    if (!styled.effect) return;
    icon.remove_effect(styled.effect);
    icon.set_scale(1, 1);
    styled.effect = null;
  }

  private _restyleAll(): void {
    for (const icon of [...this._styled.keys()]) this._apply(icon);
  }

  private _recolorAll(): void {
    const colors = this._colors();
    for (const styled of this._styled.values()) styled.effect?.setColors(colors);
  }
}
