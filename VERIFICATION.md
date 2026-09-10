# Verification

## Automated gates

Run from the repository root:

~~~powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
cargo build --locked --release --manifest-path src-tauri/Cargo.toml
~~~

Node.js is not an application dependency. When available, it can perform an additional static JavaScript syntax check:

~~~powershell
node --check web/app.js
~~~

Compiler, PDF, project, conversion, and Git tests cover scratch SVG/PDF compilation, PDF signature and page metadata, atomic PDF writing, commit-time no-clobber behavior, revision-scoped reveal state, invalid Typst diagnostics, source limits, categorized smart inventory with editable and default-visibility flags, `.typ`/`.bib` inventory and external refresh, confined bibliography creation, conflict-safe bibliography saves, bounded bibliography metadata indexing with malformed-file and duplicate-key isolation, path confinement, non-destructive LaTeX and Overleaf import, archive traversal and metadata rejection, confined includes and subfiles, bibliography, color, accent, page-geometry, and supported multicolumn restoration, Unicode panic containment, bundled GitHub identity validation, GitHub name and branch validation, confined repository initialization, local commits, branch and push-destination guards, non-conflicting merge behavior, sync-rule validation, and atomic rule persistence. JavaScript tests cover multi-field, multi-token citation ranking, accent normalization, typo tolerance, and staged-handle exclusion. CI repeats JavaScript syntax and ranking checks, Rust formatting, checking, linting, testing, and the release build on Ubuntu.

Project, CLI, and remote-control tests additionally cover zero-write inspection and safe advisory lock probing, preservation of a cold-start preferred document, typed document/PDF/remote options, foreign and duplicate option rejection, canonical PDF destinations, native-only destination redaction, typed PDF completion shape, bounded remote paths and source text, closed request serialization, capability comparison, nonce/request/timeout proof binding, an authenticated framed loopback round trip, exactly-once broker claims, and request expiry.

## Desktop smoke test

Run `cargo run --manifest-path src-tauri/Cargo.toml`, then verify:

1. the scratch document renders without selecting a project;
2. Open project uses the native folder picker and lists `.typ` and `.bib` documents;
3. the file-tree plus button creates `references.bib`, opens it as text, and refuses duplicate or escaping paths;
4. editing a `.bib` file does not invoke Typst compilation, and Ctrl+S saves it;
5. editing a `.typ` file schedules a preview without freezing typing;
6. Ctrl+Enter compiles a `.typ` file immediately and Ctrl+S saves;
7. **PDF** opens a native Save dialog and renders the exact current, including unsaved, editor snapshot to a valid `.pdf` without freezing typing;
8. cancelling the PDF dialog writes nothing; a successful current-revision export exposes the adjacent folder action, which reveals that exact file; editing or navigating hides it;
9. an invalid Typst edit or PDF export shows diagnostics without destroying the last interaction state;
10. a disk-side edit followed by save creates `.undertree/conflicts/`;
11. an import outside the approved root is rejected;
12. the GitHub button and rail item open an accessible in-app connection modal without changing the editor geometry;
13. **LaTeX → Typst** opens a native `.tex`/`.zip` picker, preserves all originals and assets, adds `.typ` drafts, opens the preferred draft, and displays conversion warnings plus aggregate embedded compile status for every newly generated root;
14. a repeated import leaves every existing `.typ` untouched;
15. **Typst → LaTeX** is enabled only for a saved project `.typ`, compile-validates the exact source, creates and opens `*.undertree-export.tex`, displays journal-review warnings, and never changes the `.typ` or any existing `.tex`;
16. a repeated reverse conversion creates `*.undertree-export-2.tex` rather than overwriting the first export;
17. preserved legacy `.tex` files remain hidden while generated UnderTree exports are visible and editable;
18. **Smart file viewer** independently filters Typst, generated and original LaTeX, BibTeX, PDF, image, and other categories; **Show all files** reveals the bounded user-project inventory;
19. selecting a visible original `.tex`, PDF, image, or other support file reports it as a read-only asset and never sends its contents through document IPC;
20. closing and reopening the window releases preview Blob URLs.

## Native CLI and running-editor smoke test

Use a disposable project for every mutating step. From `src-tauri/`, first verify the read-only surface without starting Tauri:

~~~powershell
$undertreeExe = Resolve-Path '.\target\release\undertree-typst.exe'
& $undertreeExe help
& $undertreeExe project status --project 'C:\path\to\disposable-project' --json
& $undertreeExe project files --project 'C:\path\to\disposable-project' --all --json
& $undertreeExe document read --project 'C:\path\to\disposable-project' --path 'main.typ' --json
& $undertreeExe pdf export --project 'C:\path\to\disposable-project' --source 'main.typ' --output 'C:\path\to\disposable-output\main.pdf' --json
~~~

