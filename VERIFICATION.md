# Verification report

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
