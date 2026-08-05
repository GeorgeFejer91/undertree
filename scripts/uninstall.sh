#!/usr/bin/env bash
set -euo pipefail

applications_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
icons_root="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
systemd_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

systemctl --user disable --now localtex-studio.service >/dev/null 2>&1 || true
rm -f "$applications_dir/localtex-studio.desktop"
rm -f "$icons_root/scalable/apps/localtex-studio.svg"
rm -f "$systemd_dir/localtex-studio.service"
systemctl --user daemon-reload >/dev/null 2>&1 || true

if command -v update-desktop-database >/dev/null; then update-desktop-database "$applications_dir" >/dev/null 2>&1 || true; fi
if command -v gtk-update-icon-cache >/dev/null; then gtk-update-icon-cache -f -t "$icons_root" >/dev/null 2>&1 || true; fi

echo "LocalTeX Studio launch integration was removed. Projects and user settings were kept."
