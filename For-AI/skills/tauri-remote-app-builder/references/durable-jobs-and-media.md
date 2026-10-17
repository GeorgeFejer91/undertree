# Durable Jobs, Queues, and Media Processing

Read this reference only when the product runs durable background jobs, maintains a user-visible queue, or turns uploaded content into derived outputs. Also read the file-transfer, persistence, process/sidecar, performance, and qualification references selected by the actual implementation.

## Authority and Lifecycle

The same Rust authority that owns product state owns the durable job state machine. Use explicit states such as `draft`, `queued`, `starting`, `running`, `pause_requested`, `paused`, `cancel_requested`, `succeeded`, `failed`, and `cancelled`; define allowed transitions and make terminal states immutable except through a typed retry/clone operation. Persist the requested operation, validated input object IDs, configuration, priority/order key, processor identity and version, timestamps, bounded progress, retry count, terminal result, and safe error code.

Decide before implementation whether jobs may continue after every Tauri window closes or after the app process exits. If they must, choose and review a user-session daemon/service as the single authority. Do not let the Tauri process and a worker daemon each believe they own the queue.

Use bounded worker concurrency, bounded pending work, cancellation tokens, deadlines where meaningful, and explicit resource admission. A pause or cancel acknowledgement means the authority accepted the request; publish a second transition when the worker actually reaches a safe point. Define what happens to non-interruptible processor calls and partially written output.

## Upload-to-Job Ownership

Remote clients never enqueue native paths. A completed upload produces an opaque, authority-owned content object ID only after declared length and digest verification plus atomic publication. Enqueueing then either:

1. consumes that object ID in a separate idempotent action with a job/configuration precondition; or
2. is part of one documented upload-and-enqueue transaction whose final acknowledgement names both committed IDs.

Define compensation: an uploaded object that is never enqueued becomes an orphan with a retention deadline; a failed enqueue does not expose a partial job; cancelling an upload cannot delete an object already committed to another job. Cleanup uses Rust-owned references and deadlines, never browser-supplied paths. Test acknowledgement loss at the commit boundary with the same transfer and command IDs.

## Concurrency and Preconditions

Do not guard every edit with a high-churn global revision when progress updates continuously. Keep the authority generation and global revision for convergence, then use target-specific preconditions where contention differs:

- job configuration version for edits, retry, remove, and cancellation;
- queue-order version or stable neighbor IDs for reorder and priority changes;
- transfer ID, exact offset, length, and digest for upload resumption;
- processor/configuration fingerprint before reusing cached outputs.

Serialize final transitions inside the authority. State whether priority is strict, weighted, or advisory; how equal-priority jobs are ordered; and whether a running job can be preempted. Return an authoritative conflict with enough safe state to refresh, not an automatic last-writer-wins guess.

## Crash Recovery and Outputs

On startup, reconcile durable jobs with actual worker/process state. Mark abandoned `starting` or `running` attempts as interrupted, then apply the declared retry/manual-recovery policy. Persist retry backoff and cap it. Never launch duplicate work merely because a UI reconnects.

Write output to private staging, fsync where the durability claim requires it, validate expected output, and atomically publish the final object. Record the processor binary/library identity, version, selected codec/model/backend, relevant configuration fingerprint, and output digest. Remove staging artifacts only after checking ownership and live references. Apply disk quotas to uploads, working data, cached results, logs, and final outputs separately; reserve enough space for worst-case expansion before accepting work.

If a sidecar performs processing, use fixed executable and argument templates, piped/bounded I/O, child ownership, cancellation, timeout, exit-code mapping, and sanitized diagnostics. Never turn job configuration into arbitrary argv, environment variables, shell text, URLs, or output paths.

## Complete Control Surfaces

Register queue queries, job-detail queries, progress subscriptions, add/edit/reorder/pause/resume/cancel/retry/remove actions, uploads/downloads, and pagination in the application profile. The Tauri UI, local CLI, remote CLI, and paired browser expose the same ordinary product semantics even when their input adapters differ—for example, a native picker and a browser file input both become an opaque staged object followed by the same enqueue action.

For large queues, use bounded pages and a consistent cursor/snapshot version. A reconnect obtains a bounded snapshot or page anchor and then resumes ordered/coalesced changes. Progress may be coalesced or sampled; terminal transitions and command outcomes remain reliable. The CLI uses a documented JSON-lines streaming mode rather than polling decorative human output.

Remote start/stop, initial trust enrollment, OS permission grants, and reveal-in-file-manager may be explicit local-only administrative exceptions. Missing queue or job controls are not exceptions.

## Interface Expectations

Show queue order, job state, useful progress, input/output identity, and the next available action without dashboard ornament. Provide keyboard and touch alternatives to drag reorder. Distinguish request pending, request accepted, worker transition pending, stale/reconnecting, retry scheduled, and terminal failure. Do not announce 100% before atomic publication succeeds. Preserve useful cached rows during recovery and label their freshness.

## Qualification

Test at least:

- transition-table allow/deny cases and target-version conflicts;
- concurrent enqueue/reorder/edit/progress updates through multiple adapters;
- duplicate command and upload-finalize retries with acknowledgement loss;
- crash/restart during staging, processing, finalization, and cleanup;
- cancel and pause at supported safe points plus non-interruptible behavior;
- worker, queue, memory, CPU, file-descriptor, and disk-pressure limits;
- malformed/corrupt inputs and hostile processor output;
- browser and CLI parity for queries, subscriptions, pagination, transfers, and every action;
- packaged sidecar discovery, signatures/permissions, codec/model licenses, and hardware acceleration on each claimed platform;
- control latency while uploads and processing saturate their allowed resources.

Pause for the user before selecting a licensed/proprietary codec, model, cloud processor, public relay, background service, new data-retention policy, or destructive cleanup/migration. Report processor/platform combinations not exercised as `Not run`.
