# UnderTree Codex entry point

Before changing this repository, read `For-AI/README.md` and follow the linked constraints and module map. `For-AI/` is an orchestration-only layer: never place product runtime code, generated output, compiler binaries, frontend assets, or maintenance executables there.

Follow `For-AI/skills.md` for skill order and the repository-local instruction snapshots. For control-plane changes, apply `For-AI/skills/for-ai/SKILL.md` using the existing-project adaptation in the skill index. For packaged-software or runtime behavior investigations, follow `For-AI/PROTOCOLS/reverse-engineering.md` and its nested REA skill. Ordinary complete-source analysis uses normal repository tools.

<!-- for-ai:shared-skills:start -->
## Shared project workflow

At project entry, also read [For-AI/skills.md](For-AI/skills.md) for the required RTK, GSD Core,
and Superpowers baseline, conditional Rust/Tauri/HTML routes, and Git worktree
policy. Preserve this project's product and evidence contracts.

Read the durable project goal and resume its active checklist at session
start. Before ending, update that same state with evidence, blockers, the
next action, and observed Git/publication state. Keep the overall goal open
until its own acceptance criteria pass.
<!-- for-ai:shared-skills:end -->
