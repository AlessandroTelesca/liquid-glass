import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import { TopBarManager, type TopBarPanel } from './topBarManager.js';
import type { Logger } from './logger.js';

// Built like the shell's Panel, whose three boxes the glass follows.
function isTopBar(actor: Clutter.Actor): actor is TopBarPanel {
  return actor instanceof St.Widget
    && '_leftBox' in actor && actor._leftBox instanceof St.BoxLayout
    && '_centerBox' in actor && actor._centerBox instanceof St.BoxLayout
    && '_rightBox' in actor && actor._rightBox instanceof St.BoxLayout;
}

/**
 * Top bar glass for the bars other extensions put on further monitors, such as Multi Monitors Bar.
 * Each bar sits in a box of its own in uiGroup and gets its own TopBarManager, which follows the
 * top bar settings. Bars along a side of the screen are left alone: the glass is laid out for a
 * horizontal bar.
 */
export class ExtraTopBarManager {
  private _disconnects: (() => void)[] = [];
  private _bars = new Map<TopBarPanel, TopBarManager>();
  // Every bar found, side bars too: Multi Monitors Bar moves a bar back to the top by changing its style class only.
  private _watched = new Map<TopBarPanel, number[]>();
  private _idleId = 0;
  private _attached = 0;

  constructor(private _path: string, private _settings: Gio.Settings, private _logger: Logger) {}

  setup() {
    const uiGroup = Main.layoutManager.uiGroup;
    // The shell's own signal emitters type their handlers as returning a stop flag.
    const scan = () => {
      this._scheduleScan();
      return undefined;
    };
    // A bar's box is added to uiGroup before the bar is put in it; the scan waits for an idle.
    for (const signal of ['child-added', 'child-removed'] as const) {
      const id = uiGroup.connect(signal, scan);
      this._disconnects.push(() => uiGroup.disconnect(id));
    }
    const monitorsId = Main.layoutManager.connect('monitors-changed', scan);
    this._disconnects.push(() => Main.layoutManager.disconnect(monitorsId));
    const extensionsId = Main.extensionManager.connect('extension-state-changed', scan);
    this._disconnects.push(() => Main.extensionManager.disconnect(extensionsId));
    // The shell destroys uiGroup on shutdown without disabling extensions; a scan queued by the
    // removal of its children would run on disposed actors.
    const destroyId = uiGroup.connect('destroy', () => this.cleanup());
    this._disconnects.push(() => uiGroup.disconnect(destroyId));
    this._scheduleScan();
  }

  private _scheduleScan() {
    if (this._idleId) return;
    this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._idleId = 0;
      this._scan();
      return GLib.SOURCE_REMOVE;
    });
  }

  private _scan() {
    const bars = new Set<TopBarPanel>();
    const found = new Map<TopBarPanel, St.Widget>();
    for (const box of Main.layoutManager.uiGroup.get_children()) {
      if (box === Main.layoutManager.panelBox || !(box instanceof St.Widget)) continue;
      for (const child of box.get_children()) {
        if (!isTopBar(child)) continue;
        bars.add(child);
        if (!child.has_style_class_name('multimonitor-panel-vertical')) found.set(child, box);
      }
    }

    for (const panel of [...this._bars.keys()])
      if (!found.has(panel)) this._detach(panel);
    for (const panel of [...this._watched.keys()])
      if (!bars.has(panel)) this._unwatch(panel);
    for (const panel of bars)
      if (!this._watched.has(panel)) this._watch(panel);

    for (const [panel, box] of found) {
      if (this._bars.has(panel)) continue;
      const manager = new TopBarManager(this._path, this._settings, this._logger, panel, box, `top-bar:${++this._attached}`);
      // These bars belong to other extensions and may not be built the way TopBarManager expects.
      try {
        manager.setup();
      } catch (e) {
        manager.cleanup();
        this._logger.log(`[Liquid Glass] Could not attach glass to another top bar: ${e}`);
        continue;
      }
      this._bars.set(panel, manager);
    }
  }

  private _watch(panel: TopBarPanel) {
    // The glass and the styles must go while the bar's actors still exist.
    const destroyId = panel.connect('destroy', () => this._unwatch(panel));
    // Multi Monitors Bar marks a bar it moves to a side of the screen.
    const styleId = panel.connect('notify::style-class', () => this._scheduleScan());
    this._watched.set(panel, [destroyId, styleId]);
  }

  private _unwatch(panel: TopBarPanel) {
    this._detach(panel);
    for (const id of this._watched.get(panel) ?? []) panel.disconnect(id);
    this._watched.delete(panel);
  }

  private _detach(panel: TopBarPanel) {
    const manager = this._bars.get(panel);
    if (!manager) return;
    this._bars.delete(panel);
    manager.cleanup();
  }

  cleanup() {
    if (this._idleId) {
      GLib.Source.remove(this._idleId);
      this._idleId = 0;
    }

    for (const disconnect of this._disconnects) disconnect();
    this._disconnects = [];

    for (const panel of [...this._watched.keys()]) this._unwatch(panel);
  }
}
