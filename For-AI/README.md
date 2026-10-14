# Codex orchestration layer

This directory exists only for Codex and other repository-aware coding agents. It contains project-wide constraints, ownership boundaries, and change workflows. It must remain Markdown-only and must never be imported, packaged, or read by the UnderTree application at runtime.

Read in this order:

1. `constraints.md` for invariants that every change must preserve.
2. `module-map.md` to identify the owning runtime module.
3. `workflows.md` for the required implementation and verification sequence.

Then read [product-goal.md](product-goal.md) for the active Rust/Tauri/HTML and Typst goal, [skills.md](skills.md) for installed skill routes and provenance, and [reference-evidence.md](reference-evidence.md) before making claims about Overleaf, Secret Tunnel, publication, or end-to-end qualification.

For any UI, text-editing surface, typography, responsive layout or icon change, also read [overleaf-ui-parity.md](overleaf-ui-parity.md) for mandatory Overleaf appearance/interaction parity and the original UnderTree window frame, then [ui-layout.md](ui-layout.md) for the mandatory outside-in accordion stretch, overflow prevention, bounded Pretext and SVG-centering rules. These files own their respective policies; do not duplicate them in further files.

For ChatGPT, zrok or MCP work, read [the connection protocol](PROTOCOLS/connections.md) and [the Secret Tunnel analysis](BOARD/2026-10-14-secret-tunnel.md). They adapt Secret Tunnel's relevant protocol, skill-routing and evidence structures to UnderTree's narrower review authority. Keep runtime code and settings outside this directory.

The user's latest direction expands the target to **all UnderTree functions controlled through ChatGPT chat**, including CLI capabilities, direct authoring, review decisions, settings, synchronization and workspace controls. Read [the Full control implementation plan](PLANNER/CHATGPT-FULL-CONTROL.md). It records the requested target and migration order; the runtime still exposes only the current three review tools until the corresponding authenticated actions and gates are implemented.

Use [Ponytail's actual skill](https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail/SKILL.md) for implementation, fixes, refactors and review. Load it through the existing skill mechanism or read and apply the upstream instructions; do not add a skill manager. Reuse current code and platform capabilities without removing correctness, accessibility or editor-state safeguards.

All application code and assets live outside `For-AI/`. The executable module roots are `modules/frontend/`, `modules/review/`, `modules/compiler/`, and `modules/maintenance/`; `native/tauri/` hosts the new desktop shell. The existing `src/`, `layout/`, other `native/`, and `scripts/` directories are adapters or established asset roots assigned in `module-map.md`.

## HTML UI skill route

For new or changed text-bearing HTML/CSS interfaces, load the installed `uncodixfy-pretext` skill ([source](https://github.com/GeorgeFejer91/uncodixfy-pretext/blob/main/SKILL.md)) and its Pretext reference. It nests `ponytail` and the original Uncodixfy visual discipline. Preserve this project's established design and stack; implement real `@chenglou/pretext` measurement for bounded text in the touched UI, not a CSS-only or test-only substitute. Design box geometry first, then handle measured no-fit with readable reflow, space, or an accessible full-value route. Verify the rendered target at narrow widths, 320 CSS px reflow, 200% text/zoom, and long or localized strings. This route does not claim existing UI has already been migrated or qualified.
