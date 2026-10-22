// A libadwaita window full of hoverable rows, for the driver's prefshover
// check: like a preferences window, every row lights up under the pointer.
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

const app = new Adw.Application({application_id: 'test.liquidglass.Rows'});
app.connect('activate', () => {
    const win = new Adw.ApplicationWindow({application: app, title: 'lgdrv-rows', default_width: 520, default_height: 700});
    const page = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup({title: 'Rows'});
    for (let i = 0; i < 14; i++)
        group.add(new Adw.ActionRow({title: `Row ${i}`, subtitle: 'Hover me', activatable: true}));
    page.add(group);
    const view = new Adw.ToolbarView({content: page});
    view.add_top_bar(new Adw.HeaderBar());
    win.set_content(view);
    win.present();
});
app.run([]);
