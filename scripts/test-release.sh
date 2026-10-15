#!/usr/bin/env bash
set -euo pipefail

app_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$app_root/package.json")"
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
test -f "$bundle_root/cli.mjs"
test -f "$bundle_root/modules/compiler/toolchain.mjs"
test -f "$bundle_root/src/html-renderer.mjs"
test -f "$bundle_root/src/html-render-bootstrap.js"
test -f "$bundle_root/src/pretext-fit-core.js"
for package in fast-xml-parser parse5 @chenglou/pretext; do
  test -f "$bundle_root/node_modules/$package/package.json"
done
for excluded in For-AI target native/tauri node_modules/@openai node_modules/@napi-rs node_modules/@codemirror node_modules/@tiptap node_modules/codemirror node_modules/pdfjs-dist; do
  if [[ -e "$bundle_root/$excluded" ]]; then
    echo "Excluded development or compiler content found in release: $excluded" >&2
    exit 1
  fi
done
bundle_version="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version" "$bundle_root/package.json")"
test "$bundle_version" = "$version"
test -x "$bundle_root/bin/undertree"
test -f "$bundle_root/assets/undertree.desktop.in"
test -f "$bundle_root/assets/undertree.service.in"

mkdir -p "$temporary_root/library"
UNDERTREE_PORT="$port" \
UNDERTREE_TOKEN=release-smoke-token \
UNDERTREE_LIBRARY_ROOT="$temporary_root/library" \
UNDERTREE_STATE_ROOT="$temporary_root/state" \
node "$bundle_root/server.mjs" > "$temporary_root/server.log" 2>&1 &
server_pid=$!

for _attempt in {1..30}; do
  if curl --silent --fail "http://127.0.0.1:$port/api/health" > "$temporary_root/health.json"; then break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    cat "$temporary_root/server.log" >&2
    echo "The extracted release server exited before becoming ready." >&2
    exit 1
  fi
  sleep 0.2
done

node --input-type=module - "$temporary_root/health.json" "$version" "$temporary_root/library" <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const health = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(health.app, 'UnderTree');
assert.equal(health.version, process.argv[3]);
assert.equal(health.libraryRoot, process.argv[4], 'the health response belongs to the extracted test instance');
NODE
unauthenticated_status="$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/api/projects")"
test "$unauthenticated_status" = "403"
bootstrap_status="$(curl --silent --cookie-jar "$temporary_root/cookies" --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/?token=release-smoke-token")"
test "$bootstrap_status" = "302"
curl --silent --fail --cookie "$temporary_root/cookies" "http://127.0.0.1:$port/app" > "$temporary_root/app.html"
grep -q '<title>UnderTree' "$temporary_root/app.html"
curl --silent --fail --cookie "$temporary_root/cookies" "http://127.0.0.1:$port/api/projects" > "$temporary_root/projects.json"
UNDERTREE_PORT="$port" node "$bundle_root/cli.mjs" health --no-start > "$temporary_root/cli-health.json"

if grep -RInE '/home/George|ghp_|github_pat_|(UNDERTREE|LOCALTEX)_TOKEN=' "$bundle_root" --exclude='package-lock.json'; then
  echo "Personal path or credential-like content found in the release bundle." >&2
  exit 1
fi

echo "Extracted release content, server identity, authentication, frontend and CLI passed."
