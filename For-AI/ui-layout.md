# UI layout: bounded fitting, stable editing and SVG geometry

Standing rule for all UnderTree interface work: **CSS allocates the box; text and icons adapt inside it, within readable bounds.** Moving a component, resizing a split pane or using a narrow viewport must not require new per-element font sizes or offsets. This file owns the rule; the entry guide routes here.

## References and existing code

Use [Ponytail](https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail/SKILL.md) for coding/review. The measurement reference is [Cheng Lou's Pretext](https://github.com/chenglou/pretext), package `@chenglou/pretext`. Read the upstream [README](https://github.com/chenglou/pretext/blob/main/README.md), [layout source](https://github.com/chenglou/pretext/blob/main/src/layout.ts) and [measurement source](https://github.com/chenglou/pretext/blob/main/src/measurement.ts), then check the installed package's exports. Upstream was inspected on 2026-09-19; this is a library, not a fictitious auto-font-sizing skill.

`src/pretext-fit-core.js` already uses Pretext rich-inline measurement for opted-in print blocks. Preserve that product capability and its authored fit groups/bounds. It is not a general live-editor fitter: do not run its print/manifest traversal on every keystroke or transplant its nested DOM-write/search loops into toolbar fitting. Keep live UI work under the existing frontend ownership. Reuse the dependency and useful measurements, not another layout engine or a runtime dependency on Secret Tunnel's checkout.

## One shared bounded fitting policy

Apply the same policy to constrained headings, buttons, tabs, file-tree labels, status/error text, menus, dialogs, inspector labels and editing-tool chrome. An already-fitting string is a no-op; ordinary flowing content can use CSS wrapping.

- Measure the **allocated content box**, never the text's intrinsic width. Reserve icon/badge slots, gaps and padding once; use `box-sizing: border-box`, `min-inline-size: 0`, grid/flex and `minmax(0, 1fr)`. Establish a real height only where height is intentionally bounded.
- Preserve the full current string and its semantic HTML. Read actual computed family, weight, style, whitespace, spacing and line-height. Convert dimensions to CSS pixels, not device pixels. Use shared rem-based readable minimum and preferred/maximum size tokens, resolved against the user's text scale.
- Test the preferred size first. Otherwise choose the largest size in the allowed interval that meets width, height and line-count limits. Use a small fixed search cap, for example 12 iterations, plus a declared rounding tolerance. Recompute line-height and em-based spacing for each font size. Validate the final candidate; do not treat a width ratio as proof.
- Pretext separates text/font preparation from width-dependent layout. Use `prepareWithSegments` with `measureNaturalWidth` for one line, or `measureLineStats`/`layout` for wrapping when available in the installed version. Account for hard breaks and match DOM wrapping. Use supported rich-inline measurement only when mixed formatting actually requires it.
- Cache by text, complete font **including size**, spacing, whitespace and locale/font state. Width-only changes can reuse preparations; changing font size or loaded font metrics cannot. Retain an independent preferred-size token so text grows back after its container expands. Never reuse the last shrunken result as the next maximum.
- Apply one final CSS-property update and do a bounded rendered-bounds check. Report `no-fit` when the readable minimum fails or group bounds do not intersect; defer hidden/zero-size boxes until visible. Do not expand a fixed control, shrink indefinitely, or clip required content to claim success.

Conceptual criterion, not an upstream API:

```text
font = largest tested size in [readable minimum, preferred maximum]
where maximum line width <= available width
  and line count * resolved line-height <= available height
  and line count <= the component's line limit
otherwise: defer a hidden box, or use the explicit no-fit presentation
```

Observe owning slots with `ResizeObserver`. Schedule dirty work after text/locale changes, pane resizing, reveal, reparenting, theme changes and fonts becoming ready. Batch reads then writes in `requestAnimationFrame`; avoid observer feedback, polling and scanning the entire editor. Clear stale prepared handles and relevant measurement caches after a font changes. Disconnect observers/listeners and bound caches to live/recent content. Check real rendered bounds: glyph overhang, fallback fonts and browser features can differ from idealized metrics.

## Editing and print are not interchangeable

Fit **editor chrome and finite, explicitly fitted design blocks**, not an arbitrarily long manuscript into the editor viewport. CodeMirror/Tiptap/ProseMirror source and manuscript panes keep the user's readable font/zoom and use their own wrapping, scrolling or pagination. Do not shrink the whole document as more text is typed. Inputs and textareas retain full values and native selection/scroll behavior.

Never rewrite a document, insert ellipses into an editor buffer, alter markup to make a label fit, or change compiled PDF typography because the UI pane resized. Preserve selection, caret, IME composition, undo/redo, editor transactions, protected passages and review anchors; use the editor's supported hooks instead of replacing its DOM. Print fitting changes only explicitly authored fit blocks within their saved print profile, not unrelated source text or scientific content.

At the UI readability floor use planned multiline/reflow or an accessible bounded details region. Secondary display labels alone may use measured ellipsis, with full text available by keyboard/touch and assistive technology; a hover-only title is insufficient. Use `Intl.Segmenter` grapheme boundaries, not character counts, UTF-16 slicing or `Array.from`. Never truncate editable values, manuscript text, essential errors or required instructions. Respect user zoom and text spacing rather than shrinking them back away.

## SVGs remain attached to their box

Center a dedicated icon slot using grid `place-items: center` or equivalent flex alignment. Give SVGs a correctly bounded `viewBox`, `preserveAspectRatio="xMidYMid meet"`, and width/height constrained by the slot. Size proportionally against the tighter dimension; two-axis container containment is only for deliberately dimensioned containers. Keep internal coordinates, strokes and padding in SVG user units, with room for painted bounds. Do not repair each button with absolute offsets or text-scaling transforms.

Keep icon and text slots separate. Prefer live HTML labels to outlined glyphs. Decorative icons are `aria-hidden="true"` and `focusable="false"`; real buttons retain accessible names, focus rings, keyboard operation and usable hit areas. Use `currentColor` where appropriate. Verify centering after reparenting and resizing, not only at the original desktop position.

## Verification

Test short/long localized labels, narrow/wide split panes, both dimension changes, hide/reveal, late fonts, repeated text edits, regrowth, 200% user zoom/text scaling and narrow reflow. Check preserved caret/selection/IME/undo, keyboard focus, full required content, icon clearance and absence of fit loops or typing delays. Compare behavior and bounds, not exact policy prose or fixed coordinates. Reuse existing unit/UI checks and keep print/export checks separate. A documentation edit does not mean the runtime migration or visual verification has been completed.
