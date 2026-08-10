# Verification report

Verified on 2026-08-05 against the installed LocalTeX Studio service and the
`pretext-a4-layout-compiler` project.

## Reference analysis

The live reference editor was inspected in an isolated background browser tab.
Its rendered DOM contained 269,640 bytes, 69 buttons, 11 visible tab roles, 15
tree items, CodeMirror editor resources, a file-tree rail, a split Recompile
control, PDF tools, and draggable pane boundaries. Only observable structure,
computed palette values, geometry, and labels informed this implementation;
none of its HTML or JavaScript is included here.

## Automated API and security test

All fourteen `npm test` cases pass. They exercise file-tree filtering, project
sorting, PDF viewer state, adaptive layout generation, and a disposable
Git/TeX project through:

- authenticated project discovery and unauthenticated rejection;
- strict same-origin mutation checks;
- traversal and outside-project symlink rejection;
- new folder and source-file creation;
- atomic source saving and stale-modification conflict rejection;
- full-project search;
- local `latexmk` compilation and PDF streaming;
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

The 0.2.0 native smoke test passed after the portability and lazy-PDF changes;
it loaded the complete editor, rendered a PDF, clicked Recompile, and verified
that the window, project, and active document did not reload.

## Standalone release

- `scripts/build-release.sh` produces a 1.2 MB compressed Linux archive whose
  extracted application occupies about 4.5 MB on disk.
- The archive excludes all 144 MB of development dependencies and includes
  only the compiled client, service, native shell, documentation, and minimal
  XML parser dependency.
- `scripts/test-release.sh` extracts the archive into a clean temporary
  directory, starts its own server against an empty library, checks version
  0.2.0 health, completes authenticated bootstrap, verifies required files,
  and rejects personal absolute paths or credential-shaped content.
- The generated systemd unit and desktop entry validate successfully, and the
  installed service reports version 0.2.0 from the portable project path.
- Both the complete dependency audit and runtime-only dependency audit report
  zero known vulnerabilities.

## Real-project acceptance

- 88 synchronized local TeX projects are discoverable.
- The software repository itself is correctly excluded from the TeX list.
- The real ethics sheet compiles through LocalTeX Studio's project bridge.
- The resulting PDF is one A4 page.
- The pilot worktree remains clean.
- Local, GitHub, and Overleaf resolve to the same commit
  `9f73a552b54c277d02acd725edf58aae3e32e17e`.
- `localtex-studio.service` is enabled, active, localhost-only, and has no
  restart failures.
- The installed desktop entry and systemd unit validate successfully.
- The npm dependency audit reports zero vulnerabilities.

## Scope decision

The requested offline editor workspace is achieved: local project/file/outline
navigation on the left, multi-tab TeX editing in the middle, and
compile/log/PDF controls on the right. Online collaboration, chat, review,
billing, and hosted-account functions are deliberately omitted because they
are not part of the user-confirmed UI scope and cannot operate fully offline.
