# Performance and Operations

Use this reference to set budgets, prevent cross-lane starvation, benchmark transports, and operate the remote path without weakening security.

## Measure User Outcomes

Trace complete paths:

```text
gesture -> browser validation -> transport admission -> Rust authorization
        -> authority queue -> side effect/commit -> applied response -> render
```

For connection:

```text
page usable -> discovery -> authentication -> private transport -> initial snapshot -> control ready
```

For transfer:

```text
selection -> authorization -> first byte accepted -> first file verified
          -> first product publication -> batch complete -> optional enrichment
```

Record both elapsed time and the stage that dominated it. A fast transport does not compensate for slow discovery, serialized setup, or delayed publication.

## Define Budgets Before Optimization

Each project should specify:

- cold and trusted-reconnect p50/p95/p99;
- control acknowledgement p50/p95/p99 idle and during saturated bulk/media;
- first-useful-state and first-file-publication latency;
- sustained and burst bulk throughput;
- browser `bufferedAmount`, application in-flight bytes, and queue depths;
- Rust RSS/heap, CPU, open files/tasks, disk staging, and log growth;
- reconnect and supervised recovery ceilings;
- failure/error propagation ceiling.

Use a generous hard failure timeout only as a liveness bound. Set a materially tighter latency target for normal operation.

## Priority and Backpressure

Keep independent bounded queues:

1. authentication/revocation and tiny control outcomes;
2. product commands;
3. snapshots/state;
4. bulk bytes;
5. diagnostics.

Process control between bounded bulk bursts. Limit both transport buffers and awaiting receiver acknowledgements. If a peer cannot keep up:

- coalesce replaceable state to newest;
- reject new nonessential work with `busy`;
- pause bulk sending;
- expire idle transfers;
- close a wedged peer when bounds cannot recover.

Never let “reliable” mean unbounded.

## Frame Size Is a Latency Decision

Larger frames reduce per-frame overhead but can increase head-of-line delay, allocation size, and control contention. Test at least two realistic sizes under the same route and workload.

Zuradio's 2026-09-02 prototype measured about 12.8 MB/s at 64 KiB browser WebRTC frames with control p95 around 220 ms, while 128 KiB was only about 4.8% faster but raised control p95 to roughly 1.47 s. This is a single Linux/browser/network case study, not a protocol constant. Its durable lesson is to optimize the combined throughput-plus-control objective and begin with moderate frames, bounded buffers, and frequent scheduling opportunities.

## Transport Selection Benchmark

Compare candidate paths with one harness and data set:

- current production baseline;
- vendor-SDK binary DataChannel;
- direct browser/native WebRTC if proposed;
- WSS relay/service if proposed;
- WebTransport only on its actually reachable topology;
- strict direct and forced relay where applicable.

For each record:

- exact versions, commit/build, OS, CPU, browser/WebView, network, and route;
- setup time and success rate;
- repeated transfer median and distribution, not one best run;
- control latency under saturation;
- peak buffers/RSS/CPU;
- failure and reconnect behavior;
- whether bytes terminate in JavaScript, Rust, or an intermediary.

Do not compare a Rust-to-Rust loopback microbenchmark with a browser-through-NAT production path as if they prove the same thing. Microbenchmarks identify ceilings; qualification proves the product route.

## Minimize Copies and Parsing

- keep control JSON small;
- transfer file payloads as binary, not base64 JSON;
- use `Blob.slice` and bounded buffers in the browser;
- stream in Rust while hashing the same bytes;
- avoid full payload clones when converting ownership;
- parse metadata only after outer and inner size checks;
- throttle progress publications;
- publish compact deltas only when snapshot recovery is defined.

Profile before introducing zero-copy complexity. Ownership safety and clear bounds are more valuable than theoretical copy elimination.

## Parallelize Independent Setup

Overlap only operations without ordering/security dependencies, for example:

- discovery teardown and private transport setup after authenticated route issuance;
- password KDF work and non-secret UI preparation;
- media receiver setup after control authentication while allowing control to become ready first;
- optional post-processing after a file is committed and published.

Do not parallelize command application when product ordering is required. Serialize ordered control callbacks explicitly because asynchronous handlers can reorder effects.

## Observability

Use structured events with:

- release/build ID;
- authority and transport generation in redacted/opaque form;
- operation/command/transfer correlation ID;
- safe stage, duration, byte count, queue depth, route class, and error code;
- no password, token, key, room secret, URL query, file content, full path, or private metadata.

Bound retention and local file size. Remote diagnostic upload must be opt-in with a preview.

## Operational Dependencies

Document ownership and failure policy for:

- signaling and TURN credentials/cost/capacity;
- static companion origin and deployment rollback;
- certificates/domains;
- user services and startup settings;
- sidecar/runtime packages;
- protocol compatibility across staggered updates;
- incident revocation and emergency signed update.

An external signaling or relay provider is part of availability and metadata privacy even when it cannot read encrypted application content.

## Regression Gates

Store machine-readable benchmark artifacts and compare compatible environments only. Fail CI/runtime qualification on violated product ceilings, not noisy unsupported micro-differences. Re-run after changes to:

- frame/window/watermark sizes;
- transport or WebView/browser versions;
- serialization, crypto, hashing, or persistence;
- process supervision/startup;
- service worker/static deployment;
- action/state schema size;
- media or file-transfer behavior.
