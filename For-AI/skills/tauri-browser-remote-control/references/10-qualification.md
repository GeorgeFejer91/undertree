# Qualification and Completion Gate

Use this reference before claiming a remote-enabled Tauri application is complete. Tailor exact commands to the repository, but do not remove evidence categories that the feature relies on.

## Evidence Ladder

### 1. Contract and pure-core tests

- Rust action/state serialization and validation;
- browser/Rust fixture compatibility and canonical transcript vectors;
- authorization matrix for every role/scope/action;
- reducer invariants, revision monotonicity, expected-revision behavior;
- dedupe same-request replay and changed-request ID collision;
- sequence wrap/reorder/stale-generation behavior;
- message/frame size, depth, count, numeric, and unknown-field rejection;
- transfer manifest/offset/digest/finalization/recovery tests;
- no secrets or native paths in public DTOs/errors.

### 2. Adapter tests

- Tauri command registration, exact argument names, typed errors, capability allow/deny;
- transport lane labels/options, backpressure, stale callbacks, stop/start idempotence;
- signaling/route parsing and direct/relay/unknown reporting;
- loopback host/origin/token/body limits and cross-origin/rebinding attempts;
- sidecar startup, version, malformed output, timeout, crash, cancellation, bounded logs;
- browser lifecycle listener cleanup and reconnect generation.

Mocks prove adapter logic, not native runtime or browser interoperability.

### 3. Authentication tests

- official PAKE implementation vectors and browser/Rust interoperability;
- wrong password, replayed/reflected transcript, nonce reuse, malformed groups/keys;
- online attempt limits and recovery;
- role/scope downgrade and escalation denial;
- 24-hour device enrollment, nonce proof, hard expiry, session expiry, clock edges;
- revoke one/all, password change, authority restart, stolen old token/key proof;
- same device requesting changed scope/target/generation;
- bearer fallback labeled and independently tested if supported.

### 4. Real browser-to-authority vertical slice

Launch the actual native authority and browser host. From the intended companion build:

1. discover and authenticate;
2. receive the initial snapshot;
3. issue one product action;
4. observe its `applied` result and new authority revision;
5. verify the native/local UI or physical effect;
6. reconnect and reconcile.

Run supported Chromium, Firefox, and WebKit/Safari profiles where the transport supports them. Test phone-width rendering, keyboard/touch, rotation, background/foreground, and physical devices. Browser-engine emulation is not proof of native WebView or physical mobile behavior.

### 5. File-transfer gate

Rebuild current optimized native and production web bytes. Then prove:

- real file and folder selection plus no-supported-file behavior;
- dedicated binary lane negotiation/observation and bounded compatibility fallback;
- first/middle/final receiver rejection reaches browser/CLI promptly;
- staged size/offset/path/frame/parser denials;
- SHA-256 or profile digest equality from source to committed/downloaded bytes;
- first completed file becomes usable while later files transfer;
- abort/restart cleanup preserves only committed products;
- resumption only if advertised, including changed source and expired transfer;
- repeated medium transfers and promised maximum/1 GiB soak;
- control acknowledgements remain inside ceiling during saturation;
- browser buffers, Rust memory/RSS/CPU, queues, and disk remain bounded.

Retain machine-readable artifacts with route, bytes, times, percentiles, versions, and resource peaks.

### 6. Network and lifecycle matrix

- same LAN and separate NATs;
- forced TURN/relay and strict-direct rejection;
- restrictive network, DNS/TLS/signaling failure;
- IPv4/IPv6 and VPN where supported;
- sleep/wake, browser freeze/discard, network handoff, offline/online;
- peer close, signaling reconnect exhaustion, stale host replacement;
- authority restart, transport-only restart, password rotation;
- multiple observers/controllers according to product policy;
- long-running/endurance behavior and reconnect storms.

### 7. Packaged and installed app

Test the exact built artifact, not only `tauri dev` or a loose binary:

- frontend asset/version freshness and production CSP;
- WebView/browser API availability;
- capability schemas and absence of test/debug permissions;
- loopback/private profile/bootstrap behavior;
- sidecars/resources/service files and executable permissions;
- install, cold launch, window close/background behavior, update/rollback, uninstall;
- signed/notarized behavior where promised.

If a dedicated Chromium host is the qualified adapter, exercise it; a Tauri fallback compile is not equivalent.

### 8. Public companion gate

Fetch the public HTTPS companion, verify its intended build, and connect it to the real installed app. Wait for actual host readiness, then prove authentication, snapshot, one control action/outcome, and any promised media/transfer behavior. Confirm the static host contains no user data or secrets.

Before issuing consequential actions against an installed user profile, snapshot the affected product state. Restore it from a `finally`/unconditional cleanup path even when an assertion fails, then verify the restoration. Prefer a disposable profile where that still exercises the real installed route.

Service-worker caches must not mask an obsolete build. Browser inspection must be disabled in the ordinary launcher. If the gate temporarily enables an endpoint, bind it explicitly to loopback, never a LAN or public interface; unconditional cleanup must disable it, restart the normal host if necessary, and verify the endpoint is closed.

### 9. Supervision gate

For background availability:

- verify declared services/startup items enabled and active;
- resolve and terminate only the exact supervisor-owned host PID/process;
- observe replacement with a distinct live instance within the ceiling;
- force beacon/session loss and observe a fresh genuinely discoverable epoch;
- prove unrelated authority/product state did not change;
- repeat the public companion control/stream check;
- stop the full declared service set and prove the deliberate-off state;
- restore and recheck.

## Latency and Throughput Evidence

Set project-specific ceilings. Record p50/p95/p99 and worst case for:

- cold connection and trusted reconnect;
- command acknowledgement idle and during bulk/media;
- first snapshot and first usable file;
- beacon/host recovery;
- upload/download throughput.

Measure from observable user readiness. Starting a timer before the host has actually announced itself conflates startup with connection and can hide a readiness bug; waiting on a backend flag can omit the failing browser adapter. Record both stages when both matter.

## Required Security Scenarios

- unauthenticated/wrong-role/wrong-scope operations;
- stale grant after revoke, expiry, restart, and password change;
- replayed command and changed-body reuse;
- malformed/oversized messages and binary frames;
- arbitrary path/URL/action/field attempts;
- hostile origin and local-process loopback requests;
- secret absence from URLs, logs, public assets, browser storage (except documented credential), and errors;
- remote availability without unintended activation;
- partial transfer and disk-full/quota behavior;
- transport provider/relay outage.

## Freshness and Reproducibility

- build the exact optimized Rust and production web bytes inside the gate;
- use lockfiles and record compiler/package/browser versions;
- hash important artifacts and public assets;
- isolate test data, app profile, password, rooms, ports, and device records;
- do not let an installed always-ready beacon compete with an isolated test authority;
- retain sanitized logs, traces, screenshots/video only where useful, and benchmark JSON;
- clean up processes, profiles, ports, test device records, and staging directories;
- restore any pre-existing user/product state changed by installed-path qualification, including on failure.

An existing `target/release` binary or `dist` directory is not freshness evidence.

## Completion Rule

A task is complete only when all relevant required gates pass. If a physical device, platform, restrictive network, relay, signing, 1 GiB soak, or endurance run is unavailable, report it as **not run/open** and narrow the claim. Do not waive it because lower-level checks pass.

Use this final format:

```text
Changed:
Passed:
Measured:
Installed/public evidence:
Not run:
Pre-existing failures:
Residual risk:
```
