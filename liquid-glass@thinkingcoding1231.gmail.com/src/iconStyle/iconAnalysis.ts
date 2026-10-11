// Takes an application icon apart into the plates it is drawn on (rounded
// squares, circles and the like, outermost first) and the symbol drawn on them,
// so that it can be redrawn as glass plates under a one-colour symbol.
//
// A plate is a shape close to a rounded rectangle or a superellipse (a circle,
// an ellipse and a squircle are superellipses), possibly with regular teeth or
// waves along its outline. Its colour is one colour or a smooth gradient; a
// plate that carries a picture keeps its shape, and the picture is taken as
// the symbol. Pure computation on unpremultiplied RGBA, so that it runs in a
// worker process as well as in tests.

export interface IconPixels {
  width: number;
  height: number;
  // Unpremultiplied RGBA, 4 bytes a pixel.
  data: Uint8Array;
}

export interface Ripple {
  // Teeth or waves around the outline.
  count: number;
  // The radius is scaled by `scale * (1 + sum of amp * cos(n * count * angle - phase))`, n = 1, 2, 3.
  scale: number;
  harmonics: [number, number][];
}

export interface PlateShape {
  kind: 'roundrect' | 'superellipse';
  // Centre and half sizes, in px of the analysed image.
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  // The corner radius of a rounded rectangle (px), or a superellipse's exponent.
  radius: number;
  exponent: number;
  ripple: Ripple | null;
  // How well the shape covers the plate (intersection over union).
  fit: number;
}

export interface Plate {
  shape: PlateShape;
  // Oklab colour as a quadratic in (x, y) about the centre, in units of the
  // half sizes: one row of [1, x, y, x², xy, y²] coefficients a channel.
  color: number[][];
  // One colour or a regular gradient; false when it carries a picture.
  plain: boolean;
  // The plates it sits on, by index into IconAnalysis.plates (-1: none).
  parent: number;
  // How much of what is visible of it has its colour.
  surface: number;
  // How far its largest area's colours stray from the fitted colour (RMS,
  // Oklab), and that area's share of what is visible of the plate.
  error: number;
  share: number;
  // The typical distance of its pixels from its colour (grain, noise).
  noise: number;
}

export interface IconAnalysis {
  width: number;
  height: number;
  plates: Plate[];
  // Per pixel, 0 to 1: how much of the pixel is symbol.
  symbol: Float32Array;
  // Per pixel, 0 to 1: the symbol's lightness, stretched over its range.
  intensity: Float32Array;
}

// A shape counts as a plate when it covers the candidate this well.
const FIT_PLATE = 0.94;
// Oklab distances: neighbours closer than this are one area; a pixel this far
// from its plate's colour is symbol, fully from SYMBOL_HIGH.
const SAME_AREA = 0.035;
const SYMBOL_LOW = 0.045;
const SYMBOL_HIGH = 0.11;
// A plate whose largest area strays this much (RMS) from a smooth colour, or
// covers less than this share of it, carries a picture.
const PLAIN_RMS = 0.035;
const MIN_SURFACE = 0.3;
// The most grain (typical distance from the plate's colour) a plain plate has.
const MAX_GRAIN = 0.04;
// An area smaller than this share of the image is never a plate, and an inner
// plate has at least this share of the plate it sits on.
const MIN_PLATE_AREA = 0.04;
// A shape counts as a plate only when this much of it is opaque (an outline
// drawn on nothing is a symbol).
const MIN_OPAQUE = 0.85;
// A symbol whose core spans less lightness than this is one colour; parts of
// it that differ from its main tone are drawn this much weaker at most.
const FLAT_SYMBOL = 0.15;
const DETAIL_DIM = 0.45;
const MIN_INNER_SHARE = 0.1;
// A shape that falls a little short of a plate (smaller than MIN_PLATE_AREA or MIN_INNER_SHARE, or fitted less closely
// than FIT_PLATE) is one all the same when a plate on the same plate has about its size and proportions, so that of two or three
// alike shapes all become plates, not one.
const PEER_AREA = 0.012;
const PEER_FIT = 0.88;
const PEER_SIZE = 0.3;

