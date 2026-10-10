#!/usr/bin/env bash
# Builds a contact sheet of every installed application's icon taken apart
# into glass plates and a symbol, in each icon theme given (default: Yaru,
# Adwaita, MacTahoe-dark), and prints the HTML file's path. Build the
# extension first (npm run build): the analysis is its dist/iconStyle.
#
#   tools/icon-sheet/run.sh [theme...]
#   LG_ICON_SHEET_OUT  output directory (default: tools/icon-sheet/out)
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
out=${LG_ICON_SHEET_OUT:-$here/out}
mkdir -p "$out"
themes=("$@")
[ ${#themes[@]} -gt 0 ] || themes=(Yaru Adwaita MacTahoe-dark)

# St lives with the shell, and needs mutter's typelibs.
st_typelib=$(find /usr/lib /usr/lib64 -name 'St-*.typelib' -path '*gnome-shell*' 2>/dev/null | head -n1)
meta_typelib=$(find /usr/lib /usr/lib64 -name 'Meta-*.typelib' -path '*mutter*' 2>/dev/null | head -n1)
if [ -z "$st_typelib" ] || [ -z "$meta_typelib" ]; then
  echo "St or Meta typelib not found" >&2
  exit 1
fi
shell_dir=$(dirname "$st_typelib")
mutter_dir=$(dirname "$meta_typelib")
export LD_LIBRARY_PATH="$shell_dir:$mutter_dir:${LD_LIBRARY_PATH:-}"
export GI_TYPELIB_PATH="$shell_dir:$mutter_dir:${GI_TYPELIB_PATH:-}"
# The theme is picked through org.gnome.desktop.interface; keep that in memory.
export GSETTINGS_BACKEND=memory

files=()
for theme in "${themes[@]}"; do
  gjs -m "$here/collect.js" "$theme" "$out/$theme.json"
  files+=("$out/$theme.json")
done
node "$here/build-sheet.cjs" "$out/icon-sheet.html" "${files[@]}"
echo "$out/icon-sheet.html"
