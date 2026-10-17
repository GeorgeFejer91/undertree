# Protocol and State Synchronization

Use this reference for protocol envelopes, handshakes, command semantics, state convergence, arbitration, and reconnection.

## Protocol Layers

Keep a transport-neutral protocol core. A transport adapter supplies peer-open, peer-close, reliable-control receive/send, replaceable-state receive/send, and optional bulk/media handles. Vendor room APIs and channel labels do not belong in domain action code.

Use an application profile rather than one universal action list. The profile fixes:

- protocol name and major/minor version;
- roles, scopes, capabilities, and limits;
- action and public-state schemas;
- error codes and compatibility behavior;
- lane labels and delivery semantics.

## Envelope

Every JSON control/state envelope should include these bounded fields:

```json
{
  "protocol": "example.remote",
  "version": 1,
  "type": "command",
  "authorityGeneration": "opaque-random-id",
  "senderId": "opaque-random-id",
  "senderEpoch": 1,
  "sequence": 42,
  "body": {}
}
```

Validate exact or explicitly extensible keys, UTF-8 byte length, nesting depth, collection counts, finite numbers, token syntax, and type-specific bodies before dispatch. Reject prototype-sensitive keys in JavaScript objects. Never dispatch by dynamically looking up a message-provided method name.

For signed transcripts, use a specified canonical encoding with cross-language fixtures. Ordinary `JSON.stringify` of arbitrary maps is not a cryptographic canonicalization contract.

## Handshake

A robust session progresses through explicit states:

1. transport peer opens;
2. target and controller exchange `hello` with roles, random nonces, versions, capabilities, requested/granted scopes;
3. the selected password/invitation/device protocol mutually authenticates the transcript and derives session keys;
4. target computes accepted scopes and issues a Rust-owned grant;
5. both sides exchange `ready` matching the negotiated result;
6. target sends a full authoritative snapshot;
7. control becomes ready; media/bulk may become ready independently.

Bind proof/key derivation to protocol/version, both roles, both nonces, both endpoint IDs, authority generation, requested/accepted scopes, and transport context where available. Role-domain separation prevents reflection.

## Message Families

Recommended control messages:

- `hello`, authentication-protocol frames, `ready`;
- `command`, `applied`, `rejected`;
- `snapshot_request`, `snapshot`;
- `grant_expiring`, `revoked`, `bye`, `error`;
- transfer manifest/finalize/abort messages, while bytes stay on bulk.

Recommended replaceable messages:

- `state` with revision and full/bounded projection;
- `intent` with semantic controls, sequence, lease, and optional base revision.

Unknown major versions and unknown consequential actions fail closed. Minor capability additions require explicit negotiation.

## Command Contract

A command contains:

- `commandId` from cryptographic randomness;
- required `scope`;
- closed typed `action` plus bounded arguments;
- optional `expectedRevision` for compare-and-apply behavior.

The target checks, in order:

1. envelope/version/size;
2. current authority and peer binding;
3. live grant, role, scope, and expiry;
4. replay sequence;
5. dedupe key and request fingerprint;
6. action schema and domain preconditions;
7. optional expected revision;
8. apply through the authority;
9. persist if required;
10. increment revision and return `applied`;
11. publish resulting authoritative state.

The acknowledgement is an outcome, not a transport receipt.

## Retry-Safe Deduplication

Use:

```text
dedupe key = (authority_generation, principal_id, command_id)
stored value = (canonical_semantic_request_fingerprint, final_result, final_revision, expiry)
```

- Same key and fingerprint: return the stored result without repeating the side effect. Fingerprint the scope, expected revision, and typed action/arguments; exclude replaceable transport/grant wrappers so the same authenticated principal can recover an unknown outcome after transport reconnect.
- Same key and different fingerprint: reject `command_id_reused`.
- New key: apply once and store the final result.

Bound entries by count and either retain them for the complete authority generation or define an explicit retry/dedupe lifetime after which old IDs are permanently rejected through a tombstone or generation rotation. Persist dedupe records for side effects that must survive process restarts; otherwise state the weaker guarantee. Do not silently evict and then reapply an old consequential ID. Do not dedupe only by transport sequence because reconnect resets transport state.

## Sequences and Reordering

Use unsigned counters with a defined wrap rule or generation-scoped safe integers. For 32-bit serial arithmetic, treat a value as newer only when the modular forward distance is greater than zero and less than `2^31`.

Serialize reliable control handling. Promise callbacks can otherwise apply in a different order even when DataChannel delivery was ordered. Replaceable state may drop intermediate values but must never regress the last accepted revision.

## Authoritative State

Publish a bounded public projection with:

- authority generation;
- revision;
- stable resource IDs;
- current ownership/grant status safe for that principal;
- state required to reconstruct the remote surface;
- timeline anchor if values evolve with time.

After reconnect, visibility resume, dropped-state detection, or a revision gap, request a full snapshot. Do not replay a long unbounded mutation history by default.

### Timeline anchors

For playback, timers, progress, or motion, send:

```text
value_at_anchor
anchor_monotonic_time_on_target (or target timestamp plus measured offset)
rate
paused/running state
revision
```

The browser extrapolates for display and periodically reconciles. It must not emit a command for every animation frame.

## Optimistic UI

The browser may show pending intent immediately, but it must distinguish:

- requested/pending;
- applied at revision N;
- rejected with safe reason;
- superseded by local/newer authority state;
- timed out/unknown outcome.

On timeout, retry only with the same command ID and exact request bytes or reconcile by snapshot before deciding. Never create a new ID for an operation whose first outcome is unknown unless duplicate execution is harmless.

## Local Priority and Leases

When local and remote users can manipulate the same continuous control:

- local input creates a bounded local-priority window;
- remote intent inside that window is ignored, queued as newest-only, or explicitly rejected per profile;
- remote control requires a renewable short lease/deadman;
- lease expiry returns to a safe neutral state without relying on browser unload;
- discrete commands still use reliable acknowledgement.

Define arbitration in the Rust authority, not independently in each UI.

## State Backpressure

For replaceable state, retain at most the newest unsent snapshot per peer. If the lane is buffered, overwrite the pending snapshot rather than append. A periodic full snapshot or explicit request repairs loss.

For reliable control, reject/admit based on a small backlog ceiling. Closing a wedged peer is safer than unbounded memory growth.

## Stable Errors

Use codes such as:

```text
unsupported_version
malformed_message
unauthenticated
grant_expired
scope_denied
stale_generation
stale_revision
replay_rejected
command_id_reused
busy
limit_exceeded
transfer_integrity_failed
transport_unavailable
```

Keep user-facing detail bounded and non-secret. Correlate richer local diagnostics with random operation IDs.
