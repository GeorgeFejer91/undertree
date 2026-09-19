# UnderTree: Rust-first research writing

Status: design for author review, 2026-09-19. This round changes documentation only. Do not start runtime integration until the author approves the next slice in `workflows.md`.

## Product contract

UnderTree is an offline desktop writing and reviewing application. Typst is the sole canonical manuscript language; Rust owns document state, compilation, review rules, and persistence. The primary review surface is the actual generated PDF. Humans and AI can propose changes through the same review service; only an authorized human action can accept them into the manuscript.

A new compact writing project has exactly three shared files: `paper.typ`, `paper.bib`, and `paper.json`. The PDF is generated, not a fourth required synchronization file. Application credentials, locks, recovery journals, and render caches are local state, not project content. Three files simplify portability; they do not magically solve concurrent edits or partially delivered syncs.

The working loop is: write locally -> compile -> select text in the PDF -> attach Keep/Light edit/Rework and an instruction -> receive a pending suggestion -> accept, reject, or request revision -> save a coherent three-file snapshot. Protected text may remain readable context; protection is not redaction.

## Read only what the task needs

Always read this file and `constraints.md`, and load Ponytail for development tasks as specified below. For every UI task, also read [ui-rules.md](ui-rules.md). Then load only the relevant contract:

| Document | Question it answers |
| --- | --- |
| `module-map.md` | What exists, what should be reused, and what should be simplified? |
| `project-format.md` | What belongs in the three shared files, and how are they saved/synced? |
| `agent-editing-protocol.md` | How do PDF selections, permissions, and human/AI suggestions work? |
| `workflows.md` | What is the approval-gated implementation order and proof of completion? |
| [ui-rules.md](ui-rules.md) | How do all UI text and SVG icons fit their CSS boxes and adapt automatically? |

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

## Required skill: Ponytail

Use the [Ponytail skill by DietrichGebert](https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail/SKILL.md) for every implementation, fix, refactor, architecture/dependency decision, and development review. Default to its full discipline unless the author requests another mode. Load it using the agent's available skill mechanism; if that is unavailable, read the upstream `SKILL.md` directly and apply it. Report an unavailable source honestly; do not claim installation or make skill setup a separate project.

Understand the end-to-end path first, then prefer existing project code, standard-library/native features, and already-present dependencies before adding the minimum necessary code. Fix shared root causes rather than every caller. Preserve input validation, data-loss protection, accessibility, and the author's explicit requirements. Mark a deliberate limitation with its ceiling and a concrete revisit trigger; do not create speculative frameworks or automatic skill-sync infrastructure.

## Standing UI rule

**Fit text to the CSS-allocated box with Cheng Lou's Pretext; fit and center SVG icons proportionally inside their slots. Do not resize controls around overflowing strings or hand-tune fonts/offsets every time layout changes.** All app text displays follow [ui-rules.md](ui-rules.md), including automatic refitting after content, container, font, and responsive-layout changes. That file defines readable bounds, full-content access, long-form reading behavior, and the PDF geometry exception.

`@chenglou/pretext` is the explicit presentation-layer choice, compatible with the Rust-first core. Ponytail is not permission to replace it with character counting, clipping, or a home-grown font engine. This documentation adds the requirement, not a dependency installation or a claim that the shared runtime fitter already exists.
