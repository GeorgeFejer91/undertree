#!/usr/bin/env bash
set -euo pipefail

app_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_executable="$(command -v node || true)"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/localtex-studio"
applications_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
icons_dir="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"
systemd_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

if [[ -z "$node_executable" ]]; then
  echo "LocalTeX Studio requires Node.js 20 or newer." >&2
  exit 1
fi
node_major="$($node_executable -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 20 )); then
  echo "LocalTeX Studio requires Node.js 20 or newer; found $($node_executable --version)." >&2
  exit 1
fi
if [[ ! -f "$app_root/dist/index.html" ]]; then
  echo "The compiled interface is missing. Use a release archive or run npm install && npm run build." >&2
  exit 1
fi

if ! /usr/bin/python3 -c "import gi; gi.require_version('Gdk', '3.0'); gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1'); from gi.repository import Gdk, Gtk, WebKit2" 2>/dev/null; then
  echo "LocalTeX Studio requires the installed GTK 3 and WebKitGTK 4.1 Python bindings." >&2
  exit 1
fi

mkdir -p "$config_dir" "$applications_dir" "$icons_dir" "$systemd_dir"
if [[ ! -s "$config_dir/token" ]]; then
  (umask 077; "$node_executable" -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))' > "$config_dir/token")
fi
chmod 600 "$config_dir/token"

sed "s|@APP_ROOT@|$app_root|g" "$app_root/assets/localtex-studio.desktop.in" > "$applications_dir/localtex-studio.desktop"
sed -e "s|@APP_ROOT@|$app_root|g" -e "s|@NODE_EXECUTABLE@|$node_executable|g" "$app_root/assets/localtex-studio.service.in" > "$systemd_dir/localtex-studio.service"
chmod 644 "$applications_dir/localtex-studio.desktop" "$systemd_dir/localtex-studio.service"
install -m 0644 "$app_root/assets/localtex-studio.svg" "$icons_dir/localtex-studio.svg"
chmod +x "$app_root/bin/localtex-studio"
chmod +x "$app_root/native/localtex_studio.py"

if command -v update-desktop-database >/dev/null; then update-desktop-database "$applications_dir" >/dev/null 2>&1 || true; fi
if command -v gtk-update-icon-cache >/dev/null; then gtk-update-icon-cache -f -t "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor" >/dev/null 2>&1 || true; fi
if command -v systemctl >/dev/null && systemctl --user daemon-reload >/dev/null 2>&1; then
  systemctl --user enable localtex-studio.service
  systemctl --user restart localtex-studio.service
else
  echo "No systemd user session was detected; the native launcher will start its own background service." >&2
fi

if ! command -v latexmk >/dev/null; then
  echo "Warning: install latexmk and a TeX distribution before compiling projects." >&2
fi

echo "Installed native LocalTeX Studio. Launch it from the application menu or run: $app_root/bin/localtex-studio"
