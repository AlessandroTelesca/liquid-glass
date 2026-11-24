import type Clutter from 'gi://Clutter';
import type Gio from 'gi://Gio';
import type St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { BackdropGlass } from './rendering/backdropGlass.js';
import { ensureGlassAllocated, isActorValid, placeScreenGlass, GLASS_SHADOW_MAX_RADIUS } from './actors.js';
import { startSyncLoop, stopStageLoop, hexToColorArray } from './animation.js';
import type { Logger } from './logger.js';

// The clock Hide Top Bar: Multi Monitors (hidetopbar-multimonitor@alessandrot) shows on a monitor while that
// monitor's panel is hidden: the uiGroup child of CLOCK_NAME, holding the tab the clock sits on, and inside the tab
// the actor of BODY_NAME, the tab without its flares into the screen edge. BACKED_CLASS on the tab tells it to leave
// the tab unpainted.
const CLOCK_NAME = 'hidetopbar-mm-clock';
const BODY_NAME = 'hidetopbar-mm-clock-body';
const BACKED_CLASS = 'liquid-glass-backed';
const LABEL_CLASS = 'hidetopbar-mm-clock';

// Room around the glass rect for the shader's edge effects.
const SHADER_PADDING = 20;

// What decides whether the glass grows out of the screen edge or floats off it: the top bar's own settings while the
// top bar has glass, the dock's while only the dock has. Floating, the gap to the edge is the top bar's top margin
// either way: a clock at the top of the screen has no business sitting as far off as a dock does.
const EDGE_KEYS = {
  topBar: { attach: 'top-bar-attach-to-edge', flare: 'top-bar-edge-radius', corner: 'top-bar-corner-radius' },
  dock: { attach: 'dock-attach-to-edge', flare: 'dock-edge-radius', corner: 'dock-corner-radius' },
};
const EDGE_WATCHED = [
  'top-bar-style', 'top-bar-in-dock', 'enable-dock-glass', 'top-bar-margin-top',
  ...Object.values(EDGE_KEYS).flatMap(keys => Object.values(keys)),
];

function edgeSettings(settings: Gio.Settings) {
  const topBarHasGlass = settings.get_string('top-bar-style') !== 'off' && !settings.get_boolean('top-bar-in-dock');
  const keys = !topBarHasGlass && settings.get_boolean('enable-dock-glass') ? EDGE_KEYS.dock : EDGE_KEYS.topBar;
  return {
    attached: settings.get_boolean(keys.attach),
    flare: settings.get_double(keys.flare),
    margin: settings.get_int('top-bar-margin-top'),
    corner: settings.get_double(keys.corner),
  };
}

// The tab's glass has the top bar's look.
const MATERIAL: [string, (glass: BackdropGlass, settings: Gio.Settings) => void][] = [
  ['top-bar-tint-color', (g, s) => g.setTintColor(...hexToColorArray(s.get_string('top-bar-tint-color')))],
  ['top-bar-tint-strength', (g, s) => g.setTintStrength(s.get_double('top-bar-tint-strength'))],
  ['top-bar-blur-radius', (g, s) => g.setBlurRadius(s.get_int('top-bar-blur-radius'))],
  ['top-bar-brightness', (g, s) => g.setBrightness(s.get_double('top-bar-brightness'))],
  ['top-bar-contrast', (g, s) => g.setContrast(s.get_double('top-bar-contrast'))],
  ['top-bar-saturation', (g, s) => g.setSaturation(s.get_double('top-bar-saturation'))],
];

function findByName(root: Clutter.Actor, name: string): Clutter.Actor | null {
  if (root.get_name() === name) return root;
  for (const child of root.get_children()) {
    const found = findByName(child, name);
    if (found) return found;
  }
  return null;
}

/** Glass behind one clock's tab, grown out of the screen edge the tab sits on or floating off it, fading with the clock. */
class ClockGlass {
  private _glass: BackdropGlass;
  private _tab: St.Widget;
  private _label: St.Label | undefined;
  private _frameSyncId = 0;
  private _frameSignalId = 0;

  constructor(path: string, private _settings: Gio.Settings, logger: Logger, private _clock: Clutter.Actor,
    private _body: Clutter.Actor) {
    this._tab = _body.get_parent() as St.Widget;
    this._tab.add_style_class_name(BACKED_CLASS);
    this._label = this._tab.get_children().find(child => (child as St.Widget).has_style_class_name(LABEL_CLASS)) as St.Label | undefined;

    const glass = new BackdropGlass({ extensionPath: path, settings: _settings, logger, owner: 'hidden-clock' } as any);
    this._glass = glass;
    glass.reactive = false;
    glass.setPadding(SHADER_PADDING);
    glass.setIsDock(false);
    glass.setShadowMaxRadius(GLASS_SHADOW_MAX_RADIUS);
    this.applyMaterial();
    Main.layoutManager.uiGroup.insert_child_below(glass, _clock);

    startSyncLoop(this._frameSignalSlot, this._frameSlot, {
      alive: () => isActorValid(this._clock) && isActorValid(this._glass),
      honourFreeze: true,
      errorTag: 'HiddenClockGlass',
      step: () => {
        ensureGlassAllocated(this._glass);
        this._sync();
      },
    });
  }

  refresh(): void {
    this._glass.queue_redraw();
  }

  applyMaterial(): void {
    for (const [, apply] of MATERIAL) apply(this._glass, this._settings);
    this._glass.queue_redraw();
  }

