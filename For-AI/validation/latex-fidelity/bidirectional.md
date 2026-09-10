# Bidirectional conversion protocol

This protocol governs both conversion buttons in UnderTree. It is orchestration and validation guidance only; runtime code, fixtures, PDFs, binaries, and generated documents must not be placed in `For-AI/`.

## LaTeX to Typst

- Input is one explicitly selected `.tex` file or Overleaf ZIP.
- Every source, archive, bibliography, image, and supporting asset is preserved byte-for-byte.
- UnderTree creates new `.typ` siblings only and refuses to overwrite an existing `.typ`.
- Every newly generated Typst root is compiled by UnderTree's embedded Typst world.
- Compile success is not visual-fidelity proof; use the paired-render gate in `README.md`.

## Typst to LaTeX

- Input is the saved, open `.typ` document inside the selected project.
- UnderTree first compiles the exact saved Typst source with its embedded compiler. A broken source produces no LaTeX export.
- UnderTree converts locally with the pinned Tylax diagnostics API and writes a complete article-class document.
- The original `.typ`, existing `.tex`, bibliography, and assets are never overwritten.
- Outputs are versioned as `name.undertree-export.tex`, then `name.undertree-export-2.tex`, and so on.
- Only these generated exports are visible/editable in UnderTree's file tree; preserved legacy `.tex` sources remain hidden.
- Every output carries a provenance header and explicit warnings for imports/includes, show/set rules, bibliography handling, and journal-template adaptation.

## Journal submission gate

A generated article-class document is a migration draft, not a submission-ready journal package. Before submission:

1. Obtain the journal's current official LaTeX class/template and instructions.
2. Move the converted body, metadata, figures, bibliography database, and declarations into that template without deleting the Typst source.
3. Check every citation key, cross-reference, equation, table, figure, footnote, and supplementary-file reference.
4. Compile with the exact TeX engine and bibliography workflow required by the journal, with shell escape disabled unless the official template explicitly requires and justifies it.
5. Compare the journal-template PDF with the approved Typst PDF using page count, normalized text, figure/table/equation inventory, and visual inspection.
6. Submit only after all blocking converter warnings have been resolved or explicitly accepted.

Typst and LaTeX have different programming and layout models. No automatic converter can truthfully guarantee universal round-trip or journal-template fidelity; UnderTree therefore optimizes the mechanical transfer while preserving both originals and the evidence needed for review.
