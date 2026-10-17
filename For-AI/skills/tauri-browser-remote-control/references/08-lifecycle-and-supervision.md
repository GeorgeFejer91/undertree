# Lifecycle and Supervision

Use this reference for start/stop, reconnect, stale callbacks, app/window semantics, background availability, and service supervision.

## Explicit State Machine

Model at least:

```text
off
starting
discoverable
authenticating
control_ready
degraded
reconnecting
rotating
stopping
failed
```

Track media-ready and bulk-ready independently. Make transitions idempotent and generation-guarded. A `start` during `starting` returns the same operation; a `stop` waits for/invalidates in-flight start; callbacks from an old generation are ignored.

## Startup Is a Bounded Protocol

For each component, define:

- process/socket creation;
- handshake and authentication;
- transport/discovery announcement;
- authority snapshot readiness;
- user-visible ready condition;
- timeout and safe cleanup.

A process PID, open TCP port, `/health` response, allocated session, or signaling connection is not proof that a remote browser can control the app. Readiness is the highest layer the product promises.

## Shutdown and Rotation

A security rotation should:

1. stop admitting new work;
2. invalidate authority/auth generation as required;
3. revoke grants and leases;
4. reject/cancel pending commands;
5. abort incomplete transfers while preserving committed products;
6. stop media tracks and close data channels/peers;
7. remove listeners/timers and disconnect signaling;
8. clear bootstrap/session secrets;
9. publish a safe local status;
10. start a fresh beacon only if the declared availability mode requires it.

Do not rely on browser unload for revocation or cleanup.

## Transport Recovery

Differentiate:

- transient signaling loss while peer channels remain healthy;
- peer connection interruption;
- ICE failure/restart;
- adapter reconnect exhaustion;
- host process failure;
- Rust authority restart;
- password/security rotation.

A transport retry increments transport generation. It may preserve domain state and authority generation. An authority restart/rotation invalidates all grants and requires reauthentication. When an SDK reports permanent reconnect failure, notify the owning supervisor/coordinator; do not leave a green “broadcasting” flag over a dead announcement.

## Window and App Lifecycle

Choose whether closing the last window:

- quits everything;
- hides the UI while the authority/host remains;
- exits the host but keeps the daemon;
- is replaced by a supervisor.

Implement the choice; platform defaults are not a product contract. Prevent duplicate host windows/processes and define stale-host replacement.

## Always-Ready Beacon

An app-lifetime or supervised beacon is safe only when:

- the user explicitly enabled that availability mode during installation/settings;
- discovery remains password/device protected;
- no playback, execution, capture, transfer, or other consequence starts with beacon activation;
- grants are still role/scope limited;
- secure restart rotates routes/grants without mutating unrelated product state;
- a clear deliberate-off path exists;
- local UI shows actual discoverability and connected principals;
- service and app updates preserve revocation semantics.

“Always ready” means access can be attempted, not that the controlled feature is armed.

## Service Supervision

When using systemd user services, launch agents, scheduled tasks, or platform services:

- split authority daemon and browser host only when their lifecycle needs differ;
- express ordering/dependency explicitly;
- use bounded restart delay/backoff and avoid hot crash loops;
- use process-group/job-object semantics so children do not orphan;
- run as the least-privileged user, never elevate merely for convenience;
- keep environment/config/credential file permissions narrow;
- log bounded safe metadata without bootstrap/password tokens;
- make enable/disable/uninstall behavior deterministic;
- define update coordination so mixed protocol versions fail safely.

On Linux, a user service can require the authority service and restart the host adapter. Platform equivalents need independent qualification rather than assuming systemd semantics.

## Supervision Qualification

Resolve the supervisor-owned exact process identity and terminate only that process. Prove:

- it is replaced by a different live PID/process instance within the recovery ceiling;
- authority health and unrelated product state remain correct;
- a fresh transport/session epoch becomes genuinely discoverable;
- stale grants/host callbacks cannot control the authority;
- a public companion reconnects and applies/observes a real operation;
- stopping the complete documented service set leaves the product deliberately off;
- re-enabling restores the intended mode.

Never use broad process-kill patterns for this test.

## Browser Resume and Pending Work

When a browser resumes:

1. invalidate old transport callbacks;
2. fail or mark pending command outcomes unknown;
3. reconnect with bounded backoff;
4. authenticate through the device/password policy;
5. request a full snapshot;
6. compare authority generation and revision;
7. restore only safe local view state;
8. require a new gesture for operations whose intent may no longer be current.

For a retry-safe command whose outcome is unknown, resend the exact request with the same command ID only after the protocol is ready. The authority dedupe record decides whether to reapply.

## Failure Reporting

Expose distinct safe states for:

- target off/not discoverable;
- authentication denied/expired/revoked;
- route unavailable/direct-only rejected;
- control lost while media continues or vice versa;
- host adapter crashed/recovering;
- authority restarted;
- transfer interrupted or receiver rejected;
- unsupported browser/WebView.

Avoid infinite spinners and “connected” labels based on a lower layer than the promised function.
