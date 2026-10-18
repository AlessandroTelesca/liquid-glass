// Quick Settings' buttons coming out as the menu opens in toggle mode. They
// start smaller, gathered towards the middle of the area they end up in, and
// spring out to their places, those nearest the panel button fastest. Their
// glass shows from the start; their labels and icons fade in as they go.

// The size and spread the buttons start at, as a share of their own.
const START_SCALE = 0.7;
// A spring that swings once just past the end and settles without a second
// swing (about 6% over, then under 0.5%).
const RESPONSE_S = 0.27;
const DAMPING_FRACTION = 0.66;
// Its speed at the start, in the whole way per second. From rest it would hardly move in the first frames, which
// reads as a pause before the buttons grow.
const START_VELOCITY = 4;
// How fast the button furthest from the panel button springs out, as a share of the nearest's speed. Every button
// moves from the first frame, so none sits at its start size waiting for its turn.
const SLOWEST_SPEED = 0.65;
// The spring is within 0.2% of the end by then.
const SETTLE_S = Math.log(500) / (DAMPING_FRACTION * 2 * Math.PI / RESPONSE_S);
// The least gap (px) kept between two buttons' glass while they swing past their size.
export const MIN_GLASS_GAP = 3;
// How strongly the larger of two buttons that come too close is the one made smaller.
const YIELD_POWER = 8;

/** The spring's progress (0 to about 1.06, then 1) `t` seconds after it starts. */
export function introProgress(t: number): number {
  if (t <= 0) return 0;
  const omega0 = 2 * Math.PI / RESPONSE_S;
  const zeta = DAMPING_FRACTION;
  const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
  const decay = Math.exp(-zeta * omega0 * t);
  return 1 - decay * (Math.cos(omegaD * t) + (zeta * omega0 - START_VELOCITY) / omegaD * Math.sin(omegaD * t));
}

export interface IntroFrame {
  // Each button's rect [x, y, w, h], in the coordinates of the rects given.
  rects: number[][];
  // Of each button's content, 0 to 1.
  opacity: number[];
  done: boolean;
}

/**
 * The buttons' rects over time, from their rects at rest `rects` [x, y, w, h],
 * the point they come from first `anchor` (the panel button) and how far
 * their glass reaches past them `expand`.
 */
export class ToggleIntro {
  private _center: [number, number];
  private _speeds: number[];
  // Pairs of buttons and the least gap kept between them.
  private _pairs: { i: number, j: number, gap: number }[] = [];

  constructor(private _rects: number[][], anchor: [number, number], expand: number) {
    const x0 = Math.min(..._rects.map(r => r[0]));
    const y0 = Math.min(..._rects.map(r => r[1]));
    const x1 = Math.max(..._rects.map(r => r[0] + r[2]));
    const y1 = Math.max(..._rects.map(r => r[1] + r[3]));
    this._center = [(x0 + x1) / 2, (y0 + y1) / 2];

    const distances = _rects.map(r => Math.hypot(r[0] + r[2] / 2 - anchor[0], r[1] + r[3] / 2 - anchor[1]));
    const near = Math.min(...distances);
    const span = Math.max(...distances) - near;
    this._speeds = distances.map(d => span > 0 ? 1 - (1 - SLOWEST_SPEED) * (d - near) / span : 1);

    for (let i = 0; i < _rects.length; i++) {
      for (let j = i + 1; j < _rects.length; j++) {
        const rest = distance(_rects[i], _rects[j]);
        // Buttons whose glass already touches at rest are left as they are.
        if (rest - 2 * expand < 0) continue;
        this._pairs.push({ i, j, gap: Math.min(rest, 2 * expand + MIN_GLASS_GAP) });
      }
    }
  }

  frame(t: number): IntroFrame {
    const [cx, cy] = this._center;
    const progress = this._speeds.map(speed => introProgress(t * speed));
    const rects = this._rects.map((r, i) => {
      const k = START_SCALE + (1 - START_SCALE) * progress[i];
      const mx = cx + (r[0] + r[2] / 2 - cx) * k;
      const my = cy + (r[1] + r[3] / 2 - cy) * k;
      return [mx - r[2] * k / 2, my - r[3] * k / 2, r[2] * k, r[3] * k];
    });
    this._keepApart(rects);
    return {
      rects,
      opacity: progress.map(p => Math.min(Math.max(p, 0), 1)),
      done: t >= SETTLE_S / SLOWEST_SPEED,
    };
  }

  // Buttons grow and swing at different speeds, so one can grow into its
  // neighbour; both are made smaller about their middles until their glass is
  // far enough apart, the larger (as a share of its size at rest) by most of
  // the shortfall. The shares are weighed rather than compared, so the sizes
  // change smoothly when one button overtakes the other.
  private _keepApart(rects: number[][]): void {
    for (let pass = 0; pass < 3; pass++) {
      for (const { i, j, gap } of this._pairs) {
        const short = gap - distance(rects[i], rects[j]);
        if (short <= 0) continue;
        const [gx, gy] = axisGaps(rects[i], rects[j]);
        const [wi, wj] = [i, j].map(n => (rects[n][2] / this._rects[n][2]) ** YIELD_POWER);
        for (const [n, weight] of [[i, wi / (wi + wj)], [j, wj / (wi + wj)]]) {
          const r = rects[n];
          // Each side that faces the other moves in by this share of the shortfall.
          const shrink = (axis: number) => (r[axis + 2] - 2 * short * weight) / r[axis + 2];
          const k = Math.max(gx > 0 && gy > 0 ? Math.min(shrink(0), shrink(1)) : shrink(gx > gy ? 0 : 1), 0.5);
          const [mx, my] = [r[0] + r[2] / 2, r[1] + r[3] / 2];
          rects[n] = [mx - r[2] * k / 2, my - r[3] * k / 2, r[2] * k, r[3] * k];
        }
      }
    }
  }
}

// The gaps between two rects [x, y, w, h] across and down; negative where they overlap.
function axisGaps(a: number[], b: number[]): [number, number] {
  return [Math.max(a[0], b[0]) - Math.min(a[0] + a[2], b[0] + b[2]), Math.max(a[1], b[1]) - Math.min(a[1] + a[3], b[1] + b[3])];
}

// How far apart two rects are: corner to corner when they are apart both ways.
function distance(a: number[], b: number[]): number {
  const [gx, gy] = axisGaps(a, b);
  return gx > 0 && gy > 0 ? Math.hypot(gx, gy) : Math.max(gx, gy);
}
