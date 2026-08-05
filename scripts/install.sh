#!/usr/bin/env bash
set -euo pipefail

app_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/localtex-studio"
applications_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
icons_dir="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"
systemd_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

mkdir -p "$config_dir" "$applications_dir" "$icons_dir" "$systemd_dir"
if [[ ! -s "$config_dir/token" ]]; then
  (umask 077; node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))' > "$config_dir/token")
fi
chmod 600 "$config_dir/token"

sed "s|@APP_ROOT@|$app_root|g" "$app_root/assets/localtex-studio.desktop.in" > "$applications_dir/localtex-studio.desktop"
sed "s|@APP_ROOT@|$app_root|g" "$app_root/assets/localtex-studio.service.in" > "$systemd_dir/localtex-studio.service"
chmod 644 "$applications_dir/localtex-studio.desktop" "$systemd_dir/localtex-studio.service"
install -m 0644 "$app_root/assets/localtex-studio.svg" "$icons_dir/localtex-studio.svg"
chmod +x "$app_root/bin/localtex-studio"

if command -v update-desktop-database >/dev/null; then update-desktop-database "$applications_dir" >/dev/null 2>&1 || true; fi
if command -v gtk-update-icon-cache >/dev/null; then gtk-update-icon-cache -f -t "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor" >/dev/null 2>&1 || true; fi
systemctl --user daemon-reload
systemctl --user enable --now localtex-studio.service

echo "Installed LocalTeX Studio. Launch it from the application menu or run: $app_root/bin/localtex-studio"