const LINEAR = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

function oklab(r: number, g: number, b: number, out: Float32Array, at: number): void {
  const lr = LINEAR[r], lg = LINEAR[g], lb = LINEAR[b];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  out[at] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[at + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[at + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808650822 * s;
}

/** sRGB (0-255) of an Oklab colour. */
export function oklabToSrgb(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return lin.map(c => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(Math.max(v, 0), 1) * 255);
  }) as [number, number, number];
}

function smoothstep(lo: number, hi: number, x: number): number {
  const t = Math.min(Math.max((x - lo) / (hi - lo), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Signed distance (px, negative inside) from a pixel position to the shape's outline. */
export function shapeDistance(shape: PlateShape, x: number, y: number): number {
  const dx = x - shape.cx, dy = y - shape.cy;
  let d: number;
  if (shape.kind === 'roundrect') {
    const r = Math.min(shape.radius, shape.rx, shape.ry);
    const qx = Math.abs(dx) - shape.rx + r, qy = Math.abs(dy) - shape.ry + r;
    d = Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
  } else {
    const n = shape.exponent;
    const f = (Math.abs(dx / shape.rx) ** n + Math.abs(dy / shape.ry) ** n) ** (1 / n);
    // A first-order distance: the level set's value over the length of its gradient.
    d = (f - 1) * Math.min(shape.rx, shape.ry);
  }
  if (!shape.ripple) return d;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return d;
  const base = len - d;
  return len - base * rippleFactor(shape.ripple, Math.atan2(dy, dx));
}

function rippleFactor(ripple: Ripple, angle: number): number {
  let f = 1;
  ripple.harmonics.forEach(([amp, phase], i) => {
    f += amp * Math.cos((i + 1) * ripple.count * angle - phase);
  });
  return ripple.scale * f;
}

function coverageOf(shape: PlateShape, x: number, y: number): number {
  return Math.min(Math.max(0.5 - shapeDistance(shape, x + 0.5, y + 0.5), 0), 1);
}

interface Mask {
  data: Uint8Array;
  x1: number; y1: number; x2: number; y2: number;
  area: number;
}

function maskOf(data: Uint8Array, w: number, h: number): Mask {
  let x1 = w, y1 = h, x2 = -1, y2 = -1, area = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!data[y * w + x]) continue;
      area++;
      x1 = Math.min(x1, x);
      x2 = Math.max(x2, x);
      y1 = Math.min(y1, y);
      y2 = Math.max(y2, y);
    }
  }
  return { data, x1, y1, x2, y2, area };
}

function overlap(shape: PlateShape, mask: Mask, w: number, h: number): number {
  let inter = 0, union = 0;
  const x1 = Math.max(Math.floor(Math.min(mask.x1, shape.cx - shape.rx * 1.3)) - 2, 0);
  const x2 = Math.min(Math.ceil(Math.max(mask.x2, shape.cx + shape.rx * 1.3)) + 2, w - 1);
  const y1 = Math.max(Math.floor(Math.min(mask.y1, shape.cy - shape.ry * 1.3)) - 2, 0);
  const y2 = Math.min(Math.ceil(Math.max(mask.y2, shape.cy + shape.ry * 1.3)) + 2, h - 1);
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      const c = coverageOf(shape, x, y);
      const m = mask.data[y * w + x];
      inter += Math.min(c, m);
      union += Math.max(c, m);
    }
  }
  return union > 0 ? inter / union : 0;
}

const EXPONENTS = [2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 8];
const RADII = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

function fitBasic(mask: Mask, w: number, h: number): PlateShape {
  const base = {
    cx: (mask.x1 + mask.x2 + 1) / 2, cy: (mask.y1 + mask.y2 + 1) / 2,
    rx: (mask.x2 - mask.x1 + 1) / 2, ry: (mask.y2 - mask.y1 + 1) / 2,
    radius: 0, exponent: 2, ripple: null, fit: 0,
  };
  let best: PlateShape = { ...base, kind: 'roundrect' };
  const consider = (shape: PlateShape) => {
    shape.fit = overlap(shape, mask, w, h);
    if (shape.fit > best.fit) best = shape;
  };
  for (const t of RADII)
    consider({ ...base, kind: 'roundrect', radius: t * Math.min(base.rx, base.ry) });
  for (const n of EXPONENTS)
    consider({ ...base, kind: 'superellipse', exponent: n });
  return best;
}

