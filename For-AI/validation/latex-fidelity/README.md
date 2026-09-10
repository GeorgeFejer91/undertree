# LaTeX migration fidelity gate

This folder is the durable, Markdown-only control plane for validating UnderTree's LaTeX and Overleaf migration path. It contains the protocol, fixture catalogue, acceptance thresholds, and dated result ledger. It must never contain source documents, imported user data, PDFs, rendered page images, compiler binaries, scripts, or other generated artifacts.

The reverse Typst-to-LaTeX submission workflow and its integrity rules are specified in `bidirectional.md`.

Temporary render artifacts belong in `tmp/latex-fidelity/` while a run is active and must be removed after the numeric and visual findings are recorded in `results.md`. The application never reads this folder at runtime.

## Purpose

The gate distinguishes four claims that must not be conflated:

1. **Preservation:** every original `.tex`, `.bib`, image, PDF, and archive byte remains unchanged.
2. **Syntactic validity:** the generated `.typ` compiles with UnderTree's embedded Typst world.
3. **Content fidelity:** normalized extracted text, references, figures, tables, and equations remain materially present.
4. **Visual fidelity:** page geometry and rendered placement are acceptably close to a trusted LaTeX reference PDF.

A successful Typst compile proves only item 2. UnderTree must never describe it as proof of items 3 or 4.

## Required run sequence

1. Work only on a disposable copy or on new, untracked `.typ` siblings. Hash every original before conversion and verify the hashes afterward.
2. Identify actual LaTeX document roots rather than treating every included `.tex` fragment as a standalone document.
3. Convert in-process with the pinned Tylax version and capture every bounded diagnostic.
4. Compile each generated root with UnderTree's embedded Typst world. Do not substitute a Typst CLI because it may have different fonts, package access, or filesystem authority.
5. Produce a trusted reference PDF either from an existing source-matched PDF or by compiling the preserved LaTeX in a confined QA environment with shell escape disabled.
6. Export a QA Typst PDF from the same paged document model used by UnderTree's preview.
7. Compare page count, normalized extracted text, rasterized page geometry, missing/extra pages, and representative visual regions. Record unsupported constructs separately.
8. Inspect at least the first, densest, and last page visually when they exist. Automated scores never waive human inspection for a migration marked publication-ready.
9. Record aggregate results in `results.md`, delete temporary PDFs and page images, and leave every original source untouched.

## Repository-owned QA entry points

The two ignored Rust tests below are the only repository-owned render helpers. They run the same conversion and embedded Typst world as the product; they do not download or invoke another converter.

```powershell
$env:UNDERTREE_LATEX_FIXTURE = 'C:\absolute\path\to\disposable-project'
cargo test --locked converts_external_latex_project_fixture_without_mutating_tex_sources -- --ignored --nocapture

$env:UNDERTREE_TYPST_SOURCE = 'C:\absolute\path\to\generated.typ'
$env:UNDERTREE_TYPST_PROJECT_ROOT = 'C:\absolute\path\to\project'
$env:UNDERTREE_TYPST_PDF_OUTPUT = 'C:\absolute\path\to\repo\tmp\latex-fidelity\candidate.pdf'
cargo test --locked renders_external_typst_document_to_pdf_for_fidelity_review -- --ignored --nocapture

$env:UNDERTREE_TYPST_LATEX_FIXTURE = 'C:\absolute\path\to\repo\tmp\latex-fidelity\candidate.typ'
cargo test --locked exports_external_typst_fixture_without_mutating_its_source -- --ignored --nocapture
```

Run these commands from `src-tauri/`. A trusted LaTeX renderer, PDF rasterizer, and text extractor are QA-environment tools only; they are never product runtime dependencies.

## Classification

- **Verified close:** compiles; page count matches; normalized text retention is at least 98%; no missing figures, tables, equations, or citations; representative pages pass visual inspection.
- **Usable draft:** compiles and retains the substantive text, but pagination, typography, tables, figures, references, or custom layout still need review.
- **Repair required:** generated Typst does not compile or loses substantive content.
- **Unverified:** no trustworthy source-matched reference PDF exists, so only preservation and compile checks were possible.

The threshold is deliberately conservative. LaTeX packages and macros can execute arbitrary document logic, while Typst uses a different language and layout model; universal lossless source conversion is not a realistic guarantee.

## Product implications

- Import is always non-destructive and creates new `.typ` siblings only.
- The editor inventory exposes only UTF-8 `.typ` and `.bib` documents; preserved LaTeX and supporting assets remain on disk and in Git but do not add editor clutter.
- Every generated file is labelled as a draft until the fidelity gate says otherwise.
- Known high-risk constructs must produce targeted warnings before conversion.
- UnderTree's runtime remains offline and must not invoke TeX, a shell, Pandoc, or a network conversion service.
- Every newly generated Typst root is compile-validated. Aggregate success means all generated roots compiled; any one failure keeps the import in review state.
