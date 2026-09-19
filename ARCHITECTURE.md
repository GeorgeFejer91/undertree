# UnderTree architecture

UnderTree is a local Tauri application with an embedded Typst compiler. The WebView is presentation-only; Rust owns compilation, project/review state, source-provenance validation, persistence, and authorization. The generated PDF is the primary review surface.

~~~text
web/ HTML, CSS, JavaScript
          |
          | typed, capability-scoped Tauri commands
          v
src-tauri/src/commands.rs
          |
          +--> project.rs: approved root, inventory, reads, atomic saves
          |
          +--> compiler.rs: Typst world, one layout, PDF bytes, PDF page rendering, source provenance
          |         |
          |         +--> pdf.rs: native Save As, atomic write, remembered reveal target
          |
          +--> review.rs: paper.json, marks, proposals/comments, human decisions, recovery journal
          |
          +--> latex.rs: bounded ZIP import, include graph, draft conversion
          |
          +--> github.rs: Device Flow, GitHub API, credential store, scheduler
                    |
                    +--> git.rs: confined in-process Git operations

cli.rs direct commands --> the same project/compiler/conversion/Git services
cli.rs app commands -- authenticated loopback --> remote_control.rs
          |
          +--> typed claim/completion --> the running WebView editor state
~~~

## Compiler boundary

The compiler loads Typst and its embedded default fonts once. Each compile receives the exact editor snapshot and creates a short-lived world with its own file cache. The editor snapshot is authoritative for the active document; imported source and assets are read from the approved project root.

Project-relative imports, including BibTeX bibliography files, are canonicalized and rejected if they escape that root. Package imports and additional roots are not supported. Source size, resource size, page count, rendered PDF-preview output, selectable provenance text, and PDF bytes have explicit upper bounds. Compilation, PDF generation, and Hayro page rendering run on Tauri's blocking pool so editing and window events remain responsive.

## PDF preview and output boundary

The live preview is the actual PDF product, not a separately typeset HTML/SVG approximation. For a preview snapshot, Rust compiles Typst once to a `PagedDocument`, generates PDF bytes with `typst-pdf`, and rasterizes those PDF pages with the pure-Rust Hayro renderer. A transparent selectable layer uses geometry from that same Typst layout; a text run receives source byte offsets only when every contributing glyph maps to the active source and the exact source substring equals the rendered text. Generated/macro text therefore remains readable/selectable but is not silently authorized as an edit target.

Every preview response is tied to the editor revision. The frontend discards stale completions, keeps the previous complete render while a new build runs, scales bitmap/text/highlight layers together, and exposes PDF review actions only against the current mapped revision.

Explicit PDF export remains a separate user operation. The native Save dialog suggests a name based on the active `.typ` document; the direct CLI requires an explicit output path. Export is page/size bounded, atomically committed, and remembered only for the matching document revision before Reveal is enabled. PDF bytes and writable absolute paths never become generic WebView authority.

## Project and save boundary

A project root enters application state only through the native folder picker, an exact remembered selection, or an explicit canonical product-CLI request. Inventory traversal is depth- and count-bounded and skips symlinks, `.git`, `.undertree`, dependency caches, and build targets. The snapshot exposes relative-path metadata for every other regular file so the WebView can apply a non-destructive smart visibility filter. Generic editable document content remains limited to UTF-8 `.typ`, `.bib`, and UnderTree-generated `*.undertree-export*.tex` files. `paper.json` is visible as review metadata but is never a generic editable document. Original LaTeX, PDFs, images, and other support assets cannot be opened through document IPC. New bibliographies are created through a dedicated command that accepts only a relative `.bib` path whose existing parent canonicalizes inside the approved root. A separate read-only command parses at most 64 confined `.bib` files and 12,000 entries into bounded citation summaries; malformed files and cross-file duplicate keys become local issues while valid entries remain searchable. The WebView ranks those summaries in memory and never receives arbitrary project files or filesystem authority.

The direct `project status`, `project files`, and `document read` commands use a zero-write inspection path. It canonicalizes the supplied root, reuses the bounded scanner and editable-document policy, and does not select the project, acquire its lease, run conversion, update recent projects, or create `.undertree`. Lock state is reported only when an already-existing safe advisory lock can be probed; otherwise it remains unavailable rather than creating state. Direct mutations install a short-lived approved project state and hold the normal project lease for their lifetime.

UnderTree keeps a bounded, versioned recent-project registry in its native application configuration directory. Each successful native selection records the canonical project root, display name, and parent folder. The WebView can list that metadata, but it can reopen only an exact root already present in the native registry; Rust canonicalizes it again and reacquires the project lease before installing it as the active authority root. Missing folders remain visible in history and fail safely when reopened instead of granting a replacement folder implicit authority.

