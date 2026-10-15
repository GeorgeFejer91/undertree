# Verification report

## Current viewer and native History checkpoint — 2026-10-15

The unpublished v15 capture, `artifacts/qa-current-history-diagnostics-v15`,
contains 303 sources, 15 fresh frontend assets and two copied binaries. Final
manifest SHA-256 is
`282ec7e1fba06da6977bb411729ba5a2499547b903653bdf676813c20823600b`;
desktop SHA-256 is
`5e2be040de5966eb05ab340f9552a2608b2ee7e0d29824f90b0acee2fa010cc9`.
The CLI remains byte-identical to v14, `d343134a…`, so its earlier real-Typst
20-check evidence below applies to that exact CLI. The v15 build passes 378
selected JavaScript tests with zero skips, formatting, architecture, notices
and both binary builds. All 67 Rust/native configuration inputs match v14;
its 413 Rust tests and strict Clippy are explicitly reused, not rerun.

Native History passes all eight groups. Execution
`artifacts/native-current-v15-history/invocation-02/execution.json` has SHA-256
`7590ead1b6bd3103b7d805f0ac24a7ee286e4e2cfdeff99de619fd71c0c69dc9`;
native evidence SHA-256 is
`a67bf901af0636b61ee06a7b88cb7ed0070945cb90d8266f83fed218d8990495`.
It proves prospective native Save, registered CLI Save and local acceptance
versions, read-only queries/input, retained editor/canvas/workers on Back,
CLI/HTTP/MCP denials, a held response across session replacement and ordinary
restart persistence. All 19 observed processes exit, temporary storage is
removed and all captured inputs plus two runtime extensions remain unchanged.
The executed fixture `f5e36ede…` corrects only the invalid CLI operation's
expectation to exact exit 1, empty stdout and typed `format` stderr. It is a
declared semantic assertion correction outside the immutable capture; the
original `72492389…` run's failure remains preserved.

Original native diagnostics passes its first two groups, including actual
Unicode provenance and last-good PDF/canvas/worker retention. It then fails a
fixture prerequisite: a file switch clears the prior canvas while the log
keeps the preview hidden, but the fixture waits for painting without showing
the PDF. Execution SHA-256 is
`042cd47672639ba71a6e75057acded1eb0249c6860f031f73580aebdbad22ecd`;
native evidence SHA-256 is
`af187a9e05a6b087996e47116576b31ca3eb877a5d885aedd2e479da9a34d5a3`.
A separately declared fixture, `1c91efac…`, adds only an explicit local Show
PDF action before that wait. All original assertions and deadlines remain.
It passes all five diagnostics groups, including one rooted read-only native
Inspect, rejection of a held read after newer caret/log actions, and actual
WebKit geometry at narrow widths, enlarged text and regrowth. Execution
`artifacts/native-current-v15-diagnostics/invocation-02/execution.json` has
SHA-256 `c9f9d3ee2593c287108d2709b0a4a731dda37cf0e2965f4aac2a36c43b2bee6c`;
native evidence SHA-256 is
`845ced9d84621c81216fe149b3b9b03c873b5e541bad31f2eb73c527be621236`.
All guarded inputs/extensions remain exact, observed processes exit and
temporary storage is removed. The original failure remains preserved.

Native publishing passes all six groups with 55 original assertion calls
retained in the separately declared passive overflow variant `8ce6cfe8…`.
Execution SHA-256 is
`2c96db6ece94f6065c210c171518892f1d2bdfb4536d79d1a56b416ff5aad244`;
native evidence SHA-256 is
`a05d85b281e356925cd7d0ce491fda975132cf2f6c230e3b6214c0a64c6707a5`.
The original first geometry sample and two subsequent observations show no
page overflow at 320 CSS px with 200% root text. Wide tabs are clipped by their
scrollport. This local result does not resolve the earlier hosted public
build's horizontal overflow. All captured inputs/extensions remain unchanged;
13 observed processes exit and the temporary directory is absent.

The original v15 native baseline remains **FAILED** after 11 groups. The
failed-save OS-close guard and named CLI save pass; a subsequent custom Close
is refused with a pending-local-operations message. The source reaches disk
but the window remains open. No specific pending operation has been observed
yet, and the final two groups remain unqualified. Execution SHA-256 is
`848a955f4b21ad346c36f7cfdc737700f3d66d12ddfbf72111689703d8610e80`;
native evidence SHA-256 is
`3165590d9ddbb7a34b1f1c530f2277f116df9ef1405b360b131bffcea8913a3e`.
Captured inputs remain unchanged and cleanup completes. A passive diagnostic
run is being prepared; no readiness or product fix is inferred. Remaining
package/platform/live integration and paired-parity gates stay open. No
final-product completion is claimed.

## Previous v14 combined integration checkpoint — 2026-10-15

The unpublished Rust/Tauri v2, HTML/CSS and Typst capture at
`artifacts/qa-current-history-diagnostics-v14` contains 303 source files,
15 freshly built assets and two copied binaries. Final manifest SHA-256 is
`230b9ab1b97e3c58e8c97bde0511287286c11aed7905971c6ecae71b1026b782`;
desktop SHA-256 is
`7f4213683fb58157299e5d5a2d07563cbce6912e58cd1472f66a6dc39410c70f`
and CLI SHA-256 is
`d343134a7655a9abb8ea2640d7955d04247386a1e39f08a9693c9f7acf0a930c`.
Actual compilation gates pass: 413 Rust tests (364 library and 49 integration),
373 selected JavaScript tests with zero skips, formatting, architecture,
attribution verification, strict native/review Clippy and both binary builds.
Three named unchanged heavy History quota tests are explicitly filtered; their
earlier full core evidence remains separate. The exact commands, filters and
logs are retained in `artifacts/current-native-v14-qualification/progress.json`,
SHA-256 `a8a6fae0306f0b9cf1c9aa1569799afa06bed96c939f0e558e05a62c510f3ea3`.

The original v13 five-test PDF-export failure remains preserved. Its shared
synthetic preview fixture lacked the new compiler-capture marker, correctly
making the PDF stale. The corrected fixture and a missing-marker export-denial
regression pass in v14 without relaxing production freshness. Local observed
zoom now reports and accepts 999%; remote zoom commands retain their 400% cap.
The final qualified Typst language/PDF helper files are captured from working
bytes, including the original malformed-let recovery regression.

