# Architecture and Authority

Use this reference to place components, assign ownership, and choose the browser-host boundary.

## Canonical Topology

```text
static companion origin
  -> rendezvous/signaling
  -> authenticated transport lanes
  -> browser/native host adapter
  -> authenticated local boundary
  -> Rust authority actor/service
  -> domain core + repositories + devices/files/processes
```

The companion can be served by GitHub Pages or another static HTTPS host because application data travels at runtime from the native authority. Static hosting must contain no user data, passwords, grants, transfer content, database, or product relay.

## One Authority, Many Adapters

Define product-level Rust methods such as `apply_action`, `get_snapshot`, `begin_transfer`, and `revoke_device`. Then connect:

- Tauri commands from the local WebView;
- a native/local UI adapter;
- a CLI adapter;
- remote protocol messages;
- automation or OS integrations explicitly in scope.

All adapters supply an authenticated caller context and call the same domain service. Avoid parallel frontend reducers that can mutate independent truth.

Use a bounded single-owner actor when ordering, arbitration, or device state matters. The actor owns:

- authority generation and revision;
- committed domain state;
- active grants and device-record lookups;
- command dedupe/results;
- leases and local-priority windows;
- transfer transaction handles;
- subscriber fan-out.

Do not hold its lock or mailbox turn while doing blocking disk, network, hashing, decoding, or sidecar work. Stage long work outside, then commit a generation-bound result.

## Plane Separation

### Local native plane

Use narrow Tauri commands/channels or another authenticated local IPC boundary. A loopback listener is not authenticated merely because it binds `127.0.0.1`.

### Discovery plane

Advertise only enough information to establish the private authenticated session. Treat deterministic password-derived discovery names as enumerable routing hints. Keep actual control/media credentials fresh, random, independent, and short-lived.

### Control/state plane

Carry protocol envelopes. The target performs authentication, authorization, sequencing, dedupe, action validation, and state revision assignment.

### Bulk plane

Carry binary chunks independently of control. Rust owns staging, limits, path policy, digest verification, finalization, and persistence.

### Media plane

Use browser media tracks or a dedicated native media path. Control-ready and media-ready are separate states; a missing/blocked audio graph must not disable product control.

## Host Adapter Choices

| Host | Prefer when | Main obligations |
|---|---|---|
| Tauri system WebView | required browser APIs work on every target WebView | capability isolation, CSP, lifecycle, real packaged runtime tests |
| Dedicated Chromium window/process | a system WebView lacks required WebRTC/media behavior | pinned executable discovery, private profile, protected bootstrap, process supervision, packaging/license review |
| Native Rust WebRTC | Rust should terminate data channels directly | ICE/DTLS/SCTP lifecycle, browser interoperability, bounded runtime, host-native packaging |
| Sidecar service | isolation or mature non-Rust stack is justified | fixed artifact, authenticated bounded IPC, supervision, signing, license and update plan |

Do not force every platform through the same adapter. Keep the protocol and authority stable while qualifying adapters independently.

## Tauri Is a Shell, Not the Domain

Keep pure Rust crates free of `tauri::AppHandle`, WebView labels, and plugin types. Put Tauri registration, caller extraction, permission integration, and frontend-safe errors in a thin adapter crate/module.

Remote hosted pages should normally have no direct Tauri capability. If remote URL capabilities are deliberately used, restrict exact origins, windows, commands, and platforms, and account for platforms where iframe and top-level origins cannot be distinguished.

## Local Bridge Contract

If a browser host talks to Rust over loopback:

- bind loopback only;
- choose a collision-safe port or inherited socket;
- create separate high-entropy launch and session credentials;
- pass launch material through an OS-protected file descriptor, `0600` runtime file, or URL fragment removed immediately from history/DOM;
- validate `Host`, origin, method, content type, body size, and per-route authorization;
- use `HttpOnly`, `SameSite=Strict`, narrowly scoped cookies only when cookie semantics fit;
- keep CLI credentials separate from browser bootstrap credentials;
- close or rotate sessions when the host exits;
- assume any local process can probe the port.

Prefer the Tauri custom protocol for bundled assets. Tauri's localhost plugin enlarges the attack surface and is justified only by a concrete compatibility constraint.

## Authority and Transport Generations

Keep both values on every callback and long-running operation:

```text
authority_generation = changes on daemon restart, password rotation, secure access reset
transport_generation = changes on signaling/peer reconnect or host adapter replacement
```

Ignore callbacks whose captured generation is stale. A transport reconnect can preserve grants only if policy explicitly permits it and the peer re-proves possession. An authority change always invalidates active grants, dedupe state, leases, partial in-memory transfers, and old snapshots.

## Multi-Controller Policy

Choose explicitly:

- one controller with deterministic replacement;
- many observers plus one controller;
- many scoped controllers with serialized authority arbitration.

Do not let the last transport event win accidentally. Publish ownership and replacement to every affected client. A stale host adapter must visibly lose authority when a newer one replaces it.

## Decision Record

Before code, record:

- supported native platforms and exact browser/WebView matrix;
- authority and adapter processes;
- availability mode;
- static companion origin and deployment owner;
- signaling, STUN, TURN, WSS, and optional fast-path ownership;
- direct versus relay requirements;
- password and remembered-device design;
- remote roles/scopes/actions/data projections;
- lane semantics and limits;
- file/media policy;
- target latency/throughput/resource ceilings;
- release qualification and intentionally open gaps.

Start from `assets/templates/architecture-decision.md`.
