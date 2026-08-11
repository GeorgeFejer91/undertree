# UnderTree

UnderTree is a standalone Linux desktop workspace for local LaTeX
projects. It provides an Overleaf-style three-pane interface while using your
existing Git repositories, `latexmk`, and TeX engines. Editing and compilation
remain fully offline. Its name is a tongue-in-cheek inverse of Overleaf: the
same kind of workspace, kept firmly under your own tree.

It is the primary local editing application for the canonical Overleaf project
library. It edits the library's existing Git worktrees directly, so it does not
create a separate project copy. In the Linux application menu it appears as
**UnderTree**, with the generic name **Offline LaTeX Editor**. Its enabled
background service listens only on `127.0.0.1:37371`.

Its dedicated **GitHub Sync**, **Overleaf Sync**, and **Pull remote changes**
controls are the preferred interactive synchronization interface for this
library. They automate the routine fetch, clean-worktree, ancestry, and
committed-checkpoint checks, stopping safely when a remote is newer, histories
diverge, or local changes must be resolved first. Final completion still means
that the local, GitHub, and Overleaf branch tips have been verified as the same
checkpoint.

## Included workflow

- searchable, sortable switcher for every local Git/TeX project;
- hierarchical file tree with a persistent **TeX & Bib only** filter and TeX
  section outline;
- multi-tab CodeMirror editor with local syntax highlighting, undo/redo,
  formatting helpers, search, dirty indicators, atomic auto-save, and conflict
  protection;
- green Recompile control, build logs, download, and embedded PDF preview;
- opt-out Codex recovery whenever a selected TeX source fails to build, with a
  quiet short-lived formatting-only background task, duplicate suppression,
  automatic verification, and PDF refresh;
- an original, PreTeXt-inspired UnderTree Layout source type for adaptive fixed
  boxes, with semantic XML, runtime validation, HTML and LuaLaTeX targets,
  bounded per-box font/spacing fitting, and visible overflow failures;
- a real compile-options menu for normal rebuilds, clean rebuilds, embedded
  adaptive HTML proofs, logs, and project-specific automatic recompilation;
- bundled offline PDF.js rendering with continuous vertical page scrolling,
  page jumps, fit-width, and zoom;
- project-wide text search;
- local Git state and explicit safe bridge pull/push controls;
- dedicated policy-aware GitHub Sync and Overleaf Sync buttons for committed
  checkpoints;
- system-default `.tex` and BibTeX file opening into the matching project;
- draggable panes inside a dedicated native GTK application window;
- localhost-only authenticated service that remains available offline.

## Install a release

The private GitHub release contains a self-contained application archive with
the compiled interface and a pinned official Codex SDK/runtime for compatible
automatic recovery. It does not bundle the much larger TeX distribution or
operating-system web view.

Required release-runtime components are Node.js 20 or newer, Python GTK/WebKitGTK
bindings, Git, `latexmk`, and a TeX distribution. Install the equivalent packages from your
Linux distribution, extract the archive into a permanent location, and run:

```bash
./scripts/install.sh
```

`ripgrep` is optional but recommended: when present, UnderTree uses its Rust
search engine for large-project ASCII searches and retains the built-in
JavaScript implementation as the compatibility fallback.

This adds a user-level desktop entry and background service. It does not need
administrator access. You can also run `./bin/undertree` directly; on a
system without a user systemd session, the launcher starts the localhost
service itself. `./scripts/uninstall.sh` removes the launcher integration while
keeping projects and settings.

Projects default to `~/Documents/Overleaf-projects`. The directory is created
on first start. Repositories listed in `PROJECTS.tsv`, plus Git repositories
with a `.tex-sync.conf` bridge file, appear in the project switcher. Set
`UNDERTREE_LIBRARY_ROOT` when launching manually, or add a systemd user override,
to use another library directory.

## Build from source

Building requires Node.js 22.13 or newer (Node.js 24 LTS is recommended) for
the current PDF.js toolchain. The compiled release service remains compatible
with Node.js 20 or newer.

```bash
npm ci
npm run build
./scripts/install.sh
```

Then launch **UnderTree** from the desktop application menu or run `undertree`.
The installer registers it as the default TeX/BibTeX editor;
opening a source file selects its inventory project and opens that file. The
former `localtex-studio` and `texstudio-overleaf` commands remain compatibility
aliases that route older scripts into UnderTree. Existing `LOCALTEX_*`
environment variables and `.localtex-*` project artifacts remain supported so
the rename does not invalidate established projects or automation.

