# Codex orchestration layer

This directory exists only for Codex and other repository-aware coding agents. It contains project-wide constraints, ownership boundaries, and change workflows. It must remain Markdown-only and must never be imported, packaged, or read by the UnderTree application at runtime.

Read in this order:

1. `constraints.md` for invariants that every change must preserve.
2. `module-map.md` to identify the owning runtime module.
3. `workflows.md` for the required implementation and verification sequence.

For any UI, text-editing surface, typography, responsive layout or icon change, also read [ui-layout.md](ui-layout.md). It owns the standing bounded Pretext font-to-CSS-box and SVG-centering rule; do not duplicate that policy in further files.

Use [Ponytail's actual skill](https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail/SKILL.md) for implementation, fixes, refactors and review. Load it through the existing skill mechanism or read and apply the upstream instructions; do not add a skill manager. Reuse current code and platform capabilities without removing correctness, accessibility or editor-state safeguards.

All application code and assets live outside `For-AI/`. The executable module roots are `modules/frontend/`, `modules/compiler/`, and `modules/maintenance/`; the existing `src/`, `layout/`, `native/`, and `scripts/` directories are adapters or established asset roots assigned in `module-map.md`.

## HTML UI skill route

For new or changed text-bearing HTML/CSS interfaces, load the installed `uncodixfy-pretext` skill ([source](https://github.com/GeorgeFejer91/uncodixfy-pretext/blob/main/SKILL.md)) and its Pretext reference. It nests `ponytail` and the original Uncodixfy visual discipline. Preserve this project's established design and stack; implement real `@chenglou/pretext` measurement for bounded text in the touched UI, not a CSS-only or test-only substitute. Design box geometry first, then handle measured no-fit with readable reflow, space, or an accessible full-value route. Verify the rendered target at narrow widths, 320 CSS px reflow, 200% text/zoom, and long or localized strings. This route does not claim existing UI has already been migrated or qualified.
