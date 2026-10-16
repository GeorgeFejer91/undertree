# Realtime editing and automatic GitHub synchronization

Research checked 2026-10-16. User requirements: fast automatic synchronization,
no disruption to writing, and a future path to multiple simultaneous authors.
This is an evidence-backed design recommendation; no runtime implementation or
live repository mutation was made during this investigation.

## Recommendation

Use two independent paths: responsive local document operations and background
Git checkpoints. First complete automatic bidirectional Git synchronization in
the Rust authority. Later add an authenticated collaborative document session
that exchanges operations directly; its checkpoint writer publishes ordinary
source files to GitHub. Git HEAD must never become the live document version.

```text
CodeMirror edits -> local document operations -> Rust persistence/acknowledgement
                            |                              |
                    future collaboration          saved immutable snapshots
                    operations over WSS                    |
                            |                       background Git worker
                      other authors                        |
                                                        GitHub
```

GitHub remains useful durable project storage and history. A Git push publishes
a commit; it does not deliver uncommitted typing from another person's editor.
The public Overleaf source and current GitHub-sync documentation establish the
same separation between live operations and repository synchronization.

## What Overleaf actually does

The pinned public baseline is `e039ad26c5bf5422eb57b89fc7e57c75055e631d`.
Source inspection shows:

1. The editor applies local changes immediately, composes pending operations,
   and allows one operation batch in flight. Its delayed flush is armed once
   per batch rather than restarted by every character. See
   [ShareJS client](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/js/vendor/libs/sharejs.js#L1350).
2. The ShareJS document sends `applyOtUpdate` with a base version; configured
   flush delays are 2,000 ms initially and 500 ms after a remote operation.
   Acknowledgements, pending/in-flight state and reconnect handling are explicit.
   These delays are code settings, not measured end-to-end latency. See
   [document client](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/js/features/ide-react/editor/share-js-doc.ts#L61).
3. The realtime service checks edit authorization and queues operations for the
   document updater. The ShareJS server transforms an older operation against
   intervening operations, checks duplicate sources and increments the document
   version. Applied operations return through Redis and `otUpdateApplied`; the
   sender receives an acknowledgement while collaborators receive the operation.
   See [ingestion](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/real-time/app/js/WebsocketController.js#L498),
   [transformation](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/document-updater/app/js/sharejs/server/model.js#L135)
   and [broadcast](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/real-time/app/js/DocumentUpdaterController.js#L43).
4. Overleaf's documented GitHub integration requires explicit push/pull actions;
   edits are bundled into commits when synchronization is requested. It is not
   the live editing transport. See [Overleaf GitHub synchronization](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/github-synchronization).

The browser investigation used REA CLI 6.5.0, with no MCP registration changes or
native decompiler installation. Its declared scenario opened a public read-only
University of Virginia workshop project and waited; it did not edit the project.
Evidence `ev_57015e337624d0a81d5a9bb5465b0a762d19c99ecb2afab25f30477f154aa78e`
records Chromium 155.0.8059.79, the editor page, first-party script requests and
owned-browser cleanup. The page declared release
`34719aedf5879f42769a2c2dc8c0e83f858a1e84`; this is page metadata, not independent
server artifact authentication. No WebSocket traffic appeared before capture
ended, and fourteen requests were unfinished. This capture does not prove edit
delivery, server internals, write authorization, persistence or latency.

The exact CDN URLs recorded in that capture supplied shipped client assets.
Static byte inspection of `6200-6c03d261e4daf7495fba.js`, SHA-256
`1cf0798d2e33b26a9923eab19e8291276b8e32a9fdea519c49ab20c55dee95da`,
corroborates `applyOtUpdate`, `otUpdateApplied`, pending/in-flight operations,
the 2,000/500 ms flush settings and the once-armed flush timer. This identifies
code present in the shipped bundle, not execution of those branches. Other OT
implementations and feature variants present in the bundle were not exhaustively
traced. Raw evidence and byte ranges live under ignored
`artifacts/reverse-engineering/overleaf-github-sync-20261016/`; those files do not
travel with a fresh clone.

The focused REA static analysis of that delivered editor chunk returned
`provider_timeout` at its selected 60,000 ms parsing deadline. Retained partial
Evidence `ev_597bd3210e35509abb816adb84bf2d97003b9c9701e1fd01e28d0a0a2c789001`
binds the asset inventory but declares incomplete graph coverage; 35 other
inventoried files were outside the selected analysis. No complete call graph is
claimed. The timeout response, extracted partial Evidence and concise result
index are retained beside the browser capture. The readable public-source trace
and separately identified shipped byte ranges establish the protocol findings.

## What UnderTree already has, and what is missing

The inspected checkout was dirty at HEAD
`cf00d8c063f9db2958b9d96ea41fbb3757289a29`. Per-file digests and copies identify
the inspected bytes in `source-identities.json`; HEAD alone does not identify
this working tree or the installed application.

| Source observation | Consequence |
| --- | --- |
| `src/manuscript.js`: 450 ms trailing local-save timer; `queueSync` uses another 4 s trailing timer | Roughly 4.45 s after typing stops before sync can start, plus processing/network time. Continued edits can postpone either timer indefinitely. |
| Scheduling lives in the WebView; enabling autoSync only persists its preference | No autonomous native startup/resume queue or reliable worker independent of frontend timers. |
| Every sync exception adds the project to `pausedSync` | Temporary network/busy failures can stop automation until manual intervention. |
| The 2 s `review` refresh reads the local authority, not GitHub | It does not discover remote commits. No independent inbound polling/subscriber was found. |
| `service.rs::sync_remote` can fast-forward a clean project, but returns only head/message | No changed-path/revision event is delivered to open editor sessions. |
| `ReviewSession.refresh` treats differing content as a conflict, even in a previously clean buffer | A pull cannot yet update the open editor smoothly. |
| One global sync lock; checkpoint construction holds the document mutex through Git commands | Faster scheduling alone can cause cross-project busy errors and obstruct saves. |

Preserve the current safeguards: explicit repository/root/branch identity;
existing Git credentials; exact saved-byte and source-epoch ownership; alternate
index checkpointing; refusal of unrelated/staged changes; compare-and-swap branch
updates; exact commit pushes; remote confirmation; and preservation of newer saves
while a push runs. Never force-push, silently retarget origin or discard buffers.
The earlier 2026-10-15 live receipt qualifies its named build only; its explicit
incoming Sync call does not establish automatic incoming synchronization.

## First implementation: unobtrusive automatic Git sync

- Add one app-owned coordinator in `modules/review/`. Wake it after acknowledged
  local saves, connection/autoSync enablement, startup and network recovery.
  Keep one running job and one coalesced follow-up per project, with fair bounded
  scheduling. Reuse the existing checkpoint/push implementation.
- Keep the current local save behavior and add a bounded maximum wait for
  eligible snapshots during continuous typing. Initial tuning targets: publish
  about 1-2 seconds after a confirmed save when quiet; attempt a checkpoint
  within 10 seconds during continuous editing. These are proposed scheduling
  values, conditional on a valid saved snapshot and connectivity, not promises
  of GitHub confirmation within that time.
- Capture immutable owned bytes/revisions briefly, then perform slow Git work
  outside the document lock. Revalidate identities and compare-and-swap before
  publication. Sync must never make local saving wait for a network round trip.
  Keep hashing, serialization and substantial diff computation off the editor's
  rendering path; bound work queues and apply only short UI transactions.
- Discover incoming branch changes independently. The smallest first version
  can reuse native Git head checks every 5-15 seconds for active connected
  projects, with jitter, fair budgets and longer intervals while idle/offline.
  Fetch only changed heads. No-op ticks must create no commits or pushes.
- Classify failures. Busy/transient network failures retry with bounded
  exponential backoff; authentication, protected-branch rejection, unrelated
  changes and genuine divergence retain a visible actionable pause. An uncertain
  push is reconciled against the exact remote commit before retrying.
- Stage incoming revisions before touching project files. Require a fresh
  all-affected-buffer barrier: root/source epoch, base revision, pending save,
  newer edits and IME composition. Apply clean accepted changes as narrow
  CodeMirror transactions, preserving focus, selection, scroll and local undo.
  Do not recreate the editor or echo imported changes back as fresh local edits.
  Dirty/overlapping work stays intact with both versions retained. Keep current
  stop-on-divergence behavior until a separately specified merge implementation
  can prove preservation.
- Show quiet distinct states: saved locally, waiting to publish, GitHub
  confirmed, offline/queued, and remote changes needing attention. Ordinary
  progress needs no popup, focus change, spinner over the editor or modal.
  Compilation remains an independent latest-snapshot queue and retains the last
  good PDF.

This worker lasts for the app process and should continue when the window is
minimized. Work after full Quit requires an explicit keep-running/tray or
supervised-service lifecycle; no such service was installed or qualified here.

## Later implementation: multiple simultaneous authors

Introduce one operation envelope now: project/document identity, source epoch,
base/result document revisions, origin and narrow ordered changes. Saved source
digests, live operation versions and Git commit IDs are separate identities.
This lets the first implementation stay small without making Git its editor API.

For collaboration, a Rust-hosted Yrs document and a compatible CodeMirror/Yjs
binding over authenticated WSS are a credible candidate. Yrs supplies shared
text, relative positions and origin-scoped Undo; the Yjs WebSocket pattern
distributes document updates and presence. These capabilities require explicit
integration and qualification; merely adding a library supplies neither project
authorization nor measured responsiveness. Pin compatible protocol/client-ID
versions before adopting them. See [Yrs](https://docs.rs/yrs/0.28.0/yrs/) and
[Yjs WebSocket provider](https://docs.yjs.dev/ecosystem/connection-provider/y-websocket).

One logical project authority accepts permitted edits and persists operations;
local UI replicas remain optimistic. Give each participant a revocable,
project/document-scoped coauthor grant, distinct from policy administration and
the existing suggestion-only MCP/limited App capabilities. Keep the current
Rust policy and persistence boundary. A repository URL is not a room secret or
proof of edit permission. A central session endpoint avoids peer-discovery/NAT
work; whether that host is an owner's running desktop or a hosted Rust service
remains a deployment choice, with availability consequences.

Persist acknowledged collaboration state/logs independently of Git checkpoints;
plain text alone cannot reconstruct all CRDT operation identity on reconnect.
Exactly one elected/fenced checkpoint publisher writes each collaboration
project's branch; other clients must not all publish the same shared edits.
On host changes, verify the authority epoch and expected remote head. Treat
external Git commits as identified imports against the last exported base,
convert accepted text differences into document operations once, and preserve
overlap/conflict evidence. A generic file overwrite must not reset a live room.

Map review anchors through accepted operations. Current `Anchor.reconcile`
uses one common-prefix/suffix interval; disjoint edits can stale untouched
passages between them, and external digest changes stale all markers. Preserve
the conservative policy fallback while adding precise mapping. Never let a
generic merge of sidecar JSON silently delete protections. Local Undo must undo
the participant's edits while retaining collaborators' work.

## Architecture options and evidence limits

| Approach | Fit | Cost/limit |
| --- | --- | --- |
| Native Git worker and adaptive head checks | Recommended first: reuses UnderTree and existing credentials | Changes converge in seconds after saved commits; overlapping Git histories still require resolution. |
| GitHub App/webhook relay plus native worker | Faster commit discovery for many clients | Adds hosting, participant/device authorization and delivery recovery; it still cannot carry another editor's uncommitted keystrokes. |
| Collaborative document sessions plus Git checkpoints | Required for eventual simultaneous typing | Adds durable operation state, collaborative Undo, permissions, anchor mapping and room lifecycle. Build on the same document boundary later. |

If a webhook relay is added, validate signatures, repository/branch selection
and delivery IDs, queue processing and reconcile the actual current branch head.
GitHub does not automatically redeliver failed webhooks, so startup/reconnect
and periodic reconciliation remain necessary. See [webhook practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)
and [failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries).

Avoid a REST Contents write for every keystroke. GitHub documents primary and
secondary limits, serial mutation guidance, backoff and authenticated conditional
GETs. Those REST limits are not numeric limits on UnderTree's current native Git
push transport. Native Git still needs a measured traffic/CPU budget and backoff.
See [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
and [API practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).

## Acceptance cases before claiming completion

1. Type continuously through slow/offline sync and saturated compilation. Compare
   input-to-render p50/p95/p99 with autosync disabled; verify no lost/repeated
   text, focus/scroll jumps or unbounded queues. Record hardware and load.
2. Confirm local-save acknowledgements, commit publication and verified remote
   visibility separately. Exercise continuous typing, enablement, startup with
   durable pending work, minimize/restore and reconnect; no-op periods do no work.
3. Deliver incoming commits while the editor is clean, dirty, composing text,
   saving, inactive and switched to another document. Verify narrow updates,
   selection/undo preservation, retained versions and correct preview staleness.
4. Exercise offline retry, Git busy, two projects, concurrent external commits,
   changed origins/roots/epochs, protected branches, revoked credentials and lost
   push acknowledgements. Explicit Sync must complete or report its own outcome.
5. For collaboration, use two real clients with simultaneous same-position
   inserts/deletes, Unicode/UTF-16 positions, IME, local Undo, offline edits,
   duplicated/reordered updates, reconnect and checkpoint-writer handover.
   Verify convergence, authorization/revocation, anchors/protection, crash
   recovery and absence of duplicate imported commits/checkpoints.

Research gate: VERIFIED for the cited source/docs, read-only REA browser capture
and shipped byte ranges, within their stated boundaries. REA static graph gate:
PARTIAL because of the recorded parser timeout. Runtime changes: NOT RUN. Current
GitHub latency, native minimized behavior and multiuser collaboration: NOT RUN.
The proposed timings are tuning targets, not benchmark results.
