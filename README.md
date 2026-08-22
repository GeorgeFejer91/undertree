# UnderTree

UnderTree is a standalone Linux and Windows desktop workspace for local LaTeX and fixed-page
HTML print projects. It provides an Overleaf-style three-pane interface while
using existing Git repositories, a native web view, `latexmk`, and TeX engines. On Windows,
UnderTree automatically discovers `latexmk` from your PATH or common MiKTeX/TeX Live locations,
then remembers the verified path for later launches. Editing, fitting, and rendering remain fully
offline. Its name is a tongue-in-cheek inverse of Overleaf: the same kind of workspace, kept firmly
under your own tree.

### Automation CLI

The Windows installation registers `undertree` as a per-user terminal command. It starts the desktop
service when necessary and prints JSON to stdout, with structured errors and non-zero exit codes.
For example:

```powershell
undertree projects --pretty
undertree build-all alius-internal-documents --pretty
undertree build alius-internal-documents templates/letter.tex --pretty
```

Run `undertree help --pretty` for named project, file, search, build, PDF, and synchronization
commands. `undertree api METHOD /api/path --data JSON` is the complete low-level hook for all
local API capabilities, including future endpoints.

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
- hierarchical file tree with a persistent **Sources only** filter for TeX,
  BibTeX, HTML, CSS, and layout sources, plus semantic source outlines;
- multi-tab CodeMirror editor with local syntax highlighting, undo/redo,
  formatting helpers, search, dirty indicators, atomic auto-save, and conflict
  protection;
- green Recompile control, build logs, download, and embedded PDF preview;
- per-source PDFs retained in `.tex-build`, plus a bounded in-memory viewer
  buffer that restores recently opened PDF.js canvases, page, zoom, and scroll
  position immediately while fingerprint checks and stale rebuilds run in the
  background;
- adaptive nested-source compilation that remembers whether a document resolves
  paths from its own directory or the repository root, including a source-aware
  BibTeX fallback; failed background rebuilds keep the last good PDF visible and
  do not loop again until the source changes or the user explicitly retries;
- a versioned A4 HTML print profile with CodeMirror source editing, an isolated
  in-place rich-text editor and inspector, addable free-positioned boxlets, draggable
  shared grid borders, eight-way boxlet resizing, bundled `@chenglou/pretext`
  measurement, WebKitGTK PDF printing, and generated standalone LuaLaTeX
  companions;
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

### Windows

Run `UnderTree-<version>-Windows-x64.exe`. The installer includes the desktop
runtime and creates Start-menu and optional desktop shortcuts. Install MiKTeX
(including `latexmk`) or TeX Live separately to compile LaTeX projects; UnderTree
finds standard MiKTeX installations itself, even if the application was launched
without an updated `PATH`. Set `UNDERTREE_LATEXMK` to an exact executable path
for a non-standard TeX installation. Projects
default to `%USERPROFILE%\\Documents\\Overleaf-projects`; application state is
stored below `%APPDATA%\\undertree`.

The editor, project browser, Git synchronization, and LaTeX compilation are
supported on Windows. The fixed-page HTML-to-PDF renderer currently remains a
Linux-only feature because it depends on the WebKitGTK print pipeline.

Build the Windows installer with Node.js 22.13 or newer:

```powershell
npm ci
npm run build:windows
```

### Linux

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

Adding a folder as a project bridge creates an ignored `.tex-build/`
compiler-assets folder inside that same project. UnderTree stores a separate
cached PDF for every standalone TeX source there, preserving the source's
subfolder layout. Selecting a TeX tab switches to its cached PDF immediately;
it compiles only when that source has no cached PDF or when you choose
**Recompile**. Files without `\\documentclass`, such as shared configuration
fragments, are not used as a project's default build document.

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
operation does not use npm: the JavaScript editor and Pretext runtime
are compiled into `dist/`; the backend uses Node's standard library apart from
its bundled parsers, and PDF/TeX export uses WebKitGTK and the local TeX
distribution. The optional failed-build
recovery deliberately invokes the user's installed, authenticated Codex CLI;
it is the only editor workflow that may require a network connection. The
installed program uses the operating system's lightweight WebKitGTK component
rather than Brave, Chromium, or Electron. It has its own application identity,
process, icon, window state, and download handling.

