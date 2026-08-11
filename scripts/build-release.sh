#!/usr/bin/env bash
set -euo pipefail

app_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
release_root="${1:-$app_root/release}"
version="$(node -p "JSON.parse(require('fs').readFileSync('$app_root/package.json', 'utf8')).version")"
archive_base="undertree-${version}-linux"
staging_root="$(mktemp -d)"
bundle_root="$staging_root/$archive_base"

cleanup() {
  rm -rf "$staging_root"
}
trap cleanup EXIT

cd "$app_root"
npm run build

mkdir -p "$bundle_root/assets" "$bundle_root/scripts" "$release_root"
cp -a dist layout native bin "$bundle_root/"
cp server.mjs "$bundle_root/"
cp assets/undertree.desktop.in assets/undertree.service.in assets/undertree.svg "$bundle_root/assets/"
cp scripts/install.sh scripts/uninstall.sh "$bundle_root/scripts/"
cp README.md ARCHITECTURE.md LAYOUT_FORMAT.md PERFORMANCE.md VERIFICATION.md "$bundle_root/"
cp packaging/runtime/package.json packaging/runtime/package-lock.json "$bundle_root/"

cd "$bundle_root"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
chmod +x bin/undertree bin/localtex-studio native/localtex_studio.py scripts/install.sh scripts/uninstall.sh

cd "$staging_root"
tar -czf "$release_root/$archive_base.tar.gz" "$archive_base"
(cd "$release_root" && sha256sum "$archive_base.tar.gz" > "$archive_base.tar.gz.sha256")
printf '%s\n' "$release_root/$archive_base.tar.gz"
