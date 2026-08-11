#!/usr/bin/env bash
set -euo pipefail

app_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_executable="$(command -v node || true)"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
config_dir="$config_home/undertree"
legacy_config_dir="$config_home/localtex-studio"
applications_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
icons_dir="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"
systemd_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
legacy_desktop="$applications_dir/texstudio-overleaf.desktop"

if [[ -z "$node_executable" ]]; then
  echo "UnderTree requires Node.js 20 or newer." >&2
  exit 1
fi
node_major="$($node_executable -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 20 )); then
  echo "UnderTree requires Node.js 20 or newer; found $($node_executable --version)." >&2
  exit 1
fi
if [[ ! -f "$app_root/dist/index.html" ]]; then
  echo "The compiled interface is missing. Use a release archive or run npm install && npm run build." >&2
  exit 1
fi

if ! /usr/bin/python3 -c "import gi; gi.require_version('Gdk', '3.0'); gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1'); from gi.repository import Gdk, Gtk, WebKit2" 2>/dev/null; then
  echo "UnderTree requires the installed GTK 3 and WebKitGTK 4.1 Python bindings." >&2
  exit 1
fi

mkdir -p "$config_dir" "$applications_dir" "$icons_dir" "$systemd_dir" "$bin_dir"
if [[ ! -s "$config_dir/token" && -s "$legacy_config_dir/token" ]]; then
  install -m 0600 "$legacy_config_dir/token" "$config_dir/token"
fi
if [[ ! -f "$config_dir/window-state.json" && -f "$legacy_config_dir/window-state.json" ]]; then
  install -m 0600 "$legacy_config_dir/window-state.json" "$config_dir/window-state.json"
fi
if [[ ! -s "$config_dir/token" ]]; then
  (umask 077; "$node_executable" -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))' > "$config_dir/token")
fi
chmod 600 "$config_dir/token"

sed "s|@APP_ROOT@|$app_root|g" "$app_root/assets/undertree.desktop.in" > "$applications_dir/undertree.desktop"
sed -e "s|@APP_ROOT@|$app_root|g" -e "s|@NODE_EXECUTABLE@|$node_executable|g" "$app_root/assets/undertree.service.in" > "$systemd_dir/undertree.service"
chmod 644 "$applications_dir/undertree.desktop" "$systemd_dir/undertree.service"
install -m 0644 "$app_root/assets/undertree.svg" "$icons_dir/undertree.svg"
chmod +x "$app_root/bin/undertree"
chmod +x "$app_root/bin/localtex-studio"
chmod +x "$app_root/native/localtex_studio.py"
ln -sfn "$app_root/bin/undertree" "$bin_dir/undertree"
ln -sfn "$bin_dir/undertree" "$bin_dir/localtex-studio"

# Retire the former TeXstudio profile without breaking old scripts or shortcuts:
# stale texstudio-overleaf calls now open UnderTree, and uninstall can
# restore the previous launcher and desktop entry.
if [[ -e "$bin_dir/texstudio-overleaf" && ! -L "$bin_dir/texstudio-overleaf" && ! -e "$bin_dir/texstudio-overleaf.legacy" ]]; then
  mv "$bin_dir/texstudio-overleaf" "$bin_dir/texstudio-overleaf.legacy"
fi
ln -sfn "$bin_dir/undertree" "$bin_dir/texstudio-overleaf"
if [[ -f "$legacy_desktop" && ! -f "$legacy_desktop.legacy" ]]; then
  mv "$legacy_desktop" "$legacy_desktop.legacy"
fi
rm -f "$applications_dir/localtex-studio.desktop" "$icons_dir/localtex-studio.svg"

if command -v update-desktop-database >/dev/null; then update-desktop-database "$applications_dir" >/dev/null 2>&1 || true; fi
if command -v gtk-update-icon-cache >/dev/null; then gtk-update-icon-cache -f -t "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor" >/dev/null 2>&1 || true; fi
if command -v xdg-mime >/dev/null; then
  for mime_type in text/x-tex text/x-bibtex application/x-tex application/x-latex; do
    xdg-mime default undertree.desktop "$mime_type"
  done
fi
if command -v systemctl >/dev/null && systemctl --user daemon-reload >/dev/null 2>&1; then
  systemctl --user disable --now localtex-studio.service >/dev/null 2>&1 || true
  rm -f "$systemd_dir/localtex-studio.service"
  systemctl --user daemon-reload
  systemctl --user enable undertree.service
  systemctl --user restart undertree.service
else
  echo "No systemd user session was detected; the native launcher will start its own background service." >&2
fi

if ! command -v latexmk >/dev/null; then
  echo "Warning: install latexmk and a TeX distribution before compiling projects." >&2
fi

echo "Installed UnderTree as the default TeX editor. Launch it from the application menu or run: undertree"
