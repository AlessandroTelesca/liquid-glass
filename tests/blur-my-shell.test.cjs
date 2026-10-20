const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');

class Signals {
  handlers = new Map();
  next = 1;
  connect(name, fn) { const id = this.next++; this.handlers.set(id, { name, fn }); return id; }
  disconnect(id) { assert.ok(this.handlers.delete(id), `unknown signal ${id}`); }
  emit(name, ...args) { for (const h of [...this.handlers.values()]) if (h.name === name) h.fn(this, ...args); }
}

class FakeSettings extends Signals {
  constructor(values) { super(); this.values = values; }
  get_boolean(key) { return this.values[key]; }
  set_boolean(key, value) { this.values[key] = value; this.emit(`changed::${key}`); }
  get_string(key) { return this.values[key]; }
  get_strv(key) { return [...this.values[key]]; }
  set_strv(key, value) { this.values[key] = [...value]; this.emit(`changed::${key}`); }
}

const PARTS = { popup: 'popups', panel: 'panel', 'dash-to-dock': 'dock', applications: 'applications' };

// Blur my Shell installed at /ext with its blur on for every part (popup blur
// `blur`), in `state`; `glass` and `override` are Liquid Glass's settings.
function fixture({ state = 1, blur = true, hasPopupSchema = true, glass = {}, override = {}, locked = false } = {}) {
  const bmsParts = Object.fromEntries(Object.values(PARTS).map(name => [name, new FakeSettings({ blur: name === 'popups' ? blur : true })]));
  const popup = bmsParts.popups;
  const bms = { uuid: 'blur-my-shell@aunetx', path: '/ext', state };
  const manager = new Signals();
  manager.lookup = uuid => uuid === bms.uuid ? bms : null;
  const settings = new FakeSettings({
    'blur-my-shell-popup-blur': false, 'blur-my-shell-override': false, 'blur-my-shell-override-parts': ['popups', 'panel', 'dock'],
    'blur-my-shell-overridden': [], 'top-bar-style': 'off', 'enable-dock-glass': true, 'enable-application-glass': false,
    'enable-menu-glass': true, 'enable-quick-settings-glass': true, 'enable-extra-menu-glass': false,
    'enable-desktop-menu-glass': false, 'enable-notification-glass': true, 'enable-osd-glass': true, ...glass, ...override,
  });
  const sessionMode = { isLocked: locked };
  const warnings = [];
  const prefix = 'org.gnome.shell.extensions.blur-my-shell.';
  const { BlurMyShellWatch } = loadModule(
    path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist/blurMyShell.js'), {
      Main: { extensionManager: manager, sessionMode },
      ExtensionState: { ACTIVE: 1, INACTIVE: 2 },
      GLib: { build_filenamev: parts => parts.join('/'), file_test: file => file === '/ext/schemas/gschemas.compiled',
        FileTest: { EXISTS: 16 } },
      Gio: {
        Settings: function ({ settings_schema }) { return bmsParts[PARTS[settings_schema.slice(prefix.length)]]; },
        SettingsSchemaSource: {
          get_default: () => null,
          new_from_directory: dir => ({ lookup: id => dir === '/ext/schemas' && id.startsWith(prefix) && id.slice(prefix.length) in PARTS
            && (hasPopupSchema || !id.endsWith('.popup')) ? id : null }),
        },
      },
    });
  const watch = new BlurMyShellWatch(settings, { warn: message => warnings.push(message) });
  return { watch, settings, popup, bmsParts, bms, manager, warnings, sessionMode };
}

test('popup blur in an active Blur my Shell is published and logged', () => {
  const f = fixture();
  f.watch.setup();
  assert.equal(f.settings.values['blur-my-shell-popup-blur'], true);
  assert.equal(f.warnings.length, 1);

  f.popup.set_boolean('blur', false);
  assert.equal(f.settings.values['blur-my-shell-popup-blur'], false);
  f.popup.set_boolean('blur', true);
  assert.equal(f.settings.values['blur-my-shell-popup-blur'], true);
  assert.equal(f.warnings.length, 2, 'turning it back on warns again');
});

