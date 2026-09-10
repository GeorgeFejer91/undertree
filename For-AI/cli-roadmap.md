# Native CLI roadmap and fast validation

UnderTree's command line is a product adapter over the same Rust services used by the desktop UI. It is the preferred automation and validation surface. Do not validate product behavior by scripting WebView button presses when an equivalent native command exists.

Maintaining that surface is a product requirement, not optional test tooling. Every stable desktop operation that agents need for routine project maintenance should gain a narrow CLI adapter over the same Rust service. Future agents must use and extend this CLI before considering UI automation; the CLI and desktop behavior must share validation, locking, credential, and failure semantics.

The CLI must remain product-specific. Never add a generic shell runner, arbitrary filesystem API, unrestricted URL fetcher, token printer, or bypass around project confinement. Paths are canonicalized in Rust, credentials remain in the OS credential store, and GitHub operations continue to use UnderTree's bounded TLS and libgit2 implementation.

## Current command surface

Implemented now:

- `undertree-typst open --project PATH [--source RELATIVE.typ]` opens a canonical project and optional active Typst document without a folder picker. It first tries the authenticated running editor, then starts the desktop application when no valid endpoint is reachable.
- `project status` and `project files` use the shared bounded inventory as a zero-write disk inspection path; `project refresh` selects and leases the project and has the desktop refresh/conversion semantics.
- `project files` starts from the focused writing set; `--all` expands it to the complete bounded inventory, and `--category` filters that selected set to `typst`, `bibliography`, `generated-latex`, `latex`, `pdf`, `image`, or `other`.
- `document read` returns only a confined editable `.typ`, `.bib`, or UnderTree-generated `*.undertree-export*.tex` document from disk. `document save --expected-digest SHA256 --revision N --stdin` uses bounded UTF-8 standard input and the normal conflict-preserving atomic save.
- `bibliography create --path RELATIVE.bib` uses the dedicated confined project service rather than a generic file-write primitive.
- `git status`, `branches`, `commit`, `pull`, `push`, and `sync` provide a familiar, bounded Git-style workflow without invoking Git, GitHub CLI, or GitHub Desktop. `branches` makes UnderTree safety branches auditable.
- `convert latex-to-typst --project PATH [--source RELATIVE.tex]` runs the non-destructive converter for either one exact confined source or all newly discovered document roots. LaTeX sources and assets remain untouched, existing Typst siblings are not overwritten, and every reported draft is compile-validated before `compileSucceeded` is returned.
- `convert markdown-to-typst --project PATH --source RELATIVE.md` creates one editable Typst sibling for Markdown-first proposals without replacing the canonical Markdown.
- `convert typst-to-latex --project PATH --path RELATIVE.typ` compiles the saved Typst source and creates a versioned UnderTree-generated LaTeX review draft without overwriting existing files.
- `compile --project PATH --source RELATIVE.typ` performs a bounded embedded-Typst compile and reports page, warning, and timing counts without emitting bulky preview markup.
- `pdf export --project PATH --source RELATIVE.typ --output FILE.pdf [--force] [--reveal]` compiles and atomically writes one explicit PDF destination without a dialog; replacement and showing the result in its folder remain explicit.
- `undertree-typst github login` runs device authorization.
- `github status`, `doctor`, and `repositories` provide read-only inspection, with `--json` where applicable.
- `github create`, `link`, `clone`, `pull`, `push`, `sync`, `commit-and-sync`, `rules`, `unlink`, and `logout` expose the existing bounded account, repository, and synchronization lifecycle.
- `app status`, `focus`, project/document navigation, current-source read, revision-guarded replacement, save, bibliography creation, compile, PDF export/reveal, Typst-to-LaTeX conversion, and guarded quit control the current editor through the authenticated user-local broker.

Live commands default to a 30-second timeout and accept an explicit value from 1 through 120 seconds. The endpoint and handshake records, frames, source input, connections, pending requests, and claimed-request lifetime are all bounded. The random capability is kept only in the native per-user endpoint and process; it is never a command argument, result, log value, WebView event, or project file.

The desktop UI and a direct mutating CLI command must not own the same project concurrently. `.undertree/project.lock` is the cross-process authority. A second writer fails with `project_in_use` rather than racing saves, conversions, or Git operations. The `app` group is the supported way to act through the current desktop owner and therefore preserves its exact live editor state.

## Coverage roadmap

### Phase 1 — launch and read-only project inspection

- [x] Open a canonical project directly in the desktop editor.
- [x] Restore its initial project snapshot through a narrow read-only IPC command.
- [x] Add `project status --project PATH --json` with project identity, bounded inventory counts, conversion state, and advisory lock state where a safe zero-write probe is possible.
- [x] Add `project files --project PATH [--category TYPE] [--all] --json` using the same smart-file-tree inventory rules.
- [x] Deliver validated `open --project` requests to an already-running UnderTree instance without discarding unsaved editor state.

### Phase 2 — document and bibliography operations

- [x] Add `document read --project PATH --path RELATIVE --json` for editable `.typ`, `.bib`, and UnderTree-generated LaTeX export documents only.
- [x] Add `document save --project PATH --path RELATIVE --expected-digest SHA256 --revision N --stdin` and preserve conflict-copy behavior.
- [x] Add `bibliography create --project PATH --path RELATIVE.bib` through `ProjectState`, never arbitrary file creation.
- [x] Add `project refresh --project PATH [--path RELATIVE]` using the bounded inventory scanner and desktop refresh policy.

### Phase 3 — compile and conversion

