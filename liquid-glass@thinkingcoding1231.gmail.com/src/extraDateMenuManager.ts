import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DateMenu from 'resource:///org/gnome/shell/ui/dateMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { UIManager } from './uiManager.js';
import { Logger } from './logger.js';

// PopupMenu sets itself as its actor's _delegate.
function menuOf(actor: Clutter.Actor): PopupMenu.PopupMenu | null {
  const delegate = '_delegate' in actor ? actor._delegate : null;
  return delegate instanceof PopupMenu.PopupMenu ? delegate : null;
}

/**
 * Glass behind the calendar menus of the top bars other extensions put on further monitors,
 * such as Multi Monitors Bar. Those bars build their own DateMenuButton, which the main panel's
 * UIManager never sees. They follow the Calendar menu's switch and settings.
 */
export class ExtraDateMenuManager {
  private _signals: { target: Clutter.Actor; id: number }[] = [];
  private _menus = new Map<PopupMenu.PopupMenu, UIManager>();
  private _idleId = 0;
  private _attached = 0;

  constructor(private _path: string, private _settings: Gio.Settings, private _logger: Logger) {}

  setup() {
    // PanelMenu.Button puts its menu straight into uiGroup, so a bar created or destroyed later shows up here.
    const uiGroup = Main.layoutManager.uiGroup;
    for (const signal of ['child-added', 'child-removed'] as const)
      this._signals.push({ target: uiGroup, id: uiGroup.connect(signal, () => this._scheduleScan()) });
    // The shell destroys uiGroup on shutdown without disabling extensions; a scan queued by the
    // removal of its children would run on a disposed actor.
    this._signals.push({ target: uiGroup, id: uiGroup.connect('destroy', () => this.cleanup()) });
    this._scheduleScan();
  }

  private _scheduleScan() {
    if (this._idleId) return;
    // The menu is added while its button is still being built.
    this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._idleId = 0;
      this._scan();
      return GLib.SOURCE_REMOVE;
    });
  }

  private _scan() {
    // Gone while the shell shuts down.
    const primary = Main.panel.statusArea.dateMenu?.menu;
    const found = new Set<PopupMenu.PopupMenu>();
    for (const child of Main.layoutManager.uiGroup.get_children()) {
      const menu = menuOf(child);
      if (menu && menu !== primary && menu.sourceActor instanceof DateMenu.DateMenuButton)
        found.add(menu);
    }

    for (const [menu, manager] of this._menus) {
      if (found.has(menu)) continue;
      this._menus.delete(menu);
      manager.cleanup();
    }

    for (const menu of found) {
      if (this._menus.has(menu)) continue;
      const manager = new UIManager(this._path, this._settings, this._logger, { menu }, false,
        'enable-menu-glass', 'menu', `menu:dateMenu${++this._attached}`, false);
      // These buttons belong to other extensions and may not be built the way UIManager expects.
      try {
        manager.setup();
        this._menus.set(menu, manager);
      } catch (e) {
        manager.cleanup();
        this._logger.log(`[Liquid Glass] Could not attach glass to another top bar's calendar menu: ${e}`);
      }
    }
  }

  cleanup() {
    if (this._idleId) {
      GLib.Source.remove(this._idleId);
      this._idleId = 0;
    }

    for (const { target, id } of this._signals)
      target.disconnect(id);
    this._signals = [];

    for (const manager of this._menus.values())
      manager.cleanup();
    this._menus.clear();
  }
}
