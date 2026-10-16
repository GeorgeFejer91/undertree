# Module map

| Module | Owns | Existing adapters/assets | Must not own |
| --- | --- | --- | --- |
| `modules/frontend/` | realtime scheduling, review/save coordination, interaction state, browser-only performance policy | `src/main.js`, `src/styles.css`, `index.html`, `src/manuscript.js`, `src/manuscript.css`, `manuscript.html` | native policy, compiler executable discovery, release scripts, native binaries |
| `modules/compiler/` | local service process, compiler toolchain discovery, TeX job lifecycle, build coalescing interfaces | `server.mjs`, `layout/`, `native/html_print_renderer.py`, compiler-facing helpers in `src/` | native window lifecycle, installer policy, UI DOM code |
| `modules/maintenance/` | architecture validation, runtime-package allowlists, release and test policy | `scripts/`, `packaging/`, `.github/` | application request handling or editor behavior |
| `modules/review/` | Rust manuscript/review authority, project approvals, revision checks, sidecar persistence, narrow MCP tools, Typst process/PDF handling, best-effort TeX import, local GitHub checkpoints and separately granted non-content App controls | `modules/frontend/review-*`, `src/manuscript.js`, `manuscript.html`, local review CLI/browser adapter | remote source/policy mutations, generic filesystem/shell proxies, TeX requirements |
| `native/tauri/` | Tauri window lifecycle, least-privilege commands, native folder selection, packaging | Rust review service and bundled HTML frontend | domain policy in the WebView, privileges for remote content |

## Dependency direction

Connection ownership: `modules/review/src/transport.rs` owns zrok2 supervision, the separate MCP listener, URL capability and observed MCP activity; `service.rs` owns approved shares and non-secret setup persistence. `src/connection-manager.js` is the dialog DOM adapter; it uses `modules/frontend/review-api.js` and never talks to zrok or the MCP endpoint directly. `manuscript.html` and `src/manuscript.css` own the popup structure/geometry. The active product uses Rust/Tauri on every platform. Historical `native/windows/` Electron sources are inactive migration references and are excluded from development and release targets.

```text
Tauri window adapter   ──> Rust review service <── local CLI/test adapter
review HTML adapter    ──> frontend save/review coordinator ──> typed Tauri IPC
opt-in zrok2 MCP        ──> closed Rust remote tools ──> review service
native/window adapter ──> compiler service process
frontend adapter       ──> frontend scheduling module ──> authenticated local API
compiler service       ──> compiler module + layout/render assets
maintenance commands   ──> module manifests and package configuration
```

The typed `Operation` service is the local manuscript boundary; Review MCP exposes a smaller suggestion-only subset. Project approval, policy changes, acceptance, import, content saves and synchronization remain local actions. The requested [App control target](PLANNER/CHATGPT-FULL-CONTROL.md) excludes remote full file editing and indirect autosave. Its separately granted tools use shared Rust authority and acknowledged no-save view actions; never expose `Operation` automatically or confuse planning with runtime permissions.

`service/project_tree.rs` owns bounded local-UI directory/asset inventories and
single-directory creation through no-follow handles. These operations are
excluded from both Local CLI discovery/access and MCP; the older `files` string
list remains compatible. Explicit directory entries retain empty folders;
partial inventories report their limits and omitted non-Unicode names.
The manuscript DOM adapter renders that inventory without opening asset bytes
or flushing editor buffers. Source moves and project export use their separate
native lifecycles below; deletion remains separate work.

`service/file_move.rs` owns the closed-source transaction, exact metadata group,
durable forward recovery, source epochs, owned Git deletions and explicit bounded
receipt maintenance. `modules/frontend/file-move.js` owns persisted request
coordination and endpoint-session guards; the manuscript adapter owns its dialog
and current metadata/tree refresh. `native/tauri/` exposes only two typed main-window
commands. The controller never adopts a retained receipt as permission to replay
a producer. Generic operations, browser/CLI access and MCP gain no Move authority.

`service/file_import.rs` owns native-picker file staging, bounded owner-bound
selections, import receipts and exact raw-byte Git ownership. `native/tauri/`
captures the approved destination before opening the OS file picker and passes
selected paths directly to Rust; the renderer receives opaque metadata only.
`modules/frontend/file-import.js` owns receipt/cancellation coordination, while
the manuscript adapter owns its File/mobile dialog. The internal import
commands are excluded from `Operation`, Local CLI, browser upload and MCP.
They create new entries through no-follow handles, reserve editor targets,
preserve originals and existing metadata, and do not save/open/share sources
or choose a main document. An unresolved submitted import remains part of the
App busy guard across lost acknowledgements and dialog reopen. Check the
original request or use the explicit local inspection/cancellation barrier;
never automatically replay an uncertain creation. Receipts are bounded and
process-local; abrupt process termination is not a multi-file transaction.

