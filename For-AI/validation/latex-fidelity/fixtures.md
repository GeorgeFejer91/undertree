# Fidelity fixture catalogue

Fixtures are described here without copying private documents into the application repository. A run supplies the actual paths through local environment variables.

## Required fixture classes

| Class | Required features | Why it matters |
| --- | --- | --- |
| Basic article | headings, emphasis, paragraphs, Unicode | Baseline text and pagination |
| Grant application | custom macros, images, tables, geometry, bibliography | Representative UnderTree workload |
| Multi-file Overleaf project | `\input`, `\include`, or `subfiles`, images, `.bib` | Root detection and confined dependency expansion |
| Math-heavy paper | inline/display equations, labels, references, matrices | Formula and reference integrity |
| Layout-heavy document | minipages, multicolumn content, custom spacing, headers/footers | Known source-to-layout mismatch risk |
| Adversarial preservation | non-UTF8 file, symlink, traversal path, oversized input, duplicate output | Non-destructive and confinement guarantees |

## 2026-08-28 grant-corpus candidates

These paths are relative to a disposable checkout of the user's `grants` repository and have a same-named reference PDF beside the LaTeX source unless noted otherwise.

| Fixture | Class | Initial risk signal |
| --- | --- | --- |
| `2026/Kino-Kaddish-Multi-Funder-2026/supporting-repositories/kino-kaddish/19-04_Karlshorst/2026-04-19_Anfrage_Museum_Berlin_Karlshorst_DE.tex` | Layout-heavy letter | `minipage`, custom macros, images, table widths, TeX accents |
| `2026/Kino-Kaddish-Multi-Funder-2026/supporting-repositories/kino-kaddish/golem/Ablaufplan/teilnehmerliste/teilnehmerliste.tex` | Layout-heavy list | `multicols`, macro-generated checkbox rows, compact geometry |
| `2026/BIAL-Foundation-2026-Mobile-Boundaries/supporting-repositories/pps-kit/For-AI/research/literature/docs/dynaspace_spectral_feature_audit/dynaspace_spectral_feature_audit.tex` | Technical report | long tables, custom column types, citations, images, included section |

The catalogue must expand with minimal public fixtures for every newly fixed converter regression. Private grant text should never be committed merely to reproduce a parsing or layout bug; reduce it to the smallest synthetic case.
