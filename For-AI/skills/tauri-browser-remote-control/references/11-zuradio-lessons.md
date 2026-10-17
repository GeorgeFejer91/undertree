# Zuradio Defect-to-Rule Ledger

This reference converts observed Zuradio development failures and successful remedies into reusable rules. The rules are durable; Zuradio's exact product values and benchmark results are case-study evidence only.

## Authority and Shell

| Observation | Durable rule |
|---|---|
| Local UI, CLI, remote control, uploads, and playback could diverge if each owned state. | Keep one Rust authority and route every adapter through the same typed domain service. |
| Linux WebKitGTK packages did not reliably provide the required WebRTC feature despite configuration intent. | Qualify the exact packaged WebView. Permit a dedicated Chromium or native Rust transport adapter without moving authority out of Rust. |
| A browser host was needed for Web Audio/WebRTC but should not own the catalog/player. | Treat browser processes as replaceable I/O adapters; use generation-bound authenticated local IPC. |
| A stale host window could compete with a newer instance. | Make target ownership explicit and deterministic; replace stale hosts and invalidate their callbacks/grants. |

## Static Companion and Privacy

| Observation | Durable rule |
|---|---|
| GitHub Pages can host the companion but cannot host the Rust service or private catalog. | Publish static product assets only; stream explicitly authorized runtime data from the native authority. |
| An invitation URL could leak durable access material through logs/history/sharing. | Keep passwords/tokens/private routes out of URLs; use password/device proof and fresh private coordinates. |
| Browser-side routes and peer IDs looked identity-like. | Treat provider room, stream, UUID, and successful connection as routing—not authorization. |

## Passwords, Grants, and Trusted Browsers

| Observation | Durable rule |
|---|---|
| A password-derived deterministic room simplified discovery but exposed a guessing/correlation surface. | Isolate discovery from authorization and use a standardized PAKE for human passwords. Derive fresh private routes after proof. |
| One authenticated browser could enter listen/control/upload modes. | Issue mode/scope-specific Rust grants; switching roles must reauthorize and must not inherit broader powers. |
| Users wanted 24-hour reconnect without retyping a password. | Store a revocable device authorization, preferably bound to a non-extractable browser key; hard-expire and revoke on password/security generation changes. |
| Restarted broadcasts left old grants conceptually dangerous. | Bind every grant and transfer to authority/auth generation and reject stale generations in Rust. |

Zuradio's shipped MVP used domain-separated password derivation/HMAC and a 24-hour browser bearer credential. That implementation supplied useful product evidence but retains offline-guessing and same-origin bearer risks. The mega-skill therefore upgrades the general recommendation: human-password deployments should use a reviewed PAKE and proof-of-possession device key where supported.

## Commands and State

| Observation | Durable rule |
|---|---|
| Ordered DataChannel messages entered asynchronous handlers that could resolve out of order. | Serialize control receive/application explicitly; transport ordering does not order asynchronous side effects. |
| A send call or HTTP success could be mistaken for applied state. | Return an authority-generated `applied` outcome with revision, then publish the authoritative state. |
| Reconnect/retry risked duplicate side effects. | Deduplicate by authority generation, principal, command ID, and exact request fingerprint. |
| Rapid seek/volume/progress traffic could flood reliable control. | Keep discrete commands reliable; send replaceable semantic intent/state on a newest-only lane with leases and reconciliation. |
| Local and remote controls could fight. | Put bounded local-priority arbitration and deadman leases inside the Rust authority. |
| Playback positions drifted when treated as repeated static values. | Publish timeline anchors and let clients interpolate, then reconcile periodically. |

## File Transfer

| Observation | Durable rule |
|---|---|
| 8 KiB base64 JSON chunks worked but were slow and allocation-heavy. | Negotiate a dedicated ordered binary lane; keep bounded JSON/base64 only for rolling compatibility. |
| File bytes shared control machinery. | Isolate bulk data from small commands and acknowledgements with separate buffers and scheduling. |
| Whole-file browser buffers delayed progress and increased memory. | Read bounded `Blob.slice` chunks and bound in-flight receiver acknowledgements. |
| A browser can reject too-large SCTP messages or accumulate queued bytes. | Cap payload below negotiated `RTCSctpTransport.maxMessageSize` and use `bufferedAmount` high/low watermarks plus close/error timeouts. |
| Larger 128 KiB frames slightly increased throughput but dramatically increased control p95 in one benchmark. | Optimize control latency under saturated throughput, not bulk throughput alone; begin around 64 KiB or smaller and measure. |
| Batch completion delayed usefulness. | Verify, atomically finalize, catalog, and publish each completed file before later files finish. |
| Failure on the first receiver chunk appeared to an external CLI as a late generic timeout. | Race final success with structured receiver errors and display the last acknowledged receiver stage immediately. |
| Partial transfer cleanup could delete useful completed work. | Keep committed files; remove only incomplete staging on abort, expiry, disconnect, or restart. |
| Browser file/folder picker handles became unreliable after a rerender replaced the input. | Keep the actual input and `File` objects alive through the selection event; reset only after transfer ownership is established. |

