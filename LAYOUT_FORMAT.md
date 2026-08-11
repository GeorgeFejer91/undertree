# UnderTree Layout

UnderTree Layout is a small, original, PreTeXt-inspired source format for documents whose physical regions are fixed but whose text varies. It separates semantic XML content from rendering and generates both an immediately inspectable HTML proof and editable LuaLaTeX.

It is not PreTeXt and does not claim compatibility with PreTeXt documents. The shared architectural ideas are semantic source, validation, a presentation layer, and multiple output targets.

## Use it in UnderTree

1. Create or open a file ending in `.layout.xml`.
2. Select the file in the editor.
3. Press **Recompile**. UnderTree validates the XML, creates HTML and LuaLaTeX in `.localtex-layout/<name>/`, compiles the generated LuaLaTeX, and refreshes only the PDF pane.
4. Use **View adaptive HTML proof** in the Recompile menu to inspect browser fitting or print from HTML.

The normal TeX root is compiled whenever the selected file is not a `.layout.xml` source.

## Minimal source

```xml
<layout-document version="1" title="Example" lang="en">
  <page size="A4" margin="10mm">
    <grid columns="1fr 1fr" rows="40mm 1fr" gap="4mm">
      <box id="intro" row="1" column="1" column-span="2"
           min-font-size="8.5pt" max-font-size="14pt">
        <heading>Meaningful heading</heading>
        <p>Semantic prose with <strong>emphasis</strong>.</p>
      </box>
    </grid>
  </page>
</layout-document>
```

## Page and grid

- `page`: `size="A4"` or explicit `width` and `height`; optional `margin` and `background`.
- `grid`: physical tracks such as `35mm`, flexible tracks such as `1fr` or `2fr`, plus `gap`.
- `box`: `row`, `column`, `row-span`, and `column-span`; omitted positions use row-major automatic placement.

All physical dimensions accept `mm`, `cm`, `in`, or `pt`.

## Adaptive box constraints

Each box can declare:

- `min-font-size` and `max-font-size`;
- `min-line-height` and `max-line-height` as unitless ratios;
- `min-gap` and `max-gap` between block elements;
- `valign="top|center|distribute"`;
- `padding`, background/text/border colors, border width, and corner radius.

HTML fitting first maximizes the font with minimum spacing, then restores the largest safe line height and gap. LuaLaTeX tests descending font sizes in 0.25 pt increments and distributes safe residual vertical room. Both renderers confine content to the declared box. Content that cannot fit at the minimum receives a visible red error; it is never shrunk below the boundary.

## Semantic content

Boxes accept `heading`, `p`, `label`, `list`/`item`, `image`, `rule`, and `spacer`. Inline markup supports `strong`, `em`, `code`, `link`, and `br`.

`heading`, `p`, and `label` may override their size relative to the box's fitted base font with `scale`, set a unitless `leading`, and set `color`. Images accept physical `width` and `height`; both renderers preserve the image's aspect ratio inside those bounds.

```xml
<heading scale="1.4" leading="1.5" color="#006c76">Section title</heading>
<image src="illustration.png" width="42mm" height="28mm" alt="Description"/>
```

The runtime validator gives contextual errors before rendering. The accompanying RELAX NG grammar is at `layout/localtex-layout.rng` for XML-aware editors.

## Command line

```bash
node layout/compiler.mjs examples/adaptive-boxes.layout.xml
latexmk -lualatex -outdir=examples/.localtex-layout/adaptive-boxes examples/.localtex-layout/adaptive-boxes/adaptive-boxes.tex
```

Generated files are build artifacts. Keep the `.layout.xml` semantic source under version control; ignore `.localtex-layout/`.
