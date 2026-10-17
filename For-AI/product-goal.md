# Product goals: UnderTree, wrAIter for Writer and wrAIter for Word

Word/Writer identity and its native-window, GitHub and download/installer use
follow the user-approved [shared branding contract](PROTOCOLS/branding.md).

## Active implementation goal: AI highlighting and protected rearrangement

User direction, 2026-10-17: implement the new
[AI highlighting and immutable protected-passage contract](PROTOCOLS/connections.md#ai-highlighting-and-immutable-protected-passages)
across all three subprojects: UnderTree, LibreOffice Writer and Microsoft Word.
ChatGPT must be able to read the complete shared manuscript, identify text such
as citations, and batch-mark occurrences in a fresh, functionless color. Only
the local user may assign that color a prompt, protection or editing permission.
Neutral AI marks grant no suggestion/direct authority, even over unmarked text.

Double-clicking a toolbar color or an in-text highlight must open the same local
rule settings, with explicit overlap choice and equivalent keyboard access.
Protection has highest priority: an authorized enclosing rewrite may reorder
separately protected snippets while preserving each exact contiguous unit and
its protection. One continuous marked citation group remains one indivisible
unit, including its internal order. Native authority must prove preservation
at proposal, application and acceptance; prompts alone cannot enforce it.

Completion requires shared protocol/policy cases plus independent UI, native,
persistence and installed-package checks in all three hosts. Keep the goal
active until those gates pass; existing tests and this requirements update do
not establish implementation. The connection contract owns detailed semantics,
denial cases and the narrow extension beyond the previous three Review tools.

## Native Microsoft Word deliverable

Later Word-specific interaction direction, 2026-10-17: the ribbon colors are
the entry points. A click marks selected prose; a double-click on a ribbon
color or marked text opens that color's single-page native rule dialog, with
keyboard access and explicit choice for overlaps. Remove the central editor,
highlight/proposal lists, All color rules and Next colors product surfaces.
Offer name/color, Preserve text, suggestion/direct mode, wording presets,
exclusive Shorten/More detail and a custom prompt. Preserve text overrides and
disables conflicting instructions and modes. Suggestion mode uses Word's own
Track Changes and native review controls, with paragraph replacements where
the complete paragraph is authorized; partial highlighting never broadens
authority. Include native comments and revision context in subsequent complete
reads and require renewed context after feedback changes. This supersedes
Word's earlier separate pending-proposal UI requirement below; other hosts
retain their current implementation and separate parity qualification.

Clarification from the same user: paragraph-focused writing constrains GPT's
replacement format, not the user's marking. Allow local partial, whole and
multi-paragraph highlights, including paragraph separators, without silently
shrinking the selection. Preserve the actual permission coverage and native
structure; GPT still submits separate authorized paragraph edits. A continuous
protected highlight cannot be split, including across paragraph boundaries.

User direction, 2026-10-17: additionally deliver **wrAIter for Word**, a native
Windows desktop Word selective editor installed as one package. Word loads the
add-in and owns document access; its MCP endpoint and connection dialogs run
inside the add-in, with an internal bundled zrok child. No separately managed
companion application, UnderTree runtime, Writer runtime or hosted HTML UI is
required. `modules/word/` owns source, native controls, packaging and focused
qualification. Preserve all three targets and their shared parity contract.

Apply the shared selective-editor UI/options and complete-context/highlighted-only
permission meanings to Word. Its native adapter must guard rich-text structures,
typing, revisions, local approval, stale context, revocation and replay, never
save implicitly, and never interpret ordinary Word shading as authority.
Initial connection enrollment is local; sharing is session-only. Release an
installer only after its actual installed Word behavior is verified, then install
that exact release artifact on George's PC and demonstrate it. Compilation,
framework-level UI rendering and synthetic tunnel tests are separate evidence.
Installed desktop usage does not make ChatGPT or a public tunnel work offline.

UnderTree's fixed stack, reaffirmed 2026-10-15: **Rust authority, Tauri v2 native shell, HTML/CSS interface and Typst publishing**. Electron is outside the product and release scope; its obsolete sources and packaging have been removed. The LibreOffice target runs inside the existing Writer host with native UNO document authority; it does not require migrating LibreOffice to Tauri. Later publishing additions retain their separate requirements below and in [constraints.md](constraints.md).

<a id="two-deliverables-one-selective-ai-editing-contract"></a>

## Three deliverables, one selective AI editing contract

User direction, clarified 2026-10-17: this repository has three equal delivery
goals: UnderTree, **wrAIter** for LibreOffice Writer and **wrAIter for Word**.
Deliver three independently installable packages. Each implements the same
selective AI editing contract and retains its own native authority.

| Deliverable | Packaging and owner |
| --- | --- |
| UnderTree desktop | Native desktop installer; Rust/Tauri authority and the existing UnderTree editor. |
| wrAIter | Separately installable Writer add-on, preferably an `.oxt` extension for an existing LibreOffice installation; `modules/libreoffice/` owns it. Use a native installer wrapper if needed for a practical installation flow. A suite fork or rebuilt LibreOffice distribution is not the default. Retain legacy internal extension IDs for compatibility. |
| wrAIter for Word | One native Windows Word add-in installer; `modules/word/` owns COM document authority, native controls and its independent bridge. |

All three targets must offer the **same selective-editing UI and functionality**:
user-defined highlighter colors/slots, passage marking, color settings popup,
custom prompts, Shorten/More detail presets, protection/rejection/discard,
per-color Suggestions/Direct edits toggles, visible pending proposals with local
Accept/Reject, functionless AI marking, in-text color-rule access, protected-unit
rearrangement, and connection/sharing/revocation controls. Match the control
names, choices, grouping, interaction sequence and permission meanings; do not
independently simplify or redesign one target. Host window chrome, document
rendering and native widgets may differ, but any selective-editor UI discrepancy
must be recorded and resolved before claiming parity. This requirement concerns
the shared selective-editor controls, not replacing Writer's whole workspace
with UnderTree's Typst workspace, or replacing Word's native workspace.

The [connection contract](PROTOCOLS/connections.md) applies to all three: complete
active-document reading context before proposals; suggestions and direct edits
only within current highlighted ranges; local-only permission changes and
approval; protection, revision/quote, draft and revocation checks. Full-document
context does not authorize edits to unmarked text. Reuse shared policy/protocol
contracts and equivalent test scenarios while each native host enforces its own
document mutations. Each program must own its MCP/zrok bridge and work without
the other running or supplying runtime files. wrAIter retains its private
connection setup and explicit reconnect intent across Writer starts, but never
restores document sharing. Optional local MCP URL pairing in either direction
routes the other editor's permitted tools without merging its authority; see
the [connection contract](PROTOCOLS/connections.md).

Completion requires feature/UI parity tests and installed-package checks for
all three deliverables, including native save/reopen persistence and actual local
approval/direct/denied/revoked behavior. One working installer, a passing mock,
or this requirements update cannot complete all three goals. Implementation and
installed/public qualification status remain separate for each target.

User direction, 2026-10-15: make and prove UnderTree as an Overleaf-capable Typst editor with additional UnderTree abilities. The active delivery goal covers the publishing outcomes and expected UI actions below, alongside the existing native, review, ChatGPT and GitHub requirements. The pinned Overleaf source defines the reference actions; enabled edition/configuration and actual runtime observations define parity evidence. Do not infer unlimited compatibility from a finite fixture suite or mark the goal complete while required actions remain unimplemented or unqualified.

User direction, updated 2026-10-14: reduce reliance on LaTeX over time. Build UnderTree with a Rust authority and Tauri desktop shell, an HTML/CSS interface, and Typst as the long-term manuscript and publishing engine. HTML remains an editable and portable document format. Existing TeX workflows are compatibility adapters; new review and collaboration features must not require a TeX installation.

The broader delivery goal combines all requested parts: a local editor with mandatory near-identical Overleaf appearance and interaction behavior, a Typst publication path, ChatGPT access over zrok MCP, color-bound passage policies and prompts, optional GitHub storage/synchronization, and native TeX-to-Typst import. User direction on 2026-10-17 adds per-color suggestion/direct access and independently installable LibreOffice Writer and Microsoft Word integrations. Review defaults to suggestions and adds only the required neutral `highlight_text` action; direct wording edits require complete current local marker authorization under [the connection contract](PROTOCOLS/connections.md). The focused implementation goal above preserves the broader delivery requirements. General content/tree/policy mutation, remote buffer saves and indirect autosave remain excluded. Separate [App controls](PLANNER/CHATGPT-FULL-CONTROL.md) remain non-content. Parallel workers own independent scopes and coordinate shared manifests and integration checks.

UI direction, clarified 2026-10-14: an experienced Overleaf user should feel as though they are using the same editor software. Follow [overleaf-ui-parity.md](overleaf-ui-parity.md); a merely inspired design does not meet this requirement. Use Uncodixfy Pretext's outside-in accordion stretch and overflow prevention as the standard in [ui-layout.md](ui-layout.md), following the relevant Secret Tunnel layout patterns. Give the native window its own original UnderTree boundary and custom Close/Minimize icons. This original frame is an explicit user-requested distinction; it does not relax workspace parity.

The user further requires Overleaf's colors and layout as the previous UnderTree editor used, with a direct comparison against the public Overleaf GitHub source. Restore the existing charcoal/toolbar/green visual tokens and file/editor/preview arrangement in the active manuscript workspace; the legacy shell is the implementation starting point, with upstream source and rendered checks controlling qualification.

The user explicitly requested making `GeorgeFejer91/undertree` public and linked [REA](https://github.com/morluto/rea) for reverse-engineering support. Implement a native TeX-to-Typst import path as a migration aid. Preserve the original `.tex` file; convert the supported subset and emit an explicit report for unsupported macros, environments, math and layout. Formatting equivalence for arbitrary TeX is an ambitious research goal, not a guaranteed property of a first importer.

## Observable target

User direction, 2026-10-16: make MCP interoperability a reusable application
module. UnderTree must create its own zrok endpoint, support explicit private
Secret Tunnel/UnderTree identity transfer for URL handover, and support linked
apps on multiple machines. A shared ChatGPT gateway URL must route only to
locally registered app endpoints and their explicitly permitted tool catalogues.
Copying a URL can link to its running app; taking over that same zrok reservation
requires its private identity and a deliberate owner handover. Two concurrent
owners must never claim one reservation. Review defaults to suggestions with
the locally authorized direct-marker exception described above, and
target apps retain their own grants, restrictions and revocation. This is an
expanded implementation/qualification requirement, not evidence of completion.
See [the connection contract](PROTOCOLS/connections.md).

- Reproduce the pinned open-source Overleaf workspace's outward appearance and supported interaction behavior: project/file navigation, source editing, previews, reviews, suggestion cards, and synchronization controls. Follow the comparative acceptance criteria in [overleaf-ui-parity.md](overleaf-ui-parity.md); preserve upstream licensing and attribution if code is copied. Do not claim authenticated browser reverse engineering when only public source was inspected.
- Keep manuscripts as ordinary text (`.typ`, `.html`, and related source assets), with small versioned JSON sidecars for highlight policies and review proposals. GitHub can store the project, sources, and review metadata together. Preserve offline editing and explicit conflict handling.
- Let ChatGPT web reach a dedicated, opt-in zrok MCP endpoint, following Secret Tunnel's native process supervision. Review mode retains explicitly shared manuscripts and narrowly scoped suggestions. Separate App controls may inspect authorized projects, operate safe views/settings, compile saved snapshots and export artifacts through the Rust authority. Keep scope, authentication, revocation, no-save editor guards and actual UI acknowledgement explicit; neither mode is a filesystem or command proxy.
- Show proposed replacements in color-coded cards beside the editor. MCP agents cannot accept or reject them or change protections; the local user retains those controls. Validate exact source revision, quoted passage, current policies and anchor validity at submission and local acceptance.
- Let users assign colors to protection/rejection, prompt-guided revision and discard-idea actions, with additional prompts on individual passages. Discard requires a deletion suggestion covering the marked idea, not an immediate edit. Protection/rejection wins; stale restrictive markers fail closed. Source changes require local acceptance or complete current direct-prompt marker authorization.
- Give the AI the entire active manuscript as reading context, including its constituent chapters, while permitting suggestions and direct edits only within current highlighted passages. Require complete-context retrieval before proposals and preserve the distinction between read-only context and per-color edit permission. The [connection contract](PROTOCOLS/connections.md#full-manuscript-context-and-highlighted-only-changes) defines completeness, draft/snapshot identity, privacy and the outstanding acceptance gates.
- Add optional automatic GitHub checkpoint synchronization without committing unrelated work, overwriting external edits, rewriting history, or resolving divergence automatically.

## Publishing and UI acceptance scope

| Required capability | Observable acceptance |
| --- | --- |
| Complete Typst manuscripts | Compile representative multi-file documents with equations, bibliography/citations, labels/cross-references, outline, figures, tables, links, footnotes, page numbering and templates; inspect actual PDF text/structure and separately qualify appearance. |
| Main document and project inputs | A persisted main document builds while an included source or bibliography is being edited. Save all participating dirty buffers without discarding conflicts. Included sources, bibliography, data and asset changes invalidate the old preview. |
| Publishing controls | Explicit and automatic builds remain responsive, preserve the last good PDF, expose warnings/errors with useful source locations, and provide complete page navigation, zoom, fit, source/PDF navigation and downloads. Additional formats/standards need their own native operations and tests. |
| Project/file management | Project navigation, files/folders, source/asset creation and import/upload, rename/move, safe deletion and source-project export retain save/conflict/path protections. |
| Authoring | Selection, undo/redo, find/replace, outline, formatting, indent, and insertion of math, figures/tables, citations, references and links operate on the current document and preserve editor state. History, word count, settings and supported visual editing require explicit implementation/qualification. |
| Familiar workspace | Menus, panes, review navigation, preview controls, keyboard actions and supported responsive/accessibility states pass the paired-state checks in [overleaf-ui-parity.md](overleaf-ui-parity.md). |
| UnderTree additions | TeX-free offline operation, native window controls, portable sources, passage protection/prompts, scoped ChatGPT review and non-content App controls, and optional safe local GitHub checkpoints remain explicit acceptance requirements. Extra abilities supplement the familiar editor actions. |
| Installer, GitHub release and this PC | Build and qualify the native installer, publish the tested bytes and checksums on GitHub, install that release on this PC and verify the installed executable and desktop launcher. A build or extracted-package smoke test alone does not satisfy installation. |

Equivalent document outcomes use Typst's language and packages. Existing LaTeX classes/packages, arbitrary TeX import fidelity, publisher-specific templates, system/external font changes and every Typst export format are separate compatibility/qualification questions. A valid PDF header or a successful build alone proves none of these outcomes. The mandatory `npm run test:typst-publishing` gate exercises real compiler output; a missing Typst executable fails that gate.

## Current implementation boundary

- `modules/review/` is the shared Rust authority for local Tauri/CLI operations and the narrower MCP tools. It manages `.typ` and `.html` manuscript source with `<source>.undertree-review.json` sidecars; the transient `<source>.undertree-pending.json` journal recovers an interrupted source/metadata transaction.
- The publishing engine parses prose with pinned `typst-syntax` and supervises the separately installed Typst 0.15.1 CLI for PDF compilation. Project settings retain a main `.typ`; the UI saves all open project inputs before compiling it. Rooted no-follow handles copy regular project inputs into a private compiler root, preserving relative source/asset/font paths while excluding links, reserved control-plane/dependency directories and compiler snapshots. Staging is bounded to 128 MiB for the whole project, 20,000 entries, 2,000 directories and 32 levels. Dependency receipts hash the actual copied bytes; original edits, removals and links make the safe snapshot stale. Successful warnings and the last-good PDF persist. Preparation/output verification run off the async executor and retain build ownership on cancellation; output content hashes protect prior artifacts before metadata publication. Legacy/unverified/external-package receipts cannot claim currentness. This is a pinned input copy, not an atomic multi-file filesystem transaction or an OS sandbox. External package/compiler state and system/embedded font identity remain separate trusted inputs. PDF stdout is spooled with a hard 16 MiB limit on Rust-written PDF bytes and requires actual EOF. Dependency JSON still has only a post-compile 256 KiB admission limit; a hard temporary-write bound remains open. This is not a filesystem quota for arbitrary compiler/cache writes. Normal cleanup is implemented; abrupt-crash residue remains open. The complete renderer is not embedded in the desktop binary.
- TeX import converts common headings, emphasis, lists, footnotes and page breaks into a new `.typ` source. It emits `<target>.import-report.json`, retains unsupported constructs as raw text where supported by the parser, and always reports `exactFormatting: false`. Arbitrary class/package/macro/font/layout equivalence remains an open research target.
- The zrok adapter requires an existing enabled `zrok2` executable, reserved public name and its exact HTTPS origin. Non-secret name/origin settings may be remembered locally; grants and a running tunnel are never restored automatically. It supervises the child process and a separate loopback MCP listener, rotates the capability URL on start, and revokes session shares on stop. Running-process status is not external connectivity proof.
- GitHub binding uses `owner/name` and existing Git credentials. Autosync checkpoints UnderTree-owned pending sources/sidecars/report files after a debounce; clean incoming updates may fast-forward, while staged/unrelated changes, dirty newer remotes and divergence require local resolution.
- Linux native and browser checks, actual GitHub publication, live ChatGPT/zrok use, cross-platform packages and importer fidelity have separate evidence requirements in [reference-evidence.md](reference-evidence.md).

## Migration boundary

`native/tauri/` is the desktop shell on every target platform. `modules/review/` owns the framework-independent Rust review authority and MCP boundary. `modules/frontend/` owns browser interaction and save coordination; `src/manuscript.js`, `src/manuscript.css`, and `manuscript.html` adapt it to the DOM. Existing Node/GTK and TeX modules are compatibility references during migration. The obsolete Electron path has been removed and must not return to builds or releases.

The Rust/Tauri review workspace is an independent, TeX-free execution path. Typst integration must use the same save, revision, project-confinement, and last-good-preview safeguards. Do not label the Typst migration complete until real `.typ` editing, compilation, preview, and agent suggestion behavior have been exercised.

## Evidence and handoff

Record public-source references, installed skill provenance, module boundaries, tests, browser/native results, and remaining migration gaps. A built frontend or local MCP test does not prove a live ChatGPT-to-zrok connection, a GitHub publication, or a packaged cross-platform application.

The user's 2026-10-15 instruction explicitly authorizes a GitHub installer
release and installation on this PC. Qualify the exact package before
promotion, retain its source/build/asset identities and checksum, verify the
downloaded release bytes, and launch the actual installed app. Preserve
existing user projects/settings and use the current Rust/Tauri identity.
Platform and feature limitations must remain distinct from the larger final
product goal; shipping a native preview does not establish that goal's
completion.

The Linux installer/release/this-PC row is VERIFIED for the public
[v0.3.0 native preview](https://github.com/GeorgeFejer91/undertree/releases/tag/v0.3.0)
on 2026-10-15: qualified exact package, anonymous download/checksums,
installation/removal/reinstallation, real desktop-launch Typst compilation
and a normal user app left open. See [the exact report](../VERIFICATION.md#native-linux-release-and-this-pc-installation-2026-10-15).
This bounded completion does not complete the other acceptance rows.
