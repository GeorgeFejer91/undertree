# Hosted Browser Companion

Use this reference for the static companion, PWA/offline behavior, browser security, mobile UX states, and deployment freshness.

## Static Hosting Boundary

The hosted site should consist only of versioned HTML, CSS, JavaScript, icons, manifest, and optional service worker. User data arrives from the authenticated live native session and should remain in memory unless the product explicitly defines local browser persistence.

Do not publish or proxy:

- user media/files or catalogs;
- databases, playlists, paths, logs, or thumbnails derived from private content;
- passwords, grants, device private keys, private route credentials, or TURN secrets;
- native API endpoints or unrestricted signaling administration;
- source maps containing secrets or private endpoints.

GitHub Pages is suitable for static assets, not a Rust daemon, WebSocket service, TURN server, transcoder, or private data host.

## Origin Is Part of the Security Model

The origin owns service workers, IndexedDB, WebCrypto key access, storage, CSP, and framing behavior. Protect it as a credential-bearing application:

- use HTTPS and stable domain ownership;
- minimize dependencies and pin/review build inputs;
- deploy a restrictive CSP and `frame-ancestors`/equivalent framing policy;
- avoid analytics and third-party scripts on authentication/control pages;
- scope service workers narrowly and make update/fallback behavior visible;
- prevent open redirects and arbitrary navigation;
- separate development origins/device records from production.

A non-extractable key limits export; same-origin injected code can still invoke it. XSS prevention is credential protection.

## Connection State Is Product State

Render explicit states rather than one ambiguous spinner:

```text
idle
discovering target
password/device authentication
opening private transport
control ready
media connecting / media ready
bulk ready
reconnecting
expired or revoked
unsupported browser
actionable failure
```

Do not show controls as active before the initial authority snapshot and grant are ready. Keep media readiness separate so autoplay or codec failure does not appear as control failure.

## Mobile Lifecycle

Assume a phone browser can throttle, freeze, discard, or terminate the page without a reliable unload callback. On `visibilitychange`, freeze/resume, `pagehide/pageshow`, network change, and page restoration:

- persist only safe local view state and remembered-device key/metadata;
- stop unnecessary render loops and timers;
- release or mark connections stale when frozen;
- increment the browser transport epoch before reconnect;
- re-prove device possession or password session as policy requires;
- request a fresh authority snapshot;
- never replay pending controls blindly;
- surface expired/revoked access as re-pairing.

Use bounded exponential reconnect with jitter and a terminal state for permanent authentication failure. A stale callback from a prior epoch must not update the current UI.

## UI and Input Semantics

The remote surface exposes semantic product controls. It must not synthesize arbitrary desktop input.

- make destructive/consequential actions explicit and confirm where appropriate;
- display pending versus applied state;
- disable or queue actions according to connection/grant state;
- show the current target identity and role;
- show direct/relay/unknown route honestly when relevant;
- preserve keyboard, touch, screen-reader, reduced-motion, zoom, safe-area, and coarse-pointer usability;
- test narrow phones, rotation, on-screen keyboard, and background/foreground on physical devices.

Continuous controls should send bounded semantic intent at a controlled cadence, not one message per pointer event. Use local display interpolation and reconcile from authority state.

## File and Folder Selection

Use browser `File` objects only as source handles. Preserve the live input element and selected objects through the event lifecycle; reset it after the transfer coordinator owns the selection. Filter extensions for convenience, then rely on Rust content validation.

Folder selection support differs across browsers. Provide a multi-file fallback and state the tested matrix. Never infer safe native paths from `webkitRelativePath` or similar fields.

## PWA and Offline Behavior

A service worker may cache static shell assets for fast loading, but offline shell availability is not remote-control availability. Clearly distinguish:

- companion assets available offline;
- target not discoverable;
- signaling unavailable;
- authenticated transport unavailable;
- cached stale state shown only as stale/non-actionable.

Do not cache passwords, grants, live snapshots, private media, or transfer bodies in Cache Storage by default. On deploy, version caches and remove obsolete entries without trapping users on an incompatible protocol bundle.

## Browser Capability Detection

Detect and explain required features such as:

- secure context/WebCrypto/IndexedDB;
- RTCPeerConnection, RTCDataChannel, SCTP maximum size, and media APIs;
- File/Blob slicing and directory picker profile;
- service worker or WebTransport only when used.

Feature presence is not runtime qualification. Test actual channel setup, background recovery, file selection, and media behavior in each supported browser/device.

## Deployment Freshness

Stamp builds with a non-secret version/commit identifier. Qualification should verify:

- fetched public asset content/digest matches the intended build;
- service worker is not serving an obsolete incompatible bundle;
- companion protocol major matches the installed native app;
- public site reaches the actual installed host and applies a real action;
- no development URL, bootstrap credential, source artifact, or user data entered the deployment.

Wait for observable application readiness such as `Discoverable` and a successful initial snapshot—not merely a daemon health response or allocated session record—before starting connection latency measurements.

## Multi-Tab Behavior

Choose and test a policy:

- independent tabs each authenticate and receive separate grants;
- one leader tab owns the transport and shares safe state through a browser channel;
- newer tab replaces older tab deterministically.

Do not share secrets through `localStorage` events. A leader-election mechanism must recover from frozen/discarded leaders and cannot be the only authority for grant ownership.
