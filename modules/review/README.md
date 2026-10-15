# Rust manuscript and review authority

`undertree-review` owns approved project roots, manuscript/review persistence,
color policies, scoped proposals, local acceptance, Typst compilation,
best-effort TeX import and GitHub checkpoints. The Tauri desktop and local
CLI/browser adapter dispatch the same typed `Operation`; the agent MCP
catalogue is a separate closed subset.

## Boundaries

- Review agents can list shared manuscripts, read source/review context and submit a
  wording proposal. They cannot accept/reject, save, change rules, import,
  compile, synchronize Git or address arbitrary paths.
- Separately enabled, session-only App controls have their own capability URL
  and closed non-content catalogue: shared manuscript reads, workspace/receipt
  inspection, guarded navigation/selection, presentation settings, native window
  actions and saved-revision Typst builds. They cannot save source, submit review
  proposals, accept decisions, change policies or invoke local operations. The
  existing Review URL remains exactly three tools.
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
  New journals bind the approved project/path, source-ownership intent and exact
  prior review bytes. Recovery restores the matching pending Git hashes before
  removing the journal; clean editor verification owns metadata only. Legacy
  ordinary journals without project provenance are preserved with
  `recovery_conflict` rather than replayed under the current opener.
- During one Service lifetime, disappearing previously observed review metadata
  blocks reads and writes with `policy_missing`. Restoring its exact raw bytes
  permits an explicit pure Review retry; revoking or re-enabling sharing does
  not reset that knowledge. The bounded observation store retains up to 4,096
  entries without eviction. Grants and observations are not restored at restart.
- Remote reads/proposals, App navigation and local CLI reads (including raw
  `open`) refuse pending journals and never adopt sidecars. Explicit native UI
  Open retains source recovery; observation cannot replay interrupted writes.
- Create/import refuse existing destination sources, review/pending metadata
  and import reports, including linked or dangling artifacts. Outputs are
  staged and individually published without overwriting. After any publication,
  a later failure preserves the published paths and reports `outcome_unknown`;
  pathname-based rollback could otherwise delete an external replacement.
  Partial outputs can lack companion metadata/report and require inspection
  before retrying. This is not an atomic multi-file creation transaction.
- Limits include 2 MB source files, 500 markers/suggestions, 24 palette rules,
  20 session shares, bounded directory discovery, 16 MB PDF previews and
  bounded compiler/Git subprocess output and deadlines.

`document.rs` owns policy, offsets and validation; `service.rs` owns filesystem
and Git authority; `publishing.rs` owns Typst process/PDF handling;
`tex_import.rs` owns the bounded importer; `control.rs` owns bounded UI jobs;
`service/editor.rs` owns local editor save coordination; `service/app_control.rs`
  binds non-content actions to native grants/shared IDs and filters remote output;
`transport.rs` owns MCP and loopback
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

Compilation uses the separately installed, qualified Typst 0.15.1 CLI (`UNDERTREE_TYPST`
optionally selects it). No TeX installation is required. The Rust syntax
library validates source ranges; the complete Typst renderer is currently a
supervised external process. Import creates a new `.typ` plus
`.import-report.json` with `exactFormatting: false` and keeps the `.tex`.

Local `set_main_document` accepts `project` and an existing `.typ` `path`;
an empty path clears the setting. It persists `mainDocument` in the project
registry and returns the updated project. The UI saves all open project inputs
and compiles that main document while retaining the selected chapter or
bibliography editor. Explicit `compile`/`pdf` operations still address the named
source and use its revision; Review MCP permissions do not change.

Compilation stages regular inputs through rooted, no-follow directory/file
handles before launching Typst. The child uses that private root for sources,
relative assets and project fonts. Dependency receipts hash the copied bytes;
currentness hashes the originals without following links. An edited, removed
or linked original leaves the safe snapshot PDF available with `current:false`.
Reserved directories and noncanonical source paths fail before source reads.
Staging excludes `.git`, `node_modules`, `For-AI` and compiler snapshots, with
128 MiB total input, 20,000 entry, 2,000 directory and 32-level bounds.

