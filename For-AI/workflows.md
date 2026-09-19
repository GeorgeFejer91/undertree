# Approval-gated roadmap and verification

Current round: documentation-only restructuring for author review. No application integration, native build, dependency removal, or project migration has been executed. Approval of this document set is not proof that any runtime feature works.

## Next slice to discuss with the author

Recommend a small paired prototype: a valid three-file project plus real-PDF selection resolved by Rust to a verified source target. This establishes the two highest-risk requirements before adding networking or a large suggestion UI. The figure-embedding boundary and PDF-renderer tradeoff must be explicit, not hidden behind a promise that the existing SVG viewer already qualifies.

## Implementation order after approval

| Slice | Work | Exit evidence |
| --- | --- | --- |
| 1. Baseline and compact format | Recheck `typst-main`/local branch, preserve uncommitted work, run the existing gates, define Serde v1 and exact file pairing, make a three-file fixture, add private-journal recovery. Keep existing projects unchanged. | Restart/reopen restores source, bibliography, and policy; a second installation opens the same three files offline; mixed/stale generations are rejected. |
| 2. Native real-time PDF review spike | Refactor shared snapshot/layout output; retain source provenance; display a real generated PDF; resolve ordinary-prose selections; measure latency and memory. | PDF selection maps correctly after zoom/reflow, including Unicode and repeated text; stale/ambiguous selections cannot mutate source; long builds leave typing responsive. |
| 3. Human review loop | Extend Keep/Light edit/Rework metadata; implement original Rust proposal/decision logic; show PDF-linked diff/comments; accept/reject/revise and undo via the owner transaction. | A human reviewer can propose without source writes; author accepts exactly once; new typing and protected text survive; restart restores history. |
| 4. Reviewer API and MCP | Add a capability-scoped adapter to the same Rust service; audit legacy bypasses; pair a dedicated reviewer connection through existing Secret Tunnel where appropriate. | Human/API/MCP behavior agrees; all direct source, policy, bibliography, and approval calls fail with reviewer credentials. No duplicated tunnel stack. |
| 5. Three-file collaborator exchange | Test out-of-order file delivery, external modifications, offline divergence, and coherent activation through an existing sync transport. | Neither collaborator loses source/comments/decisions; conflicts stay explicit; no fourth shared state file is needed. Do not call this simultaneous live collaboration. |
| 6. Consolidation | Retire replaced paths/dependencies only after the new slice passes. Update root implementation docs, trim stale controls, and assess figures/integrated AI/standalone connectivity from actual use. | Packaging, offline behavior, compatibility imports, and existing projects retain verified behavior. No unused second renderer or second policy engine remains. |

Slices 1 and 2 may share one small prototype. Source-level unit tests come first internally, but a source-only highlighter is not a completed user-facing milestone. Implement one slice, verify it, and review its evidence before broadening scope.

## Renderer choice: evidence before dependency

The preferred architecture is an original native Rust pipeline over the existing embedded Typst compiler, not a fork of another writer. Reuse one laid-out snapshot for PDF generation and provenance rather than compiling independent preview/export worlds.

The baseline exports actual PDFs but previews SVGs. Evaluate a maintained Rust-accessible renderer for the generated PDF and a minimal bundled PDF.js presentation fallback if needed. A Rust binding around a non-Rust engine is not pure Rust; label it honestly. Do not write a new PDF renderer to avoid a presentation dependency. Keep only the chosen production approach, and obtain approval if a non-Rust presentation component is the reliable option. A native image rendering of the actual PDF may use a matching inert selectable-text overlay from the verified build.

Compare page fidelity, source-selection alignment, font support, accessibility, platform packaging, warm-edit latency, PDF generation/rendering cost, memory, and license obligations. Use original fixtures and report environment plus median/tail measurements; do not invent a fixed real-time guarantee. Start with prose and bibliography, then test 10/50/100-page documents and long-running/error cases. Lazy page drawing and bounded caches follow measurements. Dropping a stale response must not be reported as canceling native computation.

## Required correctness matrix

- Protected range within a broader editable section; copied/moved protected words; unmarked source; late policy change: no unauthorized patch.
- Suggestion submission/retry/rejection: `.typ` and `.bib` bytes unchanged; idempotency survives restart.
- Concurrent typing, save, accept, undo, two accepts, and two overlapping proposals: exact accepted version, no later-edit loss, explicit stale outcomes.
- Crash between each transaction step; partial sync; same-ID JSON conflicts; divergent offline generations: recover or stop coherently, never newest-timestamp overwrite.
- PDF selection across columns/pages, ligatures, accented/astral Unicode, citations, formulas, macros, generated text, repeated phrases, and cached old pages: proven mapping or explicit unresolved annotation.
- Reviewer attempts source replacement, bibliography/policy writes, acceptance, raw broker use, conversion, Git, arbitrary paths, and document-injected instructions: authority cannot escalate.
- BibTeX/BibLaTeX braces/accents, duplicate keys, missing keys, supplements, and parser failures: preserve originals, report issues, compile valid citations offline.
- Imported/legacy folders, shared-file rename, unsupported schema, external figures/fonts/imports: no silent conversion, data loss, or false three-file portability claim.

## Development discipline and gates

Before changing code, inspect the exact owning path and relevant tests. Describe one input/output behavior and its failure cases. Reuse existing libraries and native services; write original implementation/tests. No generic command gateway, universal plugin system, replacement typesetting language, CRDT/cloud stack, or conversion fidelity campaign.

Keep security/correctness and actual viewer behavior tests. Native unit/CLI tests do not replace PDF selection, keyboard, zoom, accessibility, and packaged desktop checks. Do not validate by mutating a real manuscript or terminating a running dirty editor.

Current repository gates, from repository root:

```text
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
cargo build --locked --release --manifest-path src-tauri/Cargo.toml
node --check web/app.js
node --check web/citation-search.js
node --check web/agent-annotations.js
node --check web/typst-editing.js
node --test web/citation-search.test.cjs
node --test web/agent-annotations.test.cjs
node --test web/typst-editing.test.cjs
git diff --check
```

Node here is development/test tooling, not a runtime requirement. Use the repository's pinned Rust/toolchain/lockfile; do not opportunistically upgrade dependencies. For a documentation-only change, validate paths, relative links, contradictions, Markdown hygiene, and diff scope; a full native build is not required and must not be claimed.

A handoff states branch/base/final commit, exact changed paths, executed checks and results, unverified platforms, current limitations, and the one proposed next slice. Root README/architecture must eventually distinguish shipped behavior from planned behavior. Keep generated evidence in private/ignored test output, not `For-AI/`; do not create another planning directory or duplicate roadmap.
