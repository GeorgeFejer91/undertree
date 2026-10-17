# Sources and Provenance

Checked 2026-09-02 (Europe/Berlin). Exact source snapshots are recorded so future updates can distinguish durable guidance from version-sensitive facts.

## Synthesized Repositories

| Source | Audited snapshot | License | Contribution |
|---|---|---|---|
| [Browser Remote Sync Protocol](https://github.com/GeorgeFejer91/browser-remote-sync-protocol/tree/e6a5eef86d4b3c7422ace08706df5deb82338808) | `e6a5eef86d4b3c7422ace08706df5deb82338808` | MIT | BRSP/1 envelope/handshake/state semantics, application target authority, VDO.Ninja adapter, threat model, deployment and qualification discipline |
| [Tauri Rust Developer Skill](https://github.com/GeorgeFejer91/tauri-rust-developer-skill/tree/3accda94db2fe6becd851a0f81498a69b0a8c591) | `3accda94db2fe6becd851a0f81498a69b0a8c591` | MIT | Rust/Tauri architecture, capabilities, IPC, persistence, sidecars, browser companion reliability, packaging, performance, testing |
| [Zuradio](https://github.com/GeorgeFejer91/zuradio/tree/97e0eb5f8d84f7d8f6fac187f264bc261ecb339f) | committed base `97e0eb5f8d84f7d8f6fac187f264bc261ecb339f` plus audited local working tree | MIT | production case study for password-gated remote browser control, live media, trusted reconnect, uploads, binary channel, optional recognition, supervision, and browser gates |

The audited Zuradio working tree was intentionally not modified by this synthesis. It advanced concurrently during the work, so the final audit incorporated the newer committed snapshot and a supplemental in-progress qualification cut. That cut's tracked binary patch SHA-256 was `1fdc4230c2a7f6aa5c24c655dd4d5c375c6e8830ad211f337d682cdaca990c17`; its sorted untracked-file content manifest SHA-256 was `b80a3388933e1613f9884be21eff2892b0e744412363a6e0199c0ef009b5a049`. It contributed the disabled-by-default, temporary loopback-inspection and unconditional state-restoration rules. These hashes identify the exact supplemental evidence reviewed but are not an upstream immutable commit. Accordingly, qualification results drawn from that tree are labeled case-study evidence rather than released guarantees.

No full upstream source tree is vendored. Starter code is an original compact scaffold and intentionally omits vendor SDK and cryptographic PAKE implementations.

## Primary Protocol and Platform References

These sources support current technical boundaries; verify them again against pinned dependencies when implementing:

- [Tauri capabilities](https://v2.tauri.app/security/capabilities/): per-window/WebView/platform permissions, merged-capability boundaries, remote-origin cautions, generated schemas.
- [Tauri command scopes](https://v2.tauri.app/security/scope/) and [permissions](https://v2.tauri.app/security/permissions/): application enforcement and least privilege.
- [Calling Rust from the Tauri frontend](https://v2.tauri.app/develop/calling-rust/) and [calling the frontend from Rust](https://v2.tauri.app/develop/calling-frontend/): commands, events, channels, binary/streaming choices.
- [Tauri localhost plugin](https://v2.tauri.app/plugin/localhost/): official warning that localhost asset serving creates considerable security risk.
- [WebRTC specification](https://www.w3.org/TR/webrtc/): RTCDataChannel, SCTP maximum message size, buffered amount, errors, and lifecycle.
- [RFC 8831: WebRTC Data Channels](https://www.rfc-editor.org/rfc/rfc8831.html): SCTP over DTLS and channel reliability/ordering architecture.
- [RFC 8656: TURN](https://www.rfc-editor.org/rfc/rfc8656.html): relay behavior required for restrictive reachability cases.
- [RFC 9382: SPAKE2](https://www.rfc-editor.org/rfc/rfc9382.html), [RFC 9383: SPAKE2+](https://www.rfc-editor.org/rfc/rfc9383.html), and [RFC 9807: OPAQUE](https://www.rfc-editor.org/rfc/rfc9807.html): standardized/reviewed PAKE choices and security considerations.
- [RFC 9106: Argon2](https://www.rfc-editor.org/rfc/rfc9106.html): memory-hard password hashing/KDF parameter guidance.
- [RFC 9449: DPoP](https://www.rfc-editor.org/rfc/rfc9449.html): proof-of-possession token principles; this skill does not claim DPoP conformance unless its complete profile is used.
- [Web Cryptography Level 2](https://www.w3.org/TR/WebCryptoAPI/): serializable/non-extractable `CryptoKey`, IndexedDB use, origin and storage limitations.
- [WebTransport](https://www.w3.org/TR/webtransport/): browser-to-server streams/datagrams. At the check date it was a W3C Candidate Recommendation Snapshot dated 2026-07-30, not a peer-to-peer NAT-traversal replacement.
- [File API](https://www.w3.org/TR/FileAPI/): `Blob`, slicing, and browser file objects.
- [Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api): hidden/frozen/discarded behavior and unreliable unload assumptions.
- [VDO.Ninja generic P2P data guide](https://docs.vdo.ninja/guides/iframe-api-documentation/generic-p2p-data-transmission-guide) and [Ninja SDK](https://github.com/steveseguin/ninjasdk): vendor transport integration; application authorization remains above it.
- [webrtc-rs](https://github.com/webrtc-rs/webrtc): native Rust WebRTC candidate. v0.20.0 was the current stable release seen during the audit; re-check releases/API before adoption.
- [GitHub Pages documentation](https://docs.github.com/pages): static companion hosting and HTTPS/domain deployment, not a native backend.

## Synthesis Decisions

- BRSP's mutual HMAC remains valid for generated high-entropy invitation secrets, while human passwords are upgraded to a PAKE requirement.
- Tauri remains the native shell/default adapter, but exact WebView capability is a measured platform property; dedicated Chromium or native Rust WebRTC can replace only the host adapter.
- Zuradio's control/state patterns are extended with a dedicated bulk-transfer lane and stronger general remembered-device proof-of-possession recommendation.
- Measured Zuradio frame sizes, watermarks, and latency figures are starting hypotheses and qualification examples, not normative constants.
- Static hosting is strictly separated from user data and runtime authority.
- Supervised availability is an explicit product/consent mode, never an incidental default.
- Raw remote desktop/input, shell, arbitrary path/URL/SQL, and generic Tauri command forwarding remain out of scope.

## Evidence Limits

The source repositories and specifications can establish design rationale and tested examples. They cannot prove a new application's:

- target-browser/WebView support;
- NAT/relay success;
- authentication-library correctness;
- latency/throughput/resource ceilings;
- physical-device lifecycle;
- installer/signing/update behavior;
- production security.

Only the generated application's own complete qualification record can support those claims.

## License Boundary

All three synthesized repositories are MIT-licensed. Their copyright notices are retained in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). External specifications and documentation are cited as references; their prose and code are not redistributed here. Product integrations must independently review licenses for signaling SDKs, WebRTC stacks, browsers, codecs, sidecars, and platform packages.