Normal/error/cancel cleanup uses owned temporary directories. Abrupt-crash
residue cleanup remains open. PDF/dependency admission limits do not impose a
hard quota on temporary compiler writes. The external compiler, prepared
package caches and system/embedded fonts remain separate trusted inputs;
this project-input isolation is not an OS sandbox.

Bibliography and data text sources (`.bib`, `.yaml`, `.yml`, `.json`, `.csv`,
`.tsv`, `.xml`, `.svg`) use the existing confined, revision-checked save path.
Internal review journals/sidecars and import reports remain outside the editable
source inventory. New data files start empty.

`npm run test:typst-publishing` requires a built `undertree-review` service and
a real Typst executable. Unlike optional compiler unit probes, it fails when
the compiler is absent. Its authored fixtures and PDF inspection cover common
publishing outcomes and explicit import limitations, not arbitrary LaTeX
formatting equivalence or whole-application parity.

The local qualification service runs with `cargo run -p undertree-review`.
Set a random `UNDERTREE_REVIEW_TOKEN` of at least 32 characters in the local
process environment. Optional `UNDERTREE_REVIEW_STATE`,
`UNDERTREE_REVIEW_PORT` (default 37372) and `UNDERTREE_REVIEW_ASSETS` (default
`dist`) select private local state, port and built assets. The service binds
only to loopback. Do not put tokens in URLs or commit them.

With the desktop running, the local CLI discovers its authenticated, private
loopback endpoint and uses the same Rust authority:

```bash
cargo run -p undertree-review -- call '{"action":"projects"}'
```

`cargo run -p undertree-review -- capabilities` queries the same running
authority for contract version, instance identity and the implemented local
operation inventory. It reports the three Review tools separately and marks
direct file editing unavailable. Non-content App controls require their separate
explicit session grant. Capability discovery grants no additional access; caller
authority is selected by the authenticated adapter, never by a JSON field.

Discovery reads the current user's application state; `UNDERTREE_REVIEW_STATE`
can select an explicitly isolated state folder. A process-held OS lock rejects
a second authority in that folder. The private descriptor is removed on exit,
its token rotates on restart, and calls bind to the current instance identity.
The desktop endpoint serves reads and `save <project> <path>`, which saves the
registered live editor buffer through its existing queue. It accepts no replacement
text and fails with `ui_unavailable` when no editor owns the document. All other
CLI mutations remain denied inside the Rust service. It serves no frontend, browser token
bootstrap or public MCP route. Missing/stopped instances fail explicitly.

The existing `review` refresh action is a read-only snapshot: pending save journals
return `busy`, missing sidecars stay absent and external-change invalidation stays
in memory. CLI `read` and raw `open` use the same no-recovery snapshot. Explicit
native UI `open` retains interrupted-save recovery. Refreshing
review state cannot silently perform a content write or adopt external changes.

The separate browser qualification service retains its explicit environment
token and optional `UNDERTREE_REVIEW_ENDPOINT` (a loopback URL) compatibility
mode. Both CLI paths require `curl`. Neither exposes local operations through
the remote Review catalogue.

`save-receipt <requestId>` inspects the durable native result after a lost response.
The result distinguishes a committed captured generation from the current buffer:
`bufferStatus` is `saved`, `newer_buffer`, or `unconfirmed` if renderer confirmation
has not arrived within the bounded grace period. A later editor change never erases the committed receipt. Clean buffers
still verify the native disk revision. Receipts are journaled with the existing
source/review transaction and recovered before its pending journal is removed.
The private v1 editor bridge binds registrations and expiring tickets to a native
window (or a separate per-page browser qualification owner); CLI and MCP cannot
register, poll or acknowledge sessions. The bridge allows at most 64 sessions,
64 queued saves, one pending save per document and 1024 durable receipts. A full
receipt store denies new saves while retaining existing evidence.

