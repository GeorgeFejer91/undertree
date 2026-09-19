# Review operations: propose, never silently apply

Target protocol for the Rust-first redesign. It replaces the old direct-agent-replacement product direction, but this documentation change does not alter the executable. Do not expose the existing privileged broker to a reviewer and call it suggestion mode.

## Human and AI roles

An authorized author can edit accepted text, set review scopes, and accept/reject exact proposal versions. A human reviewer or AI reviewer can read authorized context, submit a proposal, and comment. Both use identical validation and proposal records; neither role gains source-write authority merely by proposing. AI identity is labeled, not presented as a human supervisor.

| PDF marking | Contract |
| --- | --- |
| Green / Keep | No reviewer proposal may change this protected range. It can remain readable context. |
| Amber / Light edit | Propose scoped prose edits under a human instruction; preserve protected tokens and neighboring content. |
| Red / Rework | Propose a replacement or explicit deletion. Red never deletes anything by itself. |
| Unmarked | Context-only unless an authorized review scope includes it. |

Use labels/icons as well as color. A protected subrange wins over a broader editable scope; initially reject crossing selections or partition them into verified editable targets. Do not accept a candidate because protected words appear elsewhere after a move. Preserve location, order, and unchanged protected spans. Instructions such as "tighten" are guidance; edit distance cannot certify scientific equivalence.

The author must be able to authorize a section with exceptions rather than mark every sentence. Read visibility is separate: an instruction not to edit is not an instruction to withhold context. Private material excluded from context must also be excluded from broader compiler/resource reads available to the reviewer.

## PDF selection and provenance

The visible selection starts in the actual generated PDF. Rust resolves it using the exact retained Typst layout/provenance for that build, not OCR, a page-number guess, or a global string replacement. The present SVG text layer is a reusable experiment, not completion of this requirement.

A build ID binds source hash, bibliography hash, resource/render profile, and document revision. A target stores that build ID, source identity, UTF-8 byte boundaries, exact source passage, and bounded surrounding quote context. Page geometry is a derived display location. DOM UTF-16 indices, UTF-8 bytes, glyph clusters, and PDF coordinates require explicit tested conversion; never mix them.

Click-to-source gives a candidate, not proof of a complete selected range. Verify the selected glyph/run provenance and source interval. Repeated text, ligatures, columns, hyphenation, math, citations, generated references, loops, and macros may be non-contiguous or many-to-one. Unresolved selections remain PDF comments or request a narrower PDF selection; never silently modify an approximate match. An imported PDF without source supports annotation only.

Selecting from a stale PDF requires verified remapping through known non-overlapping edits or a new build. Changed/ambiguous targets are stale and cannot be accepted. Any future remapping must retain protected scope and revalidate the exact old text; fuzzy similarity is not authority.

## Shared native API; thin MCP adapter

Implement ordinary typed Rust operations first. Tauri commands, the local review API, and later MCP delegate to those operations. Do not duplicate rules in each adapter. MCP is an optional tool interface; zrok/Secret Tunnel is optional connectivity.

Start with four conceptual reviewer operations (names are proposed, not currently callable):

- `review_context`: returns authorized targets, instructions, permitted operations, and coherent revision identifiers; obtain active unsaved state through the current editor owner.
- `submit_proposal`: validates one target or a bounded batch, stores pending alternatives, and returns durable IDs without applying source changes.
- `add_comment`: attaches a question, explanation, or revision response to a target/thread.
- `review_state`: reads current decisions, feedback, and the outcome of a prior submission.

A submission carries review/target IDs, base source and bibliography hashes, policy generation, operation, replacement text, rationale, parent proposal/feedback reference where relevant, and an idempotency key. Rust obtains original bytes and effective actor/permissions from trusted state, computes the diff, and enforces scope. Model-supplied offsets, original text, claims of approval, or role fields confer no authority.

Prefer plain-prose replacement targets. Escape inserted text or use a tightly validated structural patch; never turn AI output into arbitrary Typst code. Keep citation/math tokens outside editable slots initially, and reject selections whose structure cannot be preserved. Broader markup edits require a separate approved design, not an implicit capability of rework.

Submission writes `paper.json` only. Show the original, proposed diff, rationale, warnings, and Accept/Reject/Edit suggestion/Request revision controls. Editing a suggestion creates a new version for review. A request for revision retains prior versions and feedback. No proposed prose appears in the accepted manuscript/PDF before acceptance; an optional candidate proof must be separately labeled and isolated.

## Acceptance transaction

An authenticated human action names an immutable proposal version. Native code serializes it with editing/autosave, validates the live buffer and policy, verifies source/bibliography anchors, and applies only the approved patch. A policy change to Keep invalidates older editing permission. Reject stale input rather than reusing the old conflict-preserving overwrite path.

Persist the resulting source and decision with the recoverable transaction in `project-format.md`; update frontend state and compile from the resulting snapshot. Only acknowledge an accepted-and-saved result once verified; expose unknown outcomes for reconciliation. Undo records a new explicit state transition and must preserve later manual edits. A repeated acceptance cannot apply twice. Overlapping proposals become stale or are revalidated, not silently applied together.

Preserve important scientific tokens mechanically where possible; flag changes to numbers, citation keys, negation, terminology, or qualifications. These checks are warnings/structural guarantees, not proof of unchanged meaning or correct evidence. A real bibliography key does not prove support for a new claim.

## Close every alternative write path

Reviewer authority excludes source save/replace, `app agent replace`, `app document replace`, bibliography editing, project navigation/discard, conversion/export paths with write effects, Git operations, policy edits, arbitrary filesystem/HTTP access, and the human acceptance operation. Inspect actual native dispatch and authorization before connecting MCP. Existing privileged local CLI operations may remain for the author/developer, but never with reviewer credentials.

A reviewer can write review records, so proposal tools are not read-only in protocol annotations. Persist idempotency and return structured refusals for stale source/policy, protected overlap, unresolved anchor, denied authority, and unknown outcomes. After timeout query the receipt; never blindly repeat a mutation.

Shared files are not credentials. A network adapter must authenticate a reviewer, limit project/operation scope, and remain separate from the existing same-OS-user broker capability. Neither another MCP connector with raw source writes nor a privileged local process is constrained by this review API. Do not claim otherwise.

Feedback in UnderTree does not restart an idle external chat automatically. External agents read it on their next turn. Any later in-app model runner uses this same proposal contract; no unrestricted writer or extra approval path is introduced.
