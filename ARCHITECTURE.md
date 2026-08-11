# UnderTree architecture

UnderTree is an original offline workspace inspired by the visible
left-editor-preview interaction model of online LaTeX editors. It does not
contain Overleaf HTML, JavaScript, images, branding, cookies, or private API
code.

## Process model

```text
Native UnderTree GTK/WebKit window
        (bundled HTML/CSS/CodeMirror/PDF.js)
                    │ localhost HTTP + authenticated JSON
                    ▼
Node standard-library service on 127.0.0.1:37371
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

The live reference was used only to measure observable behavior: a 40 px dark
top bar, icon rail and file tree on the left, syntax editor in the middle,
Recompile/PDF/log tools on the right, draggable dividers, compact 4 px controls,
pill-shaped primary actions, and a dark green/charcoal palette. All source in
this package was independently written for the local workflow.
