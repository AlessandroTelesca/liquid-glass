import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {buildPreferences} from './pages.js';
import {parseSettings} from './controls.js';

// Developer-only tool, attached by `npm run build:dev` (see tools/dev-tune/README.md).
const UI_ONLY_KEYS = ['preferences-advanced'];
const SNAPSHOT_PATH = GLib.build_filenamev([GLib.get_user_cache_dir(), 'liquid-glass-tune-snapshot.txt']);

function printKeys(settings, keys) {
  const lines = keys.sort().map(key => `${key}=${settings.get_value(key).print(false)}`);
  return `[/]\n${lines.join('\n')}\n`;
}

function exportedKeys(settings, changedOnly) {
  return settings.settings_schema.list_keys().filter(key => {
    if (UI_ONLY_KEYS.includes(key)) return false;
    return !changedOnly || !settings.get_value(key).equal(settings.get_default_value(key));
  });
}

// GLib aborts when one apply() changes 256 keys or more, so large changes go in batches.
const BATCH = 200;

function commitAll(settings, keys, apply) {
  for (let from = 0; from < keys.length; from += BATCH) {
    const transaction = new Gio.Settings({settings_schema: settings.settings_schema, path: settings.path});
    transaction.delay();
    for (const key of keys.slice(from, from + BATCH)) apply(transaction, key);
    transaction.apply();
  }
}

function resetAll(settings) {
  commitAll(settings, settings.settings_schema.list_keys(), (transaction, key) => transaction.reset(key));
}

// Only the keys the user has set; the rest stay at their defaults when it is put back.
function snapshotText(settings) {
  const keys = settings.settings_schema.list_keys().filter(key => settings.get_user_value(key) !== null);
  return printKeys(settings, keys);
}

function restore(settings, text) {
  const {changes} = parseSettings(settings, text);
  resetAll(settings);
  const values = new Map(changes);
  commitAll(settings, [...values.keys()], (transaction, key) => transaction.set_value(key, values.get(key)));
}

function tunePage(settings, window) {
  const page = new Adw.PreferencesPage({title: 'Tune', icon_name: 'applications-science-symbolic'});
  const group = new Adw.PreferencesGroup({title: 'Tune defaults',
    description: 'Every value starts at its default, and what you see is this window\'s values. ' +
      'Your own settings come back when this window closes.'});
  page.add(group);
  const toast = title => window.add_toast(new Adw.Toast({title}));
  const copyRow = (title, subtitle, changedOnly) => {
    const row = new Adw.ActionRow({title, subtitle});
    const button = new Gtk.Button({icon_name: 'edit-copy-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Copy'});
    button.connect('clicked', () => {
      const keys = exportedKeys(settings, changedOnly);
      window.get_clipboard().set_content(Gdk.ContentProvider.new_for_value(printKeys(settings, keys)));
      toast(`Copied ${keys.length} values`);
    });
    row.add_suffix(button);
    row.activatable_widget = button;
    group.add(row);
  };
  copyRow('Copy all values', 'Every setting, as dconf dump text', false);
  copyRow('Copy changed values', 'Only the settings that differ from the schema default', true);
  const reset = new Adw.ActionRow({title: 'Back to defaults', subtitle: 'Resets every value in this window'});
  const resetButton = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER});
  resetButton.connect('clicked', () => {
    resetAll(settings);
    settings.set_boolean('preferences-advanced', true);
  });
  reset.add_suffix(resetButton);
  group.add(reset);
  return page;
}

function openTuneWindow(parent, settings) {
  // A snapshot left by a crashed session holds the real settings; keep it as the baseline.
  const [, bytes] = GLib.file_test(SNAPSHOT_PATH, GLib.FileTest.EXISTS) ? GLib.file_get_contents(SNAPSHOT_PATH) : [false, null];
  const text = bytes ? new TextDecoder().decode(bytes) : snapshotText(settings);
  if (!bytes) GLib.file_set_contents(SNAPSHOT_PATH, text);

  const window = new Adw.PreferencesWindow({title: 'Tune Defaults', transient_for: parent, destroy_with_parent: true});
  window.add(tunePage(settings, window));
  buildPreferences(window, settings);
  resetAll(settings);
  settings.set_boolean('preferences-advanced', true);

  window.connect('close-request', () => {
    restore(settings, text);
    GLib.unlink(SNAPSHOT_PATH);
    return false;
  });
  const parentClose = parent.connect('close-request', () => { window.close(); return false; });
  window.connect('destroy', () => parent.disconnect(parentClose));
  window.present();
}

function findPage(widget, title) {
  if (widget instanceof Adw.PreferencesPage && widget.title === title) return widget;
  for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
    const found = findPage(child, title);
    if (found) return found;
  }
  return null;
}

export function addTuneDefaults(window, settings) {
  const rendering = findPage(window, 'Rendering');
  const group = new Adw.PreferencesGroup({title: 'Development'});
  const row = new Adw.ActionRow({title: 'Tune Defaults', subtitle: 'Adjust every value from its default and copy the result',
    activatable: true});
  row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
  row.connect('activated', () => openTuneWindow(window, settings));
  group.add(row);
  rendering.add(group);
  // The Troubleshooting group is moved to the end once Advanced is shown; keep this one after it.
  settings.connect('changed::preferences-advanced', () => { rendering.remove(group); rendering.add(group); });
}
