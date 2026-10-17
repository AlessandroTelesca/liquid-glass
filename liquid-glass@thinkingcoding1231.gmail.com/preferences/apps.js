import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ICON_TUNING } from '../dist/iconStyle/styleColors.js';

// The id the Show Apps button goes by in the lists (see src/iconStyle/iconStyler.ts).
const SHOW_APPS_ID = 'show-apps';

const ANY_ICON_STYLE = ['icon-style-dock', 'icon-style-launcher', 'icon-style-app-grid'];

// A dark dock keeps the clear look's white symbols readable over a light wallpaper.
const CLEAR_DOCK = { 'dock-tint-color': '#000000', 'dock-tint-strength': 0.16 };

const TUNING_KEY = 'icon-style-tuning';
const LOOK_TITLES = { dark: 'Tinted, dark', light: 'Tinted, light', mono: 'Mono', clear: 'Clear' };

const WINDOW_LIST_BUS_NAME = 'org.gnome.Shell';
const WINDOW_LIST_OBJECT_PATH = '/org/gnome/Shell/Extensions/LiquidGlass';
const WINDOW_LIST_INTERFACE_NAME = 'org.gnome.Shell.Extensions.LiquidGlass';

// Installed applications as the lists show them, and the Show Apps button.
function applications() {
  const apps = Gio.AppInfo.get_all()
    .filter(app => app.should_show() && app.get_id())
    .map(app => ({ id: app.get_id(), name: app.get_display_name(), icon: app.get_icon() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [{ id: SHOW_APPS_ID, name: 'Show Apps', icon: new Gio.ThemedIcon({ name: 'view-app-grid-symbolic' }) }, ...apps];
}

function appIcon(app) {
  const image = new Gtk.Image({ pixel_size: 32, valign: Gtk.Align.CENTER });
  if (app?.icon)
    image.set_from_gicon(app.icon);
  else
    image.set_from_icon_name('application-x-executable-symbolic');
  return image;
}

function pickerDialog(title, width) {
  const dialog = new Adw.Dialog({ title, content_width: width, content_height: 560 });
  const toolbar = new Adw.ToolbarView();
  toolbar.add_top_bar(new Adw.HeaderBar());
  dialog.set_child(toolbar);
  return { dialog, toolbar };
}

function removeAll(box) {
  for (let child = box.get_first_child(); child; child = box.get_first_child())
    box.remove(child);
}

function currentLook(settings) {
  const mode = settings.get_string('icon-style-mode');
  return mode === 'tinted' ? settings.get_string('icon-style-tint-variant') : mode;
}

// A dialog of sliders for the numbers the current look is drawn with. A value left at its default is not stored.
function presentIconTuning(parent, settings, controls) {
  const look = currentLook(settings);
  const dialog = new Adw.Dialog({ title: 'Glass Tuning', content_width: 460, content_height: 560 });
  const toolbar = new Adw.ToolbarView();
  const header = new Adw.HeaderBar();
  const reset = new Gtk.Button({ label: 'Reset All', tooltip_text: 'Every look back to its defaults' });
  header.pack_start(reset);
  toolbar.add_top_bar(header);
  const page = new Adw.PreferencesPage();
  const group = new Adw.PreferencesGroup({
    title: LOOK_TITLES[look] ?? look,
    description: 'Changes show on the icons as you make them.'
  });
  page.add(group);
  toolbar.set_content(page);
  dialog.set_child(toolbar);

  let syncing = false;
  const rows = ICON_TUNING.filter(param => param.looks.includes(look)).map(param => {
    const step = param.max - param.min > 2 ? 0.5 : 0.01;
    const row = new Adw.SpinRow({
      title: param.title, digits: 2,
      adjustment: new Gtk.Adjustment({ lower: param.min, upper: param.max, step_increment: step, page_increment: step * 10 })
    });
    controls.addSlider(row, 2);
    group.add(row);
    row.connect('notify::value', () => {
      if (syncing) return;
      const values = settings.get_value(TUNING_KEY).deep_unpack();
      const value = Number(row.value.toFixed(2));
      if (value === param.value) delete values[param.key];
      else values[param.key] = value;
      controls.write({ [TUNING_KEY]: values });
    });
    return { param, row };
  });

  const refresh = () => {
    const values = settings.get_value(TUNING_KEY).deep_unpack();
    syncing = true;
    for (const { param, row } of rows) {
      row.value = values[param.key] ?? param.value;
      row.subtitle = param.key in values ? `Default ${param.value}` : '';
    }
    syncing = false;
  };
  const changedId = settings.connect(`changed::${TUNING_KEY}`, refresh);
  dialog.connect('closed', () => settings.disconnect(changedId));
  refresh();
  reset.connect('clicked', () => settings.reset(TUNING_KEY));
  dialog.present(parent);
  return dialog;
}

export class IconStyleRules {
  constructor(settings, controls) {
    this.settings = settings;
    this.controls = controls;
  }

  add(page) {
    const group = this.controls.group(page, 'Application icons',
      'Redraws icons as glass plates under a one-color symbol. An icon that carries a picture is left as it is.');
    this.controls.toggle(group, 'Dock', 'icon-style-dock', 'Dash to Dock');
    this.controls.toggle(group, 'Launcher', 'icon-style-launcher');
    this.controls.toggle(group, 'App grid', 'icon-style-app-grid', 'In the overview, folders included');
    const look = this.controls.choice(group, 'Look', [
      { title: 'Tinted', patch: { 'icon-style-mode': 'tinted' } },
      { title: 'Mono', patch: { 'icon-style-mode': 'mono' } },
      { title: 'Clear', patch: { 'icon-style-mode': 'clear' } },
    ], '', false);
    const clearHint = this._addClearHint(group);
    const variantRow = this.controls.choice(group, 'Variant', [
      { title: 'Dark', patch: { 'icon-style-tint-variant': 'dark' } },
      { title: 'Light', patch: { 'icon-style-tint-variant': 'light' } },
    ], 'Dark glass under a colored symbol, or colored glass under a white one', false);
    const accentRow = this.controls.toggle(group, 'Accent color', 'icon-style-use-accent',
      'The system accent color, from GNOME 47 on');
    const colorRow = this.controls.color(group, 'Color', ['icon-style-color']);
    const strengthRow = this.controls.number(group, 'Tint strength', ['icon-style-tint-strength'], 0, 1, 0.05,
      'From dark glass to the full color', { slider: true });
    const rows = [look,
      this.controls.number(group, 'Size', ['icon-style-size'], 0.8, 1.3, 0.05,
        'As a share of the size each place gives them', { slider: true }),
      this.controls.number(group, 'Symbol opacity', ['icon-style-symbol-opacity'], 0, 1, 0.05, '', { slider: true }),
      this._addTuningRow(group),
      this.controls.toggle(group, 'Include all applications', 'icon-style-all-apps')];
    this.controls.watch([...ANY_ICON_STYLE, 'icon-style-mode', 'icon-style-tint-variant', 'icon-style-use-accent'], () => {
      const on = ANY_ICON_STYLE.some(key => this.settings.get_boolean(key));
      const tinted = on && this.settings.get_string('icon-style-mode') === 'tinted';
      for (const row of rows) row.visible = on;
      clearHint.visible = on && this.settings.get_string('icon-style-mode') === 'clear';
      variantRow.visible = accentRow.visible = tinted;
      strengthRow.visible = tinted && this.settings.get_string('icon-style-tint-variant') === 'dark';
      colorRow.visible = tinted && !this.settings.get_boolean('icon-style-use-accent');
    });
    for (const [all, key, title] of [
      [false, 'icon-style-whitelist', 'Icons to redraw'],
      [true, 'icon-style-blacklist', 'Icons to leave as they are'],
    ])
      this._addList(page, key, title, all);
  }

  _addClearHint(group) {
    const row = new Adw.ActionRow({
      title: 'Hard to see?',
      subtitle: 'Clear icons show what is behind them. On a light wallpaper, a black dock tint at 0.16 strength keeps them readable.'
    });
    const button = new Gtk.Button({ label: 'Apply', valign: Gtk.Align.CENTER });
    button.connect('clicked', () => this.controls.write(CLEAR_DOCK));
    row.add_suffix(button);
    group.add(row);
    this.controls.watch(Object.keys(CLEAR_DOCK), () => {
      const applied = this.settings.get_string('dock-tint-color').toLowerCase() === CLEAR_DOCK['dock-tint-color'] &&
        Math.abs(this.settings.get_value('dock-tint-strength').deep_unpack() - CLEAR_DOCK['dock-tint-strength']) < 0.005;
      button.sensitive = !applied;
      button.label = applied ? 'Applied' : 'Apply';
    });
    return row;
  }

  _addTuningRow(group) {
    const row = new Adw.ActionRow({
      title: 'Glass tuning', subtitle: 'The finer numbers of the current look',
      activatable: true
    });
    row.add_suffix(new Gtk.Image({ icon_name: 'go-next-symbolic' }));
    row.connect('activated', () => presentIconTuning(row, this.settings, this.controls));
    group.add(row);
    return row;
  }

  _addList(page, key, title, activeWhen) {
    const group = new Adw.PreferencesGroup({ title });
    page.add(group);
    this.controls.watch([...ANY_ICON_STYLE, 'icon-style-all-apps'], () => {
      group.visible = ANY_ICON_STYLE.some(k => this.settings.get_boolean(k)) &&
        this.settings.get_boolean('icon-style-all-apps') === activeWhen;
    });

    const addButton = new Gtk.Button({
      valign: Gtk.Align.CENTER, css_classes: ['flat'], icon_name: 'list-add-symbolic',
      tooltip_text: 'Choose an application'
    });
    addButton.connect('clicked', () => this._presentPicker(addButton, key));
    group.set_header_suffix(addButton);

    const listBox = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
    listBox.add_css_class('boxed-list');
    group.add(listBox);
    let known = null;
    this.controls.watch([key], () => {
      known ??= new Map(applications().map(app => [app.id, app]));
      removeAll(listBox);
      const ids = this.settings.get_strv(key);
      for (const id of ids) {
        const app = known.get(id);
        const row = new Adw.ActionRow({ title: app?.name ?? id, subtitle: app ? id : 'Not installed', use_markup: false });
        row.add_prefix(appIcon(app));
        const remove = new Gtk.Button({
          icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER,
          css_classes: ['flat', 'error'], tooltip_text: 'Remove'
        });
        remove.connect('clicked', () => this.settings.set_strv(key, this.settings.get_strv(key).filter(v => v !== id)));
        row.add_suffix(remove);
        listBox.append(row);
      }
      if (ids.length === 0) {
        const empty = new Adw.ActionRow({ title: 'No applications added' });
        empty.add_css_class('dim-label');
        listBox.append(empty);
      }
    });
  }

  _presentPicker(parent, key) {
    const { dialog, toolbar } = pickerDialog('Choose an application', 460);
    const search = new Gtk.SearchEntry({ placeholder_text: 'Search', margin_start: 12, margin_end: 12, margin_top: 6 });
    toolbar.add_top_bar(search);
    const listBox = new Gtk.ListBox({
      selection_mode: Gtk.SelectionMode.NONE, margin_start: 12, margin_end: 12,
      margin_top: 12, margin_bottom: 12, valign: Gtk.Align.START
    });
    listBox.add_css_class('boxed-list');
    toolbar.set_content(new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, child: listBox }));

    const current = new Set(this.settings.get_strv(key));
    const rows = applications().map(app => {
      const row = new Adw.ActionRow({ title: app.name, subtitle: app.id, use_markup: false });
      row.add_prefix(appIcon(app));
      if (current.has(app.id)) {
        const added = new Gtk.Image({
          icon_name: 'object-select-symbolic', valign: Gtk.Align.CENTER,
          tooltip_text: 'Already in the list'
        });
        row.add_suffix(added);
        row.sensitive = false;
      } else {
        const add = new Gtk.Button({
          icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
          tooltip_text: 'Add'
        });
        add.connect('clicked', () => {
          if (!this.settings.get_strv(key).includes(app.id))
            this.settings.set_strv(key, [...this.settings.get_strv(key), app.id]);
          dialog.close();
        });
        row.add_suffix(add);
        row.activatable_widget = add;
      }
      listBox.append(row);
      return { row, text: `${app.name} ${app.id}`.toLowerCase() };
    });
    search.connect('search-changed', () => {
      const words = search.text.toLowerCase().split(/\s+/).filter(Boolean);
      for (const { row, text } of rows) row.visible = words.every(word => text.includes(word));
    });
    dialog.present(parent);
  }
}

// The shell's list of open windows, over D-Bus; only there while the extension is enabled.
class WindowListClient {
  constructor() {
    this._proxy = null;
    this._proxyError = null;
    this._watchers = new Set();
    this._signalId = 0;
  }

  _ensureProxy() {
    if (this._proxy || this._proxyError)
      return this._proxy;

    try {
      this._proxy = Gio.DBusProxy.new_for_bus_sync(
        Gio.BusType.SESSION,
        Gio.DBusProxyFlags.DO_NOT_AUTO_START | Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES,
        null,
        WINDOW_LIST_BUS_NAME,
        WINDOW_LIST_OBJECT_PATH,
        WINDOW_LIST_INTERFACE_NAME,
        null);

      this._signalId = this._proxy.connect('g-signal', (_proxy, _sender, signalName) => {
        if (signalName === 'WindowsChanged')
          this._notify();
      });
    } catch (e) {
      this._proxy = null;
      this._proxyError = e;
    }

    return this._proxy;
  }

  _notify() {
    for (const watcher of [...this._watchers])
      watcher();
  }

  addWatcher(callback) {
    this._ensureProxy();
    this._watchers.add(callback);
    return () => this._watchers.delete(callback);
  }

  listWindows(callback) {
    const proxy = this._ensureProxy();
    if (!proxy) {
      callback(null, 'Could not connect to GNOME Shell.');
      return;
    }

    proxy.call('ListWindows', null, Gio.DBusCallFlags.NONE, -1, null, (source, result) => {
      let windows = null;
      let error = null;
      try {
        const [json] = source.call_finish(result).deep_unpack();
        windows = JSON.parse(json);
      } catch {
        error = 'The window list is only available while the extension is enabled.';
      }
      callback(windows, error);
    });
  }

  destroy() {
    if (this._signalId)
      this._proxy.disconnect(this._signalId);
    this._signalId = 0;
    this._watchers.clear();
  }
}

function windowRowSubtitle(info, rowTitle) {
  const details = [];
  if (rowTitle !== info.wmClass)
    details.push(info.wmClass);
  if (info.count > 1)
    details.push(`${info.count} windows`);
  if (!info.normal)
    details.push('not a normal window — the effect cannot apply');
  return details.join(' · ');
}

function windowIcon(info) {
  const image = new Gtk.Image({ pixel_size: 32, valign: Gtk.Align.CENTER });
  let icon = null;
  // An icon string that does not parse throws a GError.
  try {
    if (info.iconName)
      icon = Gio.Icon.new_for_string(info.iconName);
  } catch {
    icon = null;
  }
  if (icon)
    image.set_from_gicon(icon);
  else
    image.set_from_icon_name('application-x-executable-symbolic');
  return image;
}

function addWindowRowSuffix(row, alreadyAdded, onAdd) {
  if (alreadyAdded) {
    const added = new Gtk.Image({
      icon_name: 'object-select-symbolic',
      valign: Gtk.Align.CENTER,
      tooltip_text: 'Already in the list',
    });
    added.add_css_class('success');
    row.add_suffix(added);
    row.set_sensitive(false);
    return;
  }
  const button = new Gtk.Button({
    icon_name: 'list-add-symbolic',
    valign: Gtk.Align.CENTER,
    css_classes: ['flat'],
    tooltip_text: 'Add',
  });
  button.connect('clicked', onAdd);
  row.add_suffix(button);
  row.activatable_widget = button;
}

function windowRow(info, alreadyAdded, onAdd) {
  const rowTitle = info.appName || info.wmClass;
  const row = new Adw.ActionRow({
    title: rowTitle,
    subtitle: windowRowSubtitle(info, rowTitle),
    use_markup: false,
    tooltip_text: info.titles?.length ? info.titles.join('\n') : null,
  });
  row.add_prefix(windowIcon(info));
  addWindowRowSuffix(row, alreadyAdded, onAdd);
  return row;
}

export class WindowRules {
  constructor(settings, controls) {
    this.settings = settings;
    this.controls = controls;
    this.client = new WindowListClient();
    controls.onClose(() => this.client.destroy());
  }

  add(page) {
    const group = this.controls.group(page, 'Application windows');
    this.controls.toggle(group, 'Window glass', 'enable-application-glass');
    const allRow = this.controls.toggle(group, 'Include all applications', 'application-glass-all-windows');
    const opacityRow = this.controls.number(group, 'Content opacity', ['application-content-opacity'], 0, 1, 0.05);
    const cornerRow = this.controls.toggle(group, 'Corner on maximized windows', 'application-corner-on-maximized');
    const glassRow = this.controls.toggle(group, 'Glass on maximized windows', 'application-glass-on-maximized');
    this.settings.bind('enable-application-glass', allRow, 'visible', Gio.SettingsBindFlags.GET);
    this.settings.bind('enable-application-glass', opacityRow, 'visible', Gio.SettingsBindFlags.GET);
    this.settings.bind('enable-application-glass', cornerRow, 'visible', Gio.SettingsBindFlags.GET);
    this.settings.bind('enable-application-glass', glassRow, 'visible', Gio.SettingsBindFlags.GET);
    for (const [all, key, title] of [
      [false, 'application-window-whitelist', 'Included applications'],
      [true, 'application-window-blacklist', 'Excluded applications'],
    ])
      this._addWindowClassEditor(page, key, title, all);
  }

  _addWindowClassEditor(page, key, title, activeWhen) {
    const settings = this.settings;
    const pickerTitle = 'Choose an application';
    const listGroup = new Adw.PreferencesGroup({ title });
    page.add(listGroup);

    this.controls.watch(['application-glass-all-windows', 'enable-application-glass'], () => {
      listGroup.visible = settings.get_boolean('enable-application-glass') &&
        settings.get_boolean('application-glass-all-windows') === activeWhen;
    });

    const addButton = new Gtk.Button({
      valign: Gtk.Align.CENTER,
      css_classes: ['flat'],
      icon_name: 'list-add-symbolic',
      tooltip_text: pickerTitle,
    });
    addButton.connect('clicked', () => this._presentWindowPicker(addButton, key, pickerTitle));
    listGroup.set_header_suffix(addButton);

    const listBox = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
    listBox.add_css_class('boxed-list');
    listGroup.add(listBox);

    this.controls.watch([key], () => {
      removeAll(listBox);
      const items = settings.get_strv(key);
      for (const item of items) {
        const row = new Adw.ActionRow({ title: item, use_markup: false });
        const removeButton = new Gtk.Button({
          icon_name: 'user-trash-symbolic',
          valign: Gtk.Align.CENTER,
          css_classes: ['flat', 'error'],
          tooltip_text: 'Remove',
        });
        removeButton.connect('clicked', () => {
          settings.set_strv(key, settings.get_strv(key).filter(v => v !== item));
        });
        row.add_suffix(removeButton);
        listBox.append(row);
      }

      if (items.length === 0) {
        const emptyRow = new Adw.ActionRow({ title: 'No applications added' });
        emptyRow.add_css_class('dim-label');
        listBox.append(emptyRow);
      }
    });

    const manualExpander = new Adw.ExpanderRow({ title: 'Add by application ID' });
    listGroup.add(manualExpander);

    const entryRow = new Adw.EntryRow({ title: 'Application ID', show_apply_button: true });
    entryRow.connect('apply', () => {
      const value = entryRow.get_text().trim();
      if (!value) return;
      this._addWindowClass(key, value);
      entryRow.set_text('');
    });
    manualExpander.add_row(entryRow);
  }

  _addWindowClass(key, wmClass) {
    const value = wmClass.trim();
    if (!value) return;
    const items = this.settings.get_strv(key);
    if (!items.some(v => v.toLowerCase() === value.toLowerCase()))
      this.settings.set_strv(key, [...items, value]);
  }

  _presentWindowPicker(parentWidget, key, title) {
    const settings = this.settings;
    const client = this.client;
    const { dialog, toolbar } = pickerDialog(title, 500);

    const contentBox = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 12,
      margin_top: 12,
      margin_bottom: 12,
      margin_start: 12,
      margin_end: 12,
    });
    toolbar.set_content(new Gtk.ScrolledWindow({
      hscrollbar_policy: Gtk.PolicyType.NEVER,
      vexpand: true,
      child: contentBox,
    }));

    const showStatus = (iconName, statusTitle, statusDescription) => {
      removeAll(contentBox);
      contentBox.append(new Adw.StatusPage({
        icon_name: iconName,
        title: statusTitle,
        description: statusDescription,
        vexpand: true,
      }));
    };

    const showWindows = windows => {
      if (!windows || windows.length === 0) {
        showStatus('window-symbolic', 'No open windows',
          'Open an application window and it will appear here.');
        return;
      }
      removeAll(contentBox);
      const listBox = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
      listBox.add_css_class('boxed-list');
      contentBox.append(listBox);

      const current = settings.get_strv(key).map(v => v.toLowerCase());
      for (const info of windows) {
        if (!info.wmClass) continue;
        listBox.append(windowRow(info, current.includes(info.wmClass.toLowerCase()),
          () => this._addWindowClass(key, info.wmClass)));
      }
    };

    // The list arrives over D-Bus: answers to an earlier request, or after the dialog closed, are dropped.
    let alive = true;
    let request = 0;
    const refresh = () => {
      if (!alive) return;
      const currentRequest = ++request;
      client.listWindows((windows, error) => {
        if (!alive || currentRequest !== request) return;
        if (error)
          showStatus('dialog-warning-symbolic', 'Window list unavailable', error);
        else
          showWindows(windows);
      });
    };

    const unwatch = client.addWatcher(refresh);
    const changedId = settings.connect(`changed::${key}`, refresh);
    const cleanup = () => {
      if (!alive) return;
      alive = false;
      unwatch();
      settings.disconnect(changedId);
    };
    dialog.connect('closed', cleanup);
    this.controls.onClose(cleanup);

    showStatus('content-loading-symbolic', 'Loading…', null);
    refresh();

    dialog.present(parentWidget);
  }
}