The unchanged maintained real-Typst runner passes all 20 checks on this exact
copied CLI with zero skips/failures and pinned Typst 0.15.1 plus DejaVu. Receipt
`artifacts/qualification/typst-publishing-current-cohort-20261015/run-01/workspace/artifacts/reverse-engineering/typst-parity/evidence.json`
has SHA-256 `3aff70671ab81784c20ab2ebcf6da5092c67716a636d7e9d1d6e81582ae3f929`.
Outer execution SHA-256 is
`2382ea5a600c5024c717ad95e6aa49fa8bc53b0dba0287fc77e1ba89ee04a66f`.
All 303 sources, 15 assets, both binaries, nine prepared inputs and 567 guarded
read-only dependencies remain unchanged; all 31 observed processes exit and
private temporary storage is empty.

Actual native baseline passes all 13 descriptive groups on this copied pair.
Its separately declared passive failure-observer runner has SHA-256
`14a84101a993e7e1c5699409ae567cb10d9265256d358cf03531175386e421c1`;
the original 64 assertions/actions/deadlines remain unchanged. Outer receipt
`artifacts/native-current-v14-baseline/invocation-01/execution.json` has SHA-256
`5f84a1fc9b7fb5dce4d5f6cf70ef522862389eb8bf584ce8a0674c7cf1549150`;
native evidence SHA-256 is
`f1c5a471802d7617a456db14f7b284a7e70e4b4e4e57a838281ffb28363fee1f`.
This includes real denied autosave followed by named CLI save, clean native
buffer and durable receipt replay. All 28 observed owned processes exit and
all input/extension guards remain exact. Stronger Rust original-session and
journal-absence assertions remain separately scoped.

Native History remains **FAILED** after four groups. Original invocation 01
and a separately hashed passive diagnostic invocation 02 preserve the unchanged
eight-group assertion contract. Split observations confirm that hiding History's
PDF scroller at zero size replaces/zeros its retained canvas; editor identity
and all three workers remain unchanged. A viewer repair requires a new cohort;
no producer repair or assertion relaxation is inferred. Report
`artifacts/native-current-v14-history/REPORT.md` has SHA-256
`17ae2635ed937684b5f626ed75f808097dd328fe9c699a9235d1d156d3a223ad`.
Native diagnostics also fails its retained-canvas assertion after one group;
a separate passive diagnostic run confirms the same zero-size replacement
when logs hide the preview. Provenance, Unicode offsets, guidance purity and
exact last-good PDF bytes pass before that assertion. These failures remain
unpassed; the viewer's five new regressions fail on the original helper and
pass with the narrowly owned fix, pending a new matched native build. Remaining
App/import/picker/installer checks, full paired
Overleaf parity, source/PDF mapping, Rename/Move, live connections and other
platforms remain separate gates. Historical v2/v3/v4 receipts below retain their
original binary/assets scopes. Dependency-report hard temporary-write bounds
and broader compiler sandbox/crash cleanup remain explicit resource gaps. This
checkpoint is not final-product or installer completion.

## Immutable source-epoch checkpoint — 2026-10-15

The Rust/Tauri v2, HTML/CSS and Typst candidate at
`artifacts/qa-final-source-epoch-v10` contains 266 captured sources and 15 built
assets. Source receipt SHA-256 is
`7429061520dc8ebac96c00f2f1a066ddb044bf30e68f5af798cf62c0b8467257`;
desktop SHA-256 is
`2a2bd6703d55bb9a3ae565f786ef88776f6300a576e72e079fd9b01a154d6c0d`
and CLI SHA-256 is
`a416eaae1709dbc22865c7f088966a2bfc0c78c8155910d1e9f3b5a5eab7c6ab`.
The backend closure passes 237 Rust tests, including real Typst checks. The
candidate passes 291 selected JavaScript tests, architecture, formatting,
notices, both frontend outputs and strict all-target review/desktop Clippy.
These selected tests include maintenance checks; they are not all frontend
tests or a complete regression qualification.

The browser epoch gate passes eight descriptive checks on the captured CLI and
assets. It covers actual held Save-all admission, immutable session identity,
configured-main/dependency epochs, stale no-effect refusals, dirty App Close,
retired-page Save preservation and refusal to parse a retained PDF from another
epoch. Evidence SHA-256 is
`7e627aa64d5fa9c0bc3430bbe4e535c9b0bef99cc7b58074661065148a811a6e`
at `artifacts/source-epoch-browser-v10/invocations/03-dd39c87d/evidence.json`.

The actual Tauri/WebKit gate passes five descriptive checks: chapter epoch 7
Save and main epoch 2 publication, legacy epoch 0 Save, malformed/stale native
requests without project effects, an actual permission-denied autosave followed
by one discovered-CLI editor commit and durable receipt replay, and stopped
startup at main epoch 3 with the unchanged epoch 2 PDF. The latter observes the
real source/PDF replies and zero cached-PDF decode, new worker, canvas or export
adoption. Receipt SHA-256 is
`8ccc402446d3cc80c76c79b77c22cc5a8cfaa7bffd9015889647562c74402045`
at `artifacts/qualification/native-source-epoch-v10/attempt03/native-source-epoch-evidence.json`.
Earlier fixture readiness/error-envelope failures remain preserved. All owned
processes exited and captured sources, assets, binaries and manifest remained
unchanged.

This qualifies the finite logical-epoch scenarios on Linux. Registry fixture
changes happen only while their service is stopped; these runs do not prove
live Move, root replacement containment, inode lifetime, History, native picker
or installer behavior. Raw duplicate JSON checks belong to the Rust HTTP
boundary because native framework values have already lost duplicate fields.
The newer expectedRoot frontend, undeclared filesystem/History helpers and
diagnostic-completeness follow-up are outside this checkpoint. Full hosted,
package, parity and product acceptance remain open.

## Immutable native Word count checkpoint — 2026-10-15

`artifacts/qa-final-word-count-v9-sources.json` records 261 sources, 15 built
assets, desktop SHA-256
`b3fcc69ec48354dc8d57a20afcef0f8160fda8c539f256db2ae4272a93e17112`
and CLI SHA-256
`e66f24800fc328ec0756c0d728e938f5210309aa80c08d456ce65449fe2b5b3c`.
Receipt SHA-256 is
`c3dd1af0f2545cfcf1683d055943f68e257de27e59bcc1458325bbbd8eae9e6c`.
All copied sources, assets and binaries remained unchanged. The source checks
pass: 210 Rust tests, 230 focused frontend tests, six maintenance tests plus
the Electron-injection check, format, architecture, notices and strict native
Clippy. The corrected Rust run explicitly uses real Typst 0.15.1; an earlier
run missing its required fixture environment remains recorded. The matching
CLI also passes all 20 real-Typst publication checks.

