# PDF-first, three-file roadmap

**All implementation phases are blocked pending George's explicit approval.** This filename is retained to avoid breaking existing links; the old feature-by-feature CLI expansion roadmap is superseded. Do not build a CLI verb for every UI gesture by default.

## 0 — review and freeze (this pass)

Deliver a source-backed YAGNI audit, upstream comparison, target invariants, operation contract, and this sequence. No dependency, runtime, feature, project-data, or tunnel changes. Record unmeasured claims as unmeasured. The planning PR can be reviewed without checking out a different branch over the user's live work.

Approval covers these proposed defaults: actual PDF review; native Typst reuse plus PDF.js; one `.typ`/`.bib`/`.json` project; suggestions-only reviewer capability; asynchronous checkpoint collaboration first; frozen legacy conversion/admin expansion. Any requested changes update this plan before implementation.

## 1 — portable project skeleton and recovery

Implement the versioned three-file profile in the existing Rust project owner, with stable IDs, strict JSON validation, input hashes, an in-memory draft snapshot, and application-local coherent-save recovery. No new database or external service. Permit empty bibliography. Keep existing projects readable without automatic flattening/deletion. A deliberate migration creates a new portable project, reports unsupported assets/imports, preserves original files, and migrates Keep/Revise notes only after exact-anchor validation. Existing marks do not become weaker permissions by default.

Test clean creation, malformed/unknown JSON, external source changes, non-ASCII text, missing metadata, staged delivery of all three files, and simulated crash at every save boundary. Reopening three files on a clean supported installation must recover all canonical writing/review data without copying `.undertree/`.

**Exit:** a coherent three-file round trip and conservative conflict recovery; not a sync-provider integration.

## 2 — early actual-PDF performance and mapping spike

Before building a large review UI, prototype the real risk: compile the current draft with embedded Typst, generate an actual PDF and a source map from the same paged document, and display it in locally bundled PDF.js with selectable text. Reuse the existing scheduler, bounds, and last-good-preview behavior. Native artifact delivery must be narrow and tied to a build, not an arbitrary filesystem URL. Bundle all worker/CMap/standard-font assets needed by the chosen viewer build; no CDN/runtime downloads.

Compare current behavior and the proposed retained native compiler session. Inspect stable Source edits and cache invalidation for source, bibliography, resources, and render profile. Use Tinymist/typst.ts as references; only trial an additional component if the native path fails a stated requirement. Pin and license-review any code/dependency before adoption. Do not confuse Rust's Cargo incremental-build setting with Typst's document-level incrementality.

Use 2-, 20-, and 100-page research fixtures; include citations, two columns, repeated text, inline math, Unicode/ligatures, zoom, and paragraph movement. Record cold/warm compile, PDF encode, IPC transfer, first visible paint, input latency, and peak memory separately on the user's Windows hardware. Initial **targets, not claims**: p95 input-to-paint under 50 ms while compiling; p95 accepted-source-change to visible PDF under 500 ms for the 20-page warm fixture and under 1.5 s for the 100-page fixture. Report debounce as part of end-to-end latency and publish hardware/sample counts. Adjust targets only by an explicit product decision, not by dropping the PDF requirement.

**Exit:** source-correct ordinary-prose selection and measured latency/resource behavior. Ambiguous/generated selections explicitly stay unresolved/comment-only. No “real-time” claim until this gate passes. Do not replace PDF with SVG silently to pass a speed test.

## 3 — first complete human review workflow on the PDF

Implement Keep/Light edit/Rework marking on the PDF, passage instructions, one suggestion margin, word/source diffs, and accept/reject/request-revision/edit-proposal actions. A human-created suggestion exercises the same service contract that AI will use. Persist proposal versions, comments, and decisions in the JSON. Source view may mirror marks, but must not be required for routine PDF review.

Use sample proposals first. Prove the source is unchanged before acceptance, stale versions cannot overwrite typing, Keep cannot be bypassed, retry does not duplicate proposals, undo works, and reload preserves the review. Keep annotation metadata out of clean PDF output unless a human explicitly requests an annotated export. Reuse the displayed accepted build for clean export when inputs/options match.

**Exit:** PDF-select → propose → human decision → new PDF → restart, on the actual desktop bundle.

## 4 — reviewer API/MCP and retirement of direct agent writes

Add the minimal scoped review service API and thin MCP adapter. Keep owner and reviewer credentials/dispatch separate, including same-user local broker access. Deny direct replacement and raw `.typ`/`.bib`/JSON writes to reviewers. The old `app agent replace` cannot remain an exposed bypass; retire or explicitly move its legitimate owner-only use to a different capability, with documented migration.

First exercise local review operations; then add a dedicated Undertree reviewer connection through Secret Tunnel in a separate repository change. Do not expose Secret Tunnel's full repository/GitHub catalogue to writing sessions. Do not add a generic proxy/provider platform. Confirm authentication, revocation, request receipts, and reconnect behavior without allowing AI acceptance or policy changes.

**Exit:** an actual AI submits and revises suggestions, but hostile direct-write/approval/policy attempts fail natively. No automatic continuation promise for an idle external chat.

## 5 — external three-file checkpoint exchange

Start with one explicitly chosen transport, not three provider integrations. Reuse optional GitHub transport if selected, or a user-managed sync folder with its limitations clearly stated. Provider credentials remain local. A file store is a transport; Google Sheets is not the manuscript database. No service account, cloud setup, or publication is authorized by this roadmap.

Use source/bib hashes, JSON checkpoint parents, a retained local baseline, and provider conditional writes/versioning where available. Validate the full received tuple before adoption. Treat divergent source or metadata as conflicts; initial manual reconciliation is acceptable. An arbitrary sync folder cannot guarantee preservation of all concurrent offline edits without provider history: require turn-taking and expose conflicts rather than advertising live co-editing. A local filesystem lease does not fix this.

Test two actual app instances: offline changes, comment-only changes, delayed/mixed file arrivals, same-parent branches, a third device without baseline, and interrupted upload/download. Never silently discard a proposal, acceptance, or source version. Existing Git textual merge success is insufficient if JSON anchors/decisions are incoherent.

**Exit:** demonstrated asynchronous collaboration of the three files. Live cursors/CRDT/Yjs are a separately approved future requirement.

## 6 — measured retirement and release

Only after replacement flows pass, retire reverse conversion, ZIP/fidelity machinery, unused file categories, duplicate wrappers, dead controls, and dependencies shown to be unnecessary. Keep old originals, required author workflows, regression tests, credentials, and safety checks. Freeze broad GitHub administration and auto-sync expansion; do not remove needed manual transport as collateral cleanup. Update root documentation, generated capabilities, and installed-package verification to match shipped behavior.

Consider optional standalone connectivity and richer embedded figure resources only after evidence from real writing sessions. No fresh editor framework or distributed backend solely to satisfy this plan.

## Global stop rules

Stop the affected slice on source loss, stale acceptance, wrong PDF target, dependency/network leakage, unresolved three-file coherence, or missing approval. Preserve evidence and return a bounded failure; do not silently fall back to direct edits. Every completed slice reports exact tested scope and remaining limitations. Source-only review, SVG-only highlights, or merely copying three files is not completion of the requested product.