Then verify:

1. help lists the complete direct and `app` grammar; a successful non-GUI `--json` command writes one value and exits `0`, a product failure exits `1`, and invalid or duplicate syntax exits `2`; `open --json` returns a value only when it reaches an already-running editor;
2. `project status`, `project files`, and `document read` neither create `.undertree` nor run conversion or update recent projects; lock state is advisory when an existing safe lock can be probed and otherwise reports unavailable;
3. in a disposable copy, `document save --expected-digest SHA256 --revision N --stdin` atomically saves an exact bounded UTF-8 payload, while an obsolete digest preserves the displaced disk bytes under `.undertree/conflicts/`;
4. with that project open in the desktop editor, direct mutating commands fail with `project_in_use`, while `app status --json` succeeds from a second terminal;
5. `app document read --json` returns the current revision and unsaved editor source; `app document replace --expected-revision N --stdin` marks the document dirty, and repeating it with a stale revision fails without changing the editor;
6. project/document navigation and `app quit` reject dirty state with `unsaved_editor`; use `--discard-unsaved` only after confirming the disposable edit may be lost;
7. direct `pdf export` writes a valid PDF to the exact explicit path, refuses an existing destination without `--force`, atomically replaces it with `--force`, and opens a file browser only when `--reveal` is explicit;
8. `app document save`, `app compile`, `app bibliography create`, and `app convert typst-to-latex` use the current editor state and return the matching typed result; repeated reverse conversion creates a versioned sibling;
9. after an unsaved disposable edit, `app pdf export --output FILE.pdf` renders that exact live revision without focusing or driving the window; `app pdf reveal` succeeds only while that same document revision remains current;
10. a second `open --project PATH [--source RELATIVE.typ]` routes to and focuses the running editor without discarding dirty work; with no valid running endpoint, it starts the application and honors an existing preferred source on cold start;
11. normal application shutdown removes its matching endpoint record; a stale unreachable endpoint permits `open` to start a new application, while malformed or protocol-mismatched endpoint records fail closed;
12. stopping or timing out a client before the frontend claims a request yields `remote_timeout`; a timeout after claim yields `remote_outcome_unknown`, and a mutating command is not automatically retried.

Use these CLI adapters for diagnosis and automation whenever the operation exists. Do not script WebView buttons or take over the desktop merely to validate an operation that has a direct or `app` command.

Focused deterministic coverage for this boundary is available with:

~~~powershell
cargo test --locked cli::tests
cargo test --locked remote_control::tests
cargo test --locked project::tests::inspects_a_project_without_conversion_or_private_state_creation
cargo test --locked project::tests::probes_only_an_existing_safe_project_lock
cargo test --locked project::tests::preserves_a_cold_start_preference_for_one_current_project_restore
~~~

## LaTeX migration fixture

The ignored external-fixture test can validate a disposable real project without placing user data in this repository:

~~~powershell
$env:UNDERTREE_LATEX_FIXTURE = "C:\path\to\a\disposable\clone"
cargo test --manifest-path src-tauri/Cargo.toml --locked `
  latex::tests::converts_external_latex_project_fixture_without_mutating_tex_sources `
  --lib -- --ignored --nocapture
~~~

On 2026-08-28 this was run against a shallow, LFS-smudge-disabled clone of `GeorgeFejer91/Grant-Applications` at commit `336e3091762fc08989e6a55af1ae9987b2ce26e9`. It verified 29 original `.tex` files byte-for-byte, created 29 additional `.typ` drafts, reported 56 review warnings, and successfully compiled the selected BIAL `main.typ` with UnderTree's embedded Typst engine. `git diff -- '*.tex'` remained empty and the only work-tree additions were the 29 generated `.typ` files. The disposable clone was not pushed.

## GitHub integration smoke test

Use the publisher-owned **UnderTree Typst Desktop** OAuth App and disposable repositories, then verify:

