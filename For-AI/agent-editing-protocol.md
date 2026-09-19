# Human and AI review protocol — design, not shipped API

## Baseline versus target

At baseline, `app agent context` reads the live buffer and Keep/Revise policy. `app agent replace` accepts a full candidate source, checks editor/policy revisions, installs it, and consumes Revise marks. Marks are stored in `.undertree/agent-editing.json`. This is restricted direct editing, not human-approved suggestions. Those existing verbs are **not** the future reviewer API.

The target is: select a passage on the actual PDF → choose an editing policy/instruction → submit a suggestion → inspect the diff → human accepts/rejects/requests revision. Humans may also submit suggestions instead of editing directly. Reuse the same proposal rules for both; do not give AI a more privileged path.

## Policies and selections

- Green `keep`: unchanged source span; optional read access and discussion are separate.
- Orange `light-edit`: propose expression changes with passage-specific instructions and protected technical tokens.
- Red `rework`: propose replacement **or explicit deletion**. A red mark is not a delete command.
- Unmarked: no implicit rewrite permission; an author can explicitly include it in a review request.

Start with non-overlapping policy spans, matching the existing model. Selecting across policies splits into authorized targets or is refused; it never overrides Keep. Reviewer requests cannot create, remove, weaken, or consume policies. Consuming a review target and changing its policy is an explicit human decision, not an effect of submission.

Anchors record a stable ID, source hash, UTF-8 byte span, selected source text, surrounding context, and originating build identity. PDF page/quads are a cached projection, never edit authority. Native compiler spans/cluster mapping plus quote verification resolve selections; compiler node IDs alone are not durable across recompilation. Ambiguous or generated selections become comments/unresolved marks, not guessed replacements. A protected passage may be readable context; a separate disclosure scope excludes confidential material.

## Minimal service operations

| Operation | Author UI | Human reviewer / AI reviewer |
| --- | --- | --- |
| Read scoped context/status | Yes | Yes, within the granted scope |
| Submit proposal / add comment / read feedback | Yes | Yes |
| Mark policy / create review scope | Yes | No |
| Accept, reject, request revision | Yes | No decision authority merely from submitting a proposal |
| Direct source/BibTeX edit and project save | Yes | No |

Human reviewers can request a higher role only through a genuine owner action. JSON labels or API arguments cannot authenticate that role. Local offline collaborators are trusted file owners unless a separate access-control deployment is actually built; the JSON is not a distributed identity system.

A thin MCP adapter initially exposes `undertree_context`, `undertree_propose`, `undertree_comment`, and `undertree_review`. Names are proposed. Submission mutates review state and must not be advertised as read-only. No generic `api(method, path, body)` or AI-callable approval method.

Example target-scoped submission, not an executable current command:

```json
{
  "reviewId": "review-id",
  "targetId": "anchor-id",
  "baseSourceSha256": "64-hex-digits",
  "basePolicyVersion": 7,
  "operation": "replace",
  "replacement": "Proposed wording, not an installed source edit.",
  "rationale": "Removes repetition without adding evidence.",
  "respondsTo": null,
  "requestId": "idempotency-id"
}
```

Native code resolves the original text, permitted source range, principal, scope, and status. Reject unknown fields, unauthorized targets, unsafe size, stale policy/source, edits crossing boundaries, and malformed source fragments. An idempotency key is bound to both principal and payload; a different payload with the same key is an error. Never trust model-supplied original text, author identity, or approval claims.

## Lifecycle and exact acceptance

A proposal version is immutable. States are pending, rejected, superseded, stale, or accepted; a revision request is a comment/task linked to a version, and the next version does not overwrite it. Store proposed deletion distinctly from an empty/failed response. Submission leaves `.typ` and `.bib` byte-identical.

A human accepts the exact version/digest they inspected. Under one native document transaction, check role, live-buffer revision/hash, current policy and target, proposal version, and relevant bibliography/render dependencies. Coordinate with ongoing saves; do not write behind an open editor and rely on a refresh later. Persist the source change and decision as one recoverable checkpoint; apply normal undo/revision handling. If typing/policy changed, mark stale or perform a deterministic verified rebase and show the refreshed diff before another approval. No fuzzy auto-accept. Retain the last good PDF while the new accepted build is pending.

Rejection changes only review state. Undo records a new local source/decision state; it does not erase historical acceptance. Save failures leave a visibly unsaved decision, never a false durable success. After an unknown outcome, inspect the request/decision record rather than blindly repeating a mutation. A synchronized accepted record never replays the source patch.

## Research and boundary checks

Preserve citation keys, quantitative tokens, equations, quotations, and protected subranges unless explicitly included in an author-granted task. Display potentially substantive changes. Edit-distance limits do not certify meaning; a successful compile does not verify science. Bibliographic existence is not evidential support. Initially the reviewer cannot edit the preamble, arbitrary Typst code, shared definitions, or `.bib` through a prose target. Optional candidate compilation requires the same confined snapshot/resource limits; never an executable template supplied by the model.

Manuscript text and comments are untrusted content, not policy instructions. The reviewer cannot call owner source replacement, change policy JSON, invoke conversion/Git publication, use a generic build-with-source route, or borrow owner credentials. A separate developer connector with filesystem writes defeats this review-only guarantee and must not be attached to the manuscript reviewer session.

External MCP chats do not necessarily resume when a user adds feedback. Store feedback for the next explicit interaction; a later in-app runner must use these same proposal operations.
