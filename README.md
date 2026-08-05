# LocalTeX Studio

LocalTeX Studio is a standalone Linux desktop workspace for local LaTeX
projects. It provides an Overleaf-style three-pane interface while using your
existing Git repositories, `latexmk`, TeX engines, and optional TeXstudio
installation. Editing and compilation remain fully offline.

## Included workflow

- searchable switcher for every local Git/TeX project;
- hierarchical file tree and TeX section outline;
- multi-tab CodeMirror editor with local syntax highlighting, undo/redo,
  formatting helpers, search, dirty indicators, atomic auto-save, and conflict
  protection;
- green Recompile control, build logs, download, and embedded PDF preview;
- an original, PreTeXt-inspired LocalTeX Layout source type for adaptive fixed
  boxes, with semantic XML, runtime validation, HTML and LuaLaTeX targets,
  bounded per-box font/spacing fitting, and visible overflow failures;
- a real compile-options menu for normal rebuilds, clean rebuilds, embedded
  adaptive HTML proofs, logs, and project-specific automatic recompilation;
- bundled offline PDF.js rendering with page navigation, fit-width, and zoom;
- project-wide text search;
- local Git state and explicit safe bridge pull/push controls;
- dedicated manual GitHub Sync and Overleaf Sync buttons for committed
  checkpoints;
- one-click native TeXstudio opening for the same configured root document;
- draggable panes inside a dedicated native GTK application window;
- localhost-only authenticated service that remains available offline.

## Install a release

The private GitHub release contains a self-contained application archive with
the compiled interface and its one small server dependency. It does not bundle
the much larger TeX distribution or operating-system web view.

Required system components are Node.js 20 or newer, Python GTK/WebKitGTK
bindings, Git, `latexmk`, and a TeX distribution. TeXstudio is optional but
enables the **Open TeXstudio** action. Install the equivalent packages from your
Linux distribution, extract the archive into a permanent location, and run:

```bash
./scripts/install.sh
```

This adds a user-level desktop entry and background service. It does not need
administrator access. You can also run `./bin/localtex-studio` directly; on a
system without a user systemd session, the launcher starts the localhost
service itself. `./scripts/uninstall.sh` removes the launcher integration while
keeping projects and settings.

Projects default to `~/Documents/Overleaf-projects`. The directory is created
on first start. Repositories listed in `PROJECTS.tsv`, plus Git repositories
with a `.tex-sync.conf` bridge file, appear in the project switcher. Set
`LOCALTEX_LIBRARY_ROOT` when launching manually, or add a systemd user override,
to use another library directory.

## Build from source

```bash
npm ci
npm run build
./scripts/install.sh
```

Then launch **LocalTeX Studio** from the desktop application menu or run
`./bin/localtex-studio`.

Create the lean downloadable archive with `./scripts/build-release.sh`. Runtime
operation does not use npm or the internet: the JavaScript editor is compiled
into `dist/`, the backend uses Node's standard library apart from the small XML
layout parser, and compilation uses the local TeX distribution. The installed
program uses the operating system's lightweight WebKitGTK component rather than
Brave, Chromium, or Electron. It has its own application identity, process,
icon, window state, and download handling.

## Keyboard shortcuts

- `Ctrl+S`: save the active source file;
- `F5` or `Ctrl+Enter`: compile the configured root document;
- `Ctrl+P`: open the local project switcher;
- `F11`: enter or leave full-screen mode;
- `Ctrl+Shift+R`: reload the native workspace shell;
- `Ctrl+Q`: close LocalTeX Studio;
- the standard CodeMirror undo, redo, and search shortcuts remain available.

The green **Recompile** button never navigates the workspace: it saves the
active source, runs the configured local build, and atomically replaces only
the PDF canvas. Its arrow opens options for a normal rebuild, a clean rebuild,
the latest adaptive HTML proof, the most recent compile log, and automatic
recompilation every 5, 10, 30, 60, or 120 seconds. The interval is off by
default, remembered separately for each project, and skips overlapping builds.
When the active file ends in `.layout.xml`, the same button becomes **Render
layout** and builds that semantic source instead of the project's ordinary TeX
root.

See `LAYOUT_FORMAT.md` and `examples/adaptive-boxes.layout.xml` for the adaptive
box format. Generated HTML, LuaLaTeX, and PDF files remain in the ignored
`.localtex-layout/` build directory, while the editable `.layout.xml` source
stays in the project repository.

Manual remote synchronization is deliberately commit-based. **GitHub Sync**
and **Overleaf Sync** push the current committed checkpoint to their named
remote after fetching and checking ancestry. They stop on uncommitted work,
newer remote changes, or divergence; use **Pull remote changes** from the Git
panel before pushing a newer remote state.

See `ARCHITECTURE.md` for the clean-room design and security boundary,
`PERFORMANCE.md` for the measured efficiency audit, and `VERIFICATION.md` for
the test evidence.
