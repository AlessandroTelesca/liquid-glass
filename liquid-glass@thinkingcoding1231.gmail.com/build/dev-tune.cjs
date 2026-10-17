// Attaches or removes the developer-only "Tune Defaults" window (tools/dev-tune).
// Usage: node build/dev-tune.cjs on|off
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const extension = path.resolve(__dirname, '..');
const tool = path.resolve(extension, '../tools/dev-tune');
const prefs = path.join(extension, 'prefs.js');
const original = path.join(__dirname, '.prefs.js.orig');
const copy = path.join(extension, 'preferences/dev-tune.js');

function ignoreLocally(file) {
  const exclude = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {cwd: extension}).toString().trim();
  const entry = path.relative(execFileSync('git', ['rev-parse', '--show-toplevel'], {cwd: extension}).toString().trim(), file);
  const file_ = path.resolve(extension, exclude);
  const current = fs.existsSync(file_) ? fs.readFileSync(file_, 'utf8') : '';
  if (!current.split('\n').includes(entry)) fs.appendFileSync(file_, `${current.endsWith('\n') || !current ? '' : '\n'}${entry}\n`);
}

function off() {
  if (fs.existsSync(original)) {
    fs.copyFileSync(original, prefs);
    fs.rmSync(original);
  }
  fs.rmSync(copy, {force: true});
}

function on() {
  if (!fs.existsSync(original)) fs.copyFileSync(prefs, original);
  fs.copyFileSync(path.join(tool, 'prefs.dev.js'), prefs);
  fs.copyFileSync(path.join(tool, 'tune-defaults.js'), copy);
  ignoreLocally(copy);
  ignoreLocally(original);
}

const mode = process.argv[2];
if (mode === 'on') on();
else if (mode === 'off') off();
else throw new Error('Usage: node build/dev-tune.cjs on|off');