Actual Tauri/WebKit Word count passes seven core descriptive checks: captured
dirty chapter/selection, literal versus source distinction, incomplete syntax,
HTML worker, no count-induced writes, retained selection/scroll/Undo/Redo,
late response retirement, native owner/field checks and readable measured
layouts. One dense 2 MiB sample completes in 8,827 ms end to end, returning
190,650 literal-prose words and 381,300 source words under the unchanged
15-second UI deadline. These are observations on this machine, not latency
guarantees or rendered/include totals. The maximum-source dismissal case holds
a genuine completed Rust response; it proves pending-controller dismissal and
no late worker/result, not native CPU-in-flight responsiveness.
Report: `artifacts/word-count-native-prep/REPORT.md`; successful runtime receipt
SHA-256 `143c149da6468a358fd92a328fdab3893f6bef6d90cfac1cd9044b78cf8c9c25`.
Earlier admission-contention and scroll-readiness fixture attempts are preserved.

Five further native regression groups pass, recording 31 descriptive statements:
baseline, App/read overlap, enlarged Settings, policy continuity and held late
policy reply. Aggregate SHA-256 is
`51e47951586e37654f9ff444ec202e5af971f697ed85156e1388432f4858b319`.
The full Review UI gate also passes on the exact v9 CLI/assets with corrected
fixture SHA-256 `0ee2dc11b3330fc810e992076a1333508a01820d834088c100a9b56b1860957d`.
Hosted v8 CI exposed its incorrect attempt to close an externally changed,
conflicted tab. An independent browser probe confirmed correct refusal without
saving; the fixture now explicitly Reloads before its clean Close/PDF checks.
An unrelated transient-null reload predicate was corrected separately. Original
hosted/local failures and passive failure captures remain archived. Full gate
aggregate SHA-256 is
`f64795e00effa5eac1e4cbb4865893fb5f31d7bb03eff3e7f73262908a5e837a`.

The proven native runner is maintained as `tests/native-word-count-smoke.mjs`
with only its introductory comment/default artifact path changed; CI supplies
an explicit built desktop/hash. Subsequent verification/CI/documentation and
notice-input overlays do not change the captured runtime. A green expanded
hosted run and a Word count installer have not yet been observed.

Source epochs, Rename/Move, native saved-version History and structured
diagnostics remain separate integration work. A finite authenticated local and
browser-owner probe on v9 demonstrates that same-path root replacement with
equal source/policy bytes can accept an old Save/EditorCommit; different-source
controls refuse. Its report is
`artifacts/reverse-engineering/history-root-replacement-v9-attempt03/REPORT.md`.
It does not exercise a Tauri owner or the newer live identity changes. Captured
root expectations and bound filesystem effects remain required before stronger
replacement-safety claims. The publisher's uncertain-pointer error-path repair
is also outside v9. This remains a checkpoint with the overall goal active.

## Instance shutdown follow-up — 2026-10-15

Both hosted runs of source commit `6e7b9a5` passed historical compatibility but
failed the existing local-instance shutdown assertion before browser/native
qualification. A deterministic private v9 regression reproduces it: a duplicate
lock handle remains open, Stop preserves a replacement descriptor, and discovery
incorrectly still sees a held authority lock. Stop now explicitly unlocks the
owned file after revocation and descriptor cleanup. The regression passes and
checks successor exclusion while and after the old duplicate closes, without
sleeping or weakening the original refusal.

The isolated v9 source plus this repair passes 211 Rust tests and strict
all-target review Clippy. Source SHA-256 is
`387eaafe29c866b36a5f45020b0cb690de3165767df1af00ea1f59de46923eec`;
the receipt at `artifacts/instance-stop-repair/handoff.json` has SHA-256
`53497f3e8eac996885b30a9d41239fcb619d0bc1acaa881944316eaf1a174e19`.
Independent source review accepts the narrow repair. An inherited descriptor
explains the hosted timing failure but was not traced in CI. The deterministic
duplicate-handle result is observed. This runtime follow-up is separate from
immutable v9; full hosted/native/package qualification and other platforms
remain pending.

The hosted reruns pass Rust and the main Review UI gate, then fail the selection
fixture while switching files. It waited for any existing editor before typing.
An artifact probe holds the real queued Open response for 500 ms and reproduces
the same failure after the passing control. The corrected fixture waits for the
requested file's completed mount and its actual dirty newline before Save. The
same probe passes both selection, byte-preservation and Undo/Redo checks without
relaxing their assertions or changing product code. Report:
`artifacts/hosted-v9-selection-readiness/REPORT.md`, SHA-256
`54a894083659df5368141ca99f0ec6df38a5c52189f92228fc4780dcc754660e`.
The corrected maintained runner has SHA-256
`4f8bff74dd0ea57b5015f678131493345be43488f3b82f6a8d3fddd80b8fb2c8`.

The next hosted runs at `e6945f7` expose two separate verification failures.
The push run receives a committed/unconfirmed waiter response in the clean-save
fixture; the API deliberately permits that historical response after its
500 ms acknowledgement grace. A deterministic real-service case now waits for
that response, sends the renderer completion, and requires two exact durable
saved receipts with unchanged source bytes and mtime. The existing external-edit
refusal remains intact; the clean test separately requires the latest durable
saved receipt. All nine editor-session integration tests pass on an isolated
copy of the public source. Evidence:
`artifacts/hosted-e694-project-tree/receipt-semantics-execution.json`.

The PR run instead fails a folder-creation success assertion whose native error
body was discarded. Its cause remains unclassified. The unchanged local scenario
passes all seven checks. The maintained fixture now awaits that original strict
assertion in its main flow, retains the bounded actual native error and emits
failure JSON/PNG; CI collects these artifacts. A genuine pre-existing-folder
negative control fails with Rust's `exists` refusal and emits both files, while
the normal scenario passes. This qualifies failure observability, not the hosted
failure's cause. Both browser invocations clean up their owned processes and
preserve the fixed CLI/assets. No application runtime changes, timeout increases,
readiness corrections or automatic retries are introduced by this follow-up.
Report: `artifacts/hosted-e694-project-tree/REPORT.md`; promotion receipts are
`receipt-semantics-promotion.json` and
`observability-qualification/qualification-and-promotion.json` in that directory.
Full hosted and installer qualification remain pending.

