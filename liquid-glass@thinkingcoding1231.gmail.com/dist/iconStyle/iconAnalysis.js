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
const LINEAR = new Float32Array(256).map((_, i) => {
    const c = i / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

function oklab(r, g, b, out, at) {
    const lr = LINEAR[r], lg = LINEAR[g], lb = LINEAR[b];
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    out[at] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    out[at + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    out[at + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808650822 * s;
}

/** sRGB (0-255) of an Oklab colour. */
export function oklabToSrgb(L, a, b) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
    return lin.map(c => {
        const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055;
        return Math.round(Math.min(Math.max(v, 0), 1) * 255);
    });
}

function smoothstep(lo, hi, x) {
    const t = Math.min(Math.max((x - lo) / (hi - lo), 0), 1);
    return t * t * (3 - 2 * t);
}

// Shapes
/** Signed distance (px, negative inside) from a pixel position to the shape's outline. */
export function shapeDistance(shape, x, y) {
    const dx = x - shape.cx, dy = y - shape.cy;
    let d;
    if (shape.kind === 'roundrect') {
        const r = Math.min(shape.radius, shape.rx, shape.ry);
        const qx = Math.abs(dx) - shape.rx + r, qy = Math.abs(dy) - shape.ry + r;
        d = Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
    }
    else {
        const n = shape.exponent;
        const f = (Math.abs(dx / shape.rx) ** n + Math.abs(dy / shape.ry) ** n) ** (1 / n);
        // A first-order distance: the level set's value over the length of its gradient.
        d = (f - 1) * Math.min(shape.rx, shape.ry);
    }
    if (!shape.ripple)
        return d;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6)
        return d;
    const base = len - d;
    return len - base * rippleFactor(shape.ripple, Math.atan2(dy, dx));
}

function rippleFactor(ripple, angle) {
    let f = 1;
    ripple.harmonics.forEach(([amp, phase], i) => {
        f += amp * Math.cos((i + 1) * ripple.count * angle - phase);
    });
    return ripple.scale * f;
}

function coverageOf(shape, x, y) {
    return Math.min(Math.max(0.5 - shapeDistance(shape, x + 0.5, y + 0.5), 0), 1);
}

function maskOf(data, w, h) {
    let x1 = w, y1 = h, x2 = -1, y2 = -1, area = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!data[y * w + x])
                continue;
            area++;
            x1 = Math.min(x1, x);
            x2 = Math.max(x2, x);
            y1 = Math.min(y1, y);
            y2 = Math.max(y2, y);
        }
    }
    return { data, x1, y1, x2, y2, area };
}

function overlap(shape, mask, w, h) {
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

function fitBasic(mask, w, h) {
    const base = {
        cx: (mask.x1 + mask.x2 + 1) / 2, cy: (mask.y1 + mask.y2 + 1) / 2,
        rx: (mask.x2 - mask.x1 + 1) / 2, ry: (mask.y2 - mask.y1 + 1) / 2,
        radius: 0, exponent: 2, ripple: null, fit: 0,
    };
    let best = { ...base, kind: 'roundrect' };
    const consider = (shape) => {
        shape.fit = overlap(shape, mask, w, h);
        if (shape.fit > best.fit)
            best = shape;
    };
    for (const t of RADII)
        consider({ ...base, kind: 'roundrect', radius: t * Math.min(base.rx, base.ry) });
    for (const n of EXPONENTS)
        consider({ ...base, kind: 'superellipse', exponent: n });
    return best;
}

// The outline's distance from the centre at `count` angles, or null when a ray
// leaves the shape more than once (not star-shaped).
function radii(mask, w, h, cx, cy, count) {
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
            if (now)
                last = r;
            else if (inside)
                exits++;
            inside = now;
        }
        if (exits > 1)
            bent++;
        out[i] = last;
    }
    return bent > count * 0.03 ? null : out;
}

// A shape with regular teeth or waves (a gear, a scalloped badge): the
// outline's distance from the centre is the basic shape's times a periodic
// factor whose energy sits in one count of teeth and its multiples.
function fitRipple(mask, w, h, basic) {
    const N = 256;
    const measured = radii(mask, w, h, basic.cx, basic.cy, N);
    if (!measured)
        return null;
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
            if (shapeDistance(plain, basic.cx + ux * mid, basic.cy + uy * mid) < 0)
                lo = mid;
            else
                hi = mid;
        }
        ratio[i] = measured[i] / Math.max(lo, 1);
        mean += ratio[i];
    }
    mean /= N;
    const amps = [0], phases = [0];
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
    if (!best || amps[best] < 0.015 || bestEnergy < total * 0.75)
        return null;
    const shape = {
        ...basic,
        ripple: { count: best, scale: mean, harmonics: [1, 2, 3].map(n => [amps[n * best], phases[n * best]]) },
    };
    shape.fit = overlap(shape, mask, w, h);
    return shape.fit >= FIT_PLATE ? shape : null;
}

