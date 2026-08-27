# Repository constraints

- Keep ordinary editing and preview fully offline. Do not add a runtime dependency on a Typst CLI, Node.js, Electron, TeX, or a network service.
- Rust owns filesystem authorization, compilation policy, validation, and persistence. Frontend checks are usability checks, not security boundaries.
- A native user choice must establish the project root. Canonicalize every imported or opened path and reject escapes, symlinks, package imports, and extra roots.
- Compile the exact editor snapshot for the active document. Never require an autosave before preview.
- Preserve atomic-save behavior, SHA-256 conflict detection, and `.undertree/conflicts/` recovery copies.
- Guard compile and save results by editor revision so stale native responses cannot overwrite current UI state.
- Never run Typst work on an async/UI event path. Preserve debounce and latest-state-wins scheduling.
- Do not expose shell, network, generic filesystem, remote-content, or unrestricted plugin authority to the WebView.
- Keep explicit source, resource, inventory, page, and SVG-output bounds.
- Render generated SVG only through Blob-backed image elements. Do not inject compiler output as HTML.
- Preserve the checkpoint visual layout exactly: top bar, activity rail, split file/outline sidebar, editor/preview proportions, toolbars, resizers, colors, spacing, and responsive breakpoints. Verify layout changes against the checkpoint screenshot.
- `For-AI/` is Markdown-only orchestration guidance and is never a runtime or generated-output location.