Every opened document carries a SHA-256 digest. A save compares that digest with the current disk content. If another process changed the file, UnderTree first atomically preserves the displaced bytes in `.undertree/conflicts/`, then atomically commits the editor snapshot. The UI accepts a save result only when its revision still matches the editor revision.

## Compact review state and acceptance

New compact projects are created as `paper.typ`, `paper.bib`, and `paper.json`. `review.rs` owns the versioned metadata schema, exact UTF-8 anchors with prefix/suffix context, Keep/Light edit/Rework policy, pending suggestions, comments, source/bibliography digests, and idempotent reviewer record IDs. A source or bibliography change supersedes pending proposals conservatively; ambiguous rebasing fails closed.

Proposal/comment submission writes `paper.json` only. Acceptance exists only on the human Tauri review command. It rechecks the saved source digest, policy version, proposal state, target bytes, mark kind, and Light-edit citation/number preservation. Accepted source plus the updated metadata are protected by a private `.undertree/review-transaction.json` recovery journal. Recovery rolls forward only when the observed files still match the expected old/new digests; an unrelated external write stops recovery rather than choosing a winner.

The authenticated running-editor protocol has reviewer-specific `ReviewContext`, `ReviewPropose`, and `ReviewComment` requests with typed results and bounds. There is no reviewer Accept request. The CLI exposes those three reviewer operations and requires caller-supplied proposal/comment IDs for retry idempotency. The old direct-agent replacement request is refused by the frontend and is no longer an advertised reviewer workflow.

## IPC and frontend

Commands are thin adapters over the compiler, PDF, and project services. Boundary errors are deliberately stable and sanitized. The frontend centralizes command invocation and uses latest-state-wins scheduling: at most one preview compile runs, with one newest follow-up snapshot retained. PDF completion is also revision-guarded so a saved older snapshot is never presented as the current export.

The frontend reuses the checkpoint application's stylesheet and layout vocabulary. Its top bar, activity rail, split file/diagnostic sidebar, editor and preview panes, toolbars, resizers, and status bar are a compatibility contract. Capability labels may change from TeX to Typst, but layout changes require an explicit product decision and a rendered comparison against the checkpoint screenshot.

Compiled preview pages are returned as bounded PNG data images produced from the generated PDF and displayed inertly through image elements. The transparent text/provenance layer contains text and geometry only; generated document markup is never injected as HTML.

## LaTeX conversion boundary

LaTeX import is a native, offline migration path rather than a second compiler. Rust selects files, confines and budgets project traversal, extracts Overleaf ZIPs into a unique staging directory, expands an approved include graph, invokes the pinned Apache-2.0 Tylax 0.3.7 library, atomically creates new `.typ` siblings, and compile-validates every newly generated root with the embedded Typst engine. The converter has no network or general filesystem authority, and UnderTree never invokes TeX, shell escape, project scripts, or downloaded packages.

Every original source and asset remains byte-for-byte present. Existing Typst output is never overwritten. Archive entries are bounded by archive size, entry count, individual size, actual expanded bytes, path length, and depth; traversal, absolute/drive paths, links, special files, encryption, duplicate case-folded paths, `.git`, `.undertree`, alternate data streams, and Windows reserved names are rejected before staging is promoted.

UnderTree, not Tylax, owns multi-file semantics. It recognizes root documents and `% !TeX root`, recursively expands confined `\input`, `\include`, `\subfile`, and `\subfileinclude` dependencies with cycle/depth/aggregate-byte guards, removes standalone subfile preambles before inclusion, ignores include-like text in literal environments, and restores external bibliography declarations, safe HTML color bindings, common TeX accents, simple page geometry, and supported multicolumn checklist layouts. `\import`, `\subimport`, minipages, and custom table column declarations remain explicit review warnings.

Tylax runs with `non_strict: true` so unknown macro arguments are preserved rather than silently discarded. Release builds retain unwind semantics so `catch_unwind` can contain known converter panics; a separate Unicode multirow guard covers the current upstream byte-index crash. Generated content is always labelled a draft and reports known semantic-loss cases. Compile success proves Typst syntax and resources resolve, not visual or semantic equivalence to LaTeX.

Reverse conversion is also local and in-process. Rust requires an already approved `.typ` path, compiles the saved source with the embedded Typst world under the project root, calls Tylax's structured Typst-to-LaTeX diagnostics API behind panic containment, validates the complete-document wrapper and size, and atomically creates a versioned `*.undertree-export[-N].tex` sibling. Only those generated LaTeX exports cross the editor inventory boundary; unrelated preserved `.tex` sources remain hidden and inaccessible through document IPC. No existing source or export is overwritten.