// The outline's distance from the centre at `count` angles, or null when a ray
// leaves the shape more than once (not star-shaped).
function radii(mask: Mask, w: number, h: number, cx: number, cy: number, count: number): Float64Array | null {
  const out = new Float64Array(count);
  const reach = Math.hypot(mask.x2 - mask.x1 + 2, mask.y2 - mask.y1 + 2);
  let bent = 0;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * 2 * Math.PI;
    const ux = Math.cos(angle), uy = Math.sin(angle);
    let last = 0, inside = true, exits = 0;
    for (let r = 0; r <= reach; r += 0.25) {
      const x = Math.floor(cx + ux * r), y = Math.floor(cy + uy * r);
      const now = x >= 0 && y >= 0 && x < w && y < h && mask.data[y * w + x] > 0;
      if (now) last = r;
      else if (inside) exits++;
      inside = now;
    }
    if (exits > 1) bent++;
    out[i] = last;
  }
  return bent > count * 0.03 ? null : out;
}

// A shape with regular teeth or waves (a gear, a scalloped badge): the
// outline's distance from the centre is the basic shape's times a periodic
// factor whose energy sits in one count of teeth and its multiples.
function fitRipple(mask: Mask, w: number, h: number, basic: PlateShape): PlateShape | null {
  const N = 256;
  const measured = radii(mask, w, h, basic.cx, basic.cy, N);
  if (!measured) return null;
  const ratio = new Float64Array(N);
  let mean = 0;
  for (let i = 0; i < N; i++) {
    const angle = (i / N) * 2 * Math.PI;
    const ux = Math.cos(angle), uy = Math.sin(angle);
    // The basic shape's radius along the ray, by bisection on its distance.
    let lo = 0, hi = Math.max(basic.rx, basic.ry) * 2;
    const plain = { ...basic, ripple: null };
    for (let k = 0; k < 24; k++) {
      const mid = (lo + hi) / 2;
      if (shapeDistance(plain, basic.cx + ux * mid, basic.cy + uy * mid) < 0) lo = mid;
      else hi = mid;
    }
    ratio[i] = measured[i] / Math.max(lo, 1);
    mean += ratio[i];
  }
  mean /= N;
  const amps: number[] = [0], phases: number[] = [0];
  let total = 0;
  for (let k = 1; k <= N / 4; k++) {
    let re = 0, im = 0;
    for (let i = 0; i < N; i++) {
      const a = (k * i / N) * 2 * Math.PI;
      re += (ratio[i] / mean - 1) * Math.cos(a);
      im += (ratio[i] / mean - 1) * Math.sin(a);
    }
    amps[k] = Math.hypot(re, im) * 2 / N;
    phases[k] = Math.atan2(im, re);
    total += amps[k] ** 2;
  }
  let best = 0, bestEnergy = 0;
  for (let k = 4; 3 * k <= N / 4; k++) {
    const energy = amps[k] ** 2 + amps[2 * k] ** 2 + amps[3 * k] ** 2;
    if (energy > bestEnergy) {
      best = k;
      bestEnergy = energy;
    }
  }
  if (!best || amps[best] < 0.015 || bestEnergy < total * 0.75) return null;
  const shape: PlateShape = {
    ...basic,
    ripple: { count: best, scale: mean, harmonics: [1, 2, 3].map(n => [amps[n * best], phases[n * best]]) },
  };
  shape.fit = overlap(shape, mask, w, h);
  return shape.fit >= FIT_PLATE ? shape : null;
}