At `faea2e7`, the PR's Word count fixture inserts at the wrong DOM caret after
closing its dialog, while the push run separately times out saving Settings.
A passive browser probe reproduces the exact Word count prefix failure: the
real dialog close handler returns focus after the fixture has already focused
the editor. The fixture now waits for that handler and the actual selected
`beta` text inside CodeMirror before inserting. The bounded probe and all five
maintained Word count groups pass against the unchanged v9 assets and fixed
shutdown CLI. No source selection is fabricated and replacement, Undo/Redo,
count and no-save assertions remain intact, with no retry or longer deadline.
Runner SHA-256 is
`43fc1cf4eb0d8a368cce0516a16cf4092e65503ee20a6ba279b90371391fc28b`;
report `artifacts/hosted-faea-triage/word-count-focus/REPORT.md` has SHA-256
`96bb1cc3626c8830c84d2a9604cf42bf18ca9ce20fe38d8274e5aeadee520865`.
The separate hosted Settings failure remains unclassified; a bounded local
workflow passes but does not reproduce its cause. Failure capture now follows
the actual preference or blocked-storage page and restores the main target
after context closure. One intentional failure verifies its preference-stage
JSON, exact source hash and visually inspected PNG; all 18 observed owned
processes exit and all 289 guarded inputs remain unchanged. This qualifies
logging, not a full Review UI rerun or the hosted failure's cause. Maintained
logger SHA-256 is
`83356ab0332036094cc59c9505144639d78e8d32b237e003fac744202513dddd`;
qualification `artifacts/hosted-faea-preference-observability-prep/invocation-01/qualification.json`
has SHA-256
`96f4dcee97737fcbb718d236eca97783460aa444264c5cfa6fe99f38dfc32781`.
A refreshed hosted run and complete installer qualification remain pending.

Both hosted runs at `7a9aa26` pass Rust, real Typst, Review UI, Word count,
Connections and the historical compatibility archive smoke. Both then fail an
App fixture Projects-read poll on Rust's pre-effect document-lock `busy` refusal;
later native/installer gates are skipped. The fixture now observes only Projects
or Pdf and treats only that exact HTTP400/error code/message as not ready.
Other HTTP, JSON, transport and native errors remain fatal, producers are
refused before dispatch, and the original poll deadlines are unchanged.

The complete maintained App browser gate passes on the fixed shutdown CLI and
15 unchanged v9 assets, retaining all original rendered, no-save, private-main
PDF, inactive-dirty-buffer, held-response and revocation assertions. No real
readiness-busy response occurred in this local run; 20 separate labelled
synthetic controls verify that classification and fatal-error/producer refusal.
All 15 observed owned processes exit, and the guarded inputs remain unchanged.
Runner SHA-256 is
`1689ee15fffdca335b2195cb8f0abcaeb63d1a5bf9937277e1b2de1e65912a1e`;
handoff `artifacts/hosted-7a9aa26-triage/app-readiness-handoff.json` has SHA-256
`57709e5223dfa4b3b8ffc83eca30276b82e1f3fd324f83c4a44066837ee181ec`.
This changes verification only; no source operation is retried. Refreshed hosted,
newer combined native and complete installer qualification remain pending.

