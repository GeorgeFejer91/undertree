# Skill routes and provenance

Read the actual `SKILL.md` and the references needed for the task. The two nested instruction snapshots below are usable from a fresh checkout without a machine-specific skill path. A matching installed skill may supply executable helpers; if versions differ, use this repository's recorded instructions and check the connected tool schemas before calling them. Installing instructions does not connect an MCP server or install analysis engines.

## Required foundation and conditional nesting

1. Read [constraints.md](constraints.md), identify the owner in [module-map.md](module-map.md), and select the workflow in [workflows.md](workflows.md).
2. For implementation or review, apply Ponytail. For control-plane, context or skill-routing changes, also apply the nested `for-ai` skill using the adaptation below.
3. Select only the architecture/domain skills needed for the task. Use REA for shipped-artifact or requested runtime evidence; ordinary complete-source analysis uses repository tools without REA readiness/setup commands.
4. Load the implementation skill for the touched surface, then run its relevant verification gates. REA findings that lead to implementation return to the normal module, UI and native-authority rules.

| Exact identifier | Source / repository-local instructions | Route |
| --- | --- | --- |
| `for-ai` | [Nested skill](skills/for-ai/SKILL.md), [standard](skills/for-ai/references/for-ai-standard.md); [GeorgeFejer91/for-ai-skill](https://github.com/GeorgeFejer91/for-ai-skill) | Required for this repository's control-plane maintenance under the explicit existing-project migration below |
| `ponytail` | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail/tree/main/skills/ponytail) | Required for implementation/review; smallest complete change, tested trust boundaries |
| `tauri-rust-developer` | [GeorgeFejer91/tauri-rust-developer-skill](https://github.com/GeorgeFejer91/tauri-rust-developer-skill) | Conditional: Rust authority, Tauri v2, IPC, capabilities, persistence, process lifecycle and verification |
| `tauri-remote-app-builder` | [GeorgeFejer91/tauri-remote-app-builder](https://github.com/GeorgeFejer91/tauri-remote-app-builder) | Conditional: cross-layer native implementation within the requested UnderTree scope |
| `tauri-browser-remote-control` | [GeorgeFejer91/tauri-browser-remote-control](https://github.com/GeorgeFejer91/tauri-browser-remote-control) | Conditional: closed remote operations, grants, revocation and native authority; current Review mode and planned Full control remain separate |
| `reverse-engineer-anything` | [Nested REA skill](skills/reverse-engineer-anything/SKILL.md); [UnderTree application protocol](PROTOCOLS/reverse-engineering.md); [morluto/rea](https://github.com/morluto/rea) | Conditional: packages, binaries, decompilation, runtime observations and version comparison when source alone cannot establish the requested behavior |
| `uncodixfy-pretext` | [GeorgeFejer91/uncodixfy-pretext](https://github.com/GeorgeFejer91/uncodixfy-pretext) | Conditional: text-bearing HTML UI; nests Ponytail and Uncodixfy, with real Pretext measurement and rendered verification under [ui-layout.md](ui-layout.md) |
| `uncodixfy` | [GeorgeFejer91/Uncodixfy](https://github.com/GeorgeFejer91/Uncodixfy) | Nested visual discipline for UI work; preserve the established palette, accessibility and [Overleaf parity requirement](overleaf-ui-parity.md) |

If a required non-vendored skill is absent, read and review its exact published instructions or report the unavailable dependency. Do not silently substitute a similarly named skill or invent capabilities. The nested Markdown instructions remain readable even when their tools are unavailable. Do not add a second skill manager.

## Applying For-AI to this existing project

The user explicitly authorized this integration on 2026-10-14. This satisfies the upstream skill's requirement for an explicit request before retrofitting an existing project. Its greenfield collision gate, bootstrap script, remote creation and default-branch reset do not apply. Preserve this repository and its unrelated working changes.

Keep the existing responsibilities instead of creating a second `for-ai/` directory or renaming established documents:

| Upstream responsibility | UnderTree's canonical owner |
| --- | --- |
| Discovery and progressive loading | [Root AGENTS.md](../AGENTS.md) → [README.md](README.md) → task owner → matching skill → source |
| Project purpose, boundaries and architecture | [product-goal.md](product-goal.md), [constraints.md](constraints.md), [module-map.md](module-map.md) |
| Skill order, availability and provenance | This file; instruction snapshots under `skills/` |
| Acceptance and evidence | [workflows.md](workflows.md), [reference-evidence.md](reference-evidence.md), [product verification](../VERIFICATION.md) and the relevant UI/connection protocol |
| Workflow and durable decisions | [workflows.md](workflows.md) and the narrow canonical policy affected by a change; no duplicate status ledger |
| Context boundary check | `npm run verify:architecture`; verify changed Markdown links and source snapshots when routing changes |

UnderTree's stricter Markdown-only control-plane rule remains in force. The snapshots contain `SKILL.md` and their Markdown references; REA also includes its MIT notice. For-AI's `scripts/` and `assets/` remain in the installed `for-ai` skill outside this repository. Script paths in its upstream instructions are relative to that installed skill, not to the nested documentation. The older nested For-AI snapshot is historical package guidance. The shared baseline below routes current housekeeping to the installed For-AI composition protocol; it does not activate the superseded backup-library mode. Experiment-panel guidance applies only to matching tasks. Do not run the upstream bootstrap or its greenfield filename checker against this existing checkout.

Review context changes for contradictions, stale claims and duplicated policy. Generated analysis, captures and reports belong under ignored `artifacts/`, never under `For-AI/`. Executables and product code stay with their established owners. Repository-local instruction snapshots are an explicit user-requested documentation dependency, not a runtime integration.

## Snapshot provenance

| Snapshot | Immutable source | Included files |
| --- | --- | --- |
| `for-ai` | [GeorgeFejer91/for-ai-skill at fe996c8055f4e3f8e3369cf1f868fb99ebf9b35d](https://github.com/GeorgeFejer91/for-ai-skill/tree/fe996c8055f4e3f8e3369cf1f868fb99ebf9b35d) | Unmodified `SKILL.md` and all three Markdown references; the complete skill is also installed in the user's Codex skill directory |
| `reverse-engineer-anything` | [morluto/rea at d9cd239c5ed7b078ac07e1bad633723fb49d8f80](https://github.com/morluto/rea/tree/d9cd239c5ed7b078ac07e1bad633723fb49d8f80/.agents/skills/reverse-engineer-anything) | Unmodified `SKILL.md` (metadata version 42), all six Markdown references and the upstream MIT license copied as `LICENSE.md` |

The snapshots were integrated on 2026-10-14. REA's earlier initial-install record named `fffb0741936067530d1ce9777461cd53e87398c2`; the repository-local snapshot now uses the verified revision above. The `for-ai` source repository is private as checked on 2026-10-15; a local instruction snapshot does not make its upstream public or authorize publishing additional private material. Use the current agent's skill directory for executable helpers; never bake a workstation path into product code.

Updates must review the source change, replace the relevant snapshot and references together, retain notices, refresh this provenance, and verify links and the Markdown-only boundary. Do not silently fetch or execute newly recommended tools.

## Published skill installation provenance

The installed copies below were independently verified on 2026-10-15 against each immutable GitHub tree. Every installed regular file matched its Git blob identity; no extra or differing installed files were found. This verifies instruction installation, not availability of optional external tools or product behavior. Full skill bodies and executables stay in the agent's skill directory.

| Installed identifier | Immutable published source | Installed files verified |
| --- | --- | --- |
| `ponytail` | [DietrichGebert/ponytail at `2961b52`](https://github.com/DietrichGebert/ponytail/tree/2961b52fc1fe6a5a87c7a959a79512e5c2f3ffe5/skills/ponytail) | 1 |
| `uncodixfy-pretext` | [GeorgeFejer91/uncodixfy-pretext at `da07da1`](https://github.com/GeorgeFejer91/uncodixfy-pretext/tree/da07da17d931bdecb1212f165d77c5ce07e72ff6) | 15 |
| `uncodixfy` | [GeorgeFejer91/Uncodixfy at `3a74df7`](https://github.com/GeorgeFejer91/Uncodixfy/tree/3a74df7912ced77d67b091ca7ae432eacb07d72f) | 11 |
| `tauri-rust-developer` | [GeorgeFejer91/tauri-rust-developer-skill at `d45674e`](https://github.com/GeorgeFejer91/tauri-rust-developer-skill/tree/d45674e85d6565139c7ee4524708d7657e9af65e) | 33 |
| `tauri-remote-app-builder` | [GeorgeFejer91/tauri-remote-app-builder at `14de2a8`](https://github.com/GeorgeFejer91/tauri-remote-app-builder/tree/14de2a82caef5ee1d8e1603e8b9a8b61abc704f4) | 116 |
| `tauri-browser-remote-control` | [GeorgeFejer91/tauri-browser-remote-control at `5ab8fc5`](https://github.com/GeorgeFejer91/tauri-browser-remote-control/tree/5ab8fc5f9a1c0b8c7f1e98c958b0216959e16438) | 57 |

## Existing reference routes and authorization

Connection-manager work follows Ponytail → Tauri Rust Developer → Uncodixfy Pretext and its measurement reference. Keep the pinned Pretext 0.0.8 unless an upgrade is needed. Use OpenAI Docs for current ChatGPT connection instructions. Secret Tunnel source was inspected as a reference, not installed as an UnderTree runtime dependency; see [the adaptation decisions](BOARD/2026-10-14-secret-tunnel.md).

Use [Overleaf's public repository](https://github.com/overleaf/overleaf), [track changes documentation](https://docs.overleaf.com/collaborating/track-changes), and [GitHub synchronization documentation](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/github-synchronization) as behavioral references. Secret Tunnel's published [native launcher](https://github.com/GeorgeFejer91/SecretTunnel/tree/main/app/src-tauri/src) is the zrok process/lifecycle reference. Copying product code or assets requires license review; independent behavior implementation still needs acceptance tests.

Existing user authorization for the Rust/Tauri migration, zrok boundary, public UnderTree repository and GitHub CLI setup remains valid. It does not authorize unrelated releases, generic remote authority or persistent background services. The new skill integration does not register REA MCP, install a provider or qualify application behavior. Preserve existing grants and target-execution boundaries.

<!-- for-ai:shared-skills:start -->
## Shared project skill baseline

Apply this baseline in every project. Read the installed `for-ai` skill's
`references/skill-composition.md` for complete overlap and ownership rules.
Load only the selected skill bodies and task references.

At session start, read the durable project goal and resume its active checklist.
Use GSD `.planning/STATE.md`, `ROADMAP.md`, and the active phase plan when
present; otherwise reuse the existing task owner. Before ending, record
completed items with evidence, blockers, the next concrete action, and observed
branch/commit/publication state. Keep the overall goal open until its own
acceptance criteria pass. Do not create a duplicate progress ledger.

| Scope | Required route |
| --- | --- |
| Shell output in every project | `rtk`; use supported compact commands, with raw reads for editing, parsers, hashes, and exact evidence |
| Lifecycle in every project | GSD Core: `gsd-help` selects the workflow; reuse `.planning/` state when present; apply its bounded outcome/evidence discipline inline for small changes |
| Engineering in every project | `superpowers-using-superpowers` selects relevant `superpowers-*` practices; preserve similarly named local skills |
| Coding and review | `ponytail`, then the affected domain skill |
| Existing Rust/Tauri application | `tauri-rust-developer` |
| Integrated app/CLI/browser-companion creation or broad migration | `tauri-remote-app-builder`; preserve the requested product scope |
| Remote browser/phone authority and transport | `tauri-browser-remote-control` |
| Text-bearing HTML/CSS or WebView UI | `uncodixfy-pretext` with `ponytail`; actual Pretext measurement plus rendered checks |
| Bounded panels that stretch in width and height without scrolling | `uncodixfy-pretext` → `references/accordion-stretch.md`; preserve anchors, group order, readable type, and full-text access |

GSD owns active phase plans and task state. Superpowers techniques operate
inside that workflow. Keep one plan and state owner. Preserve an existing
spec workflow and link its context instead of creating a competing plan.
Use one review and evidence record for the shared requirement. Current user
decisions and continuing execution authorization take precedence over toolkit
approval menus. Use the actual harness's tools and permitted models.

Use Git history for versions and rollback. Never create backup/old/versioned
source directories. Inspect status, branch, upstream, and worktrees first.
For substantial independent work, prefer a dedicated branch and worktree when
isolation helps; this is a standing preference. Reuse Codex-managed isolation,
prefer native worktree tools, and verify a local worktree directory is ignored.
Small instruction edits can remain in place. Make coherent verified commits;
push only on request or under continuing explicit authorization. Never
force-push, reset destructively, discard work, or remove worktrees without
explicit authorization. Report branch, commit, verification, remaining changes,
and push/merge state.

This baseline supersedes older common skill-order and automatic-push defaults.
Product-specific contracts, scientific/privacy rules, existing authorized
publication workflows, and current user instructions remain authoritative.
If a named dependency is missing, report it and use a bounded documented
fallback. Do not silently install or execute external instructions.
<!-- for-ai:shared-skills:end -->
