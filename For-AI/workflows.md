# Codex workflows

## wrAIter branding delivery

For Word/Writer application icons, native windows, repository presentation or
download/install materials, follow [the branding protocol](PROTOCOLS/branding.md).
Reuse the approved master and existing native owners; apply Uncodixfy without
redesigning functional controls. Qualify both packages and their windows
independently, and distinguish source, local builds, live installation and public
release evidence.

## AI highlighting and protected-passage delivery

The [active implementation goal](product-goal.md#active-implementation-goal-ai-highlighting-and-protected-rearrangement)
requires all three hosts: UnderTree, LibreOffice Writer and Microsoft Word.
Read the [canonical connection contract](PROTOCOLS/connections.md#ai-highlighting-and-immutable-protected-passages)
before changing policy, UI or tool discovery. Its narrow color-only Review
extension supersedes older fixed-three-tool wording; native preservation of
whole protected units supersedes blanket overlap rejection only when proven.

Implement in this order: extend the existing shared runtime contract and denial
cases; add native neutral marking and explicit MCP catalogue/dispatch schemas;
add local toolbar/in-text rule gestures; implement protected-unit reconstruction
and reanchoring; run equivalent host cases and qualify each installed package.
Use the existing ChatDev loop with disjoint authority/UI/QA scopes for delivery.
Review normal and imported connectors plus frozen pairing aliases explicitly;
never export a local dispatcher. Keep color-function assignment user-only.
Earlier installers, mocks or a passing single host do not complete this goal.
The connection contract owns the acceptance matrix and current qualification
limit; record new observed results in the existing verification/evidence owners.

## Native Microsoft Word delivery

The user requested implementation, one Windows installer, public release when
ready, installation on this PC and an actual Word demonstration. Work is owned
by `modules/word/`. Preserve the existing UnderTree/Writer work and private state.
Use the shared selective-editor contract and native Word layout/text measurement;
this COM/.NET host does not require Tauri or an HTML/Pretext rendering claim.

Build with `modules/word/build.ps1`; verify policy, the real loopback endpoint,
owned child cleanup and native UI independently. Run
`modules/word/test-com-contract.ps1` against the exact built DLL, including its
dispatch-only mutation regression. `modules/word/tests/test-installed.ps1`
requires normally opened, activated desktop Word and exercises a synthetic DOCX.
Check suggestion/direct/denied/revoked, explicit save/reopen, unchanged surrounding
text and no implicit save before release. Keep authentication user-owned; an
Office activation screen is a real host-qualification blocker, not a passed gate.
Publish/install the exact source-bound installer only after these gates pass.

## ChatDev 2.0 delivery orchestration

The user's 2026-10-17 coordination direction is to continue development in one
primary chat for this checkout. Do not run independent chats that edit the same
working tree concurrently. Scoped internal delegation remains available to that
one orchestrator. Push a source checkpoint and record qualification limits in
the existing session and verification documents before handing work over.

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

The 2026-10-17 marked-edit exception in [the connection contract](PROTOCOLS/connections.md)
supersedes this section's older blanket suggestion-only wording. Review's closed
catalogue includes the new required color-only extension above; wording changes
may apply only locally authorized, fully marked direct prompt edits;
App controls and generic file/policy changes retain their existing exclusions.
Writer extension work stays under `modules/libreoffice/`, uses native UNO
authority/measurement, and requires actual installed-extension, ODT reopen,
authorized full-document context, highlighted-only changes,
approval/direct/denied/revoked and gateway checks. Apply the
[three-deliverable parity contract](product-goal.md#three-deliverables-one-selective-ai-editing-contract)
to every assignment touching selective editing. Run equivalent functional and
permission scenarios against all three hosts, compare the actual controls/options
and interaction flow, and qualify each separately installable package. Keep
target-specific gaps explicit; one host's passing gate cannot stand in for the
others. Propagate contract changes to active workers before they resume related
implementation or declare completion.

1. Read the nested [Ponytail](skills/ponytail/SKILL.md) and [Tauri Rust Developer](skills/tauri-rust-developer/SKILL.md) skills, adding the integrated/remote routes only as directed by [skills.md](skills.md). Use the HTML/Pretext route for touched text-bearing UI, including its accordion stretch reference. Follow [overleaf-ui-parity.md](overleaf-ui-parity.md) and [ui-layout.md](ui-layout.md). Read REA when artifact/runtime evidence is needed; ordinary public-source analysis uses repository tools.
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

### Local delivery on George's PC

George explicitly requested on 2026-10-17 that completed UnderTree changes
always reach the installed app running on his PC. After proportionate checks,
build the current Windows installer, close UnderTree through its normal
buffer-preserving close path, install the exact verified artifact, and relaunch
the installed executable. Verify installed binary identities and the requested
visible behavior; a source change or development build alone is not delivery.
Preserve manuscripts, settings and connection configuration. If a close/save
conflict or an installation failure prevents delivery, report the blocker rather
than force termination or claim the running app is updated. This authorizes
local UnderTree updates, not publication, signing or unrelated installations.

## Required handoff

For connection changes, first read [the connection contract](PROTOCOLS/connections.md). Test invalid setup without revoking a live session, duplicate starts, startup failure, process death, MCP initialization and denied authority, individual revocation, stop and fresh capabilities, and persisted setup without restored grants. Run `cargo test -p undertree-review`, `npm run build`, `cargo build -p undertree-review`, `npm run test:connections-ui`, and `npm run verify:architecture`. The browser gate exercises the real Rust authority with a synthetic zrok child; a live ChatGPT/public-tunnel test remains a distinct qualification step. Preserve unrelated concurrent edits and do not terminate another task's build processes.

Report changed module boundaries, responsiveness behavior, exact checks and their results, environment-only failures, live integrations actually exercised, and remaining Typst/TeX import or platform gaps. Update the reference evidence with observations, inferences and unknowns; never label a mock, source review or successful build as runtime proof.
