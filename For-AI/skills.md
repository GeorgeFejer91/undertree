# Skill routes and provenance

The [2026-10-17 marked-edit contract](PROTOCOLS/connections.md#locally-authorized-marked-edits)
supersedes older blanket suggestion-only statements in the routes below. Review
still defaults to approval. Later direction adds only the
[color-only Review action and protected-unit preservation requirement](PROTOCOLS/connections.md#ai-highlighting-and-immutable-protected-passages)
across UnderTree, Writer and Word; only a local user may assign color functions.
Separately granted App controls remain non-content. The Writer extension uses native UNO
document authority and native text geometry under `modules/libreoffice/`.

Read the actual `SKILL.md` and only the references needed for the task. The nested Markdown instruction snapshots below work from a fresh checkout without machine-specific paths. A matching installed skill may supply executable helpers; if versions differ, use this repository's recorded instructions and check connected tool schemas before calling them. Instructions do not install tools or connect an MCP server.

## Required foundation and conditional nesting

1. Read [constraints.md](constraints.md), identify the owner in [module-map.md](module-map.md), and select the workflow in [workflows.md](workflows.md).
2. For implementation or review, apply Ponytail. For control-plane, context or skill-routing changes, also apply the nested `for-ai` skill using the adaptation below.
3. Select only the architecture/domain skills needed for the task. Use REA for shipped-artifact or requested runtime evidence; ordinary complete-source analysis uses repository tools without REA readiness/setup commands.
4. Load the implementation skill for the touched surface, then run its relevant verification gates. REA findings that lead to implementation return to the normal module, UI and native-authority rules.

| Exact identifier | Source / repository-local instructions | Route |
| --- | --- | --- |
| `for-ai` | [Nested skill](skills/for-ai/SKILL.md), [standard](skills/for-ai/references/for-ai-standard.md); [GeorgeFejer91/for-ai-skill](https://github.com/GeorgeFejer91/for-ai-skill) | Required for this repository's control-plane maintenance under the explicit existing-project migration below |
| `ponytail` | [Nested skill](skills/ponytail/SKILL.md); [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail/tree/main/skills/ponytail) | Required across the repository: implementation, fixes, refactors, dependencies, maintenance and review; smallest complete change with validation and data-loss safeguards |
| `ponytail-audit` | [Nested skill](skills/ponytail-audit/SKILL.md) | Conditional: repository-wide review; report findings with concrete cases, verify callers before proposing deletion, and state unread/unrun scope |
| `ponytail-review` | [Nested skill](skills/ponytail-review/SKILL.md) | Conditional: review a bounded change and its connected callers/tests |
| `tauri-rust-developer` | [Nested skill](skills/tauri-rust-developer/SKILL.md); [upstream](https://github.com/GeorgeFejer91/tauri-rust-developer-skill) | Conditional: Rust authority, Tauri v2, IPC, capabilities, persistence, process lifecycle and verification |
| `tauri-remote-app-builder` | [Nested skill](skills/tauri-remote-app-builder/SKILL.md); [upstream](https://github.com/GeorgeFejer91/tauri-remote-app-builder) | Conditional: integrated desktop/CLI/remote work within UnderTree's existing authority boundaries |
| `tauri-browser-remote-control` | [Nested skill](skills/tauri-browser-remote-control/SKILL.md); [upstream](https://github.com/GeorgeFejer91/tauri-browser-remote-control) | Conditional: closed remote operations, grants, revocation and native authority; suggestion-only Review and separately granted non-content App controls remain distinct |
| `reverse-engineer-anything` | [Nested REA skill](skills/reverse-engineer-anything/SKILL.md); [UnderTree application protocol](PROTOCOLS/reverse-engineering.md); [morluto/rea](https://github.com/morluto/rea) | Conditional: packages, binaries, decompilation, runtime observations and version comparison when source alone cannot establish the requested behavior |
| `uncodixfy-pretext` | [GeorgeFejer91/uncodixfy-pretext](https://github.com/GeorgeFejer91/uncodixfy-pretext) | Conditional: text-bearing HTML UI; nests Ponytail and Uncodixfy, with real Pretext measurement and rendered verification under [ui-layout.md](ui-layout.md) |
| `uncodixfy` | [GeorgeFejer91/Uncodixfy](https://github.com/GeorgeFejer91/Uncodixfy) | Nested visual discipline for UI work; preserve the established palette, accessibility and [Overleaf parity requirement](overleaf-ui-parity.md) |

If a required non-vendored skill is absent, read and review its exact published instructions or report the unavailable dependency. Do not silently substitute a similarly named skill or invent capabilities. The nested Markdown instructions remain readable even when their tools are unavailable. Do not add a second skill manager.

## Applying the nested skills to UnderTree

Ponytail applies to all owned source, tests, adapters, packaging and orchestration, including compatibility paths. Trace consumers before deleting or merging code; reuse the existing owner or standard/platform facility before adding a dependency. Keep named trust boundaries, concurrency/recovery guards, accessibility and required behavior. A shorter implementation is useful only when it preserves those contracts. Review alone does not authorize broad rewrites or installation. Audit reports and mechanical inventories belong in ignored `artifacts/`; durable policy belongs here.

The three Tauri skills are task routes, not three mandatory full reads. Start native work with `tauri-rust-developer`; add the integrated builder for app/CLI work and browser remote control for remote authority or transport. Follow their reference maps progressively. Existing-source locations in [module-map.md](module-map.md) replace template `src-tauri/` paths. UnderTree's product constraints override greenfield defaults: do not expose every local operation remotely, create a new phone companion, restore Full control, add startup services, or upgrade pinned Pretext just because a template describes them. Existing local-only operations retain their documented trust/consent reasons.

The snapshots are documentation dependencies. Code, scripts, starter contracts, templates and optional tools mentioned in them stay in the complete installed/upstream skill outside `For-AI/`; relative helper paths are resolved there. Markdown references and license notices are nested here. Original bytes are preserved except one declared link relocation below. A source ledger inside a skill records that skill's historical inputs, not UnderTree's installed dependency versions or runtime qualification.

## Applying For-AI to this existing project

The user explicitly authorized this integration on 2026-10-14 and refreshed it on 2026-10-17. This satisfies the upstream skill's requirement for an explicit request before retrofitting an existing project. Its greenfield collision gate, bootstrap script, remote creation and default-branch reset do not apply. Preserve this repository and its unrelated working changes.

Keep the existing responsibilities instead of creating a second `for-ai/` directory or renaming established documents:

| Upstream responsibility | UnderTree's canonical owner |
| --- | --- |
| Discovery and progressive loading | [Root AGENTS.md](../AGENTS.md) → [README.md](README.md) → task owner → matching skill → source |
| Project purpose, boundaries and architecture | [product-goal.md](product-goal.md), [constraints.md](constraints.md), [module-map.md](module-map.md) |
| Skill order, availability and provenance | This file; instruction snapshots under `skills/` |
| Acceptance and evidence | [workflows.md](workflows.md), [reference-evidence.md](reference-evidence.md), [product verification](../VERIFICATION.md) and the relevant UI/connection protocol |
| Workflow and durable decisions | [workflows.md](workflows.md) and the narrow canonical policy affected by a change; no duplicate status ledger |
| Context boundary check | `npm run verify:architecture`; verify changed Markdown links and source snapshots when routing changes |

UnderTree's stricter Markdown-only control-plane rule remains in force. The snapshots contain `SKILL.md` and their Markdown references; REA also includes its MIT notice. For-AI's `scripts/` and `assets/` remain in the installed `for-ai` skill outside this repository. Script paths in its upstream instructions are relative to that installed skill, not to the nested documentation. Backup-library and experiment-panel references are available for explicitly matching tasks; they do not enable those modes in UnderTree. Do not run the upstream bootstrap or its greenfield filename checker against this existing checkout.

Review context changes for contradictions, stale claims and duplicated policy. Generated analysis, captures and reports belong under ignored `artifacts/`, never under `For-AI/`. Executables and product code stay with their established owners. Repository-local instruction snapshots are an explicit user-requested documentation dependency, not a runtime integration.

## Snapshot provenance

| Snapshot | Immutable source | Included files |
| --- | --- | --- |
| `for-ai` | [GeorgeFejer91/for-ai-skill at fe996c8055f4e3f8e3369cf1f868fb99ebf9b35d](https://github.com/GeorgeFejer91/for-ai-skill/tree/fe996c8055f4e3f8e3369cf1f868fb99ebf9b35d) | Re-downloaded and Git-blob verified on 2026-10-17: unmodified `SKILL.md` and all three Markdown references; complete skill already installed |
| `reverse-engineer-anything` | [morluto/rea at d9cd239c5ed7b078ac07e1bad633723fb49d8f80](https://github.com/morluto/rea/tree/d9cd239c5ed7b078ac07e1bad633723fb49d8f80/.agents/skills/reverse-engineer-anything) | Unmodified `SKILL.md` (metadata version 42), all six Markdown references and the upstream MIT license copied as `LICENSE.md` |
| `tauri-rust-developer` | [GeorgeFejer91/tauri-rust-developer-skill at d45674e85d6565139c7ee4524708d7657e9af65e](https://github.com/GeorgeFejer91/tauri-rust-developer-skill/tree/d45674e85d6565139c7ee4524708d7657e9af65e) | `SKILL.md`, 26 Markdown references and MIT notice (28 files) |
| `tauri-remote-app-builder` | [GeorgeFejer91/tauri-remote-app-builder at 14de2a82caef5ee1d8e1603e8b9a8b61abc704f4](https://github.com/GeorgeFejer91/tauri-remote-app-builder/tree/14de2a82caef5ee1d8e1603e8b9a8b61abc704f4) | `SKILL.md`, 47 Markdown references (including inherited Tauri references), MIT and third-party notices (50 files) |
| `tauri-browser-remote-control` | [GeorgeFejer91/tauri-browser-remote-control at 5ab8fc5f9a1c0b8c7f1e98c958b0216959e16438](https://github.com/GeorgeFejer91/tauri-browser-remote-control/tree/5ab8fc5f9a1c0b8c7f1e98c958b0216959e16438) | `SKILL.md`, 15 Markdown references, MIT and third-party notices (18 files); its application-profile JSON link points to the same immutable upstream file instead of an absent local asset |
| `ponytail`, `ponytail-audit`, `ponytail-review` | [DietrichGebert/ponytail at 16352ac229eb08a9598dcae48fe9f2b342567d86](https://github.com/DietrichGebert/ponytail/tree/16352ac229eb08a9598dcae48fe9f2b342567d86/skills) | Each skill's unmodified `SKILL.md` plus the upstream MIT notice (6 files) |

For-AI and REA were first integrated on 2026-10-14. For-AI, the three Tauri skills and the three Ponytail entrypoints above were downloaded from immutable upstream revisions and verified against their Git blob identities on 2026-10-17. REA was retained unchanged; its earlier initial-install record named `fffb0741936067530d1ce9777461cd53e87398c2`. The `for-ai` source repository was private as checked on 2026-10-15; nesting it does not authorize publishing additional private material. Use the current agent's skill directory for executable helpers; never bake workstation paths into product code.

Updates must review the source change, replace the relevant snapshot and references together, retain notices, refresh this provenance, and verify links and the Markdown-only boundary. Do not silently fetch or execute newly recommended tools.

The external UI routes were verified as installed on 2026-10-15: `uncodixfy-pretext` at [`da07da1`](https://github.com/GeorgeFejer91/uncodixfy-pretext/tree/da07da17d931bdecb1212f165d77c5ce07e72ff6) and `uncodixfy` at [`3a74df7`](https://github.com/GeorgeFejer91/Uncodixfy/tree/3a74df7912ced77d67b091ca7ae432eacb07d72f). This is historical installation evidence, not a claim that optional tools or product behavior were qualified. The current nested instructions above govern this checkout even if an installed copy is older.

## Existing reference routes and authorization

Connection-manager work follows Ponytail → Tauri Rust Developer → Uncodixfy Pretext and its measurement reference. Keep the pinned Pretext 0.0.8 unless an upgrade is needed. Use OpenAI Docs for current ChatGPT connection instructions. Secret Tunnel source was inspected as a reference, not installed as an UnderTree runtime dependency; see [the adaptation decisions](BOARD/2026-10-14-secret-tunnel.md).

Use [Overleaf's public repository](https://github.com/overleaf/overleaf), [track changes documentation](https://docs.overleaf.com/collaborating/track-changes), and [GitHub synchronization documentation](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/github-synchronization) as behavioral references. Secret Tunnel's published [native launcher](https://github.com/GeorgeFejer91/SecretTunnel/tree/main/app/src-tauri/src) is the zrok process/lifecycle reference. Copying product code or assets requires license review; independent behavior implementation still needs acceptance tests.

Existing user authorization for the Rust/Tauri migration, zrok boundary, public UnderTree repository and GitHub CLI setup remains valid. It does not authorize unrelated releases, generic remote authority or persistent background services. The new skill integration does not register REA MCP, install a provider or qualify application behavior. Preserve existing grants and target-execution boundaries.
