# Codex workflows

## Changing the Rust/Tauri manuscript workspace

1. Read the installed Ponytail and Tauri Rust skills; use the HTML/Pretext route for touched text-bearing UI, including its accordion stretch reference. Follow [overleaf-ui-parity.md](overleaf-ui-parity.md) and [ui-layout.md](ui-layout.md). Read REA when artifact/runtime evidence is needed; ordinary public-source analysis uses repository tools.
2. Put domain validation, persistence, compilation/import and synchronization in `modules/review/`. Keep `native/tauri/` as a least-privilege adapter; keep save/review coordination in `modules/frontend/` and DOM changes in `src/manuscript.*`.
3. Check every local caller when changing `Operation`. The implemented Review catalogue is a separate fixed subset: it must never inherit a newly added local operation automatically. For the user's requested full CLI/application control, follow [the Full control plan](PLANNER/CHATGPT-FULL-CONTROL.md), including its instance/session/authentication prerequisites and feature inventory.
4. Preserve proposal-only behavior in Review mode, policy precedence, UTF-16 ranges, revision/quote checks, stale markers, escaped acceptance and interrupted-save recovery. Planned Full control actions must use the same native validations under their own grant. Test denied and stale paths alongside success; adding a tool name is not proof of complete feature control.
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
