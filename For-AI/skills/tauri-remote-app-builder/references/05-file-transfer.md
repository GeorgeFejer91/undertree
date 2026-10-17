# Transactional File Transfer

Use this reference for browser-to-native uploads, native-to-browser downloads, batch imports, resumability, integrity, and transfer performance.

## Security and Product Boundary

File transfer is a privileged product operation, not a generic remote filesystem API. A remote principal receives a specific scope such as `library.upload` or `export.download`; Rust determines destination, naming, parsing, publication, and download eligibility.

Never accept an absolute native path from the browser. Treat browser relative paths, filenames, MIME types, sizes, and metadata as untrusted display hints.

## Separate Bulk From Control

Put manifests, finalization, outcomes, cancellation, and safe progress summaries on the reliable control lane. Put raw bytes on a dedicated reliable ordered binary lane. Keep:

- a small control backlog;
- independent bulk backpressure;
- bounded in-flight chunks;
- control scheduling opportunities between bulk bursts;
- receiver acknowledgements tied to transfer/file/offset or chunk index.

Base64-in-JSON is acceptable only for a tightly bounded compatibility path. It expands data, allocates extra copies, and burdens JSON parsing. Negotiate the binary capability and retain compatibility only for the declared rolling-version window.

## Transaction State Machine

```text
declared -> receiving -> file_verified -> file_committed -> batch_committed
                    \-> rejected/aborted/expired
```

Recommended operations:

1. `begin`: declare random transfer ID, file count, total bytes, and every file's random file ID, relative display path, exact size, optional media type, and digest algorithm.
2. `chunk`: supply transfer/file identity and exact offset or chunk index; bytes travel on bulk.
3. `finish_file`: supply expected digest and immutable metadata needed for finalization.
4. `commit`: close the batch and return all committed results.
5. `abort`: discard only incomplete staging state.

The receiver owns truth. It rejects undeclared IDs, duplicate/conflicting manifests, offsets other than the next expected position (unless a resumable range profile is used), bytes beyond the declared size, post-finalization chunks, and expired or wrong-grant operations.

## Binary Frame

A simple frame can use:

```text
magic/version | metadata length | canonical bounded metadata | raw bytes
```

Metadata binds:

- frame protocol/version;
- grant and peer/principal context;
- authority generation;
- command/sequence ID;
- transfer ID and file ID;
- offset and payload length;
- optional chunk digest/flags.

Validate total frame length before allocating or parsing. Enforce a small metadata ceiling, fatal UTF-8 decoding, exact fields, safe integers, negotiated SCTP message size, and configured payload maximum. Do not trust channel identity alone: bind every frame to the authenticated grant.

## Browser Sender

- Keep the actual `<input type="file">` element alive through the `change` handler; replacing/re-rendering it during the same event can invalidate `File` objects or automation handles in some browsers.
- Filter for usability, then let Rust validate content.
- Use `Blob.slice()` to read bounded chunks; do not call `arrayBuffer()` on the entire multi-gigabyte file merely to transfer it.
- A whole-file WebCrypto digest may still require a full buffer because the standard API does not expose incremental hashing. For large files, use a reviewed incremental implementation/worker, native helper, or protocol that computes the authoritative digest while Rust streams bytes and compares a separately produced browser digest when feasible.
- Respect negotiated channel maximum and application watermarks.
- Bound the acknowledgement window. On first receiver rejection, stop new sends, settle/cancel pending work, surface the exact safe stage, and request abort.
- Treat browser closure/freeze as expected; never rely on unload to complete or abort.

## Rust Receiver

For each transfer:

- create a private application-owned staging directory with restrictive permissions;
- sanitize display names and choose destination paths from Rust policy;
- create new staging files without following attacker-controlled links;
- enforce per-file, per-batch, concurrent-transfer, disk-space, and account/device quotas;
- stream chunks to the expected offset while updating the authoritative incremental digest;
- bound idle and total transfer lifetimes;
- flush/sync according to durability requirements;
- parse/validate the exact staged bytes after size and digest match;
- atomically move or copy-and-verify into the managed destination according to same-filesystem/platform semantics;
- commit the domain/database record transactionally;
- publish a new authority revision only after the item is usable.

