# UnderTree architecture

UnderTree is an original offline workspace whose required editor appearance
and interaction behavior are near identical to the pinned open-source Overleaf
UI under [the parity requirement](For-AI/overleaf-ui-parity.md). Bounded control
panels follow the [outside-in accordion stretch standard](For-AI/ui-layout.md),
inside an original UnderTree native window frame. It does not
contain Overleaf HTML, JavaScript, images, branding, cookies, or private API
code.

## Rust/Tauri manuscript authority

The new workspace has one framework-independent Rust authority in
`modules/review/`. The Tauri v2 shell serves bundled `manuscript.html`, chooses
local project folders, and forwards typed `Operation` requests. The HTML/CSS
frontend presents sources, previews, highlights and review cards; it cannot
apply filesystem policy independently.

```text
Bundled manuscript HTML/CSS ── typed Tauri commands ──┐
Local CLI / loopback qualification adapter ──────────┤
                                                   ▼
                                      Rust review authority
                                      ├── approved project roots
                                      ├── revisioned text + JSON reviews
                                      ├── protect/reject/custom prompt rules
                                      ├── local acceptance + save journal
                                      ├── Typst compiler + last-good PDF
                                      ├── best-effort TeX import + report
                                      └── optional GitHub checkpoints
                                                   ▲
Shared manuscript IDs ── separate zrok2 MCP listener ┘
                         list / read / suggest only
```

`document.rs` validates UTF-16 source ranges, exact quoted text, revision,
prose-only scope and current policy at submission and acceptance. Typst's
syntax tree prevents agent proposals from targeting code, math or raw content;
HTML proposals must target an ordinary text run. Accepted replacement text is
escaped for the source format. Protect/reject rules deny overlapping changes;
stale protection blocks suggestions until locally resolved. Custom prompts are
passed as review constraints, with no additional operating-system authority.

Source files remain ordinary UTF-8 text. `<source>.undertree-review.json`
stores versioned rules, anchors and suggestions. A same-directory atomic
replacement and `<source>.undertree-pending.json` journal coordinate changed
source and review metadata. Conflicting external edits are rejected and an
unresolvable interrupted transaction retains both versions for local recovery.
The frontend save coordinator keeps newer edits dirty and flushes before local
acceptance, switching files or compiling.

The initial native publishing path uses pinned `typst-syntax` plus an external
Typst CLI, confines `typst compile --root` to the approved project, bounds
diagnostics/output/runtime and retains the last good PDF after failure. A full
embedded renderer is a later migration step. Native TeX import creates a new
Typst source and adjacent warning report; it preserves the original and makes
no arbitrary formatting-equivalence claim.

The opt-in zrok2 child forwards only a dedicated loopback MCP listener. The
remote catalogue has exactly three tools (`list_manuscripts`,
`read_manuscript`, `suggest_text`); it cannot invoke the local `Operation`
registry. Manuscript shares and the random capability URL are session-only.
Non-secret name/origin settings can persist without restoring access or the
tunnel on startup. Shutdown stops the child, closes the listener and revokes
shares. The URL is a
secret capability and must be kept out of commits and logs. Native process
status is explicitly distinct from verified public reachability.

GitHub operations remain local and use existing Git credentials. A bound
`owner/name` is checked against origin before each synchronization. The service
commits only its pending sources/sidecars/import reports, refuses staged or
unrelated work, fetches ancestry, permits a clean fast-forward, avoids force
pushes and confirms the pushed branch head. Automatic checkpoints are opt-in
and scheduled separately from typing; live network qualification remains a
separate check.

Tauri capabilities allow the two local commands and core window facilities,
with no remote origins or generic shell/filesystem plugin. The CSP confines
the UI and isolates HTML previews. The local CLI/browser adapter uses a
separate loopback token and shares this Rust authority; it is not the agent
endpoint. Linux debug execution, browser qualification, live ChatGPT/zrok and
packaged platform execution have distinct evidence requirements.

## Retained compatibility process model

UnderTree uses the same authenticated localhost boundary on both platforms, but
the native shell differs. Linux uses GTK/WebKitGTK. Windows uses Electron and
keeps the service in a dedicated utility process so compiler and filesystem
work never shares the native window process event loop.

```text
Native UnderTree window
        (GTK/WebKitGTK on Linux; Electron renderer on Windows)
        (bundled HTML/CSS/CodeMirror/PDF.js)
                    │ localhost HTTP + authenticated JSON
                    ▼
Node service on 127.0.0.1:37371
        (independent service process on Linux;
         Electron utility process on Windows)
        ├── canonical project inventory and icons
        ├── atomic, project-root-confined text saves
        ├── tex-sync / latexmk builds
        ├── validated HTML print-profile fitting and export
        ├── isolated read-only WebKitGTK print renderer
        ├── guarded Codex formatting recovery after failed TeX builds
        ├── generated PDF streaming
        ├── local full-project text search
        ├── read-only Git status
        ├── explicit safe pull/push bridge actions
        └── project-aware desktop file opening
```

## Modular ownership

- `For-AI/` is a Markdown-only Codex orchestration layer containing global
  constraints, the module map, and change workflows. It is never packaged.
- `modules/frontend/` owns browser-safe scheduling and responsiveness logic;
  `src/` is its DOM/API adapter and established frontend asset root.
- `modules/review/` owns the new Rust manuscript/review, Typst publication,
  native TeX import, narrow MCP authority and GitHub checkpoint service.
