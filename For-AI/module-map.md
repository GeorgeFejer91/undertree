# Module map

| Module | Owns | Existing adapters/assets | Must not own |
| --- | --- | --- | --- |
| `modules/frontend/` | realtime scheduling, review/save coordination, interaction state, browser-only performance policy | `src/main.js`, `src/styles.css`, `index.html`, `src/manuscript.js`, `src/manuscript.css`, `manuscript.html` | native policy, compiler executable discovery, release scripts, native binaries |
| `modules/compiler/` | local service process, compiler toolchain discovery, TeX job lifecycle, build coalescing interfaces | `server.mjs`, `layout/`, `native/html_print_renderer.py`, compiler-facing helpers in `src/` | Electron window lifecycle, installer policy, UI DOM code |
| `modules/maintenance/` | architecture validation, runtime-package allowlists, release and test policy | `scripts/`, `packaging/`, `.github/` | application request handling or editor behavior |
| `native/windows/` | Electron window adapter and native dialogs | `main.cjs`, `preload.cjs`, installer integration | compiler implementation or project scanning |
| `modules/review/` | Rust manuscript/review authority, project approvals, revision checks, sidecar persistence, narrow MCP tools, Typst process/PDF handling, best-effort TeX import, GitHub checkpoints; future explicitly granted Full control actions | `modules/frontend/review-*`, `src/manuscript.js`, `manuscript.html`, local review CLI/browser adapter | generic remote filesystem/shell proxies, Review-mode agent acceptance, TeX requirements |
| `native/tauri/` | Tauri window lifecycle, least-privilege commands, native folder selection, packaging | Rust review service and bundled HTML frontend | domain policy in the WebView, privileges for remote content |

## Dependency direction

Connection ownership: `modules/review/src/transport.rs` owns zrok2 supervision, the separate MCP listener, URL capability and observed MCP activity; `service.rs` owns approved shares and non-secret setup persistence. `src/connection-manager.js` is the dialog DOM adapter; it uses `modules/frontend/review-api.js` and never talks to zrok or the MCP endpoint directly. `manuscript.html` and `src/manuscript.css` own the popup structure/geometry. This is the Rust/Tauri manuscript path; legacy Node/GTK/Electron TeX editors retain their current services.

```text
Tauri window adapter   ──> Rust review service <── local CLI/test adapter
review HTML adapter    ──> frontend save/review coordinator ──> typed Tauri IPC
opt-in zrok2 MCP        ──> closed Rust remote tools ──> review service
native/window adapter ──> compiler service process
frontend adapter       ──> frontend scheduling module ──> authenticated local API
compiler service       ──> compiler module + layout/render assets
maintenance commands   ──> module manifests and package configuration
```

The typed `Operation` service is the new local manuscript boundary; the implemented MCP catalogue exposes a smaller suggestion-only subset. The loopback HTTP review adapter exists for the local CLI and browser qualification. Project approval, policy changes, acceptance, import, Git and tunnel activation are currently local actions. The requested [Full control target](PLANNER/CHATGPT-FULL-CONTROL.md) plans explicit authenticated tools for those product functions and UI actions, with a shared authority and a separate grant; do not expose `Operation` automatically or confuse the plan with current runtime permissions.

The authenticated local HTTP contract remains the boundary between the legacy frontend and compiler modules. Do not bypass either authority with renderer filesystem access or privileged synchronous IPC.