1. every build contains the official public OAuth Client ID, provides no registration/configuration command or credential field, and never reads a runtime environment override;
2. Connect GitHub works both from scratch and after opening a folder, displays the matching one-time code for UnderTree's compiled identity, copies it to the native clipboard with an onscreen confirmation, and only then opens `https://github.com/login/device` in the system browser;
3. cancelling, expiry, network failure, and GitHub's slow-down response leave the UI recoverable and do not expose a token;
4. authorization requests `repo` access and the picker lists the connected account's accessible repositories without a GitHub App installation; sorting by name or creation date and public/private/owned/shared filters preserve only valid selections;
5. Clone local copy opens the native parent-folder picker directly, emits a visible fetching/checking-out state after selection, supports Windows paths beyond 260 characters through repository-local libgit2 configuration, and never replaces an existing target;
6. linking a repository creates or reuses `.git` inside the selected project only when `origin` matches, writes only non-secret `.undertree/github-sync.json` settings, and adds `.undertree/` to `.git/info/exclude` without changing `.gitignore`;
7. Clone local copy accepts writable and read-only accessible repositories, rejects an existing target, creates the repository-named child beneath the selected parent, opens a contained `.typ` file, and leaves no partial target after a failed clone; read-only projects permit pull but disable push and automatic commits;
8. Refresh project from disk updates the file tree and preferred active document after an external local edit, while an unsaved UnderTree edit must be saved, discarded, or cancelled first;
9. manual commit-and-sync pushes a test edit, a clean remote advance fast-forwards, and non-conflicting divergence creates a normal merge commit without switching branches;
10. an unsaved editor, dirty pull, changed fetch or push destination, ignored-file collision, symlinked `.undertree`, escaped Git metadata, active Git operation, or merge conflict is rejected without overwriting work;
11. Off, 5, 15, 30, and 60 minute rules persist, automatic sync runs only while UnderTree and the project are active, scheduled failures remain visible in the modal, a successful scheduled pull refreshes the active document from disk, and auto-commit remains opt-in;
12. New GitHub project validates its name, creates the selected visibility under the connected user, creates a confined repository-named local child with `main.typ`, makes and pushes the initial commit, and never exposes a delete-repository command;
13. Disconnect removes the saved credential from the operating-system credential manager, while Unlink leaves the local Git repository intact;
14. launching a second desktop process focuses the existing UnderTree window instead of starting a concurrent credential/synchronization worker.
15. `undertree-typst help` exits without starting Tauri, CLI option parsing rejects unknown/duplicate options and token-shaped escape hatches, `open --project PATH` rejects missing/non-directory/unrelated options before Tauri starts, and `github doctor --json` returns only sanitized account/project/Git metadata;
16. a second `ProjectState` owner receives `project_in_use` while the first holds `.undertree/project.lock`, then succeeds after the first owner exits;
17. ordinary Sync refuses an uncommitted working tree with `uncommitted_changes`, while Commit & Sync accepts it and requires an explicit commit message in the CLI;

For visual compatibility, render the frontend at 1440 × 825 and compare it with `assets/localtex-studio-screenshot.png` from the checkpoint branch. The top bar, navigation rail, sidebar split, editor/preview panes, toolbars, gutters, and status bar must retain their geometry and visual hierarchy.

Signing, installer generation, native Save-dialog/Explorer-reveal interaction, live GitHub authorization in CI, and changing the GitHub default branch are not part of the current automated gate. PDF rendering, bounds, atomic output, and remembered-location policy are covered by Rust tests.

For a local credential-safe account smoke test after authorizing UnderTree, run `cargo test --locked live_account_lists_accessible_repositories_without_exposing_credentials -- --ignored --nocapture` from `src-tauri`. It exercises UnderTree's compiled OAuth identity, OS credential-store session, `/user` verification, paginated repository listing, and metadata validation. It prints repository counts and grant-related repository names only; it never returns or logs the access or refresh token.

For an explicit live clone demonstration, set `UNDERTREE_LIVE_REPOSITORY` to an accessible `owner/repository` and `UNDERTREE_LIVE_CLONE_PARENT` to a safe parent folder, then run `cargo test --locked live_clone_uses_undertree_service_and_opens_the_local_project -- --ignored --nocapture`. The same Rust service used by the desktop command validates account access, clones through embedded libgit2, applies checkout limits, writes the local sync approval, and opens the new folder through the normal project state. The test refuses an existing target rather than replacing it.

For a non-destructive live transport check, set `UNDERTREE_LIVE_PROJECT_ROOT` to an UnderTree-linked clone and run `cargo test --locked live_project_pulls_and_pushes_through_undertree_without_remote_changes -- --ignored --nocapture`. It executes the normal Pull command followed by a no-op Push, proving fetch and write authentication without creating a commit or changing the remote repository.

The durable CLI and grant-project diagnosis procedure is recorded in `For-AI/validation/github-cli.md`. On 2026-08-28, the native `github doctor` command verified the stored `GeorgeFejer91/grants` approval, `main` branch, read/write access, zero ahead/behind divergence, and 127 untracked `.typ` conversions. The diagnosed blocker was semantic rather than transport or authorization: automatic commits were off and ordinary Sync can push only commits.
