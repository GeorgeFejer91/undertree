---
name: tauri-browser-remote-control
description: Architect, build, secure, optimize, test, and ship Rust/Tauri applications with a separately hosted browser or phone companion that remotely controls one local Rust authority. Use for typed remote commands, revisioned state synchronization, password pairing, revocable 24-hour trusted-browser access, WebRTC/WSS/WebTransport selection, live media, transactional file transfer, supervised background availability, or end-to-end remote qualification. Do not use for generic Tauri work without remote browser access, ordinary websites, generic remote desktop, arbitrary input forwarding, or safety-critical control.
---

# Tauri Browser Remote Control

Build remote access into the application's domain boundary, not as a generic tunnel bolted onto its UI. Keep one Rust authority for local UI, CLI, Tauri commands, and remote browser actions. Treat the hosted browser companion as an untrusted, separately deployed client.

## Start Here

1. Read repository instructions and preserve unrelated work.
2. Inspect pinned Rust, Tauri, frontend, WebView, signaling, and transport versions.
3. State the target platforms, browser matrix, reachability goal, remote roles, data classes, and whether remote availability is manual or supervised.
4. Read [references/00-system-contract.md](references/00-system-contract.md), then use the routing table below. For a new or migrated app, also read [references/13-tauri-application-foundation.md](references/13-tauri-application-foundation.md) before selecting the remote topology.
5. Write the application profile and threat model before transport code.
6. Implement one narrow vertical slice: authenticate, request one typed action, apply it through the Rust authority, acknowledge it, and publish the resulting authoritative state.
7. Add separate media or bulk-transfer lanes only after the control slice passes.
8. Run the qualification ladder in [references/10-qualification.md](references/10-qualification.md). Never substitute mocks, compilation, screenshots, or an API health flag for a real browser-to-native result.

## Non-Negotiable Invariants

- Rust owns authorization, product state, filesystem/process/network authority, side effects, revisions, grants, and revocation.
- Every frontend and remote request maps to a closed, typed product action. Expose no generic shell, SQL, path, URL fetch, DOM, keyboard, mouse, script, or arbitrary Tauri-command proxy.
- The target applies commands. A controller never declares success; it waits for an `applied` or `rejected` response tied to its command ID and observes the resulting revision.
- Keep authority generation separate from transport connection generation. Restarting signaling must not silently rotate product authority; rotating authority must invalidate grants, dedupe entries, transfers, and stale peers.
- Separate traffic by semantics: reliable ordered control, replaceable newest-state/intent when useful, and reliable ordered binary bulk transfer with independent backpressure. Do not send file bytes through the control queue.
- A signaling room, stream ID, peer ID, transport password, TLS/WebRTC connection, or successful discovery is routing evidence, not application authorization.
- Use a reviewed PAKE such as OPAQUE, SPAKE2, or SPAKE2+ for a human-memorable password. BRSP mutual HMAC is suitable only for a generated high-entropy invitation secret. Do not invent a password proof from PBKDF2/HMAC alone and call it password-safe.
- A 24-hour remembered browser credential is revocable authorization, not the password. Prefer a per-device non-extractable WebCrypto key plus a Rust record; bind proofs to nonce, origin/session context, scope, authority generation, expiry, and device ID. A bearer-token fallback must be labeled weaker.
- Bind grants to principal, peer, role, scopes, authority generation, and expiry. Enforce them again in Rust for every action and transfer operation.
- The hosted companion contains static application assets only. It must not host user files, media, catalogs, passwords, tokens, databases, private signaling state, or a privileged proxy.
- Remote availability never implies activation of the controlled function. An always-ready beacon may be supervised only after explicit local installation/enablement; beacon recovery must not start playback, execution, or another consequential action.
- Bound every message, queue, retry, timeout, collection, log, process output, transfer, and concurrency pool. Redact secrets and user data.
- Report direct, relayed, and unknown routes honestly. A successful WebRTC connection is not proof of a direct peer-to-peer route.

