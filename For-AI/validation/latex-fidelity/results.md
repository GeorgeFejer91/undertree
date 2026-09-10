# Fidelity result ledger

## 2026-08-28 — grant-corpus baseline and first repair

- Converter: Tylax 0.3.7, pinned through Cargo.lock.
- UnderTree additions: confined include expansion, root detection, non-strict preservation mode, Unicode table guard, starred-heading repair, safe HTML color restoration, external bibliography restoration, common accent normalization, basic page-layout restoration, supported multicolumn checklist repair, bounded warnings, atomic no-clobber output, and embedded Typst compile validation of every newly generated root.
- Corpus: local disposable checkout of the user's `grants` repository.
- Preservation observation: 131 original `.tex` files remained present; 127 new `.typ` siblings were created; no original LaTeX file was replaced.
- Editor inventory observation: UnderTree exposes only UTF-8 `.typ` and `.bib` documents and skips `.tex`, PDFs, images, Git metadata, and generated state folders.
- Baseline source inspection found concrete fidelity risks in real generated drafts: minipage width tokens emitted as literal text, flattened multicolumn layout, incomplete TeX accent normalization, and LaTeX-specific table column declarations carried into Typst output.
- `teilnehmerliste.tex` reference: MiKTeX pdfTeX with shell escape disabled; one A4 page. The initial Tylax draft compiled but rendered as three A4 pages, repeated literal dimension artifacts, flattened the two-column list, and extracted 376 tokens versus the reference's 199. Multiset token recall was 97.99%, precision 51.86%, and sequence similarity 67.83%.
- Repaired `teilnehmerliste.typ`: the embedded UnderTree Typst world compiled it and the test-only Typst PDF exporter produced one A4 page. It preserves the title, all visibly inspected names, checkboxes, two-column structure, common German accents, margins, and no-page-number layout. Both PDFs extracted 199 tokens; multiset recall and precision were 98.49%. The three differing tokens are PDF extractor substitutions around `Lürßen`, `Wolff`, and `Daiß`, which were visibly correct in the rendered Typst page.
- At 150 DPI, the reference page's non-white content bounding box was `(83, 82, 860, 1527)` and the repaired Typst page's was `(83, 81, 856, 1494)`. Human inspection found close overall geometry with minor heading size, font, and vertical-spacing differences. Classification: **Verified close for this fixture only**.
- The layout-heavy letter and technical-report candidates could not form a trustworthy paired render in this checkout because their JPEG/PNG dependencies were Git LFS pointer text rather than materialized images. The letter failed both LaTeX and Typst image decoding. The technical report additionally produced four unclosed-delimiter diagnostics in Typst. Classification: **Unverified / repair required** until LFS assets are materialized and the remaining syntax errors are reduced to public regression fixtures.
- No generated Typst draft from the grants repository was pushed. All 131 original `.tex` files remain preserved; the 127 generated `.typ` siblings remain local and require project-level review.

This run demonstrates that a compile-only gate would have accepted a materially wrong three-page result. It does not establish universal LaTeX fidelity: each new construct class must earn its own fixture result before UnderTree can call it verified.

## 2026-08-28 — Typst-to-LaTeX basic submission fixture

- Source: a disposable one-page A4 Typst fixture with headings, author text, bold/italic emphasis, a bullet list, inline and display mathematics, and a two-column table.
- Integrity: the source compiled in UnderTree's embedded Typst world before conversion; its bytes remained unchanged; three repeated QA exports produced versioned files rather than overwriting prior output.
- Converter: Tylax 0.3.7 structured Typst-to-LaTeX diagnostics API, complete-document mode, with UnderTree restoration of simple base font size, default unnumbered headings/pages, zero paragraph indentation, and table-to-paragraph flow.
- LaTeX validation: the final draft compiled with MiKTeX pdfTeX 1.40.28 using `-no-shell-escape`, producing one A4 page with no blocking error. This TeX installation is QA-only and is not a product dependency.
- Render comparison: both sides were one A4 page. At 150 DPI, the Typst content bounding box was `(117, 115, 917, 752)` and the final LaTeX box was `(118, 119, 987, 821)`. Human inspection confirmed every heading, prose sentence, list item, equation term, and table cell remained visibly present; differences were limited to expected font metrics and vertical spacing.
- Raw PDF text extraction produced 70 Typst tokens and 71 LaTeX tokens, with 92.86% multiset recall, 91.55% precision, and 92.20% sequence similarity. The apparent omissions were math-glyph extraction differences (`∫`, Greek symbols, and superscripts), not visible content loss, so token scores alone are not a sufficient equation-fidelity measure.
- Classification: **Verified close for the basic fixture only**. Imports, packages, dynamic show/set rules, citations/bibliographies, figures, complex tables, custom journal classes, and multi-file projects remain review-gated until dedicated reverse-direction fixtures pass.
