// The texture an icon is redrawn from (see shaders/icon-style.frag): the
// plates as distance fields and the symbol's coverage, on a square of
// MAP_SIZE px that stands for the icon's square.
//
//   R  the outer plate, a rounded square around everything
//   G  the plates on it
//   B  the plates on those, and any deeper
//   A  the symbol, weaker where it differs from its main tone
//
// A distance d (map px, negative inside) is stored as 0.5 - d / (2 * RANGE).
// Pure computation, for the worker and the tests.
import { shapeDistance, symbolLayer } from './iconAnalysis.js';
export const MAP_SIZE = 256;
export const MAP_RANGE = 16;
// Every outer plate is brought to this half size (a share of the icon's), so
// that all icons in a row are the same size. The one put around icons that
// have none is a squircle.
const OUTER_HALF = 0.46;
const OUTER_EXPONENT = 4;
// What goes on that plate is scaled to reach this far from its centre, as a
// share of the plate's half size.
const CONTENT_REACH = 0.74;
// An icon's own outermost plate is its rounded square when it is about square,
// fills this much of the icon and leaves almost nothing outside it.
const SQUARE_ASPECT = 0.08;
const SQUARE_FILL = 0.72;
const SQUARE_EXPONENT = 3.5;
// A rounded rectangle with corners rounder than this share of its half size is a circle or a pill.
const SQUARE_RADIUS = 0.62;
const OUTSIDE_SHARE = 0.01;

function isSquare(shape, width) {
    const roundEnough = shape.kind === 'roundrect' ? shape.radius <= Math.min(shape.rx, shape.ry) * SQUARE_RADIUS
        : shape.exponent >= SQUARE_EXPONENT;
    return roundEnough && !shape.ripple && Math.abs(shape.rx - shape.ry) <= Math.max(shape.rx, shape.ry) * SQUARE_ASPECT &&
        Math.min(shape.rx, shape.ry) * 2 >= width * SQUARE_FILL;
}

// How much of what is drawn lies outside `shape`.
function outsideShare(pixels, scale, shape) {
    let outside = 0, total = 0;
    for (let i = 0; i < pixels.width * pixels.height; i++) {
        const a = pixels.data[i * 4 + 3];
        if (!a)
            continue;
        total += a;
        if (shapeDistance(shape, (i % pixels.width + 0.5) * scale, (Math.floor(i / pixels.width) + 0.5) * scale) > 1)
            outside += a;
    }
    return total ? outside / total : 0;
}

// The centre and the half size (largest distance along x or y) of what is drawn, in analysis px.
function extent(pixels, scale) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (let i = 0; i < pixels.width * pixels.height; i++) {
        if (pixels.data[i * 4 + 3] < 26)
            continue;
        const x = i % pixels.width, y = Math.floor(i / pixels.width);
        x1 = Math.min(x1, x);
        y1 = Math.min(y1, y);
        x2 = Math.max(x2, x + 1);
        y2 = Math.max(y2, y + 1);
    }
    if (x2 < x1)
        return { cx: pixels.width * scale / 2, cy: pixels.height * scale / 2, half: 1 };
    return { cx: (x1 + x2) / 2 * scale, cy: (y1 + y2) / 2 * scale, half: Math.max(x2 - x1, y2 - y1) / 2 * scale };
}

function depthOf(plates, k) {
    return plates[k].parent < 0 ? 0 : depthOf(plates, plates[k].parent) + 1;
}

function encode(d) {
    return Math.round(Math.min(Math.max(0.5 - d / (2 * MAP_RANGE), 0), 1) * 255);
}

/**
 * The style map of an icon, from its analysis and the icon drawn again at
 * `detail` (any size; twice the analysis's keeps the symbol's edges smooth).
 * Null when a plate carries a picture: such an icon is shown as it is.
 */
export function buildStyleMap(analysis, detail, size = MAP_SIZE) {
    const { plates } = analysis;
    if (plates.some(plate => !plate.plain))
        return null;
    const A = analysis.width;
    const scale = A / detail.width;
    const centre = A / 2;
    // The outer plate, and where the content goes on it: content point q shows at centre + k (q - from).
    const tops = plates.map((_, k) => k).filter(k => plates[k].parent < 0);
    const own = tops.length === 1 && isSquare(plates[tops[0]].shape, A) &&
        outsideShare(detail, scale, plates[tops[0]].shape) < OUTSIDE_SHARE;
    const half = OUTER_HALF * A;
    let outer, k, fromX, fromY;
    if (own) {
        const shape = plates[tops[0]].shape;
        k = half / Math.max(shape.rx, shape.ry);
        outer = { ...shape, cx: centre, cy: centre, rx: shape.rx * k, ry: shape.ry * k, radius: shape.radius * k };
        fromX = shape.cx;
        fromY = shape.cy;
    }
    else {
        outer = { kind: 'superellipse', cx: centre, cy: centre, rx: half, ry: half, radius: 0, exponent: OUTER_EXPONENT,
            ripple: null, fit: 1 };
        const e = extent(detail, scale);
        k = Math.min(1, half * CONTENT_REACH / e.half);
        fromX = e.cx;
        fromY = e.cy;
    }
    const level = plates.map((_, i) => depthOf(plates, i) + (own ? 0 : 1));
    const { symbol, intensity } = symbolLayer(plates, A, detail);
    const field = new Float32Array(symbol.length);
    for (let i = 0; i < field.length; i++)
        field[i] = symbol[i] * intensity[i];
    const sample = (x, y) => {
        // Bilinear, in detail pixels.
        const fx = x / scale - 0.5, fy = y / scale - 0.5;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        let v = 0;
        for (const [dx, dy, wgt] of [[0, 0, (1 - (fx - x0)) * (1 - (fy - y0))], [1, 0, (fx - x0) * (1 - (fy - y0))],
            [0, 1, (1 - (fx - x0)) * (fy - y0)], [1, 1, (fx - x0) * (fy - y0)]]) {
            const u = x0 + dx, w = y0 + dy;
            if (u >= 0 && w >= 0 && u < detail.width && w < detail.height)
                v += field[w * detail.width + u] * wgt;
        }
        return v;
    };
    const data = new Uint8Array(size * size * 4);
    const mapPx = size / A;
    // Map pixels over content pixels: each map pixel averages this many samples a side.
    const taps = Math.max(1, Math.ceil(1 / (k * mapPx * scale)));
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const fx = (x + 0.5) / mapPx, fy = (y + 0.5) / mapPx;
            const qx = fromX + (fx - centre) / k, qy = fromY + (fy - centre) / k;
            const inner = [Infinity, Infinity];
            plates.forEach((plate, i) => {
                const l = level[i];
                if (l === 0)
                    return;
                const slot = Math.min(l, 2) - 1;
                inner[slot] = Math.min(inner[slot], shapeDistance(plate.shape, qx, qy) * k * mapPx);
            });
            let sym = 0;
            for (let ty = 0; ty < taps; ty++) {
                for (let tx = 0; tx < taps; tx++) {
                    const sx = fromX + ((x + (tx + 0.5) / taps) / mapPx - centre) / k;
                    const sy = fromY + ((y + (ty + 0.5) / taps) / mapPx - centre) / k;
                    sym += sample(sx, sy);
                }
            }
            const at = (y * size + x) * 4;
            data[at] = encode(shapeDistance(outer, fx, fy) * mapPx);
            data[at + 1] = encode(inner[0]);
            data[at + 2] = encode(inner[1]);
            data[at + 3] = Math.round(Math.min(sym / (taps * taps), 1) * 255);
        }
    }
    return { size, data, ownPlate: own };
}