## Optional Recognition/Enrichment

| Observation | Durable rule |
|---|---|
| Acoustic recognition could delay import if placed inline. | Publish the validated file first, then run optional enrichment through a bounded queue and deadline. |
| Provider metadata could overwrite embedded/user metadata. | Store provider fields alongside source and user fields; define precedence and search behavior explicitly. |
| Helper availability and no-match/failure were ambiguous. | Persist explicit pending/recognized/no-match/unavailable/error states with retry policy. |
| SongRec's GPL boundary differed from the MIT application. | Keep independently licensed functionality in a verified process boundary, retain notices, and pass only minimum data. |
| Unbounded subprocess output or hanging helper could exhaust the service. | Capture stdout/stderr concurrently with byte ceilings, timeout, kill-on-drop, strict JSON/field validation, and bounded workers. |

## Availability and Supervision

| Observation | Durable rule |
|---|---|
| “Broadcast on” conflated discovery availability with playback. | A remote-access beacon may be ready without activating product behavior; represent discovery, control, media, and playback separately. |
| A host process could exit while the Rust daemon stayed healthy. | Supervise the host separately when app-lifetime availability is promised and surface adapter readiness to the authority/UI. |
| Provider reconnect exhaustion could leave a dead session presented as active. | Escalate permanent transport failure to the owner; rotate the transport/session and revoke stale peers. |
| Restart testing with broad process matching could kill unrelated work. | Resolve the supervisor-owned exact PID/process, terminate only it, and prove replacement with a distinct instance. |
| Automatic recovery could accidentally mutate player state. | Prove session/epoch replacement while unrelated authority state remains byte/field equivalent. |
| Users still need a real off switch. | Define and test the complete deliberate-off state, such as stopping both authority and host services. |

## Verification Discipline

| Observation | Durable rule |
|---|---|
| Existing release binaries and `dist` assets could be stale. | Rebuild current optimized native and production browser bytes inside the gate. |
| A Rust session record existed before the browser host was actually discoverable. | Start readiness/latency assertions from observable top-layer readiness, not internal allocation. |
| An installed always-on beacon using the same password interfered with isolated tests. | Generate isolated passwords/routes/profiles/ports and explicitly separate installed from test authorities. |
| Unit/API checks passed while browser/native paths could still fail. | Require a real browser to authenticate, apply an action, observe revision/state, and exercise the installed/public path. |
| A Tauri fallback compiled while the qualified Chromium path carried WebRTC. | Name which runtime was exercised; compiling another adapter is not equivalent evidence. |
| Installed public-path automation needed to inspect the dedicated Chromium host. | Keep inspection disabled by default; enable it only through a scoped qualification/support path, bind it explicitly to loopback, and use unconditional cleanup to restart without it and verify closure. |
| A real installed-path gate deliberately changed playback while proving control. | Snapshot affected product state and restore it from unconditional cleanup, including after failed assertions; verify the restoration. |
| Desktop automation left physical-phone, forced-TURN, endurance, or platform gaps. | Keep unrun matrix entries visible and narrow release claims; never silently waive the gate. |

## Case-Study Measurements

The audited 2026-09-02 Zuradio working tree recorded:

- vendor binary-channel microbenchmark near 14.9 MB/s for repeated 64 MiB runs;
- browser WebRTC near 12.8 MB/s with 64 KiB frames and much better control latency than 128 KiB frames;
- a complete staged two-file transfer with byte-exact authenticated download and incremental publication;
- 22 browser scenarios across Chromium plus Firefox/WebKit compatibility profiles;
- installed public-companion command acknowledgements well below the product's 2 s hard ceiling in the recorded runs;
- supervised host replacement in roughly four seconds and separate beacon recovery without changing player state.

These measurements were taken on one evolving Linux setup, some from uncommitted working-tree qualification records. They justify the rules and future test shapes, not universal performance promises. Physical-phone, restrictive-network/forced-TURN, long endurance, and 1 GiB soak evidence remained open in the audited material.
