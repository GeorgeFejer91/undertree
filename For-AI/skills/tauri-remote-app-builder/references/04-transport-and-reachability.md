# Transport and Reachability

Use this reference to select WebRTC, WSS, VDO.Ninja, native Rust WebRTC, or WebTransport and to define route claims.

## Choose From Product Constraints

| Requirement | Default candidate | Tradeoff |
|---|---|---|
| Publicly reachable owned service is acceptable | authenticated WSS | simplest stateful operations; server carries traffic |
| Browser must reach a laptop behind NAT without port forwarding | WebRTC DataChannels with STUN/TURN | signaling and ICE complexity; relay may be required |
| Live browser media plus application data | WebRTC media + separate DataChannels | browser-friendly; host adapter/runtime must support it |
| LAN/VPN/publicly routable native endpoint fast path | WebTransport | browser-to-server; no ICE hole punching |
| Existing VDO.Ninja discovery/media infrastructure | pinned Ninja SDK adapter | vendor lifecycle/labels/events must remain outside protocol core |
| Rust should terminate the peer path | maintained Rust WebRTC stack | strongest native ownership; largest integration/interop burden |

Do not choose from a headline throughput number. Measure connection success, route type, control latency under load, memory, CPU, recovery, and operational cost on target networks.

## WebRTC DataChannels

WebRTC data channels use SCTP over DTLS over ICE transport. A profile can create multiple channels with different semantics:

```text
app.control.v1  ordered + reliable       small commands and outcomes
app.state.v1    unordered + maxRetransmits=0 (optional) newest state/intent
app.bulk.v1     ordered + reliable       binary file frames
```

Use fixed versioned labels and reject unknown privileged channels. Opening both control and state should be an atomic readiness condition if both are required. Bulk can negotiate later.

Before sending binary data:

- wait for `open`;
- set `binaryType = "arraybuffer"`;
- inspect `pc.sctp.maxMessageSize` after SCTP is connected;
- reserve framing overhead and keep a conservative configured ceiling;
- catch synchronous `send` errors and asynchronous channel errors;
- use `bufferedAmount`, `bufferedAmountLowThreshold`, close/error listeners, and a timeout for backpressure;
- bound application in-flight acknowledgements as well as browser buffer bytes.

The WebRTC specification throws when data exceeds the negotiated maximum and may reject queuing when buffers are full. “The browser accepted `send()`” is not a receiver acknowledgement.

## ICE, STUN, and TURN

STUN helps discover candidate addresses. ICE selects a candidate pair. TURN relays traffic when a direct path cannot be established. Restrictive NAT/firewall networks make relay a normal requirement, not an exceptional bug.

Expose route as:

- `direct` only when selected-candidate evidence proves a host/srflx path per the adapter's definition;
- `relay` when TURN/relay is selected;
- `unknown` when the stack cannot prove it.

A strict-direct mode must reject a relay route and explain the reachability failure. It must not silently downgrade while continuing to display “direct.” A practical default mode should permit TURN and explain privacy/cost implications.

Test at least same LAN, different ordinary NATs, forced TURN, restrictive network failure, IPv4/IPv6 where supported, VPN, network handoff, sleep/wake, and signaling outage.

## VDO.Ninja Adapter

When using the Ninja SDK:

- pin the exact SDK artifact/version and integrity metadata;
- use data-only mode when media is not needed;
- treat room listing/stream IDs/UUIDs as discovery only;
- filter expected target prefixes and require explicit choice if multiple targets appear;
- use one duplex peer connection rather than creating needless mirrored peers;
- open custom channels for the defined lane semantics;
- disable undocumented fallback paths when strict peer routing is required;
- normalize SDK channel-label prefixes deliberately;
- wrap callbacks with a transport generation and ignore stale callbacks;
- make stop/start idempotent and remove every listener/channel/timer;
- surface reconnect exhaustion to the owner so a supervised beacon can rotate cleanly;
- inspect selected-route statistics instead of trusting a connection-success event.

Keep the BRSP/application handshake above the SDK. A VDO transport password is not the application's human-password protocol.

## Native Rust WebRTC

Native termination removes the browser-host forwarding hop for bulk/control and keeps channel ownership in Rust. It also makes Rust responsible for:

- signaling message validation;
- ICE servers, candidate policy, restarts, and selected-route evidence;
- DTLS/SCTP configuration and certificates;
- DataChannel open/close/error/backpressure behavior;
- runtime/task bounds and shutdown;
- browser interoperability and mobile network lifecycle;
- relay credentials and secret rotation.

At the 2026-09-02 source check, `webrtc-rs/webrtc` v0.20.0 is the current stable line and introduced a rewritten runtime plus opt-in send backpressure. Verify the current release and API at implementation time; do not encode this snapshot as a forever pin.

## WSS

An authenticated WebSocket service is a good default when the desktop can reach an owned public service and peer-to-peer traffic is not mandatory.

- use TLS and authenticated application sessions;
- never put bearer tokens in the URL;
- define heartbeat, idle timeout, reconnect/backoff, resume/snapshot behavior, and server limits;
- partition tenants/targets and authorize every routed message;
- bound server and client queues;
- stream bulk data separately or schedule it so control is not starved;
- define data retention and operator access because the service can observe traffic unless application-layer encryption is added.

## WebTransport

The W3C WebTransport API is browser-to-server over WebTransport-capable HTTP. It provides streams and datagrams but does not supply ICE/STUN/TURN NAT traversal or browser-to-browser discovery.

Use it as an optional fast path when the Rust endpoint is reachable through LAN, VPN, reverse tunnel, or public routing and certificate/origin requirements are satisfied. Race it against a universal path only with bounded resource use; cancel the loser and preserve one authenticated authority session. Always retain a tested fallback unless reachability is an explicit deployment prerequisite.

## Lane Scheduling

Even separate DataChannels share underlying network and SCTP resources. Large messages can increase head-of-line delay when interleaving/prioritization support differs. Prefer moderate frames and bounded bursts.

A useful initial policy to benchmark—not a universal constant—is:

- up to 64 KiB bulk payloads, capped below negotiated maximum;
- about 1 MiB browser-side high watermark and a lower resume threshold;
- a bounded window of receiver-acknowledged chunks;
- yield after a bounded byte burst;
- tiny control messages and independent application queues.

Tune with p50/p95/p99 command acknowledgements while transfer is saturated. Zuradio's case study found 128 KiB chunks slightly improved throughput but severely harmed control latency compared with 64 KiB; this is evidence to measure framing, not a guarantee for another stack.

## Transport Interface

Keep protocol code dependent on a small interface:

```text
start / stop
peer events with transport generation
send_control(bytes) -> admitted/rejected
send_latest_state(bytes) -> sent/replaced
open_bulk() -> bounded binary channel
route_quality() -> direct/relay/unknown + diagnostics
```

Adapters may reconnect internally, but they must never invent application grants or declare commands applied.
