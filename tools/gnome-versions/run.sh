#!/usr/bin/env bash
# Runs the packed extension in another GNOME Shell version as a window on the
# current desktop, inside the distrobox "gnomeVERSION" whose home is
# ~/gnomeVERSION-home (made by setup.sh). Works from the host and from inside
# the box.
#
#   run.sh VERSION            install the last packed zip and start the shell
#   run.sh VERSION --pack     npm run pack first (host only, needs npm)
#   run.sh VERSION --no-ext   start the shell with Liquid Glass disabled, to compare
#   run.sh VERSION --no-dock  leave Dash to Dock out
#
# VERSION is 46 to 51. 49 and later run with --devkit (the nested screen is
# streamed to a GTK window through PipeWire); 46 to 48 have no devkit and run
# with --nested, an X11 window on the host's Xwayland, whose screen keeps the
# size it starts with: on sway, the focused workspace's (or set
# MUTTER_DEBUG_DUMMY_MODE_SPECS, e.g. 1440x900).
#
# Dash to Dock is copied from the host's extensions when it is installed there
# (its releases support 45 to 51), so the dock glass can be tried too.
#
# LGTEST_AUTOSTART='kitty & gnome-text-editor' runs commands in the nested
# session once the shell is up.
#
# The shell gets its own session bus, runtime dir, PipeWire and dconf (in the
# box's home), so the real session's settings and extensions are untouched.
# Log: ~/gnomeVERSION-home/gVERSION.log
set -euo pipefail

version=${1:-}
case "$version" in
  46|47|48|49|50|51) shift ;;
  *) echo "usage: $(basename "$0") 46|47|48|49|50|51 [--pack|--no-ext|--no-dock]" >&2; exit 2 ;;
esac

BOX=gnome$version
UUID=liquid-glass@thinkingcoding1231.gmail.com
DTD_UUID=dash-to-dock@micxgx.gmail.com
here=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
repo=$(cd "$here/../.." && pwd)
ext_src="$repo/$UUID"
zip="$ext_src/$UUID.shell-extension.zip"

in_box() { [ -n "${CONTAINER_ID:-}" ] || [ -f /run/.containerenv ]; }

if ! in_box; then
  args=()
  for arg in "$@"; do
    if [ "$arg" = --pack ]; then
      (cd "$ext_src" && npm run pack)
    else
      args+=("$arg")
    fi
  done
  # Dash to Dock comes from the host's own extensions; the box only sees its
  # own home under ~.
  export LGTEST_DTD_DIR="$HOME/.local/share/gnome-shell/extensions/$DTD_UUID"
  # podman starts the box through the systemd user manager over the session
  # bus; a desktop started with its own dbus-daemon (/tmp/dbus-...) has no
  # systemd on it, so point podman at systemd's bus.
  # The --nested screen (46 to 48) keeps the size it starts with, and its
  # window cannot be resized. On sway it starts as large as the focused
  # workspace, less the title bar and border sway draws around the window.
  if [ "$version" -le 48 ] && [ -z "${MUTTER_DEBUG_DUMMY_MODE_SPECS:-}" ] && command -v swaymsg >/dev/null &&
     swaymsg -t get_version >/dev/null 2>&1; then
    size=$( { swaymsg -t get_workspaces; echo; swaymsg -t get_tree; } | python3 -c '
import json, sys
workspaces, tree = [json.loads(part) for part in sys.stdin.read().split("\n\n", 1)]
ws = next(w for w in workspaces if w["focused"])["rect"]
def focused(node):
    if node.get("focused"):
        return node
    for child in node.get("nodes", []) + node.get("floating_nodes", []):
        found = focused(child)
        if found:
            return found
con = focused(tree) or {}
border = con.get("window_rect", {}).get("x", 2)
title = con.get("deco_rect", {}).get("height", 30)
print("%dx%d" % (ws["width"] - 2 * border, ws["height"] - title - border))
' 2>/dev/null) || size=""
    [ -n "$size" ] && export MUTTER_DEBUG_DUMMY_MODE_SPECS="$size"
  fi
  user_bus="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus"
  [ -S "$user_bus" ] && export DBUS_SESSION_BUS_ADDRESS="unix:path=$user_bus"
  exec distrobox enter "$BOX" -- "$here/run.sh" "$version" "${args[@]}"
fi

enabled="'$UUID'"
dock=1
for arg in "$@"; do
  case "$arg" in
    --pack) echo "--pack needs npm on the host; installing the existing zip instead" >&2 ;;
    --no-ext) enabled="" ;;
    --no-dock) dock=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