test('disabling Blur my Shell clears the warning, and removing it drops its settings', () => {
  const f = fixture();
  f.watch.setup();
  f.bms.state = 2;
  f.manager.emit('extension-state-changed', f.bms);
  assert.equal(f.settings.values['blur-my-shell-popup-blur'], false);

  f.bms.state = 1;
  f.manager.emit('extension-state-changed', f.bms);
  assert.equal(f.settings.values['blur-my-shell-popup-blur'], true);

  f.manager.lookup = () => null;
  f.manager.emit('extension-state-changed', f.bms);
  assert.equal(f.settings.values['blur-my-shell-popup-blur'], false);
  assert.equal(f.popup.handlers.size, 0);
});

test('a Blur my Shell without popup blur, or an inactive one, is not reported', () => {
  for (const options of [{ hasPopupSchema: false }, { state: 2 }, { blur: false }]) {
    const f = fixture(options);
    f.watch.setup();
    assert.equal(f.settings.values['blur-my-shell-popup-blur'], false, JSON.stringify(options));
    assert.equal(f.warnings.length, 0, JSON.stringify(options));
  }
});

test('cleanup disconnects everything and leaves no warning behind', () => {
  const f = fixture();
  f.watch.setup();
  f.watch.cleanup();
  assert.equal(f.manager.handlers.size, 0);
  assert.equal(f.settings.handlers.size, 0);
  assert.equal(f.popup.handlers.size, 0);
  assert.equal(f.settings.values['blur-my-shell-popup-blur'], false);
});

test('the override turns off the blur of chosen parts with glass, and only those', () => {
  const f = fixture({ glass: { 'top-bar-style': 'pill' }, override: { 'blur-my-shell-override': true } });
  f.watch.setup();
  const blur = name => f.bmsParts[name].values.blur;
  assert.deepEqual([blur('popups'), blur('panel'), blur('dock'), blur('applications')], [false, false, false, true]);
  assert.deepEqual(f.settings.values['blur-my-shell-overridden'].sort(), ['dock', 'panel', 'popups']);
  assert.equal(f.settings.values['blur-my-shell-popup-blur'], false, 'no warning for a blur that is overridden');

  f.settings.set_boolean('enable-dock-glass', false);
  assert.equal(blur('dock'), true, 'a part that loses its glass gets its blur back');
  f.settings.set_strv('blur-my-shell-override-parts', ['popups']);
  assert.equal(blur('panel'), true, 'a part taken off the list gets its blur back');
  assert.deepEqual(f.settings.values['blur-my-shell-overridden'], ['popups']);
});

test('a blur already off is left alone, and turning it on again is overridden', () => {
  const f = fixture({ override: { 'blur-my-shell-override': true } });
  f.bmsParts.dock.values.blur = false;
  f.watch.setup();
  assert.deepEqual(f.settings.values['blur-my-shell-overridden'], ['popups']);
  f.settings.set_boolean('blur-my-shell-override', false);
  assert.equal(f.bmsParts.dock.values.blur, false, 'not turned on, as Liquid Glass did not turn it off');
  assert.equal(f.popup.values.blur, true);

  f.settings.set_boolean('blur-my-shell-override', true);
  f.popup.set_boolean('blur', true);
  assert.equal(f.popup.values.blur, false);
});

test('turning Liquid Glass off gives the blur back, but locking the screen does not', () => {
  const f = fixture({ override: { 'blur-my-shell-override': true }, locked: true });
  f.watch.setup();
  f.watch.cleanup();
  assert.equal(f.popup.values.blur, false);
  assert.deepEqual(f.settings.values['blur-my-shell-overridden'].sort(), ['dock', 'popups']);

  f.sessionMode.isLocked = false;
  f.watch.setup();
  f.watch.cleanup();
  assert.equal(f.popup.values.blur, true);
  assert.equal(f.bmsParts.dock.values.blur, true);
  assert.deepEqual(f.settings.values['blur-my-shell-overridden'], []);
});

test('the blur is given back when Blur my Shell is turned off', () => {
  const f = fixture({ override: { 'blur-my-shell-override': true } });
  f.watch.setup();
  f.bms.state = 2;
  f.manager.emit('extension-state-changed', f.bms);
  assert.equal(f.popup.values.blur, true);
  assert.deepEqual(f.settings.values['blur-my-shell-overridden'], []);
});
