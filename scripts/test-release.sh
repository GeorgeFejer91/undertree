#!/usr/bin/env bash
set -euo pipefail

app_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
archive="${1:-$app_root/release/localtex-studio-0.2.0-linux.tar.gz}"
temporary_root="$(mktemp -d)"
port="${LOCALTEX_RELEASE_SMOKE_PORT:-37993}"
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" >/dev/null 2>&1 || true; fi
  rm -rf "$temporary_root"
}
trap cleanup EXIT

tar -xzf "$archive" -C "$temporary_root"
bundle_root="$(find "$temporary_root" -mindepth 1 -maxdepth 1 -type d -name 'localtex-studio-*' -print -quit)"
test -n "$bundle_root"
test -f "$bundle_root/server.mjs"
test -f "$bundle_root/dist/index.html"
test -f "$bundle_root/node_modules/fast-xml-parser/package.json"

mkdir -p "$temporary_root/library"
LOCALTEX_PORT="$port" \
LOCALTEX_TOKEN=release-smoke-token \
LOCALTEX_LIBRARY_ROOT="$temporary_root/library" \
node "$bundle_root/server.mjs" > "$temporary_root/server.log" 2>&1 &
server_pid=$!

for _attempt in {1..30}; do
  if curl --silent --fail "http://127.0.0.1:$port/api/health" > "$temporary_root/health.json"; then break; fi
  sleep 0.2
done

grep -q '"version":"0.2.0"' "$temporary_root/health.json"
bootstrap_status="$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/?token=release-smoke-token")"
test "$bootstrap_status" = "302"

if grep -RInE '/home/George|ghp_|github_pat_|LOCALTEX_TOKEN=' "$bundle_root" --exclude='package-lock.json'; then
  echo "Personal path or credential-like content found in the release bundle." >&2
  exit 1
fi

echo "Extracted release server and authenticated bootstrap passed."
