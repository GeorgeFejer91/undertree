# Codex orchestration layer

This directory exists only for Codex and other repository-aware coding agents. It contains project-wide constraints, ownership boundaries, and change workflows. It must remain Markdown-only and must never be imported, packaged, or read by the UnderTree application at runtime.

Read in this order:

1. `constraints.md` for invariants that every change must preserve.
2. `module-map.md` to identify the owning runtime module.
3. `workflows.md` for the required implementation and verification sequence.
4. `cli-roadmap.md` for the command-surface roadmap and fast validation recipes.
5. `github-divergence-protocol.md` before changing pull, push, merge, or automatic synchronization behavior.
6. `agent-editing-protocol.md` before changing AI editing marks, agent context, or protected source replacement.

All application code and assets live outside `For-AI/`. The runtime roots are `src-tauri/` for native Rust code and `web/` for the local HTML wrapper. This directory must contain Markdown guidance only.
