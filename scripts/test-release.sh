#!/usr/bin/env bash
set -euo pipefail

app_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(node -p "JSON.parse(require('fs').readFileSync('$app_root/package.json', 'utf8')).version")"
archive="${1:-$app_root/release/undertree-${version}-linux.tar.gz}"
temporary_root="$(mktemp -d)"
port="${UNDERTREE_RELEASE_SMOKE_PORT:-${LOCALTEX_RELEASE_SMOKE_PORT:-37993}}"
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" >/dev/null 2>&1 || true; fi
  rm -rf "$temporary_root"
}
trap cleanup EXIT

tar -xzf "$archive" -C "$temporary_root"
bundle_root="$(find "$temporary_root" -mindepth 1 -maxdepth 1 -type d -name 'undertree-*' -print -quit)"
test -n "$bundle_root"
test -f "$bundle_root/server.mjs"
test -f "$bundle_root/dist/index.html"
test -f "$bundle_root/node_modules/fast-xml-parser/package.json"
test -f "$bundle_root/node_modules/@openai/codex-sdk/package.json"
bundled_codex="$(find "$bundle_root/node_modules/@openai" -path '*/bin/codex' -type f -perm -u+x -print -quit)"
test -n "$bundled_codex"
"$bundled_codex" --version | grep -q '^codex-cli '
test -x "$bundle_root/bin/undertree"
test -f "$bundle_root/assets/undertree.desktop.in"
test -f "$bundle_root/assets/undertree.service.in"

mkdir -p "$temporary_root/library"
UNDERTREE_PORT="$port" \
UNDERTREE_TOKEN=release-smoke-token \
UNDERTREE_LIBRARY_ROOT="$temporary_root/library" \
node "$bundle_root/server.mjs" > "$temporary_root/server.log" 2>&1 &
server_pid=$!

for _attempt in {1..30}; do
  if curl --silent --fail "http://127.0.0.1:$port/api/health" > "$temporary_root/health.json"; then break; fi
  sleep 0.2
done

grep -q "\"app\":\"UnderTree\"" "$temporary_root/health.json"
grep -q "\"version\":\"$version\"" "$temporary_root/health.json"
bootstrap_status="$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/?token=release-smoke-token")"
test "$bootstrap_status" = "302"

if grep -RInE '/home/George|ghp_|github_pat_|(UNDERTREE|LOCALTEX)_TOKEN=' "$bundle_root" --exclude='package-lock.json'; then
  echo "Personal path or credential-like content found in the release bundle." >&2
  exit 1
fi

echo "Extracted release server and authenticated bootstrap passed."
