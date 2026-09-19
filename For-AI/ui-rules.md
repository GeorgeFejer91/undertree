# UI contract: fit content to its CSS box

Status: author-requested design rule, 2026-09-19; documentation only. This does not install Pretext, introduce a runtime fitter, or approve the pending implementation slices. Read this for every UI addition, change, refactor, and review, together with the required Ponytail skill in [README.md](README.md).

## One rule, applied everywhere

**CSS gives each component its space. Text adapts to that space through Cheng Lou's Pretext. SVG icons scale and center within their own slots. Moving or resizing a component must not require new font sizes or positioning patches.**

This is the Secret Tunnel text-to-box convention, made explicit for UnderTree. It applies to all application text displays: buttons, menus, tabs, headings, status/error rows, project and citation labels, tooltips, dialogs, annotation controls, and review panels. Static wording is not exempt from responsive layout. A static element proven to fit across its supported states needs no redundant runtime measurement; it still follows this contract.

Boxes may change through CSS layout, container queries, intentional responsive modes, and user pane resizing. What is forbidden is growing a control/window, adding an accidental scrollbar, or adjusting one-off offsets just because its current label overflows. Reparenting the same component must preserve its internal proportions and alignment.

## CSS is responsible for geometry

- Use shared component classes and CSS custom properties for font bounds, line height, padding, gaps, icon ratios, and density. Product-wide design tokens are allowed; per-label pixel guesses and breakpoint font patches are not.
- Give text a real allocated content box, not an intrinsic box whose width is already the text width. Use shrinkable flex/grid children (`min-inline-size: 0`, `min-block-size: 0`, and `minmax(0, 1fr)` where appropriate). Measure the granted space after borders/padding and reserved sibling slots; do not subtract the same gap twice.
- Reserve icon, label, badge, and action slots explicitly. Labels cannot push siblings out of the component. Center within the appropriate slot with grid/flex alignment, not spaces, negative margins, absolute screen coordinates, or `translate` nudges.
- Prefer local container-relative sizing to viewport-only sizing so nested/resized/moved components behave alike. Use logical CSS properties for direction-aware layouts. Establish a size independently before applying size containment; otherwise the measured/query container can collapse or depend on its own content.
- Narrow/mobile-sized layouts may deliberately stack or change composition. They must reuse the same component rules, not a second collection of hand-tuned fonts. This is responsive behavior, not scope for a new mobile app.

## Pretext is the default text measurement engine

