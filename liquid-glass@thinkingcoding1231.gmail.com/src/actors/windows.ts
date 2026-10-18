import type Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

export function getWindowActors(): any[] {
  return global.get_window_actors();
}

/**
 * Whether a window above `actor` (which is in the window group) may cover any
 * of the stage rect [x0, y0, x1, y1]. Mutter does not draw the wallpaper and
 * windows under the opaque part of such a window, so the framebuffer there
 * still holds an older frame when `actor` is painted. The opaque region is
 * not known here; the whole window counts. A window that is translucent or
 * has an effect is not culled against.
 */
export function windowMayCover(actor: Clutter.Actor, rect: number[]): boolean {
  let top: Clutter.Actor | null = actor;
  while (top && top.get_parent() !== global.window_group) top = top.get_parent();
  if (!top) return false;
  for (let above = top.get_next_sibling(); above; above = above.get_next_sibling()) {
    if (!(above instanceof Meta.WindowActor) || !above.visible || above.get_paint_opacity() !== 255) continue;
    if (above.get_effects().some(effect => effect.enabled)) continue;
    const box = above.get_transformed_extents();
    const [x, y] = [box.get_x(), box.get_y()];
    if (x < rect[2] && y < rect[3] && x + box.get_width() > rect[0] && y + box.get_height() > rect[1]) return true;
  }
  return false;
}
