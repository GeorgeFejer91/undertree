# Global project constraints

## Correctness and safety

- UnderTree is offline-first. Ordinary editing, saving, project discovery, compilation, PDF preview, and Git inspection must not require the network.
- Every filesystem path received through the local API must remain confined to an inventory-approved project root.
- Editor content is authoritative at a build boundary. Atomic save, conflict preservation, revision acceptance, and newer-edit guards must remain intact.
- A slow or failed compiler must never freeze typing, project navigation, window management, or the last good PDF preview.
- Automatic work may be coalesced, but explicit user builds, clean builds, exports, and sync actions must never be silently dropped.
- Compiler processes are external tools. Do not bundle MiKTeX, TeX Live, TeXstudio, or a full TeX distribution into the application package.

## Architecture

- `For-AI/` is Markdown-only and orchestration-only. It is not a runtime module.
- Electron's main process owns native window lifecycle and minimal IPC only. Project scanning, parsing, search fallback, archive creation, and TeX orchestration belong to the compiler/service process.
- Frontend code may optimistically reflect edits and stale previews, but only a verified backend response may mark a saved revision or PDF current.
- Slow compiler work and fast editor work use separate state machines. Never make the editor inert merely because a build is running.
- Realtime compilation is latest-state-wins: debounce bursts, allow one build at a time, and run at most one follow-up for the newest pending revision.
- Cache bounds must be explicit. Avoid unbounded watchers, canvases, logs, process output, queues, or project caches.

## Module ownership

- Frontend responsiveness and scheduling: `modules/frontend/` with browser adapters in `src/`.
- Compiler discovery, service hosting, TeX process lifecycle, and future persistent compilation: `modules/compiler/` with format assets in `layout/` and platform renderers in `native/`.
- Packaging policy, boundary validation, release verification, and developer automation: `modules/maintenance/` with command adapters in `scripts/`.
- Cross-module imports must point from an adapter to an owning module or through a documented public module file. Avoid circular ownership.

## Performance acceptance

- Measure cold startup, editor input responsiveness, edit-to-build-start latency, warm edit-to-PDF latency, peak PDF canvas memory, and packaged size separately.
- Prefer removing work, deferring work, bounded concurrency, and incremental processing before introducing another framework or language.
- A footprint improvement must not be described as a compiler-speed improvement, and a compiler-speed improvement must not be described as UI responsiveness unless typing remains independently responsive.
