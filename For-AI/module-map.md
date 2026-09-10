# Module map

| Area | Owner | Responsibility |
| --- | --- | --- |
| Tauri bootstrap | `src-tauri/src/lib.rs`, `main.rs` | Plugin initialization, managed state, command registration |
| Native CLI | `src-tauri/src/cli.rs`, `main.rs` | Product-specific direct commands over shared native services plus the authenticated running-editor client |
| Running-instance control | `src-tauri/src/remote_control.rs`, `src-tauri/src/lib.rs`, `web/app.js` | User-local authenticated loopback protocol, typed request broker, exact editor-state execution, and endpoint lifecycle |
| AI editing policy | `src-tauri/src/agent_annotations.rs`, `remote_control.rs`, `commands.rs`, `cli.rs`, `web/agent-annotations.js`, `web/app.js` | Durable Keep/Revise anchors, policy versions, source-scoped agent context, native replacement enforcement, and editor highlighting/catalog |
| IPC adapters | `src-tauri/src/commands.rs` | Request/response types and thin command boundary |
| Typst engine | `src-tauri/src/compiler.rs` | Typst world, validation, diagnostics, layout, SVG preview, and bounded PDF rendering |
| PDF output | `src-tauri/src/pdf.rs`, `commands.rs`, `cli.rs`, `remote_control.rs`, `web/app.js` | Shared bounded rendering, native Save As, explicit direct/live CLI output, no-clobber/atomic commit, revision-scoped remembered location, and reveal |
| Project policy | `src-tauri/src/project.rs` | Approved root and lease, zero-write inspection, bounded inventory, confined reads, bibliography creation, and conflict-safe saves |
| Document conversion | `src-tauri/src/latex.rs`, `markdown.rs` | Non-destructive LaTeX/Markdown to Typst companions and versioned Typst-to-LaTeX drafts |
| Git/GitHub | `src-tauri/src/git.rs`, `github.rs` | Bounded libgit2 transport, credentialed GitHub API, project approvals, synchronization, and divergence safety |
| Stable errors | `src-tauri/src/error.rs` | Sanitized application error vocabulary |
| Capabilities | `src-tauri/capabilities/main.json` | Commands available to the main WebView |
| App configuration | `src-tauri/tauri.conf.json` | Window, CSP, identity, frontend path, bundle policy |
| Local UI | `web/` | Editor, project list, compile scheduler, Blob preview |
| Example | `examples/welcome.typ` | Small manual and automated smoke-test project |
| CI | `.github/workflows/verify.yml` | Format, check, lint, test, release build |

Cross-boundary changes must update the Rust contract and frontend consumer together. Files under `src-tauri/target/`, `.undertree/`, and release/build-output directories are generated and must not be committed.
