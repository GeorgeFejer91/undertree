# Implementation and validation workflow

Current implementation candidate: `feature/rust-pdf-review`. The core PDF-review, three-file, human suggestion, AI reviewer CLI, and Pretext fitting paths are implemented. Merge readiness depends on the gates below; do not substitute a written plan for compiler/packaged-desktop evidence.

## Implemented slices

1. **Compact format:** new GitHub projects create `paper.typ`, `paper.bib`, `paper.json`; review metadata is bounded, versioned, non-generic-editable, and crash-recoverable.
2. **Actual-PDF preview:** the embedded Typst layout produces PDF bytes; pure-Rust Hayro renders those PDF pages; exact source provenance is attached conservatively to directly mapped text runs.
3. **Human review loop:** PDF Keep/Light edit/Rework, suggestions/comments, reject/revision feedback, explicit human acceptance.
4. **Reviewer adapter:** authenticated remote protocol + CLI context/propose/comment; no reviewer acceptance/direct edit.
5. **Shared UI fitting:** pinned Pretext is bundled locally into `dist/`; one adapter fits constrained controls; SVG geometry is container-bound.

Existing GitHub, conversion, and owner/developer CLI features remain compatibility paths. Do not expand them while stabilizing review.

## Required automated gates

From repository root:

```text
npm install --ignore-scripts --no-audit --no-fund
npm run build:web
npm run check:web
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
cargo build --locked --release --manifest-path src-tauri/Cargo.toml
git diff --check
```

The repository GitHub Action installs/builds the web bundle before Rust checking because Tauri points at `dist/`. Node/npm are build/test tooling, not application runtime dependencies.

A GitHub Actions job that ends before any step/log executes is an infrastructure/startup failure; report it separately. It does not prove the compiler passed or failed.

## Required review correctness

- proposal submission/rejection never changes `paper.typ` or `paper.bib`;
- Accept applies one exact pending proposal once and cannot cross Keep;
- Light edit refuses deletion and citation/number token changes;
- source/bibliography changes invalidate or supersede pending proposals;
- duplicate proposal/comment IDs are idempotent only when content matches;
- crash between acceptance writes recovers one coherent new state or fails closed on an unrelated external write;
- stale/ambiguous/generated PDF selection never authorizes a source change;
- reviewer remote/CLI surface has context/propose/comment only; no accept/source-save/replace/Git/conversion authority.

## Required desktop/UI evidence

Test the packaged app with mapped Unicode prose, repeated text, page zoom, stale preview, narrow panes, long labels, theme/font/text-scale changes, and hidden-to-visible review panels. Verify PDF bitmap/text/highlight layers remain aligned and Pretext settles without observer loops or unreadably shrinking long-form review text.

See root [VERIFICATION.md](../VERIFICATION.md) for the complete smoke matrix and [ui-rules.md](ui-rules.md) for fitting evidence.

## Remaining non-blocking product work

Do not call these implemented:
- simultaneous real-time multi-user collaboration/CRDT;
- automatic Google Drive/Dropbox/etc. provider integration;
- resource embedding that makes figure-heavy projects literally three files;
- automatic Secret Tunnel/MCP configuration;
- performance claims for 50/100-page papers until benchmarked on packaged targets.

When one becomes a real requirement, implement the smallest slice on top of the existing Rust review contract rather than adding a parallel document model.
