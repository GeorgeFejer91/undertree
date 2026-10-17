# Sources and Provenance

Direct integration snapshots were checked on 2026-09-10 (Europe/Berlin). Commit-pinned links are the authority for what was copied or adapted. Historical evidence snapshots named inside inherited references remain historical; they are not silently relabeled as the current direct inputs.

## Direct Source Snapshots

| Source | Immutable snapshot | License | Contribution |
|---|---|---|---|
| Tauri Browser Remote Control | [`0fbf222da89469c63844e8b49fcb6d0047431b74`](https://github.com/GeorgeFejer91/tauri-browser-remote-control/commit/0fbf222da89469c63844e8b49fcb6d0047431b74) | MIT | Remote system contract, authority/protocol/authentication/transport/transfer/lifecycle/qualification references, templates, starter contracts and Rust/browser code, scaffold and repository checks |
| Tauri Rust Developer Skill | [`3accda94db2fe6becd851a0f81498a69b0a8c591`](https://github.com/GeorgeFejer91/tauri-rust-developer-skill/commit/3accda94db2fe6becd851a0f81498a69b0a8c591) | MIT | Complete general Rust/Tauri reference library covering architecture, security, frameworks, native integration, migration, performance, verification, and release |
| Zuradio Builder subtree | [`1990ca844f063356dfa6380189d62607adf5cb66`](https://github.com/GeorgeFejer91/zuradio/tree/1990ca844f063356dfa6380189d62607adf5cb66/skills/zuradio-builder) | MIT | Product contract and defect-derived lessons for one Rust authority, CLI parity, browser control, media, bulk upload, recognition isolation, browser lifecycle, supervision, and installed/public gates |
| Uncodixfy | [`e0e028058b5259debdd94b78147c6d6c77bf7da2`](https://github.com/cyxzdev/uncodixfy/commit/e0e028058b5259debdd94b78147c6d6c77bf7da2) | MIT | Complete upstream anti-generated-UI critique, retained verbatim as a conditional reference and adapted into a product/accessibility-aware interface gate |
| Pretext | [`630e0966baed8111c4e3468781677ffff35885da`](https://github.com/chenglou/pretext/tree/630e0966baed8111c4e3468781677ffff35885da) (`@chenglou/pretext` 0.0.9) | MIT | Documented text-measurement surface, supported CSS subset, font/runtime caveats, layout APIs, and regression guidance synthesized into a strict bounded-text contract |

Direct skill entrypoints:

- [Tauri Browser Remote Control `SKILL.md`](https://github.com/GeorgeFejer91/tauri-browser-remote-control/blob/0fbf222da89469c63844e8b49fcb6d0047431b74/SKILL.md)
- [Tauri Rust Developer `SKILL.md`](https://github.com/GeorgeFejer91/tauri-rust-developer-skill/blob/3accda94db2fe6becd851a0f81498a69b0a8c591/SKILL.md)
- [Zuradio Builder `SKILL.md`](https://github.com/GeorgeFejer91/zuradio/blob/1990ca844f063356dfa6380189d62607adf5cb66/skills/zuradio-builder/SKILL.md)
- [Uncodixfy `SKILL.md`](https://github.com/cyxzdev/uncodixfy/blob/e0e028058b5259debdd94b78147c6d6c77bf7da2/SKILL.md)
- [Pretext `README.md`](https://github.com/chenglou/pretext/blob/630e0966baed8111c4e3468781677ffff35885da/README.md), [platform bugs](https://github.com/chenglou/pretext/blob/630e0966baed8111c4e3468781677ffff35885da/PLATFORM_BUGS.md), and [package manifest](https://github.com/chenglou/pretext/blob/630e0966baed8111c4e3468781677ffff35885da/package.json)

## Destination Ledger

| Destination | Source and treatment |
|---|---|
| `SKILL.md` | New synthesis of the source entrypoints; routes instead of concatenating them |
| `references/00-system-contract.md` through `11-zuradio-lessons.md`, plus `13-tauri-application-foundation.md` | Copied from Tauri Browser Remote Control snapshot; links retained within the integrated layout |
| `assets/starter/contracts`, `assets/starter/rust`, `assets/starter/browser`, `assets/starter/qualification`, `assets/templates` | Copied from Tauri Browser Remote Control snapshot; notices added to scaffold output |
| `scripts/scaffold_remote_control.py` | Copied and adapted from Tauri Browser Remote Control to include the integrated CLI and notices |
| `scripts/check_repository.py` and inherited tests | Copied and adapted for the new skill name, resources, CLI, links, and notices |
| `references/tauri/*` | Complete reference directory copied from Tauri Rust Developer Skill snapshot |
| `references/zuradio-project-contract.md` | Copied from the Zuradio Builder subtree; remains a labeled case study rather than a universal product specification |
| `references/uncodixfy-upstream.md` | Verbatim copy of the Uncodixfy `SKILL.md` at the pinned snapshot |
| `references/interface-quality.md` | New adaptation preserving Uncodixfy's anti-clutter/anti-template intent while resolving conflicts with existing systems, accessibility, semantic headings, brand color, platform conventions, and legitimate landing-page needs |
| `references/pretext-text-layout.md` | New synthesis of Pretext's documented support boundary into a scoped typography allow-list, overflow policy, integration pattern, and browser/WebView verification gate; no Pretext source code is vendored |
| `references/integrated-app-blueprint.md` and `references/cli-and-automation.md` | New synthesis defining the combined authority topology and filling the missing portable CLI contract |
| `assets/starter/cli` | Newly authored typed CLI/admin adapter starter; not copied from Zuradio's product-specific CLI |

Uncodixfy's MIT-licensed comparison screenshots are retained under `assets/interface-examples/` as optional visual examples because the user requested the full four-skill combination. They are not required reading; the complete operational upstream `SKILL.md` text is retained separately.

## Important Synthesis Decisions

- General Tauri work uses the complete Tauri reference library; remote-specific gates activate only when the change affects remote readiness or behavior.
- A new application gets one shared Rust action/service boundary and a first-class CLI. Remote transport remains inert until the user chooses an activation and reachability profile.
- Installed, CLI, and remote exposure remain distinct typed adapters, but ordinary product actions default to full semantic parity. Local-only exceptions must be explicit and justified by trust, consent, physical-presence, OS-permission, or safety boundaries. Nothing is exposed through reflection, string command lookup, arbitrary CLI parsing, or a generic Tauri proxy.
- Human-memorable passwords require a maintained reviewed PAKE. Passwords are not mandatory when passkeys, accounts, or high-entropy invitations better fit the product.
- A static no-user-data companion is the preferred local-first profile, not a substitute for designing a requested cloud data/account architecture.
- The inherited 24-hour remembered-browser profile is an example with strong expiry/revocation requirements, not a universal product lifetime.
- WebRTC, WSS, WebTransport, VDO.Ninja, GitHub Pages, media, bulk lanes, background supervision, and local-operator priority are conditional choices supported by routed references, not requirements for every app.
- Uncodixfy's fixed dimensions, blanket color/font/headline prohibitions, and random palette suggestion are treated as critique, not universal accessibility or branding rules.
- Pretext is optional for ordinary flowing text and required only when an application claims its predictive text geometry. Governed regions accept allow-listed, target-tested named font tokens and documented Pretext features; unsupported requirements use an explicit DOM-managed path without a Pretext claim.
- Zuradio measurements and defect history justify test shapes and design constraints but do not become performance promises for another app.

## Inherited Provenance and Exclusions

The complete inherited Tauri provenance remains in [tauri/provenance.md](tauri/provenance.md). It records transitive MIT sources and distinguishes architecture observations from copied material.

No source or prose was copied from the no-reuse-license projects identified there, or from RustDesk's AGPL-3.0 code. VDO.Ninja SDK (MPL-2.0), SongRec (GPL-3.0-or-later), Affect Tracker (BSD-3-Clause), FreePD (CC0), and other runtime/case-study dependencies are cited only; they are not vendored by this skill. Generated applications must audit the exact dependencies and assets they choose.

## Current Primary References

Version-sensitive claims must be checked again against pinned project versions and current official sources:

- [Tauri v2 capabilities](https://v2.tauri.app/security/capabilities/), [permissions](https://v2.tauri.app/security/permissions/), and [scopes](https://v2.tauri.app/security/scope/)
- [Tauri calling Rust](https://v2.tauri.app/develop/calling-rust/) and [calling the frontend](https://v2.tauri.app/develop/calling-frontend/)
- [WebRTC specification](https://www.w3.org/TR/webrtc/) and [RFC 8831 WebRTC Data Channels](https://www.rfc-editor.org/rfc/rfc8831.html)
- [RFC 8656 TURN](https://www.rfc-editor.org/rfc/rfc8656.html)
- [RFC 9382 SPAKE2](https://www.rfc-editor.org/rfc/rfc9382.html), [RFC 9383 SPAKE2+](https://www.rfc-editor.org/rfc/rfc9383.html), and [RFC 9807 OPAQUE](https://www.rfc-editor.org/rfc/rfc9807.html)
- [Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/)
- [WebTransport](https://www.w3.org/TR/webtransport/)
- [GitHub Pages documentation](https://docs.github.com/pages)
- [Pretext README](https://github.com/chenglou/pretext/blob/main/README.md), [changelog](https://github.com/chenglou/pretext/blob/main/CHANGELOG.md), and [platform bug ledger](https://github.com/chenglou/pretext/blob/main/PLATFORM_BUGS.md)
- [Tauri WebView versions](https://v2.tauri.app/reference/webview-versions/) and [`Intl.Segmenter`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter)

## Evidence Limits

This skill and its starter can establish consistent boundaries, schemas, parser behavior, and tested examples. They cannot prove a generated application's authentication-library correctness, OS-specific local IPC, browser/WebView compatibility, Pretext-to-DOM agreement for its fonts and strings, NAT/relay success, transfer integrity under real faults, latency/throughput, background lifecycle, accessibility, installer/signing/update behavior, physical-device support, or production security. Only that application's own complete qualification record can support those claims.

## License Boundary

Required direct and inherited notices are retained in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). The scaffolded starter carries its own notice so copied code preserves attribution. Product integrations must independently review licenses for their chosen frameworks, cryptography, WebRTC/signaling stacks, codecs, sidecars, fonts, icons, and other assets.