function fitShape(mask, w, h) {
    if (mask.x2 - mask.x1 < 8 || mask.y2 - mask.y1 < 8)
        return null;
    const basic = fitBasic(mask, w, h);
    if (basic.fit >= FIT_PLATE)
        return basic;
    return fitRipple(mask, w, h, basic);
}

// Areas
function areas(lab, opaque, w, h) {
    const parent = new Int32Array(w * h).map((_, i) => i);
    const find = (i) => {
        while (parent[i] !== i) {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        return i;
    };
    const near = (i, j) => Math.hypot(lab[i * 3] - lab[j * 3], lab[i * 3 + 1] - lab[j * 3 + 1], lab[i * 3 + 2] - lab[j * 3 + 2]) < SAME_AREA;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (!opaque[i])
                continue;
            for (const j of [x + 1 < w ? i + 1 : -1, y + 1 < h ? i + w : -1]) {
                if (j >= 0 && opaque[j] && near(i, j))
                    parent[find(i)] = find(j);
            }
        }
    }
    const labels = new Int32Array(w * h).fill(-1);
    for (let i = 0; i < w * h; i++) {
        if (opaque[i])
            labels[i] = find(i);
    }
    return labels;
}

/** The mask with every hole in it filled. */
function filled(data, w, h) {
    const outside = new Uint8Array(w * h);
    const stack = [];
    const push = (i) => {
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
        const i = stack.pop();
        const x = i % w, y = (i - x) / w;
        if (x > 0)
            push(i - 1);
        if (x < w - 1)
            push(i + 1);
        if (y > 0)
            push(i - w);
        if (y < h - 1)
            push(i + w);
    }
    return outside.map(v => 1 - v);
}

// Colour
const TERMS = 6;

function terms(shape, x, y, out) {
    const u = (x - shape.cx) / shape.rx, v = (y - shape.cy) / shape.ry;
    out[0] = 1;
    out[1] = u;
    out[2] = v;
    out[3] = u * u;
    out[4] = u * v;
    out[5] = v * v;
}

/** The plate's Oklab colour at a pixel position. */
export function plateColor(plate, x, y, out = [0, 0, 0]) {
    const t = new Float64Array(TERMS);
    terms(plate.shape, x, y, t);
    for (let c = 0; c < 3; c++) {
        let v = 0;
        for (let k = 0; k < TERMS; k++)
            v += plate.color[c][k] * t[k];
        out[c] = v;
    }
    return out;
}

function solve(a, b, n) {
    const m = Float64Array.from(a);
    const x = Float64Array.from(b);
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let r = col + 1; r < n; r++) {
            if (Math.abs(m[r * n + col]) > Math.abs(m[pivot * n + col]))
                pivot = r;
        }
        if (Math.abs(m[pivot * n + col]) < 1e-9)
            return null;
        for (let k = 0; k < n; k++)
            [m[col * n + k], m[pivot * n + k]] = [m[pivot * n + k], m[col * n + k]];
        [x[col], x[pivot]] = [x[pivot], x[col]];
        for (let r = 0; r < n; r++) {
            if (r === col)
                continue;
            const f = m[r * n + col] / m[col * n + col];
            for (let k = col; k < n; k++)
                m[r * n + k] -= f * m[col * n + k];
            x[r] -= f * x[col];
        }
    }
    for (let r = 0; r < n; r++)
        x[r] /= m[r * n + r];
    return x;
}

