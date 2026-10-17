# wrAIter branding and icon integration

User-approved direction, 2026-10-17: use the compact AI waiter/typewriter mark
coherently for wrAIter's LibreOffice Writer and Microsoft Word integrations,
their windows, installers/download materials and GitHub presentation. The towel
and typewriter paper share one shape. Earlier logo sketches are not alternatives.

## Canonical assets and owners

The product master is [`assets/wraiter/icon.svg`](../../assets/wraiter/icon.svg).
Its named PNG exports and multiframe `icon.ico` live beside it. Product assets,
rendering helpers and release output never belong under `For-AI/`. Reuse these
exports; do not regenerate the concept, stretch/crop it, introduce another
palette, or substitute stock Office artwork for the add-on's identity.
[`assets/wraiter/README.md`](../../assets/wraiter/README.md) describes the exports.

| Surface | Owner and required treatment |
| --- | --- |
| LibreOffice toolbar and Extension Manager | `modules/libreoffice/build.py`, `extension/Addons.xcu` and `description.xml` package/refer to the shared PNGs. Palette swatches remain functional colors. |
| LibreOffice add-on dialogs | The shared native `Dialog` path owns application identity for every color/overlap, connection, setup, consent, detail and proposal window. Windows uses the packaged ICO on that dialog's own native handle; it never changes Writer's document or application icon globally. Other platforms retain native host chrome until independently qualified. |
| Word Home/wrAIter ribbon | The primary add-on/Connections entry uses the embedded logo. Color swatches, new-rule and selected-rule actions retain distinct functional imagery and keyboard names. |
| Word add-on windows | All add-on forms inherit the shared `NativeDialog` icon from `AppBranding`; no per-window stock or alternate brand icon. System confirmation/error glyphs retain their native meanings. |
| Installers and installed-app entries | Word setup/uninstall executables and Windows DisplayIcon use the same ICO. The Writer OXT contains its PNG/ICO assets and works independently. Any later installer wrapper or download UI follows this contract. |
| GitHub and downloads | Root/add-on README sections and [download instructions](../../docs/downloads.md) show the approved mark. The shared social-preview PNG is ready for repository settings; do not change the account avatar or replace UnderTree's identity. Public release links require actually published, qualified artifacts. |

## Coherent native style

Follow the installed Uncodixfy visual discipline through [the skill route](../skills.md).
Use a modest mark in native title bars and existing primary entry points, with
consistent optical scale, aspect ratio and clear space. Keep native fonts,
control behavior, focus rings, action order, consent text and resize behavior.
Avoid repeated brand headers, hero panels, decorative badges, gradients or
additional navigation. The approved icon's rounded tile is part of the asset,
not a reason to round or recolor every control.

Later Word-specific direction asks for the logo in the dialog layout as well as
its window icon. Use one modest mark in the existing footer's leading space,
cream (`#fbf8ef`) window surfaces and deep-green (`#1b3530`) body text from the
approved artwork. Keep native inputs, buttons, selection colors and user-owned
highlight swatches. High contrast uses system surfaces and text. Do not add a
banner or another layout row, or reduce readable text to make branding fit.

This request covers every **application identity icon**, not replacing distinct
actions with identical logos. Close, Copy, connection state, warnings and
user-owned highlight colors remain recognizable. Branding conveys no connection,
sharing, protection or edit permission; [the connection contract](connections.md)
still governs authority. Never recolor document highlights to match the logo.

These integrations are native UNO/WinForms. Use native measurement and the
[outside-in layout policy](../ui-layout.md); do not claim HTML/Pretext testing.
If an actual HTML downloader or add-on surface is introduced, read the combined
Uncodixfy/Pretext skill and its measurement reference, use the locked dependency
and test the rendered bounded labels. A Markdown README needs no HTML runtime.

## Verification and delivery

1. Compare exported PNG dimensions and packaged/embedded bytes with the shared
   master exports. Check small and large toolbar sizes, transparency and centering.
2. Open every native dialog class through each host's shared path. On Windows,
   inspect both small and large window icons; verify handle cleanup on close.
   Exercise native resizing, enlarged text, focus and existing dialog layout gates.
3. Build each target independently. Inspect OXT references and Word DLL,
   setup/uninstall and DisplayIcon resources. Include brand inputs in Word's
   source/build receipts. Test malformed/missing assets without touching documents.
4. Check README/download links and distinguish local builds from public releases.
   A repository README can show this mark without changing the repository owner
   avatar. Record social-preview upload and public publication separately.
5. Preserve live Office sessions and unrelated working changes. Install only
   qualified packages when the host can be safely updated. If source changes
   during checks, capture a stable input copy and identify its limits; do not
   certify an unstable source tree or treat icon checks as whole-product release
   qualification. Evidence belongs in ignored `artifacts/raider-logo/`, with a
   concise result in [reference-evidence.md](../reference-evidence.md).
