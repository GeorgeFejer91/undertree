# UnderTree

UnderTree is an offline manuscript workspace built around Rust, Tauri and Typst,
with an HTML/CSS interface required to look and feel near identical to the
open-source Overleaf editor and review workflow. Visual and interaction parity
are an acceptance requirement; the current workspace has not yet been qualified
against that reference. See [the UI target](For-AI/overleaf-ui-parity.md).
Manuscripts remain ordinary text files in your own project: `.typ` or `.html`,
with small adjacent JSON files for highlights and suggestions. Its name is a
tongue-in-cheek inverse of Overleaf: the workspace stays under your own tree.

The product stack is fixed: **Rust authority, Tauri v2 native shell, HTML/CSS interface and Typst publishing**. Native delivery on every platform uses Tauri. Electron is excluded from the active dependencies, build and release configuration.

Bounded control panels are required to use the [outside-in accordion stretch and overflow
prevention standard](For-AI/ui-layout.md) from Uncodixfy Pretext. The native
window uses an original UnderTree boundary with custom Close and Minimize
controls; the workspace within it retains the Overleaf parity target.

The new Tauri workspace can edit Typst, compile a PDF through the local Typst
CLI, and import a supported subset of TeX into a new Typst file. It works
without LaTeX. The existing TeX and fixed-page HTML tools remain compatibility
workflows while the Typst migration progresses.

## Rust/Tauri manuscript workspace

### Linux installer

