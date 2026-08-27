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

Compiler tests cover scratch compilation, invalid Typst diagnostics, source limits, project inventory, and path confinement. CI repeats formatting, checking, linting, testing, and the release build on Ubuntu.

## Desktop smoke test

Run `cargo run --manifest-path src-tauri/Cargo.toml`, then verify:

1. the scratch document renders without selecting a project;
2. Open project uses the native folder picker and lists `.typ` documents;
3. editing schedules a preview without freezing typing;
4. Ctrl+Enter compiles immediately and Ctrl+S saves;
5. an invalid Typst edit shows diagnostics without destroying the last interaction state;
6. a disk-side edit followed by save creates `.undertree/conflicts/`;
7. an import outside the approved root is rejected;
8. closing and reopening the window releases preview Blob URLs.

For visual compatibility, render the frontend at 1440 × 825 and compare it with `assets/localtex-studio-screenshot.png` from the checkpoint branch. The top bar, navigation rail, sidebar split, editor/preview panes, toolbars, gutters, and status bar must retain their geometry and visual hierarchy.

Signing, installer generation, PDF export, Git operations, and changing the GitHub default branch are not part of the current runtime verification gate.
