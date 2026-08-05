# LocalTeX Studio

LocalTeX Studio is a standalone offline LaTeX workspace for the canonical local
project library. It provides an Overleaf-style three-pane interface while using
the same `tex-sync`, `latexmk`, TeX engines, Git repositories, and TeXstudio
profile already installed on this computer.

## Included workflow

- searchable switcher for every local Git/TeX project;
- hierarchical file tree and TeX section outline;
- multi-tab CodeMirror editor with local syntax highlighting, undo/redo,
  formatting helpers, search, dirty indicators, atomic auto-save, and conflict
  protection;
- green Recompile control, build logs, download, and embedded PDF preview;
- bundled offline PDF.js rendering with page navigation, fit-width, and zoom;
- project-wide text search;
- local Git state and explicit safe bridge pull/push controls;
- one-click native TeXstudio opening for the same configured root document;
- draggable panes inside a dedicated native GTK application window;
- localhost-only authenticated service that remains available offline.

## Install or update

```bash
npm install
npm run build
./scripts/install.sh
```

Then launch **LocalTeX Studio** from the desktop application menu or run
`./bin/localtex-studio`.

Runtime operation does not use npm or the internet: the JavaScript editor is
compiled into `dist/`, the backend uses Node's standard library, and compilation
uses the local TeX distribution. The installed program uses the operating
system's lightweight WebKitGTK component rather than Brave, Chromium, or
Electron. It has its own application identity, process, icon, window state, and
download handling.

## Keyboard shortcuts

- `Ctrl+S`: save the active source file;
- `F5` or `Ctrl+Enter`: compile the configured root document;
- `Ctrl+P`: open the local project switcher;
- `F11`: enter or leave full-screen mode;
- `Ctrl+Shift+R`: reload the native workspace shell;
- `Ctrl+Q`: close LocalTeX Studio;
- the standard CodeMirror undo, redo, and search shortcuts remain available.

See `ARCHITECTURE.md` for the clean-room design and security boundary.
