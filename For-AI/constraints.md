# Global project constraints

## Product interface

- UnderTree's editor workspace must outwardly look and feel near identical to the pinned open-source Overleaf UI. Similarity or general inspiration is insufficient; follow [overleaf-ui-parity.md](overleaf-ui-parity.md) and qualify appearance and interactions before claiming completion.
- Outside-in geometry, accordion stretch and overflow prevention are standard for bounded control panels under [ui-layout.md](ui-layout.md). The user separately requires an original UnderTree window boundary with custom Close and Minimize icons; preserve workspace parity within that frame.

## Correctness and safety

- UnderTree is offline-first. Ordinary editing, saving, project discovery, compilation, PDF preview, and Git inspection must not require the network.
- The new Rust/Tauri review workspace must run without LaTeX. Typst is the long-term publishing engine; existing TeX paths are compatibility adapters.
- MCP **Review** mode has suggestion-only authority: it cannot accept edits, change policies or synchronize Git. The latest user correction allows separate authenticated **App controls** but prohibits full editing of files; follow [the plan](PLANNER/CHATGPT-FULL-CONTROL.md). Remote source/tree mutation, local-save dispatch, policy changes and indirect autosave are excluded. Rust enforces the current grant and revision/session guards in either mode.
- Colors are presentation and user-owned policy keys. Protect/reject actions deny overlapping agent proposals; custom prompts describe the requested wording but cannot expand remote authority. A stale protection marker blocks new proposals until resolved locally.
- Recheck source revision, exact quote, prose range and current protection at proposal submission and local acceptance. Never accept a stale suggestion through a UI-only check.
- Typst and HTML are portable text sources. Keep review metadata in versioned adjacent JSON; preserve unknown or corrupt metadata and external edits instead of silently resetting them.
- Every filesystem path received through the local API must remain confined to an inventory-approved project root.
- Editor content is authoritative at a build boundary. Atomic save, conflict preservation, revision acceptance, and newer-edit guards must remain intact.
- A slow or failed compiler must never freeze typing, project navigation, window management, or the last good PDF preview.
- Automatic work may be coalesced, but explicit user builds, clean builds, exports, and sync actions must never be silently dropped.
- Compiler processes are external tools. Do not bundle MiKTeX, TeX Live, TeXstudio, or a full TeX distribution into the application package.

## Architecture

- The final product stack is Rust, Tauri v2, HTML/CSS and Typst. This is a fixed user requirement, reaffirmed on 2026-10-15. Do not introduce Electron, its dependencies or its packaging into development or release work. Obsolete Electron sources and packaging have been removed; retain historical evidence in documentation and Git history.
- `For-AI/` is Markdown-only and orchestration-only. It is not a runtime module.
- The new Tauri shell owns window lifecycle, native folder selection and thin typed IPC. `modules/review/` owns manuscript/review policy, persistence, Typst process supervision, TeX import, Git checkpoints and the closed MCP service. Neither the WebView nor the MCP transport is a second authority.
- Windows and other native platform delivery use the same Rust/Tauri architecture. Existing TeX and HTML compatibility modules may supply format behavior without replacing the native shell or authority.
- Frontend code may optimistically reflect edits and stale previews, but only a verified backend response may mark a saved revision or PDF current.
- Slow compiler work and fast editor work use separate state machines. Never make the editor inert merely because a build is running.
- Realtime compilation is latest-state-wins: debounce bursts, allow one build at a time, and run at most one follow-up for the newest pending revision.
- Cache bounds must be explicit. Avoid unbounded watchers, canvases, logs, process output, queues, or project caches.
- Tunnel activation and manuscript sharing are separate opt-ins. Grants are session-only; stopping the tunnel revokes them. The Review catalogue remains exactly `list_manuscripts`, `read_manuscript`, and `suggest_text`. Non-content App controls require a separate authenticated capability and explicit named actions; never expose a generic CLI, shell, arbitrary API/path proxy or the local operation registry automatically. Build only saved snapshots remotely, and deny navigation/Close that would save or discard a buffer.
- TeX import is a native best-effort conversion into a new `.typ` file and an adjacent report. Keep the original `.tex`; unsupported math, macros and layout must be reported. Do not claim arbitrary TeX formatting equivalence.
- Optional GitHub autosync uses the selected project's existing identity and credentials, checkpoints only UnderTree-owned pending files, verifies the remote head, and stops on unrelated/staged changes or divergence. Never force-push or silently retarget an existing origin.

## Module ownership

- Frontend responsiveness and scheduling: `modules/frontend/` with browser adapters in `src/`.
- Manuscript/review, Typst publication, native TeX import, Git checkpoints and narrow MCP authority: `modules/review/` with the Tauri adapter in `native/tauri/`.
- Compiler discovery, service hosting, TeX process lifecycle, and future persistent compilation: `modules/compiler/` with format assets in `layout/` and platform renderers in `native/`.
- Packaging policy, boundary validation, release verification, and developer automation: `modules/maintenance/` with command adapters in `scripts/`.
- Cross-module imports must point from an adapter to an owning module or through a documented public module file. Avoid circular ownership.

## Performance acceptance

- Measure cold startup, editor input responsiveness, edit-to-build-start latency, warm edit-to-PDF latency, peak PDF canvas memory, and packaged size separately.
- Prefer removing work, deferring work, bounded concurrency, and incremental processing before introducing another framework or language.
- A footprint improvement must not be described as a compiler-speed improvement, and a compiler-speed improvement must not be described as UI responsiveness unless typing remains independently responsive.