Never hold the main authority lock during disk I/O, hashing, metadata parsing, or sidecar recognition. Use a generation-bound transfer owner and send a small commit message back to the authority.

## Incremental Publication

For a multi-file batch, finalize and publish each completed file before later files finish when the product can safely preserve partial success. This improves time-to-first-use and recovery.

Define batch semantics explicitly:

- completed files remain committed after later failure/abort;
- incomplete staging is removed on abort, expiry, restart, or quota rejection;
- the final batch outcome lists committed and failed/skipped files;
- retries create a new transfer or resume only through the specified resumable profile.

Do not report “100% uploaded” before the receiver has verified, finalized, persisted, and acknowledged the final product outcome.

## Resumability

Do not call a transfer resumable because a browser retries a request. A true resumable profile needs:

- stable random transfer identity and authenticated resume secret/proof;
- persisted manifest, principal/grant lineage, expiry, and committed status;
- authoritative received ranges or next offset;
- immutable file size and digest binding;
- conflict rules when source bytes changed;
- quota and cleanup for abandoned state;
- restart recovery and concurrent-resume exclusion;
- final digest verification over one staged byte sequence.

Chunk hashes can identify corruption earlier; the final full-file digest remains mandatory. For very large files, a Merkle/chunk-manifest profile may support sparse resume, but it adds canonicalization and storage complexity and needs its own version.

## Downloads

Expose downloads by stable product object ID, never native path. Reauthorize the caller and object on every request. Support bounded range reads when needed, set a safe content disposition/filename, prevent MIME sniffing, and stream without buffering the complete file.

If privacy requires the hosted companion to control but not retrieve originals, do not add a download scope merely because the local loopback UI has one. Test the public route is denied.

For integrity-sensitive downloads, provide the committed digest/size in authenticated metadata and verify byte equality in qualification.

## Post-Processing and Sidecars

Publish the primary product object before optional enrichment when enrichment is not required for validity. Queue enrichment with bounded concurrency and timeout. Store provider-derived fields alongside—not over—source/user metadata. Use explicit `pending`, `recognized`, `no_match`, `unavailable`, and `error` states when that distinction helps retry/support.

For an external helper:

- pin and verify the artifact and version;
- retain license/source notices and maintain process separation where licensing requires it;
- pass only the minimum staged/committed input;
- set stdin, bounded stdout/stderr, deadline, kill-on-drop, and safe argument construction;
- validate every response field and length;
- make helper failure non-fatal to the already committed file unless the product contract says otherwise.

## Progress and Errors

Report receiver stages, not just sender bytes:

```text
connecting -> authorized -> declared -> receiving N/M -> verifying -> finalizing -> published -> complete
```

Include safe byte counts, file index, and transfer ID/correlation ID. A CLI or automated browser must race final success against visible/structured receiver errors, so a first-chunk storage failure appears immediately rather than as a final timeout.

## Qualification

At minimum prove:

- password/role/scope denial before any bytes are accepted;
- declared limits, exact offsets, duplicate/reordered frames, malformed header, oversized frame;
- receiver failure on the first, middle, and final operations;
- source-to-committed/download digest and byte equality;
- immediate first-file publication during a later-file transfer;
- cleanup of incomplete state and persistence of completed items;
- restart/resume behavior matching the advertised profile;
- 64 MiB repeated transfers plus a 1 GiB soak when large files are promised;
- bounded browser buffers, Rust memory/RSS, disk staging, CPU, and queue depth;
- p50/p95/p99 control acknowledgements while bulk is saturated;
- real file and folder selection on supported browser/OS combinations;
- installed/public companion path, not only an internal test page.
