# Integrated Application Blueprint

Read this reference when creating a new application, migrating an existing application into the combined architecture, or deciding which process owns authority.

## Target Shape

```text
                                  static HTTPS companion
                                           |
                               authenticated typed protocol
                                           |
local desktop UI ---- Tauri IPC ----+      |      +---- authenticated remote CLI
                                    v      v      v
local CLI -------- local IPC ----> one Rust authority/service
                                           |
                      +--------------------+--------------------+
                      |                    |                    |
                 domain reducers      repositories       bounded workers
                                                         and sidecars
```

The arrows are adapters, not separate products. The Rust authority assigns final results and revisions. Each adapter translates its environment into the same domain actions and safe projections. The browser companion is a full semantic client: after pairing, it can operate every ordinary product capability available in the installed app.

## Choose the Authority Topology

Choose one topology deliberately and record it in the architecture decision.

### Tauri-process authority

Use when the app is interactive, remote sessions are manually activated, and state need not remain available after the desktop app exits.

- Tauri initializes the service and owns its lifecycle.
- The local UI calls thin Tauri commands.
- The CLI connects to an authenticated local IPC boundary in the running process or performs explicitly safe offline operations with exclusive locking.
- The remote host adapter starts only after a local activation gesture.

### Daemon/service authority

Use when the CLI, background acquisition, scheduled work, or an explicitly enabled remote beacon must remain available without an open window.

- A Rust daemon owns state and side effects.
- Tauri and CLI are clients of a local authenticated IPC protocol.
- The remote transport adapter lives in the daemon or a supervised child with a bounded authenticated link to it.
- Window close, app exit, service stop, logout, and machine shutdown have distinct, tested semantics.

Never let the Tauri process and daemon both believe they own the same mutable product state. Never repair lifecycle ambiguity with competing JSON stores or ad hoc file writes.

## Suggested Workspace Boundaries

Adapt names to the repository, but keep dependencies pointing inward:

```text
crates/app-domain/       actions, state, projections, stable errors
crates/app-service/      authority owner, repositories, grants, workers
crates/app-protocol/     serializable envelopes, validation, versioning
crates/app-cli/          typed CLI parser and local/remote client adapters
src-tauri/               Tauri setup, commands, capabilities, platform code
web/app/                 installed local interface
web/companion/           static remote interface or shared entry point
tests/qualification/     real cross-boundary scenarios and artifacts
```

Small projects may combine crates, but vendor SDKs, Tauri, browser code, and transport choices must not flow into domain reducers.

## One Domain, Multiple Exposure Surfaces

Define the full product action set first. Then derive typed surfaces:

- `LocalAction`: every action allowed through trusted local UI after Rust validation.
- `CliAction`: scriptable local administration and product actions with stable output.
- `RemoteAction`: every remotely operable product action, with scopes and preconditions appropriate to authenticated remote principals.
- `PublicProjection`: state safe to serialize to the requested role and scope.

Do not derive remote eligibility from enum reflection, command registration, string prefixes, CLI names, or frontend routes. Match every exposed action explicitly and fail closed on unknown variants or fields.

Maintain one machine-checkable operation registry derived from the Rust domain. Include actions, queries, subscriptions/progress, pagination, and transactional upload/download workflows. Its policy is full semantic parity across Tauri UI, local CLI, remote CLI, and browser companion. Catalogue an operation outside that shared registry only when remote execution would defeat a deliberate trust, consent, physical-presence, OS-permission, or safety boundary. Record its typed local bindings and exact reason; do not use a vague category to hide unfinished companion work.

For each action define:

- required role and scope;
- arguments and size/range validation;
- whether an expected revision or target precondition is required;
- idempotency or duplicate semantics;
- cancellation and timeout behavior;
- safe result and error shape;
- audit/redaction policy;
- local, CLI, and remote availability.

## Required State and Retry Semantics

Use distinct identities for authority generation, transport generation, principal, device, peer, grant, command, revision, and transfer. A consequential command carries a stable command ID. Cache its fingerprinted outcome within a bounded dedupe policy so an acknowledgement-loss retry cannot repeat the effect.

The controller does not declare success. It waits for an authority-generated `applied` or `rejected` result and reconciles against the resulting revision or snapshot. Use target/timeline preconditions for noncommutative operations. After reconnect or missed deltas, recover from a complete authoritative snapshot.

## Local and Remote CLI Contract

The CLI is a first-class product surface, not a shell escape hatch.

- Fixed administrative verbs manage remote readiness, status, devices, revocation, and diagnostics.
- Product subcommands and browser controls map through closed product-specific schemas to the complete operation registry. Generate adapter registries and compare them with the profile in CI; a loose JSON object or hand-maintained checklist is insufficient.
- A local CLI talks to the selected authority through an authenticated local channel.
- A remote CLI uses the same public authentication, authorization, protocol, dedupe, and transport policy as the browser companion.
- Stable JSON output includes protocol/schema version, success, command ID, authority generation when safe, revision, data or stable error code, and no secrets.

Read [cli-and-automation.md](cli-and-automation.md) before implementing or claiming CLI support.

## Remote Readiness Is Inert by Default

Remote-ready means the complete browser/CLI semantic surface and adapters can be enabled safely. It does not mean opening a listener, joining signaling, changing the firewall, installing a service, forwarding a port, or starting a controlled action.

Choose and document one availability profile:

- manual session;
- app-lifetime beacon;
- explicitly installed supervised user-session service;
- a separately designed cloud-backed account profile when the user requests one.

The local-first static-companion profile keeps user data and authority off the static host. A cloud-backed product needs its own data ownership, account, retention, deletion, incident, and operational model; do not pretend it is the same profile.

## Traffic and Work Isolation

Separate semantics even if a transport combines physical connections:

- reliable ordered control must remain bounded and responsive;
- authoritative state is revisioned and snapshot-recoverable;
- high-rate intent is replaceable, leased, and safe to drop when stale;
- bulk transfer uses binary framing, integrity checks, independent backpressure, and transactional staging;
- media readiness and buffering do not block control readiness.

Move scans, hashing, parsing, recognition, visualization, and large transfers off the authority's critical path. Keep their final state commit short and bounded.

## UI Contract

Local and companion interfaces should share product semantics and design tokens when practical, but they need not share every layout. The installed interface may expose privileged local operations; the companion renders only role-safe actions and projections.

Design from user tasks, information hierarchy, failure states, density, input mode, and target screen before styling. Preserve semantic HTML, focus order, labels, contrast, touch targets, reduced motion, localization, and platform conventions. Apply [interface-quality.md](interface-quality.md) as a design review, not a reason to override a real brand or accessibility requirement.

## Incremental Build Order

1. Scaffold and compile the untouched Tauri application.
2. Implement one pure Rust action and repository boundary.
3. Route it through the Tauri adapter and local UI.
4. Route it through the typed local CLI and test executable output.
5. Define the remote application profile and threat model.
6. Authenticate one principal and route the same action through the browser and remote CLI adapters.
7. Reconcile the acknowledgement and resulting state in the companion.
8. Extend the vertical slice across the full operation registry; fail coverage for missing browser/CLI actions, queries, subscriptions, pages, or transfers.
9. Add remembered devices, bulk transfer, media, or supervision only when the preceding layer passes.
10. Qualify source, packaged, installed, network, browser, and physical-device paths in proportion to the claims.

## Completion Boundary

Repository starter tests prove only that the reusable contracts, parsers, and sample reducer agree. A generated app must supply its own real authentication implementation, local IPC, transport/signaling, Tauri capability map, product action schema, persistence, UX, packaged runtime, supported browser/device matrix, and end-to-end evidence.
