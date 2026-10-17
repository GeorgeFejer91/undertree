# Global project constraints

## Product interface

- wrAIter's Word/LibreOffice identity, native window icons and GitHub/download/installer materials use the approved shared logo under [the branding protocol](PROTOCOLS/branding.md). Retain meaningful action and system icons, native layout and independent UnderTree branding.
- UnderTree's editor workspace must outwardly look and feel near identical to the pinned open-source Overleaf UI. Similarity or general inspiration is insufficient; follow [overleaf-ui-parity.md](overleaf-ui-parity.md) and qualify appearance and interactions before claiming completion.
- Outside-in geometry, accordion stretch and overflow prevention are standard for bounded control panels under [ui-layout.md](ui-layout.md). The user separately requires an original UnderTree window boundary with custom Close and Minimize icons; preserve workspace parity within that frame.

## Correctness and safety

- UnderTree, wrAIter for LibreOffice Writer and wrAIter for Microsoft Word are equal delivery targets under [the shared selective AI editing contract](product-goal.md#three-deliverables-one-selective-ai-editing-contract). All three require the same selective-editor controls, prompts, toggles and permission behavior, and independently installable packages. Each requires its own implementation and qualification.
- UnderTree is offline-first. Ordinary editing, saving, project discovery, compilation, PDF preview, and Git inspection must not require the network.
- The Rust/Tauri workspace supports both Typst and direct LaTeX publication under the user's 2026-10-17 goal. Typst editing/compilation must still run without a LaTeX engine. Optional LaTeX uses a confined native compiler worker and prepared offline resources; it must not replace the source with an implicit Typst conversion.
- MCP **Review** defaults to suggestions. User direction on 2026-10-17 permits the existing `suggest_text` tool to apply wording only when current local prompt markers fully authorize direct edits. Protect/reject, stale policy, exact quote/revision and registered-editor guards still apply. Remote policy changes, general file/tree mutation, local-save dispatch and Git synchronization remain excluded. Separate **App controls** stay non-content; follow [the plan](PLANNER/CHATGPT-FULL-CONTROL.md) and [the connection contract](PROTOCOLS/connections.md).
- Colors are presentation and user-owned policy keys. The required color-only `highlight_text` action may create neutral marks, including over unmarked text, but no function, prompt or editing permission. Only a local user may assign rules; neutral marks never authorize suggestions/direct edits. Follow [the highlighting contract](PROTOCOLS/connections.md#ai-highlighting-and-immutable-protected-passages).
- Protection has highest priority. Protected text is immutable, while separate intact protected units may move within a user-authorized enclosing rewrite under the native preservation contract above. A continuous protected highlight remains one indivisible unit. Deny edits that lose/change/split units, bypass coverage or cannot prove preservation; keep conservative overlap refusal until that host supports the proof. Stale protection fails closed. Custom prompts cannot expand remote authority.
- Required by the user on 2026-10-17: retrieve complete manuscript context before proposing changes, while restricting both suggestions and direct edits to fully highlighted source ranges. Unhighlighted text is context only. Follow the snapshot, sharing, prior-read enforcement and qualification requirements in [the connection contract](PROTOCOLS/connections.md#full-manuscript-context-and-highlighted-only-changes); this is a new requirement, not a claim of existing runtime enforcement.
- Recheck source revision, exact quote, prose range and current protection at proposal submission and local acceptance. Never accept a stale suggestion through a UI-only check.
- Typst and HTML are portable text sources. Keep review metadata in versioned adjacent JSON; preserve unknown or corrupt metadata and external edits instead of silently resetting them.
- Every filesystem path received through the local API must remain confined to an inventory-approved project root.
- Editor content is authoritative at a build boundary. Atomic save, conflict preservation, revision acceptance, and newer-edit guards must remain intact.
- A slow or failed compiler must never freeze typing, project navigation, window management, or the last good PDF preview.
- Automatic work may be coalesced, but explicit user builds, clean builds, exports, and sync actions must never be silently dropped.
- Compiler processes are external tools. Do not bundle MiKTeX, TeX Live, TeXstudio, or a full TeX distribution into the application package.

## Architecture

- `modules/word/` owns the user-requested native Windows Word add-in as one
  installer. Native COM/.NET host integration is a target-specific adapter, not
  a migration of UnderTree's Rust/Tauri stack or Writer's UNO integration. Word
  owns document changes and never saves them through MCP. Its independent
  connection profile, local sharing consent and bundled tunnel child cannot
  adopt another target's credentials, live reservation or document grants.

- The final product stack is Rust, Tauri v2 and HTML/CSS, with Typst and the explicitly requested optional LaTeX publishing path. Preserve the native architecture and Typst's independent operation. Do not introduce Electron, its dependencies or its packaging into development or release work. Obsolete Electron sources and packaging have been removed; retain historical evidence in documentation and Git history.
- `For-AI/` is Markdown-only and orchestration-only. It is not a runtime module.
- `modules/libreoffice/` owns wrAIter, the separately installable Writer extension, preferably an `.oxt` add-on to an existing suite. Native UNO owns document/range mutations and local permissions. wrAIter must own its persisted private MCP/zrok bridge without depending on UnderTree programs, processes or runtime files. Optional local URL pairing in either direction retains the target editor's authority. Remembered connection intent must not restore document sharing. Required full-document context and highlighted-only changes follow the same contract as UnderTree. LibreOffice itself is an external installed suite, never vendored or rebuilt here by default. UnderTree's Rust/Tauri stack does not require replacing Writer's native host.
- The new Tauri shell owns window lifecycle, native folder selection and thin typed IPC. `modules/review/` owns manuscript/review policy, persistence, Typst process supervision, TeX import, Git checkpoints and the closed MCP service. Neither the WebView nor the MCP transport is a second authority.
- Windows and other native platform delivery use the same Rust/Tauri architecture. Existing TeX and HTML compatibility modules may supply format behavior without replacing the native shell or authority.
- Frontend code may optimistically reflect edits and stale previews, but only a verified backend response may mark a saved revision or PDF current.
- Slow compiler work and fast editor work use separate state machines. Never make the editor inert merely because a build is running.
- Realtime compilation is latest-state-wins: debounce bursts, allow one build at a time, and run at most one follow-up for the newest pending revision.
- Cache bounds must be explicit. Avoid unbounded watchers, canvases, logs, process output, queues, or project caches.
- Tunnel activation and manuscript sharing are separate opt-ins. Grants are session-only; stopping the tunnel revokes them. Extend the closed native Review catalogue (`list_manuscripts`, `read_manuscript`, `suggest_text`) only with the required color-only `highlight_text` action. Explicit local pairing may add bounded frozen aliases for another editor's permitted native Review tools under [the connection contract](PROTOCOLS/connections.md). Non-content App controls require a separate authenticated capability and explicit named actions; never expose a generic CLI, shell, arbitrary API/path proxy or the local operation registry automatically. Build only saved snapshots remotely, and deny navigation/Close that would save or discard a buffer.
- Later explicit Writer direction adds separately granted `project_*` and `github_*` scopes inside its single add-on, as specified in [Explicit Writer project access](PROTOCOLS/connections.md#explicit-writer-project-access). They never expand Review, pairing, open-document writes or remote permission management. Folder selection and GitHub credentials may be remembered; their grants must remain off after restart.
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