// A least-squares quadratic colour over the pixels, refitted twice without the
// ones far from it (a symbol over the rim, the plate's own highlights).
function fitColor(shape, pixels, lab, w) {
    // Start from the pixels near the median colour, so that a symbol that runs
    // into the plate through soft edges does not pull the first fit.
    const median = [0, 1, 2].map(ch => {
        const values = pixels.map(i => lab[i * 3 + ch]).sort((a, b) => a - b);
        return values[Math.floor(values.length / 2)] ?? 0;
    });
    let weights = Float64Array.from(pixels, i => (Math.hypot(lab[i * 3] - median[0], lab[i * 3 + 1] - median[1], lab[i * 3 + 2] - median[2]) < 0.15 ? 1 : 0));
    let color = [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]];
    let rms = 1, kept = 0, noise = 1;
    const t = new Float64Array(TERMS);
    for (let round = 0; round < 3; round++) {
        const ata = new Float64Array(TERMS * TERMS);
        const atb = [new Float64Array(TERMS), new Float64Array(TERMS), new Float64Array(TERMS)];
        pixels.forEach((i, n) => {
            if (!weights[n])
                return;
            terms(shape, i % w + 0.5, Math.floor(i / w) + 0.5, t);
            for (let r = 0; r < TERMS; r++) {
                for (let c = 0; c < TERMS; c++)
                    ata[r * TERMS + c] += t[r] * t[c];
                for (let ch = 0; ch < 3; ch++)
                    atb[ch][r] += t[r] * lab[i * 3 + ch];
            }
        });
        // A little damping keeps the curvature terms from running off on a thin rim.
        for (let r = 1; r < TERMS; r++)
            ata[r * TERMS + r] += r >= 3 ? 2 : 0.5;
        const solved = atb.map(b => solve(ata, b, TERMS));
        if (solved.some(s => !s))
            break;
        color = solved.map(s => Array.from(s));
        const residuals = pixels.map(i => {
            terms(shape, i % w + 0.5, Math.floor(i / w) + 0.5, t);
            let d2 = 0;
            for (let ch = 0; ch < 3; ch++) {
                let v = 0;
                for (let k = 0; k < TERMS; k++)
                    v += color[ch][k] * t[k];
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
            if (!weights[n])
                return;
            sum += r * r;
            kept++;
        });
        rms = kept ? Math.sqrt(sum / kept) : 1;
    }
    return { color, rms, kept: pixels.length ? kept / pixels.length : 0, noise };
}

