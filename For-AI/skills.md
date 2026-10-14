# Installed skill routes

Installed on 2026-10-14 into the current user's Codex skills directory, outside this repository. Read the actual `SKILL.md` and task-relevant references; this index is not a substitute. Newly installed skills are discoverable by Codex on the next turn; their instructions were read directly for the current implementation.

| Skill | Published source | Route |
| --- | --- | --- |
| Ponytail | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail/tree/main/skills/ponytail) | Every implementation/review; smallest complete change, tested trust boundaries |
| Uncodixfy Pretext | [GeorgeFejer91/uncodixfy-pretext](https://github.com/GeorgeFejer91/uncodixfy-pretext) | Text-bearing HTML UI; mandatory outside-in accordion stretch for bounded panels, real Pretext measurement and rendered overflow verification under `ui-layout.md` |
| Uncodixfy | [GeorgeFejer91/Uncodixfy](https://github.com/GeorgeFejer91/Uncodixfy) | Restrained product-specific styling; project accessibility and existing palette take precedence |
| Tauri Rust Developer | [GeorgeFejer91/tauri-rust-developer-skill](https://github.com/GeorgeFejer91/tauri-rust-developer-skill) | Rust authority, Tauri v2, IPC, capabilities, persistence, process lifecycle and verification |
| Tauri Remote App Builder | [GeorgeFejer91/tauri-remote-app-builder](https://github.com/GeorgeFejer91/tauri-remote-app-builder) | Cross-layer native implementation; apply only within the requested manuscript-review scope |
| Tauri Browser Remote Control | [GeorgeFejer91/tauri-browser-remote-control](https://github.com/GeorgeFejer91/tauri-browser-remote-control) | Closed remote operations, grants, revocation and native authority. Current Review mode is narrow; the requested Full control target covers named UnderTree actions, not generic browser/desktop input. |
| Reverse Engineer Anything (REA) | [morluto/rea](https://github.com/morluto/rea/tree/main/.agents/skills/reverse-engineer-anything) | User-specified skill; packaged/runtime evidence when source is insufficient. Follow its explicit route: ordinary complete-source analysis uses normal repository tools, without REA setup. |

The user's requested Rust/Tauri migration and zrok MCP connection authorize implementation of that boundary. The user separately authorized making `GeorgeFejer91/undertree_texstudio` public and installing/authenticating the GitHub CLI through Chrome. This does not authorize unrelated release publication, generic remote authority, or persistent background services. Existing authorization takes precedence over skill pause points; do not request the same permission again. Do not introduce a second skill manager or place downloaded skills/executables in `For-AI/`.

## Public-source reverse engineering

For connection-manager work, the applied route is Ponytail → Tauri Rust Developer (IPC, native process ownership, settings and verification) → Uncodixfy Pretext plus its measurement reference. The existing pinned Pretext 0.0.8 exports the measurement APIs used here; keep it pinned unless an upgrade is separately needed. Use OpenAI Docs for current ChatGPT connection instructions. The local Secret Tunnel v2 checkout's current v5 guidance was inspected as a reference, not installed as an UnderTree runtime dependency; see [source provenance and adaptation decisions](BOARD/2026-10-14-secret-tunnel.md). No third-party skill bodies, credential stores, executables or private production settings are copied into this public repository.

Use [Overleaf's public repository](https://github.com/overleaf/overleaf), [track changes documentation](https://docs.overleaf.com/collaborating/track-changes), and [GitHub synchronization documentation](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/github-synchronization) as behavioral references. Secret Tunnel's published [native launcher](https://github.com/GeorgeFejer91/SecretTunnel/tree/main/app/src-tauri/src) is the zrok process/lifecycle reference. Copying source requires license review; independently implementing behavior still needs real acceptance tests.

The user's complete public GitHub inventory (99 repositories) was checked for relevant skills. REA was subsequently specified by the user and installed from its real `.agents/skills/reverse-engineer-anything` path. Installing instructions does not register an MCP server; do not claim REA MCP tools are available merely because the skill is installed.

REA was installed from commit `fffb0741936067530d1ce9777461cd53e87398c2`. The other six skills were installed from their published main branches on the date above; no exact commit identity was retained for them, so do not imply an immutable source pin. In this session their real local instructions were available under `/home/Zuri/.codex/skills/`; use the current session's skill directory on another machine rather than baking this path into runtime code.
