# Rust manuscript and review authority

`undertree-review` owns approved project roots, manuscript/review persistence,
color policies, scoped proposals, local acceptance, Typst compilation,
best-effort TeX import and GitHub checkpoints. The Tauri desktop and local
CLI/browser adapter dispatch the same typed `Operation`; the agent MCP
catalogue is a separate closed subset.

## Boundaries

- Agents can list shared manuscripts, read source/review context and submit a
  wording proposal. They cannot accept/reject, save, change rules, import,
  compile, synchronize Git or address arbitrary paths.
- Local acceptance rechecks source revision, quote, valid prose and current
  protection. Replacement text is escaped for HTML or Typst. Protect/reject
  beats prompts; stale protection fails closed.
- Local `reanchor` takes `project`, `path`, the current `revision`, marker `id`,
  UTF-16 `from`/`to` and exact `quote`. It moves the existing highlight while
  keeping its rule and prompt; it never edits source or grants MCP authority.
- Manuscripts are UTF-8 text with adjacent version-1
  `.undertree-review.json` sidecars. A transient `.undertree-pending.json`
  journal recovers interrupted source/metadata writes. Unknown/corrupt metadata
  and external conflicts are preserved for local resolution.
- Limits include 2 MB source files, 500 markers/suggestions, 24 palette rules,
  20 session shares, bounded directory discovery, 16 MB PDF previews and
  bounded compiler/Git subprocess output and deadlines.

`document.rs` owns policy, offsets and validation; `service.rs` owns filesystem
and Git authority; `publishing.rs` owns Typst process/PDF handling;
`tex_import.rs` owns the bounded importer; `transport.rs` owns MCP and loopback
adapters. `native/tauri/` forwards local commands and supplies native folder
selection. Browser save/review coordination lives in `modules/frontend/`.

## Run and verify

From the repository root:

```bash
npm run desktop
npm run test:review
npm run test:review-ui
npm run verify:architecture
```

Compilation requires a separately installed Typst CLI (`UNDERTREE_TYPST`
optionally selects it). No TeX installation is required. The Rust syntax
library validates source ranges; the complete Typst renderer is currently a
supervised external process. Import creates a new `.typ` plus
`.import-report.json` with `exactFormatting: false` and keeps the `.tex`.

The local qualification service runs with `cargo run -p undertree-review`.
Set a random `UNDERTREE_REVIEW_TOKEN` of at least 32 characters in the local
process environment. Optional `UNDERTREE_REVIEW_STATE`,
`UNDERTREE_REVIEW_PORT` (default 37372) and `UNDERTREE_REVIEW_ASSETS` (default
`dist`) select private local state, port and built assets. The service binds
only to loopback. Do not put tokens in URLs or commit them.

With that service running, the local CLI accepts a typed JSON operation:

```bash
cargo run -p undertree-review -- call '{"action":"projects"}'
```

It uses the same environment token and optional `UNDERTREE_REVIEW_ENDPOINT`
(a loopback URL), and requires `curl`. This adapter is for local scripting and
browser qualification; it does not expose the local registry to remote agents.

## Opt-in network integrations

The tunnel adapter requires enabled `zrok2`, an existing reserved public name
and its exact HTTPS origin. `UNDERTREE_ZROK` optionally selects its executable.
Rust supervises the child and a separate loopback MCP listener; each start
creates a fresh secret URL. Sharing individual manuscripts is separate from
starting the tunnel. Stopping the tunnel revokes session shares. The URL grants
review access and must be treated as a secret. A child remaining alive does
not establish public connectivity.

The manuscript workspace's **Connections** popup manages setup, MCP status and
individual session grants through this same service. Only the public name and
origin are saved in `connection.json` in the native state directory; startup
restores no process, capability, MCP activity or shared manuscript. Invalid or
duplicate starts preserve the live session. Child exit detected by status
clears grants; every public request independently requires a live owned child.
`connection` reports initialization, request time, tool-call count and the
closed catalogue without claiming a verified public route or client identity.

GitHub binding accepts `owner/name`, uses existing Git credentials, and refuses
to retarget a different existing origin. Synchronization stages only
UnderTree-owned pending sources/sidecars/import reports, checks ancestry and
conflicts, never force-pushes and verifies the remote branch head. Automatic
checkpoints are scheduled by the UI after a debounce and remain optional.
Metadata-only review changes own only the sidecar; they cannot adopt external
source edits or renew a previously saved source's pending digest.

See [the product goal](../../For-AI/product-goal.md) and
[reference evidence](../../For-AI/reference-evidence.md) for migration scope,
upstream behavioral references and live integration/platform checks still
needed. Neither the service nor Tauri consumes `For-AI/` at runtime.
