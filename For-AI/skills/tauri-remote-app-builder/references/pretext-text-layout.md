# Pretext-Governed UI Text Layout

Read this reference when an installed Tauri interface or hosted browser companion has fixed-height text, generated copy, localization risk, virtualized rows, responsive cards, or text that must flow around other content. Pretext is a frontend measurement and line-breaking tool. It does not own application state, replace semantic HTML/CSS, or change the Rust authority or remote protocol.

## Why Use It

Pretext separates expensive preparation from cheap width-dependent layout. Use that property to:

- predict card, row, transcript, and notification heights before mounting them;
- verify that generated or localized labels fit their allocated controls;
- resize phone and desktop layouts without synchronous DOM-measurement loops;
- virtualize long experiment logs with deterministic estimated heights;
- preserve scroll anchors when live text changes;
- compute multiline shrink-wrap or line-by-line widths around plots, media, and controls;
- turn text overflow from a screenshot observation into a repeatable test result.

Normal HTML and CSS still render ordinary interface text. Use Pretext where knowing the geometry before or outside DOM layout materially helps. Do not add it to a project solely because the project contains text.

## Support Boundary

The Pretext guarantee applies only to a **Pretext-governed text region**. Such a region must use a declared text style, a known content width, a named overflow policy, and the supported feature subset below. A component outside this subset is DOM-managed and needs its own browser/WebView verification; it must not be reported as Pretext-verified.

Pretext is not a general CSS inline formatting engine. It does not model arbitrary nested markup, Flexbox or Grid sizing, padding, borders, replaced elements, automatic hyphenation, selection behavior, or every advanced font feature. The DOM remains the final rendering oracle.

## Strict Supported Profile

### Runtime

- Bundle the locked `@chenglou/pretext` package into the static frontend. Do not load it from a CDN or add a remote script origin to Tauri CSP.
- Feature-detect `Intl.Segmenter` and a Canvas 2D or `OffscreenCanvas` context before activating the governed path. A missing prerequisite selects an explicit DOM fallback or makes the declared platform unsupported.
- Wait for the exact primary font face to load before calling `prepare()` or `prepareWithSegments()`. Do not measure a fallback and later render a different face.
- Record the package version, lockfile, supported OS/WebView matrix, and any polyfill in the application's verification evidence. Re-run the text corpus before accepting an upgrade.

### Typography Allow-List

Pretext does not publish a universal list of safe font families. It accepts a Canvas font string, while actual accuracy depends on the resolved font in each browser/WebView. Therefore each application must own a small allow-list of **tested typography tokens** rather than accept arbitrary font strings.

Each token must declare:

- one explicit primary font family that is bundled with both the installed UI and public companion or otherwise proven present on every supported target;
- the exact static face or tested style and weight;
- a finite CSS-pixel font size;
- a finite CSS-pixel line height;
- a finite numeric CSS-pixel letter spacing;
- `whiteSpace: 'normal'` or `whiteSpace: 'pre-wrap'`;
- `wordBreak: 'normal'` or `wordBreak: 'keep-all'`;
- locale and representative probe text used by the qualification test.

CSS and Pretext must be generated from the same token. Pretext-governed components may reference token IDs only; do not construct unchecked font strings inside components.

A token is ineligible until the exact face loads and its predicted line count and height agree with rendered DOM fixtures in every claimed browser and Tauri WebView. A font family is not approved merely because it looks similar on one machine.

By default, reject these features inside a Pretext-governed region:

- `system-ui`, `-apple-system`, or a generic-only family as the measured primary face;
- an unpinned local-font fallback that can resolve differently across devices;
- synthetic weights or styles that do not have a tested face;
- `font-optical-sizing`, `font-feature-settings`, or standalone `font-variation-settings`;
- variable-font axes not represented by and tested through the Canvas font string;
- relative, `normal`, or content-derived line heights, and non-pixel letter spacing;
- `white-space` modes other than `normal` and `pre-wrap`;
- `word-break` values other than `normal` and `keep-all`;
- wrapping semantics other than `overflow-wrap: break-word` with `line-break: auto`;
- `hyphens: auto`; insert conservative locale-aware soft hyphens before preparation when hyphenation is required;
- CSS text transformation unless the final transformed string is what Pretext receives;
- geometric transforms or independent CSS scaling that change text or box geometry after measurement;
- arbitrary mixed-font nested markup. Use the deliberately narrow `@chenglou/pretext/rich-inline` API only for tested inline items, with explicit `extraWidth` for atomic chrome.

An existing product may keep a different typography system for ordinary DOM-managed text. If a user requires an unsupported feature, preserve that requirement, mark the component DOM-managed, and verify the real layout. Never silently remove required accessibility, localization, or brand behavior merely to retain a Pretext label.

