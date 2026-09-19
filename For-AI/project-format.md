# Compact writing project: three shared files

Proposed v1 contract; not implemented or approved for migration yet. It applies to new compact projects. Existing folder projects and original imports must not be silently flattened, rewritten, or deleted.

## Responsibilities

| Shared file | Sole responsibility |
| --- | --- |
| `paper.typ` | Accepted Typst manuscript, layout settings, and citation calls. No injected review-control syntax or pending alternative manuscript. |
| `paper.bib` | One ordinary UTF-8 BibTeX/BibLaTeX bibliography, retaining stable entry keys. An empty bibliography remains a file for a consistent triple. |
| `paper.json` | Versioned project identity, paired-file digests, review scopes, instructions, proposals, comments, and decisions. Declarative data only. |

Names are illustrative: one agreed stem and exactly one of each extension. Renaming is an explicit coordinated project operation. PDF/export files and app-local state are not part of the shared contract. No fourth `.txt`, per-comment file, SQLite database, or cloud record is needed to reconstruct the review project.

A normal Typst source uses `#bibliography("paper.bib")` and `@key` or `#cite(<key>)`. Typst already reads `.bib`; do not convert the library to JSON/YAML or require TeX/Biber to preserve citation support. UnderTree's existing Rust `biblatex` dependency supplies parsing. See [Typst bibliography](https://typst.app/docs/reference/model/bibliography/) and [LaTeX-user guide](https://typst.app/docs/guides/for-latex-users/).

Compatibility import may translate supported LaTeX citation commands into Typst citation calls. Preserve keys, supplements, original bytes, and unsupported constructs for review; broad regex replacement is not a LaTeX parser. Consolidating multiple bibliographies requires collision checks and human confirmation. Unknown fields and malformed entries must not be silently dropped. Existing full-document converters remain explicit draft import/export, not another canonical format.

## Minimal JSON shape

Illustrative shape, not a shipped schema or a file to evaluate:

```json
{
  "schemaVersion": 1,
  "projectId": "stable-project-uuid",
  "files": { "source": "paper.typ", "bibliography": "paper.bib" },
  "snapshot": {
    "generation": "new-generation-uuid",
    "parentGeneration": null,
    "sourceSha256": "64-lowercase-hex-characters",
    "bibliographySha256": "64-lowercase-hex-characters"
  },
  "policy": { "version": 1, "defaultMode": "context-only", "ranges": {} },
  "suggestions": {},
  "comments": {},
  "decisions": {}
}
```

Use UUID-keyed records, deterministic serialization, bounded fields/collections, and an explicit supported schema version. Proposals hold the relevant original passage, candidate, target/policy revisions, and rationale, not another full manuscript. Thread revisions link immutable proposal versions. Decisions name the exact proposal version and source transition. Persist request idempotency where retry recovery requires it; avoid an unbounded operational log in the shared JSON.

Local editor counters are session concurrency guards, not global version identifiers. Generation IDs and exact byte hashes establish the portable pairing. Timestamps are informational, never overwrite priority. Hash raw UTF-8 file bytes consistently; do not silently normalize one side before comparison. New compact files use a documented newline policy. Unknown future schema versions are opened non-mutating until supported, not rewritten into today's shape.

Policies control editing scope, not access credentials. Project JSON contains no account tokens, tunnel URLs containing secrets, local paths, machine identities used as grants, automatic sync authorizations, shell commands, or permissions allowing an AI to approve itself. Attribution is not authenticated identity. Other editors or collaborators with raw file-write access can edit the files; this format does not claim cryptographic authorship or DRM.

## Persistence and synchronization

A coherent saved generation is the triple whose `.typ` and `.bib` byte digests match `.json`. For proposal-only changes the source/bibliography hashes stay unchanged while metadata generation advances. Accepted edits and their decision receipts become durable together from the application's perspective.

Native save sequence: obtain the existing owner/lease and verify expected hashes; record a small private recoverable transaction; stage the candidate bytes; replace the changed source/bibliography files atomically; publish JSON last as the generation marker; verify all three before acknowledging success; then finalize the private journal. A crash after any step must recover a coherent old or new generation, never report an unapplied suggestion as accepted. Individual filesystem renames are not a three-file transaction by themselves.

An external service may deliver the three files out of order. A receiver must settle changes, read a consistent candidate, and verify both digests before activating it. Until then retain the last good local generation and report incomplete delivery. Private recovery/cache data lives in app-local state and is never required on the other collaborator's machine. Migration must preserve the existing lease/recovery protections.

Version one supports exchange and conflict-aware synchronization, not Google-Docs-style simultaneous keystrokes. Keep a local common-base snapshot for three-way comparison. Divergent source, policy changes, conflicting decisions, or identical record IDs with different content stop for explicit reconciliation; do not auto-accept, merge by timestamp, or treat syntactically valid JSON as a resolved semantic conflict. Distinct review records can be merged later only under a tested native rule. A file count does not remove the need for a concurrency policy.

Start with an already synchronized local folder or the existing guarded Git adapter. A Google Drive/other file service is a transport option, not the source of truth; Google Sheets is not the manuscript database. No provider SDK, cloud backend, CRDT, account system, or storage plugin framework is needed for the first slice.

## Portability limits to resolve before claiming completeness

The first compact fixture covers prose, mathematics, tables, citations, and bundled fonts/styles. External figures, custom fonts, CSL files, package imports, and extra `.typ` files are additional dependencies: detecting them must fail the compact-portability check, not silently omit them or claim the project has only three required files.

Exactly-three-file figure support needs an approved embedding scheme, not an invisible assets folder. A bounded resource section in the same JSON is a possible later choice, with size/encoding costs and an allowlisted compiler projection that excludes review/private data. It is not implemented or selected here. Do not use mutable network image URLs as an offline solution. Preserve non-compact projects while the author decides the figure requirement.

Reproducible rendering also depends on compatible app/compiler/font versions. Record a non-secret rendering-profile identifier when necessary; do not auto-upgrade Typst or substitute fonts silently to open a collaborator's project.

Existing marks in `.undertree/agent-editing.json` need a reviewed migration into the shared JSON. Verify source anchors and preserve the old state privately before retiring it; it cannot remain a hidden fourth canonical file. Existing `.undertree/github-sync.json`, locks, and credentials remain machine-local integration state, not portable policy authority.