Create the lean downloadable archive with `./scripts/build-release.sh`. Runtime
operation does not use npm: the JavaScript editor is compiled into `dist/`, the
backend uses Node's standard library apart from the small XML layout parser, and
PDF compilation uses the local TeX distribution. The optional failed-build
recovery deliberately invokes the user's installed, authenticated Codex CLI;
it is the only editor workflow that may require a network connection. The
installed program uses the operating system's lightweight WebKitGTK component
rather than Brave, Chromium, or Electron. It has its own application identity,
process, icon, window state, and download handling.

## Keyboard shortcuts

- `Ctrl+S`: save the active source file;
- `F5` or `Ctrl+Enter`: compile the active `.tex` document (or the configured
  root when another file type is active);
- `Ctrl+P`: open the local project switcher;
- `F11`: enter or leave full-screen mode;
- `Ctrl+Shift+R`: reload the native workspace shell;
- `Ctrl+Q`: close UnderTree;
- the standard CodeMirror undo, redo, and search shortcuts remain available.

The green **Recompile** button never navigates the workspace. Saving and building
are one ordered transaction. The TeX-aware middle editor writes roughly 100 ms
after typing stops. For the active TeX/layout source, UnderTree sends the exact
editor snapshot in the build request; the service atomically reconciles it and
then starts the compiler, without a redundant save request. If an autosave is
already in flight, the build snapshot waits for it first. Non-source inputs such
as an active BibTeX file are flushed before the configured root builds. The same
revision guard ensures that a build or save response can never mark a newer
keystroke clean.

Each editor instance is permanently bound to its file path, preventing delayed
events from one tab from changing another. If a clean open tab's source was
removed externally, UnderTree recreates it from the remaining editor buffer.
If disk contents changed concurrently, the editor remains authoritative while
the displaced disk side is first preserved under private UnderTree state. The
completed PDF replaces the preview page stack only after its current page is
ready.

Selecting any `.tex` document also checks that exact source automatically. If
its matching PDF is missing or older than the source, UnderTree immediately
tries to compile that file. This includes bare or included fragments: when they
cannot compile independently, the same guarded formatting-only recovery
workflow is available for the selected file.

If that TeX build exits unsuccessfully or produces no PDF, **Automatically
repair failed TeX with Codex** starts a private background task by default. It
uses `gpt-5.6-luna` with low reasoning for both the initial repair and the single
permitted retry. UnderTree gives each recovery an isolated temporary Codex home,
never opens or focuses the Codex desktop app, and removes the task and routine
success log after verification, so frequent repairs do not create sidebar tasks
or success reports.

The generated request is restricted to the smallest mechanical LaTeX
formatting/build fix. The current on-disk source is authoritative; Codex is
forbidden from using Git history or another file to restore older content, and
from changing visible prose, order, meaning, citations, labels, headings, or
focus. UnderTree stops direct builds at the first fatal error, sends a bounded
diagnostic around that error, deduplicates identical failures, and temporarily
protects the selected editor from competing saves. If the first candidate does
not pass an independent verification build, the new diagnostic is sent once to
the same private task. Any candidate that changes the visible-text signature is
rejected, retained in private recovery state only when inspection is necessary,
and the exact original source is restored. After a clean verification build,
clean editor tabs reload and the PDF sidebar refreshes silently. Only unresolved
errors are surfaced. The setting is saved per project and can be disabled in the
compile-options menu. A preview-renderer failure after a clean TeX build does not
invoke Codex because it is not a TeX formatting error.

Selecting another `.tex` tab switches the preview to that document's existing
PDF when it is current; recompiling updates only that selected document. A
standalone source's `% !TeX program = ...`
directive selects pdfLaTeX, LuaLaTeX, or XeLaTeX for that file; the project's
configured engine is the fallback. This also permits **All PDFs** to compile a
mixed-engine document set correctly. When a non-TeX file is active, the
configured project root remains the build target. Its arrow opens options for a normal
rebuild, a clean rebuild, the latest adaptive HTML proof, the most
recent compile log, and automatic recompilation after one second without edits
or every 5, 10, 30, 60, or 120 seconds. Automatic recompilation is off by
default, remembered separately for each project, and skips overlapping builds.
When the active file ends in `.layout.xml`, the same button becomes **Render
layout** and builds that semantic source instead of the project's ordinary TeX
root.

The PDF toolbar downloads the current document using its source filename (for
example, `paper.tex` becomes `paper.pdf`). **All PDFs** finds every standalone
`.tex` source with a document class, compiles each one, and downloads the
successful results together as a ZIP. Nested source directories are preserved
inside the archive so equally named documents do not overwrite one another;
sources that do not compile are reported and omitted.

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
