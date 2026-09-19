# Review operations: propose, never silently apply

This is the implemented PDF-review contract on `feature/rust-pdf-review`.

## Roles and markings

| PDF mark | Reviewer authority |
| --- | --- |
| Green / Keep | Readable context, no replacement proposal. |
| Amber / Light edit | Replacement proposal only; citation-key and numerical-token multiplicity must remain unchanged. |
| Red / Rework | Replacement or explicit deletion proposal. |
| Unmarked | Context only; not an implicit edit target. |

Review colors are UI communication; Rust enforces the mark kind and exact source target. Read visibility, proposal authority, and human acceptance are distinct.

## PDF selection and provenance

The live preview is generated from the actual PDF. Rust compiles the current Typst snapshot to one `PagedDocument`, creates PDF bytes, rasterizes those PDF pages with Hayro, and emits a transparent text companion from the same Typst layout.

A text run receives `sourcePath`, `sourceStartByte`, and `sourceEndByte` only when its glyph spans all belong to the active source and the exact source substring equals the rendered run. The frontend converts the DOM selection from UTF-16 to UTF-8 bytes and refuses a range containing unmapped, overlapping, multi-source, or stale runs. Rust then verifies the visible text against the exact source bytes before storing the mark.

Generated references, macro output, formula/layout content, or any ambiguous mapping can still be read in the PDF; they are not silently promoted to writable prose.

## Shared Rust service

`review.rs` owns:
- state/materialization of `paper.json`;
- mark creation/removal and conservative rebasing;
- proposal/comment creation and idempotent IDs;
- Keep/Light edit/Rework enforcement;
- source/bibliography generation tracking;
- human accept/reject decisions;
- crash recovery for source + metadata acceptance.

Tauri commands and the remote reviewer protocol delegate to this service. The browser does not decide whether an edit is permitted.

## Human UI

A user selects mapped PDF prose and creates a mark/instruction. Human suggestions are stored as pending records. Reject may include revision feedback. Accept is a dedicated human Tauri command and is the only review operation that can write accepted manuscript text.

The UI refreshes review state before each mutation so source, bibliography, and policy generations are current. Accepted source is reloaded into the editor and recompiled.

## AI reviewer surface

The authenticated running-editor protocol supports:
- `ReviewContext`: returns the saved source plus portable review state;
- `ReviewPropose`: submits one idempotent pending proposal;
- `ReviewComment`: submits one idempotent comment.

The CLI exposes those as `app review context|propose|comment`. Proposal/comment callers provide stable IDs so retry after an uncertain transport result cannot create duplicates. There is deliberately no `app review accept`.

The frontend refuses legacy `agent-replace` direct mutation. Existing owner/developer document commands are separate privileged capabilities and must never be exported as reviewer MCP tools.

A future Secret Tunnel MCP adapter should map only the review context/propose/comment operations. It should not reimplement policy, expose raw document replacement, or add a second tunnel stack inside UnderTree.

## Staleness and scientific guards

A manual source edit may rebase a mark only by exact unique text/context; ambiguity refuses. Source or bibliography generation changes supersede pending proposals. Accept rechecks exact target bytes and the proposal base digest. A repeated/resolved proposal cannot apply twice.

Light edit preserves citation and numerical tokens mechanically. This does not prove unchanged meaning, correct evidence, preserved negation, or scientific validity; the human still evaluates the visible diff before acceptance.