  private _sync(): void {
    const glass = this._glass;
    const clock = this._clock;
    // Right below the clock, so the glass reads the stage before the clock is drawn. The clock restacks itself after
    // it is added (below its panel), which would leave the glass on top of its text: follow it.
    if (glass.get_next_sibling() !== clock) Main.layoutManager.uiGroup.set_child_below_sibling(glass, clock);
    const shown = clock.visible && clock.mapped && clock.opacity > 0 && this._body.mapped;
    const edge = edgeSettings(this._settings);
    const [x, y] = this._body.get_transformed_position();
    const [w, h] = this._body.get_transformed_size();
    const monitor = Main.layoutManager.findMonitorForActor(clock);
    if (!shown || !monitor || ![x, y].every(Number.isFinite) || !(w > 1) || !(h > 1)) {
      if (glass.visible) glass.hide();
      return;
    }
    if (!glass.visible) glass.show();
    glass.opacity = clock.get_paint_opacity();

    // A panel at the bottom of its monitor hides behind the bottom edge, and its clock grows out of that.
    const moved = clock.translation_y;
    const atBottom = y - moved + h / 2 > monitor.y + monitor.height / 2;
    // The tab has more padding on one side, as it hangs off the screen edge: a floating pill hugs the text evenly.
    let pillY = y;
    let pillH = h;
    const text = this._label?.clutter_text;
    if (!edge.attached && text) {
      const [, textY] = text.get_transformed_position();
      const [, textH] = text.get_transformed_size();
      const pad = Math.min(textY - y, y + h - textY - textH);
      if (pad >= 0 && textH > 0) {
        pillY = textY - pad;
        pillH = textH + pad * 2;
      }
    }
    // The clock moves with its glass, off the edge by the margin, so the text stays centered on it.
    const wanted = atBottom ? monitor.y + monitor.height - edge.margin - pillH : monitor.y + edge.margin;
    const target = edge.attached ? 0 : Math.round(moved + wanted - pillY);
    if (moved !== target) clock.translation_y = target;
    pillY += target - moved;
    glass.setAttachedEdge(edge.attached ? (atBottom ? 'bottom' : 'top') : 'none', edge.flare);
    glass.setCornerRadius(edge.attached ? pillH / 2 : Math.min(edge.corner, pillH / 2));
    const p = SHADER_PADDING;
    const rect = { x: x - p - monitor.x, y: pillY - p - monitor.y, w: w + p * 2, h: pillH + p * 2 };
    placeScreenGlass(glass, monitor.x, monitor.y, monitor.width, monitor.height, rect);
    glass.setResolution(monitor.width, monitor.height);
    glass.setGlassGeometry(rect.x, rect.y, rect.w, rect.h);
    // After the geometry setters, so the relays cover this frame's rect.
    glass.syncSources();
  }

  destroy(): void {
    stopStageLoop(this._frameSignalSlot, this._frameSlot);
    if (isActorValid(this._tab)) this._tab.remove_style_class_name(BACKED_CLASS);
    if (isActorValid(this._clock)) this._clock.translation_y = 0;
    this._glass.cleanup();
    if (isActorValid(this._glass)) this._glass.destroy();
  }

  private get _frameSlot() {
    return { get: () => this._frameSyncId, set: (id: number) => { this._frameSyncId = id; } };
  }

  private get _frameSignalSlot() {
    return { get: () => this._frameSignalId, set: (id: number) => { this._frameSignalId = id; } };
  }
}

/**
 * Glass behind the clock Hide Top Bar: Multi Monitors shows on a monitor while its panel is hidden
 * (enable-hidden-clock-glass), in place of the dark tab it draws itself.
 */
export class HiddenClockGlass {
  private _clocks = new Map<Clutter.Actor, ClockGlass>();
  private _settingsIds: number[] = [];
  private _uiGroupIds: number[] = [];

  constructor(private _path: string, private _settings: Gio.Settings, private _logger: Logger) {}

  setup(): void {
    this._settingsIds.push(this._settings.connect('changed::enable-hidden-clock-glass', () => this._apply()));
    for (const [key] of MATERIAL)
      this._settingsIds.push(this._settings.connect(`changed::${key}`, () => {
        for (const clock of this._clocks.values()) clock.applyMaterial();
      }));
    // The edge look is read with the geometry on the next frame, which a redraw brings.
    for (const key of EDGE_WATCHED)
      this._settingsIds.push(this._settings.connect(`changed::${key}`, () => {
        for (const clock of this._clocks.values()) clock.refresh();
      }));
    this._apply();
  }

  private _apply(): void {
    this._stop();
    if (!this._settings.get_boolean('enable-hidden-clock-glass')) return;
    const uiGroup = Main.layoutManager.uiGroup;
    this._uiGroupIds = [
      uiGroup.connect('child-added', (_group: Clutter.Actor, child: Clutter.Actor) => this._add(child)),
      uiGroup.connect('child-removed', (_group: Clutter.Actor, child: Clutter.Actor) => this._remove(child)),
    ];
    for (const child of uiGroup.get_children()) this._add(child);
  }

  private _add(child: Clutter.Actor): void {
    if (child.get_name() !== CLOCK_NAME || this._clocks.has(child)) return;
    const body = findByName(child, BODY_NAME);
    if (!body?.get_parent()) return;
    this._clocks.set(child, new ClockGlass(this._path, this._settings, this._logger, child, body));
  }

  private _remove(child: Clutter.Actor): void {
    this._clocks.get(child)?.destroy();
    this._clocks.delete(child);
  }

  private _stop(): void {
    const uiGroup = Main.layoutManager.uiGroup;
    for (const id of this._uiGroupIds) uiGroup.disconnect(id);
    this._uiGroupIds = [];
    for (const clock of this._clocks.values()) clock.destroy();
    this._clocks.clear();
  }

  cleanup(): void {
    for (const id of this._settingsIds) this._settings.disconnect(id);
    this._settingsIds = [];
    this._stop();
  }
}
