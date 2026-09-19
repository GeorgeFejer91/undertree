# Native ownership and YAGNI sweep

Scope: architecture-level source inspection of `typst-main` at `75513ffe`, not a runtime benchmark or exhaustive correctness audit. Paths below exist at that baseline; names described as proposed do not yet exist. No runtime deletions are authorized by this document.

## Keep, narrow, or defer

| Existing area | Evidence and intended treatment |
| --- | --- |
| `src-tauri/src/lib.rs`, `main.rs`, `commands.rs` | Keep Tauri bootstrap and thin typed adapters. Do not turn command handlers into a second policy engine. |
| `compiler.rs` | Keep embedded Typst, fonts, confinement, and limits. `compile()` and `compile_pdf()` each build a world and layout; refactor toward one snapshot/layout result used for PDF, selection provenance, and export. Current text runs carry text/geometry but not source-range identity. |
| `pdf.rs` | Keep native export, exact-revision tracking, no-clobber writes, and reveal guards. Extend with a bounded immutable preview-artifact path only after the rendering spike. Do not reintroduce the old Node/PDF.js application backend. |
| `project.rs` | Keep root approval, leases, digest guards, and atomic writes. Add compact-project validation and a recoverable three-file save. Current conflict-copy-and-overwrite behavior must not be reused as acceptance of stale suggestions. |
| `agent_annotations.rs` | Reuse validated UTF-8 anchors, policy generations, and Keep/Revise tests. Extend deliberately to light-edit/rework and pending suggestions. Move semantic rebasing/validation authority to Rust; reject ambiguous remaps. |
| `remote_control.rs`, `cli.rs` | Keep authenticated owner-mediated live snapshots and stable errors. Narrow a separate reviewer capability; existing document/agent replacement, save, navigation, conversion, Git, and quit are not reviewer tools. |
| `web/app.js`, `web/agent-annotations.js` | Keep the working UI during migration. Reduce to presentation and input adapters as native ownership lands. Replace full-document agent installation with suggestion rendering; do not copy policy logic into the new UI. |
| `web/citation-search.js`, `web/typst-editing.js` | Retain useful citation/input affordances and tests. Display-only ranking may remain frontend-side; Rust determines bibliography validity and patch correctness. No rewrite merely to reach a Rust line-count target. |
| `git.rs`, `github.rs` | Keep functioning optional synchronization and credential safeguards, but freeze feature expansion. Compact projects synchronize only their three canonical files; Git success alone is not proof of a coherent review snapshot. |
| `latex.rs`, `markdown.rs` | Compatibility adapters, not the normal writing pipeline. Keep originals and existing tested behavior. No automatic conversion on compact-project open/refresh; make migration explicit. Do not pursue universal LaTeX round-trip fidelity in this roadmap. |
| `Cargo.toml`, `Cargo.lock` | Already include Typst, Serde/JSON, `biblatex`, SHA-256, atomic writes, and Tauri. Reuse first. Tylax/ZIP remain tied to explicit legacy import; remove dependencies only after approved code removal and build evidence. |
| `For-AI/cli-roadmap.md`, `validation/` | Replace the broad CLI feature backlog with a short reference. Retain conditional regression protocols, not daily reading or live product state. Git history, not duplicate planning archives, preserves superseded directions. |
| `assets/`, `examples/`, build outputs | Keep used identity assets and useful fixtures. Determine references before proposing removal of old screenshots or generated files; size alone is not evidence of dead code. Never delete user projects. |

## Target services within the same Rust application

Use a single authoritative document snapshot containing source bytes, bibliography bytes, metadata generation, and policy generation. Frontend buffers provide edit intents/snapshots; native services validate and serialize accepted state transitions. Do not create a second writable document model just for AI.

A small proposed `review.rs` can own proposal validation, decisions, and scope checks, reusing `agent_annotations.rs`. A small proposed `project_format.rs` can own Serde structs, version validation, and manifest hashes, composed by `project.rs`. Start with modules, not a workspace full of service crates. Split further only when independent tests or a genuinely separate consumer need it.

The native compile worker accepts an immutable source/bibliography/resource snapshot and returns an identified build containing the retained Typst layout, real PDF artifact, diagnostics, and a source-provenance index. A private artifact handler serves only that build's bytes or page images. The UI overlays selections and suggestions; it does not infer permission from screen coordinates.

All entry points call these same services: local author UI, human-review UI, narrow review API, and optional MCP adapter. The API is a logical typed service contract first; a new HTTP server is not mandatory for in-process UI calls. MCP is an adapter, not a second implementation or a synonym for a network tunnel.

## External ideas: specify behavior, implement independently

| Reference | Behavior to investigate | Do not transplant |
| --- | --- | --- |
| [Typwriter](https://github.com/Ahdeyyy/typwriter) | Latest-snapshot compilation, page identity, source/preview navigation | Its source implementation, frontend framework, custom version store, mobile stack |
| [TypstPad](https://github.com/ladderlogix/typstpad) | Separate proposal/decision records; MCP calls the same application operations as humans | Its Go/PostgreSQL/Yjs infrastructure, unrestricted edit tool, inline-before-accept semantics |
| [Texpile](https://github.com/texpile/texpile) | Preserve unknown source constructs; approachable document interactions | Its Electron stack or a universal visual-editor reconstruction |
| [Typst IDE APIs](https://docs.rs/typst-ide/0.15.1/typst_ide/) | Supported native navigation/provenance primitives | A second compiler daemon; the assumption that click navigation proves arbitrary range mapping |

Write small original behavioral fixtures first, then implement against supported Typst APIs and UnderTree's own model. Pin compatible crate versions and retain license notices. No performance superiority or source-selection reliability claim is established by this reference list.
