# Compact writing project: shipped v1 contract

New compact UnderTree projects use three shared files:

| File | Responsibility |
| --- | --- |
| `paper.typ` | Accepted Typst manuscript and layout. |
| `paper.bib` | One ordinary UTF-8 BibTeX/BibLaTeX bibliography. |
| `paper.json` | Review metadata only: hashes, marks, suggestions, comments, decisions/status, and policy/generation counters. |

PDF output, credentials, caches, locks, conflict copies, and `.undertree/review-transaction.json` are local/generated state, not synchronization files. Existing non-compact projects remain supported; UnderTree never flattens or deletes them automatically.

## Runtime JSON schema

The Rust type is authoritative. Version 1 serializes this top-level shape:

```json
{
  "schemaVersion": 1,
  "generation": 0,
  "policyVersion": 0,
  "document": "paper.typ",
  "bibliography": "paper.bib",
  "sourceDigest": "<sha256 of saved paper.typ bytes>",
  "bibliographyDigest": "<sha256 of saved paper.bib bytes>",
  "marks": [],
  "proposals": [],
  "comments": []
}
```

Unknown fields are rejected by Serde and unsupported schema versions fail closed. Collections and text sizes are bounded. JSON is declarative content, never executable policy or a credential.

A mark contains a stable short ID, one of `keep`, `light-edit`, or `rework`, an exact UTF-8 source-byte anchor plus bounded prefix/suffix context, optional human instruction, and stale state. A proposal records its ID, target mark, replace/delete operation, pending candidate text, rationale, human/AI attribution, status, base source digest, and creation/resolution times. A comment can target a mark and optionally a proposal. Proposal/comment IDs are idempotency keys: reusing the same ID with different content is an error.

## Bibliography compatibility

Typst remains the only canonical manuscript language; `paper.bib` stays ordinary BibTeX/BibLaTeX so existing citation libraries retain stable keys. UnderTree's Rust bibliography parser supplies citation search. A compact manuscript may reference `paper.bib` using normal Typst bibliography/citation syntax. No TeX/Biber runtime or bibliography conversion database is required.

Light-edit proposals mechanically preserve citation-token and numerical-token multiplicity. That is a structural guard, not proof of scientific equivalence.

## Persistence

Proposal/comment/mark changes update `paper.json` only and require the current saved manuscript digest. Manual source edits are still allowed; on the next review operation Rust attempts exact/context rebasing. Ambiguous or missing anchors become a refusal. A source or bibliography generation change conservatively supersedes pending proposals.

Acceptance is different: an authorized human names one pending proposal. Rust revalidates the proposal, target bytes, mark kind, saved source digest, policy generation, and bibliography generation. It writes a private bounded recovery journal containing expected old/new digests, atomically writes the accepted source and updated JSON, then removes the journal. On restart, recovery rolls forward only if observed files still match the expected old/new states; an unrelated external modification stops with an explicit conflict.

Individual file renames are not claimed to form a filesystem-wide atomic transaction. The journal is the recovery mechanism. It is private local state and never a fourth file required by a collaborator.

## Synchronization

The three files are the portable payload. Existing Git/GitHub synchronization can transport them as one commit. Another external file-sync service may also transport them, but UnderTree must not activate mixed generations silently: `sourceDigest` and `bibliographyDigest` must match the files before review mutations/acceptance proceed.

Version 1 is asynchronous conflict-aware exchange, not Google-Docs-style simultaneous keystrokes. Timestamps do not decide conflicts. Same IDs with different content, divergent source, or ambiguous policy state require explicit reconciliation.

## Portability limits

A truly three-file project cannot silently depend on extra figures, custom fonts, CSL files, package imports, or additional Typst sources. Existing projects with such assets remain valid UnderTree projects but are not self-contained three-file payloads. Embedding binary resources in `paper.json` is not implemented; add it only if a real compact-project use case justifies the size and compiler-projection complexity.
