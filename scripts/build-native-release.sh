#!/usr/bin/env bash
set -euo pipefail

app_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != Linux ]]; then
  echo "This command builds the Linux Debian installer on Linux." >&2
  exit 1
fi

cd "$app_root"
npm run verify:architecture
node modules/maintenance/generate-notices.mjs --check
mkdir -p "$app_root/artifacts/native-release"
build_record="$(mktemp -d "$app_root/artifacts/native-release/build.XXXXXX")"
cargo metadata --locked --no-deps --format-version 1 > "$build_record/metadata.json"
native_host="$(rustc --version --verbose | sed -n 's/^host: //p')"
if [[ -n "${CARGO_BUILD_TARGET:-}" && "$CARGO_BUILD_TARGET" != "$native_host" ]]; then
  echo "The Linux installer requires the native Rust host target." >&2
  exit 1
fi
cargo build --locked --release -p undertree-review --message-format=json-render-diagnostics > "$build_record/cli-artifacts.jsonl"
node modules/maintenance/native-release-paths.mjs "$build_record/metadata.json" "$build_record/cli-artifacts.jsonl" "$native_host" "$build_record"
cd "$app_root/native/tauri"
node ../../node_modules/@tauri-apps/cli/tauri.js build --config "$build_record/tauri.installer.json" --bundles deb --ci --no-sign -- --locked
node "$app_root/modules/maintenance/native-release-receipt.mjs" "$build_record/paths.json"
