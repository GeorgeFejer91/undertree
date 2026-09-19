# UnderTree: Rust-first research writing

Status: implementation candidate on `feature/rust-pdf-review`, based on `typst-main`. The PDF review and three-file runtime now exist on the feature branch; validation evidence still decides whether the branch is merge-ready. Do not describe a workflow failure with no executed CI steps as a passing or failing compiler test.

## Product contract

UnderTree is an offline desktop writing and reviewing application. Typst is the sole canonical manuscript language; Rust owns document state, compilation, review rules, source-provenance validation, acceptance, and persistence. The primary review surface is the actual generated PDF.

New compact projects contain exactly three shared writing files: `paper.typ`, `paper.bib`, and `paper.json`. The PDF is generated. Credentials, locks, caches, conflict evidence, and the review recovery journal are local/private state. Existing folder projects and legacy conversion workflows remain compatible and are not silently flattened.

The working loop is: write locally -> compile one Typst layout -> generate/render the PDF -> select mapped prose in the PDF -> mark Keep/Light edit/Rework -> receive a pending human/AI suggestion -> accept, reject, or request revision -> persist a coherent source/review transition. Protected text may remain readable context; protection is not redaction.

## Read only what the task needs

Always read this file and `constraints.md`. Load the [Ponytail skill](https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail/SKILL.md) for development tasks. For UI work also read [ui-rules.md](ui-rules.md).

| Document | Purpose |
| --- | --- |
| `module-map.md` | Runtime ownership and current keep/narrow boundaries. |
| `project-format.md` | The shipped v1 `paper.json`/three-file contract. |
| `agent-editing-protocol.md` | PDF mapping, proposal/comment authority, and human acceptance. |
| `workflows.md` | Required validation and remaining merge gates. |
| `ui-rules.md` | Shared Pretext fitting and SVG geometry rules. |

`github-divergence-protocol.md` and `validation/` remain regression references for existing Git/conversion behavior. Do not load them for an unrelated review change.

## Current feature-branch behavior

Implemented in Rust/Tauri:
- one Typst layout drives generated PDF bytes and the live PDF preview;
- the pure-Rust Hayro renderer rasterizes the generated PDF for the WebView;
- directly mapped text runs carry exact active-source byte provenance; unresolved/generated runs never become editable review targets;
- `review.rs` owns `paper.json`, Keep/Light edit/Rework, idempotent suggestions/comments, source/bibliography generations, and crash-recoverable human acceptance;
- new GitHub projects create `paper.typ`, `paper.bib`, and `paper.json`;
- the human UI selects/marks text in the PDF and accepts/rejects suggestions;
- the authenticated running-editor protocol and CLI expose review context/propose/comment but no reviewer acceptance;
- the old direct-agent replacement request is refused by the WebView and is no longer an advertised reviewer workflow;
- the local web build vendors pinned Pretext and uses one shared fitter for constrained app controls; long manuscript/diff text remains readable and Typst still owns PDF typography.

Not claimed until tested: cross-platform packaged PDF selection fidelity, performance targets on long papers, simultaneous live collaboration, or automatic Secret Tunnel/MCP wiring. The review CLI is the narrow adapter surface that a later Secret Tunnel MCP toolset can call without acquiring manuscript-accept authority.

## Original implementation; selective reuse

Study external editors for observable behavior and failure cases, then write UnderTree's own models, algorithms, and tests. Do not copy or closely translate another editor's source merely by changing language. Reuse maintained infrastructure where it solves an actual primitive: Typst, Tauri, Serde, Hayro, Pretext, SHA-256, the existing bibliography parser, and existing Git/conversion services.

## YAGNI / Ponytail rule

Understand the real path first. Then reuse existing project code, standard/native facilities, and already-pinned dependencies before adding the smallest code that completes the user-visible slice. No second compiler, second policy engine, generic plugin framework, cloud manuscript database, duplicate tunnel, or CRDT stack without a demonstrated requirement.

Minimal does not mean removing validation, data-loss protection, accessibility, review authority boundaries, or explicit author requirements.

## Standing UI rule

CSS allocates the box. Cheng Lou Pretext measures constrained application text and selects the largest readable fitting size within shared bounds. SVG icons scale/center geometrically in their slots. Moving/resizing a component must not require per-control font/offset patches. See [ui-rules.md](ui-rules.md). PDF/manuscript typography and source-selection geometry remain Typst/build-owned and must never be independently fitted by Pretext.
