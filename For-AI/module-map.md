# Ownership and target architecture

Status: proposed boundaries, not modules already added. Preserve the Tauri/Rust + local `web/` stack. Adding review does not justify React, Electron, a second compiler, or a new service process by default.

```text
Human PDF/source UI ── typed Tauri/author API ─┐
                                            ├─ Rust review/project service
AI client ── thin MCP adapter ─ reviewer API ─┘       │
                                            coherent three-file project
                                                     │
                                      native Typst compile snapshot
                                           ┌─────────┴─────────┐
                                      PDF artifact       source mapping
                                           └─────────┬─────────┘
                                       local PDF viewer + review overlay
```

The API is the application contract, not another mandatory HTTP server. Keep Tauri and the existing authenticated local broker as adapters. A future MCP connection calls narrow shared review methods; do not tunnel the owner control endpoint wholesale.

| Existing owner | Keep/reuse | Planned change after approval |
| --- | --- | --- |
| `src-tauri/src/compiler.rs` | Embedded Typst, fonts, confinement, diagnostics, byte/page limits | Coherent in-memory `.typ`/`.bib` inputs; measured persistent source/cache reuse; PDF and native span map from the same build |
| `src-tauri/src/pdf.rs` | Bounded PDF generation, native export, atomic destination handling | Reuse exact accepted build for export; add narrow artifact delivery to the PDF viewer without exposing arbitrary paths |
| `src-tauri/src/project.rs` | Root approval, digests, inventory, leases, atomic writes | Explicit portable three-file profile; JSON schema/checkpoints and coherent recovery; conflicting saves stop rather than auto-overwrite |
| `src-tauri/src/agent_annotations.rs` | Native range validation, Unicode anchors, policy generations, stale detection | Keep/light-edit/rework policies; explicit review scope; durable proposals and decisions; no direct AI replacement |
| `src-tauri/src/remote_control.rs`, `commands.rs`, `cli.rs` | Typed bounded requests, live-buffer revision guards, shared native services | Separate author/reviewer credentials and dispatch; only narrowly needed review CLI verbs; old owner replacement must not appear in reviewer capability |
| `web/app.js`, `web/agent-annotations.js` | Editor state, selection helpers, async guards, undo foundations | Extract only touched preview/review/state seams; replace source-only marking with PDF-first marking and suggestion margin |
| `web/typst-editing.js`, citation helpers/tests | Author editing and bibliography usability | Keep one source of truth; no second rich-text document representation; exactly one bibliography in portable mode |
| `web/styles.css`, `web/index.html`, `src-tauri/tauri.conf.json`, capabilities | Visual vocabulary, native boundaries | Focused PDF-review layout and accessible actions; security-reviewed local PDF worker/artifact permissions |
| `git.rs`, `github.rs` | Existing guarded manual version-control transport | Optional transport, outside typing/compilation; no second implementation in Secret Tunnel; validate three-file semantic consistency after Git merge |
| `latex.rs`, `markdown.rs`, Tylax/ZIP dependencies | Existing originals and historical conversion evidence | Freeze new work; remove conversion from the core writing path only in an approved, verified retirement slice |
| `lib.rs`, `main.rs`, CI, scripts | Native startup, isolation, tests, packaging | Register the minimum new commands; verify installed bundles, not only dev sources |

Naming a review/project responsibility does not authorize generic `providers/`, repositories-of-repositories, plugin registries, or duplicate controllers. Extract a small Rust `review.rs` or `project_manifest.rs` only when real ownership needs it. Keep a single mutation owner for the live document. Reviewer proposal writes never use an owner credential as a hidden forwarding shortcut.

## Connection decision

First prove review locally. Next use Secret Tunnel as a transport for an Undertree-specific reviewer endpoint/tool catalogue. Reuse connectivity without importing GitHub/whole-folder powers. No Secret Tunnel runtime changes in this planning branch. A standalone connection method is a later packaging option for the same API, not a fork of the review engine. Connecting a reviewer is not accepting its future edits.

## Upstream decision

Proposed first implementation: retain native Typst and add locally bundled PDF.js for actual PDF selection/rendering. Tinymist/typst.ts are the primary incremental-preview and navigation references, not automatic replacements. Their fastest SVG path does not satisfy the actual-PDF requirement. The early performance/mapping spike in `cli-roadmap.md` can overturn this choice with measured evidence; no benchmark winner is claimed yet.