// The closest shape, which may fit less than FIT_PLATE (down to PEER_FIT).
function fitShape(mask: Mask, w: number, h: number): PlateShape | null {
  if (mask.x2 - mask.x1 < 6 || mask.y2 - mask.y1 < 6) return null;
  const basic = fitBasic(mask, w, h);
  if (basic.fit >= FIT_PLATE) return basic;
  return fitRipple(mask, w, h, basic) ?? (basic.fit >= PEER_FIT ? basic : null);
}

function areas(lab: Float32Array, opaque: Uint8Array, w: number, h: number): Int32Array {
  const parent = new Int32Array(w * h).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const near = (i: number, j: number) => Math.hypot(lab[i * 3] - lab[j * 3], lab[i * 3 + 1] - lab[j * 3 + 1],
    lab[i * 3 + 2] - lab[j * 3 + 2]) < SAME_AREA;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!opaque[i]) continue;
      for (const j of [x + 1 < w ? i + 1 : -1, y + 1 < h ? i + w : -1]) {
        if (j >= 0 && opaque[j] && near(i, j)) parent[find(i)] = find(j);
      }
    }
  }
  const labels = new Int32Array(w * h).fill(-1);
  for (let i = 0; i < w * h; i++) {
    if (opaque[i]) labels[i] = find(i);
  }
  return labels;
}

/** The mask with every hole in it filled. */
function filled(data: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!data[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w, y = (i - x) / w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  return outside.map(v => 1 - v);
}

const TERMS = 6;

function terms(shape: PlateShape, x: number, y: number, out: Float64Array): void {
  const u = (x - shape.cx) / shape.rx, v = (y - shape.cy) / shape.ry;
  out[0] = 1;
  out[1] = u;
  out[2] = v;
  out[3] = u * u;
  out[4] = u * v;
  out[5] = v * v;
}

/** The plate's Oklab colour at a pixel position. */
export function plateColor(plate: Plate, x: number, y: number, out: number[] = [0, 0, 0]): number[] {
  const t = new Float64Array(TERMS);
  terms(plate.shape, x, y, t);
  for (let c = 0; c < 3; c++) {
    let v = 0;
    for (let k = 0; k < TERMS; k++) v += plate.color[c][k] * t[k];
    out[c] = v;
  }
  return out;
}

function solve(a: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const m = Float64Array.from(a);
  const x = Float64Array.from(b);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r * n + col]) > Math.abs(m[pivot * n + col])) pivot = r;
    }
    if (Math.abs(m[pivot * n + col]) < 1e-9) return null;
    for (let k = 0; k < n; k++) [m[col * n + k], m[pivot * n + k]] = [m[pivot * n + k], m[col * n + k]];
    [x[col], x[pivot]] = [x[pivot], x[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r * n + col] / m[col * n + col];
      for (let k = col; k < n; k++) m[r * n + k] -= f * m[col * n + k];
      x[r] -= f * x[col];
    }
  }
  for (let r = 0; r < n; r++) x[r] /= m[r * n + r];
  return x;
}