[ -f "$zip" ] || { echo "no $zip; run 'npm run pack' on the host" >&2; exit 1; }

# Inside the box $HOME is the box's own home.
extensions="$HOME/.local/share/gnome-shell/extensions"
ext="$extensions/$UUID"
rm -rf "$ext" && mkdir -p "$ext"
unzip -q "$zip" -d "$ext"
glib-compile-schemas "$ext/schemas"

dtd_src=${LGTEST_DTD_DIR:-/nonexistent}
if [ "$dock" = 1 ] && [ -d "$dtd_src" ]; then
  rm -rf "${extensions:?}/$DTD_UUID"
  cp -r "$dtd_src" "$extensions/$DTD_UUID"
  enabled="${enabled:+$enabled, }'$DTD_UUID'"
fi

runtime=$(mktemp -d /tmp/lgrt.XXXXXX)
cleanup() {
  fusermount3 -u "$runtime/doc" 2>/dev/null || fusermount -u "$runtime/doc" 2>/dev/null || true
  rm -rf "$runtime" 2>/dev/null || true
}
trap cleanup EXIT

if [ "$version" -ge 49 ]; then
  # The devkit window is a Wayland client of the real desktop.
  host_wayland="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/${WAYLAND_DISPLAY:-wayland-0}"
  [ -S "$host_wayland" ] || { echo "no Wayland socket at $host_wayland" >&2; exit 1; }
  export HOST_WAYLAND="$host_wayland"
  export SHELL_MODE=--devkit
else
  # The nested window is an X11 client of the real desktop's Xwayland.
  [ -n "${DISPLAY:-}" ] || { echo "no DISPLAY; --nested needs the host's Xwayland" >&2; exit 1; }
  export HOST_DISPLAY="$DISPLAY"
  export SHELL_MODE=--nested
fi

export XDG_RUNTIME_DIR="$runtime"
# The box has no system bus socket of its own; the host's is under /run/host.
export DBUS_SYSTEM_BUS_ADDRESS=unix:path=/run/host/run/dbus/system_bus_socket
# What apps started by the nested shell, or activated over its session bus,
# need: a GNOME session and the nested display rather than the host's.
export XDG_CURRENT_DESKTOP=GNOME XDG_SESSION_DESKTOP=gnome XDG_SESSION_TYPE=wayland
export WAYLAND_DISPLAY=lg$version
unset DISPLAY
# The host's input method (fcitx) is not in the box.
unset GTK_IM_MODULE QT_IM_MODULE XMODIFIERS
export XDG_DATA_DIRS="$HOME/.local/share/flatpak/exports/share:/usr/local/share:/usr/share"
export ENABLED_EXTENSIONS="[$enabled]"
export UUID DTD_UUID EXT_DIR="$ext"
log="$HOME/g$version.log"

echo "starting GNOME Shell $(gnome-shell --version | awk '{print $3}') ($SHELL_MODE), log: $log"
dbus-run-session -- bash -c '
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell enabled-extensions "$ENABLED_EXTENSIONS"
  gsettings set org.gnome.shell welcome-dialog-last-shown-version "9999"
  # A test profile: the extension logs to the log file.
  gsettings --schemadir "$EXT_DIR/schemas" set org.gnome.shell.extensions.$UUID output-logs true
  pw=""
  wp=""
  if [ "$SHELL_MODE" = --devkit ]; then
    # --devkit streams the nested screen to its window through PipeWire.
    pipewire >/dev/null 2>&1 &
    pw=$!
    sleep 0.5
    wireplumber >/dev/null 2>&1 &
    wp=$!
    sleep 0.5
  fi
  if [ -n "${LGTEST_AUTOSTART:-}" ]; then
    (sleep 6; bash -c "$LGTEST_AUTOSTART") &
  fi
  # Xwayland would need a systemd unit, which the box does not have.
  if [ "$SHELL_MODE" = --devkit ]; then
    WAYLAND_DISPLAY="$HOST_WAYLAND" gnome-shell --devkit --wayland --no-x11 --wayland-display "$WAYLAND_DISPLAY"
  else
    DISPLAY="$HOST_DISPLAY" gnome-shell --nested --wayland --no-x11 --wayland-display "$WAYLAND_DISPLAY"
  fi
  [ -n "$wp" ] && kill $wp 2>/dev/null
  [ -n "$pw" ] && kill $pw 2>/dev/null
  true
' 2>&1 | tee "$log"
