# UnderTree — PDF-first research writing

**Status: PLAN FOR HUMAN REVIEW. Runtime implementation is not authorized by this document.**

Planning baseline: `typst-main` at `75513ffef8846538352c154952ee501a7a5755b3` (10 September 2026). Audit/research date: 19 September 2026. The older `main` branch is not the implementation base. This pass changes Markdown guidance only; do not migrate projects, install dependencies, alter code, or remove features until George reviews the roadmap and explicitly authorizes implementation. Merging these documents alone is not that authorization.

## Product contract

UnderTree is a downloadable, offline-first research editor. Typst is its authoring/compilation format. Researchers select and highlight passages **in the actual generated PDF preview**, attach instructions, and review proposed edits. The source editor remains available but is not required for ordinary review.

One portable project consists of exactly three canonical sync files:

```text
main.typ             accepted manuscript and self-contained layout
references.bib       bibliography
undertree.json       project identity, review rules, anchors, proposals, discussions
```

PDFs and preview indexes are regenerated locally. Credentials, machine paths, locks, recovery journals, and UI preferences are not shared project content. The constraint concerns what collaborators must synchronize, not a prohibition on disposable application-local files. Figure/resource limits must be explicit; no undisclosed asset folder may be necessary to reopen a claimed three-file project.

Humans and AI can both propose changes and comment. An AI reviewer reads only authorized context and writes only review records. Only an authorized human author accepts a specific proposal version into the manuscript. API, CLI, Tauri, and MCP adapters share one Rust-owned review service; none owns a separate editing policy. Protected does not mean unreadable: reading permission and editing permission are separate.

## Read only what the task needs

| Document | Purpose |
| --- | --- |
| [constraints.md](constraints.md) | Data format, persistence, security, and rendering invariants |
| [module-map.md](module-map.md) | Existing owners and proposed boundaries; no rewrite from scratch |
| [cli-roadmap.md](cli-roadmap.md) | The staged product roadmap; filename retained to preserve existing links |
| [agent-editing-protocol.md](agent-editing-protocol.md) | Human/AI review contract and old-versus-new behavior |
| [workflows.md](workflows.md) | Approval gate, verification, and handoff |

Consult [yagni-audit.md](yagni-audit.md) for audit evidence and [typst-research.md](typst-research.md) for upstream alternatives. These two are references, not extra orchestration layers.

Existing `github-divergence-protocol.md` and `validation/` files remain historical/module-specific evidence, not the new product backlog. Preserve relevant safety checks while their code exists. Do not interpret old completed checklists as proof that PDF-first review or three-file collaboration works. Root README/ARCHITECTURE describe the existing application until the corresponding implementation milestone updates them.

## Deliberate exclusions

No LaTeX runtime or new conversion-fidelity program; no second editor database; no automatic whole-manuscript rewrite; no generic filesystem/HTTP/shell tool; no copied full editor/tunnel stack; no CRDT, multi-provider sync platform, or distributed approval system in the first release. First prove the smallest complete PDF-select → propose → human-decision → save → reopen workflow.

`For-AI/` stays Markdown-only and never becomes application input, a policy store, or an output directory.
