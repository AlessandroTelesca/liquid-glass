// Writes the icon contact sheet: one row per application, and per icon theme
// the icon as drawn, the analysis over it, and the icon redrawn as glass plates
// under a one-colour symbol.
//
//   node build-sheet.cjs <out.html> <theme.json>...
'use strict';
const fs = require('node:fs');

const [out, ...inputs] = process.argv.slice(2);
const themes = inputs.map(path => JSON.parse(fs.readFileSync(path, 'utf8')));
const apps = new Map();
for (const theme of themes) {
  for (const icon of theme.icons) {
    if (!apps.has(icon.id)) apps.set(icon.id, { id: icon.id, name: icon.name, icon: icon.icon, themes: {} });
    apps.get(icon.id).themes[theme.theme] = icon;
  }
}
const data = {
  themes: themes.map(t => t.theme),
  size: themes[0]?.size ?? 128,
  apps: [...apps.values()].sort((a, b) => a.name.localeCompare(b.name)),
};

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Icon Sheet</title>
<style>
:root {
  --bg: #16171b; --panel: #202127; --line: #30323a; --text: #e8e8ec; --muted: #9a9ca6; --accent: #3584e4;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 13px/1.4 system-ui, sans-serif; }
header { position: sticky; top: 0; z-index: 2; background: color-mix(in srgb, var(--bg) 92%, transparent);
  backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); padding: 10px 16px;
  display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; }
