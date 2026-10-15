# Codex workflows

## ChatDev 2.0 delivery orchestration

The user explicitly requested an active delivery goal and continuous specialist
delegation until the final product meets [product-goal.md](product-goal.md).
Apply ChatDev 2.0's planning → implementation → review → testing → documentation
loop through the available Codex agents. The orchestrator owns integration and
the delivery decision; a worker finishing one assignment triggers the next
relevant assignment, not a declaration that the product is complete.

The reference is OpenBMB/ChatDev at
[`4fb2db0`](https://github.com/OpenBMB/ChatDev/tree/4fb2db0ea90375ce1059f44fe03ffbd191a7a169),
especially its
[`ChatDev_v1.yaml`](https://github.com/OpenBMB/ChatDev/blob/4fb2db0ea90375ce1059f44fe03ffbd191a7a169/yaml_instance/ChatDev_v1.yaml)
software-development graph and
[workflow-authoring contract](https://github.com/OpenBMB/ChatDev/blob/4fb2db0ea90375ce1059f44fe03ffbd191a7a169/docs/user_guide/en/workflow_authoring.md).
The template's filename is `ChatDev_v1`; the downloaded platform is ChatDev 2.0.
The upstream checkout and unmodified YAML live under ignored
`artifacts/chatdev/upstream/`, outside the Markdown-only control plane and all
application packages. This is a Codex execution adaptation: downloading the
graph does not mean the separate DevAll server or its model API has run.

| Responsibility | Work boundary and completion evidence |
| --- | --- |
| Orchestrator / product / architecture | Select the next unmet requirement, assign disjoint file ownership and dependencies, integrate results, keep the delivery goal active and assess the release gates. |
| Rust / authority / security | Native document, policy, persistence, compiler, connection and synchronization behavior; success, denied, stale and recovery cases. |
| Frontend / interaction | Editor/session coordination and the established workspace; measured text, accessible interaction, dirty-buffer preservation and rendered qualification. |
| QA / release | Independent acceptance checks, package inspection and startup, regression reproduction and release evidence; rotate a free worker into independent review when needed. |

Use the available concurrency limit; queue further specialties until a slot is
free. Each assignment names the requirement, files owned, trust boundaries,
observable acceptance check and dependencies. Workers read the applicable
repository and skill routes, preserve existing changes, and report changed
files, exact checks/results and remaining gaps. Serialize shared manifests,
build outputs and native qualification when concurrent writes would invalidate
the result.

On a result, review its diff and evidence, return defects to the owning worker,
and assign the next independent requirement to any free worker. Reuse valid
evidence for unchanged inputs. Record durable contract changes in their
canonical owners and raw receipts in ignored `artifacts/`; do not create a
second status ledger. Completion requires the product, UI, native, connection
and release gates below and in [reference-evidence.md](reference-evidence.md),
including the [non-content App control conformance gates](PLANNER/CHATGPT-FULL-CONTROL.md).
An unavailable live integration or platform remains an explicit qualification
gap; a bounded iteration count, passing mock or finished worker is not product
completion.

## Changing the control plane or investigating software behavior

For context and skill-routing changes, apply the nested [For-AI skill](skills/for-ai/SKILL.md) through [the existing-project mapping](skills.md). Update the narrow canonical owner, keep the entrypoint short and task-routed, preserve the Markdown-only boundary, and run `npm run verify:architecture` plus changed-document link checks. The upstream bootstrap creates new repositories; do not run it against UnderTree.

For artifact/runtime investigations and behavior reconstruction, follow [the UnderTree reverse-engineering protocol](PROTOCOLS/reverse-engineering.md). Load REA and only the relevant guide, bind evidence to the selected target/version, then return implementation work to its normal owner and acceptance gates below. Record findings in [reference-evidence.md](reference-evidence.md); raw generated evidence stays in ignored `artifacts/`.

## Changing the Rust/Tauri manuscript workspace

1. Read the installed Ponytail and Tauri Rust skills; use the HTML/Pretext route for touched text-bearing UI, including its accordion stretch reference. Follow [overleaf-ui-parity.md](overleaf-ui-parity.md) and [ui-layout.md](ui-layout.md). Read REA when artifact/runtime evidence is needed; ordinary public-source analysis uses repository tools.
2. Put domain validation, persistence, compilation/import and synchronization in `modules/review/`. Keep `native/tauri/` as a least-privilege adapter; keep save/review coordination in `modules/frontend/` and DOM changes in `src/manuscript.*`.
3. Check every local caller when changing `Operation`. Review remains a separate fixed catalogue and must never inherit a newly added local operation. Follow [the App control plan](PLANNER/CHATGPT-FULL-CONTROL.md): remote source/tree/policy mutation and implicit autosave are forbidden, and local CLI saves stay local.
4. Preserve proposal-only Review behavior, policy precedence, UTF-16 ranges, revision/quote checks, stale markers, escaped local acceptance and interrupted-save recovery. App controls use separate authority and explicit no-save UI guards. Test denied/stale/dirty/IME paths alongside success; a tool name is not proof of applied UI state or complete coverage.
5. Verify with `npm run verify:architecture`, `npm run test:review`, `npm run build`, and `cargo check -p undertree-desktop --features custom-protocol`. Use `npm run test:review-ui` for rendered browser qualification and `npm run desktop` for the real Tauri window with bundled offline assets.
6. Test successful and failed real Typst compilation separately from syntax validation. A simulated zrok process or local MCP exchange does not establish a live ChatGPT connection. Git fixture tests do not establish a real GitHub push; verify actual branch heads when that action is performed.

## Changing frontend behavior

1. Put reusable scheduling/state logic in `modules/frontend/`. Treat [Overleaf UI parity](overleaf-ui-parity.md) and [outside-in accordion stretch/overflow prevention](ui-layout.md) as acceptance requirements, including for retained editor surfaces.
2. Keep `src/main.js` as the DOM and API adapter.
3. Add deterministic unit tests for the reusable module before relying on UI smoke tests.
4. Verify that typing remains enabled during builds and that a newer edit cannot be marked clean by an older response.

## Coordinating UI work

1. Give each worker the same pinned Overleaf reference and both canonical UI policies. Assign explicit DOM/CSS, interaction-state, native-frame and verification scopes; coordinate shared manifests and capabilities before editing them.
2. Preserve reference workspace hierarchy while placing UnderTree-specific controls in familiar menus/panels. Use the original UnderTree boundary only for the native frame.
3. Qualify visual/interaction parity with matched-state comparisons, and stretch/overflow behavior with independent width and height changes. Record unqualified gaps in [reference-evidence.md](reference-evidence.md); existing build or width-only smoke results do not prove either requirement.

## Changing compiler behavior

1. Put toolchain discovery and process lifecycle code in `modules/compiler/`.
2. Preserve the authenticated localhost API and project-root confinement.
3. Treat automatic compilation as coalescible and explicit compilation as non-coalescible.
4. Test missing-tool, failed-build, superseded-build, clean-build, and shutdown behavior.

## Changing packaging or maintenance

1. Put reusable validation/release policy in `modules/maintenance/`.
2. Keep platform command wrappers in `scripts/` or `native/`.
3. Run `npm run verify:architecture` before building a release.
4. Inspect the unpacked package and installer size; do not assume dependency declarations equal shipped contents.

## Required handoff

For connection changes, first read [the connection contract](PROTOCOLS/connections.md). Test invalid setup without revoking a live session, duplicate starts, startup failure, process death, MCP initialization and denied authority, individual revocation, stop and fresh capabilities, and persisted setup without restored grants. Run `cargo test -p undertree-review`, `npm run build`, `cargo build -p undertree-review`, `npm run test:connections-ui`, and `npm run verify:architecture`. The browser gate exercises the real Rust authority with a synthetic zrok child; a live ChatGPT/public-tunnel test remains a distinct qualification step. Preserve unrelated concurrent edits and do not terminate another task's build processes.

Report changed module boundaries, responsiveness behavior, exact checks and their results, environment-only failures, live integrations actually exercised, and remaining Typst/TeX import or platform gaps. Update the reference evidence with observations, inferences and unknowns; never label a mock, source review or successful build as runtime proof.