// A least-squares quadratic colour over the pixels, refitted twice without the
// ones far from it (a symbol over the rim, the plate's own highlights).
function fitColor(shape: PlateShape, pixels: number[], lab: Float32Array, w: number):
  { color: number[][], rms: number, kept: number, noise: number } {
  // Start from the pixels near the median colour, so that a symbol that runs
  // into the plate through soft edges does not pull the first fit.
  const median = [0, 1, 2].map(ch => {
    const values = pixels.map(i => lab[i * 3 + ch]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)] ?? 0;
  });
  let weights = Float64Array.from(pixels, i => (Math.hypot(lab[i * 3] - median[0], lab[i * 3 + 1] - median[1],
    lab[i * 3 + 2] - median[2]) < 0.15 ? 1 : 0));
  let color: number[][] = [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]];
  let rms = 1, kept = 0, noise = 1;
  const t = new Float64Array(TERMS);
  for (let round = 0; round < 3; round++) {
    const ata = new Float64Array(TERMS * TERMS);
    const atb = [new Float64Array(TERMS), new Float64Array(TERMS), new Float64Array(TERMS)];
    pixels.forEach((i, n) => {
      if (!weights[n]) return;
      terms(shape, i % w + 0.5, Math.floor(i / w) + 0.5, t);
      for (let r = 0; r < TERMS; r++) {
        for (let c = 0; c < TERMS; c++) ata[r * TERMS + c] += t[r] * t[c];
        for (let ch = 0; ch < 3; ch++) atb[ch][r] += t[r] * lab[i * 3 + ch];
      }
    });
    // A little damping keeps the curvature terms from running off on a thin rim.
    for (let r = 1; r < TERMS; r++) ata[r * TERMS + r] += r >= 3 ? 2 : 0.5;
    const solved = atb.map(b => solve(ata, b, TERMS));
    if (solved.some(s => !s)) break;
    color = solved.map(s => Array.from(s!));
    const residuals = pixels.map(i => {
      terms(shape, i % w + 0.5, Math.floor(i / w) + 0.5, t);
      let d2 = 0;
      for (let ch = 0; ch < 3; ch++) {
        let v = 0;
        for (let k = 0; k < TERMS; k++) v += color[ch][k] * t[k];
        d2 += (v - lab[i * 3 + ch]) ** 2;
      }
      return Math.sqrt(d2);
    });
    const sorted = [...residuals].sort((a, b) => a - b);
    noise = sorted[Math.floor(sorted.length * 0.5)] ?? 1;
    const limit = Math.max(noise * 3, 0.03);
    weights = Float64Array.from(residuals, r => (r <= limit ? 1 : 0));
    let sum = 0;
    kept = 0;
    residuals.forEach((r, n) => {
      if (!weights[n]) return;
      sum += r * r;
      kept++;
    });
    rms = kept ? Math.sqrt(sum / kept) : 1;
  }
  return { color, rms, kept: pixels.length ? kept / pixels.length : 0, noise };
}

interface Candidate {
  mask: Mask;
  shape: PlateShape;
  // Whether it is a plate on its own, rather than only beside one like it.
  strict: boolean;
}

function alike(a: Candidate, b: Candidate): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) <= PEER_SIZE * Math.max(x, y);
  return near(a.mask.area, b.mask.area) && near(a.shape.rx, b.shape.rx) && near(a.shape.ry, b.shape.ry);
}

