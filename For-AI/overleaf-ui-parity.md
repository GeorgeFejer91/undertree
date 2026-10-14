# Mandatory Overleaf UI parity

User requirement, clarified 2026-10-14: **UnderTree must outwardly look and feel near identical to the open-source Overleaf editor, so an experienced user feels as though they are using the same software.** General inspiration, matching colors alone or a similar pane arrangement is insufficient. This supersedes earlier descriptions of the target as merely "Overleaf-like" or "inspired by Overleaf".

This applies to the active Rust/Tauri manuscript workspace and retained user-facing editor surfaces during migration. It is a product acceptance requirement, not a claim about the current implementation. UnderTree keeps its own identity; the user explicitly requests an original native window boundary with custom Close/X and Minimize icons. The workspace inside that frame retains the parity requirement.

## Reference baseline

Use the [open-source Overleaf repository](https://github.com/overleaf/overleaf/tree/e039ad26c5bf5422eb57b89fc7e57c75055e631d) at the inspected commit `e039ad26c5bf5422eb57b89fc7e57c75055e631d` as the starting source baseline. Record the running open-source edition/configuration, build identity, theme, fonts, locale, viewport, scale, content fixture and enabled features before comparative qualification. An intentional baseline update must record the replacement commit and refresh reference captures; do not silently chase upstream main.

Compare the editor workspace of the open-source software. Public-source review components can guide UnderTree's review additions; their presence in a source tree does not prove they are enabled in every open-source deployment. Record which surfaces were actually rendered. Marketing pages, premium-only screenshots and a guessed composite design cannot substitute for this reference.

The existing evidence ledger covers focused review source inspection. It does not yet contain a complete rendered editor baseline or proof of visual/interaction parity. Preserve that distinction and the existing independent implementation/license boundary.

## Required appearance and interaction

- Match the project header, menus, toolbar, navigation rail, hierarchical file tree, editor, preview, review surfaces and pane dividers: placement, default proportions, spacing, sizing, typography, colors, borders, icons, labels and hover/focus/selected/disabled/error states.
- Match familiar supported workflows: project/file navigation, tree expansion, menus, source selection and search, pane dragging/collapse, recompilation, PDF navigation/zoom/download, diagnostics and review navigation/decisions. Preserve caret, selection, scroll, undo/redo and IME behavior through pane and file changes.
- Fit Typst, passage policies, ChatGPT connections and local Git controls into the reference's existing hierarchy and styling. Additional capabilities must not turn the main workspace into a separate dashboard or permanently displace the familiar editing/preview arrangement.
- Use the mandatory [outside-in accordion stretch and overflow prevention policy](ui-layout.md) for finite bounded controls. Stretch is responsive geometry within the familiar interface, not permission to introduce a different visual language. Use real Pretext measurement and rendered bounds checks.
- Give the native window an original visible UnderTree boundary and custom SVG Close/X and Minimize buttons with centered icon slots, accessible names, focus states and usable hit areas. Keep window dragging separate from interactive controls. Native buttons must perform the named action and must not appear as dead controls in browser mode. Custom and OS close requests must flush pending edits and leave the window/buffer intact on save failure or unresolved conflicts.
- Preserve offline editing, Rust policy/acceptance authority, suggestion-only remote agents, save/revision/conflict guards, responsive typing during compilation and the last good preview. Shared visual conventions do not grant unsupported operations or expand remote authority.

## Acceptance gate

1. Capture paired reference/UnderTree states with matching content, viewport, fonts, theme and scale: initial project, selected file, editing, open menus/dialogs, resized/collapsed panes, compilation in progress, successful preview, compile error and review states available in the reference.
2. Compare full-workspace captures and component crops/overlays. Check both visual metrics and the actual interactions above. List every visible or behavioral deviation with its cause and resolution; broad similarity or an unexamined screenshot score does not pass the requirement.
3. Exercise width and height independently, including narrow/tall and wide/short panels, supported minima, expanded sizes, breakpoint edges and regrowth. Include 320 CSS px reflow, 200% text/zoom, long/localized strings, keyboard operation and text-spacing overrides. Preserve accessibility; record necessary reflow differences rather than hiding overflow or counteracting zoom.
4. Verify custom and OS Close, Minimize/restore, dragging and keyboard activation in the actual Tauri window, including dirty buffers, pending saves, unresolved conflicts and save failures. Failed close must preserve the buffer and keep the window open. Verify window-control absence in browser mode. A browser mock does not qualify native integration.
5. Store generated captures/reports outside `For-AI/`; add source identities, exercised workflows, results and unresolved deviations to [reference-evidence.md](reference-evidence.md). Mark parity complete only when comparative evidence supports it; ordinary build, reflow and functional smoke success alone is insufficient.

## Agent coordination and current handoff

Every UI worker reads this requirement and [ui-layout.md](ui-layout.md) before changing a surface. DOM and style adapters belong in `manuscript.html`, `src/manuscript.*` or the existing legacy adapters; reusable interaction state belongs in `modules/frontend/`; native frame configuration and least-privilege window capabilities belong in `native/tauri/`. Rust manuscript authority stays in `modules/review/`. Coordinate shared manifests/capabilities and acceptance fixtures before integration.

Two agents reviewed the requirement and current sources on 2026-10-14. Source-observed gaps to carry into implementation: a custom fixed four-column manuscript shell; flat file buttons; missing draggable/collapsible panes; Recompile outside the preview toolbar; missing PDF page/zoom/log controls with rendering capped at six pages; review cards without source-position/anchor layout or overview; and CodeMirror state recreated on file switches. These are an implementation handoff, not a rendered comparison. Reuse suitable legacy frontend primitives, then qualify them against the pinned reference.
