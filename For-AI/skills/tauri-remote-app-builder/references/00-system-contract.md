# System Contract

Use this reference before making architectural or security decisions. It defines the vocabulary and minimum contract shared by every implementation profile in this skill.

## Product Boundary

The product is a native application with a separately loaded browser companion. The browser may request named application operations and receive explicitly published application state. It is not a general remote desktop, remote shell, filesystem browser, or Tauri IPC bridge.

The native Rust process is the authority even when browser APIs or a WebView terminate WebRTC. A browser host is an adapter: it authenticates transport messages to a Rust-owned session and forwards closed protocol objects. It does not become the business-state owner.

## Normative Language

- **MUST**: required to claim this architecture or security property.
- **SHOULD**: default unless a documented, tested reason overrides it.
- **MAY**: optional profile behavior.

## Principals and Identifiers

- **authority generation**: random identity for one Rust authority lifetime or deliberate security rotation.
- **transport generation**: identity for one signaling/peer-connection attempt. It may change without changing authority.
- **principal**: authenticated human/device identity known to Rust.
- **device record**: Rust-owned remembered-browser authorization record.
- **peer ID**: transport endpoint identifier. It is never identity by itself.
- **grant**: short-lived authorization bound to principal, peer, role, scopes, generation, and expiry.
- **command ID**: controller-generated idempotency key unique within a principal and authority generation.
- **revision**: monotonically increasing authority-state version.
- **transfer ID/file ID**: opaque random IDs within a grant, never paths.

Never overload one value across these roles. In particular, do not use a room name as a grant, a transport peer UUID as a user identity, or a playback revision as a session generation.

## Trust Boundaries

Treat all of the following as untrusted until a narrower boundary proves otherwise:

- hosted JavaScript and every dependency or service worker at its origin;
- browser storage, messages, paths, filenames, MIME types, and metadata;
- signaling, STUN, TURN, relays, room listings, transport labels, and peer display names;
- Tauri WebView input and command arguments;
- loopback HTTP/WebSocket callers, including other local processes and web pages;
- sidecar stdout/stderr and third-party response data;
- remote clocks and claimed revisions;
- stale callbacks from a previous browser, WebView, peer, or authority generation.

Transport encryption protects bytes in transit. It does not authorize a product operation.

## Required Separation of Concerns

Keep these layers explicit:

1. **Discovery** finds a possible target.
2. **Transport** carries bytes and reports route/liveness.
3. **Authentication** proves possession of password-derived or device-held key material.
4. **Authorization** issues and checks roles/scopes.
5. **Protocol** defines bounded typed messages and replay/idempotency rules.
6. **Authority** validates and applies product actions.
7. **Presentation** renders projected state and optimistic intent.

A success at an earlier layer must not imply success at a later one.

## Traffic Classes

| Class | Delivery semantics | Examples | Rule |
|---|---|---|---|
| Control | reliable, ordered, bounded | command, applied, snapshot request, auth transition | never starve behind files/media |
| Authoritative state | latest useful value; snapshot-recoverable | player/device status, catalog generation | revisions beat arrival order |
| Live intent | replaceable, often unordered/no retry | slider drag, pointer-like semantic value | lease/deadman and local priority |
| Bulk | reliable, ordered binary with backpressure | upload/download chunks | separate lane, transaction, digest |
| Media | media transport semantics | audio/video track | readiness separate from control |

Do not use one unlimited queue for all classes. If an implementation has only one physical connection, it must still isolate scheduling and buffering logically.

## Authority Invariants

- Only the authority assigns revisions and final results.
- Every consequential request is authorized at application time, not only at connection time.
- Remote and local commands pass through the same domain validation and mutation logic.
- A state publication reflects committed authority state, not merely a requested value.
- A snapshot is sufficient to recover after missed deltas or reconnect.
- Unknown fields, message types, action variants, roles, and scopes fail closed for the negotiated major protocol version.
- Errors are stable, bounded, non-secret codes plus safe display text. Internal causes remain in redacted local diagnostics.

## Availability Modes

Choose one and state it in the application profile:

- **manual session**: a local gesture starts remote discovery; stop rotates authority and closes access.
- **app-lifetime beacon**: remote discovery remains ready while the app is running; activation does not execute product actions.
- **supervised login service**: explicit installation/enablement keeps a host adapter ready during the user session. Stopping the declared service set is the deliberate off state.

Never drift from manual consent to background availability as an incidental implementation detail.

## Privacy Contract

List what may cross each boundary. A typical static companion may receive a bounded public projection of catalog/status data and a live stream only while authorized. It must not receive native paths, secrets, unrestricted logs, databases, or undeclared file contents.

For each data class, record:

- owner and source of truth;
- allowed roles/scopes;
- transport and retention;
- size/rate limit;
- whether it may appear in logs;
- deletion/revocation behavior.

## Unsupported Claims

Do not claim any of the following from architecture alone:

- **secure** without an exact threat model and negative tests;
- **password-safe** from hashing or transport encryption alone;
- **direct** without selected ICE-pair/relay evidence;
- **cross-platform** without target runtime tests;
- **low latency** without workload percentiles;
- **resumable** without restart/range/digest tests;
- **always ready** from a process-running flag;
- **production ready** from unit tests or a release build.