export function analyzeIcon(icon: IconPixels): IconAnalysis {
  const { width: w, height: h, data } = icon;
  const n = w * h;
  const lab = new Float32Array(n * 3);
  const alpha = new Float32Array(n);
  const opaque = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    oklab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], lab, i * 3);
    alpha[i] = data[i * 4 + 3] / 255;
    opaque[i] = alpha[i] >= 0.5 ? 1 : 0;
  }

  // Candidates: the whole silhouette, and every large area with its holes filled.
  const candidates: Candidate[] = [];
  const add = (fill: Uint8Array) => {
    const mask = maskOf(fill, w, h);
    if (mask.area < n * PEER_AREA) return;
    let solid = 0;
    for (let i = 0; i < n; i++) solid += fill[i] & opaque[i];
    if (solid < mask.area * MIN_OPAQUE) return;
    const shape = fitShape(mask, w, h);
    if (shape) candidates.push({ mask, shape, strict: mask.area >= n * MIN_PLATE_AREA && shape.fit >= FIT_PLATE });
  };
  add(filled(opaque, w, h));
  const labels = areas(lab, opaque, w, h);
  const sizes = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (labels[i] >= 0) sizes.set(labels[i], (sizes.get(labels[i]) ?? 0) + 1);
  }
  for (const [label, size] of sizes) {
    if (size < n * PEER_AREA * 0.5) continue;
    const area = new Uint8Array(n);
    for (let i = 0; i < n; i++) area[i] = labels[i] === label ? 1 : 0;
    add(filled(area, w, h));
  }

  // Outermost first. A candidate the same as one kept already is the same
  // plate, and one that lies partly over a kept plate is not a plate.
  candidates.sort((a, b) => b.mask.area - a.mask.area);
  const kept: Candidate[] = [];
  const parents: number[] = [];
  // How much of `mask` lies in `shape`.
  const share = (mask: Mask, shape: PlateShape) => {
    let inside = 0;
    for (let i = 0; i < n; i++) {
      if (mask.data[i] && coverageOf(shape, i % w, Math.floor(i / w)) > 0.5) inside++;
    }
    return inside / mask.area;
  };
  // The kept plate `c` lies in, -1 for none, or null when it lies partly over one.
  const placeOf = (c: Candidate): number | null => {
    if (kept.some(k => overlap(k.shape, c.mask, w, h) > 0.95)) return null;
    const shares = kept.map(k => share(c.mask, k.shape));
    if (shares.some(share => share > 0.1 && share < 0.9)) return null;
    let parent = -1;
    for (let k = kept.length - 1; k >= 0 && parent < 0; k--) {
      if (shares[k] >= 0.9) parent = k;
    }
    return parent;
  };
  const loose = candidates.filter(candidate => !candidate.strict);
  for (const c of candidates.filter(candidate => candidate.strict)) {
    const parent = placeOf(c);
    if (parent === null) continue;
    if (parent >= 0 && c.mask.area < kept[parent].mask.area * MIN_INNER_SHARE) {
      loose.push(c);
      continue;
    }
    kept.push(c);
    parents.push(parent);
  }
  // Then the shapes alike to a kept plate on the same plate. Nothing kept lies in them, so they go last.
  loose.sort((a, b) => b.mask.area - a.mask.area);
  for (const c of loose) {
    const parent = placeOf(c);
    if (parent === null || !kept.some((k, i) => parents[i] === parent && alike(k, c))) continue;
    if (kept.some(k => k.mask.area < c.mask.area && share(k.mask, c.shape) >= 0.9)) continue;
    kept.push(c);
    parents.push(parent);
  }

  // Per pixel, the innermost plate it is in.
  const owner = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const x = i % w + 0.5, y = Math.floor(i / w) + 0.5;
    for (let k = kept.length - 1; k >= 0; k--) {
      if (shapeDistance(kept[k].shape, x, y) < 0) {
        owner[i] = k;
        break;
      }
    }
  }

  // A plate's colour is that of its largest smooth area: its rim may carry a
  // lit edge or a border, and a symbol may cross it. A plate whose largest
  // area is a small part of it carries a picture.
  const plates: Plate[] = kept.map((c, k) => {
    const own: number[] = [];
    const counts = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      if (owner[i] !== k || !opaque[i]) continue;
      own.push(i);
      counts.set(labels[i], (counts.get(labels[i]) ?? 0) + 1);
    }
    let main = -1, most = 0;
    for (const [label, count] of counts) {
      if (count > most) {
        main = label;
        most = count;
      }
    }
    // Grain breaks a plate into specks; then the fit starts from all of it.
    const share = own.length ? most / own.length : 0;
    const fit = fitColor(c.shape, share >= MIN_SURFACE ? own.filter(i => labels[i] === main) : own, lab, w);
    const plate: Plate = { shape: c.shape, color: fit.color, plain: false, parent: parents[k], surface: 0, error: fit.rms,
      share, noise: fit.noise };
    let surface = 0;
    const at = [0, 0, 0];
    const near = Math.max(SYMBOL_LOW, fit.noise * 3);
    for (const i of own) {
      plateColor(plate, i % w + 0.5, Math.floor(i / w) + 0.5, at);
      if (Math.hypot(at[0] - lab[i * 3], at[1] - lab[i * 3 + 1], at[2] - lab[i * 3 + 2]) < near) surface++;
    }
    plate.surface = own.length ? surface / own.length : 0;
    // A grainy plate strays evenly: its typical pixel is near its colour.
    plate.plain = plate.surface >= MIN_SURFACE && (fit.rms < PLAIN_RMS || fit.noise < MAX_GRAIN);
    return plate;
  });

  const { symbol, intensity } = symbolLayer(plates, w, icon);
  return { width: w, height: h, plates, symbol, intensity };
}

