# Preferences

The preferences window has three pages: Appearance, Effects and Rendering.
Settings view switches between Simple (the default, eight shared appearance controls)
and Advanced (individual surfaces, offsets, springs, sampling and optical controls).
The view is remembered independently of the effects: switching never applies a preset
or resets existing values. Advanced surface controls are created on demand and reused.
Both views use short English labels and native libadwaita controls.

Opening preferences must not write any settings. Different existing values are
shown as Custom and are retained until an explicit edit. A shared edit updates only
that control's keys, including disabled surfaces, in one delayed GSettings transaction.
No migration or reset runs on open. Custom is a status, not a preset or saved undo point.
Smooth motion sets critically damped springs; it does not run automatically.
The Blur my Shell warning at the top of Appearance follows `blur-my-shell-popup-blur`,
which the shell writes. Its Turn Off button writes only Blur my Shell's own popup
`blur` key, and only when clicked.

The window is built from three files. `preferences/pages.js` defines the pages, the visible
choices and which existing keys they own, the advanced view (a group per surface, built the
first time it is picked), the Desktop page and the switches for detected top bar menus.
`controls.js` owns the row builders, grouped writes, mixed-value readouts and subscriptions,
the settings backup format, and the branches that set the rows depending on a switch (animations,
adaptive color, the outline) in from the left and fold them with an arrow at the end of the
switch's row; it loads the one CSS rule for that indent and removes it when the window closes.
`apps.js` owns the application icon and window lists, their pickers and the D-Bus lifetime of
the window list.
The preferences entry point only loads this window; it does not import Shell modules.

Verification:

```sh
node --test --test-isolation=none tests/preferences.test.cjs
GSETTINGS_BACKEND=memory gjs -m tests/preferences-smoke.mjs
```

The second test needs a graphical session and uses actual GTK/libadwaita widgets;
it refuses to run without the isolated memory backend. Neither test changes the
user's profile. The GTK test covers construction and editing, not a visual audit.

Ship the `preferences/` directory alongside `prefs.js`. When using
`gnome-extensions pack`, include it with `--extra-source=preferences` in addition to
the existing runtime files (`dist`, `shaders` and `resources.gresource`). Reopen the
preferences window to load an update; restarting GNOME is not necessary.

Native widget and transaction behavior follow the upstream documentation for
[libadwaita preferences](https://gnome.pages.gitlab.gnome.org/libadwaita/doc/main/class.PreferencesWindow.html)
and [GSettings delayed writes](https://docs.gtk.org/gio/class.Settings.html).