The durable fidelity gate is Markdown-only under `For-AI/validation/latex-fidelity/`. It separates preservation, compilation, content retention, and rendered-layout claims. Disposable PDFs, raster pages, logs, and fixture copies are written only below ignored `tmp/latex-fidelity/`, summarized in the result ledger, and removed after review.

## GitHub synchronization boundary

GitHub synchronization is optional and does not change the offline editing or preview path. The WebView can request only typed GitHub operations. Rust owns the Device Flow exchange, native clipboard write, fixed browser launch, GitHub API calls, repository selection checks, credential storage, interval scheduler, and every local Git mutation. Authorization validates the pending attempt, displays its public one-time code, copies it, confirms that state in the modal, and only then opens GitHub's fixed device-login URL in the system browser; GitHub pages are never embedded in the privileged WebView.

UnderTree has one publisher-owned public OAuth App registration, **UnderTree Typst Desktop**. Its public client ID is checked into and compiled into the native binary, which contains no client secret. There is no per-user app-registration or per-repository installation flow, runtime/process-environment override, persisted identity file, or WebView command that can replace UnderTree's identity. Stored sessions are bound to the compiled Client ID, so an identity rotation safely requires reauthorization.

Access and refresh tokens are bounded, kept out of IPC responses, and stored under the application service name in the operating-system credential manager. HTTP requests disable redirects, use fixed GitHub origins, enforce timeouts and response-size limits, and return sanitized boundary errors. Git transport credentials are supplied to libgit2 only after the configured `origin` exactly matches the selected `https://github.com/owner/repository.git` URL. Repository-local credential, proxy, URL-rewrite, and TLS overrides are rejected. UnderTree installs no certificate callback, so libgit2's native Windows trust decision remains authoritative and a failed certificate validation cannot be accepted or accidentally replaced. Process-wide libgit2 connection/server timeouts cover silent network stalls in addition to callback-based transfer limits.

UnderTree requests the OAuth `repo` scope and enumerates repositories the authorized user can access as an owner, collaborator, or organization member. The API response is reduced to validated names, default branches, creation dates, visibility, ownership, and write capability; the WebView can sort and filter only that bounded metadata. GitHub and organization policy still determine whether each repository is writable. Read-only repositories remain cloneable, linkable, and pullable; push and automatic-commit controls stay unavailable without write access. Linking reuses a repository only when `origin` is the exact selected HTTPS URL. Cloning creates one new repository-named child beneath a natively selected parent. Creating a project uses only the fixed authenticated-user repository endpoint, then creates `main.typ`, commits, pushes, and opens the confined local folder; UnderTree exposes no repository-deletion command.

The selected local folder remains the source of truth and authority root. UnderTree edits the same on-disk files seen by local Git and other tools; a confined native refresh reinventories the folder and rereads the preferred active document after external changes, while revision digests protect unsaved edits. It does not maintain a second editor database or a GitHub-Contents-API editing path. GitHub receives local changes only through the guarded Git synchronization path. Repositories whose work tree, common Git directory, nested Git metadata, or `.undertree` state escapes the approved root are rejected, as are external Git config includes, object alternates, and repositories that track `.undertree/`. Clones use a short identity-checked staging child, enforce object/byte/path checkout limits, enable repository-local `core.longpaths` on Windows, and atomically promote only a complete checkout. The private state directory is added to the repository-local `.git/info/exclude`, is excluded from application-created commits, and does not alter the shared `.gitignore`.

Synchronization never switches the user's branch, cleans or force-checks out the work tree, rewrites history, or force-pushes. Clean remote advances use a fast-forward. Non-conflicting divergence is merged into a normal local merge commit; content conflicts, local dirtiness during a pull, ignored-file collisions, active Git operations, and changed fetch or push destinations stop without replacing local work.

The current libgit2 bridge does not initialize submodules or materialize Git LFS objects. Existing complete local checkouts remain linkable, but native clone results for repositories using these extensions are intentionally reported as ordinary work trees rather than guaranteed complete project materializations.

Non-secret rules live in `.undertree/github-sync.json` and permit only Off, 5, 15, 30, or 60 minute intervals. Rules authorize no operation by themselves: Link, Clone, or Create writes a separate OS-credential-store approval bound to the canonical path plus stable directory identity, compiled OAuth client, immutable GitHub account ID, repository, branch, and write capability. The scheduler ignores rules without that exact native approval. It runs only for the currently selected project, serializes GitHub work, and requires a fresh fail-closed clean-editor lease before mutating the work tree. The desktop single-instance interlock prevents duplicate GUI workers, while an OS-backed exclusive `.undertree/project.lock` lease serializes a current desktop owner and native CLI mutations across processes. Automatic commits are separately opt-in. It never invokes a shell, external Git executable, GitHub CLI, or GitHub Desktop.

