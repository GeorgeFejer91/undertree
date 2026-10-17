# Tauri and Rust Integration

Use this reference to connect the protocol to an idiomatic Rust core, Tauri v2 shell, local browser host, persistence, and sidecars.

## Crate and Module Boundaries

A durable layout is:

```text
crates/app-domain/          actions, state, reducers, errors
crates/app-service/         authority actor, grants, transfers, repositories
crates/remote-protocol/     DTOs, validation, framing, transport traits
src-tauri/                  Tauri setup, commands, capabilities, platform adapters
web/                        local shell + static companion entries
```

The exact project can be smaller, but dependencies should point inward: Tauri and transport vendors depend on the domain, never the reverse.

## Rust Authority Pattern

Use a bounded async mailbox or carefully scoped mutex around a single owner. Each request supplies an `AuthenticatedContext` rather than raw token strings deep in the domain.

```rust
struct AuthenticatedContext {
    principal_id: PrincipalId,
    grant_id: GrantId,
    role: Role,
    scopes: ScopeSet,
    authority_generation: Generation,
}
```

The service validates the context, calls a closed action reducer/service, persists if needed, increments the revision, stores the dedupe outcome, and emits a public projection. Keep secrets in redacting types and never derive authorization from a frontend-provided role alone.

Use `Result` and stable application errors. Avoid `unwrap`/`expect` on runtime input, lock acquisition, network, files, sidecar output, or serialization.

## Tauri IPC Choice

- **commands**: request/response product operations and initial snapshots;
- **channels**: ordered streaming/progress from Rust to a WebView;
- **events**: small notifications or multi-consumer signals where no reply is required;
- **managed state**: handles/services, not an excuse for one giant lock.

Tauri events are asynchronous JSON notifications and can be observed/applied out of the order expected by naive callbacks. Do not use them as the sole ordering or acknowledgement mechanism for consequential state transitions. Tauri channels are the better streaming primitive.

Keep a typed frontend wrapper around command names and DTOs. Validate again in Rust. For large binary input, use the current Tauri raw IPC/channel facilities or a Rust-owned stream/file path instead of serializing large arrays into JSON.

## Capabilities and Permissions

For every native operation:

1. identify exact windows/WebViews and platforms;
2. expose a product command, not a generic primitive;
3. enable only required permissions;
4. narrow plugin scopes to exact paths/URLs/programs;
5. enforce application-defined scope inside Rust where Tauri does not do so automatically;
6. test allowed and denied cases against generated schemas.

Capabilities assigned to the same window/WebView merge their permissions. Review the union. By default, registered application commands can be broadly reachable unless explicitly restricted through the current application manifest/permission model.

Avoid remote URL capabilities for the hosted companion. If explicitly required, pin exact HTTPS origins and understand platform-specific iframe/top-level limitations before granting any command.

## CSP and Navigation

- use a restrictive production CSP with only required `connect-src`, media, worker, and asset origins;
- avoid `unsafe-eval`, wildcard sources, arbitrary remote navigation, and third-party scripts;
- open untrusted links through a validated system-browser operation;
- prevent privileged windows from navigating to untrusted content;
- test development and packaged CSP separately.

Anything bundled into or reachable by a WebView is not a secret.

## Browser Host and Loopback

If Tauri's system WebView supports the exact required WebRTC/media/file behavior, it can host the adapter. Verify the packaged runtime on each target; a generic browser test is insufficient.

If it does not, use a dedicated browser process or native transport adapter while keeping Rust authoritative. A dedicated Chromium launcher should:

- select a known compatible executable without executing an arbitrary path from remote input;
- use a private product profile and keep debugging/inspection disabled in ordinary launches;
- enable bounded inspection only through an explicit test/support path, bind it to loopback (for example, `127.0.0.1`) rather than a LAN or public interface, and use unconditional cleanup to remove the flag, restart normally, and verify the port closed;
- pass a high-entropy loopback bootstrap without logging it;
- retain the child handle and distinguish window close, process crash, and app shutdown;
- cleanly stop or let a declared supervisor restart it;
- ship/install it only under a documented dependency and license policy.

An embedded loopback server must bind only loopback, authenticate every privileged route, validate host/origin/body limits, and isolate browser bootstrap, CLI, and remote-session credentials. Prefer Tauri's default custom protocol for ordinary app assets; the official localhost plugin explicitly carries considerable security risk.

## Browser File Pickers

Keep file input ownership stable during selection. A framework render triggered synchronously by `change` can replace the input before the browser/automation finishes attaching selected files. Read the `FileList`, retain required `File` references, update state, and clear/reset only after the event and transfer state have safely advanced.

Test file and folder pickers in real Chromium, Firefox, and WebKit-compatible paths where supported. Framework component tests do not prove native picker lifecycle.

## Persistence and Secrets

- non-secret settings: typed versioned store;
- structured product data: Rust-owned SQLite/repository with migrations;
- passwords/device private material: OS credential store or reviewed vault where appropriate;
- device public keys/grant records: Rust-owned database with expiry/revocation indexes;
- transfer staging: private app-data directory with startup cleanup/recovery.

Do not store secrets in the ordinary frontend settings store. Browser device private keys stay in WebCrypto/IndexedDB when using the proof-of-possession profile; Rust stores only the public key and authorization record.

## Sidecars

Prefer in-process Rust when mature and compatible. Use a sidecar for isolation, licensing boundaries, existing tools, or unavailable native functionality.

- package one verified artifact per target;
- permit exact executable and fixed argument grammar;
- avoid secrets in argv;
- define bounded framing, timeout, cancellation, output capture, and restart behavior;
- consume stdout/stderr concurrently to avoid deadlock;
- bind local socket/HTTP IPC with a per-launch secret;
- test absent, wrong-version, malformed, slow, crashed, and unlicensed/unpackaged cases.

Optional post-processing must not delay authoritative publication unless it is a documented validity prerequisite.

## Concurrency and Blocking Work

- never hold authority/database locks across network, filesystem, hashing, decoding, subprocess, or `.await` boundaries;
- use `spawn_blocking` for genuinely blocking work, not merely an `async fn` wrapper;
- bound transfer and helper queues;
- carry cancellation and captured generations into workers;
- discard stale results rather than committing after authority/session replacement;
- use one documented lock order and explicit poisoned-lock policy.

## Packaging and Release

Build every supported platform natively or through a documented supported path. Verify exact frontend assets, Rust binary, sidecars, service units, capability schemas, installer, and public companion version. Sign/notarize where required, keep update ownership singular, and promote only already-tested artifacts.

Installed runtime evidence is mandatory for remote features because development servers hide asset, CSP, bootstrap, process, service, and WebView differences.
