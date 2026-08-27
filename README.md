# UnderTree

UnderTree is an offline-first Typst workspace built with Rust and Tauri. The Typst 0.15.1 compiler is embedded in the native process; users do not need a Typst CLI, Node.js, Electron, a TeX distribution, or a network connection for ordinary editing and preview.

This branch is the Rust/Typst rewrite. The former Electron/LaTeX application is frozen on GitHub at branch [checkpoint/latex-electron-v0.2.2](https://github.com/GeorgeFejer91/undertree_texstudio/tree/checkpoint/latex-electron-v0.2.2) and tag [latex-electron-v0.2.2-checkpoint](https://github.com/GeorgeFejer91/undertree_texstudio/tree/latex-electron-v0.2.2-checkpoint).

## What works

- plain local HTML/CSS/JavaScript wrapper hosted by Tauri's system WebView;
- the checkpoint application's visual shell, pane geometry, navigation rail, toolbars, resizers, and responsive breakpoints;
- embedded Typst compilation in Rust with bundled default fonts;
- multi-page SVG preview without injecting generated SVG into the DOM;
- latest-edit-wins compilation scheduling that never blocks typing;
- native folder selection for approving a project root;
- bounded .typ inventory and switching between project documents;
- project-relative Typst imports and assets confined to the approved root;
- UTF-8 and size validation at the Rust IPC boundary;
- atomic saves with revision acceptance guards;
- SHA-256 conflict detection and preservation of displaced disk content in .undertree/conflicts/;
- restrictive CSP and an explicit main-window command capability;
- no shell, network, generic filesystem, or remote-content authority exposed to the WebView.

The visual layout is a compatibility surface: future work should keep it identical to the checkpoint while replacing capabilities behind it with Rust/Typst implementations. The current foundation intentionally supports desktop folder projects. Package-registry imports are disabled so compilation remains offline and reproducible. PDF export, syntax highlighting, Git integration, and release installers are the next product slices; see [VERIFICATION.md](VERIFICATION.md) and [ARCHITECTURE.md](ARCHITECTURE.md) for the current boundary.

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

- src-tauri/src/compiler.rs: embedded Typst world, validation, diagnostics, and SVG export;
- src-tauri/src/project.rs: approved-root inventory, reads, conflict preservation, and atomic saves;
- src-tauri/src/commands.rs: thin Tauri command adapters;
- src-tauri/capabilities/main.json: least-privilege WebView command exposure;
- web/: local presentation wrapper and revision-aware interaction state;
- For-AI/: Markdown-only repository instructions for coding agents.

The existing application identifier io.github.georgefejer91.UnderTree is retained from the checkpoint. Signing, publishing, and changing the GitHub default branch are separate release operations.
