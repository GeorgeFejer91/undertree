# UnderTree

UnderTree is an offline-first Typst workspace built with Rust and Tauri. The Typst 0.15.1 compiler is embedded in the native process; users do not need a Typst CLI, Node.js, Electron, a TeX distribution, or a network connection for ordinary editing and preview.

This branch is the Rust/Typst rewrite. The former Electron/LaTeX application is frozen on GitHub at branch [checkpoint/latex-electron-v0.2.2](https://github.com/GeorgeFejer91/undertree_texstudio/tree/checkpoint/latex-electron-v0.2.2) and tag [latex-electron-v0.2.2-checkpoint](https://github.com/GeorgeFejer91/undertree_texstudio/tree/latex-electron-v0.2.2-checkpoint).

## What works

- plain local HTML/CSS/JavaScript wrapper hosted by Tauri's system WebView;
- the checkpoint application's visual shell, pane geometry, navigation rail, toolbars, resizers, and responsive breakpoints;
- embedded Typst compilation in Rust with bundled default fonts;
- multi-page SVG preview without injecting generated SVG into the DOM;
- one-click native PDF rendering and atomic Save As, followed by a direct show-in-folder action for the current export;
- latest-edit-wins compilation scheduling that never blocks typing;
- native folder selection for approving a project root;
- bounded `.typ` and `.bib` inventory and switching between project documents;
- confined creation, editing, and conflict-safe saving of BibTeX bibliography files;
- inline, keyboard-first citation recommendations from project BibTeX handles, matched across title, author, year, venue, DOI, and key without leaving the source editor;
- green Keep and amber Revise highlighter marks for AI-assisted editing, with a compact catalog, durable source anchors, and native enforcement that prevents coding agents from rewriting protected or out-of-scope prose;
- a smart file-tree viewer with focused defaults, per-type visibility controls, and a Show all files override;
- project-relative Typst imports and assets confined to the approved root;
- UTF-8 and size validation at the Rust IPC boundary;
- atomic saves with revision acceptance guards;
- SHA-256 conflict detection and preservation of displaced disk content in .undertree/conflicts/;
- a product-specific native CLI for zero-write project inspection, confined document reads and saves, bibliography creation, compilation, conversion, Git, and GitHub lifecycle operations;
- authenticated control of an already-running editor, including status, focus, project/document navigation, revision-guarded source replacement, save, compile, bibliography creation, reverse conversion, and guarded quit;
- GitHub OAuth Device Flow authorization through the user's system browser;
- in-process Git clone, fetch, merge, commit, and push without a Git CLI or GitHub Desktop;
- local-first projects that edit the real files in an existing folder or an authorized repository cloned to local storage;
- per-project manual and interval-based synchronization rules;
- GitHub credentials stored in the operating-system credential manager rather than project files;
- native, offline LaTeX/Overleaf-to-Typst import and Typst-to-LaTeX export that preserve every original and add reviewable, editable sibling drafts;
- embedded Typst validation of generated drafts, with explicit warnings for known lossy converter constructs;
- restrictive CSP and an explicit main-window command capability;
- no shell, network, generic filesystem, or remote-content authority exposed to the WebView.

The visual layout is a compatibility surface: future work should keep it identical to the checkpoint while replacing capabilities behind it with Rust/Typst implementations. The current foundation intentionally supports desktop folder projects. Package-registry imports are disabled so compilation remains offline and reproducible. Syntax highlighting and release installers remain future product slices; see [VERIFICATION.md](VERIFICATION.md) and [ARCHITECTURE.md](ARCHITECTURE.md) for the current boundary.

## PDF output

Choose **PDF** in the preview toolbar to render the exact current editor snapshot with UnderTree's embedded Typst engine. The native Save dialog suggests a name based on the active `.typ` document; scratch documents work too. The export is page- and size-bounded, written atomically to the explicitly selected local destination, and never sends PDF bytes or a writable path through the WebView. After a successful current-revision export, the adjacent folder button reveals that PDF in the system file browser. Editing or opening another document hides the folder action until that exact revision is exported.

## LaTeX and Overleaf import

Choose **Import LaTeX** to select one UTF-8 `.tex` document or an Overleaf `.zip`. Conversion is entirely local and in-process. UnderTree uses the Apache-2.0 Tylax 0.3.7 engine in preservation mode, resolves bounded `\input`, `\include`, `\subfile`, and `\subfileinclude` dependencies inside the approved project only, restores safe HTML color, external bibliography declarations, common TeX accents, basic page geometry, and supported multicolumn checklist layouts where the converter omits them, writes new `.typ` siblings atomically, and compile-checks every newly generated root with the embedded Typst compiler.

The original `.tex`, `.bib`, images, archive, and other assets are never removed or overwritten. Re-import also refuses to overwrite an existing `.typ`. ZIP extraction occurs in a unique staging folder and rejects traversal, absolute paths, links and special files, encrypted entries, duplicate or case-colliding paths, Git metadata, Windows reserved names, oversized files, excessive expansion, and overly deep projects before promoting the imported folder.

Conversion output is deliberately labelled a draft. UnderTree contains known converter panics and reports constructs that require source comparison, including inline bibliographies, TikZ, `siunitx`, optional matrix row spacing, `\displaystyle`, align labels, nested lists, minipages, custom table columns, `\includeonly`, and unsupported two-part import commands. A legacy non-UTF-8 source or include is reported and skipped without preventing compatible documents in the same cloned project from opening and converting; its original bytes remain unchanged. External BibTeX files are the reliable bibliography route. Pandoc remains useful as a differential-conversion reference, but its GPL-2.0-or-later distribution is not bundled into this currently unlicensed application. The Markdown-only fidelity protocol, fixture catalogue, thresholds, and result ledger live in `For-AI/validation/latex-fidelity/`; generated QA renders remain temporary and never enter `For-AI/`.

## Typst to LaTeX export

Open a saved `.typ` document and choose **Typst → LaTeX**. UnderTree first compiles that exact source with its embedded Typst engine, then uses Tylax's structured reverse-conversion API to create a complete article-class LaTeX draft. It never changes the Typst source or an existing LaTeX file. Exports are versioned as `name.undertree-export.tex`, `name.undertree-export-2.tex`, and so on; these generated files are visible and editable in UnderTree while preserved legacy `.tex` files remain hidden.

The export is designed to remove mechanical rewriting, not to pretend that different document languages or journal templates are equivalent. Imports/includes, show/set rules, bibliography details, and journal-class adaptation produce visible review warnings. Before submission, move the converted content into the journal's current official LaTeX template, compile it with the required TeX/bibliography toolchain, and compare the resulting PDF with the approved Typst rendering. The durable two-way workflow is documented in `For-AI/validation/latex-fidelity/bidirectional.md`.

## Smart file viewer

The file tree starts in a focused writing view: Typst documents, UnderTree-generated LaTeX exports, and BibTeX databases are visible. Open **Smart file viewer** to independently reveal original `.tex` sources, PDFs, images, or other project support files, or choose **Show all files** for the complete user-project inventory. Git metadata, `.undertree` private state, dependency caches, build targets, symlinks, and paths beyond the inventory limits remain excluded even in Show all mode.

Visibility is non-destructive and does not change Git, disk contents, compilation, or conversion. Original LaTeX, PDFs, images, and miscellaneous assets are labelled as visible read-only assets; only `.typ`, `.bib`, and versioned `*.undertree-export*.tex` documents cross the native text-editor boundary.

## GitHub connection setup

UnderTree itself is registered once with GitHub as a public OAuth App. That registration is UnderTree's sign-in identity, not a second executable, bridge process, hosted service, or repository installation. The publisher enables Device Flow and expiring user tokens. UnderTree requests the standard OAuth `repo` scope so it can list, create, clone, pull, and push every public or private repository the signed-in user is permitted to access, subject to organization OAuth and SAML policies.

The official **UnderTree Typst Desktop** registration's public Client ID is checked into and compiled directly into UnderTree. End users never register an app, install UnderTree into repositories, paste an identifier, supply a client secret, or configure a personal access token. Runtime environment variables and project files cannot replace this identity. User access and refresh tokens remain Rust-owned, stay out of the WebView, are stored in the operating-system credential manager, and are bound to UnderTree's compiled Client ID.

Select GitHub in UnderTree and choose **Connect GitHub** either before or after opening a local project. UnderTree first displays the one-time code, copies it through the native clipboard, confirms the copy onscreen, and only then opens GitHub's fixed device-login page in the system browser. It requests repository access, polls only at GitHub's required interval, and resumes automatically after authorization. The repository list then comes directly from the connected account; no per-repository installation is required. It can be sorted by name or creation date and filtered by public/private visibility or personally owned/shared repositories. **New GitHub project** creates a repository and a matching local Typst folder with an initial commit. **Link current project** keeps an existing matching checkout—or a folder intended for an empty remote—as the source of truth. **Clone local copy** is the safe choice when the GitHub repository already contains the project. Repositories with read-only access can still be cloned, linked, pulled, and automatically refreshed; GitHub write permission is required for Push, Commit & Sync, and automatic commits.

The approved local folder is always the source of truth. UnderTree reads and atomically saves the actual `.typ` and `.bib` files there, so the same folder remains usable by local Git and other editors. **Refresh project from disk** rereads the file inventory and active document after an external tool changes them; successful Git pulls and scheduled syncs perform the same refresh automatically. If the disk changes while an UnderTree edit is unsaved, the revision-aware save path preserves the displaced disk version as a conflict copy.

An existing Git repository is reused only when its `origin` exactly matches the selected GitHub repository; UnderTree never silently changes branches, cleans files, force-pushes, or replaces a different origin. On Windows, UnderTree enables libgit2's repository-local long-path support so deep writing archives can be checked out without disabling operating-system certificate validation. It relies on libgit2's native TLS decision and installs no certificate-acceptance callback. UnderTree's own `.undertree/` state is added to `.git/info/exclude`, keeping the rule and conflict files local without changing the project's shared `.gitignore`. A repository that already tracks `.undertree/` is refused so synchronization rules cannot overwrite or masquerade as project content.

Sync rules are stored as non-secret project metadata in `.undertree/github-sync.json`. A separate OS-credential-store approval binds those rules to the canonical local folder, UnderTree OAuth client, GitHub account, repository, and branch; copied or hand-authored project metadata cannot authorize GitHub writes. A clean remote advance is fast-forwarded; non-conflicting local and remote changes receive a normal merge commit; a content conflict, dirty pull, active Git operation, changed remote, or unsaved editor stops before UnderTree overwrites work. Automatic sync runs only while UnderTree is open with that project selected and can optionally create a local commit before synchronizing. Unlinking removes both the local rule and OS-bound approval but deliberately leaves the local `.git` repository and its `origin` remote intact.

UnderTree does not currently edit repository contents directly through GitHub's remote file API. Remote-only repositories are cloned before editing; an existing local checkout can instead be linked in place. Both routes use the same local-first, revision-aware editor path, keeping offline editing, atomic saves, external-change detection, Git history, and conflict behavior consistent.

Git submodule initialization and Git LFS materialization are not yet part of UnderTree's embedded Git bridge. A repository that relies on either can still be linked to an already complete local checkout, but **Clone local copy** currently obtains only the ordinary libgit2 work tree; UnderTree must not describe that as a complete materialization of large LFS- or submodule-backed writing repositories.

## Native command line and running-editor control

The same executable provides a product-specific console interface when started with arguments; without arguments it opens the desktop editor. Run `undertree-typst help` for the exact grammar. `undertree-typst open --project PATH [--source RELATIVE.typ]` opens a canonical project without a folder dialog. If UnderTree is already running, the request is delivered to that editor and is refused when it would discard an unsaved document; otherwise it starts the desktop application and uses the requested initial document when it is present in the approved inventory.

The direct command groups cover:

- `project status`, `files`, and `refresh`;
- `document read` and digest/revision-aware `document save --stdin`;
- `bibliography create`, embedded `compile`, explicit-path `pdf export`, and LaTeX→Typst, Markdown→Typst, and versioned Typst→LaTeX conversion;
- bounded `git status`, `branches`, `commit`, `pull`, `push`, and `sync`;
- GitHub login, status, doctor, repository listing/creation, link, clone, pull, push, sync, commit-and-sync, rules, unlink, and logout.

PDF export is available without opening or driving the desktop UI. `pdf export` compiles the saved project document to an explicit destination, refuses to replace an existing file unless `--force` is supplied, and can opt in to showing that just-written artifact with `--reveal`. When the desktop already owns the project, `app pdf export` renders the exact current editor overlay—including unsaved text—through the authenticated native broker; `app pdf reveal` reveals only the remembered export for that same document revision.

`project status`, `project files`, and `document read` inspect the saved on-disk project without selecting it, running conversion, acquiring its lease, or creating `.undertree`. `project refresh`, save, bibliography, conversion, and Git/GitHub mutations use the shared Rust services and acquire the exclusive project lease. A direct mutating command therefore receives `project_in_use` while a desktop editor or another CLI process owns that project. `project refresh` has the desktop refresh semantics and may create non-destructive Typst companions for newly discovered LaTeX roots.

`project files` starts with the focused writing set; `--all` expands it to the complete bounded user-project inventory, and `--category` filters that selected set to `typst`, `bibliography`, `generated-latex`, `latex`, `pdf`, `image`, or `other`.

`convert latex-to-typst --project PATH [--source RELATIVE.tex]` converts either one exact confined source or every newly discovered document root. It never overwrites an existing `.typ` sibling. Every generated or selected draft is immediately checked with the embedded Typst compiler, and the JSON report exposes `compileSucceeded` plus bounded `typst-compile` diagnostics when validation fails.

The `app` group deliberately targets the live editor rather than its saved disk view:

- `app status`, `focus`, `compile`, and guarded `quit`;
- `app project open|refresh` and `app document open|read|replace|save`;
- `app agent context|replace` for policy-versioned Keep/Revise editing;
- `app bibliography create`, `app pdf export|reveal`, and `app convert typst-to-latex`.

`app document read` can return the unsaved editor overlay. `app document replace` accepts source only through bounded standard input and requires the exact current `--expected-revision`; it marks the editor dirty and leaves saving explicit. Navigation and quit fail with `unsaved_editor` unless the caller deliberately supplies `--discard-unsaved`. Busy editor/GitHub operations are serialized or refused, and a timeout after an operation has been claimed is reported as an unknown outcome so automation does not blindly repeat a mutation.

`app agent context --json` returns one coherent live source snapshot with the editor revision, annotation policy version, and typed Keep/Revise ranges. `app agent replace --expected-revision N --expected-policy-version N --stdin` is validated in native Rust before the editor changes: Keep text stays exact, and when any Revise mark exists all text outside those amber ranges is immutable. Successful replacements preserve Keep marks and consume completed Revise marks.

Live commands default to a 30-second timeout; `--timeout` accepts 1 through 120 seconds.

~~~powershell
undertree-typst project status --project "C:\Documents\My project" --json
undertree-typst project files --project "C:\Documents\My project" --all --json
undertree-typst convert latex-to-typst --project "C:\Documents\My project" --source "main.tex" --json
undertree-typst compile --project "C:\Documents\My project" --source "main.typ" --json
undertree-typst pdf export --project "C:\Documents\My project" --source "main.typ" --output "C:\Documents\Exports\main.pdf" --json
undertree-typst app status --json
undertree-typst app document read --json
undertree-typst app agent context --json
undertree-typst app pdf export --output "C:\Documents\Exports\live-draft.pdf" --json
undertree-typst app pdf reveal
undertree-typst github doctor --project "C:\Documents\My project" --json
undertree-typst github commit-and-sync --project "C:\Documents\My project" --message "Update Typst drafts"
~~~

The running application publishes a versioned endpoint record in its per-user application configuration directory and listens only on an ephemeral IPv4 loopback port. A fresh 256-bit capability, client/server nonces, and HMAC-SHA-256 proofs authenticate both the server and the complete typed request, including its timeout. On Unix the endpoint directory/file are forced to `0700`/`0600`; Windows inherits the current user's profile ACL. Frames, source text, connections, pending requests, and timeouts are bounded. The capability is never printed or sent to the WebView, and the matching endpoint is removed during normal shutdown. This channel authorizes the same logged-in OS user; it is not a network-facing API or a substitute for operating-system account isolation.

Non-GUI commands that accept `--json` write one JSON value to stdout on success and exit `0`; product failures use sanitized stable codes and exit `1`, while invalid syntax exits `2`. For `open --json`, a running editor returns a JSON result, while a cold start becomes the desktop process and has no synchronous success payload. No command accepts a token, client secret, arbitrary executable, arbitrary URL, raw Git configuration, or unrestricted filesystem operation. The CLI is not a wrapper around external Git: it reuses UnderTree's credential-store session, approval checks, TLS policy, repository validation, and embedded libgit2 transport.

**Sync commits** deliberately refuses a dirty working tree because Git cannot push uncommitted files. Use **Commit & Sync**—or `github commit-and-sync` with an explicit message—when local documents need to become a commit and reach GitHub. Automatic synchronization commits local changes only when **Automatically commit** is explicitly enabled.

## Development

Requirements:

- Rust 1.92 or newer;
- platform prerequisites from the [Tauri v2 guide](https://v2.tauri.app/start/prerequisites/);
- WebView2 on Windows, WebKitGTK on Linux, or WebKit on macOS.

No JavaScript package manager is used. The frontend is static source in web/.

~~~powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
cargo run --manifest-path src-tauri/Cargo.toml
~~~

The first build is intentionally substantial because it compiles Tauri and the complete Typst engine. Subsequent builds are incremental. Local dev/test profiles omit debug symbols to keep the embedded compiler's Windows build footprint manageable.

## Repository map

- src-tauri/src/compiler.rs: embedded Typst world, validation, diagnostics, SVG preview, and bounded PDF rendering;
- src-tauri/src/pdf.rs: shared bounded PDF rendering-to-path, no-clobber/atomic output, revision-scoped remembered location, and reveal validation;
- src-tauri/src/cli.rs: bounded console parsing and adapters to shared project, compiler, conversion, Git/GitHub, and running-editor services;
- src-tauri/src/remote_control.rs: authenticated loopback protocol, typed request broker, bounded lifecycle, and Tauri adapters for running-editor control;
- src-tauri/src/agent_annotations.rs: durable Keep/Revise policy storage, source anchoring, policy versions, and native replacement enforcement;
- src-tauri/src/project.rs: approved-root inventory, zero-write inspection, bibliography creation, reads, conflict preservation, and atomic saves;
- src-tauri/src/github.rs: GitHub Device Flow, API access, credential storage, project rules, and native scheduler;
- src-tauri/src/git.rs: confined in-process clone, commit, merge, and push operations;
- src-tauri/src/latex.rs: confined LaTeX/Overleaf discovery, extraction, conversion, preservation, and review reporting;
- src-tauri/src/commands.rs: thin Tauri command adapters;
- src-tauri/capabilities/main.json: least-privilege WebView command exposure;
- web/: local presentation wrapper and revision-aware interaction state;
- For-AI/: Markdown-only repository instructions for coding agents.

The existing application identifier io.github.georgefejer91.UnderTree is retained from the checkpoint. Signing, publishing, and changing the GitHub default branch are separate release operations.
