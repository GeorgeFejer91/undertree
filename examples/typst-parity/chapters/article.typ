#import "../template.typ": emphasize
#set document(title: "UnderTree Typst delivery fixture", author: "UnderTree QA")
#set page(paper: "a4", margin: 20mm, numbering: "1")
#set text(font: "New Computer Modern", size: 11pt)
#set heading(numbering: "1.")
#set math.equation(numbering: "(1)")

= Offline article <sec-article>

#outline(title: [Contents])

Article sentinel. This fixture exercises native Typst publication through UnderTree.
It cites an offline reference @undertree2026 and contains a footnote.#footnote[Footnote sentinel.]
The imported template supplies #emphasize[Imported template sentinel].

#include "background.typ"

#pagebreak()
= Methods <sec-methods>

Math sentinel. The inline expression $q^2 + alpha = 7$ and the displayed model
use mathematical symbols, superscripts, and a fraction:

$ z = frac(a, b) $ <eq-model>

#figure(
  image("../assets/plot.svg", width: 45mm),
  caption: [Vector plot sentinel.],
) <fig-plot>

#figure(
  table(
    columns: 2,
    stroke: 0.5pt,
    table.header([Sample], [Value]),
    [Control sentinel], [11],
    [Treatment sentinel], [23],
  ),
  caption: [Results table sentinel.],
) <tab-results>

References resolve to @sec-background, @sec-methods, @eq-model, @fig-plot,
and @tab-results.

#link("https://example.org/undertree")[External link sentinel.]

#pagebreak()
= Discussion <sec-discussion>

Discussion sentinel. The bibliography is read from a local BibTeX file.

#bibliography("../references.bib", style: "ieee", title: [References])
