# UnderTree Codex entry point

Before changing this repository, read `For-AI/README.md` and follow the linked constraints and module map. `For-AI/` is an orchestration-only layer: never place product runtime code, generated output, compiler binaries, frontend assets, or maintenance executables there.

This repository has three equal delivery goals: UnderTree and independently installable LibreOffice Writer and Microsoft Word selective AI editors. Read `For-AI/product-goal.md` for matching UI/options and the AI-highlighting/protected-passage goal; each target requires its own implementation and tests. AI coloration grants no function or edit permission; only the local user may assign color rules.

Follow `For-AI/skills.md` for skill order and the repository-local instruction snapshots. For control-plane changes, apply `For-AI/skills/for-ai/SKILL.md` using the existing-project adaptation in the skill index. For packaged-software or runtime behavior investigations, follow `For-AI/PROTOCOLS/reverse-engineering.md` and its nested REA skill. Ordinary complete-source analysis uses normal repository tools.

Apply `For-AI/skills/ponytail/SKILL.md` throughout the repository. Rust/Tauri work uses the nested `tauri-rust-developer` skill, with `tauri-remote-app-builder` and `tauri-browser-remote-control` only for their matching tasks. Load references progressively; preserve local authority, default suggestions with the explicitly authorized marked-prompt direct-edit exception, and non-content App controls under `For-AI/PROTOCOLS/connections.md`. The installable Writer integration is owned by `modules/libreoffice/` and its native UNO authority.