## Architecture Default

Use this baseline unless measured product constraints justify another design:

```text
hosted HTTPS companion (static)
        |
        | discovery + authenticated transport setup
        v
signaling / STUN / TURN ---------- optional WSS fallback
        |
        v
browser peer == control lane + state lane + bulk lane + optional media
        |
        v
packaged host adapter (Tauri WebView, dedicated Chromium, or native Rust WebRTC)
        |
        | authenticated loopback/native IPC
        v
single Rust authority actor/service
        |
        +-- typed reducers and repositories
        +-- transactional staging and persistence
        +-- Tauri commands, local UI, and CLI adapters
```

Prefer a static companion sharing the product's existing frontend build where practical. Do not grant remote web content direct Tauri capabilities merely to avoid designing the application protocol. On Linux or any platform whose system WebView cannot satisfy the WebRTC/browser feature matrix, keep Rust authoritative and use a qualified dedicated Chromium host or a native Rust transport adapter.

## Build Sequence

### 1. Define the Application Profile

Specify protocol/version, roles, scopes, action variants, state schema, revision rules, errors, limits, availability mode, and privacy boundary. Start from [assets/starter/contracts/application-profile.example.json](https://github.com/GeorgeFejer91/tauri-browser-remote-control/blob/5ab8fc5f9a1c0b8c7f1e98c958b0216959e16438/assets/starter/contracts/application-profile.example.json), then make the application's schema authoritative in both Rust and browser tests.

### 2. Establish One Authority

Model product actions and state in a pure Rust core. Serialize calls through a bounded owner/actor when ordering matters. Local UI, CLI, Tauri IPC, and remote adapters call the same service methods. Never mirror independent mutable truth in JavaScript.

### 3. Implement Authentication Before Features

Separate discovery, password authentication, session-key derivation, authorization, transport encryption, and remembered-device access. Rate-limit online attempts, rotate nonces, use constant-time verification where applicable, and make password change revoke all device records and active grants. Follow [references/03-authentication-and-devices.md](references/03-authentication-and-devices.md).

### 4. Synchronize Commands and State

Namespace command dedupe by `(authority_generation, principal_id, command_id)` and store a request fingerprint with the result. A duplicate with the same fingerprint returns the prior result; a reused ID with different bytes is rejected. Use monotonic revisions, snapshot recovery, stale filtering, and timeline anchors for time-varying state. Follow [references/02-protocol-and-state.md](references/02-protocol-and-state.md).

### 5. Select and Isolate Transports

Use WSS when a reachable service is acceptable and operational simplicity wins. Use WebRTC DataChannels for browser-to-local peer paths through NAT; provision TURN and expose route status. Treat WebTransport as browser-to-server transport and only as an optional LAN/VPN/publicly reachable fast path unless reachability has been proved. Follow [references/04-transport-and-reachability.md](references/04-transport-and-reachability.md).

### 6. Add Transactional File Transfer

Declare a manifest, stage privately, require exact offsets, enforce limits, stream bounded binary chunks, hash the exact staged bytes, finalize each file atomically, publish completed files incrementally, and preserve completed files if a later file fails. Add resumability only with persistent transfer identity, received-range truth, digest binding, expiry, and quota policy. Follow [references/05-file-transfer.md](references/05-file-transfer.md).

### 7. Make Lifecycle Explicit

Model idle, discovering, authenticating, control-ready, media-ready, degraded, reconnecting, revoked, and closed separately. Mobile pages can freeze or disappear without cleanup events. Reconcile from an authoritative snapshot after resume. Supervise only the host process that should persist, with bounded restart behavior and exact process ownership. Follow [references/08-lifecycle-and-supervision.md](references/08-lifecycle-and-supervision.md).

### 8. Qualify the Installed Path

Test wrong passwords, stale generations, duplicate/reordered messages, grant expiry/revocation, reconnects, direct and relayed routes, saturated bulk transfer with concurrent controls, receiver-side failures, browser lifecycle, packaged/installed binaries, public hosted assets, and physical supported devices. Rebuild the exact bytes under test. Follow [references/10-qualification.md](references/10-qualification.md).

## Security Pause Points

Stop and get explicit user direction before introducing any of these beyond the requested product scope:

- remote shell, generic filesystem browsing, arbitrary URL fetching, raw input injection, screen scraping, or remote desktop;
- public exposure of a loopback/native API;
- remote Tauri capabilities or privileged remote WebView content;
- a relay, signaling service, custom public endpoint, account system, or persistent cloud data store;
- background startup, auto-login availability, firewall changes, UPnP/port forwarding, or a system service;
- bearer credentials in browser storage when a proof-of-possession design is feasible;
- signing, publishing, release creation, production deployment, or secret-bearing CI changes.

## Reference Routing

| Need | Read |
|---|---|
| Invariants, terminology, scope | [00-system-contract.md](references/00-system-contract.md) |
| Topology and authority ownership | [01-architecture-and-authority.md](references/01-architecture-and-authority.md) |
| Envelopes, commands, revisions, dedupe, leases | [02-protocol-and-state.md](references/02-protocol-and-state.md) |
| Passwords, PAKE, grants, 24-hour browser access | [03-authentication-and-devices.md](references/03-authentication-and-devices.md) |
| WebRTC, WSS, VDO.Ninja, TURN, WebTransport | [04-transport-and-reachability.md](references/04-transport-and-reachability.md) |
| Upload/download, integrity, resumption, scheduling | [05-file-transfer.md](references/05-file-transfer.md) |
| Rust core, Tauri IPC, capabilities, loopback adapters | [06-tauri-and-rust-integration.md](references/06-tauri-and-rust-integration.md) |
| Static/PWA companion and browser behavior | [07-hosted-browser-companion.md](references/07-hosted-browser-companion.md) |
| Sleep/wake, reconnect, service supervision | [08-lifecycle-and-supervision.md](references/08-lifecycle-and-supervision.md) |
| Latency budgets, backpressure, measurements | [09-performance-and-operations.md](references/09-performance-and-operations.md) |
| Test matrix and completion gate | [10-qualification.md](references/10-qualification.md) |
| Defect-to-rule lessons from Zuradio | [11-zuradio-lessons.md](references/11-zuradio-lessons.md) |
| Source snapshots and current primary references | [12-sources-and-provenance.md](references/12-sources-and-provenance.md) |
| Creating/migrating the underlying Tauri application | [13-tauri-application-foundation.md](references/13-tauri-application-foundation.md) |

## Reusable Materials

For experiment remote viewers hosted in recorder tabs, read [experiment-remote-panels.md](references/experiment-remote-panels.md) for Remote Panel/1 descriptors, stable controller paths, opaque-frame compatibility, desktop-to-phone mirroring and link/QR registration. Preserve each target's authentication and action authority.


- `assets/starter/`: transport-neutral contracts plus tested Rust/browser authority scaffolds. They intentionally omit PAKE internals and transport vendor credentials.
- `assets/templates/`: application profile, threat model, architecture decision, repository instructions, and qualification-gate templates.
- `scripts/scaffold_remote_control.py`: copies the starter materials into an empty target without overwriting files.
- `scripts/check_repository.py`: validates this skill's metadata, links, JSON contracts, and starter structure.

Adapt the materials to pinned project versions. They are a secure starting boundary, not proof that an application is production-ready.

## Completion Report

Report:

```text
Architecture: authority owner, host adapter, companion origin, transport/routes
Security: password protocol, device credential form, scopes, revocation, residual risk
Changed: protocol/core/adapters/companion/supervision/deployment files
Passed: exact commands, test counts, browsers/devices, direct/relay results, latency/throughput
Not run: explicit platform/network/release gaps
Evidence: artifact hashes, installed path/version, public URL and observed user outcome
```

Never describe a design as secure, direct, low-latency, cross-platform, resumable, or production-ready without corresponding evidence.
