# Upstream architecture comparison — 19 September 2026

Broad search of public Typst desktop/web editors, preview engines, and collaboration projects. Sources are the projects' own repositories/docs. Feature and license entries describe upstream declarations, not independently reproduced performance/security claims. No upstream app was installed or benchmarked, no code was copied, and no new dependency is selected by star count. Pin exact revisions/versions and inspect component licenses at implementation time.

## Decision proposed for review

Retain UnderTree's embedded native Typst engine and use locally bundled **PDF.js** for the actual PDF review surface. Borrow incremental-session and navigation ideas from **Tinymist/typst.ts**. Treat **Hilbert** as the closest PDF-oriented desktop architecture reference, not a product to fork wholesale. An early benchmark/mapping spike can revise this choice; it is a compatibility judgment, not a measured fastest-engine result.

Tinymist explicitly distinguishes its PDF-on-type export from its faster SVG web preview. Therefore adding its web preview does not, by itself, satisfy the user's requirement that highlights live on an actual PDF. Do not hide that distinction behind the word “preview.”

| Candidate / primary source | What is useful | Why not adopt the entire architecture |
| --- | --- | --- |
| [Tinymist](https://github.com/Myriad-Dreamin/tinymist), [preview docs](https://myriad-dreamin.github.io/tinymist/feature/preview.html) | Integrated Typst language/preview service, incremental preview and source navigation; repository declares Apache-2.0 | LSP/server/editor integration is more than the initial review loop. SVG speed does not prove PDF latency or precise arbitrary-range mapping. Reusing crates requires compatibility and per-component license checks. |
| [typst.ts](https://github.com/Myriad-Dreamin/typst.ts) | Native/browser compiler and vector rendering architecture; incremental server-rendered artifacts; Apache-2.0 | A browser/WASM compiler duplicates UnderTree's native core unless evidence justifies replacement. Default examples may load assets online; offline bundling must be explicit. |
| [Hilbert](https://github.com/aburousan/hilbert-editor) | Tauri/Rust + Monaco, actual live PDF, PDF-to-source navigation and local workflow; MIT | Uses external Typst CLI, optional Tinymist, and substantial maths/code-running infrastructure. Its README describes contextual text matching; that is not sufficient authorization for destructive edits. Borrow PDF UX and tests, not executable-tool breadth. |
| [Typst Studio](https://github.com/DeathKhan/typst-studio) | CodeMirror + Tinymist live HTML preview and source navigation; separate PDF export | Electron and external tools conflict with the existing minimal native runtime. HTML preview is not actual PDF review. License/revision inspection required before code reuse. |
| [Typwriter](https://github.com/Ahdeyyy/typwriter) | Tauri/Svelte Typst editing, live compiled preview and export | Another whole application; README flags local-compilation development limitations. Inspect relevant components rather than assume release readiness or change frontend framework. |
| [Texpile](https://github.com/texpile/texpile) | Visual/source interaction over plain authoring files, citations and comments; AGPL-3.0 declared | Broad LaTeX/Typst/Markdown application; code reuse requires deliberate license/distribution review. Visual editing is not the same as author-approved PDF suggestions. |
| [Moraya](https://github.com/zouwei/moraya) | Tauri/Rust desktop, Typst live preview, local-first/MCP interaction; Apache-2.0 declared on project site | Broad Markdown/AI marketplace/provider feature set is the wrong scope to import. A privacy claim is not a substitute for checking actual provider calls. |
| [Typos](https://github.com/dailydaniel/typos) | Rust core separated from Tauri/Svelte/CodeMirror and CLI; embedded compiler | Notes, backlinks and indexes add a second product model. Useful ownership pattern, not a research-paper schema. |
| [TeXlyre](https://github.com/texlyre/texlyre) | Local-first editing with Yjs and peer collaboration; real concurrent-edit reference | Yjs/CRDT and peer-network persistence are a distinct complexity budget. Three-file transfer alone does not provide their semantics. Revisit only for an approved live-coediting phase. |
| [TypstDrive](https://github.com/SirBlobby/TypstDrive) | CodeMirror/Yjs multi-user web model | Self-hosting, accounts and collaborative state exceed the initial offline desktop/checkpoint requirement. |
| [Tyraria](https://github.com/ParaN3xus/tyraria) | Tinymist-WASM + typst.ts integration proof of concept; GPLv3 | Special fork/build setup and demo positioning, not a drop-in production backend; no wholesale copying. |
| [Typst online editor](https://github.com/Mapaor/typst-online-editor) | Typst-WASM/PDF.js browser integration example; MIT project declaration | Next.js/browser build is not a reason to replace native Rust; useful viewer/compiler boundary reference only. |
| [typst-desktop](https://github.com/lucaslrodri/typst-desktop) | Small Tauri shell; MIT | Wraps the hosted Typst web editor and requires login. Not an offline local compiler foundation. |
| [Annotate](https://github.com/not-manu/annotate) | Existing-PDF overlay workflow | Separate per-page authoring files and generated directories oppose the three-file contract; does not supply source-safe manuscript review. |

## Components rather than a fork

[Typst](https://github.com/typst/typst) already implements incremental compilation. Do not claim UnderTree has zero incrementality merely because its World is short-lived; measure reuse, parsing, PDF generation and transport independently. [PDF.js](https://mozilla.github.io/pdf.js/) is a PDF renderer/platform with a local worker/text-layer integration path, not a Typst source map or review-policy engine.

CodeMirror is a possible later source-editor component, not a prerequisite for PDF-first reviewing. Keep source-buffer ownership singular; an editor-library migration should only address demonstrated editing/undo needs. No simultaneous adoption of Monaco, CodeMirror and a separate rich-text database.

For three-file resource design, consult Typst's [image byte input](https://typst.app/docs/reference/visualize/image/) and [bibliography](https://typst.app/docs/reference/model/bibliography/) documentation. These establish useful format capabilities, not a promise that arbitrary external figures, fonts and packages fit the initial portable profile. Bundled defaults and explicit unsupported cases come first.

## Reuse gate

For any selected upstream component record its exact commit/release, actual feature path used, license/notice obligations, offline asset requirements, trust boundary, maintenance cost, and a test proving the requested behavior. Keep the native compiler unless measured PDF/mapping results show a better fit. No transitive upgrade or public-license change is authorized by this plan.