The console entry point is selected before Tauri startup whenever command-line arguments are present. `cli.rs` parses a bounded product-specific grammar and calls the same project, compiler, PDF, conversion, `GitHubService`, and libgit2 functions as Tauri commands; it exposes no arbitrary shell, URL, token, credential-store, or filesystem primitive. The direct surface includes project inventory/refresh, confined document read/save, bibliography creation, embedded compilation, explicit PDF export, three conversion directions, bounded Git, and the GitHub account/repository lifecycle. Human output and optional JSON contain only sanitized result DTOs and compiler diagnostics. Read-only project inspection does not take the project lease. Refresh, save, PDF export, bibliography, conversion, and Git/GitHub mutations use the native lease; link, clone, rules, pull, push, sync, and commit-and-sync also use a clean-editor heartbeat local to the CLI lifetime. Ordinary Sync rejects an uncommitted working tree instead of reporting those files as synchronized; Commit & Sync remains the explicit operation that stages, commits, fetches, reconciles, and pushes.

## Running-editor remote-control boundary

The separate `app` command group controls the currently running editor rather than opening the saved project in a competing process. `remote_control.rs` brokers a closed set of typed requests for status, focus, project/document navigation, current-source read and revision-guarded replacement, save, bibliography creation, compile, exact-overlay PDF export/reveal, Typst-to-LaTeX export, and guarded quit. The frontend declares readiness, claims each queued request exactly once, executes requests serially against its current editor state, and returns a result type that Rust validates against the original request. Native-only authority such as a project root or CLI-supplied PDF destination is redacted from the claimed request returned to the WebView and resolved later from the authenticated request ID. Project opening and PDF writing still enter through narrow native adapters; no generic filesystem, opener, or JavaScript execution primitive is introduced.

The native process listens only on an ephemeral IPv4 loopback port and publishes a bounded, versioned endpoint record in the per-user application configuration directory. A random 256-bit capability remains native-side. Fresh client and server nonces and HMAC-SHA-256 proofs authenticate the server and bind the protocol version, both nonces, requested timeout, serialized request length, and exact request bytes. Comparisons are constant-time; malformed or unknown fields fail closed. The endpoint and handshake records are limited to 4 KiB, a framed request or response to 8 MiB, and source text to 1 MiB. At most eight connections and 64 pending requests are accepted. Live CLI timeouts default to 30 seconds and are restricted to 1 through 120 seconds; handshake and I/O waits have shorter native caps, and an abandoned claimed request expires after ten minutes. Unix endpoint directories and records are forced to `0700` and `0600`; Windows inherits the current user's profile access controls.

This channel is a same-OS-user capability boundary, not a network API or a confidentiality boundary against that user or a privileged local process. The capability is never returned through CLI output, logs, events, or WebView IPC. Normal shutdown removes only the endpoint whose capability matches the current server. A stale unreachable endpoint lets `open` fall back to normal application startup, while malformed records and protocol mismatches fail closed.

Live operations preserve editor semantics. Reads can return the unsaved source overlay. Replacement requires the exact current revision, marks the editor dirty, and leaves persistence explicit. Project/document navigation and quit reject unsaved work unless the caller deliberately supplies `--discard-unsaved`; save retains digest/conflict handling, and compile uses the exact current overlay. Busy editor and GitHub operations are serialized or refused. A timeout before claim cancels the request; a timeout after claim reports an unknown outcome so an automation client does not blindly repeat a mutation.

`open --project PATH [--source RELATIVE.typ]` first attempts this authenticated path. A running editor can validate, open, and focus the request without losing unsaved work; if no valid endpoint is reachable, the process starts the desktop application with the requested initial selection. Tauri's single-instance callback remains the race fallback and validates relative paths against the sender's working directory before focusing the existing window.

## Security model

The main WebView receives only the application commands explicitly listed in `src-tauri/capabilities/main.json`. The content security policy denies remote content, objects, frames, forms, and arbitrary connections. The application exposes no shell, generic network, generic filesystem, or generic path-opening command; PDF output, GitHub network, Git transport, and authenticated loopback control are narrow Rust-owned services. Remote-control claims and completions are typed Tauri commands, and the endpoint capability never crosses into the WebView.

The principal remaining risks are resource-heavy legal Typst programs, platform WebView behavior, and user-created repository divergence. Compile and transport limits, the blocking pool, a restrictive CSP, guarded fast-forward/merge operations, release builds, and manual platform smoke tests are the current controls.
