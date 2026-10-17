# Product Interface Quality

Read this reference before generating or substantially changing the Tauri frontend or hosted companion. It adapts the Uncodixfy anti-template critique into a product, accessibility, and platform-aware design gate. The complete upstream text is retained in [uncodixfy-upstream.md](uncodixfy-upstream.md).

## Priority Order

1. User requirements and supplied visual references.
2. The existing product's components, tokens, typography, palette, density, and interaction conventions.
3. Accessibility, semantic structure, localization, input modality, and target-platform behavior.
4. Product tasks, information hierarchy, and real data states.
5. These anti-template principles.

Do not erase a coherent design system merely because it conflicts with a numeric preference in the upstream critique. Do not copy another product's trade dress. Use references to calibrate restraint, hierarchy, and finish.

## Design Before Styling

Inventory:

- primary user tasks and frequency;
- information that must remain visible while acting;
- empty, loading, partial, busy, offline, reconnecting, unauthorized, denied, conflict, error, and success states;
- keyboard, pointer, touch, gamepad, screen-reader, and narrow-width needs actually supported;
- local-only versus remotely permitted actions;
- destructive or consequential actions and confirmation/recovery needs;
- data density, performance, and virtualization constraints.

Choose a familiar layout pattern that fits those tasks. Do not invent asymmetry, extra rails, nested panels, or ornamental content merely to make the page feel designed.

## Anti-Template Gate

Reject common generated-UI defaults unless the product has a concrete reason for them:

- floating glassmorphism shells and detached rounded sidebars;
- gradients, glows, haze, decorative blobs, or oversized shadows used as hierarchy;
- pill-shaped treatment for every button, tab, label, and status;
- giant radii repeated across unrelated components;
- hero sections, eyebrow labels, slogans, and decorative explainer copy inside operational tools;
- generic dark SaaS dashboards with cyan accents;
- KPI-card grids, donut charts, fake trends, or progress bars without real decision value;
- decorative icon containers, badges, status dots, and tags on every row;
- excessive whitespace or padding that hides useful density;
- hover transforms, bounce, parallax, and animation without feedback value;
- sidebars, right rails, activity panels, schedules, quota blocks, and footer metadata invented to fill space;
- mobile behavior that merely stacks every desktop panel into one long column;
- copy such as “command center,” “operational clarity,” “live pulse,” or “premium” when it is not the product's voice.

Prefer ordinary, well-resolved components: solid surfaces, subtle one-pixel borders, clear labels, predictable placement, restrained radii, short color/opacity transitions, consistent spacing, and readable typography.

## Structure and Semantics

Use semantic headings and landmarks. The upstream “no headlines” rule means “avoid ornamental headline compositions,” not “remove accessible document hierarchy.” A page needs a clear title; an internal tool usually does not need an eyebrow, slogan, supporting paragraph, and decorative banner around it.

- Keep labels above or clearly associated with form fields.
- Use buttons for actions and links for navigation.
- Preserve DOM order that matches reading and focus order.
- Make tables actual tables when relationships are tabular.
- Keep status text explicit; do not rely on color or a dot alone.
- Announce asynchronous results and errors appropriately.
- Maintain visible focus, sufficient contrast, usable zoom, reduced motion, and touch targets appropriate to the platform.

## Layout Defaults, Not Laws

When the project has no system, start restrained:

- a consistent spacing scale such as 4/8/12/16/24/32 pixels;
- 14–16 pixel body text adjusted for font and platform;
- 8–12 pixel radii for cards and smaller radii for controls;
- a fixed desktop sidebar around 240–260 pixels only when persistent navigation is genuinely needed;
- toolbars around 48–56 pixels when that density fits the platform;
- subtle shadows no stronger than needed to express elevation;
- transitions around 100–200 ms for state feedback.

These are starting hypotheses. Content, touch ergonomics, platform conventions, user preferences, and an existing system can justify different values.

## Color and Typography

Reuse project tokens first. If none exist, choose a small coherent palette with sufficient contrast and document the semantic roles: background, surface, text, muted text, border, primary action, focus, danger, warning, and success. Do not choose randomly from the upstream palette table, default reflexively to blue, or ban blue when the product brand requires it.

Use a typeface that is licensed, available in the shipping context, readable at target sizes, and appropriate to the brand and platform. A system stack is acceptable for ordinary DOM-managed text when it is a deliberate performance/platform choice. A Pretext-governed region instead uses an explicit named primary face from the project's tested typography allow-list; see [pretext-text-layout.md](pretext-text-layout.md). Avoid mixing type families merely to simulate “premium” design.

## Bounded Text and Flexible Layout

Inventory every fixed or maximum-size text region and declare an overflow outcome: expand, reflow, scroll, clamp with access to the complete value, or reject. Silent clipping, unreadable auto-shrinking, and accidental wrapping inside controls are design failures, not polish issues.

Use Pretext when the interface benefits from knowing text height or line breaks before DOM layout: generated or localized labels, virtualized logs, responsive cards, stable scroll anchors, multiline shrink-wrap, or text flowing around media and plots. Apply the strict support profile and verification workflow in [pretext-text-layout.md](pretext-text-layout.md). Pretext predicts supported text geometry; semantic HTML and the rendered DOM remain authoritative for accessibility and final fit.

When a component claims Pretext verification:

- accept only allow-listed typography token IDs, never arbitrary font strings;
- keep CSS and measurement inputs generated from the same token;
- use only Pretext-supported whitespace, word-break, wrapping, line-height, and letter-spacing behavior;
- redesign or mark the component DOM-managed when required typography falls outside that profile;
- preserve the user's accessibility, localization, and brand requirements instead of forcing them into an unsupported measurement model.

## Local and Remote State Honesty

Remote interfaces must distinguish:

- discovering a route;
- transport connected;
- authenticating;
- authenticated but missing scope;
- control-ready after initial authoritative state;
- media or bulk lane still preparing;
- degraded or relayed route;
- reconnecting after sleep/network change;
- expired, revoked, stopped, or offline.

Do not show “connected” as a substitute for application readiness. Disable or explain actions based on real scope and state, not optimistic DOM state. Preserve useful cached content while marking it stale when recovery is underway.

## Tauri and WebView Details

- Test every promised WebView engine; browser success does not prove WebView parity.
- Clean subscriptions, timers, listeners, watchers, and channels on teardown, including async setup that completes after unmount.
- Avoid blocking initial paint on scans, metadata, optional remote discovery, or diagnostics.
- Respect title-bar, menu, tray, safe-area, keyboard, zoom, dynamic text, and window-size conventions per platform.
- Do not expose privileged Tauri APIs to remote content to simplify UI implementation.

## Review Checklist

- Can a user identify the primary action without reading decorative prose?
- Does every visible element represent product information or a useful action?
- Are hierarchy and state legible without gradients, glow, or badge proliferation?
- Are empty/error/offline/unauthorized states as carefully designed as success?
- Does phone width preserve all authorized workflows without hiding authority?
- Does every bounded text region declare and pass its overflow policy with long, localized, and zoomed content?
- Can the interface be used by keyboard and assistive technology?
- Is motion short, optional where appropriate, and tied to feedback?
- Does the interface look like this product rather than a generated dashboard template?
- Were screenshots or visual tests inspected at representative sizes and states?

Visual polish is not completion by itself. Verify the actions still reach the same Rust authority, errors remain safe, remote scope is enforced, and performance remains acceptable under real data and transfer load.
