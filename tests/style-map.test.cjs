const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const { dist } = require('./helpers/gpu.cjs');

const { analyzeIcon, shapeDistance } = loadModule(path.join(dist, 'iconStyle/iconAnalysis.js'), {});
const { buildStyleMap, MAP_SIZE, MAP_RANGE } = loadModule(path.join(dist, 'iconStyle/styleMap.js'), {});

// An icon of `size` px drawn from layers of a distance (in units of a 128 px icon) and a colour.
function draw(size, layers) {
  const k = 128 / size;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rgb = [0, 0, 0], a = 0;
      for (const layer of layers) {
        const cov = Math.min(Math.max(0.5 - layer.distance((x + 0.5) * k, (y + 0.5) * k) / k, 0), 1);
        if (!cov) continue;
        const c = typeof layer.color === 'function' ? layer.color((x + 0.5) * k, (y + 0.5) * k) : layer.color;
        rgb = rgb.map((v, i) => (v * a * (1 - cov) + c[i] * cov) / (a * (1 - cov) + cov));
        a = a * (1 - cov) + cov;
      }
      data.set([...rgb.map(Math.round), Math.round(a * 255)], (y * size + x) * 4);
    }
  }
  return { width: size, height: size, data };
}

const shape = (kind, r, extra = {}) => ({ kind, cx: 64, cy: 64, rx: r, ry: r, radius: 0, exponent: 2, ripple: null, fit: 0, ...extra });
const of = s => (x, y) => shapeDistance(s, x, y);
const bar = (x1, y1, x2, y2) => (x, y) => Math.max(x1 - x, x - x2, y1 - y, y - y2);

function mapOf(layers) {
  return buildStyleMap(analyzeIcon(draw(128, layers)), draw(256, layers));
}

// The stored distance (map px) at a point given in 128 px icon units.
function field(map, channel, x, y) {
  const s = MAP_SIZE / 128;
  const v = map.data[(Math.floor(y * s) * MAP_SIZE + Math.floor(x * s)) * 4 + channel] / 255;
  return (0.5 - v) * 2 * MAP_RANGE;
}

test('a rounded square stays the outer plate, brought to the size every outer plate has', () => {
  const plate = shape('roundrect', 56, { radius: 14 });
  const map = mapOf([{ distance: of(plate), color: [30, 120, 220] }, { distance: bar(56, 30, 72, 98), color: [255, 255, 255] }]);
  assert.equal(map.ownPlate, true);
  assert.ok(field(map, 0, 64, 64) < -MAP_RANGE + 1);
  // Its edge moved out from 8 px to 0.04 of the icon off the icon's edge.
  assert.ok(Math.abs(field(map, 0, 64, 5.1)) < 2, `edge ${field(map, 0, 64, 5.1)}`);
  // Nothing else is a plate.
  assert.ok(field(map, 1, 64, 64) > MAP_RANGE - 1);
});

test('a circle gets a rounded square around it and shrinks onto it', () => {
  const circle = shape('superellipse', 60);
  const map = mapOf([{ distance: of(circle), color: [30, 200, 90] }, { distance: bar(44, 58, 84, 70), color: [0, 0, 0] }]);
  assert.equal(map.ownPlate, false);
  // The square reaches the corners' diagonal further than the shrunk circle.
  assert.ok(field(map, 0, 22, 22) < 0, 'outer plate in the corner region');
  assert.ok(field(map, 1, 22, 22) > 0, 'circle not in the corner');
  assert.ok(field(map, 1, 64, 64) < 0, 'circle in the middle');
  // The circle's edge moved in from 4 px off the icon's edge.
  assert.ok(field(map, 1, 64, 8) > 0);
});

test('an icon whose plate carries a picture has no map', () => {
  let seed = 3;
  const noise = () => (seed = (seed * 16807) % 2147483647) % 256;
  const plate = shape('roundrect', 56, { radius: 14 });
  assert.equal(mapOf([{ distance: of(plate), color: () => [noise(), noise(), noise()] }]), null);
});

test("the symbol's anti-aliased edge stays partly covered", () => {
  const plate = shape('roundrect', 56, { radius: 14 });
  // A thick diagonal stroke, whose edges cross pixels at every fraction.
  const stroke = (x, y) => Math.abs((x - y) / Math.SQRT2) - 8;
  const map = mapOf([{ distance: of(plate), color: [240, 240, 240] }, { distance: stroke, color: [20, 20, 20] }]);
  const values = new Set();
  for (let i = 0; i < MAP_SIZE * MAP_SIZE; i++) values.add(map.data[i * 4 + 3]);
  const partial = [...values].filter(v => v > 25 && v < 230).length;
  assert.ok(partial > 40, `only ${partial} partial levels`);
  assert.ok(field(map, 0, 64, 64) < 0);
  assert.equal(map.data[(MAP_SIZE / 2 * MAP_SIZE + MAP_SIZE / 2) * 4 + 3], 255);
});

// The tone stored at a point given in 128 px icon units (channel 0: the plates on the outer one).
function tone(map, x, y) {
  const s = MAP_SIZE / 128;
  return map.tone[(Math.floor(y * s) * MAP_SIZE + Math.floor(x * s)) * 4] / 255;
}

test('plates side by side in different colours get different tones, a plate alone the neutral one', () => {
  const plate = shape('roundrect', 56, { radius: 14 });
  const halves = mapOf([
    { distance: of(plate), color: [240, 240, 240] },
    { distance: bar(14, 14, 62, 114), color: [70, 70, 75] },
    { distance: bar(66, 14, 114, 114), color: [230, 90, 30] },
  ]);
  assert.ok(field(halves, 1, 38, 64) < 0 && field(halves, 1, 90, 64) < 0, 'both halves are plates');
  assert.ok(tone(halves, 90, 64) - tone(halves, 38, 64) > 0.3, `${tone(halves, 38, 64)} ${tone(halves, 90, 64)}`);
  const single = mapOf([{ distance: of(plate), color: [240, 240, 240] }, { distance: bar(30, 30, 98, 98), color: [30, 120, 220] }]);
  assert.equal(Math.round(tone(single, 64, 64) * 10) / 10, 0.5);
});

test('alike squares a little too small to be plates on their own are plates beside one that is', () => {
  const plate = shape('roundrect', 56, { radius: 14 });
  // 36 px is a plate on its own (over a tenth of the plate it is on), 32 px is not.
  const squares = [[12, 36], [52, 32], [86, 32]].map(([x, side]) => ({ distance: bar(x, 46, x + side, 46 + side),
    color: [230, 90, 30] }));
  const map = mapOf([{ distance: of(plate), color: [240, 240, 240] }, ...squares]);
  for (const x of [30, 68, 102]) assert.ok(field(map, 1, x, 62) < 0, `square at ${x}`);
});
