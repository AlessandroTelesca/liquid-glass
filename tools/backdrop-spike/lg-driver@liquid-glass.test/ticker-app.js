// A window whose text changes ten times a second, for the driver's
// stalefreeze check: what is on screen over it has to keep up.
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const app = new Adw.Application({application_id: 'test.liquidglass.Ticker'});
app.connect('activate', () => {
    const win = new Adw.ApplicationWindow({application: app, title: 'lgdrv-ticker', default_width: 420, default_height: 300});
    const label = new Gtk.Label({css_classes: ['title-1'], vexpand: true});
    const view = new Adw.ToolbarView({content: label});
    view.add_top_bar(new Adw.HeaderBar());
    win.set_content(view);
    let n = 0;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        label.label = `${n++}`;
        return GLib.SOURCE_CONTINUE;
    });
    win.present();
});
app.run([]);
