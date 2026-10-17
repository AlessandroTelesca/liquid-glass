# Tune Defaults (developer only)

A second preferences window that starts with every value at its schema default, applies its own values to
the shell while open, and copies them to the clipboard. The user's settings are restored on close
(a snapshot is kept in `~/.cache/liquid-glass-tune-snapshot.txt` meanwhile, in case the window is killed).

It is not part of the extension. `npm run build:dev` (in the extension directory) copies
`tune-defaults.js` to `preferences/dev-tune.js` and swaps in `prefs.dev.js` as `prefs.js`.
`npm run build` and `npm run pack` put the original `prefs.js` back and remove the copy.
