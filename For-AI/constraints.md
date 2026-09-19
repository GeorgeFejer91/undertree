# Non-negotiable boundaries

These are target constraints for the approved redesign. Preserve working baseline safeguards until their replacement is implemented and verified. This documentation round authorizes no code removal, dependency change, application restart, or manuscript modification.

## Native core, thin presentation

- Rust owns authoritative project/review state, target resolution, authorization, validation, diff application, compilation scheduling, persistence, and sync reconciliation. Use ordinary modules in the existing crate; extract a crate only for a demonstrated second consumer.
- Typst remains the document language and typesetter. The "meta-compiler" is a small Rust layer that validates JSON and derives review targets and proposed changes. It is not another compiler, scripting language, template engine, or duplicate manuscript representation.
- Keep the Tauri shell and minimal local HTML/CSS/JavaScript for drawing, text input, selection gestures, accessibility, and typed IPC. Move correctness decisions native-side incrementally; do not replace the frontend framework or add WASM for language purity.
- Ordinary editing, bibliography use, reviewing stored suggestions, and rendering work offline. No runtime Node/Electron/TeX/Typst CLI, cloud account, package download, or tunnel is required.
- Reuse the pinned embedded Typst and Rust libraries. Do not add a competing compiler, a full Tinymist daemon, browser compiler, database server, or universal agent runtime without a measured need and explicit approval.

## Document and review integrity

- `paper.typ` is accepted source; `paper.bib` is bibliography; `paper.json` is portable review metadata. JSON contains no executable rules and is never evaluated as code. A pending proposal changes metadata only, not accepted source or its normal PDF.
- Read visibility, permission to propose, and authority to accept are separate. Green Keep is read-only context when shared, not hidden text. Unmarked text is context-only by default; a human can authorize a broader review scope.
- Human reviewers and AI use the same proposal model. Reviewer credentials cannot apply source edits, accept proposals, change policy, edit bibliography/macros, or read privileged credentials. Local author editing remains possible and invalidates affected proposals.
- Permissions are enforced at every native entry point, not by tool descriptions, frontend colors, client-supplied actor names, or caller-supplied `approved: true` flags. Disable legacy source replacement for reviewer principals before connecting any AI reviewer.
- Revalidate exact target, source/bibliography/policy generations, proposal version, and human authority at acceptance. Stale or ambiguous data stops; keeping a backup does not authorize an overwrite.
- Bind every preview, selection map, proposal, and save response to a coherent immutable snapshot. A stale completion cannot mark newer work current. External same-user tools and independently authorized connectors are outside this boundary; never claim OS-wide protection.
- Imported JSON is content, not a credential or grant of authority. Synced identities are attribution, not verified signatures. A remote policy relaxation requires locally authorized reconciliation, never silent permission escalation.

## Rendering and responsiveness

- The required highlighter operates in the actual PDF preview, not only source text or an SVG preview relabeled PDF. Keep current SVG behavior during migration until a verified replacement exists. Choose one production review renderer after the rendering spike.
- Use one bounded latest-state-wins compile worker and at most one newest pending snapshot. Never perform heavy Typst/PDF/diff work on the UI event path. Retain the last good render on failure.
- Preserve explicit source, resource, page, output, cache, request, and history bounds. Measure latency and memory before promising real-time performance. Discarding stale output is not preemptive cancellation of a running compiler.
- Render untrusted content inertly. Keep the existing prohibition on injecting SVG as HTML. Any PDF renderer receives only a scoped immutable artifact, no filesystem or command authority; disable document scripts and automatic remote resource loads.
- Preserve readable text, keyboard navigation, selection, zoom, and accessibility. Use shared fitting for constrained controls; do not shrink manuscript or suggestion prose into unreadable fixed boxes. PDF review intentionally supersedes the old pixel-identical LaTeX layout rule, not basic UI quality.

## Files, processes, and optional integrations

- Approve and canonicalize the project root natively; reject traversal, symlinks/escapes, unsafe imports, and oversized input. Preserve atomic single-file writes, SHA-256 comparisons, existing project leases, dirty-buffer checks, and recovery evidence.
- A local three-file save requires a recoverable transaction; three renames are not jointly atomic. A sync reader verifies the manifest hashes and never activates a mixed generation. Conflict resolution never defaults to newest timestamp wins.
- Private journals/caches/credentials must not become a fourth shared project file. Do not remove current recovery mechanisms just to make the working directory appear empty; migrate private state deliberately.
- No general shell, filesystem, arbitrary URL forwarding, remote markup, or unrestricted editor API for reviewers. Existing user-local broker authority must not be published through a tunnel.
- Preserve Git no-force-push/divergence protections and explicit sync approvals. Do not expand GitHub, conversion, or networking features while the review loop is unfinished.
- `For-AI/` remains Markdown-only, outside runtime imports and packaging. No test outputs, generated schemas, secrets, fixtures, or executables belong here. Code and tests live in their owning runtime/test locations.
