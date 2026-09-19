# UnderTree: Rust-first research writing

Status: design for author review, 2026-09-19. This round changes documentation only. Do not start runtime integration until the author approves the next slice in `workflows.md`.

## Product contract

UnderTree is an offline desktop writing and reviewing application. Typst is the sole canonical manuscript language; Rust owns document state, compilation, review rules, and persistence. The primary review surface is the actual generated PDF. Humans and AI can propose changes through the same review service; only an authorized human action can accept them into the manuscript.

A new compact writing project has exactly three shared files: `paper.typ`, `paper.bib`, and `paper.json`. The PDF is generated, not a fourth required synchronization file. Application credentials, locks, recovery journals, and render caches are local state, not project content. Three files simplify portability; they do not magically solve concurrent edits or partially delivered syncs.

The working loop is: write locally -> compile -> select text in the PDF -> attach Keep/Light edit/Rework and an instruction -> receive a pending suggestion -> accept, reject, or request revision -> save a coherent three-file snapshot. Protected text may remain readable context; protection is not redaction.

## Read only what the task needs

Always read this file and `constraints.md`. Then load the relevant contract:

| Document | Question it answers |
| --- | --- |
| `module-map.md` | What exists, what should be reused, and what should be simplified? |
| `project-format.md` | What belongs in the three shared files, and how are they saved/synced? |
| `agent-editing-protocol.md` | How do PDF selections, permissions, and human/AI suggestions work? |
| `workflows.md` | What is the approval-gated implementation order and proof of completion? |

`cli-roadmap.md` is a small compatibility note, not another feature roadmap. `github-divergence-protocol.md` and `validation/` are conditional regression references for the existing Git/conversion/viewer features only. Their preservation checks remain relevant when those modules change; their historical feature priorities do not expand this roadmap. Do not load every validation ledger for an ordinary review change.

## Current versus intended behavior

Inspection baseline: `GeorgeFejer91/undertree_texstudio`, branch `typst-main`, commit `75513ffef8846538352c154952ee501a7a5755b3`. The older `main` branch is not the implementation baseline.

Already present: Rust/Tauri, embedded Typst, SVG preview plus a selectable-text companion, separate native PDF export, BibTeX parsing/citation assistance, revision/digest guards, Keep/Revise annotations, an authenticated live-editor broker, and optional GitHub/conversion workflows.

Not yet delivered by this plan: interactive PDF review, source-provenance selection, pending proposals with human acceptance, the compact JSON contract, or a reviewer-only MCP connection. Existing `app agent replace` applies a validated candidate directly; it is NOT the desired suggestion operation. Existing annotations live under private `.undertree/` state and are NOT already a portable review project.

These documents govern the new direction. Root `README.md`, `ARCHITECTURE.md`, and `VERIFICATION.md` describe the implementation baseline and must be updated when an approved runtime slice actually changes it. A written plan is not test evidence.

## Original implementation; selective reuse

Study external editors to understand observable behavior, tradeoffs, and failure cases. Write UnderTree's own functional specifications, data structures, algorithms, and tests. Do not copy source, closely translate another editor into Rust, or import its framework stack. Reading code and rewriting it in another language is not a claim of clean-room development or license independence.

Use maintained, appropriately licensed infrastructure such as Typst, Tauri, Serde, and the existing bibliography parser. Original application logic does not mean rebuilding a typesetter, PDF parser, cryptography, or a text editor from scratch. Record provenance and preserve dependency notices.

## YAGNI decision rule

Keep an addition only when it completes an approved user-visible slice, closes a demonstrated correctness gap, or passes a measured performance gate. Prefer an existing service, a small typed function, and a bounded collection over a framework, plugin registry, new language, cloud service, or second source of truth. Rust-first is a responsibility boundary, not a mandate to rewrite harmless presentation code.
