# Native ownership and YAGNI sweep

Scope: runtime ownership for the PDF-review implementation candidate on `feature/rust-pdf-review`. Items labelled compatibility remain supported but are not the primary product path. No user project is migrated or deleted implicitly.

## Keep, narrow, or defer

| Existing area | Evidence and intended treatment |
| --- | --- |
| `src-tauri/src/lib.rs`, `main.rs`, `commands.rs` | Keep Tauri bootstrap and thin typed adapters. Do not turn command handlers into a second policy engine. |
| `compiler.rs` | Embedded Typst remains authoritative. Live compile now lays out once, creates PDF bytes, renders PDF pages through Hayro, and emits exact source provenance only for directly mapped text runs. Explicit export may compile its own requested snapshot. |
| `pdf.rs` | Keep native export, exact-revision tracking, no-clobber writes, and reveal guards. Extend with a bounded immutable preview-artifact path only after the rendering spike. Do not reintroduce the old Node/PDF.js application backend. |
| `project.rs` | Keep root approval, leases, digest guards, atomic writes, and inventory. `paper.json` is visible review metadata but not a generic editable document; `paper.typ` is preferred for compact projects. |
| `review.rs` | Canonical portable review engine: three mark kinds, exact/context anchors, idempotent proposal/comment records, Light-edit token guards, human decisions, digest generations, and private recovery journal. |
| `remote_control.rs`, `cli.rs` | Keep authenticated owner-mediated transport. Reviewer-specific context/propose/comment requests are typed and bounded; no review Accept exists. The legacy direct-agent replacement path is compatibility-only and refused by the frontend. |
| `web/app.js`, `web/review-ui.js`, `web/review-selection.js` | Presentation/input only: generated-PDF pages, transparent mapped text, selection gestures, review cards and decisions. Rust remains authoritative for scope and acceptance. Old source-mark UI is hidden. |
| `web/citation-search.js`, `web/typst-editing.js` | Retain useful citation/input affordances and tests. Display-only ranking may remain frontend-side; Rust determines bibliography validity and patch correctness. No rewrite merely to reach a Rust line-count target. |
| `git.rs`, `github.rs` | Keep functioning optional synchronization and credential safeguards, but freeze feature expansion. Compact projects synchronize only their three canonical files; Git success alone is not proof of a coherent review snapshot. |
| `latex.rs`, `markdown.rs` | Compatibility adapters, not the normal writing pipeline. Keep originals and existing tested behavior. No automatic conversion on compact-project open/refresh; make migration explicit. Do not pursue universal LaTeX round-trip fidelity in this roadmap. |
| `Cargo.toml`, `Cargo.lock` | Typst/Serde/biblatex/SHA/atomic/Tauri remain. Hayro + base64 support real-PDF preview; Pretext is a pinned local web dependency built into `dist/`. Tylax/ZIP remain explicit legacy compatibility. |
| `For-AI/cli-roadmap.md`, `validation/` | Replace the broad CLI feature backlog with a short reference. Retain conditional regression protocols, not daily reading or live product state. Git history, not duplicate planning archives, preserves superseded directions. |
| `assets/`, `examples/`, build outputs | Keep used identity assets and useful fixtures. Determine references before proposing removal of old screenshots or generated files; size alone is not evidence of dead code. Never delete user projects. |

## Target services within the same Rust application

Use a single authoritative document snapshot containing source bytes, bibliography bytes, metadata generation, and policy generation. Frontend buffers provide edit intents/snapshots; native services validate and serialize accepted state transitions. Do not create a second writable document model just for AI.

`review.rs` now owns proposal validation, decisions, portable metadata and recovery. Keep it as one bounded module until a demonstrated second consumer requires extraction. `project.rs` remains the filesystem/inventory owner; do not create a second writable project model.

The native compile worker accepts an immutable source/resource snapshot, retains the Typst layout long enough to generate PDF bytes and exact direct-source provenance, and returns bounded PDF page images plus diagnostics/provenance. The UI overlays selections and suggestions; it never infers permission from screen coordinates alone.

All entry points call these same services: local author UI, human-review UI, narrow review API, and optional MCP adapter. The API is a logical typed service contract first; a new HTTP server is not mandatory for in-process UI calls. MCP is an adapter, not a second implementation or a synonym for a network tunnel.

## External ideas: specify behavior, implement independently

| Reference | Behavior to investigate | Do not transplant |
| --- | --- | --- |
| [Typwriter](https://github.com/Ahdeyyy/typwriter) | Latest-snapshot compilation, page identity, source/preview navigation | Its source implementation, frontend framework, custom version store, mobile stack |
| [TypstPad](https://github.com/ladderlogix/typstpad) | Separate proposal/decision records; MCP calls the same application operations as humans | Its Go/PostgreSQL/Yjs infrastructure, unrestricted edit tool, inline-before-accept semantics |
| [Texpile](https://github.com/texpile/texpile) | Preserve unknown source constructs; approachable document interactions | Its Electron stack or a universal visual-editor reconstruction |
| [Typst IDE APIs](https://docs.rs/typst-ide/0.15.1/typst_ide/) | Supported native navigation/provenance primitives | A second compiler daemon; the assumption that click navigation proves arbitrary range mapping |

Write small original behavioral fixtures first, then implement against supported Typst APIs and UnderTree's own model. Pin compatible crate versions and retain license notices. No performance superiority or source-selection reliability claim is established by this reference list.
