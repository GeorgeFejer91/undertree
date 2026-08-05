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

`npm test` passes a disposable Git/TeX project through:

- authenticated project discovery and unauthenticated rejection;
- strict same-origin mutation checks;
- traversal and outside-project symlink rejection;
- new folder and source-file creation;
- atomic source saving and stale-modification conflict rejection;
- full-project search;
- local `latexmk` compilation and PDF streaming;
- safe bridge pull/push command routing;
- Git and build-configuration status.

## Installed UI test

`tests/ui-smoke.mjs` passes against the persistent systemd user service:

- project and icon discovery;
- file tree and root-document opening;
- CodeMirror editor and source tab;
- project-wide search results;
- Git/bridge panel;
- project switcher;
- Recompile completion;
- embedded PDF display;
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

## Real-project acceptance

- 88 synchronized local TeX projects are discoverable.
- The software repository itself is correctly excluded from the TeX list.
- The real ethics sheet compiles through both LocalTeX Studio and the installed
  `texstudio-overleaf-build` wrapper.
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