header h1 { font-size: 15px; margin: 0 8px 0 0; }
header label { display: flex; gap: 6px; align-items: center; color: var(--muted); }
select, input[type=text] { background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; }
.summary { padding: 8px 16px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 4px 24px; }
table { border-collapse: collapse; margin: 0 16px 40px; }
th, td { border-bottom: 1px solid var(--line); padding: 6px 10px; vertical-align: top; }
th { position: sticky; top: 52px; background: var(--bg); text-align: left; color: var(--muted); font-weight: 600; z-index: 1; }
td.name { width: 190px; }
td.name b { display: block; }
td.name small { color: var(--muted); word-break: break-all; }
.cell { display: flex; gap: 6px; }
.cell canvas { border-radius: 6px; background: #000; }
.info { color: var(--muted); font-size: 11px; max-width: 320px; margin-top: 3px; }
.info .fallback { color: #e5a50a; }
.info .error { color: #ff7b63; }
.legend { color: var(--muted); padding: 0 16px 6px; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>Icon Sheet</h1>
  <label>Mode <select id="mode"><option value="tinted">Tinted</option><option value="mono">Mono</option><option value="clear">Clear</option></select></label>
  <label>Accent <input id="accent" type="color" value="#3584e4"></label>
  <label>Size <select id="size"><option>48</option><option selected>64</option><option>96</option><option>128</option></select></label>
  <label><input id="jail" type="checkbox" checked> Plate behind icons without one</label>
  <label><input id="debug" type="checkbox" checked> Analysis column</label>
  <label><input id="info" type="checkbox" checked> Details</label>
  <label>Filter <input id="filter" type="text" placeholder="name or id, a|b for either"></label>
</header>
<div class="summary" id="summary"></div>
<div class="legend">Analysis: plates outlined outermost first (white, yellow, cyan, magenta, ...); dashed = carries a picture
(its content is kept as symbol); red tint = what is taken as the symbol. "theme" = the icon came from the theme itself,
"hicolor" = from the fallback every theme shares, "other theme" / "file" = from elsewhere.</div>
<table><thead><tr id="head"></tr></thead><tbody id="rows"></tbody></table>
<script>
const DATA = ${JSON.stringify(data).replace(/</g, '\\u003c')};
const SIZE = DATA.size;
const COLORS = ['#ffffff', '#f6d32d', '#33d17a', '#62a0ea', '#f66151', '#c061cb', '#ffa348'];
const images = new Map();
function image(b64) {
  if (!images.has(b64)) {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    images.set(b64, img.decode().then(() => img));
  }
  return images.get(b64);
}

// A wallpaper for the glass to be over, sharp and blurred.
const wall = document.createElement('canvas');
wall.width = 1024; wall.height = 512;
{
  const g = wall.getContext('2d');
  const base = g.createLinearGradient(0, 0, 1024, 512);
  base.addColorStop(0, '#1d3557'); base.addColorStop(0.5, '#6a4c93'); base.addColorStop(1, '#0b6e4f');
  g.fillStyle = base; g.fillRect(0, 0, 1024, 512);
  const blobs = [[120, 100, '#ff9f1c'], [380, 380, '#2ec4b6'], [640, 120, '#e71d36'], [860, 340, '#ffd166'], [520, 260, '#8ecae6']];
  for (const [x, y, c] of blobs) {
    const r = g.createRadialGradient(x, y, 0, x, y, 170);
    r.addColorStop(0, c); r.addColorStop(1, c + '00');
    g.fillStyle = r; g.fillRect(0, 0, 1024, 512);
  }
  g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 3;
  for (let x = 0; x < 1024; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 200, 512); g.stroke(); }
}
const wallBlur = document.createElement('canvas');
wallBlur.width = wall.width; wallBlur.height = wall.height;
{ const g = wallBlur.getContext('2d'); g.filter = 'blur(10px)'; g.drawImage(wall, 0, 0); }

function hexRgb(hex) { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); }
function mix(a, b, t) { return a.map((v, i) => Math.round(v + (b[i] - v) * t)); }
function rgba(c, a) { return 'rgba(' + c.join(',') + ',' + a + ')'; }

function path(points) {
  const p = new Path2D();
  points.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
  p.closePath();
  return p;
}

function squircle(cx, cy, r, n = 5) {
  const pts = [];
  for (let i = 0; i < 96; i++) {
    const a = i / 96 * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a);
    pts.push([cx + r * Math.sign(c) * Math.abs(c) ** (2 / n), cy + r * Math.sign(s) * Math.abs(s) ** (2 / n)]);
  }
  return pts;
}

function glass(g, outline, style, depth, wallX, wallY) {
  const p = path(outline);
  g.save();
  g.clip(p);
  if (depth === 0) g.drawImage(wallBlur, wallX, wallY, SIZE, SIZE, 0, 0, SIZE, SIZE);
  g.fillStyle = style.fill(depth);
  g.fill(p);
  g.restore();
  // A rim lit from the top left.
  const xs = outline.map(p => p[0]), ys = outline.map(p => p[1]);
  const rim = g.createLinearGradient(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
  rim.addColorStop(0, style.rim(0.75));
  rim.addColorStop(0.5, style.rim(0.12));
  rim.addColorStop(1, style.rim(0.4));
  g.save();
  g.clip(p);
  g.lineWidth = 3;
  g.strokeStyle = rim;
  g.stroke(p);
  g.restore();
}

function styles(mode, accent) {
  const white = [255, 255, 255], black = [0, 0, 0];
  if (mode === 'mono') return {
    fill: d => rgba([24, 24, 28], d === 0 ? 0.5 : 0.3), rim: a => rgba(white, a), symbol: white, symbolAlpha: 1 };
  if (mode === 'clear') return {
    fill: d => rgba(white, d === 0 ? 0.14 : 0.1), rim: a => rgba(white, a), symbol: white, symbolAlpha: 0.92 };
  return {
    fill: d => (d === 0 ? rgba(mix(accent, black, 0.72), 0.62) : rgba(mix(accent, black, 0.45), 0.38)),
    rim: a => rgba(mix(accent, white, 0.6), a),
    symbol: mix(accent, white, 0.45), symbolAlpha: 1 };
}

async function drawResult(canvas, rec, opts, wallX, wallY) {
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, SIZE, SIZE);
  g.drawImage(wall, wallX, wallY, SIZE, SIZE, 0, 0, SIZE, SIZE);
  if (!rec.symbol) return;
  const style = styles(opts.mode, opts.accent);
  const plates = rec.plates;
  const jail = opts.jail && plates.length === 0;
  const depthOf = i => (plates[i].parent < 0 ? 0 : depthOf(plates[i].parent) + 1);
  if (jail) glass(g, squircle(SIZE / 2, SIZE / 2, SIZE * 0.44), style, 0, wallX, wallY);
  plates.forEach((plate, i) => glass(g, plate.outline, style, depthOf(i), wallX, wallY));
  const sym = await image(rec.symbol);
  const off = new OffscreenCanvas(SIZE, SIZE);
  const o = off.getContext('2d');
  o.drawImage(sym, 0, 0);
  o.globalCompositeOperation = 'multiply';
  o.fillStyle = rgba(style.symbol, 1);
  o.fillRect(0, 0, SIZE, SIZE);
  o.globalCompositeOperation = 'destination-in';
  o.drawImage(sym, 0, 0);
  g.save();
  g.globalAlpha = style.symbolAlpha;
  g.shadowColor = 'rgba(0,0,0,0.3)';
  g.shadowBlur = 3;
  if (jail) {
    const s = 0.7;
    g.translate(SIZE * (1 - s) / 2, SIZE * (1 - s) / 2);
    g.scale(s, s);
  }
  g.drawImage(off, 0, 0);
  g.restore();
}

async function drawDebug(canvas, rec) {
  const g = canvas.getContext('2d');
  g.fillStyle = '#7f7f7f';
  g.fillRect(0, 0, SIZE, SIZE);
  if (!rec.original) return;
  g.globalAlpha = 0.55;
  g.drawImage(await image(rec.original), 0, 0);
  g.globalAlpha = 1;
  const sym = await image(rec.symbol);
  const off = new OffscreenCanvas(SIZE, SIZE);
  const o = off.getContext('2d');
  o.drawImage(sym, 0, 0);
  o.globalCompositeOperation = 'source-in';
  o.fillStyle = 'rgba(255,40,40,0.85)';
  o.fillRect(0, 0, SIZE, SIZE);
  g.drawImage(off, 0, 0);
  rec.plates.forEach((plate, i) => {
    g.save();
    g.lineWidth = 2;
    g.strokeStyle = COLORS[i % COLORS.length];
    if (!plate.plain) g.setLineDash([5, 4]);
    g.stroke(path(plate.outline));
    g.restore();
  });
}

async function drawOriginal(canvas, rec) {
  const g = canvas.getContext('2d');
  g.fillStyle = '#2a2b31';
  g.fillRect(0, 0, SIZE, SIZE);
  if (rec.original) g.drawImage(await image(rec.original), 0, 0);
}

function describe(rec) {
  if (rec.error) return '<span class="error">' + rec.error + '</span>';
  const source = rec.fromTheme ? 'theme' : rec.file.includes('/hicolor/') ? 'hicolor'
    : '<span class="fallback">' + (rec.file.includes('/icons/') ? 'other theme' : 'file') + '</span>';
  const plates = rec.plates.map(p => {
    const s = p.shape;
    const kind = s.kind === 'roundrect' ? 'rect r' + Math.round(s.radius) : 'superellipse n' + s.exponent;
    const ripple = s.ripple ? ' ~' + s.ripple.count + ' teeth' : '';
    const colour = p.from === p.to ? p.centre : p.from + '→' + p.to;
    return kind + ripple + ' (fit ' + s.fit.toFixed(2) + (p.plain ? '' : ', picture') + ', area ' + p.share + ' err ' + p.error + ' grain ' + p.noise +
      ', ' + colour + ')';
  });
  const missing = rec.missing ? '<span class="error">missing, the generic icon</span> · ' : '';
  return missing + source + ' · ' + rec.ms + ' ms · ' + (plates.length ? plates.join('; ') : 'no plate');
}

function options() {
  return {
    mode: document.getElementById('mode').value,
    accent: hexRgb(document.getElementById('accent').value),
    jail: document.getElementById('jail').checked,
    debug: document.getElementById('debug').checked,
    info: document.getElementById('info').checked,
    size: +document.getElementById('size').value,
    filter: document.getElementById('filter').value.toLowerCase(),
    start: +(hash.get('start') ?? 0),
    count: +(hash.get('count') ?? Infinity),
  };
}

function summary() {
  const parts = DATA.themes.map(theme => {
    const recs = DATA.apps.map(a => a.themes[theme]).filter(Boolean);
    const ok = recs.filter(r => !r.error);
    const withPlate = ok.filter(r => r.plates.length);
    const fromTheme = ok.filter(r => r.fromTheme);
    return '<b>' + theme + '</b>: ' + recs.length + ' icons, ' + fromTheme.length + ' from the theme, ' +
      withPlate.length + ' with plates, ' + (recs.length - ok.length) + ' failed';
  });
  document.getElementById('summary').innerHTML = parts.join('');
}

let drawId = 0;
async function render() {
  const opts = options();
  const id = ++drawId;
  document.getElementById('head').innerHTML = '<th>Application</th>' + DATA.themes.map(t => '<th>' + t + '</th>').join('');
  const body = document.getElementById('rows');
  body.innerHTML = '';
  let row = 0, index = -1;
  for (const app of DATA.apps) {
    const text = (app.name + ' ' + app.id).toLowerCase();
    if (opts.filter && !opts.filter.split('|').some(part => part && text.includes(part))) continue;
    index++;
    if (index < opts.start || index >= opts.start + opts.count) continue;
    const tr = document.createElement('tr');
    tr.innerHTML = '<td class="name"><b>' + app.name + '</b><small>' + app.id + '</small></td>';
    const jobs = [];
    DATA.themes.forEach((theme, t) => {
      const td = document.createElement('td');
      const rec = app.themes[theme];
      if (rec) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        const make = () => {
          const c = document.createElement('canvas');
          c.width = c.height = SIZE;
          c.style.width = c.style.height = opts.size + 'px';
          cell.appendChild(c);
          return c;
        };
        jobs.push(drawOriginal(make(), rec));
        if (opts.debug) jobs.push(drawDebug(make(), rec));
        const wx = (row * 137 + t * 251) % (wall.width - SIZE), wy = (row * 59 + t * 97) % (wall.height - SIZE);
        jobs.push(drawResult(make(), rec, opts, wx, wy));
        td.appendChild(cell);
        if (opts.info) {
          const info = document.createElement('div');
          info.className = 'info';
          info.innerHTML = describe(rec);
          td.appendChild(info);
        }
      }
      tr.appendChild(td);
    });
    body.appendChild(tr);
    row++;
    if (row % 20 === 0) {
      await Promise.all(jobs);
      if (id !== drawId) return;
    }
  }
}

// Controls can be set from the address, e.g. #mode=mono&size=128&filter=calc&debug=0, and a range of rows
// with start and count.
const hash = new URLSearchParams(location.hash.slice(1));
for (const [key, value] of hash) {
  const control = document.getElementById(key);
  if (!control) continue;
  if (control.type === 'checkbox') control.checked = value !== '0';
  else control.value = value;
}
for (const id of ['mode', 'accent', 'size', 'jail', 'debug', 'info', 'filter'])
  document.getElementById(id).addEventListener('input', render);
summary();
render();
</script>
</body>
</html>
`;
fs.writeFileSync(out, html);
console.log(`${out}: ${data.apps.length} applications, ${data.themes.join(', ')}`);