Use `@chenglou/pretext` from [chenglou/pretext](https://github.com/chenglou/pretext). Consult the upstream API for the version actually pinned. Pretext measures/layouts text; it does not automatically observe elements or choose a font size. UnderTree supplies one small shared adapter, not independent fitting logic per control.

For an approved implementation, keep that adapter in the existing `web/` presentation area (proposed owner: `web/ui-fit.js`, only created when implemented). Expose one class/attribute convention such as `data-fit`; ordinary components opt in without supplying hard-coded fonts or dimensions. A shared default fits labels; a small semantic distinction handles long-form content. Do not build a typography framework or import a React wrapper.

The adapter must:

1. Read the current CSS content-box budget, computed font family/weight/style, pixel-resolved font size/line height/letter spacing, wrapping policy, locale, and direction. Resolve shared minimum/maximum font tokens independently of its last fitted output, so a label can grow again after shrinking.
2. Use Pretext to find the **largest readable font within those CSS bounds that fits both width and height**, including the allowed line count. Use a bounded measurement search, not repeated DOM write/read trials, character counts, or an assumed linear scale from a single measured font size.
3. Check one-line width and hard breaks as well as height; check wrapped line widths and total line height for multiline content. Use the pinned version's `prepare`/`layout` or `prepareWithSegments` with line statistics/natural-width APIs as needed. Use supported rich-inline measurement or separate runs for mixed styling; a bold/code diff cannot be measured as one plain-font string.
4. Apply the result once. Keep the original text as data; display fitting must not edit source, comments, identifiers, or proposal payloads. Do not horizontally stretch text or use `transform: scale(...)` to disguise overflow.
5. At the readable minimum, use an explicitly permitted fallback: bounded wrapping, a shorter unambiguous control label, or measured grapheme-safe truncation for noncritical summaries. CSS `clamp()`/container units can set bounds but are not proof that particular words fit. Ellipsis alone is not the fitting strategy.

For an abbreviated identifier, keep the complete value available to keyboard, touch, and assistive-technology users and available to copy. A mouse-only `title` is insufficient. Never truncate the decisive wording of Accept/Reject controls, warnings, permissions, numerical results, or review changes. An impossible fit requires an intentional accessible layout/content mode, not invisible clipping or arbitrarily tiny text.

## Refit automatically; do not thrash layout

Observe the allocated box with `ResizeObserver` and invalidate when text, parent/slot geometry, visibility, font loading, typography tokens, theme/density, language/direction, or user text scaling changes. Content updates and reparenting must use the same adapter invalidation path; resize alone does not detect a different font or new wording. Defer zero-sized/hidden elements and refit when they become visible. Do not persist fitted pixel sizes in project JSON.

Coalesce changes with `requestAnimationFrame`, batch reads before writes, observe the stable allocated box rather than a self-sizing text child, and skip unchanged results. A fitter must settle rather than trigger itself indefinitely. Disconnect observers and release bounded caches when components disappear. No per-element timers, permanent polling, global DOM rescans on every keystroke, or expensive layout work during a drag event.

Reuse prepared text when only available width changes at the same typography. Reprepare for changed text, font size/family/weight, spacing, locale, or loaded font face; old prepared handles cannot be assumed to update themselves. Keep measurement CSS and rendering CSS identical. Test the target WebViews against Pretext's documented supported CSS/font features; unsupported variable-font settings or browser minimum-font rules require explicit handling, not a claim of universal pixel accuracy. Verify actual rendered bounds after settling and in tests, not on each measurement-search step.

## SVG icons: proportional and centered

Every application icon uses an SVG with a meaningful, normalized `viewBox` and `preserveAspectRatio="xMidYMid meet"`. Prefer SVG paths over font/Unicode icons. Dynamic labels remain ordinary measurable text beside the icon; do not bake changeable labels into paths or assume SVG `<text>` is automatically fitted.

The button's CSS allocates an icon slot; the slot centers its child using `display: grid; place-items: center` (or equivalent flex alignment). Set SVG display to block, preserve its aspect ratio, and size it as a shared fraction of the **smaller available dimension**. Container units such as `cqi`/`cqb` require an explicitly sized eligible container for both axes; percentages require a definite slot. Use one compatible fallback when a target WebView needs it, not per-button corrections.

Keep padding and icon/label gaps relational. Normalize asymmetric artwork/padding inside the SVG once instead of compensating with location-specific CSS. Geometric centering must survive parent changes, portrait/narrow layouts, and square or wide controls. Choose one shared stroke-scaling policy; use `currentColor` for themeable monochrome controls. Keep the accessible button hit area and focus ring independent of the smaller glyph. Decorative SVGs are hidden from assistive technology; icon-only buttons have a useful accessible name.

## Reading and PDF boundaries

All app text follows box-aware layout, but long manuscript/source text and review diffs are **reading content**, not short labels. Give them a readable, user-scalable type size and controlled wrapping/scrolling inside their designated pane. Use Pretext where measuring that app text is needed; do not shrink an entire proposal to fit a tiny card, truncate a meaningful edit, or turn every paragraph into a custom line renderer. Planned document/panel scrolling is permitted; a scrollbar added to hide a broken button or root-window layout is not.

Actual PDF typography remains owned by Typst. Never independently fit its text layer with Pretext or change PDF glyph positions to match a UI box. Scale the PDF, native source-map geometry, selection layer, and highlights together using the same build-bound viewport transform. This prevents a visually fitted overlay from authorizing edits to the wrong source. Human-facing annotation controls around the PDF do follow the normal Pretext/SVG rules.

Respect user zoom, minimum font preferences, and increased text size. Font fitting must not cancel their accessibility effect. Use shared readable bounds and deliberate accessible/narrow layouts when necessary. Keyboard navigation, IME input, text selection, and complete review content must survive refitting.

## Rust-first and YAGNI boundaries

Pretext is a deliberate local presentation dependency, not a new backend or a replacement for Rust policy enforcement. When the UI slice is approved, pin and bundle only what is needed with applicable notices. No CDN/runtime download, Node service, second UI framework, or Rust reimplementation of browser font measurement. Reuse the existing thin WebView; ordinary editing and reviewing stay offline.

Fix an overflow defect once in shared geometry/fitting or the SVG asset. Do not scatter `font-size`, `left/top`, character-limit, or viewport patches across controls. Keep this document as the sole detailed UI contract; link to it instead of duplicating it across modules.

## Required UI evidence

For each touched component, test short/long text, localized labels and Unicode, theme/font/text-scale changes, first font load, hidden-to-visible state, resize smaller then larger, and moving the component into a differently sized parent. Include narrow/mobile-sized panes and relevant display scaling on the supported desktop WebViews.

Assert settled text fits its allocated width/height with no sibling overlap; minimum readability is retained; growth restores the eligible font size; font changes invalidate measurements; no observer loop or drag jitter occurs; and icon center/aspect/relative size remain stable. Check keyboard/touch access to full values and complete diffs. Add an original regression fixture for the shared bug, not a test framework for every label. Capture UI evidence only in ignored/private test output. A documentation update is not proof the runtime implements these rules.

## References

- [Ponytail skill](https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail/SKILL.md): required development discipline.
- [Pretext README and API](https://github.com/chenglou/pretext): measurement, layout, caching, and supported-feature caveats.
- [Secret Tunnel fitting convention](https://github.com/GeorgeFejer91/SecretTunnel-v2/blob/v3/For-AI/README.md): reference behavior, not a runtime dependency on Secret Tunnel.