The [v0.3.0 native preview](https://github.com/GeorgeFejer91/undertree/releases/tag/v0.3.0)
provides a Debian x86-64 installer and SHA-256 checksums. Download the `.deb`,
verify its checksum, then install it with `sudo apt install ./UnderTree_0.3.0_amd64.deb`.
Launch **UnderTree** from the applications menu. Typst 0.15.1 is installed
separately for compilation; the editor itself does not require LaTeX.
This Linux build targets Debian 13; other platforms need their own packages.

### Build from source

Install Node.js 22.13 or newer, Rust and the platform's Tauri v2 build
prerequisites, then run:

```bash
npm ci
npm run desktop
```

`npm run desktop` builds the HTML interface and starts `undertree-desktop`.
`npm run build:native` builds a release executable; creating and qualifying
installers is a separate step. Install Typst 0.15.1 separately to compile `.typ`
documents, or set `UNDERTREE_TYPST` to its executable. The Rust backend uses
Typst's syntax library for review validation and supervises the compiler; the
full renderer is not embedded in the desktop binary yet.

Linux installer builds verify the checked-in dependency notices. After changing
frontend or dependency inputs, regenerate them with the pinned maintenance tool:

```bash
cargo install cargo-about --version 0.9.2 --locked --root artifacts/tools
npm run generate:notices
npm run verify:notices
```

This tool is used during development and is not part of the application.

Typst source has syntax highlighting and **Insert** actions for inline/display
math, citations, cross-references, links, figures and tables. Replace selected
placeholders with your bibliography keys, labels, URLs or image paths. Each
insertion is one undo step; use it in Typst markup rather than inside code,
comments or raw text. Highlighting is a bounded approximation of Typst syntax.

Use **View → Editor settings** to choose font size, word wrapping and Compact,
Normal or Wide line spacing. Apply saves these presentation preferences locally;
Cancel leaves them unchanged. Reset defaults fills the dialog for review before
Apply. Settings preserve source text, undo history and pane choices. If local
storage is unavailable, the app reports that preferences apply for this session.

**File → Word count** counts a captured snapshot of the current editor file,
including unsaved text and source selections. It reports source words and a
literal prose estimate without saving or compiling. Typst estimates include
literal content, including unused definitions; generated text and included files
are excluded. HTML estimates exclude code and non-prose subtrees. The dialog
shows its scope and segmentation locale; it does not report a rendered project
total. Typst prose analysis requires the desktop app.

Use **File → Set as main document** on a `.typ` file to keep building the
complete manuscript while editing chapters, BibTeX/Hayagriva bibliographies,
or data files. Recompile saves the project's open buffers before building;
conflicts retain the buffers for resolution. **Clear main document** restores
compilation of the selected Typst file. Successful compiler warnings remain in
the compilation log, and changed project inputs make the previous PDF stale.
Locally prepared packages work offline; UnderTree does not download missing
packages. Project fonts are loaded from regular local font files. External
packages/system fonts need separate freshness qualification.

Each build uses a private copy of regular project inputs, limited to 128 MiB
for the whole project. Linked files/directories, `.git`, `node_modules`,
`For-AI` and compiler snapshots are excluded. This prevents project symlinks
from exposing outside files through compiler output or errors.

After `cargo build -p undertree-review`, run `npm run test:typst-publishing`
for the mandatory real-Typst publishing gate. It checks representative PDF
content, math, bibliography, references, figures/tables/links, import limits,
failure retention and dependency freshness; a missing compiler fails the gate.
This finite suite does not establish every LaTeX package or publisher template.

Choose a project folder, open or create a manuscript, and select a passage to
apply a color rule. Rules can protect text, attach a custom instruction such as
“Keep the meaning; make this snappier,” or mark an idea for discard. **Discard
idea** requires a deletion suggestion covering the complete highlighted passage;
the manuscript changes only when you accept it. **Reject agent changes** remains
a separate rule that blocks proposals. Colors and prompts are editable in
**Format → Color rules**; existing projects can add a custom Discard idea rule.
Suggestions appear beside their source passages, with a
pending count and a cue for new proposals. Only your local Accept action changes
the manuscript. Protection and rejection rules override prompts. To repair a
stale highlight, select its current passage and use **Reanchor from selection**;
the confirmation preserves its color rule and custom prompt.

If review data disappears or conflicts with a pending save, UnderTree keeps your
draft and last known protections and blocks further saves and review changes.
You can export the buffer and revoke sharing without saving. Restore or resolve
the adjacent review files locally, then use **Check review data**; that check
does not save or reload your draft.

ChatGPT access is opt-in. Install and enable `zrok2` separately, provide an
existing reserved public name and its HTTPS origin under **Connections → zrok**,
then explicitly share each manuscript. `UNDERTREE_ZROK` can select the
executable. The generated MCP URL grants access to shared sources and their
review context through exactly three tools: `list_manuscripts`,
`read_manuscript`, and `suggest_text`. Stopping the tunnel revokes the session's
shares. Add the complete private HTTPS URL as a custom MCP server in
[ChatGPT Plugins](https://chatgpt.com/plugins), install it, then select it in a
new chat. Refresh the connection after server tool or metadata changes, as
described in [OpenAI's connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt).
Live ChatGPT-to-zrok use still requires qualification.

Review always has suggestion-only authority, including for deletions. It has no
tool that can switch itself into direct editing. The local **Share** checkbox
and **Connections → Stop tunnel** control access. The separate **App controls**
toggle grants non-content controls only.

The **ChatGPT symbol** beside Review, GitHub and Connections opens the **Overview**
menu directly. On narrow screens, use **Menu → ChatGPT MCP setup**. The menu
links to zrok setup, provides the private address and copy action, and explains
how to add it as a custom MCP server in ChatGPT. Expand **Connection activity
and tools** for observed MCP activity; use **Shared** to revoke manuscripts.
It remembers the public name and origin, while access and the tunnel remain
session-only. Use `npm run test:connections-ui` after `npm run build` and
`cargo build -p undertree-review` to check the popup with an isolated native
service and simulated zrok child.

An explicit Secret Tunnel import can preserve the complete existing
`https://<name>.shares.zrok.io/t/<private-token>/mcp` address. Export only its
connector identity and zrok enrolment into a new private directory:

```bash
npm run connection:profile -- export --settings /absolute/profile/settings.json --zrok-home /absolute/enabled/zrok-home --output /absolute/private/transfer
```

Transfer that directory between PCs with Magic Wormhole, then close UnderTree
and import into its existing native review state directory:

```bash
npm run connection:profile -- import --input /absolute/private/received-transfer --state /absolute/UnderTree/review
```

Both commands require absolute paths and refuse existing output/connector
profiles or conflicting setup. Import does not start a tunnel. It installs a
private dedicated zrok home and a native-only `secret-tunnel-connector.json`;
never put either in a repository or paste their contents into chat. No other
Secret Tunnel account sessions or folder permissions are copied. Restart
UnderTree, stop the source Secret Tunnel share before starting this same public
name, then share manuscripts explicitly. The imported connector exposes only
the three text-review tools; App controls and PDF downloads are unavailable.
Stopping clears grants, but the imported bearer address is reused on the next
explicit start. Anyone holding that address can access newly shared manuscripts;
remove the imported profile locally to return to rotating addresses. Live
cross-PC transfer and public connectivity require separate verification.

The separate **App** tab enables session-only controls for safe navigation,
selection, presentation settings, saved-source compilation and native window
actions. It has its own private URL. It cannot edit or save files, change review
rules, accept suggestions or trigger autosave. Dirty or conflicted buffers block
navigation, compilation and remote Close.

For one ChatGPT connector covering several apps or PCs, use **Connections →
Apps**. Start the zrok connection, enable the shared app gateway, then link each
app's existing MCP URL and allow its current tools. Copy the gateway URL from
Overview into ChatGPT once. The gateway distinguishes apps with matching tool
names and keeps each app's permissions; UnderTree Review suggestions still
require local acceptance. Enable UnderTree's separate **App controls** to include its
non-content controls behind that same URL. Refresh the ChatGPT connection after
changing linked apps or controls.

Copying another running Secret Tunnel/UnderTree URL links its existing app.
Moving ownership of the same zrok URL uses the private transfer described above
and a deliberate handover. Imported URLs stay Review-only until you explicitly
enable the gateway. App links and grants are session-only and clear when the
gateway or tunnel stops; reconnect them after restart. Up to 64 app links and
512 upstream tools are supported. Live multi-PC ChatGPT routing requires its
own verification; local fixtures do not prove it.
Review color protections apply through UnderTree's Review tools, not to another
app's filesystem access. Separately authorizing an app to write the same files
can bypass that boundary; keep such access read-only for suggestion-only work.

After building the Rust service and frontend, run `npm run test:mcp-hub` for
JSON/stateful-SSE routing, `npm run test:mcp-hub-ui` for Connections, and
`npm run test:mcp-review-policy` plus `npm run test:review-discard` for passage
policies and local acceptance. `npm run test:native-mcp-hub` uses a matching
bundled desktop executable for native IPC/window qualification.
`node tests/mcp-imported-hub-smoke.mjs` separately checks same-URL imported
connector switching and revocation with a disposable synthetic identity.

**PDF export** has a further local permission inside that tab, initially off.
Choose project folders explicitly: exported PDFs may contain current or future
saved text, images, fonts and data from those folders, including unshared files.
Unsaved editor text is excluded, and new project folders need separate permission.
ChatGPT can request an exact existing saved PDF, with a private download URL
that expires after five minutes; disabling exports or App access revokes it.
Downloads are limited to 16 MiB. PDFs using external package-cache inputs are
outside this project-folder permission. Local browser and Linux native download
checks pass; live ChatGPT/zrok remains unverified.

The local file tree includes empty folders and read-only asset entries.
Use **File → New folder** or **Refresh files** without flushing an open buffer.
Folder creation requires an existing parent and never overwrites an entry.

In the desktop app, **File → Import files…** copies selected source files and
assets into an existing project folder. Review the staged names before importing.
Original files are kept, existing destinations are preserved, and import does
not save or open your editor buffer. Limits are 32 files, 2 MiB per UTF-8 source,
16 MiB per asset and 32 MiB for the batch including review metadata. If a response
is lost, use **Check import** to inspect the same request before trying again.
If import fails after publishing files, it keeps those files and reports an
uncertain outcome. Inspect the destination before retrying; it does not delete
partially imported files to undo the operation.

**File → Download saved project (.zip)** exports saved sources, assets, empty
folders and adjacent review/import metadata. Unsaved editor changes are excluded.
Choose a new destination outside the source project; existing files are preserved.
Git, build, dependency and app-state directories are excluded. The saved inputs
are limited to 128 MiB. If confirmation is lost, use **Check project download**
before downloading again.

Connect a project to a GitHub `owner/repository` using your existing Git
credentials, then choose explicit or optional automatic checkpoints.
Synchronization includes UnderTree's pending manuscript/review files and imported
assets, verifies their exact saved bytes, and stops
on unrelated changes, staged work or divergence. A clean project can receive a
fast-forward update; the app never force-pushes or silently changes an existing
origin. Incoming updates stop while owned work is pending and preserve ignored
local files. Ignored pending files, changed executable modes or Git transformations
that change saved bytes stop the checkpoint and retain pending ownership for
resolution. New files use Git's non-executable mode; existing tracked files keep
their committed mode. A disposable
live GitHub branch verified native checkpoints, browser
autosave/autosync, clean incoming updates and conflict preservation. The opt-in
`UNDERTREE_LIVE_GITHUB_TEST=1 npm run test:live-github` gate requires existing
GitHub CLI authentication and publishes only synthetic test files before
conditionally removing its own temporary branch.

TeX import preserves the original `.tex` and creates a new `.typ` plus
`<target>.import-report.json`. Common headings, emphasis, lists, footnotes and
page breaks are supported. Arbitrary math, macros, packages, fonts and page
layout are not equivalent; read the report and inspect the output before use.

Run `npm run test:review`, `npm run test:review-ui`, and
`npm run verify:architecture` for the native policy, rendered review UI and
module-boundary checks. The Typst authoring browser gate requires Typst 0.15.1
and explicit isolated build paths:

```bash
UNDERTREE_REVIEW_BINARY=/absolute/path/to/undertree-review \
UNDERTREE_REVIEW_ASSETS=/absolute/path/to/dist npm run test:typst-authoring
```

See [the review module](modules/review/README.md) for
the local CLI and [architecture](ARCHITECTURE.md) for authority boundaries.

`npm run test:native-ui` exercises the bundled Linux Tauri window in an isolated
X11 display, including real Typst rendering and save-aware Close/Minimize.
It requires a built custom-protocol desktop binary, `tauri-driver`,
`WebKitWebDriver`, `Xvfb`, `xfwm4`, `xdotool`, and `wmctrl`. Browser checks alone
do not establish native window behavior or installer support on other platforms.

## Existing TeX and HTML workflows

The legacy Linux compatibility workspace uses existing Git repositories, a native
web view, `latexmk`, and TeX engines.
Its editing, fitting and rendering remain offline.

The repository is organized into discrete frontend, review, compiler, and maintenance
modules. Codex-only project constraints and orchestration live in the
Markdown-only `For-AI/` folder; no application asset is loaded from or packaged
with that folder. The compatibility frontend remains editable during slow TeX builds and
coalesces rapid edits into the newest required follow-up build.

### Automation CLI

The legacy `node cli.mjs` adapter starts its compatibility service when necessary
and prints JSON to stdout, with structured errors and non-zero exit codes. The
current Rust/Tauri CLI is documented in [the review module](modules/review/README.md).
For example:

```bash
node cli.mjs projects --pretty
node cli.mjs build-all alius-internal-documents --pretty
node cli.mjs build alius-internal-documents templates/letter.tex --pretty
```

Run `node cli.mjs help --pretty` for the compatibility project, file, search,
build, PDF and synchronization commands. These are legacy adapter commands,
separate from the native Rust service and its scoped MCP catalogue.

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

### Native Rust/Tauri packages

On Linux, `npm run build:installer:linux` builds the unsigned Debian package;
`npm run test:installer:linux` extracts and qualifies it without installation.
Install Typst separately. Windows and macOS use the same Rust/Tauri architecture;
their native installers still require platform qualification. Historical Electron
installers and commands are outside the current delivery target.

### Linux

The legacy compatibility archive contains the compiled interface and local
service. Automatic Codex recovery is disabled in this distribution. It does not bundle the much larger TeX distribution or
operating-system web view.

Required compatibility-runtime components are Node.js 22.13 or newer, Python GTK/WebKitGTK
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
source without a cached PDF triggers a selection-time build. A failed build
shows compiler diagnostics and keeps the last good preview. Background Codex
repair is disabled in this distribution; correct the source locally and
recompile. Failed builds leave manuscript content unchanged.

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
