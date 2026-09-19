# YAGNI architecture audit — 19 September 2026

Baseline: `typst-main@75513ffef8846538352c154952ee501a7a5755b3`. Scope: repository/module inventory, selected runtime paths, manifests, and existing design/protocol documentation. This is not an exhaustive line-by-line, security, dead-code, performance, or packaged-runtime audit. No application was launched; no tests/benchmarks were run. v3 discovery was unavailable in this turn, so evidence comes from the connected GitHub repository. Nothing below authorizes runtime deletion before review.

## Main finding

Retain the native Typst product. It already has compilation, real PDF export, native persistence/security, live editor control, and policy anchors. The missing product is a portable **PDF-first suggestion workflow**, not a new Typst migration. Much existing complexity supports conversion and repository management rather than that loop; quarantine and retire deliberately, not by copying a different complete editor.

| Area/evidence | Finding | Proposed disposition |
| --- | --- | --- |
| `src-tauri/Cargo.toml` | Tauri 2, Typst family 0.15.1, embedded fonts, Rust-native services; Tylax, ZIP, git2, reqwest and keyring also present | Keep core; add no Electron/Node/CLI runtime. Remove other dependencies only with retired callers and tested packaging. Cargo `incremental=false` concerns Rust builds, not document preview. |
| `compiler.rs: compile/compile_pdf` | Fonts/library shared; each request creates a world; preview serializes SVG for every page; PDF path performs another compilation | Measure persistent source/cache reuse and one paged build for PDF/map/export. Do not assert existing Typst memoization is absent or promise page-local reflow. |
| `compiler.rs: PreviewTextRun/collect_preview_text` | Selectable runs contain text/geometry, not source spans; top-to-bottom/left-to-right sorting is not semantic multi-column mapping | Reuse traversal knowledge, not its geometry as edit authority. Add verified compiler-span mapping; ambiguity must remain unresolved. |
| `compiler.rs` limits | 1 MiB source, 128 pages, 32 MiB preview, 64 MiB PDF; bounded selectable text | Keep explicit bounds. Check real thesis workloads before changing limits; do not lift them blindly. |
| `pdf.rs` + `ARCHITECTURE.md` PDF boundary | Real PDF export exists, separately from SVG preview; PDF bytes currently do not cross WebView IPC | Add a narrowly authorized build-artifact path and locally bundled viewer. An SVG page is not the requested actual PDF highlighter. |
| `agent_annotations.rs` + editing protocol | Keep/Revise, UTF-8 ranges, versions and stale checks; policy stored in `.undertree/agent-editing.json`; no Revise means broad unprotected scope | Reuse validators; migrate rules into the canonical JSON; explicit reviewer scope; add rework and pending proposals. No silent permissions widening. |
| `app agent replace` protocol | A successful full-source replacement installs text and consumes Revise marks | Retire direct replacement from reviewer capability. Submission must not touch source or consume marks; human decisions are distinct operations. |
| `project.rs` behavior documented in architecture | SHA-256 conflicts are backed up before the editor version replaces disk | Preserve backups/atomic writes, but stop for conflicts in the collaborative profile. Backing up first does not make overwriting a collaborator safe. |
| `web/app.js` | 186,465-byte central file; DOM setup, editor state, preview, marks and GitHub controls share it | Extract only preview/review/state seams touched by implementation. Size is a coupling signal, not proof of removable code. No whole-frontend rewrite. |
| `web/styles.css`, `index.html` | Existing layout and source/visual modes | Keep useful visual vocabulary; make PDF review primary through an explicit layout change. Do not maintain a second canonical rich-text representation. |
| `latex.rs`, `markdown.rs`, conversion docs | Large bidirectional conversion, include graphs, archive hygiene, fidelity validation | Freeze new conversion work. Plan removal from default writing UX after non-destructive migration exists; preserve originals and necessary importer safety. |
| `git.rs` / `github.rs` | Respectively 113,169 / 105,052 bytes at baseline; guarded transport, account/repo lifecycle, scheduling and tests | Keep necessary manual transport; freeze unrelated account/admin/scheduler expansion. Native module sizes include tests; no blanket deletion claim. |
| `cli.rs` / `remote_control.rs` | Broad owner-command surface and authenticated local broker | Reuse authentication/receipts, not owner powers in reviewer sessions. Stop “every UI operation gets a CLI verb” expansion. |
| Root README/ARCHITECTURE and `For-AI/` | Current-feature explanations and old CLI/conversion roadmaps overlap | Rewrite the active guidance now. Keep historical evidence off the mandatory read path; update shipped feature docs alongside actual code changes. |
| CI, tests, security, recovery | Essential correctness infrastructure | Keep. Safety checks and tests are not YAGNI clutter. No claimed speedup or test pass from this audit. |

## The first removal candidates, after approval

Reverse Typst-to-LaTeX exports, the expanding conversion-fidelity program, default ZIP/import-centric UI, unsupported file-category controls in portable mode, and newly unnecessary duplicate command wrappers. Trace callers, CLI help, tests, capability manifests, examples and docs before deletion. Preserve compatibility reads and user originals; no auto-pruning of existing projects. Freeze rather than remove optional GitHub transport until the selected sync path can replace it.

Do not yet add CRDT infrastructure, WebRTC relays, a Google Sheets database, multiple storage adapters, a complete Tinymist desktop fork, a second WASM compiler, autonomous source-writing repair, or an embedded Secret Tunnel clone.

## Evidence

All repository references below are pinned to the audit baseline, not the moving default branch:

- [Compiler, preview text and PDF paths](https://github.com/GeorgeFejer91/undertree_texstudio/blob/75513ffef8846538352c154952ee501a7a5755b3/src-tauri/src/compiler.rs)
- [Annotation types and storage](https://github.com/GeorgeFejer91/undertree_texstudio/blob/75513ffef8846538352c154952ee501a7a5755b3/src-tauri/src/agent_annotations.rs)
- [Native dependencies](https://github.com/GeorgeFejer91/undertree_texstudio/blob/75513ffef8846538352c154952ee501a7a5755b3/src-tauri/Cargo.toml)
- [Existing architecture and persistence/control boundaries](https://github.com/GeorgeFejer91/undertree_texstudio/blob/75513ffef8846538352c154952ee501a7a5755b3/ARCHITECTURE.md)
- [Old direct-edit protocol](https://github.com/GeorgeFejer91/undertree_texstudio/blob/75513ffef8846538352c154952ee501a7a5755b3/For-AI/agent-editing-protocol.md)
- [Existing frontend](https://github.com/GeorgeFejer91/undertree_texstudio/blob/75513ffef8846538352c154952ee501a7a5755b3/web/app.js)