- [x] Add `compile --project PATH --source RELATIVE --json` using the embedded Typst engine and the same size/import limits.
- [x] Add `pdf export --project PATH --source RELATIVE.typ --output FILE.pdf [--force] [--reveal] [--json]` with an explicit destination, atomic output, bounded compilation, and opt-in replacement/reveal.
- [x] Add `convert latex-to-typst --project PATH [--source RELATIVE.tex] --json`; originals and assets remain unchanged, existing siblings are preserved, and the generated drafts are compile-validated.
- [x] Add `convert typst-to-latex --project PATH --path RELATIVE --json`; create versioned review drafts rather than replacing Typst.
- [ ] Add a non-mutating `convert analyze` preflight that reports unsupported or lossy constructs.

### Running-editor control — implemented

- [x] Authenticate a user-local loopback client and server with a native-only 256-bit capability, fresh nonces, and HMAC proofs bound to the exact typed request and timeout.
- [x] Queue requests until the frontend is ready, claim each request exactly once, execute them serially, and validate the returned result type against the request.
- [x] Expose status, focus, project open/refresh, document open/read/replace/save, bibliography creation, compile, PDF export/reveal, Typst-to-LaTeX conversion, and guarded quit without a generic command channel.
- [x] Preserve dirty-state, exact-revision, busy-operation, digest/conflict, and exact-editor-overlay semantics.
- [x] Distinguish timeout before claim from unknown outcome after claim, and remove only the matching endpoint record on normal shutdown.

### Phase 4 — validation profiles

- [ ] Add `validate quick --project PATH --json`: inventory, active-document read, compile, Git link inspection, and credential-safe status.
- [ ] Add `validate conversion --fixture PATH --artifacts OUTPUT`: source preservation, Typst compile, PDF render comparison, and bounded diagnostics. Artifacts stay outside `For-AI/`.
- [ ] Add `validate github --project PATH --read-only`: authentication, approval, TLS, repository, branch, divergence, and worktree diagnosis without writes.
- [ ] Add `validate full --fixture-root PATH`: all deterministic offline checks plus explicitly opted-in live checks.

## Command contract

- Successful non-GUI commands that accept `--json` write one JSON value to stdout and exit `0`. `open --json` returns a value when it reaches a running editor; a cold start becomes the desktop process and has no synchronous success payload.
- Expected product failures use stable safe error codes, write no secrets, and exit `1`.
- Invalid command syntax exits `2`.
- Mutating commands require explicit verbs and all required values; validation commands default to read-only.
- `project status`, `project files`, and `document read` do not select or lease the project, run conversion, update recents, or create `.undertree`.
- Direct mutations, including PDF export, acquire the normal project lease. Live `app` operations execute through the current owner and do not bypass editor or service-layer guards. `app pdf export` keeps its absolute destination in the native claimed request while the WebView supplies only the exact locked editor snapshot.
- Navigation and quit preserve unsaved work unless `--discard-unsaved` is explicit. `app document replace` requires the exact current revision and bounded standard input.
- A remote timeout after the editor claims a request is `remote_outcome_unknown`; automation must inspect state before deciding whether to retry.
- No command accepts an access token, client secret, arbitrary executable, arbitrary URL, or raw Git configuration.
- Commands that can overwrite or publish work must support a preflight/dry-run path before being included in automated validation.
- CLI adapters call shared service methods. Business rules must not be duplicated in argument handlers.

## Fast validation recipes

From `src-tauri/` in PowerShell:

```powershell
$undertreeExe = Resolve-Path '.\target\cli-release\release\undertree-typst.exe'
& $undertreeExe help
& $undertreeExe project status --project 'C:\Users\gyorg\Documents\UnderTree Projects\grants' --json
& $undertreeExe project files --project 'C:\Users\gyorg\Documents\UnderTree Projects\grants' --all --json
& $undertreeExe git status --project 'C:\Users\gyorg\Documents\UnderTree Projects\grants' --json
& $undertreeExe git branches --project 'C:\Users\gyorg\Documents\UnderTree Projects\grants' --json
& $undertreeExe github doctor --project 'C:\Users\gyorg\Documents\UnderTree Projects\grants' --json
cargo test --locked cli::tests
cargo test --locked remote_control::tests
cargo test --locked project::tests::inspects_a_project_without_conversion_or_private_state_creation
cargo test --locked project::tests::project_lease_serializes_desktop_and_cli_owners
cargo test --locked github::tests::ordinary_sync_refuses_to_misreport_uncommitted_files_as_synchronized
```

Project status/files, Git status/branches, and the grants doctor command are read-only. `app status --json` is also safe when a desktop instance is running. Do not use `commit-and-sync`, `push`, `pull`, project refresh, conversion, PDF export/reveal, save, bibliography creation, source replacement, or discard as an automated live-repository check. Mutating validation belongs in a disposable temporary repository and account-scoped test fixture.

Before handoff, run the repository-wide gates:

```powershell
cargo fmt --check
cargo check --locked
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
node --check ..\web\app.js
git diff --check
```

For a packaged smoke test, build to a fresh target directory if another UnderTree executable is running. Never terminate a live editor merely to replace its executable; first prove the editor has no unsaved state or ask the user to close it.

## Evidence and artifact hygiene

`For-AI/` contains Markdown instructions only. Test repositories, PDFs, screenshots, logs, JSON output, generated Typst/LaTeX, executables, and compiler artifacts must be stored in disposable OS temp folders or the appropriate build/output directory. Record only sanitized results and reproducible commands here.