Native editor and App callbacks share a page epoch from `editor_connect`; a
retired renderer cannot register or acknowledge new work. App opt-in/callbacks
use a separate internal `ControlOperation` adapter and require a current local
UI owner. Browser qualification uses `/api/control` with its UI token and page
nonce. None of these routes exists on the private CLI or public MCP listener.
The local CLI connection response omits the App bearer URL.

App UI acknowledgements never export their arbitrary result object. Rust returns
only bounded command status and verified build metadata, and filters workspace
observations to shared IDs. The full local snapshot still guards inactive and
unshared dirty/conflicted/composing buffers. `control_open` reads without journal
recovery or metadata creation; `control_compile` derives the shared target and
saved revision from its authorized job. Internal build replay does not start
another compiler and refuses a replaced PDF artifact. Public artifact export is
available only through the separately enabled PDF export permission described below.

The local Connections App page can enable standing PDF export for selected approved
project roots that currently contain shared manuscripts. This permission includes
current and future saved inputs inside those roots, including other sources,
included text, images, fonts and data; individual input files need no repeated
approval. A new project root is excluded until explicitly added locally. Existing
App grants start with PDF export disabled. Local permission changes bind both the
rendered App `generation` and `pdfExport.generation` (`exportGeneration` in the
request), so delayed requests cannot overwrite later consent or re-enable exports.
Root path and native identity are captured for the grant; a replacement real folder
at the same path does not inherit it.

Only currently shared Typst manuscripts in those roots receive optional `savedPdf`
metadata on App `list_manuscripts`. `get_pdf_download` requires its exact
`documentId`, `revision` and `artifactId`; it never compiles, saves or substitutes
a different build. The legacy artifact ID hashes base64 text, while `sha256` hashes
the raw PDF bytes. New exports require a current verified saved preview; stale,
legacy or unavailable previews fail explicitly. Once issued, a download retains
its exact bytes even if a later local compile replaces the preview.

PDF tickets last five minutes, permit four GETs and are bounded to four retained
artifacts, 16 MiB per PDF and 64 MiB total, including bytes held by revoked active
streams. One inspection worker, four request-authorization workers and two downloads
may run concurrently. Downloads
use 64 KiB chunks with a one-minute transfer deadline and ongoing grant, owner,
share and UI-lease checks. Revocation stops later chunks and requests; already
sent or buffered bytes cannot be recalled. The public listener mounts only the
fixed GET/HEAD PDF route, with no CORS or browser-Origin access. CLI and Review
cannot enable export or obtain its download tool. Local CLI connection status
omits the private PDF permission details.

The native compiler and its package/system-font environment remain trusted inputs;
artifact hashes bind the generated bytes rather than proving the behavior of an
arbitrary configured compiler. A resource link and HTTP download do not establish
automatic ChatGPT attachment ingestion: that still needs a live host/zrok check.

The authenticated local UI also has `project_tree` and `create_directory`.
The tree returns explicit directories (including empty folders), editable-source
candidates and regular assets without reading file contents. Its flat entries
use native `editable` eligibility; opening a source still validates its content.
Binary assets with UTF-8 names are included. Names that cannot round-trip through
JSON UTF-8 are omitted and counted once per encountered entry, without traversing
an omitted directory. `truncated` and the returned limits identify a partial
inventory; partial or omitted results cannot establish that a folder is empty.
Hidden entries, `node_modules`, `For-AI`, internal review/journal/import-report
files, links and special files are excluded. The existing `files` string-array
contract is unchanged. Both new actions are denied to CLI and MCP authority.

Folder creation makes one new empty leaf beneath an existing parent, never
overwrites an existing entry and creates no placeholder, sidecar or Git pending
record. Git does not track an empty folder; it becomes part of a checkpoint only
through subsequently tracked files. Capability directory handles prevent link
redirection. The approved root remains a path-based grant, with directory identity
checked during each operation. An external rename concurrent with creation can
produce `outcome_unknown`; refresh before retrying, and never remove a replacement
to disguise that uncertainty. These backend checks do not establish native
rendered file-tree qualification.

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
