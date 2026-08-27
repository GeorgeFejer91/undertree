# Module map

| Area | Owner | Responsibility |
| --- | --- | --- |
| Tauri bootstrap | `src-tauri/src/lib.rs`, `main.rs` | Plugin initialization, managed state, command registration |
| IPC adapters | `src-tauri/src/commands.rs` | Request/response types and thin command boundary |
| Typst engine | `src-tauri/src/compiler.rs` | Typst world, validation, diagnostics, layout, SVG export |
| Project policy | `src-tauri/src/project.rs` | Approved root, bounded inventory, confined reads, conflict-safe saves |
| Stable errors | `src-tauri/src/error.rs` | Sanitized application error vocabulary |
| Capabilities | `src-tauri/capabilities/main.json` | Commands available to the main WebView |
| App configuration | `src-tauri/tauri.conf.json` | Window, CSP, identity, frontend path, bundle policy |
| Local UI | `web/` | Editor, project list, compile scheduler, Blob preview |
| Example | `examples/welcome.typ` | Small manual and automated smoke-test project |
| CI | `.github/workflows/verify.yml` | Format, check, lint, test, release build |

Cross-boundary changes must update the Rust contract and frontend consumer together. Files under `src-tauri/target/`, `.undertree/`, and release/build-output directories are generated and must not be committed.