- `native/tauri/` owns the Tauri v2 window, least-privilege command adapter,
  native folder picker and desktop packaging configuration.
- `modules/compiler/` owns compiler discovery and service-process entry points;
  `server.mjs`, `layout/`, and platform renderers are its established adapters
  and format assets.
- `modules/maintenance/` owns architecture validation and runtime packaging
  policy; `scripts/`, `packaging/`, and `.github/` remain platform-facing
  maintenance adapters.

The retained frontend and compiler communicate only through the authenticated local HTTP
contract. Electron's main process owns window lifecycle and native dialogs, not
project scanning, parsing, search, ZIP creation, or TeX orchestration.

## Responsive compilation model

Fast editor state and slow compiler state are deliberately separate. Input is
never disabled for an ordinary build. A 450 ms latest-state scheduler coalesces
an edit burst, permits one build at a time, and retains exactly one newest
follow-up request when edits arrive during compilation. The build request still
carries an exact editor snapshot, and the revision acceptance guard prevents an
older build response from marking newer text clean. The previous complete PDF
remains visible and stale until a replacement has compiled and rendered.

The systemd user service keeps the local API available without internet. The
desktop launcher starts an independent GTK application backed by the operating
system's WebKitGTK runtime. Brave and the user's ordinary browser session are
not involved. A single-instance application identity raises the existing
UnderTree window when it is launched again.

## Security boundary

- The service binds only to `127.0.0.1`.
- The native shell permits in-app navigation only to the localhost origin and
  delegates external links to the operating system.
- The WebKit context is ephemeral, so the bootstrap cookie is not kept in a
  general-purpose browser profile.
- A random user-only token bootstraps an `HttpOnly`, `SameSite=Strict` cookie.
- Mutating APIs require same-origin JSON requests.
- Every path is resolved below an inventory-approved project root.
- Print-profile HTML is served to an ephemeral WebKit view from a separate
  read-only loopback origin. Its CSP blocks remote resources and arbitrary
  document JavaScript; asset requests remain confined to the project.
- Traversal, absolute paths, outside-project symlinks, oversized text, and
  unsupported binary editing are rejected.
- Saves use a same-directory temporary file and atomic rename, with modification
  time conflict detection. A per-tab revision coordinator serializes overlapping
  saves and keeps later edits dirty; every build passes a flush barrier that
  persists the newest editor revision before compilation can begin. Editor
  callbacks are path-bound, and the build endpoint receives the exact buffer and
  verifies/saves it immediately before invoking LaTeX. A missing open source is
  recreated from its editor buffer. Concurrent disk contents are archived under
  private application state before the editor-authoritative version replaces
  them, so automatic reconciliation never discards either side.
- Sync uses existing repository protocols and never force-pushes.
- Codex recovery is never driven by browser navigation. The authenticated build
  endpoint uses the pinned official Codex SDK, which starts its version-matched
  local runtime without a shell and streams structured task events. It passes a
  bounded compiler excerpt, confines the task to the inventory project, disables
  network/web search, and uses workspace-write/never-approve execution. Identical
  failures are deduplicated, failed launches can be retried immediately,
  concurrency is capped, diagnostics focus on the first fatal error, and the
  verification build cannot recursively invoke another recovery. One failed
  verification may resume the same private task once with the new diagnostic.
- Both attempts use the low-latency `gpt-5.6-luna` model with low reasoning.
  Each job receives an isolated temporary Codex home linked only to the user's
  existing authentication and model cache. UnderTree never opens or focuses the
  Codex desktop app, removes the temporary task after completion, and removes
  routine success logs. Diagnostics for unresolved/rejected repairs remain
  user-private state outside every project repository.
- The selected source is protected from editor-API writes during recovery. A
  visible-text signature is checked before compilation; a candidate that changes
  document words is retained privately for inspection while the exact original
  source is restored. Selecting any `.tex` source reuses its matching project-local
  PDF, including a visibly marked stale build, and creates one only when none has
  been compiled yet; automatic recovery runs only after that exact source fails
  compilation.
- Canonical print-profile HTML is parsed and validated before rendering. The
  bundled Pretext runtime proposes bounded font, leading, and gap values, while
  final DOM scroll dimensions remain authoritative. A captured browser-layout
  manifest drives generated absolute-geometry LuaLaTeX; the generated file is a
  disposable companion carrying the HTML and separate browser-PDF hashes, never
  a second source of truth. It reconstructs selectable text, links, assets, and
  TikZ geometry without embedding the full browser page.

## Clean-room UI mapping

Visual and interaction parity are mandatory and remain unqualified. The
measurements below are historical observations, not the acceptance baseline;
use the pinned reference and matched-state checks in
[overleaf-ui-parity.md](For-AI/overleaf-ui-parity.md).

The earlier live reference was used only to measure observable behavior: a 40 px dark
top bar, icon rail and file tree on the left, syntax editor in the middle,
Recompile/PDF/log tools on the right, draggable dividers, compact 4 px controls,
pill-shaped primary actions, and a dark green/charcoal palette. All source in
this package was independently written for the local workflow.

The new review workflow was also informed by focused public Overleaf source
inspection at `e039ad26c5bf5422eb57b89fc7e57c75055e631d`. The observed card,
selection and permission concepts were independently implemented; no Overleaf
source or assets were copied. See [the reference ledger](For-AI/reference-evidence.md)
for inspected source paths, evidence scope and qualification gaps.