// Oklab distance from `c` to the segment from `p` to `q`: a pixel on the
// line between two plates mixes their colours.
function segmentDistance(c: ArrayLike<number>, p: number[], q: number[]): number {
  const v = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const len2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  const t = len2 > 0 ? Math.min(Math.max(((c[0] - p[0]) * v[0] + (c[1] - p[1]) * v[1] + (c[2] - p[2]) * v[2]) / len2, 0), 1) : 0;
  return Math.hypot(c[0] - p[0] - v[0] * t, c[1] - p[1] - v[1] * t, c[2] - p[2] - v[2] * t);
}

/**
 * The symbol over `plates` (from analyzeIcon() at `analysisWidth` px) in
 * `pixels`, which may be the icon drawn at another size: per pixel how much of
 * it is symbol, and the symbol's own lightness against its main tone.
 *
 * A pixel's distance from its plate's colour grows with how much of it the
 * symbol covers, up to the symbol's full colour; that is taken from the
 * strongest pixel next to it that differs from the plate the same way, so
 * that anti-aliased edges keep their partial coverage instead of turning
 * solid.
 */
export function symbolLayer(plates: Plate[], analysisWidth: number, pixels: IconPixels):
  { symbol: Float32Array, intensity: Float32Array } {
  const { width: w, height: h, data } = pixels;
  const n = w * h;
  // Analysis px per pixel.
  const s = analysisWidth / w;
  const lab = new Float32Array(n * 3);
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    oklab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], lab, i * 3);
    alpha[i] = data[i * 4 + 3] / 255;
  }
  const owner = new Int32Array(n).fill(-1);
  // How far inside its plate a pixel is, in pixels.
  const depth = new Float32Array(n);
  // Per pixel, the colour of its plate and how far it is from it (Oklab).
  const base = new Float32Array(n * 3);
  const raw = new Float32Array(n);
  const low = new Float32Array(n);
  const at = [0, 0, 0], other = [0, 0, 0];
  const c = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const x = (i % w + 0.5) * s, y = (Math.floor(i / w) + 0.5) * s;
    const near: number[] = [];
    for (let k = plates.length - 1; k >= 0; k--) {
      const d = shapeDistance(plates[k].shape, x, y) / s;
      if (d < 0 && owner[i] < 0) {
        owner[i] = k;
        depth[i] = d;
      } else if (Math.abs(d) < 1.5) {
        near.push(k);
      }
    }
    const k = owner[i];
    if (k < 0 || !plates[k].plain) {
      raw[i] = Infinity;
      continue;
    }
    const plate = plates[k];
    plateColor(plate, x, y, at);
    base.set(at, i * 3);
    low[i] = Math.max(SYMBOL_LOW, plate.noise * 3);
    // The plate's own anti-aliased outline is not symbol.
    if (depth[i] > -1.2 && plate.parent < 0) continue;
    c[0] = lab[i * 3];
    c[1] = lab[i * 3 + 1];
    c[2] = lab[i * 3 + 2];
    let d = Math.hypot(c[0] - at[0], c[1] - at[1], c[2] - at[2]);
    // Along the outline between two plates, the pixel mixes them.
    for (const j of near) {
      if (j === k || !plates[j].plain) continue;
      d = Math.min(d, segmentDistance(c, at, plateColor(plates[j], x, y, other)));
    }
    raw[i] = d;
  }

  // Coverage: the distance over that of the strongest pixel within reach that
  // differs from the plate in the same direction.
  const reach = Math.max(1, Math.ceil(1 / s));
  const cover = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = raw[i];
    if (d === Infinity) {
      cover[i] = 1;
      continue;
    }
    if (!(d > low[i])) continue;
    const x = i % w, y = Math.floor(i / w);
    const dx = lab[i * 3] - base[i * 3], dy = lab[i * 3 + 1] - base[i * 3 + 1], dz = lab[i * 3 + 2] - base[i * 3 + 2];
    let full = d;
    for (let v = Math.max(0, y - reach); v <= Math.min(h - 1, y + reach); v++) {
      for (let u = Math.max(0, x - reach); u <= Math.min(w - 1, x + reach); u++) {
        const j = v * w + u;
        if (raw[j] === Infinity || !(raw[j] > full) || owner[j] !== owner[i]) continue;
        const ex = lab[j * 3] - base[i * 3], ey = lab[j * 3 + 1] - base[i * 3 + 1], ez = lab[j * 3 + 2] - base[i * 3 + 2];
        const dot = dx * ex + dy * ey + dz * ez;
        if (dot > 0.9 * d * Math.hypot(ex, ey, ez)) full = raw[j];
      }
    }
    full = Math.max(full, low[i] + SYMBOL_HIGH - SYMBOL_LOW);
    cover[i] = Math.min(Math.max((d - low[i]) / (full - low[i]), 0), 1);
  }

  // A line that runs all along a plate at one depth (a lit edge, a border) is
  // part of the plate. A symbol rarely fills most of a ring at one depth.
  plates.forEach((plate, k) => {
    if (!plate.plain) return;
    const deepest = Math.max(6, Math.min(plate.shape.rx, plate.shape.ry) * 0.15) / s;
    const bins = Math.ceil(deepest * 2);
    const total = new Float64Array(bins), marked = new Float64Array(bins), sums = new Float64Array(bins * 3);
    for (let i = 0; i < n; i++) {
      if (owner[i] !== k || -depth[i] >= deepest) continue;
      const b = Math.floor(-depth[i] * 2);
      total[b]++;
      if (cover[i] <= 0.5) continue;
      marked[b]++;
      for (let ch = 0; ch < 3; ch++) sums[b * 3 + ch] += lab[i * 3 + ch];
    }
    const ring = (b: number) => b >= 0 && b < bins && total[b] >= 20 / s && marked[b] > total[b] * 0.6;
    const spread = Math.ceil(1 / s);
    for (let i = 0; i < n; i++) {
      if (owner[i] !== k || -depth[i] >= deepest || !cover[i]) continue;
      const b = Math.floor(-depth[i] * 2);
      // The ring's own bins, or ones next to them for its anti-aliased sides.
      let r = -1;
      for (let o = 0; o <= spread * 2 && r < 0; o++) {
        if (ring(b - o)) r = b - o;
        else if (ring(b + o)) r = b + o;
      }
      if (r < 0) continue;
      const mean = [sums[r * 3] / marked[r], sums[r * 3 + 1] / marked[r], sums[r * 3 + 2] / marked[r]];
      const d = segmentDistance(lab.subarray(i * 3, i * 3 + 3), Array.from(base.subarray(i * 3, i * 3 + 3)), mean);
      cover[i] *= smoothstep(0.04, 0.1, d);
    }
  });

  // The symbol's main tone (the median lightness of its core) is drawn at
  // full strength, and parts that differ from it, lighter or darker, a little
  // weaker, so that details stay visible in one colour. A partly covered
  // pixel's lightness is taken back to the symbol's own.
  const own = new Float32Array(n);
  const lights: number[] = [];
  for (let i = 0; i < n; i++) {
    const L = lab[i * 3];
    own[i] = raw[i] === Infinity || cover[i] <= 0 ? L
      : base[i * 3] + (L - base[i * 3]) / Math.max(cover[i], 0.25);
    if (cover[i] > 0.9 && alpha[i] > 0.5) lights.push(own[i]);
  }
  lights.sort((a, b) => a - b);
  const main = lights.length ? lights[Math.floor(lights.length / 2)] : 0;
  const spread = lights.map(l => Math.abs(l - main)).sort((a, b) => a - b)[Math.floor(lights.length * 0.9)] ?? 0;
  const symbol = new Float32Array(n);
  const intensity = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    symbol[i] = alpha[i] * cover[i];
    intensity[i] = spread < FLAT_SYMBOL / 2 ? 1
      : 1 - DETAIL_DIM * smoothstep(FLAT_SYMBOL / 4, Math.max(spread, FLAT_SYMBOL), Math.abs(own[i] - main));
  }
  return { symbol, intensity };
}