## Bounded-Text Contract

Every fixed or maximum-size text region must declare one of these outcomes before implementation:

- `expand`: grow the block and reflow surrounding content;
- `reflow`: select a different approved layout at the breakpoint;
- `scroll`: retain the region and expose all content through scrolling or virtualization;
- `clamp`: show an explicit, accessible path to the full text;
- `reject`: fail authoring, fixture, or CI validation because truncation is not allowed.

Silent clipping is not a policy. Do not auto-shrink below the product's readable minimum, hide failure with a smaller font, or treat CSS ellipsis as proof that the content fits.

Use `reject` for primary buttons, critical state, participant instructions, safety/consent text, and values whose distinction matters. Use `expand` or `reflow` for ordinary cards. Use bounded `scroll` or virtualization for logs and transcripts. Use `clamp` only for genuinely secondary copy with keyboard, touch, and assistive-technology access to the complete value.

## Integration Pattern

Keep one framework-neutral wrapper shared by the installed interface and browser companion. It should accept only an allow-listed token and a closed overflow policy, then return measured geometry and whether the region fits.

```ts
import { layout, prepare } from '@chenglou/pretext'

export function measureBoundedText(
  text: string,
  token: ApprovedTextToken,
  contentWidthPx: number,
  maxHeightPx: number,
) {
  const prepared = prepare(text, token.canvasFont, {
    whiteSpace: token.whiteSpace,
    wordBreak: token.wordBreak,
    letterSpacing: token.letterSpacingPx,
  })
  const result = layout(prepared, contentWidthPx, token.lineHeightPx)
  return { ...result, fits: result.height <= maxHeightPx }
}
```

Memoize preparation by final text, token, and locale. A width change calls only `layout()`; a content, font, letter-spacing, whitespace, word-break, or locale change requires new preparation. Bound caches or call `clearCache()` when applications cycle through large numbers of fonts or generated text variants.

Pass the actual content-box width, excluding padding, borders, icons, badges, buttons, and gaps. Prefer known layout values or `ResizeObserver` output rather than interleaved synchronous DOM reads. Flex and Grid children still need correct CSS sizing such as an intentional minimum width; Pretext cannot repair a wrong containing block.

Use:

- `prepare()` plus `layout()` for height and line-count prediction;
- `prepareWithSegments()` plus `measureLineStats()` for multiline shrink-wrap decisions;
- `layoutNextLineRange()` for variable width per line around an obstacle;
- `rich-inline` only for its documented flat inline items, never as a nested HTML renderer.

Keep rendering semantic. A measured heading remains a heading, a button remains a button, and reading/focus order remains DOM order. Pretext geometry must not replace accessible names or hide status text.

## Verification Gate

For every governed component:

1. Confirm the selected token exists in the project's allow-list and all font files are bundled and licensed.
2. Wait for the exact face, then prove the required Pretext runtime features exist.
3. Exercise minimum, typical, and maximum supported widths; every declared font size; 100%, 200%, and the product's maximum supported zoom or dynamic-text setting.
4. Include empty strings, longest real labels, long unbroken identifiers and URLs, repeated symbols, emoji, combining marks, hard spaces, explicit newlines, RTL text, CJK/Hangul, and the supported localization corpus.
5. Check the Pretext result against the declared `maxHeight`, `maxLines`, and overflow policy.
6. Render the real DOM after fonts load and compare predicted line count/height with observed geometry within a documented tolerance. Assert that unintended `scrollWidth > clientWidth` or `scrollHeight > clientHeight` does not occur.
7. Run companion tests in each supported browser engine and smoke the exact packaged Tauri WebViews on each claimed OS. A Chromium browser pass does not prove WebKitGTK or WKWebView behavior.
8. Capture version, font files/hashes, runtime versions, fixtures, widths, and failures. If only the DOM fallback was exercised, report that the component was not Pretext-verified.

Treat Pretext's own dashboards as upstream evidence, not proof for the application's fonts, strings, CSS, or WebViews.

## Source Baseline

This reference was derived from Pretext `0.0.9` at commit [`630e0966baed8111c4e3468781677ffff35885da`](https://github.com/chenglou/pretext/tree/630e0966baed8111c4e3468781677ffff35885da), checked on 2026-09-10. Recheck the current [README](https://github.com/chenglou/pretext/blob/main/README.md), [changelog](https://github.com/chenglou/pretext/blob/main/CHANGELOG.md), [platform bug ledger](https://github.com/chenglou/pretext/blob/main/PLATFORM_BUGS.md), and [package manifest](https://github.com/chenglou/pretext/blob/main/package.json) before selecting or upgrading the dependency.

