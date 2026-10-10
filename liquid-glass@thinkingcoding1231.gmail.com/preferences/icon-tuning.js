import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import {ICON_TUNING} from '../dist/iconStyle/styleColors.js';

const KEY = 'icon-style-tuning';

// Sliders for the numbers the icon looks are drawn with, for choosing their defaults by eye. Only the current
// look's numbers are shown; a value left at its default is not stored.
export function addIconTuning(page, settings, controls, anyIconStyle) {
  const group = controls.group(page, 'Icon glass tuning',
    'For choosing the defaults: the numbers the current look is drawn with. "Copy" puts them on the clipboard.');
  const buttons = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
  const copy = new Gtk.Button({label: 'Copy', css_classes: ['flat']});
  const reset = new Gtk.Button({label: 'Reset all', css_classes: ['flat']});
  buttons.append(copy);
  buttons.append(reset);
  group.set_header_suffix(buttons);

  const stored = () => settings.get_value(KEY).deep_unpack();
  const look = () => {
    const mode = settings.get_string('icon-style-mode');
    return mode === 'tinted' ? settings.get_string('icon-style-tint-variant') : mode;
  };
  let syncing = false;
  const rows = ICON_TUNING.map(param => {
    const step = param.max - param.min > 2 ? 0.5 : 0.01;
    const row = new Adw.SpinRow({title: param.title,
      adjustment: new Gtk.Adjustment({lower: param.min, upper: param.max, step_increment: step, page_increment: step * 10}),
      digits: 2});
    controls._addSlider(row, 2);
    group.add(row);
    row.connect('notify::value', () => {
      if (syncing) return;
      const values = stored();
      const value = Number(row.value.toFixed(2));
      if (value === param.value) delete values[param.key];
      else values[param.key] = value;
      controls.write({[KEY]: values});
    });
    return {param, row};
  });

  controls.watch([...anyIconStyle, 'icon-style-mode', 'icon-style-tint-variant', KEY], () => {
    group.visible = anyIconStyle.some(key => settings.get_boolean(key));
    const values = stored();
    syncing = true;
    for (const {param, row} of rows) {
      row.visible = param.looks.includes(look());
      row.value = values[param.key] ?? param.value;
      row.subtitle = param.key in values ? `Default ${param.value}` : '';
    }
    syncing = false;
  });

  copy.connect('clicked', () => {
    const values = stored();
    const current = Object.fromEntries(rows.filter(({param}) => param.looks.includes(look()))
      .map(({param}) => [param.key, values[param.key] ?? param.value]));
    Gdk.Display.get_default().get_clipboard().set(JSON.stringify({look: look(), ...current}, null, 1));
  });
  reset.connect('clicked', () => settings.reset(KEY));
}
