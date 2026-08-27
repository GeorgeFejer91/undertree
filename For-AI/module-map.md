# Module map

| Module | Owns | Existing adapters/assets | Must not own |
| --- | --- | --- | --- |
| `modules/frontend/` | realtime scheduling, interaction state, browser-only performance policy | `src/main.js`, `src/styles.css`, `index.html`, frontend helpers in `src/` | TeX executable discovery, release scripts, native binaries |
| `modules/compiler/` | local service process, compiler toolchain discovery, TeX job lifecycle, build coalescing interfaces | `server.mjs`, `layout/`, `native/html_print_renderer.py`, compiler-facing helpers in `src/` | Electron window lifecycle, installer policy, UI DOM code |
| `modules/maintenance/` | architecture validation, runtime-package allowlists, release and test policy | `scripts/`, `packaging/`, `.github/` | application request handling or editor behavior |
| `native/windows/` | Electron window adapter and native dialogs | `main.cjs`, `preload.cjs`, installer integration | compiler implementation or project scanning |

## Dependency direction

```text
native/window adapter ──> compiler service process
frontend adapter       ──> frontend scheduling module ──> authenticated local API
compiler service       ──> compiler module + layout/render assets
maintenance commands   ──> module manifests and package configuration
```

The local HTTP contract is the boundary between frontend and compiler modules. Do not bypass it with renderer filesystem access or privileged synchronous IPC.