`service/project_export.rs` owns immutable saved-project ZIP preparation,
bounded native-owner tickets and destination-write receipts. It copies saved
regular sources/assets, ordinary dotfiles, empty directories and opaque adjacent
review/import metadata without source saves, recovery or compilation. Runtime,
control, dependency and actual native state subtrees are excluded; pending save
journals, unsupported names, links, special files, observed changes or bounds
fail the whole preparation. The 128 MiB input and 144 MiB ZIP limits are separate.
A versioned ZIP comment records the saved main document and manifest snapshot
identity; no project file is generated or metadata adopted. This is a verified
private copy, not an atomic multi-file filesystem snapshot.

The native adapter prepares that private ZIP before requesting an OS Save
destination, using a recorded request identity before the dialog. It writes
only a new selected file outside the source project/app state, with no-clobber
publication and exact archive-byte verification. `modules/frontend/project-export.js`
retains unresolved request identities and status/cancellation barriers; the
manuscript File/mobile menu makes saved-only semantics explicit. These internal
commands use the current native owner and are absent from `Operation`, CLI,
browser upload and MCP. Two outstanding archives and 64 process-local receipts
bound resource/history use. Whole-project ZIP import remains separate work.

Local `review` and CLI `open`/`read` are no-recovery observations: they refuse
pending journals and do not adopt or persist metadata. Explicit native UI
`open` retains recovery.
`service/policy_continuity.rs` retains bounded current-Service policy witnesses;
`service/journal_ownership.rs` validates interrupted saves against explicit
approved project/path context and completes exact pending Git ownership before
journal removal. Neither observation nor sharing changes may reset missing
known review data or infer ownership for an unbound legacy ordinary journal.
Frontend App guards distinguish harmless observations from pending Open/writes,
while continuing to bind effects to editor generation, revision, navigation,
queue, conflict and IME state.

`modules/review/src/instance.rs` owns private local CLI discovery, the per-state
process lock, ephemeral API-only loopback listener and shutdown revocation.
The desktop manages that listener against its existing `Arc<Service>`; it is
separate from both the browser qualification adapter and the public MCP
listener. The local CLI permits reads and an explicit save of an already
registered live editor buffer. `service/editor.rs` owns session/owner epochs,
bounded tickets and journal-linked receipts; internal UI callbacks are absent
from CLI and MCP. The older read-only native checkpoint and newer session-save
checks have distinct evidence in [reference-evidence.md](reference-evidence.md).

`control.rs` owns the closed non-content App command/acknowledgement state;
`service/app_control.rs` owns native scope, current UI owner, grant and safe
result projection. App callbacks use a separate internal `ControlOperation`
through current-page authenticated native/browser adapters. They never expand
the local `Operation` catalogue into MCP or authorize source saves. The
Connections DOM and effect adapters are `src/connection-manager.js` and
`src/mcp-control.js`; `src/manuscript.js` supplies explicit no-save effects.

`service/pdf_exports.rs` owns the separate local PDF-export permission,
approved root identities, exact saved artifact metadata, bounded byte cache and
expiring download tickets. `service/app_control.rs` appends its closed read-only
tool; `transport.rs` mounts only the fixed PDF GET/HEAD route on the public
listener. The local consent adapter is `src/pdf-export-consent.js`, called from
the existing connection manager. It keeps transient checkbox state and never
grants native authority optimistically. PDF permission carries both expected App
and export generations; its native commit rejects stale consent requests.

`word_count.rs` extracts bounded literal Typst markup from supplied text without
evaluation, file access or compilation. `word_count_native.rs` owns the strict
current-main-owner query and one retained blocking-worker permit. The Tauri
adapter exposes only `word_count_typst_text`; Operation, CLI, HTTP and MCP do
not gain a count or source-access route. Frontend `word-count*.js` captures the
current immutable editor document/selection, counts source words and HTML prose
in a worker, and rejects stale dialog results. Counts describe a local file
snapshot and literal estimates, not evaluated or included project totals.

The authenticated local HTTP contract remains the boundary between the legacy frontend and compiler modules. Do not bypass either authority with renderer filesystem access or privileged synchronous IPC.