export function analyzeIcon(icon) {
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
    const candidates = [];
    const add = (fill) => {
        const mask = maskOf(fill, w, h);
        if (mask.area < n * MIN_PLATE_AREA)
            return;
        let solid = 0;
        for (let i = 0; i < n; i++)
            solid += fill[i] & opaque[i];
        if (solid < mask.area * MIN_OPAQUE)
            return;
        const shape = fitShape(mask, w, h);
        if (shape)
            candidates.push({ mask, shape });
    };
    add(filled(opaque, w, h));
    const labels = areas(lab, opaque, w, h);
    const sizes = new Map();
    for (let i = 0; i < n; i++) {
        if (labels[i] >= 0)
            sizes.set(labels[i], (sizes.get(labels[i]) ?? 0) + 1);
    }
    for (const [label, size] of sizes) {
        if (size < n * MIN_PLATE_AREA * 0.5)
            continue;
        const area = new Uint8Array(n);
        for (let i = 0; i < n; i++)
            area[i] = labels[i] === label ? 1 : 0;
        add(filled(area, w, h));
    }
    // Outermost first. A candidate the same as one kept already is the same
    // plate, and one that lies partly over a kept plate is not a plate.
    candidates.sort((a, b) => b.mask.area - a.mask.area);
    const kept = [];
    const parents = [];
    for (const c of candidates) {
        if (kept.some(k => overlap(k.shape, c.mask, w, h) > 0.95))
            continue;
        const shares = kept.map(k => {
            let inside = 0;
            for (let i = 0; i < n; i++) {
                if (c.mask.data[i] && coverageOf(k.shape, i % w, Math.floor(i / w)) > 0.5)
                    inside++;
            }
            return inside / c.mask.area;
        });
        if (shares.some(share => share > 0.1 && share < 0.9))
            continue;
        let parent = -1;
        for (let k = kept.length - 1; k >= 0 && parent < 0; k--) {
            if (shares[k] >= 0.9)
                parent = k;
        }
        if (parent >= 0 && c.mask.area < kept[parent].mask.area * MIN_INNER_SHARE)
            continue;
        kept.push(c);
        parents.push(parent);
    }
    // Per pixel, the innermost plate it is in.
    const owner = new Int32Array(n).fill(-1);
    const depth = new Float32Array(n).fill(-Infinity);
    for (let i = 0; i < n; i++) {
        const x = i % w + 0.5, y = Math.floor(i / w) + 0.5;
        for (let k = kept.length - 1; k >= 0; k--) {
            const d = shapeDistance(kept[k].shape, x, y);
            if (d < 0) {
                owner[i] = k;
                depth[i] = d;
                break;
            }
        }
    }
    // A plate's colour is that of its largest smooth area: its rim may carry a
    // lit edge or a border, and a symbol may cross it. A plate whose largest
    // area is a small part of it carries a picture.
    const plates = kept.map((c, k) => {
        const own = [];
        const counts = new Map();
        for (let i = 0; i < n; i++) {
            if (owner[i] !== k || !opaque[i])
                continue;
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
        const plate = { shape: c.shape, color: fit.color, plain: false, parent: parents[k], surface: 0, error: fit.rms,
            share, noise: fit.noise };
        let surface = 0;
        const at = [0, 0, 0];
        const near = Math.max(SYMBOL_LOW, fit.noise * 3);
        for (const i of own) {
            plateColor(plate, i % w + 0.5, Math.floor(i / w) + 0.5, at);
            if (Math.hypot(at[0] - lab[i * 3], at[1] - lab[i * 3 + 1], at[2] - lab[i * 3 + 2]) < near)
                surface++;
        }
        plate.surface = own.length ? surface / own.length : 0;
        // A grainy plate strays evenly: its typical pixel is near its colour.
        plate.plain = plate.surface >= MIN_SURFACE && (fit.rms < PLAIN_RMS || fit.noise < MAX_GRAIN);
        return plate;
    });
    // The symbol: whatever is not the colour of the plate it is on. Near an
    // inner plate's edge, the pixel mixes it with the one under it.
    const symbol = new Float32Array(n);
    const at = [0, 0, 0];
    const distanceTo = (plate, i) => {
        plateColor(plate, i % w + 0.5, Math.floor(i / w) + 0.5, at);
        return Math.hypot(at[0] - lab[i * 3], at[1] - lab[i * 3 + 1], at[2] - lab[i * 3 + 2]);
    };
    for (let i = 0; i < n; i++) {
        const k = owner[i];
        if (k < 0) {
            symbol[i] = alpha[i];
            continue;
        }
        const plate = plates[k];
        if (!plate.plain) {
            symbol[i] = alpha[i];
            continue;
        }
        // The plate's own anti-aliased edge is not symbol.
        if (depth[i] > -1.2 && plate.parent < 0)
            continue;
        let d = distanceTo(plate, i);
        if (depth[i] > -1.5 && plate.parent >= 0 && plates[plate.parent].plain)
            d = Math.min(d, distanceTo(plates[plate.parent], i));
        // Grain on the plate is not symbol.
        const low = Math.max(SYMBOL_LOW, plate.noise * 3);
        symbol[i] = alpha[i] * smoothstep(low, low + SYMBOL_HIGH - SYMBOL_LOW, d);
    }
    // A line that runs all along a plate at one depth (a lit edge, a border) is
    // part of the plate. A symbol rarely fills most of a ring at one depth.
    plates.forEach((plate, k) => {
        if (!plate.plain)
            return;
        const deepest = Math.max(6, Math.min(plate.shape.rx, plate.shape.ry) * 0.15);
        const bins = Math.ceil(deepest * 2);
        const total = new Float64Array(bins), marked = new Float64Array(bins), sums = new Float64Array(bins * 3);
        for (let i = 0; i < n; i++) {
            if (owner[i] !== k || -depth[i] >= deepest)
                continue;
            const b = Math.floor(-depth[i] * 2);
            total[b]++;
            if (symbol[i] <= 0.5)
                continue;
            marked[b]++;
            for (let c = 0; c < 3; c++)
                sums[b * 3 + c] += lab[i * 3 + c];
        }
        const ring = (b) => b >= 0 && b < bins && total[b] >= 20 && marked[b] > total[b] * 0.6;
        for (let i = 0; i < n; i++) {
            if (owner[i] !== k || -depth[i] >= deepest || !symbol[i])
                continue;
            const b = Math.floor(-depth[i] * 2);
            // The ring's own bin, or one next to it for its anti-aliased sides.
            const r = ring(b) ? b : ring(b - 1) ? b - 1 : ring(b + 1) ? b + 1 : -1;
            if (r < 0)
                continue;
            const d = Math.hypot(lab[i * 3] - sums[r * 3] / marked[r], lab[i * 3 + 1] - sums[r * 3 + 1] / marked[r], lab[i * 3 + 2] - sums[r * 3 + 2] / marked[r]);
            if (d < 0.1)
                symbol[i] = 0;
        }
    });
    // The symbol's main tone (the median lightness of its core: its
    // anti-aliased edges mix in the plate) is drawn at full strength, and parts
    // that differ from it, lighter or darker, a little weaker, so that details
    // stay visible in one colour.
    const lights = [];
    for (let i = 0; i < n; i++) {
        if (symbol[i] > 0.9)
            lights.push(lab[i * 3]);
    }
    lights.sort((a, b) => a - b);
    const main = lights.length ? lights[Math.floor(lights.length / 2)] : 0;
    const spread = lights.map(l => Math.abs(l - main)).sort((a, b) => a - b)[Math.floor(lights.length * 0.9)] ?? 0;
    const intensity = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        intensity[i] = spread < FLAT_SYMBOL / 2 ? 1
            : 1 - DETAIL_DIM * smoothstep(FLAT_SYMBOL / 4, Math.max(spread, FLAT_SYMBOL), Math.abs(lab[i * 3] - main));
    }
    return { width: w, height: h, plates, symbol, intensity };
}
