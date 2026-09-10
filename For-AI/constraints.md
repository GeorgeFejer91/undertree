# Repository constraints

- Keep ordinary editing and preview fully offline. Do not add a runtime dependency on a Typst CLI, Node.js, Electron, TeX, or a network service.
- Rust owns filesystem authorization, compilation policy, validation, and persistence. Frontend checks are usability checks, not security boundaries.
- A native user choice, exact remembered selection, or explicit product-CLI `--project` argument must establish the project root. Canonicalize every imported or opened path and reject escapes, symlinks, package imports, and extra roots.
- Compile the exact editor snapshot for the active document. Never require an autosave before preview.
- Preserve atomic-save behavior, SHA-256 conflict detection, and `.undertree/conflicts/` recovery copies.
- Guard compile and save results by editor revision so stale native responses cannot overwrite current UI state.
- Never run Typst work on an async/UI event path. Preserve debounce and latest-state-wins scheduling.
- Do not expose shell, network, generic filesystem, remote-content, or unrestricted plugin authority to the WebView.
- Direct CLI mutations must use the normal approved project state and exclusive lease. Running-editor commands must execute through the current owner and never bypass its editor, revision, save, compiler, conversion, Git, or GitHub guards.
- Keep running-instance control typed, bounded, authenticated, and user-local over loopback. The endpoint capability remains native-side in the per-user application configuration directory; never expose it through the WebView, output, logs, command options, or project files.
- Live source replacement requires the exact current editor revision. Project/document navigation and quit must preserve dirty work unless the caller explicitly opts into discard; a timeout after claim has an unknown outcome and must not trigger an automatic retry of a mutation.
- Keep explicit source, resource, inventory, page, and SVG-output bounds.
- Render generated SVG only through Blob-backed image elements. Do not inject compiler output as HTML.
- Preserve the checkpoint visual layout exactly: top bar, activity rail, split file/outline sidebar, editor/preview proportions, toolbars, resizers, colors, spacing, and responsive breakpoints. Verify layout changes against the checkpoint screenshot.
- Use accessible vector chevrons for disclosure, dropdown, and directional controls. Never substitute text glyphs such as `⌄`, `›`, or `‹` for chevron icons.
- `For-AI/` is Markdown-only orchestration guidance and is never a runtime or generated-output location.
