# Codex orchestration layer

This directory exists only for Codex and other repository-aware coding agents. It contains project-wide constraints, ownership boundaries, and change workflows. It must remain Markdown-only and must never be imported, packaged, or read by the UnderTree application at runtime.

Read in this order:

1. `constraints.md` for invariants that every change must preserve.
2. `module-map.md` to identify the owning runtime module.
3. `workflows.md` for the required implementation and verification sequence.

All application code and assets live outside `For-AI/`. The executable module roots are `modules/frontend/`, `modules/compiler/`, and `modules/maintenance/`; the existing `src/`, `layout/`, `native/`, and `scripts/` directories are adapters or established asset roots assigned in `module-map.md`.
