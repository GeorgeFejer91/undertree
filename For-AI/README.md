# Codex orchestration layer

The additional [native Microsoft Word deliverable](product-goal.md#native-microsoft-word-deliverable)
is owned by `modules/word/`: one Windows installer, Word-native authority and
controls, in-process MCP and an internal bundled tunnel child. Preserve all
three targets; qualify Word independently before release/install claims.

This directory exists only for Codex and other repository-aware coding agents. It contains project-wide constraints, ownership boundaries, and change workflows. It must remain Markdown-only and must never be imported, packaged, or read by the UnderTree application at runtime.

This repository has [three equal selective AI editor delivery goals](product-goal.md#three-deliverables-one-selective-ai-editing-contract): UnderTree, **wrAIter** for LibreOffice Writer and **wrAIter for Word**, with matching selective-editor UI, options and MCP restrictions, and independently installable packages. Each owns its MCP/zrok bridge and runs independently; optional URL pairing retains each target's authority. Preserve all three goals. Writer uses native UNO authority and Word native COM authority; the desktop stack below describes UnderTree.

The fixed product stack is **Rust, Tauri v2 and HTML/CSS, with Typst and optional direct LaTeX publication**; see [constraints.md](constraints.md#architecture). Obsolete Electron code and packaging have been removed; historical evidence remains in documentation and Git history.

Read in this order:

1. `constraints.md` for invariants that every change must preserve.
2. `module-map.md` to identify the owning runtime module.
3. `workflows.md` for the required implementation and verification sequence.

Then read [product-goal.md](product-goal.md) for all three delivery goals and their shared parity contract, [skills.md](skills.md) for installed skill routes and provenance, and [reference-evidence.md](reference-evidence.md) before making claims about Overleaf, Secret Tunnel, publication, or end-to-end qualification.

Final-product delivery uses the [ChatDev 2.0 orchestration loop](workflows.md#chatdev-20-delivery-orchestration): the orchestrator assigns bounded specialist work, reviews results and keeps assigning relevant follow-ups until the product's acceptance gates are met.

## Control-plane and investigation routes

The user explicitly requested applying the For-AI building skill to this existing repository. Preserve the current `For-AI/` casing and canonical documents. Apply [the nested For-AI skill](skills/for-ai/SKILL.md) and its [control-plane standard](skills/for-ai/references/for-ai-standard.md) through the existing-project mapping in [skills.md](skills.md); its new-project bootstrap is not this migration's workflow. User direction and repository-owned constraints govern adaptations of upstream skill instructions.

| Task | Read next |
| --- | --- |
| wrAIter logo, native window icons, installers or GitHub/download branding | [Branding protocol](PROTOCOLS/branding.md), then the owning add-on module |
| Change agent context, skill nesting or verification policy | [Skill order and For-AI adaptation](skills.md), then the nested For-AI skill and standard |
| Explain or reproduce behavior from a package, binary or running app | [UnderTree reverse-engineering protocol](PROTOCOLS/reverse-engineering.md), then its task-relevant REA guide |
| Explain behavior established by complete source | [Module map](module-map.md), source and relevant tests; use REA only for a remaining artifact/runtime question |

The nested skills contain Markdown instructions and references only. Their executable helpers and analysis providers stay outside this repository's control plane. Load task-relevant detail progressively.

For any UI, text-editing surface, typography, responsive layout or icon change, also read [overleaf-ui-parity.md](overleaf-ui-parity.md) for mandatory Overleaf appearance/interaction parity and the original UnderTree window frame, then [ui-layout.md](ui-layout.md) for the mandatory outside-in accordion stretch, overflow prevention, bounded Pretext and SVG-centering rules. These files own their respective policies; do not duplicate them in further files.

For ChatGPT, zrok or MCP work, read [the connection protocol](PROTOCOLS/connections.md) and [the Secret Tunnel analysis](BOARD/2026-10-14-secret-tunnel.md). They adapt Secret Tunnel's relevant protocol, skill-routing and evidence structures to UnderTree's narrower review authority. Keep runtime code and settings outside this directory.

The later Writer request adds separately consented project-folder and GitHub
tools inside the single add-on; see [Explicit Writer project access](PROTOCOLS/connections.md#explicit-writer-project-access).
This does not expand Review; its separate color-only extension is defined in
the connection contract below.

The 2026-10-17 user direction permits **direct wording edits only inside locally authorized prompt markers**, alongside default suggestions, and requests wrAIter in this repository. Read [the connection contract](PROTOCOLS/connections.md) and [constraints](constraints.md) for this narrow exception. Later direction adds the [color-only MCP action and immutable protected-passage contract](PROTOCOLS/connections.md#ai-highlighting-and-immutable-protected-passages), with an [active implementation goal across all three hosts](product-goal.md#active-implementation-goal-ai-highlighting-and-protected-rearrangement). Only the local user may assign color functions; neutral AI marks grant no editing authority. This requirement is not a claim of runtime support. General file/tree/policy changes and indirect editor saves remain excluded. [App controls](PLANNER/CHATGPT-FULL-CONTROL.md) retain their separate non-content capability. wrAIter lives in `modules/libreoffice/` and owns its private persisted connection and tunnel supervision. Remembered connection intent never restores document sharing; see the connection contract for pairing and qualification limits.

The user additionally requires [complete manuscript context before highlighted-only changes](PROTOCOLS/connections.md#full-manuscript-context-and-highlighted-only-changes): both suggestions and direct edits must stay within current highlights. Read that section's implementation status and acceptance gates before claiming this newer contract is enforced.

Use the [nested Ponytail skill](skills/ponytail/SKILL.md) across the entire repository for implementation, fixes, refactors, dependencies, maintenance and review. Reuse current owners and platform capabilities while preserving correctness, accessibility and editor-state safeguards. Use [Ponytail Audit](skills/ponytail-audit/SKILL.md) for a whole-repository review and [Ponytail Review](skills/ponytail-review/SKILL.md) for a bounded change; reports belong under ignored `artifacts/`.

Rust/Tauri work starts with [Tauri Rust Developer](skills/tauri-rust-developer/SKILL.md). Integrated app/CLI work additionally routes to [Tauri Remote App Builder](skills/tauri-remote-app-builder/SKILL.md); remote authority/transport work routes to [Tauri Browser Remote Control](skills/tauri-browser-remote-control/SKILL.md). Their Markdown references and license notices are nested here. Read only task-relevant references and apply the [UnderTree scope adaptation and pinned provenance](skills.md); template defaults cannot broaden remote authority.

All application code and assets live outside `For-AI/`. The executable module roots are `modules/frontend/`, `modules/review/`, `modules/compiler/`, and `modules/maintenance/`; `native/tauri/` hosts the new desktop shell. The existing `src/`, `layout/`, other `native/`, and `scripts/` directories are adapters or established asset roots assigned in `module-map.md`.

## HTML UI skill route

For new or changed text-bearing HTML/CSS interfaces, load the installed `uncodixfy-pretext` skill ([source](https://github.com/GeorgeFejer91/uncodixfy-pretext/blob/main/SKILL.md)) and its Pretext reference. It nests `ponytail` and the original Uncodixfy visual discipline. Preserve this project's established design and stack; implement real `@chenglou/pretext` measurement for bounded text in the touched UI, not a CSS-only or test-only substitute. Design box geometry first, then handle measured no-fit with readable reflow, space, or an accessible full-value route. Verify the rendered target at narrow widths, 320 CSS px reflow, 200% text/zoom, and long or localized strings. This route does not claim existing UI has already been migrated or qualified.
