# Reference and qualification evidence

Evidence ledger for the 2026-10-14 Rust/Tauri/Typst migration. This is authored orchestration context, not a runtime input. Source inspection establishes source behavior; only an exercised path establishes integration behavior.

## Shared MCP gateway and discard policies, 2026-10-16

The user's single-connector requirement is implemented as the separately enabled
[shared app gateway](PROTOCOLS/connections.md#shared-app-gateway), not an expansion
of Review's three-tool authority. Locally linked apps receive distinct aliases;
target apps retain their own permissions. Upstream tool-list changes require
local relinking, and uncertain calls are not transparently replayed.

The real Rust/HTTP and Chromium discard gate passes four groups in
`artifacts/review-discard-smoke.json`: custom color/action highlighting, pending
MCP deletion without source writes, local rejection preserving source/markers,
responsive deletion cards, and local acceptance deleting exactly the marked
passage and retiring its marker. It uses CLI SHA-256
`ce1d38c2dd910503cc5ccbfce05be805eb44fb26695b7f202814349e4520ce87`
and its recorded immutable frontend assets. This qualifies discard interaction,
not the later shared-gateway binary or native Tauri window. The focused document
harness separately passes 23 tests against the actual document module. An
earlier session/source-binding run passes 76 tests, but has no source-hash
snapshot (`artifacts/chatgpt-mcp-review-unit-receipt.json`). A later working-tree
rerun passes 74/76; two PDF VM fixtures fail with
`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` after concurrent lazy-PDF changes.
Those unrelated fixtures remain untouched. A rooted refresh bug found by the
integration gate is fixed without adopting stale document identities.

The actual SDK-backed Hub module passes 13 runtime tests in 74.97 seconds,
including stateful SSE, pagination, distinct aliases, replay prevention,
revocation, tool-list drift, bounded instructions and oversized/error bodies.
The isolated harness uses an equivalent `Error`/`Result` boundary and coherent
Cargo-built dependencies, not the complete Service/Tauri crate. Its receipt and
reusable harness are in `artifacts/mcp-hub-unit-harness/`; module SHA-256 is
`5b828fe17f8d5ea5ce6ece1a58d7849a033501c4094995fff48143301c694e6b`.

The rendered gateway fixture in `artifacts/mcp-hub-ui-smoke.json` is explicitly a
simulated native API: enable/link/unlink, complete selectable/copyable URLs,
transient URL input, imported-connector gating and narrow/zoom/localized text.
It does not establish upstream routing. The real Rust service build and canonical
HTTP policy/multi-app gates subsequently pass using CLI SHA-256
`47ffbd9f21e37b1cca14d2be50ca0e5829b135c574759d1401781f9236b36a78`.
Receipts are `artifacts/mcp-review-policy-final.log` and
`artifacts/mcp-hub-final.log`: Typst/HTML protection and local acceptance,
independent JSON/stateful-SSE apps, pagination, scoped instructions, distinct
aliases, no replay after lost replies, CLI redaction and revocation. The imported
HTTP gate passes four groups in
`artifacts/mcp-imported-hub/imported-hub-evidence.json`, proving the preserved URL,
explicit gateway switch, forwarding/deduplication, a separately authenticated
browser-adapter App grant, and Review-only restoration. It does not fabricate a
renderer acknowledgement. All tunnel/identity/peer inputs are synthetic.

A subsequent final-source build includes the generic gateway initialization
instructions to read the app-scoped context first. All three canonical HTTP
gates pass again against CLI SHA-256
`5ba0dc922ed6bd17bcf13c5806899e7e0a5f9188c21951f250cf8c646b7065d0`;
the imported receipt is now
`artifacts/mcp-imported-hub-v2/imported-hub-evidence.json`.
Current-source native type-checking and the bundled desktop build pass with the
immutable frontend in `artifacts/mcp-hub-ui-verified-dist`, tree hash
`a483e8a91fcfa33f9688170da84fbf2aa968e3d1874fedf9b3fb0121ff6b62cb`.
All 63 captured Rust/Cargo/native inputs remain unchanged after qualification.

Actual Linux Tauri/WebKitGTK execution passes four native gateway groups against
desktop SHA-256
`8e89b6026d22f90cbfb69abdd6d4c817da3ce62523d532a9c5f05280994630a4`.
The real Apps UI enables and registers a loopback app, forwards one effect
exactly once, applies a pane change and independently observed X11
minimize/restore, and records genuine renderer acknowledgements. Retired-owner
and private-CLI denials, gateway capability redaction, exact source/policy
preservation, no save IPC, App-only revocation and gateway revocation pass.
The receipt `artifacts/native-mcp-hub/native-gateway-evidence.json` has SHA-256
`063dabbfe4b4a8877fb7f18c80e9db63ac01c20bc59800258e50faa5712cf759`.
The first registration attempt is preserved under `attempt01`; the runner now
waits for the actual enabled Link control and records its native response.
Only harness readiness/diagnostics changed, not product code or assertions.

Verified attribution refresh covers 354 Rust and 27 JavaScript components, with
four checksum-pinned clarifications preserving the actual AWS-LC/chrono texts
and upstream rmcp Apache/MIT transition notice; its offline verification and
regression test pass. These tests use isolated state, loopback peers and fake
zrok; the installed user application and real manuscript remain untouched.
Real zrok enrolment/credential handover and ChatGPT access across PCs are
not verified; the source Secret Tunnel still requires its explicit Read/Write
approval before a private transfer can be created.

## Realtime editing and GitHub synchronization investigation, 2026-10-16

[The synchronization analysis and phased design](BOARD/2026-10-16-realtime-github-sync.md)
records the user's requirements for unobtrusive background GitHub sync and eventual
simultaneous authors. The pinned Overleaf source, a read-only REA 6.5.0 browser
scenario and exact shipped CDN byte ranges distinguish live OT operations from
Overleaf's manual GitHub integration. Browser Evidence
`ev_57015e337624d0a81d5a9bb5465b0a762d19c99ecb2afab25f30477f154aa78e`
records editor/client loading and owned-browser cleanup; no WebSocket traffic or
edit delivery was observed before its incomplete network window ended. Source
and shipped-code settings are not measured latency or server qualification.
Focused shipped-bundle REA parsing timed out at 60 s; retained partial Evidence
`ev_597bd3210e35509abb816adb84bf2d97003b9c9701e1fd01e28d0a0a2c789001`
does not establish a complete call graph.

The dirty UnderTree source audit identifies 450 ms trailing saves, another 4 s
trailing publication timer, no independent remote discovery/native sync worker,
permanent transient-error pauses, incoming clean-editor conflict behavior and
document-lock contention. Preserve existing byte/epoch/Git publication guards.
The recommendation adds a bounded Rust coordinator and guarded editor changes
first, then a separate authorized collaboration channel with one checkpoint
publisher. Raw identities/captures live under ignored
`artifacts/reverse-engineering/overleaf-github-sync-20261016/` and do not travel
with a fresh clone. No product source was changed or live repository pushed;
new native sync, latency and multiuser qualification remain NOT RUN.

## Existing Secret Tunnel address, 2026-10-16

The explicit imported-connector mode preserves the existing `/t/<token>/mcp`
address and mounts only the three Review tools. Its private native profile and
dedicated zrok child home are separate from public connection settings; no
manuscript grants or tunnel startup are restored. See the
[connection contract](PROTOCOLS/connections.md#explicit-secret-tunnel-connector-import).
The maintenance export/import gate passes eight tests, covering minimal
credential selection, private destination permissions, existing state,
concurrent imports, required enrolment files, links/bounds and sanitized CLI
errors. The rendered Overview/Pretext fixture passes its functional, imported
mode and narrow/zoom checks (`artifacts/connection-controls-ui/report.json`).
These are local fixtures. Cross-PC Wormhole transfer, real zrok handover and
ChatGPT discovery of the changed catalogue remain unverified.

## Native Linux release and installed app, 2026-10-15

[UnderTree v0.3.0](https://github.com/GeorgeFejer91/undertree/releases/tag/v0.3.0)
is publicly released as a Rust/Tauri Linux preview. The 10,178,958-byte Debian
installer SHA-256 is `6e20cd825eca2212225fd5a3bd6816a48c45fbe11f22c2c036f1fd9c7db57fd2`.
Anonymous page/asset downloads and strict checksums pass (`d80cdb01…`).
Build commit `c3e09a1…` matches the 304-source/15-asset v16 manifest
`4a580ecd…`; tag commit `89ca118…` changes only the browser fixture.
Packaged desktop `966ea7ae…` and CLI `00dfa493…` pass 87 native/compiler
checks across twelve gates, including baseline13, History8, diagnostics5,
real OS import/ZIP and real Typst20. Aggregate evidence `32563ceb…` proves
input guards and cleanup. All 382 frontend tests pass. Prior Rust/Clippy
results apply to exactly unchanged 67 input files and are not relabeled.

Actual GitHub-downloaded bytes install, remove and reinstall successfully on
this Debian 13 amd64 PC while preserving existing app data (`3624fa4c…`).
The system desktop launcher compiles a current PDF with expected text through
normal PATH and separately installed Typst, without a compiler override
(`329be24d…`). A normal user-profile app is left open. The Close repair clears
the previous native failure on the exact package. The seven-check project-tree
browser gate also passes after explicitly testing the bounded depth refusal
and then removing only its owned fixture before retry; original assertions
remain (`5e6cc845…`). Earlier failures remain immutable, and hosted CI remains a
separate gate assessed only from its actual result.

See [the release and installation report](../VERIFICATION.md#native-linux-release-and-this-pc-installation-2026-10-15)
for exact receipts, compiler identity, source/fixture distinctions and limits.
The portable receipt and checksums travel with the public release; ignored
raw local artifacts do not. The installer slice is complete; the full delivery
goal, Move/parity/live/platform acceptance and hard dependency-output bound
remain active/open.

## Previous v15 combined capture, 2026-10-15

The newer unpublished v15 capture binds 303 sources, 15 fresh assets and
desktop `5e2be040…` / unchanged CLI `d343134a…` to final manifest `282ec7e1…`.
It passes 378 selected JavaScript tests and both builds; v14's Rust/strict
Clippy evidence is reused only because all 67 Rust/native inputs match.
Actual native History passes all eight groups, including producer versions,
pure reads/compare/input, retained editor/canvas/workers, access denials,
late-response rejection and restart persistence. Execution `7590ead1…` and
native evidence `a67bf901…` bind the exact copied pair and disclosed fixture
`f5e36ede…`: only the invalid CLI call's parse-denial assertion was corrected.
Original failures remain preserved. Native diagnostics passes all five groups
using a separately disclosed one-action Show PDF prerequisite correction;
its assertions/deadlines remain intact. Native publishing passes six groups
with a passive geometry observer: no local 320 px/200% page overflow, while the
earlier hosted public build's overflow remains unresolved. The original v15
baseline fails after 11 groups when custom Close is refused because an
unidentified local operation is pending; its final two groups remain
unqualified. Captured inputs remain unchanged and cleanup completes. See the
[current checkpoint](../VERIFICATION.md#previous-v15-viewer-and-native-history-checkpoint--2026-10-15)
for exact receipts and limits. The goal remains active.

## Previous v14 combined capture, 2026-10-15

The unpublished v14 capture binds 303 sources, 15 freshly built assets and
copied desktop `7f421368…` / CLI `d343134a…` to final manifest
`230b9ab1b97e3c58e8c97bde0511287286c11aed7905971c6ecae71b1026b782`.
It passes 413 Rust tests, 373 selected JavaScript tests, strict native Clippy,
both binary builds and all 20 real-Typst publishing checks with no publishing
skips. Three unchanged heavy History quota cases retain separate earlier
evidence and were explicitly filtered here. All captured/guarded inputs remain
unchanged and the publisher fixture's observed processes are gone.

See the [v14 checkpoint](../VERIFICATION.md#previous-v14-combined-integration-checkpoint--2026-10-15)
for exact binary, test and publishing receipts. Native baseline passes all 13
groups with an explicitly declared passive failure-observer variant and
unchanged assertions; all owned processes exit. Native History fails after
four groups: a hidden zero-size PDF scroller replaces its canvas while editor
and workers remain intact. Original and diagnostic failures are retained; a
viewer repair and new matched native qualification remain pending. Native
diagnostics confirms the same canvas replacement when logs hide the preview,
after passing real report/provenance and last-good-byte checks. Its later
groups remain unrun. Focused viewer regressions establish a source fix; they
do not replace the required new native qualification.
The corrected synthetic PDF fixture preserves historical-preview export denial,
and observed local 999% zoom does not widen remote commands. Older source,
runtime and package receipts remain historical to their named captures. Full
native/installer, parity, lifecycle, live integration and resource gates remain
open; the delivery goal stays active.

## Native tree and acknowledged App controls, 2026-10-15

The next immutable snapshot, `artifacts/qa-final-tree-v3/`, contains 205 source
files and 13 frontend assets. Its inventory receipt SHA-256 is
`cf1d2cbd07baccc880fd0ac2ebf2c0594e130c991da29b2b21bd89948b56a641`.
Desktop SHA-256 is
`808436aa2667b2d68753448a6c9c7beacdc0ef3eeb5d9fcc758f8f915b9f5085`;
service/CLI SHA-256 is
`26fe7e9539f6cd5a0fb1b8b1b92c641f374d19e64cf4e37524c9c4d7ff1c7cd4`.
The matching backend passed 113 Rust tests with real Typst and strict Clippy;
the copy passed architecture validation and 148 focused frontend tests.

Actual native checks passed: 13 editor/CLI/window checks, the five-case App
baseline and a controlled pending read across Restore. The latter held a real
Review response across final native checks and acknowledgement, with an applied
receipt, X11 Normal state and unchanged source/policy bytes. Local Review is now
genuinely read-only and refuses pending journals; explicit local Open retains
recovery. Harmless reads no longer veto presentation effects, while pending
Open/writes and editor revision/generation/navigation/queue/IME guards remain.

Two additional real native Close cases passed. Holding the actual successful
completion reply kept the window alive without saving; releasing it closed the
window, revoked the local authority and removed discovery. Revoking the App
grant before releasing completion produced an actual native `scope` error,
kept the editor usable and preserved its normal OS-close save guard. Receipts
are under the copied snapshot's `artifacts/native-{ui,app-controls,safe-read,close-clean-v2,close-revoke-typed}`
locations; `native-ui-evidence.json` is directly under `artifacts/`.

The tree browser gate passed six real-service scenarios: nested sources, empty
folders, binary assets, bounded/non-Unicode inventory notices, dirty-buffer
creation/refresh with undo preserved and no save, IME/missing-parent refusal,
stale inventories, canceled late creation/project switching, reload and actual
Pretext at 1100×480 and 320×900 with 200% text. Passing artifact runner SHA-256
is `f17afb1a6e4093cfb67c1f101665743bd9473ad8f061529c405ef9b0191d83df`;
`artifacts/project-tree-smoke.json` has SHA-256
`9dbc681aa71bf54d726e9177d9bc1629fa3124d2297ed16a3dfdc0676261d5a7`.
Its cleanup used visible File → Save after the original uppercase shortcut
failed. A separate actual-key probe proved `Control+S` emitted `key:"S"` and
no save, while `Control+s` saved. The subsequent case-normalization fix and its
regressions are outside this runtime and need a fresh build.

The stronger App browser gate also passed actual private-to-shared Open,
non-BMP UTF-16 selection, font/wrap/panes, painted three-page PDF navigation,
zoom/fit, unshared-main PDF redaction, old-job/capability revocation and an
inactive dirty private buffer blocking Open/Compile/Close with zero source
Save or editor-commit attempts. Source and policy bytes stayed unchanged.
Runner SHA-256 is
`1b89d2f4688f86daf0541b0cd0b9fce3acde2533189941f32a59d2015f520ece`;
structured receipt `artifacts/coordination/mcp-v3-browser-evidence.json` has
SHA-256 `6fe5ac203993b3b21c8b443a9d1f01266fbbb8113051beb19bd5410e81af2425`.
Earlier computed-wrapping and post-regrant busy failures remain recorded; the
successful run used local settling without replaying uncertain commands.

An unsigned Linux installer checkpoint is being rebuilt from a separate copy
of these inputs, with the shortcut limitation recorded. New PDF-export
permission/download work, general file import, rename/deletion, project export, live
ChatGPT/zrok, other platforms and full rendered Overleaf parity are not proved
by this snapshot. All remote transport tests here simulate the zrok child.

## Combined native editor/App snapshot, 2026-10-15

The immutable `artifacts/qa-final-app-v2/` capture contains 201 authored source
files, 13 built frontend assets and both root-built Rust debug executables. Its
inventory receipt SHA-256 is
`3e6e881a7bd3e1b6e5877f0b7dfc40ade53ab5454fa035f1ae17c8df34e08f76`.
Desktop SHA-256 is
`ae8d56ea1f31cfc8ed0f51e317880746e036a072d77bc103298ca031d51eba13`;
service/CLI SHA-256 is
`2ecdc6eca213d15a07c7aa3379562f0f333cfcf7ec990d59ed8ab62a1827a928`.
The source guard refused the first capture after concurrent documentation/test
changes. A refreshed fingerprint, successful warm build and unchanged-input
guard preceded this private copy. Shared installed dependencies remained frozen.

Architecture validation and 145 focused frontend tests passed on that copy.
Its actual Linux Tauri gate passed 13 checks, including the named CLI saving a
dirty registered native editor after a real denied autosave, durable replay,
retired-page/raw-save/anonymous denial and shutdown revocation. Receipt:
`artifacts/qa-final-app-v2/artifacts/native-ui/native-ui-evidence.json`, SHA-256
`3851597c0f30e8e72c4417111d4afaacfb9500ce0b80e4b10bdf415ef1860977`.

A separate authoring run passed all eight checks against this exact copied v2
service and its matching assets. The frozen runner SHA-256 is
`bf8143ea9875f22d65c9a596cbe77a402171b684df028fc5abaf951080b6afa7`;
receipt `artifacts/qualification/authoring-combined-v2/artifacts/reverse-engineering/typst-authoring/evidence.json`
has SHA-256
`bfbfd26f4a23dd15dc4ccb6d948679f2bd927dea3f7f0cbc206daafe2185d4f0`.
It records the exact HTML/CSS/JavaScript identities, including manuscript
JavaScript SHA-256
`379cc3f6d938b9353c49b59c2c27674b2b0ba190a1c9317168bc0c564f3676b4`.
Real insertion, literal-source syntax styling, independent undo/redo, placeholder
typing, seven menu actions at 320 CSS px and 200% text, HTML refusal and real
Typst PDF output passed with zero page errors. This qualifies local authoring
with the v2 editor session; it does not qualify App permissions, native OS IME
or later builds. The earlier C4pf authoring receipt remains separate and
unchanged. The v2 service, three named assets, runner and receipt were rehashed
when this entry was reconciled; no old result was relabeled as a current run.

The real local MCP App browser gate and existing Connections gate passed
against the copied service/assets. App checks cover a separate explicit grant,
the unchanged three-tool Review catalogue, acknowledged presentation/selection
actions, saved Typst compilation, source/policy byte preservation, private-ID
filtering, dirty-buffer no-autosave denial and independent revocation. The App
artifact runner SHA-256 is
`668cbd82ebf2f2df5f6e56e7dbc523b22ad25eb1e2a3982e175b2a8f20941a44`;
logs are `artifacts/coordination/mcp-app-controls-v2-diagnostic.log` and
`connections-ui-v2.log`. Earlier attempts remain recorded: the original fixture
incorrectly assumed read-only Open created a policy sidecar; a policy-seeded
attempt encountered an explicit busy rejection. The successful runner seeded
policy through local setup and used bounded, gentler receipt polling. It did
not replay uncertain commands. The corrected checked-in baseline runner has
SHA-256 `f7fd410d6f42958c4557b516a971687de118bd6e3fc153ed9ada508833d9fae2`;
later stronger assertions need their own execution evidence.

Native App qualification remains incomplete: native view/minimize/restore/focus
were exercised, but a native action can be rejected after affecting the window
when background reading overlaps its acknowledgement. A focused native probe
recorded `busy` after X11 already showed the window minimized; it did not reach
its intended Restore overlap case. A later native attempt also exposed a fixture
race with the ordinary delayed automatic build's own save retry after permission
restoration. These are separately diagnosed; neither is hidden by the browser
pass. The pending read-only Review/guard fix and new native file-tree work are
outside this captured runtime. Inactive dirty-buffer, retained unshared-main PDF,
actual rendered effects and clean/lost-ack native Close coverage are being
strengthened. zrok is simulated in these gates; live ChatGPT/public routing,
installer refresh, other platforms and complete rendered Overleaf parity remain
unqualified.

## Delivery orchestration reference

On 2026-10-15 the user requested a final-product delivery goal and continuous
specialist delegation using ChatDev 2.0. The official
[OpenBMB/ChatDev tree at `4fb2db0`](https://github.com/OpenBMB/ChatDev/tree/4fb2db0ea90375ce1059f44fe03ffbd191a7a169)
was downloaded to ignored `artifacts/chatdev/upstream/`. The unchanged
`yaml_instance/ChatDev_v1.yaml` has SHA-256
`fad693b89f06e0f4e075c98b14d81988c19a547593e1a93ae95b758ac58f13c1`;
the inspected `docs/user_guide/en/workflow_authoring.md` has SHA-256
`ece91774b1cfbaacb0f21ecb4dd32c6dbd57568a58737c96800a292527a4c9a5`.
The software graph contains planning, implementation, review, testing and
documentation loops. [The delivery workflow](workflows.md#chatdev-20-delivery-orchestration)
adapts those responsibilities to the live Codex orchestrator and specialists;
the separate DevAll server/model runtime was not executed or installed into
UnderTree.

The user's Respy 2.0 reference was resolved to the public
[Respyra 2.0 tree at `78505d1`](https://github.com/GeorgeFejer91/respyra-2.0/tree/78505d11acd174c2310ea8b0e069c6df03536026).
No ChatDev workflow or mention was found in that downloaded tree. Its
`for-ai/WORKFLOW.md` was inspected, but the exact earlier ChatDev configuration
is unverified; do not claim an identical saved workflow was reused.

## Public-source references

Overleaf's public tree was retrieved at commit `e039ad26c5bf5422eb57b89fc7e57c75055e631d` (the tree inventory reported `truncated: false`). Initial inspection read the focused source files below and the license; the later rendered reference used the complete pinned source tree without claiming a complete audit. The retrieved license is GNU AGPL v3. UnderTree independently implements the observed concepts and copies no Overleaf source or assets into its product.

The commit and complete tree inventory were independently rechecked during the user's requested one-to-one color/layout comparison. The focused styles and layout sources below were read and cached outside the repository; this extends the earlier review inspection without establishing upstream runtime/pixel equivalence.

### One-to-one color and layout source comparison

| Surface | Immutable upstream source observation | UnderTree mapping |
| --- | --- | --- |
| Palette | [Foundation colors](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/stylesheets/foundations/colors.scss#L12): chrome `#1b222c`, toolbar `#2f3a4c`, divider `#495365`, muted `#677283`, secondary `#afb5c0`, light `#f4f5f6`; green action/hover/selected `#098842` / `#1e6b41` / `#195936`. | The previous `src/styles.css` foundation matches these values exactly. Use these tokens in the active manuscript shell. |
| Project bar | [Toolbar geometry](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/stylesheets/pages/editor/toolbar-redesign.scss#L25): 40 px bar, 32 px home control, 24 px mark, 28 px menus; project title between menus and right actions. | The legacy topbar is already 40 px; restore its compact dark hierarchy within the custom native frame. |
| Rail | [Rail styles](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/stylesheets/pages/editor/rail.scss#L61): 40 px rail, 32 px buttons and 4 px gaps. | Preserve rail geometry and independently drawn SVGs with separate centered slots. |
| Workspace proportions | [Main layout](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/js/features/ide-react/components/layout/main-layout.tsx#L47) and [rail panel](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/js/features/ide-react/components/rail/rail-panel.tsx#L37): rail/sidebar followed by editor/PDF group, initially 50:50; sidebar starts at 15% and supports collapse. | Use the familiar file/editor/preview arrangement. Legacy 292 px sidebar/47% source are approximations; stored pane sizes/configuration affect the comparison. |
| Review default | [Rail defaults](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/js/features/ide-react/context/rail-context.tsx#L60) and [review rail gate](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/js/features/ide-react/components/rail/rail.tsx#L125): Files initially selected; Review availability follows a feature flag and replaces Files when selected. | No permanent extra review column in the default workspace. Exact Files/Review alternation and deployment feature availability need explicit qualification. |
| Splitters | [Resize styles](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/stylesheets/pages/editor/ide.scss#L233): 7 px side-by-side resize handles, 6 px vertically stacked handles. | The legacy horizontal-layout handle is 6 px; record or correct that difference rather than calling it exact. Preserve keyboard resizing. |
| Tree and tabs | [File tree](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/stylesheets/pages/editor/file-tree.scss#L1) and [tabs](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/stylesheets/pages/editor/tabs.scss#L1): dark hierarchical tree, green selection; 36 px tab row, selected primary-background tab and upper corner treatment. | Use dark navigation/tab chrome; leave source content white under the selected comparable editor theme. |
| Preview chrome | [PDF styles](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/stylesheets/pages/editor/pdf.scss#L1): `#2f3a4c` surroundings, 32 px toolbar, green compile action and page/zoom controls. | Recompile belongs in preview chrome. Legacy `#3a4557` PDF surroundings are close but differ from this pinned source. |
| Typography | [Foundation typography](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/stylesheets/foundations/typography.scss#L3) and [toolbar sizes](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/stylesheets/abstracts/variables.scss#L1): Noto Sans interface, common 14 px/20 px text; 40 px primary and 32 px small chrome. | Reuse the legacy interface font stack, retaining separate user-owned editor typography and readable reflow outside reference dimensions. |

These are static source observations. Themes, fonts, stored pane state and enabled features still need matching in paired runtime captures. The earlier complete-source inventory does not mean every repository file was analyzed.

### Rendered upstream component reference, 2026-10-15

PARTIAL: the pinned Overleaf source was rendered in Chrome 155 with its unchanged MainLayout, SourceEditor, PDF.js components and Sass. The fixture uses public EditorProviders, mockDoc and SocketIOMock with declared metadata/backend responses. All 6,330 tracked source blobs matched the immutable Git inventory. Six original-handler checks passed: edit/undo, File menu/Escape, Find, pane drag, PDF pages/zoom and collapse/reopen. No runtime errors or undeclared fixture requests were observed.

Paired UnderTree production captures used an isolated real Rust service and Typst 0.15.1 at 1600×1000 and 1100×800. The initial measured upstream geometry was a 40 px header/rail, 232.95 px sidebar, 656.52 px editor/PDF panes, 36 px tabs, 32 px source/PDF toolbars and 12 px/19.2 px source typography. UnderTree's merged desktop PDF toolbar matches the 32 px row. Remaining appearance differences are recorded in the fixture receipt; later UI edits require refreshed captures.

The refreshed component comparison reverified the pinned source and reproduced the same upstream assets, then exercised six original and six UnderTree handlers: editing/undo, menus/Escape, source search, pane dragging, PDF zoom and collapse/reopen. Paired initial/File/search captures at both sizes confirm toolbar/gutter tokens, 12 px/19.2 px type, 232.94/157.94 px responsive sidebars, matching preview edges and outline positions within 0.5 px. The refresh receipt is `artifacts/reverse-engineering/overleaf-e039ad26-component-reference/refresh-2026-10-15/evidence.json`, SHA-256 `965797e450221163216ab4eae983fea4ad1e6fc9a293fa46bcd26664edc60468`. Later PDF percentage/zoom changes have fresh module/browser zoom checks and a native check of the rebuilt bundle; this reference capture predates those final bundle changes. The later revision-aware PDF receipt fix has its own delayed-response browser regression; the retained native receipt predates that final fix.

The upstream three-page Cypress PDF is a separate prebuilt fixture, not a compilation of the short comparison source. Persistence, compilation, a live Community Edition backend and upstream review cards were not qualified. Full visual/interaction parity is not established. The local receipt/captures are under ignored `artifacts/reverse-engineering/overleaf-e039ad26-component-reference/`; the receipt SHA-256 is `16681e8a9b751d8e2d59b59349b909ab29c472a8e2b01467e85125d322c74765`. Reproduction uses task-specific Yarn cache/global folders; the original dependency preparation also created user caches, recorded in the receipt. Generated evidence is not included in a fresh clone.

| Observation | Source at the inspected commit | UnderTree mapping and boundary |
| --- | --- | --- |
| Review cards show additions/deletions or paired replacements and offer permission-dependent accept/reject actions. | [review-panel-change.tsx](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/js/features/review-panel/components/review-panel-change.tsx) | Original proposal cards beside the editor; Rust alone applies a locally accepted replacement. Overleaf's operational-transform model is not adopted. |
| Review UI selects current-file or overview subviews. | [review-panel.tsx](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/js/features/review-panel/components/review-panel.tsx) | A focused current-manuscript sidebar. A project-wide review overview is not qualified. |
| Selected-source ranges determine which tracked changes are accepted/rejected. | [use-tracked-changes-actions.ts](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/js/features/review-panel/hooks/use-tracked-changes-actions.ts) | UTF-16 source selections, quoted anchors and explicit card decisions. UnderTree validates the revision and policy at each acceptance. |
| Review entries are sorted by source position and positioned around the focused entry while avoiding card collisions. | [position-items.ts](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/js/features/review-panel/utils/position-items.ts) | Source-linked review cards are the target; exact Overleaf card geometry and collision behavior have not been reproduced or qualified. |
| Editing/review/view mode availability follows permissions and track-change capabilities. | [review-mode-options.tsx](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/js/features/ide-react/components/toolbar/review-mode-options.tsx) | Local author and remote reviewer have separate authorities. Remote agents always submit suggestions; there is no remote direct-edit mode. |

Secret Tunnel's public [native process supervisor](https://github.com/GeorgeFejer91/SecretTunnel/blob/main/app/src-tauri/src/process.rs), [commands](https://github.com/GeorgeFejer91/SecretTunnel/blob/main/app/src-tauri/src/commands.rs), and [settings](https://github.com/GeorgeFejer91/SecretTunnel/blob/main/app/src-tauri/src/settings.rs) were inspected for its zrok2 child lifecycle, reserved public share invocation and local configuration. These references were fetched from main without a retained immutable commit identity. UnderTree's independent adapter uses those process concepts with a substantially narrower review-only tool catalogue; it does not depend on another checkout at runtime.

The repository-local [REA skill](skills/reverse-engineer-anything/SKILL.md), pinned with [its provenance](skills.md), explicitly routes ordinary complete-source analysis through normal repository tools. Apply it through [the UnderTree reverse-engineering protocol](PROTOCOLS/reverse-engineering.md). The nested For-AI and REA instruction snapshots document the investigation workflow; their presence establishes no MCP connection, provider availability, runtime observation or behavioral parity. Record those outcomes only after the corresponding investigation and acceptance gates.

## Typst document outcomes and editor-action audit, 2026-10-15

The user requested an active goal to deliver Overleaf's expected UI actions and equivalent Typst document outcomes, with additional UnderTree abilities. [The product acceptance scope](product-goal.md#publishing-and-ui-acceptance-scope) is the requirement owner. This is a bounded implementation/qualification milestone; complete Overleaf parity and the delivery goal remain open.

Source observations use pinned Overleaf `e039ad26c5bf5422eb57b89fc7e57c75055e631d`: [latexmk/compiler behavior](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/clsi/app/js/LatexRunner.js#L164), [source/PDF navigation](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/clsi/app/js/CompileManager.js#L500), [menu actions](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/js/features/ide-react/components/toolbar/menu-bar.tsx#L88), main-document settings and clickable diagnostic hooks. Five selected files matched fetched upstream bytes. The source-only checklist is `artifacts/reverse-engineering/typst-overleaf-engine-parity/source-checklist.json`, SHA-256 `990639056a6ac280fc959a13af4c769e0d7080bb4d98050c8ee56ff376d5a38a`. It records the boundary before this implementation, not a live Overleaf/backend observation.

The [official Typst migration guide](https://typst.app/docs/guides/for-latex-users/) and [bibliography](https://typst.app/docs/reference/model/bibliography/), [PDF](https://typst.app/docs/reference/pdf/) and [HTML](https://typst.app/docs/reference/html/) documentation establish the language's distinct syntax/ecosystem and supported outcomes. Literal LaTeX package/class compatibility is not implemented; HTML/bundle export is not qualified by UnderTree's PDF path. The REA protocol correctly routed complete-source work through repository tools, then used direct compiler/service/browser/native probes. No REA MCP provider, decompilation or authenticated Overleaf session was used or installed.

VERIFIED: `UNDERTREE_TYPST=/home/Zuri/.local/bin/typst UNDERTREE_TEST_FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf npm run test:typst-publishing` passed 20 checks, zero skipped, through the real Rust API and Typst 0.15.1, with `UNDERTREE_REVIEW_BINARY` selecting the copied service below. The invocation's workstation paths are local qualification inputs, not product configuration. The authored `examples/typst-parity/` fixture produced three A4 pages; PDF.js checked imported/included prose, footnote, Greek glyph, raised exponent and stacked fraction, outline/internal destinations, resolved labels/citations, bibliography text, SVG color/paths, table cells/captions and external link. A rendered page was separately inspected, without an Overleaf visual-equivalence claim.

The gate also verified byte-identical last-good retention for syntax/missing-asset/root-escape/cold-package failures; changed chapter/bibliography/SVG stale/rebuild/exact reversion; persisted successful warnings; real copied DejaVu font identity and freshness; linked fonts unavailable to the compiler; cached local package output with `externalDependencyCount >= 2` and `current: false`; ordinary and timestamp-preserving dependency changes after staging retaining the copied bytes with a stale receipt; static file/directory symlink read/include attempts disclosing no outside marker in diagnostics; live main/dependency replacements with outside symlinks leaving the safe copied PDF available and stale; and a sparse unused input above the whole-project 128 MiB limit failing before compilation while retaining the last-good PDF. The final cleanup check found no owned input-stage residue in private service state after the successful and failed builds. TeX import kept originals and reported unsupported math, citations/references, figures/tables and custom macros; its readable raw output is not equivalent typesetting. The archived receipt is `artifacts/qualification/typst-publishing/b070ef51cfdaee9cc8a2c2ebc8e1999b980cdd21199dd9b65fd422245643bb9f/evidence.json`, SHA-256 `b070ef51cfdaee9cc8a2c2ebc8e1999b980cdd21199dd9b65fd422245643bb9f`, service binary SHA-256 `8f9af47f53d32b7af678532da6a9a72e41dcb7e7302b00b28bdd56ae55b89352`. Compiler-only dependency/warning/package probes are retained separately in `artifacts/reverse-engineering/typst-publishing-audit/compiler-dependency-probe.json`, SHA-256 `f4fe333187582a24b5039d94ce8a2de2183f580e048fe3d7e9e1e35153c1c408`.

Implementation owners remain `modules/review/` for native main settings, confined bibliography/data editing and publication; `modules/frontend/` for revision/save coordination; and `src/manuscript.js`/`manuscript.html` for the existing menus, main-target preview/export and warnings. The Review catalogue remains exactly list/read/suggest. A refresh that observes an in-flight local acceptance may clear its obsolete conflict only when the eventual response's exact content/revision matches and no typing occurred. Focused regressions preserve different external conflicts and newer typing. Formatting transactions now isolate history from adjacent typing; real CodeMirror cases cover Typst/HTML inline/block undo/redo, CRLF and Unicode. The PDF viewer publishes new scale geometry before assigning scroll, preserving explicit page intent through resize without clamping to the old document height; browser-style unit fixtures cover page 10, deferred newer jumps and genuine scrolling. Shared page normalization truncates decimal page requests and rejects nonfinite state, so page/toolbar/canvas navigation remains on integer pages; focused viewer/state tests passed 23 cases. The page-number field is not overwritten while focused during resize. A separate real-service diagnosis confirmed editor preferences preserve Undo; the prior fixture read disk before asynchronous Save completed. Its corrected check waits for the authoritative saved receipt.

The latest scoped checks passed 102 Rust tests with real Typst and 81 focused frontend tests, strict review Clippy, architecture validation and a Tauri custom-protocol compilation check. The frontend was built into an owned output directory and the service copied before qualification; binary/assets and source changes during the build are recorded in `artifacts/qualification/typst-parity-build/staged-3ibnrh67/build-evidence.json`. This binds the tested runtime without claiming an exact repository-commit build: concurrent App control/transport source changes are listed. Workspace formatting and diff checks passed after the concurrent edits were formatted. Earlier Tauri/native receipts remain historical until a matching native gate passes. A dedicated CI job now installs pinned Typst and an explicit font fixture, runs Rust/publication checks and uploads evidence; hosted CI execution is NOT RUN in this milestone. Generated PDFs, captures and receipts remain ignored local artifacts, unavailable from a fresh clone until the gates are rerun.

VERIFIED: the final `npm run test:review-ui` gate passed against the same copied service `8f9af47f53d32b7af678532da6a9a72e41dcb7e7302b00b28bdd56ae55b89352` and owned frontend (`manuscript-LmQWsa5h.js`, SHA-256 `b4ff1c6574c89488ee03f5bd66a4792c6252682579ee13a192e077fcf3b1f0bf`). Result `artifacts/reverse-engineering/typst-overleaf-engine-parity/review-ui-snapshot-undertree-review-ui-4tMwcm-result.json` has SHA-256 `9f844d58325ebf02c8a0b1b1601978a3a122b0304f32e472be9414985e836d9b`; its immutable runtime/runner snapshot has SHA-256 `9329e55922cba6b758d9f5be82e771a9f0afaaf4d78ae2e221a3daf664dd3738`. It exercises main/bibliography/F5/reload, successful/cached warnings and PDF names/downloads, dirty/new dependencies, delayed chapter acceptance followed by a new main compile, external conflicts, failed-build last-good retention, adjacent-typing formatting/math Undo, page-number draft preservation during resize, fractional page input/Next/Previous, exact CRLF save receipts, preferences, synthetic composition/authority/revocation and reflow cases. Fixture checks now await authoritative save/acceptance/new-compile outcomes rather than reading old status labels; the selected binary/assets/runner stayed fixed. Real Rust/Typst were used; zrok and final autosync were simulated. This is browser integration evidence, not native-shell, live public ChatGPT/GitHub or full paired Overleaf qualification.

Before staging was added, a real-service confinement audit exposed a gap: Typst 0.15.1 follows project file/directory symlinks outside `--root`; failed `panic(read(...))` can disclose outside bytes in diagnostics before the existing post-build dependency rejection. The harmless-marker receipt is `artifacts/reverse-engineering/typst-publishing-audit/symlink-boundary-probe.json`, SHA-256 `c5b7f9249ab33d9daab87a3d9b741ff9aefeb1ca372dee6badaf87076bdad012`. The archived 20-case service fixes that project-input disclosure with a private staging root. Pinned `cap-std`/`cap-fs-ext` 4.0.3 supply rooted no-follow handles for copy and freshness reads; copied-byte hashes bind compiler dependencies. Reserved and noncanonical main paths fail before reads. The blocking preparation owns the compile guard through cancellation. Normal/error/cancel cleanup is implemented. The 128 MiB staging budget covers copied input bytes; 16 MiB PDF and 256 KiB dependency limits are post-compiler admission limits, not hard temporary-write quotas. Abrupt-crash residue, atomic multi-file snapshots, external package/embedded/system-font provenance and OS-wide compiler sandboxing remain separate requirements.

A preceding scoped Linux native run passed 12 checks with real Rust IPC, Typst and bundled WebKitGTK, including private CLI discovery/read-only denial, UTF-16/CRLF, source save, typing during compilation, PDF revision/canvases, automatic follow-up, 320 px/200%/short-height reflow, Minimize/restore, failed-save OS Close and successful protected Close. That invocation recorded receipt SHA-256 `6c3af789685ab7fdacb06f695902e215c7a34ff1024ec2681924aa78c1d64c9b`, desktop binary `1c4da09a9535fcdfcc2182234fb89a708a9df91da4ffbe980ef238b88d40e430` and CLI `77dd724b4dc54a3cbafb40d4fcb06a7c97340ac55dd013720068b1a9d38e0ae6`. Its mutable receipt path was subsequently overwritten by a failed run; the historical pass does not qualify the newer binary. The new custom-protocol build (`a6decb3027ca568e0566f3f7532a712ea34d09c649c324065613a989785dcef8`) stops at the prior read-only CLI capability assertion after another active chat introduced editor-save coordination. The failed receipt is `artifacts/qualification/typst-parity-native/0332131e14a3953ab7e9cefb43b03bd0455d1615f754b6b0938c192c054078a2/native-ui-evidence.json`, SHA-256 `0332131e14a3953ab7e9cefb43b03bd0455d1615f754b6b0938c192c054078a2`. The new CLI/editor contract and newest native frontend require coordinated qualification; no assertion was weakened to claim success. Other platforms/installers remain separate gates.

Still PARTIAL: complete paired-state Overleaf appearance/interactions; complete Insert/Format and source syntax/visual editing coverage; file/folder rename/move/duplicate/recoverable deletion and binary asset upload; source ZIP/history/word count/settings coverage; clickable diagnostics and full source/PDF navigation; additional export formats/PDF standards; publisher templates and broad importer fidelity; non-content App control prerequisites/live ChatGPT and remaining platform/package gates. A fixture pass is not proof of all document/UI combinations. Project output now binds copied bytes, including timestamp-preserving edits in the fixture; this is not an atomic project filesystem transaction. System/embedded fonts, external packages, temporary compiler-write quotas and crash-residue bounds still need qualification. The active goal must remain open for those requirements.

## Observations, inferences and open qualification

UI direction, clarified 2026-10-14: [near-identical open-source Overleaf appearance and interaction](overleaf-ui-parity.md), [outside-in accordion stretch and overflow prevention](ui-layout.md), and an original UnderTree native boundary with custom Close/Minimize icons are mandatory. Recording these requirements does not qualify the current workspace.

The manuscript workspace implements hierarchical files with the outline below the tree, six menus, local Typst/HTML formatting/search, draggable and collapsible panes, source-linked collision-aware review cards, pending/new proposal cues and local stale-highlight reanchoring. File sessions retain caret, undo and scroll; delayed file/project/PDF responses cannot move those states into another session. The merged preview toolbar uses CSS-normalized PDF percentages, reciprocal 1.25/0.8 zoom steps and a 10%–999% range. Rendering covers the visible pages plus adjacent overscan, bounded by 128 live canvases, nine million total integer backing pixels, 32,767 pixels per canvas dimension and 1,000 cached page sizes. Browser, native and GitHub gates below qualify these observed workflows; complete reference control/icon sets, full Typst language support/visual editing, review overview, persisted pane layout and complete paired-state parity remain open.

Secret Tunnel comparison used the local `SecretTunnel-v2` source snapshot's `app/src/styles.css`, `app/src/ui-layout.ts`, `app/src/ui-pages.ts`, and `app/scripts/smoke-ui-layout.mjs`. Source observed: full-height ordered groups with `space-between`, wrapped control rows, isolated icon/label slots, font-gated shared Pretext measurement with a bounded cache, DOM-preserving presentation pages, and rendered overflow checks. No immutable identity was retained for these working files and no new sibling runtime check was run. Its additional global no-scroll/paging policy is broader than the accordion skill's bounded-panel contract. The source review did not establish two-axis adaptive font/gap budgets; those remain UnderTree requirements to implement and qualify. See [the existing local reference analysis](BOARD/2026-10-14-secret-tunnel.md) for the related protocol/process snapshot and recorded file hashes. These source references are orchestration context, never a runtime dependency on another checkout.

| Scope | Evidence type and current conclusion | Still requires direct qualification |
| --- | --- | --- |
| Overleaf visual/interaction parity | PARTIAL pinned component reference and paired initial/File/search captures at 1600×1000 and 1100×800; six upstream and six UnderTree handlers passed. Fresh measurements confirm source toolbar/gutters, proportional sidebar, preview edge and outline placement within 0.5 px. | Full Community Edition/backend/review qualification, complete supported state comparisons and resolution of remaining control/icon/source/visual/status differences. Complete parity is not established. |
| Restored palette and default workspace | Source and rendered UnderTree observed: the active stylesheet uses the pinned foundation colors and Noto Sans stack; a real Rust/Typst default capture in `artifacts/overleaf-palette-default.png` has charcoal bars/tree/rail, white source and paper on `#2f3a4c`, green Recompile, Review closed, 40 px topbar/rail, 36 px tabs, 32 px source/preview toolbars and 7 px splitters. Editor/PDF widths were 662/663 px within their remaining region. | This verifies UnderTree's source-matched tokens/geometry, not a paired upstream pixel comparison. Review sidebar alternation, icon geometry and complete interaction/state parity still require comparison against a matching rendered Overleaf configuration. |
| Outside-in accordion stretch | Required standard under [ui-layout.md](ui-layout.md). Expanded browser qualification covers width×height, 200% text and text-spacing chrome. The final Linux WebKitGTK snapshot passes bounded controls at 320×900 and 1100×480 with 14/28 px root text; source height remains positive. Secret Tunnel source supplies selected layout/measurement patterns. | Broader locale/font/regrowth cases, complete panel/state matrix and other target WebViews. These observed cases do not qualify every possible string, panel or platform. |
| Rust review authority | VERIFIED 39 Rust tests and the current real-service browser gate: revision/UTF-16/prose/quote/protection checks, proposal-only MCP, local acceptance and metadata-only reanchor preserving IDs/rules/prompts. Native CRLF/emoji selection matched the persisted UTF-16 quote without changing source bytes. | Broader manuscript cases and all other native review interactions remain separate qualification. |
| Typst source authoring | VERIFIED 17 language tests, nine insertion tests and eight real Rust/Chrome/Typst 0.15.1 authoring checks. Common markup/code/math/raw/comment syntax receives presentation-only styling; seven Insert actions preserve surrounding CRLF/Unicode source, select editable placeholders and isolate undo/redo. Actual typed math, bibliography, reference, hyperlink, SVG and table content appears in the compiled PDF. HTML disables Typst-only commands; 320 px menus at 100%/200% text use actual Pretext measurement. | Insert actions target markup, not arbitrary code/raw contexts. Highlighting is approximate with a 64-context fallback; completion, folding, native/OS IME and full source/visual parity are not established. |
| Typst publication | Source observed: `publishing.rs` supervises external `typst compile --root`, bounds output/time and retains the previous good PDF on failure; `typst-syntax` checks prose scope. Browser and real Linux Tauri/WebKitGTK runs compiled with Typst v0.15.1 and rendered PDF.js canvases; source hashes matched native PDF metadata. Browser checks preserve the last good PDF on failure and reach all ten fixture pages within the backing-pixel budget. | Platform package qualification remains open. An embedded full Typst engine is not implemented. |
| TeX import | Source observed: `tex_import.rs` converts a bounded subset and emits warnings. Runtime observed: the review UI smoke exercised import into a new Typst source and verified the TeX original is preserved. | Representative manuscript fidelity and broader math/macro/package support. Exact formatting equivalence is not claimed. |
| zrok MCP | Source observed: three remote tools, session-only shared manuscripts, capability URL, supervised `zrok2`, no browser-Origin requests or local action proxy. Runtime observed: the UI smoke exchanged real MCP requests with the Rust listener using a simulated zrok2 process and exercised the scoped tool paths. | An actual enabled zrok2 reservation, public endpoint reachability, ChatGPT web tool discovery/use and revocation from that live client. The simulated tunnel proves local protocol behavior only. |
| Non-content App controls from ChatGPT | The 2026-10-15 user correction prohibits full file editing, superseding the prior direct-edit target. [The App control plan](PLANNER/CHATGPT-FULL-CONTROL.md) excludes remote source/tree/policy mutation, saves and implicit autosave. Review stays exactly three suggestion-only tools; App controls require a separate explicit session capability and no-save UI hooks. | Integration and real ChatGPT qualification remain incomplete. Local CLI/editor save coordination does not grant MCP save authority. A queued action, mock tunnel or catalogue entry does not prove actual UI/native application. |
| GitHub project sync | VERIFIED against authenticated GitHub with `tests/live-github-sync.mjs`: native checkpoint push, rendered browser autosave/autosync, clean incoming fast-forward, and remote-conflict preservation with autosync paused. Exact committed source/sidecar trees and remote heads matched the receipts; the disposable branch was conditionally removed and its absence verified. | Broader repository/credential/platform cases remain unqualified. The receipt identifies the observed service/frontend build; later UI changes need their own checks. |
| Repository visibility | Observed integration: GitHub CLI installed and authenticated as `GeorgeFejer91` via Chrome device flow; `gh api` set `private=false`, `gh repo view` confirmed `PUBLIC`, and an unauthenticated GitHub API lookup independently confirmed public visibility for [GeorgeFejer91/undertree](https://github.com/GeorgeFejer91/undertree). | Publishing the implementation branch/PR is a separate Git operation; public visibility alone does not prove source synchronization. |
| Desktop/CLI shared authority | VERIFIED with real Linux Tauri and the built Rust CLI: autodiscovery returns the same instance identity as native IPC, reads the desktop-approved inventory, denies anonymous/mutating calls and revokes the old endpoint on exit. Focused Rust integration tests cover duplicate hosts, stale/replaced descriptors, process-death lock recovery, session binding and private-file/symlink checks. The 12-case native receipt is `artifacts/qa-native-2026-10-15/native-ui-evidence.json`, desktop SHA-256 `07bae1f3958b07368efefbf7804b4ebd56887a69eef9aac6b6fd0a1e07e083d3`. | This is an explicitly read-only local CLI boundary. Editor synchronization, the local CLI save barrier/non-content App controls, other OS discovery/permissions and installer qualification remain separate gates. Later frontend or native rebuilds need matching evidence. |
| New-file and import integrity | VERIFIED focused Rust tests preserve existing sources, corrupt/future orphan sidecars, pending metadata, import reports and linked/dangling artifacts; reported publication/registry failures preserve existing bytes and roll back unchanged owned outputs. The local CLI ignores user curl configuration before applying its validated endpoint, with a synthetic two-server regression confirming the session header reaches only the intended listener. | New outputs are individually atomic; abrupt termination between publications can leave a new file without its companion metadata/report. There is no creation-specific crash-recovery journal. Inspect incomplete new outputs before retrying. Existing source-save journals remain in force. |
| Native shell | VERIFIED ten Linux checks with `tests/native-ui-smoke.mjs`: isolated X11, bundled Wry/WebKitGTK assets, exact CRLF/emoji highlight offsets with source bytes preserved, Rust IPC editing/save, real Typst PDF revision/canvases, automatic compilation, responsive typing, Minimize/restore and failed-save OS Close followed by successful custom Close. Native 320×900 and 1100×480 layouts passed at 14/28 px root text with usable source space and centered icons; no frontend errors. | Folder selection, physical display/GPU behavior, OS IME input and Windows/macOS/Linux installers remain separate gates. The current ignored receipt binds observations to binary SHA-256 `db8d2a2b41f45d5aedd95fd54c260fa8b19756f2f993512446fe7451dfc2f990`; rebuilds require refreshed qualification. |
| Original UnderTree window frame | Source observed: undecorated main Tauri window, custom boundary and centered SVG Close/Minimize controls, narrow native window permissions, save-aware close with temporary inert/CodeMirror read-only protection and IME veto. Runtime observed: build/architecture/native Cargo checks and seven focused guard tests passed; browser mode hides native chrome. A separate Linux instance passed drag, double-click maximize/restore, minimize/taskbar restore and actual pointer-edge resizing. Real OS Close preserved a dirty buffer when saving was denied; restoring write permission then using custom X saved that buffer and exited cleanly. Final restored-color native rendering and drag/minimize/restore also passed in an owned private display. | Windows/macOS and installer behavior remain unqualified; full rendered upstream parity remains separate. |
| HTML layout | Browser review gate passed 320–1600 CSS px, independent 480–1000 px height cases, 200% text, user text-spacing, nested navigation, pane controls, search and complete PDF navigation. Actual-module Pretext gate verifies icon-slot budgets, DOM agreement, whitespace/font/locale invalidation, no-fit recovery and preferred-size regrowth. Real CodeMirror typing causes zero root rescans or unrelated chrome measurements. | Full product accordion geometry, other WebViews, fonts/locales and full accessibility remain distinct gates. Synthetic measurement fixtures do not establish whole-workspace or Overleaf parity. |

Update these rows with exact command/results or integration receipts as qualification is performed. Do not replace remaining unknowns with general completion language.

## Integrated verification checkpoint

The current integrated checks passed 39 Rust tests with real Typst 0.15.1, workspace formatting, strict Clippy for the review and Tauri crates, the bundled native debug build, frontend production build and architecture validation. Focused frontend checks include review save/refresh races, source-format transactions/undo, literal CRLF/UTF-16 positions, PDF scaling/stale-load/memory bounds and the Window receiver required by WebKit timers. The full Node suite passed 99 of 102 tests; its three failures are the same pre-change cases requiring the absent `latexmk` executable.

Both rendered browser gates passed against the real Rust service: review highlights/acceptance/custom rules, file-switch undo preservation, queued explicit compilations, real Typst PDF output, TeX import, failed-build preview retention, and the Connections popup's initialization/activity/revocation/failure states. Width/reflow cases include 320 CSS px and 200% text. The zrok child was simulated; these checks establish no live ChatGPT/public-tunnel connection. Local bare-Git fixtures verified exact checkpoints, external-edit/staging rejection and divergence protection; the separate opt-in live GitHub gate additionally verified native/browser checkpoint publication, clean incoming updates and preservation on remote conflict.

CodeMirror states now remain attached to their file sessions across tab switches, with at most 20 open buffers. Close and save failures preserve unresolved buffers. This resolves the earlier source-observed state-recreation gap; it does not establish full Overleaf appearance or interaction parity. That broader acceptance target and the separately documented App control roadmap remain open.

The current native receipt `artifacts/qualification/review-2026-10-15/70313cfb21aac108d59bcb8932a50ae978114654290628c6d0c648efd9662ea9/native-ui-evidence.json` has SHA-256 `70313cfb21aac108d59bcb8932a50ae978114654290628c6d0c648efd9662ea9` and identifies the tested binary above. Real GitHub requalification passed all four paths on a synthetic disposable branch, verified exact source/sidecar trees and heads, then conditionally deleted only its own branch. Its receipt is `artifacts/live-github-sync-73b485f46683dff0.json`, SHA-256 `39225bcbb71809499a2a1e5d49e1b5befcf9a41b35306b5f8f3cbab369b1f6c2`. The current browser gate additionally holds real PDF worker shutdown/Open responses to prove latest-file and separate undo ownership, tests failed project-switch save preservation, and exercises delayed Mark/Palette responses across approved projects with sync intercepted before remote access. The latter proves routing, not a second live push. A fresh isolated indexed build also passed the delayed-compile/autosaved-newer-source regression and `tests/review-buffer-limit-smoke.mjs`: Open/Create/Import stop at 20 buffers before backend work or new files; closing one tab permits each retry while draft/caret/undo and the TeX original survive. OS IME remains unqualified; composition veto checks dispatch synthetic browser events.

### Isolated Typst authoring and viewport PDF checkpoint, 2026-10-15

The isolated indexed frontend passed its production build, architecture validation, all 47 focused insertion/language/PDF tests, the complete real-service review browser gate and all eight `npm run test:typst-authoring` checks. The qualified JavaScript asset is `manuscript-C4pfNK5A.js`, SHA-256 `e73de85f057acf8feb23536e951c7921c7559d65f6ff65b879a8596681622ff5`; the unchanged review authority is SHA-256 `d70471171f62faf6b1f94149e978135c8b1d2c98a46908c260860e75aabb8d3f`. The source and artifact identities are in `artifacts/authoring-qualification-2026-10-15.json`, SHA-256 `543388e911820b7885c2d2266b83a3251e58bf4337184dd550f66872406e8403`. This excludes the newer working App-control/editor-service changes.

The eight-check authoring receipt is `artifacts/reverse-engineering/typst-authoring/evidence.json`, SHA-256 `dc4840998682e6f9cb2f847939792a7f0d78acc6d550ee2df8300e39d496fbad`. Actual PDF.js/Chrome viewport checks paint all eight visible pages at 10% in a 1,000 px preview, with adjacent overscan and 79,632 backing pixels. Extreme portrait/landscape tests enforce the total pixel and per-dimension limits after integer rounding. Extremely tall previews with tiny pages can reach the 128-page cap; offsets outside the 1,000-size cache remain estimated.

These are browser and generated-project checks. The review gate uses a simulated zrok child and intercepted final autosync response; retained native/GitHub receipts predate this authoring bundle. Native authoring, physical OS IME, current App controls, live ChatGPT/zrok and complete Overleaf parity require their own matched qualification.

## UI requirement and frame checks, 2026-10-14 through 2026-10-15

- `npm run build`, `npm run verify:architecture`, `cargo check -p undertree-desktop --features custom-protocol`, and `cargo build -p undertree-desktop --features custom-protocol`: passed on Linux for the custom frame implementation.
- `node --test tests/window-chrome.test.mjs`: passed, seven close-guard cases covering pending saves, blocked conflict/write failures, asynchronous listener removal/newer edits, duplicate native requests, delayed-close freezing, restoration and IME veto.
- `npm run test:review`: passed, three frontend session tests and 30 Rust tests in this run.
- `npm run test:review-ui`: passed against the real Rust service and real Typst CLI, including explicit browser-mode window-control absence, protection/acceptance, queued compilation, import, last-good preview and narrow/200% reflow. The zrok child is simulated; this does not qualify a public tunnel.
- Local Markdown-link validation and `git diff --check`: passed. These documentation checks do not qualify appearance or native behavior.
- Separate owned Linux native instance: drag, double-click maximize/restore, minimize/taskbar restore and bottom-right pointer resizing passed. The autonomous native-close fixture denied writes, verified real OS Close kept the window/dirty buffer and unchanged disk, restored permission, then verified custom X saved and exited with code 0. A separate browser fixture with mocked window IPC and real Rust service checked 1600/760/320 CSS px, 320×480, 200% text, keyboard controls, errors and blocked typing throughout delayed closing. The user's already-running window and folder dialog were preserved. Frame captures in `artifacts/window-frame-native*.png` show the frame before color/layout restoration.
- Palette pass: current `src/manuscript.css` was changed in small context patches, preserving concurrently added navigation, outline, splitter, editor-state, PDF and review functionality. Build/architecture/diff checks and the expanded `test:review-ui` passed. That gate now exercises nested files, resize/collapse/search/menu actions, preserved undo, width×height/200%/text-spacing chrome, all ten PDF pages with bounded canvases/zoom/logs, explicit builds, import and last-good preview against the real Rust/Typst path. The clean default capture above was inspected and its computed source-matched colors/geometry checked.
- `npm run test:connections-ui`: passed after updating the fixture to explicitly open the now-optional Review panel before sharing a manuscript. The gate retains connection setup/failure, MCP activity, per-document revoke, capability rotation, crash revocation, keyboard/focus, real Pretext and 320 px/200% reflow checks. Its zrok child remains simulated; no public ChatGPT route is inferred.
- Final native palette/reflow repair: the first real WebKitGTK check found low-contrast footer errors, invisible selected native values and a zero-height source region at narrow/200% text. CSS fixes preserve native selection, use explicit dark control surfaces and a separate chevron, raise footer error contrast from 2.40:1 to 9.56:1, and route duplicate narrow controls through the existing Menu/Highlight dialog while retaining the collapse action. Browser assertions were retained unchanged. The repaired real Linux WebKitGTK 2.54.0/Wry 0.57 snapshot passes seven native checks, including 1440×900 with the copied `examples/manuscript.typ` and real Typst PDF, 320×900 and 1100×480 at both 14/28 px root text, no page/panel/control overflow and centered frame icons. Source height is 270.52 px at 320/28 and 55.30 px at 1100×480/28; native project/rule values are visible. Drag/minimize/restore pass and the user's existing instance remains running.
- Final native captures/receipt: `artifacts/palette-native-final/native-charcoal-workspace.png`, `native-charcoal-320-200.png`, and `native-charcoal-evidence.json`. Source fingerprints stayed identical before/after qualification. The tested stylesheet SHA-256 is `d87767f7e63729134e0fbb894a8344a1ee76954f3d257236451cacd4f23cda01`; the receipt identifies the other sources and owned native binary. Generated captures/receipts remain outside `For-AI/` and are evidence for this exact snapshot, not for future concurrent edits.

The session used existing temporary Node/Typst toolchains for verification. No compiler, generated capture or executable was placed in `For-AI/`, and no new package dependency was needed for the frame. Full Overleaf comparisons and the complete two-axis accordion stretch matrix remain outstanding.

## Integrated PDF export and native checkpoint, 2026-10-15

VERIFIED on immutable `artifacts/qa-final-pdf-v4`: 214 captured source files,
13 built frontend assets, desktop SHA-256
`5199d1c620c4651aea27f2672903cadb4c47adecfb1565d738124506baada82e`
and service/CLI SHA-256
`124e219448faa6f2e0b28ace8d9ca5215f1f85fb023618920461cdb2a171980c`.
The strict source/build/copy guard passed. Review and desktop all-target Clippy,
native/frontend builds, architecture validation, 119 Rust tests with real Typst
and 156 focused JavaScript tests passed. These counts describe this checkpoint,
not subsequently changed sources.

Browser qualification passed five consent, five real-PDF download and seven
tree/keyboard checks. The PDF fixture builds a shared main document containing
an unshared input. App access alone does not grant PDF export; explicit native
permission covers the selected project root. Exact saved revision/artifact/raw
hash and GET/HEAD bytes match. Wrong identities, new unselected roots and
revoked export/App/share grants deny access. Source/policy bytes stay unchanged
with zero Save/editor-commit calls. Consent remains usable at 320 CSS px with
28 px root text, real Pretext measurement and wrapped full folder paths.
Actual uppercase and lowercase Ctrl+S both save exact source bytes; the earlier
v3 uppercase shortcut defect is fixed in this v4 checkpoint.

Actual Linux Tauri/WebKitGTK qualification passed 13 native editor/CLI/window
checks, six App checks including a held harmless Review response across Restore,
three clean Close acknowledgement checks and three revoked Close checks.
A further six native publishing checks exercised uppercase Ctrl+Shift+S,
byte-exact source and real PDF downloads through WebKit, separate PDF permission
and MCP download/revocation, narrow consent geometry and exporting a dirty
buffer without an implicit save. Downloads used a verified private XDG directory;
existing desktop windows and user downloads were preserved. One initial native
publishing fixture attempt missed menu readiness; its failure was preserved and
the distinct successful runner waits for visible painted controls and complete
native typing.

The aggregate receipt is `artifacts/qualification/v4-integrated-checkpoint.json`,
SHA-256 `a7e8d3d59e70208975d6a72ed1ce737a0568437e0bb3ed8ceabdae36cdb1fb6e`;
it names and hashes every scoped browser/native receipt. The unsigned Debian
installer subsequently passed its separate extracted-package checks: contents,
offline CLI, native 13, App six, publishing six and both three-check Close cases.
Archive SHA-256 is
`19ebbe40fc98283477d8e9dcfdf5e418e97c217dc9bacf36b240c3c0fdc8d7e6`;
`artifacts/qualification/v4-packaged-checkpoint.json` has SHA-256
`ed41beb01d9fadf2586b2cf3cfcb2babf6353963ef14c6d2998630057549c6fb`.
An initial terminal `busy` Restore rejection remains in its original failed
receipt. The separate successful diagnostic runner added passive IPC error
observation only, with no effect retry; exact attribution of the earlier
rejection remains uncertain. Native file import is later implementation work
and is excluded here.
All tunnel fixtures used a simulated zrok child: public ChatGPT connectivity,
automatic file attachment, other platforms, signing, installation and complete
Overleaf parity remain unqualified. Generated evidence stays ignored and does
not travel with a fresh clone.

## Native file-import checkpoint, 2026-10-15

VERIFIED on immutable `artifacts/qa-final-import-v5`: 219 captured source files,
13 frontend assets, desktop SHA-256
`5fca7d14ed932e68fd533394fcf28d66fb59610d3963f5982deeee60e980e895`
and service/CLI SHA-256
`419f93d52780ef6c1ef3d658f60c67587c23672409224ebe6f837135de951366`.
The strict capture, combined native all-target Clippy/build, architecture and
stack checks passed. Backend checks passed 131 real-Typst Rust cases, including
12 import boundary cases; the combined focused frontend suite passed 170 cases.

Actual Linux Tauri qualification passed 13 native editor/window checks and seven
new native import checks. Real OS picker cancellation and source/PNG selection
reach Rust-owned staging. Exact source/binary bytes, source sidecar and pending
Git ownership match without opening/saving/compiling or changing the main
document. A real committed response was held, then routed to the renderer's
error callback by changing only the acknowledgement routing header. The app
retained the same request across dialog reopen, blocked overlapping App effects,
and confirmed its committed receipt through Check with exactly one import
dispatch. Collisions, a replaced destination folder and dirty-buffer native
Undo/Redo preserve the intended source and metadata.

Successful runner SHA-256 is
`b7792f5e9e813d338cb85962b67ccfc74542a3188bd59b431fa7aab59015bfba`.
Receipt `artifacts/qa-final-import-v5/artifacts/native-import-realized-entry/native-app-evidence.json`
has SHA-256 `5c65c3a07d9333857930bceabd298b9d6de3e621778f07eda802309be0445f21`.
Earlier fixture failures are preserved: native folder-entry realization/Recent
selection and ordinary delayed autosave after Undo/Redo required OS automation
and quiescence corrections. No product assertion was bypassed. The saved-project
ZIP implementation is later live source work and is excluded from v5. Physical
OS IME, native narrow long-name import layouts, public ChatGPT/zrok, other
platforms and a v5 installer remain separate gates. Import receipts are bounded
and process-local; abrupt termination can leave partial new files, requiring
inspection rather than automatic replay.

## Independent core failures and control checkpoint, 2026-10-15

The read-only v6 core review found seven concrete failures despite earlier finite
passes: queued highlighting can protect a shifted passage; slash-delimited HTML
raw tags admit proposals and local acceptance; journal recovery can overwrite
unexpected corrupt metadata; Git filters/CRLF can change published source bytes;
chained URL rewrites can change the executed destination; ignored owned outputs
can clear without publication; and deleting known protected metadata can reset
active-share policy. The exact report is
`artifacts/qualification/acceptance-v6-independent/REPORT.md`, SHA-256
`e544ebed5a6b19207d696faaa26a69465aae5929868ce8f5986c582b7aa39828`.
Its exit-zero probes record reproduced failures, not product success. Relevant
current functions matched the frozen v6 sections. These findings supersede any
inference that the earlier finite Git/policy tests establish complete acceptance.
Known policy loss must fail closed until explicit local resolution or revocation;
external deletion is not the local Unmark action.

Later v7 is immutable at `artifacts/qa-final-controls-settings-v7`, with 228 source
files, 13 built assets, desktop SHA-256
`bb23148d11fa8365d567aa4a87c2f0de7c7df090b50cd618d57eb5c3ea47967b`
and service/CLI SHA-256
`5fb5d7b62196897515f1aa5adb9266113ad8d74b2c0d7e34b1f0421be26d1d6e`.
Combined architecture, stack-injection, format, 195 focused frontend tests,
frontend build, strict native Clippy and both native builds pass; the backend
handoff has 148 real-Typst Rust tests. CLI reads no longer perform recovery.
Native control checks wait at most two seconds, retain uncertainty without
effect replay, keep Close error handling scoped to its job and prevent
overlapping or heartbeat-blocking acknowledgement retries.

Actual v7 native Focus/load (three requests), held-Close-ACK/poll-load (four
checks), baseline native 13, App/read six, import seven and ZIP core/retired-page
gates pass. These receipts remain separately scoped under the copied target's
`artifacts/`. V7 is not release-ready: native WebKit found a short/enlarged Review
pane overflow despite the Chromium settings pass. Publishing subsequently passed
six checks after private-display and ordinary-autosave/current-PDF quiescence
fixture corrections; the original unsampled PDF mismatch remains unexplained.
The native aggregate is `artifacts/qa-final-controls-settings-v7/artifacts/v7-native-status.json`,
SHA-256 `d6c55c908d4a70f968005abbfcc48a0029aa2a661aa45a6568cdf08c5d6978b9`.
The independent core failures above require their own repairs and a fresh
combined candidate. Installer review also confirmed
missing third-party notice payloads and a conditional custom-target CLI path
mismatch. No v7 installer, public upload, live ChatGPT/zrok, signing or other
platform qualification is claimed.

The later live Git correction has 68 passing service-module library tests,
including ignored-file refusal, staged/raw-byte checks, one-pass configured
remote routing and clearing the actual checkpoint capture. This is a narrow
source/library result, not immutable native or live GitHub qualification.
An additional working-source Git follow-up has 20 focused tests passing after
reproducing external executable-mode publication and ignored-source overwrite
during incoming fast-forward. It verifies exact staged mode/blob/path and
preserves ignored files and pending ownership. Receipt:
`artifacts/coordination/v8-git-mode-incoming-fix.json`. This remains a local-bare
library result rather than a new live GitHub or native claim.

Compiler cancellation/reaping supervision is individually qualified on a private
v7-plus-owned-overlay candidate: 18 publishing tests, 152 full review tests and
20 real-Typst publishing checks pass. Owned work and exclusion survive a dropped
caller; persistent reap failure can retain busy indefinitely. Handoff:
`artifacts/qualification/publisher-supervision-r7-j8ezghnm/handoff.json`.
The frozen HTML classifier fix separately passes 16 focused tests and actual
private MCP/local checks covering 21 proposals and six denied raw-context
acceptances. Its expanded receipt is
`artifacts/qualification/html-context-priority-followup-cmhrydrn/runtime-evidence.json`.

Policy continuity has 170 Rust tests passing and a scoped private CLI; the
matching final frontend passes 84 focused tests and six actual Chromium/service
checks, including missing/corrupt metadata, preserved dirty buffers, no-save
revocation, pure retry, late responses and enlarged/narrow layouts. Frozen
receipts are `artifacts/backend-policy-evidence/freeze.json` and
`artifacts/coordination/policy-continuity-frontend-freeze.json`. Import's later
post-publication preservation and retired-owner fixes have 14 focused tests
passing; see `artifacts/qa-delivery-2026-10-15/import-race-repair-receipt.json`.
These were separate source/candidate results and are not retroactively included
in the scoped policy CLI.

The later immutable v8 integrity checkpoint combines these repairs with strict
journal ownership, durable receipt identity, exact pending-write completion and
Create/import preservation after uncertain publication. All 252 source hashes,
14 assets and both debug binaries remain exact. Its 182 Rust tests, 216 focused
frontend tests, strict native Clippy and 13 successful native fixture groups
pass. The separately built unsigned Debian package also passes extracted
contents, attribution, offline CLI and 13 native fixture groups. Each native
aggregate contains 65 descriptive check statements, not 65 unique requirements.
See the [exact v8 identities and evidence limits](../VERIFICATION.md#immutable-integrity-and-unsigned-linux-package-checkpoint--2026-10-15).
Package aggregate SHA-256 is
`ef923a8be007afe2d5083cf6b59368ed4bda1887cd651bb00d3f4f27ba0e00e9`.
The package remains local, unsigned and uninstalled. Newer Word count and pure
diagnostic work are outside v8; lifecycle epochs and Rename/Move remain
planning-only. Remaining acceptance in [product-goal.md](product-goal.md) keeps
the delivery goal active.

The later [native Word count checkpoint](../VERIFICATION.md#immutable-native-word-count-checkpoint--2026-10-15)
captures 261 sources, 15 assets and both binaries before the live source-epoch
work. Real Tauri/WebKit count, dirty-history/late-reply/owner/layout checks and
five native regression groups pass. Its matching CLI passes 20 real-Typst
publishing checks; the full Review UI gate passes with explicit external-change
Reload and null-readiness fixture corrections. Preserve the original hosted
failure as evidence of correct conflict refusal. The maintained native runner
and CI/notice/documentation overlays do not retroactively alter the captured
runtime. No new installer or green expanded hosted run is inferred. The
authenticated root-replacement counterexample and remaining captured-root,
History, lifecycle and diagnostic work are explicitly scoped in that report.

The [instance shutdown follow-up](../VERIFICATION.md#instance-shutdown-follow-up--2026-10-15)
separately changes runtime Stop to release its owned lock even with a surviving
duplicate handle. A deterministic red/green regression, 211 isolated Rust tests,
strict review Clippy and independent source review pass. Original hosted failures
are retained; inherited-descriptor timing is an inference. Its hosted rerun
passes Rust and the main Review UI, then exposes a selection fixture that types
before the requested file finishes mounting. A genuine held-Open negative
control reproduces that failure; the corrected readiness fixture passes the
same probe with both original assertions intact. The linked follow-up records
exact evidence. Full hosted and repaired-runtime package qualification remain
pending.

The following hosted runs expose a valid earlier unconfirmed save response in a
receipt fixture and a separate folder-creation failure with its error discarded.
A deterministic delayed-acknowledgement integration case requires the final
exact durable saved receipt; nine editor-session tests pass. Folder failure
observability is qualified with a normal seven-check run and a genuine native
`exists` refusal. Its hosted cause remains unclassified; CI now retains failure
JSON/PNG. These verification changes preserve runtime behavior and do not imply
green hosted or installer qualification; see the linked shutdown follow-up.

A later Word count fixture failure is reproduced with passive focus/selection
tracing. Waiting for the real dialog close handler and exact DOM selection
preserves all original insertion/history/no-save assertions; the full five-group
browser gate passes on the unchanged captured runtime. The separate hosted
Settings-save failure remains unclassified. Failure capture now targets the
actual auxiliary page; an intentional failure verifies its JSON/source identity
and visually inspected PNG with complete owned-process cleanup. The linked
follow-up records runner and evidence identities; these results do not qualify
newer native work or establish a green hosted/package run.

Both next hosted runs pass through Connections and the legacy archive smoke,
then stop on an App fixture's strict Projects-read assertion during a real
pre-effect busy refusal. A closed Projects/Pdf readiness observer preserves
all original authority, no-save, rendered and revocation checks. Its full local
App gate passes; 20 separately labelled synthetic cases cover exact-busy,
fatal-error and producer refusal. No genuine busy occurs in that local run.
The linked follow-up records exact inputs and complete owned-process cleanup;
new hosted/native/installer acceptance is still pending.

At `02ada71`, both hosted runs pass the full App browser gate as well as
Review UI, Word count, Connections and historical archive smoke. They then fail
the separate App controls layout fixture at 320 CSS px/200% text. The original
nine-case fixture reproduces 92 px vertical overflow locally with Chrome 155:
the additional closed PDF-export section pushes Refresh/Stop below the finite
dialog. Scoped narrow Connections spacing removes that overflow; all nine
cases and original functional/Pretext assertions pass unchanged, with exact
regrowth. Full values, fonts, controls and overflow policy remain intact.
CI now retains its report and PNGs. See the linked verification follow-up for
exact red/green inputs; this is local mocked-control presentation evidence,
not hosted Chrome 151, native authorization or installer qualification.

The later [source-epoch checkpoint](../VERIFICATION.md#immutable-source-epoch-checkpoint--2026-10-15)
captures 266 sources, 15 assets and matched Rust/Tauri binaries. Its backend
closure passes 237 Rust tests; selected JavaScript/static gates, eight browser
and five actual native epoch check statements pass. Earlier fixture failures
are retained and all captured inputs remain unchanged. The stopped-startup
epoch fixtures do not qualify live Move or root replacement containment. Newer
expectedRoot, saved History and diagnostic integration remain separate work;
full hosted, package and parity acceptance still keep the product goal active.

The newer unpublished publishing slice bounds Rust-written PDF spool bytes to
16 MiB while concurrently consuming bounded stderr through the existing owned
compiler/reaper lifecycle. Its 77 focused publishing cases and strict Clippy
pass on the exact private inputs recorded in
`artifacts/qualification/typst-bounded-pdf-spool/handoff.json`. Dependency JSON
is still bounded only when admitted after compilation; a hard temporary-write
quota, compiler/cache sandboxing and crash residue remain separate gaps.
Subsequent compiler-source capture and creation-alias fixes require their own
receipts and a matched native integration; these focused passes do not qualify
the newer desktop or an installer.

The [menu-navigation and policy-fixture continuation](../VERIFICATION.md#menu-navigation-and-policy-fixture-continuation--2026-10-16)
qualifies the integrated keyboard menus with 37 focused checks, six Chromium
groups and four actual Linux Tauri/WebKit groups. The separately corrected
root/epoch-bound policy fixture passes six groups on unchanged v16 runtime
inputs. This does not establish full hosted, paired Overleaf or new-installer
acceptance; the linked report preserves the exact identities and failed runs.

## Frontend work reduction, 2026-10-16

The Ponytail performance pass defers PDF.js until an available PDF is displayed,
retains tabs across already-dirty edits, skips identical PDF/save status and
Review-position writes, and reuses fully painted PDF windows across small
scrolls. PDF replacement, dimensions, zoom and pixel density still invalidate
that window; partial, failed and superseded paints cannot populate it. Save,
conflict, source-identity and explicit-build authority remain unchanged.

Production entry/preload JavaScript falls from 1,252,749 to 826,834 bytes
(34.0%); this measures deferred loading, not native cold-start or Typst speed.
Focused Chromium checks with real Rust, CodeMirror and Pretext observe 61 → 0
tab/save-label mutations for 20 already-dirty edits, and 1 → 0 PDF engines
loaded during HTML startup. A real three-page Typst PDF loads on demand and a
small scroll retains its painted canvas; the original HTML and policy bytes
remain exact. These focused runners omit the broader Settings/layout gates.
The 86 focused editor/session/position/format/PDF/workspace/window tests, build
and architecture check pass. Raw snapshots and receipts are under ignored
`artifacts/performance-2026-10-16/`. The broad Review UI attempt stops on a
preserved source conflict during its early exact-save fixture. Rust tests and
the native check encounter another task's Cargo build-directory lock; native
WebView, full UI, compiler timing and installer qualification remain open.