Both hosted runs at `02ada71` ([PR](https://github.com/GeorgeFejer91/undertree_texstudio/actions/runs/38710508511),
[push](https://github.com/GeorgeFejer91/undertree_texstudio/actions/runs/38710502425))
pass Rust, real Typst, the complete Review UI, Word count, Connections, the full
App browser gate and the historical compatibility archive smoke. Both then
fail `connection-controls-ui-smoke.mjs` at 320 CSS px with 200% text; later native
and installer steps are skipped. The uploaded artifacts omit that report and
its PNGs, so the exact hosted geometry is unavailable.

The unchanged nine-case fixture reproduces the same labelled failure locally
on Chrome 155.0.8059.79: dialog clientHeight 942 versus scrollHeight 1034. The
closed PDF-export fallback adds a legitimate section, and the footer is clipped.
Horizontal bounds, actual Pretext fits and all functional checks pass. Red
qualification `artifacts/hosted-02ada71-triage/qualification.json` has SHA-256
`8905f28ccce4136fe2e008ee84866ca940cbfdbce9f97d547af865eeabd83e5a`.

Five narrowly scoped Connections rules now derive spacing from both dimensions
inside the existing 380 px breakpoint. Fonts, controls, disclosures, full-value
routes and overflow policy are unchanged. On the exact public source plus only
this CSS hunk, the original runner
`056365f65e7645ef8c3ffc472d483dbefd32e65a1d28bb9ac32b1f41a30e39e3`
passes every original functional assertion and all nine geometry observations.
The failing case now has clientHeight 903 equal to scrollHeight 903; regrowth
retains its exact original 372 px geometry. Public CSS SHA-256 is
`625356e6756e2786ff8f1d88958a66efafd6ce328b024ec1c3d53ad25f1f3875`.
Green qualification `artifacts/connections-finite-fix/qualification.json` has
SHA-256 `9a1830b99409e299af5743249e5ee7535c4413cb8fcd436944c97789988aff01`;
report SHA-256 is
`bc029b53b54edffb595a49c727eac8fc7e74c1782745941689a423c4b4d0ea0b`.
All guarded sources/dependencies remain exact and all 12 observed owned PIDs
exit. CI additionally retains only this fixture's report/PNGs, excluding its
cache. Hosted Chrome 151, native controls, the newer unpublished integration
and complete installer acceptance remain separate gates.

## Immutable integrity and unsigned Linux package checkpoint — 2026-10-15

The Rust/Tauri v2/HTML/CSS/Typst candidate at
`artifacts/qa-final-integrity-v8` contains 252 source files, 14 built assets,
desktop SHA-256 `75a973af15be0d851b3a78baf03730367f8d828724eeb10243dc329b2c797d47`
and CLI SHA-256 `dc372904a20e7789c06aeb14216c50f1ed9ba6d338e32345cd9b3c2e7467fdb6`.
Its source receipt has SHA-256
`32adc926a1882f53245c78a2f356558f8053b29dc711e426ad070424ccce231f`.
All captured sources, assets and binaries remained unchanged during qualification.

Architecture and Electron-injection checks, formatting, 216 focused frontend
tests, 182 Rust tests, six release-maintenance tests, strict native Clippy and
both native builds pass. The native aggregate records 13 successful fixture
groups with 65 descriptive check statements. They cover editing/shared
authority, App controls, publishing, import, saved-project ZIP, retired-page
protection, Close, policy continuity, late replies and enlarged layouts.
These counts describe evidence entries, not unique requirements or complete
product acceptance. Earlier fixture failures remain preserved.

The separately built unsigned Debian package is preserved at
`artifacts/qa-v8-installer-evidence/verified-build-outputs/UnderTree_0.3.0_amd64-v8-checkpoint.deb`,
SHA-256 `68c2f673c4bc9e524bc7a9b4798247e584bfc5a7fd2467d7eaf168c8749012b3`.
Contents, runtime dependencies, exact notices for 329 Rust and 27 bundled
JavaScript components, offline CLI and another 13 native fixture groups with
65 recorded statements passed after extraction without installation. The
packaged desktop differs from the recorded release build only by Tauri's exact
`UNK` to `DEB` bundle marker; every other byte matches. Final package provenance
is `artifacts/qa-v8-installer-evidence/v8-packaged-checkpoint.json`, SHA-256
`ef923a8be007afe2d5083cf6b59368ed4bda1887cd651bb00d3f4f27ba0e00e9`.
Debug and packaged results are separate observations, not additive unique coverage.

Native policy checks establish current-Service continuity after known metadata
loss and exact-byte restoration. The alternate metadata case is valid JSON
with an added newline; corrupt JSON and real save-producer interruption have
separate Rust/browser evidence. The native seeded wrong-prior journal proves
refusal, not producer recovery. No-save assertions cover blocked/retry phases;
later ordinary Undo/Redo save attempts are denied. Persistent witness continuity
across restart is not established. Reviewed suggestions are not named History.

This checkpoint excludes newer Word count and diagnostic work, source epochs,
Rename/Move and the remaining product acceptance. Public ChatGPT/zrok, physical
IME, installation/upgrade/removal, signing, other Linux distributions, Windows
and macOS remain unqualified. No final-product completion follows from this pass.

## Immutable native controls and settings checkpoint — 2026-10-15

`artifacts/qa-final-controls-settings-v7-sources.json` records 228 sources,
13 assets, desktop SHA-256
`bb23148d11fa8365d567aa4a87c2f0de7c7df090b50cd618d57eb5c3ea47967b`
and CLI SHA-256
`5fb5d7b62196897515f1aa5adb9266113ad8d74b2c0d7e34b1f0421be26d1d6e`.
All copied sources, assets and binaries were rehashed unchanged after testing.
The aggregate `artifacts/qa-final-controls-settings-v7/artifacts/v7-native-status.json`
has SHA-256 `d6c55c908d4a70f968005abbfcc48a0029aa2a661aa45a6568cdf08c5d6978b9`.

The 13 native editing/shared-authority checks, App controls with a held safe
Review read, clean/revoked Close, seven OS-picker import checks, six publishing
checks, seven OS Save/ZIP checks and retired-page ZIP protection passed.
Three distinct Focus jobs each applied once during concurrent authority reads.
A separate native Close check observed a real busy heartbeat while holding
the actual successful completion reply: a later healthy heartbeat left exactly
one completion in flight; releasing that reply closed the window and authority
without saving. Read traffic was bounded; only the tunnel child was simulated.

Native publishing now observes actual 450/700 ms timer completion and pending
save responses before restoring write permission. Its successful runner,
SHA-256 `117a19e575db0819ffc64d2c51c1c932f428ab88e88f64ad2fddc7ce74578580`,
also waits for the current PDF build to finish and disables private Xvfb resets.
Exact source/PDF bytes, root consent/revocation and dirty export assertions are
retained. Earlier display, PDF-byte and timer-counter failures remain archived;
their individual causes are not all established by the later successful run.

Actual WebKit Settings Apply/Cancel/reset and dirty history preservation passed,
but at 1100×480 with 200% text the expanded Review list exceeded its pane.
That failure, diagnostic CSS probes and an explicitly invalid selector-array
attempt are preserved separately. The subsequent geometry repair, attribution,
Git/publication corrections and installer are outside this captured snapshot.
No v7 installer was built. New release-receipt and attribution checks have
passing focused maintenance tests; actual new-package qualification and hosted
CI remain pending. Existing platform, physical OS IME and public-route gaps
still apply. This checkpoint is not a final release.

## Immutable native file-import checkpoint — 2026-10-15

`artifacts/qa-final-import-v5-sources.json` records 219 sources, 13 assets,
desktop SHA-256
`5fca7d14ed932e68fd533394fcf28d66fb59610d3963f5982deeee60e980e895`
and CLI SHA-256
`419f93d52780ef6c1ef3d658f60c67587c23672409224ebe6f837135de951366`.
The 13 native shared-authority checks, six App checks including a held safe
read, clean/revoked Close cases (three each), and six publishing checks passed.
The later saved-project ZIP implementation is excluded from this snapshot.

Seven native import checks passed using the actual GTK file picker and Rust
staging/publication. They cover OS cancellation; exact CRLF/UTF-8 source and
binary asset bytes; source sidecar and owned pending Git entries; unchanged
main document, active buffer and source policy; collision preservation; dirty
buffer with real keyboard Undo/Redo; and rejection after replacing the staged
destination folder. No source save or compile was invoked by the import.

For acknowledgement loss, the fixture holds Rust's actual committed response,
then changes only its renderer callback-routing header while retaining the
body. This avoids Tauri's fetch-failure fallback and mutation re-dispatch.
App effects remain rejected while the result is unresolved, including after
closing/reopening the dialog. Check import confirms the same committed UUID
with exactly one `import_files` dispatch. The successful runner SHA-256 is
`b7792f5e9e813d338cb85962b67ccfc74542a3188bd59b431fa7aab59015bfba`.

The successful publishing runner SHA-256 is
`7c0943883d3e0a80d0c6c894469084d67459beb8ff66395b010b98fb70c814e7`.
Its test-only changes wait for the exact rendered App endpoint and a new
denied save after typing before declaring ordinary timers quiescent. Earlier
OS-picker automation and stale-timer fixture failures remain recorded; they
are not silently replaced by the successful receipts. All runners, attempts,
private-display screenshots and receipts are under
`artifacts/qa-final-import-v5/artifacts/`. The captured product inputs were
unchanged. These exact successful runners are now maintained and wired into
CI and extracted-package verification; that new combined wrapper has syntax
checks and passing constituent native gates, not a newly observed hosted run.

This is a Linux checkpoint without installation. Only the tunnel child is
simulated. Physical OS IME, the import dialog with long filenames at narrow
width/200% text, other platforms and the subsequent ZIP flow remain separate
qualification tasks. The v4 installer evidence below does not include native
file import. No final-release or public-route claim follows from this report.

## Immutable native PDF publishing checkpoint — 2026-10-15

`artifacts/qa-final-pdf-v4-sources.json` records 214 source files, 13 built
assets and two native executables. The copied desktop SHA-256 is
`5199d1c620c4651aea27f2672903cadb4c47adecfb1565d738124506baada82e`;
the CLI SHA-256 is
`124e219448faa6f2e0b28ace8d9ca5215f1f85fb023618920461cdb2a171980c`.
The subsequent native file-import implementation is outside this checkpoint.

On those exact debug binaries, all 13 native editing/shared-authority checks,
six MCP App checks including a held harmless Review read across Restore, and
both three-check clean/revoked Close cases passed. Six additional native
publishing checks passed: actual uppercase Control+S saves once, local source
and PDF Blob downloads retain exact bytes, root PDF consent is separately off
by default, real MCP downloads match the saved PDF, revocation invalidates its
ticket, and dirty-buffer source export performs no save. A 320 px/200% text
observation preserves the complete root path without page overflow.

Downloads used disposable XDG config/data/cache and working directories. Before
any download click, a Rust resolver linked to the built `dirs` dependency
confirmed the unique private download directory. `HOME` and existing user files
were untouched. The maintained publishing runner also compiles this small
test-only resolver automatically from the native build's dependency cache; its
actual packaged run passed with the resolver and library hashes recorded.

The unsigned package
`artifacts/qa-v4-installer-evidence/UnderTree_0.3.0_amd64-v4-checkpoint.deb`
has SHA-256
`19ebbe40fc98283477d8e9dcfdf5e418e97c217dc9bacf36b240c3c0fdc8d7e6`.
Its extracted desktop SHA-256 is
`a415760b17e62f35a87868e413f588e4511ec98a8904f60aad1c1fa75fd91955`;
the CLI SHA-256 is
`c127dc77a12e8de03e7a978ca35a933dd0d62c59ed561e37dd8f8e4ed456b94b`.
The packaged desktop differs from its release build only by Tauri's exact
Debian bundle marker. Contents, metadata, offline CLI help and the same native
13/App six/publishing six/Close three-plus-three checks passed after extraction,
without installation. Raw receipts, source/build inventories, runner hashes and
byte-identical exported source/PDF fixtures are retained under
`artifacts/qa-v4-installer-evidence/`.

The first packaged App attempt rejected Restore with terminal `busy` before a
window effect. It remains recorded separately under `package/app-controls/`.
A fresh diagnostic run and full package rerun passed; the passive observer
recorded actual `control_poll` errors saying “The connection is processing
another operation.” That demonstrates polling contention, but does not prove
the earlier Restore cause. No automatic effect retry or product guard change
was used. The publishing fixture also retains an earlier menu-interactability
failure; its successful runner waits for the visible action after restoring
the viewport and text size.

These runs use actual Tauri/WebKitGTK, Rust MCP, Typst and private X11 windows;
only the zrok child is simulated. They qualify Linux checkpoint binaries,
not a final release, public ChatGPT routing, installation/upgrade/removal,
signing, other distributions, Windows or macOS. Native-import acceptance awaits
its next matching snapshot. CI now includes native publishing and all extracted
package lifecycle checks; syntax and local equivalents are evidence, while a
successful hosted run of the expanded workflow remains unobserved. The npm and
Rust dependency audit qualifications and informational warnings below remain
applicable.

## Immutable native App and project-tree checkpoint — 2026-10-15

`artifacts/qa-final-tree-v3-sources.json` records a strict capture of 205 source
files, 13 built assets and both native executables. The copied desktop SHA-256 is
`808436aa2667b2d68753448a6c9c7beacdc0ef3eeb5d9fcc758f8f915b9f5085`;
the CLI SHA-256 is
`26fe7e9539f6cd5a0fb1b8b1b92c641f374d19e64cf4e37524c9c4d7ff1c7cd4`.
Subsequent live changes are excluded from this checkpoint.

| Check on this immutable copy | Observed result |
| --- | --- |
| Architecture and focused JavaScript tests | Passed; 148 tests, zero failures or skips. |
| Rendered project tree | Six real-service scenarios passed with a separately recorded test-only cleanup. |
| Native shared authority and editing | 13 checks passed, including named CLI save with exactly one registered-editor commit after ordinary autosave/compile timers had settled under denied writes. |
| Native MCP App controls | Six checks passed: separate UI opt-in, suggestion-only Review catalogue, safe view, native minimize/restore/focus, pending safe Review read, dirty Close rejection without saving, and App revocation. |
| Clean native remote Close | Real Rust completion was recorded while its reply was held; the window stayed alive without saving. Releasing that exact reply closed the window and removed/revoked the local authority. |
| Revoked native Close completion | Rust rejected the delayed completion with `scope`; the window and editor remained usable. A subsequent OS Close still reached the native guard and preserved the dirty buffer when its explicit local save was denied. |

The native cases use private Xvfb displays and disposable project/app state;
existing windows and installed applications are untouched. App tests use actual
Tauri IPC, Rust MCP and X11 state; only the zrok child is simulated. Source and
review-policy hashes remain unchanged during remote controls. The independently
hashed test-only runners and receipts are under
`artifacts/qa-final-tree-v3/artifacts/`; they do not alter the captured product.
No public ChatGPT route, system installation, signing or other platform is
qualified by these runs.

This checkpoint has a confirmed keyboard limitation: Control+S emitting uppercase
`S` does not save, while lowercase `s` does. The live correction and subsequent
PDF-export work belong to a later snapshot. This is a checkpoint, not a final
product release.

The separately copied unsigned installer passed package contents, offline CLI
help, all 13 extracted native checks and six extracted native App checks. Its
archive is `artifacts/qa-v3-installer-evidence/UnderTree_0.3.0_amd64-v3-checkpoint.deb`,
SHA-256 `6db8a7b333de2b38cf3f260d20d3b6e70692b7df849efe183422ec216b3f8109`.
The packaged desktop SHA-256 is
`f64911096f4f960d00f5faabf280429b3a80facea87712a2904c3b25dca3b2cf`;
the CLI SHA-256 is
`5699797a45a574a661c26329a3c5792adffeab16084ed9ee291bec405ddede77`.
The desktop differs from its build output only by Tauri's exact Debian bundle
marker. Package and runner identities, source inventory, raw receipts and known
limitations are recorded under `artifacts/qa-v3-installer-evidence/`. The package
was extracted for qualification without installation. The expanded Rust/Tauri CI
workflow parses locally; a successful hosted run of that workflow remains
unobserved.

## Isolated Typst authoring and viewport PDF — 2026-10-15

The indexed `manuscript-C4pfNK5A.js` frontend passed its production build,
architecture check, all 47 focused language/insertion/PDF tests, the complete
real-service review browser gate and eight Typst authoring browser checks.
The authoring gate verifies syntax styling, all seven Insert actions, editable
placeholders, independent undo/redo, source-preserving IME/selection guards,
CRLF saves, actual Typst 0.15.1 PDF content and 320 px/200% text menus.
Startup failure and blocked-receipt checks also verified private fixture cleanup.

This used the unchanged previously qualified review authority and excludes newer
working App-control/editor-service code. Native authoring and physical OS IME
remain unqualified. Exact source/artifact identities, raw receipt hashes and PDF
limits are recorded in [the reference evidence](For-AI/reference-evidence.md).

## Earlier qualification checkpoints — 2026-10-15

The Rust/Tauri/Typst product is still under active implementation. Final readiness,
authenticated non-content APP control from ChatGPT, rendered Overleaf parity, and
cross-platform installer qualification have not been established. The canonical current requirements and
remaining evidence are in [For-AI/reference-evidence.md](For-AI/reference-evidence.md).
The older report below describes the previous TeX/GTK product and is retained as
historical evidence; its release contents and scope decisions are not current claims.

| Check | Observed result | Scope |
| --- | --- | --- |
| Initial `npm test` baseline | 99/102 passed; three failures require absent `latexmk` | This baseline predates the subsequent CLI, editor and authority changes. |
| `npm run build`, `npm run verify:architecture`, shell syntax and `git diff --check` | Passed | Build and boundary checks do not qualify runtime integration. |
| `npm run test:review-text-layout` | Passed | Actual Pretext/CodeMirror measurements, zero chrome rescans while typing, icon budgets, font/locale invalidation and two-axis type regrowth. |
| `npm run test:review-ui` | Passed for the `manuscript-DBuTP_wF.js` lifecycle snapshot | Real Rust/Typst, source/review/save races, IME protection during pending acceptance, stale-PDF handling, ten-page preview, import and width/height/text checks. Tunnel and final autosync response are simulated. |
| `npm run test:connections-ui` | Passed | Real local Rust MCP authority, simulated zrok child, revocation, keyboard/focus and 320 px/200% text. |
| `npm run test:native-ui` | Passed, 12 Linux checks | Real bundled Tauri/WebKitGTK 2.54.0, Typst, autosave/preview, responsive typing, CRLF/emoji anchors, native Close/Minimize and bounded layouts. |
| Unsigned Rust/Tauri Debian installer checkpoint | Passed contents, offline CLI and 12 extracted native checks | Real packaged desktop and CLI; no system installation. Source inventory and unresolved captured failures are described below. |
| Portable legacy archive build and extracted-package smoke | Passed after packaging correction | Actual extracted server identity, authentication, frontend and CLI; this is the legacy 0.2.2 distribution, not a Tauri installer. |

The native run also verified that the named CLI privately discovers the same Rust
instance as native IPC, reads the desktop-approved project inventory, advertises
read-only access and rejects anonymous requests and unsynchronized mutations.
Real native shutdown removes its descriptor, revokes the former endpoint and
makes CLI discovery return `instance_unavailable`. This recorded binary predates
the later local registered-editor save coordination. Authenticated remote APP
control requires its own qualification; source editing and saving are outside
the current MCP scope.

The local receipt is `artifacts/qa-native-2026-10-15/native-ui-evidence.json`.
It identifies desktop SHA-256
`07bae1f3958b07368efefbf7804b4ebd56887a69eef9aac6b6fd0a1e07e083d3`
and CLI SHA-256
`2a28033aac386defe55ca1461a5836f395e5336fad5b8edadad20e7255e90095`.
Credentials are excluded from the receipt. Generated evidence is ignored and is
not included in a fresh clone or portable archive. Concurrent changes and later
rebuilds require refreshed qualification; subsequent workspace preferences are
outside this recorded snapshot.

Live public ChatGPT/zrok use, complete rendered Overleaf comparisons, Windows and
macOS native/installer behavior, and representative TeX-import fidelity remain
separate gates. A local mock tunnel, package startup, or passing source test is
not evidence that those gates passed.

An isolated installer-infrastructure checkpoint is recorded in
`artifacts/qa-delivery-2026-10-15/candidate-sources.json`. Its captured
`manuscript-Bd2aDFkJ.js` bundle passes the real HTML Visual editing/save/clipboard
checks, pane geometry checks, Pretext checks and local Connections checks with a
simulated zrok child. The complete review browser gate fails PDF page navigation
after resizing, and three captured Typst scanner unit cases fail. Later fixes in
the live workspace are outside that checkpoint until explicitly captured and
qualified. This checkpoint is not a final software release.

The 0.3.0 amd64 checkpoint package is
`artifacts/qa-delivery-2026-10-15/UnderTree_0.3.0_amd64-checkpoint.deb`, SHA-256
`4afa8addf9377910e65151997f7869e8ee6b842141425a738340cf457ada9f92`.
Its packaged desktop SHA-256 is
`c4002c3ec069d6aec8764a8d9e810456544748332dc2b85f7ae7e9d1ef28f2ff`
and its CLI SHA-256 is
`5d15e2602e23a8351f08d3d6f4cb9ef1117e0f0ee52ec326c184698e3a335719`.
The package contains two Rust executables, an icon, a desktop entry and README;
it declares curl/GTK/WebKit dependencies, recommends Git and requires external
Typst. It contains no Electron, orchestration layer or compiler binaries.
The packaged desktop differs from the build output by exactly the three
expected `UNK` → `DEB` bundle-marker bytes; every other byte is identical,
matching [Tauri 2.12.3's bundler implementation](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.3/crates/tauri-bundler/src/bundle.rs).

The package and native receipts are in
`artifacts/qa-delivery-2026-10-15/native-package/`. The successful run used the
working desktop DBus session with private Xvfb and disposable app/project state.
Two attempts using nested DBus sessions timed out before WebDriver session
creation; those failures remain in the local evidence. The package predates the
new local editor-save and APP-control work, dependency refresh and shipping README
cleanup. Installation, upgrade/removal, signing and other platforms are untested.

The refreshed active npm manifest and installed dependencies contain no Electron.
After compatible dependency patches and a fresh `npm ci`, the actual installed
npm audit reports zero known advisories; the local receipt is
`artifacts/npm-audit-native-stack-installed.json`. An earlier audit reported
18 development advisories before the Electron removal; it is historical evidence
and the isolated installer checkpoint predates that dependency refresh. Electron
is excluded from the Rust/Tauri installer. The read-only Cargo.lock audit with
official cargo-audit 0.22.2 reports
zero vulnerability entries and retains two warnings: `glib` 0.18.5 unsoundness
([RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)) and
unmaintained `proc-macro-error` 1.0.4
([RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html)).
This is not a clean whole-dependency audit. The local audit receipt is
`artifacts/cargo-audit-2026-10-15.json`; no manifest was changed by that audit.

## Historical legacy verification — 2026-08-11

Verified on 2026-08-11 against the installed UnderTree service and the
`pretext-a4-layout-compiler` project.

## Reference analysis

The live reference editor was inspected in an isolated background browser tab.
Its rendered DOM contained 269,640 bytes, 69 buttons, 11 visible tab roles, 15
tree items, CodeMirror editor resources, a file-tree rail, a split Recompile
control, PDF tools, and draggable pane boundaries. Only observable structure,
computed palette values, geometry, and labels informed this implementation;
none of its HTML or JavaScript is included here.

## Automated API and security test

All twenty-eight `npm test` cases pass. They exercise file-tree filtering, project
sorting, PDF viewer state, adaptive layout generation, and a disposable
Git/TeX project through:

- authenticated project discovery and unauthenticated rejection;
- strict same-origin mutation checks;
- traversal and outside-project symlink rejection;
- new folder and source-file creation;
- atomic source saving and stale-modification conflict rejection, including an
  edit arriving during an in-flight save and the pre-build newest-revision
  barrier, safe preservation/reconciliation of a racing disk version, and
  recreation of a deleted source from its remaining editor buffer. A dedicated
  path-binding regression test proves a delayed first-tab event cannot change
  the second tab;
- full-project search;
- watcher-backed project-tree cache invalidation and ordered ripgrep search
  with the dependency-free fallback retained;
- local `latexmk` compilation and PDF streaming;
- a real failed TeX compilation routed through a fake isolated Codex process,
  including official-SDK option wiring, formatting-only prompt constraints,
  background-task isolation without desktop focus, immediate retry after launcher failure, automatic
  recompilation, one same-task retry after failed verification, bare-text TeX
  scaffolding with unchanged prose, visible-text tampering rejection/restoration,
  and recovered PDF streaming;
- selection-time compilation/recovery for every selected TeX source, plus
  stale-PDF detection and cache-first source switching without a rebuild;
- per-file TeX-engine directives for selected standalone documents and
  mixed-engine PDF bundles;
- safe bridge pull/push command routing;
- Git and build-configuration status.

The PDF state tests also verify page boundaries, accumulated rapid zoom, and
the 10-megapixel high-zoom render budget. The dedicated PDF browser smoke test
verifies that every page has a continuous-scroll placeholder, scrolling updates
the current-page status, and visible pages render on demand.

## Installed UI test

`tests/ui-smoke.mjs` passes against the persistent systemd user service:

- project and icon discovery;
- file tree and root-document opening;
- persistent TeX/Bib-only filtering;
- CodeMirror editor and source tab;
- project-wide search results;
- Git/bridge panel;
- project switcher with activity, name, and creation-date sorting;
- Recompile completion;
- embedded continuous-scroll PDF display;
- zero application console errors;
- zero external HTTP, HTTPS, WebSocket, or secure WebSocket requests.

## Native program shell

- The desktop entry launches a dedicated GTK application rather than Brave or
  Chromium.
- The native WebKitGTK smoke test requires the complete editor DOM, populated
  file tree, source tab, three-pane workspace, and rendered PDF canvas to load
  successfully.
- The application has its own process identity, taskbar icon, window title,
  remembered window dimensions, full-screen shortcut, and download handling.
- Authentication is injected inside the process and is not exposed in the
  command line.
- The native smoke test records every loaded resource and fails if the editor
  or PDF renderer contacts a non-local network origin.
- The native regression test clicks Recompile on the real ethics project and
  requires the same loaded document, selected project, and active source tab
  to survive until a newly rendered PDF canvas appears.
- Clean rebuild and separate GitHub/Overleaf synchronization paths are tested
  against disposable local Git remotes; no live remote is mutated by tests.

The 0.2.0 UnderTree native smoke test passed after the application-identity
migration; it loaded the complete editor, rendered a PDF, clicked Recompile,
and verified that the window, project, and active document did not reload.

## Live Codex recovery

- An isolated real Git/TeX smoke project replaced a tracked complete document
  with only `lightweight background words`. The failed build reported missing
  document structure and automatically started a private background recovery
  through the bundled SDK/runtime.
- `gpt-5.6-luna` with low reasoning treated the working file as authoritative,
  did not restore the committed document, added only the minimal article wrapper,
  and preserved the visible words exactly. UnderTree independently rebuilt the
  source and detected the one-page PDF on the first attempt in 35.6 seconds.
- The main Codex session count remained exactly 171 before and after recovery,
  and the job's isolated Codex home was removed after verification. No Codex
  desktop task was opened or focused.
- The real ethics-project `a1.tex` bare-text case likewise preserved `nonono`,
  added only document scaffolding, and produced a verified PDF in 36.5 seconds.

## Standalone release

- `scripts/build-release.sh` produces the 116 MB
  `undertree-0.2.0-linux.tar.gz` archive, whose extracted application occupies
  about 305 MB on disk.
- The archive excludes development dependencies and includes the compiled
  client, service, native shell, documentation, XML parser, and pinned official
  Codex SDK/runtime so recovery does not depend on a separately updated CLI.
- `scripts/test-release.sh` extracts the archive into a clean temporary
  directory, starts its own server against an empty library, checks the
  UnderTree identity and version 0.2.0 health, completes authenticated
  bootstrap, verifies required files, and rejects personal absolute paths or
  credential-shaped content.
- The generated systemd unit and desktop entry validate successfully, and the
  installed service reports version 0.2.0 from the portable project path.
- The complete development and runtime dependency audits report zero known
  vulnerabilities. PDF.js was upgraded from 5.6.205 to patched 6.2.108, and
  its continuous-scroll/zoom/reload smoke test passes in a real browser.

## Real-project acceptance

- 65 synchronized local TeX projects are discoverable in the current library.
- The software repository itself is correctly excluded from the TeX list.
- The real ethics sheet compiles through UnderTree's project bridge.
- The active ZANV standalone information sheet honors its LuaLaTeX magic
  comment even though the project's configured root uses pdfLaTeX.
- The resulting PDF is one A4 page.
- The pilot worktree remains clean.
- Local, GitHub, and Overleaf resolve to the same commit
  `9f73a552b54c277d02acd725edf58aae3e32e17e`.
- `undertree.service` is enabled, active, localhost-only, and has no
  restart failures.
- The installed desktop entry and systemd unit validate successfully.
- The pinned release runtime dependency audit reports zero vulnerabilities.

## Scope decision

The requested offline editor workspace is achieved: local project/file/outline
navigation on the left, multi-tab TeX editing in the middle, and
compile/log/PDF controls on the right. Online collaboration, chat, review,
billing, and hosted-account functions are deliberately omitted because they
are not part of the user-confirmed UI scope and cannot operate fully offline.