## Keyboard shortcuts

- `Ctrl+S`: save the active source file;
- `F5` or `Ctrl+Enter`: render the active print-profile `.html`, compile the
  active `.tex`, or use the configured root for other file types;
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

Selecting any `.tex` document also checks that exact source automatically. Its
first successful build remains in the ignored project-local `.tex-build/`
directory. Later file-tree and tab selections switch the right pane to that
source's cached PDF immediately, even when the source has since changed; a
visible stale marker then offers Recompile as the explicit update path. Only a
source without a cached PDF triggers a selection-time build. Included fragments
that cannot compile independently can still use the same guarded formatting-only
recovery workflow on that first attempt.

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
project-local PDF without recompiling it; recompiling updates only that selected
document. A standalone source's `% !TeX program = ...`
directive selects pdfLaTeX, LuaLaTeX, or XeLaTeX for that file; the project's
configured engine is the fallback. This also permits **All PDFs** to compile a
mixed-engine document set correctly. When a non-TeX file is active, the
configured project root remains the build target. Its arrow opens options for a normal
rebuild, a clean rebuild, the latest adaptive HTML proof, the most
recent compile log, and automatic recompilation after one second without edits
or every 5, 10, 30, 60, or 120 seconds. Automatic recompilation is off by
default, remembered separately for each project, and skips overlapping builds.
When the active file ends in `.html`, the same button becomes **Render HTML**.
UnderTree validates the profile, waits for fonts and images, applies Pretext
fitting, verifies actual DOM overflow, and prints a fixed A4 PDF after 750 ms of
editing inactivity. The right pane remains PDF.js; a failed replacement leaves
the last successful PDF visible and marked stale. **Export PDF + TeX** writes
the adjacent generated `.tex`, which contains the canonical HTML hash and is
overwritten by later exports. The WebKit PDF remains a separate build artifact;
the portable companion records its hash and reconstructs the validated manifest
as selectable text, links, images, and absolute TikZ geometry rather than
embedding the full browser page. When the active file ends in `.layout.xml`, the
button instead becomes **Render layout** for the legacy semantic source type.

In HTML **Visual** mode, **+ Boxlet** adds a movable, independently fitted region
to the A4 canvas. Its teal square handle moves it and its green edge/corner
handles resize it. Existing CSS-grid cards expose handles for their shared
track boundaries, so dragging a border reallocates space between neighboring
cards without breaking alignment. The rich-text toolbar formats headings,
paragraphs, lists, links, emphasis, underline, alignment, color and font size.
**Refit** reruns the bundled Pretext engine immediately; overflowing boxlets are
outlined in red and remain clipped to their physical boundary.

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

For automation, the same renderer is available without opening the desktop UI:

```bash
undertree render-html flyer.html --pdf build/flyer.pdf
undertree render-html flyer.html --pdf build/flyer.pdf --tex flyer.tex
```

See `examples/html-print-profile.html` for the constrained profile. HTML is the
sole source of truth: explicit `data-ut-page` containers define page geometry,
`data-ut-id` makes visual patches stable, and `data-ut-fit="pretext"` opts boxes
into bounded fitting and optional balance groups. Remote resources, arbitrary
scripts, generated pseudo-element content, unsupported CSS effects, and assets
outside the project are rejected for TeX-compatible export.

Manual remote synchronization is deliberately commit-based. **GitHub Sync**
and **Overleaf Sync** push the current committed checkpoint to their named
remote after fetching and checking ancestry. They stop on uncommitted work,
newer remote changes, or divergence; use **Pull remote changes** from the Git
panel before pushing a newer remote state.

See `ARCHITECTURE.md` for the clean-room design and security boundary,
`PERFORMANCE.md` for the measured efficiency audit, and `VERIFICATION.md` for
the test evidence.
