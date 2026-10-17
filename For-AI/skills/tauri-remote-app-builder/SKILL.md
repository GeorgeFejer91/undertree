---
name: tauri-remote-app-builder
description: Build, migrate, secure, test, and ship polished Rust/Tauri v2 applications with one Rust authority shared by the desktop UI, a first-class CLI, an opt-in browser or phone companion, and verifiable bounded-text layouts. Use for end-to-end Tauri app creation, typed remote control, revisioned state sync, media or file transfer, native integrations, packaging, or frontend UI work. Do not use for ordinary websites, generic remote desktop, shell or input forwarding, or safety-critical control.
---

# Tauri Remote App Builder

Build one coherent product: an idiomatic Rust core, a least-privilege Tauri shell, a scriptable CLI, a secure remote browser companion, and a restrained product-specific interface. Adapt this architecture to the user's app instead of imposing demo semantics.

## Product Contract

For a new app, include the CLI, remote application boundary, and companion UI by default unless the user opts out. The paired browser on another device must be able to operate the complete semantic product surface. Keep network availability disabled until the user explicitly chooses an activation and reachability model.

- Rust owns business state, policy, secrets, persistence, filesystem/process/network authority, authorization, revisions, grants, and side effects.
- The Tauri UI, local CLI, authenticated remote CLI, and browser companion are adapters over the same closed operation service. They do not implement competing mutable stores.
- Maintain one Rust-derived operation registry covering actions, queries, subscriptions/progress, pagination, uploads, downloads, and other transactional transfers. Every ordinary product operation has explicit Tauri, local-CLI, remote-CLI, and browser-companion bindings. Missing browser operations are defects, not optional future polish.
- Catalogue a local-only operation separately only for trust, consent, physical-presence, OS-permission, or safety reasons. Give it typed local bindings and a substantive reason; “not implemented remotely” is never a reason.
- Every mutation is a named, typed product action. Never expose a generic shell, arbitrary argv, SQL, path, URL fetch, Tauri-command proxy, DOM event, keyboard, mouse, or script surface.
- A static hosted companion contains only public HTML, CSS, JavaScript, and product assets. It never contains user data, native paths, passwords, grants, private routes, databases, or privileged proxy logic.
- Transport discovery or encryption is not application authentication or authorization. Rust rechecks scope and preconditions when applying every action.
- The interface follows the product's existing design language first, then the anti-template principles in [interface-quality.md](references/interface-quality.md). Accessibility and platform conventions outrank decorative rules.
- Fixed-height, generated, localized, virtualized, or programmatically flowed text uses the bounded-text contract in [pretext-text-layout.md](references/pretext-text-layout.md) when predictive geometry adds value. A Pretext guarantee applies only to allow-listed, tested typography tokens and documented text features; unsupported typography remains DOM-managed and must not be reported as Pretext-verified.
- Completion claims require observed evidence from the real path being claimed. Compilation, mocks, screenshots, or a health endpoint cannot substitute for browser-to-Rust, CLI-to-Rust, packaged-runtime, or physical-device checks.

## Start With the Relevant References

For every new application or broad migration, read:

1. [integrated-app-blueprint.md](references/integrated-app-blueprint.md)
2. [13-tauri-application-foundation.md](references/13-tauri-application-foundation.md)
3. [cli-and-automation.md](references/cli-and-automation.md)
4. [interface-quality.md](references/interface-quality.md)
5. [00-system-contract.md](references/00-system-contract.md) before implementing remote access

Then load only the material relevant to the current change.

### Rust, Tauri, and Platform Work

- Repository orientation, scaffolding, or migration: [project-workflow.md](references/tauri/project-workflow.md)
- Commands, events, channels, state, and module boundaries: [tauri-architecture.md](references/tauri/tauri-architecture.md)
- Rust types, ownership, async, errors, logging, and tests: [rust-quality.md](references/tauri/rust-quality.md)
- IPC, capabilities, plugins, remote content, filesystem, shell, HTTP, or new windows: [tauri-security.md](references/tauri/tauri-security.md)
- Frontend/framework and static-output decisions: [frontend-frameworks.md](references/tauri/frontend-frameworks.md)
- Fixed text boxes, generated or localized copy, virtualized rows, multiline shrink-wrap, obstacle-aware flow, or overflow verification: [pretext-text-layout.md](references/pretext-text-layout.md)
- Desktop windows, menus, tray, and lifecycle: [desktop-integration.md](references/tauri/desktop-integration.md)
- Android/iOS: [mobile-development.md](references/tauri/mobile-development.md)
- Files, databases, settings, and secrets: [files-and-persistence.md](references/tauri/files-and-persistence.md)
- HTTP, WebSockets, OAuth, FFI, or shared native libraries: [networking.md](references/tauri/networking.md)
- Plugins: [plugin-development.md](references/tauri/plugin-development.md)
- Sidecars and child processes: [sidecars-and-processes.md](references/tauri/sidecars-and-processes.md)
- Durable queues, background jobs, media processing, and upload-to-job ownership: [durable-jobs-and-media.md](references/durable-jobs-and-media.md)
- OS integrations: [system-integrations.md](references/tauri/system-integrations.md)
- Python replacement: [python-to-rust-migration.md](references/tauri/python-to-rust-migration.md)
- High-rate or deadline-sensitive systems: [latency-critical-systems.md](references/tauri/latency-critical-systems.md)
- Performance and production review: [performance-and-production.md](references/tauri/performance-and-production.md)
- Testing and diagnosis: [testing-debugging.md](references/tauri/testing-debugging.md)
- CI, installers, signing, updates, and stores: [release-distribution.md](references/tauri/release-distribution.md)
- Completion evidence: [verification.md](references/tauri/verification.md)
- Unusual or uncovered Tauri subsystems: [coverage-map.md](references/tauri/coverage-map.md)
- Explicit VR/XR work only: [vr-xr-development.md](references/tauri/vr-xr-development.md)
- Presentation-only shared scenes, BRSP/1, VDO.Ninja, or Marionette profiles: [marionette-remote-control.md](references/tauri/marionette-remote-control.md)
- Detailed remembered-browser, reconnection, timeline, loopback, and congestion analysis: [browser-companion-reliability.md](references/tauri/browser-companion-reliability.md)
- Tutorial/source-currency audits only: [source-ledger.md](references/tauri/source-ledger.md) and [python-migration-source-ledger.md](references/tauri/python-migration-source-ledger.md)
- Inherited origins and license audit: [provenance.md](references/tauri/provenance.md)

### Remote Browser, CLI, and Data Planes

For experiment runners with HTML remote viewers or recorder tab integration, read [experiment-remote-panels.md](references/experiment-remote-panels.md). Include a Remote Panel/1 descriptor, stable embeddable controller path, local link/QR export, and independent experiment authority.


| Need | Read |
|---|---|
| Authority topology | [01-architecture-and-authority.md](references/01-architecture-and-authority.md) |
| Envelopes, commands, revision, dedupe, and leases | [02-protocol-and-state.md](references/02-protocol-and-state.md) |
| Human passwords, PAKE, grants, and remembered devices | [03-authentication-and-devices.md](references/03-authentication-and-devices.md) |
| WebRTC, WSS, TURN, VDO.Ninja, and WebTransport | [04-transport-and-reachability.md](references/04-transport-and-reachability.md) |
| Upload, download, integrity, resumption, and scheduling | [05-file-transfer.md](references/05-file-transfer.md) |
| Rust/Tauri integration and loopback adapters | [06-tauri-and-rust-integration.md](references/06-tauri-and-rust-integration.md) |
| Static/PWA companion behavior | [07-hosted-browser-companion.md](references/07-hosted-browser-companion.md) |
| Sleep, reconnect, shutdown, and supervision | [08-lifecycle-and-supervision.md](references/08-lifecycle-and-supervision.md) |
| Latency budgets, backpressure, and operations | [09-performance-and-operations.md](references/09-performance-and-operations.md) |
| Browser/native/device qualification | [10-qualification.md](references/10-qualification.md) |
| Real defects and durable Zuradio lessons | [11-zuradio-lessons.md](references/11-zuradio-lessons.md) and [zuradio-project-contract.md](references/zuradio-project-contract.md) |

Use [uncodixfy-upstream.md](references/uncodixfy-upstream.md) only when the user requests the exact upstream rules or an audit needs the complete upstream anti-pattern catalogue. The adapted [interface-quality.md](references/interface-quality.md) controls when the two differ. Use [12-sources-and-provenance.md](references/12-sources-and-provenance.md) when auditing origins, licenses, evidence limits, or version currency.

## Build Workflow

### 1. Establish the Baseline

Read repository instructions and inspect status, manifests, lockfiles, resolved versions, entry points, Tauri configuration, capability and permission files, generated schemas, CI, and tests. Preserve the existing frontend framework, package manager, Rust edition, Tauri major version, and conventions unless the user requests a migration. Run a cheap baseline and record pre-existing failures.

For a new app, confirm platforms, product identity, frontend stack, package manager, native features, remote roles, data classes, distribution targets, and whether remote readiness is manual, app-lifetime, or supervised. Do not invent a bundle identifier, signing identity, public service, or background-start policy.

### 2. Design One Authority and Contract

Define the complete domain operation registry, closed product-specific request/result schemas, state projections, stable errors, revision rules, idempotency, resource limits, cancellation, privacy boundaries, and per-surface bindings before transport or UI code. Include actions, queries, subscriptions/progress, pagination, and transactional transfer workflows. Keep the domain in ordinary Rust crates or modules independent of Tauri and vendor transports.

Choose the narrowest native boundary:

- command for typed request/response;
- channel for ordered progress or streaming;
- event for small notifications without a return value;
- managed state for initialized service handles, not arbitrary frontend state.

For remote access, also define protocol version, roles, scopes, authority generation, transport generation, authentication method, grant lifetime, revocation, route reporting, state recovery, and control/state/bulk/media lanes. Start from the contracts in `assets/starter/contracts/` rather than inventing an unbounded message format. Treat `remoteControl.policy: full-semantic-parity` as a coverage gate. Generate `surface-registry` evidence from the actual typed Rust/Tauri/CLI/browser registries and run `validate_application_profile.py`; do not hand-maintain four unaudited lists.

### 3. Implement the Vertical Slice Through Every Local Adapter

Implement and unit-test one pure Rust action first. Route the same operation through:

1. the authority/service method;
2. a thin Tauri command and typed frontend wrapper;
3. the first-class CLI with stable human and JSON output;
4. the local UI with success, expected failure, busy, and malformed-input states.

Compile and exercise this path before expanding the feature. The CLI must call the same service or authenticated local IPC boundary; it must not duplicate business logic or mutate durable files behind the running authority. As operations are added, update the Rust-derived registry and all adapter bindings in the same change so browser parity cannot drift.

### 4. Add Remote Control as an Opt-In Adapter

Run `python scripts/scaffold_remote_control.py <project-directory>` when the reusable contracts and starter boundary help. Replace the example actions and profile with product semantics.

Implement one remote slice in this order: authenticate, issue a least-scope Rust grant, request one typed action from the browser or remote CLI, apply it through the same authority, return `applied` or a final/retryable `rejected` outcome for the stable command ID, then publish the authoritative revision. A timeout is an unknown outcome and retries reuse the same ID and request fingerprint. Cache deterministic final outcomes; persist outcome/tombstone identity in the same transaction as any side effect that survives restart. Expand the slice until every non-exempt action, query, subscription, and transfer has browser/CLI parity. Add media or bulk transfer only after the control path passes.

Use a reviewed PAKE such as OPAQUE, SPAKE2, or SPAKE2+ for human-memorable passwords. BRSP-style mutual HMAC is only suitable for a generated high-entropy invitation secret. Never invent a password proof from a KDF and HMAC alone and call it password-safe.

CLI remote mode uses the same public application protocol, authentication, scopes, dedupe, action catalogue, and transfer rules as the browser companion. The browser does not forward CLI strings; both adapters compile explicit inputs into the same typed Rust actions. Neither may reach around the protocol to a private daemon endpoint or leak secrets through argv, process listings, logs, URLs, shell history, or machine-readable output.

### 5. Build the Interface From Product Tasks

Map real user tasks, hierarchy, states, keyboard behavior, narrow-width behavior, accessibility, and platform conventions before styling. Reuse the project's established components, tokens, and palette. If none exists, choose a restrained coherent palette and document it.

Avoid generic AI-dashboard habits: decorative hero copy in tools, floating glass shells, gratuitous KPI grids, pill overload, giant radii, fake charts, random gradients or glows, excessive padding, ornamental status labels, and motion without feedback value. Use semantic headings even though decorative headline blocks are discouraged. Never sacrifice focus visibility, contrast, touch targets, reduced motion, screen-reader structure, localization, or data density to imitate a reference aesthetic.

Before implementing any fixed or maximum-size text region, declare whether it expands, reflows, scrolls, clamps with access to the full value, or rejects overflow. When using Pretext, bundle it locally, share one typed wrapper and typography allow-list between the installed UI and companion, and use only the supported profile in [pretext-text-layout.md](references/pretext-text-layout.md). Do not accept arbitrary runtime font strings, silently clip text, or shrink typography below the product's readable minimum.

Keep local and remote interfaces visibly honest about connecting, authenticating, authorized, degraded, reconnecting, revoked, and offline states. A transport-open indicator is not "ready."

### 6. Verify the Claimed Product

Use focused checks first, then the repository's broader gates. For a remote-capable app, completion evidence includes:

- pure Rust unit/integration tests and denied-action cases;
- Tauri IPC and capability allow/deny checks;
- CLI executable tests, JSON contract tests, explicit boolean/enum handling, exit codes, timeouts, and secret redaction;
- an automated registry-coverage test proving every domain action, query, subscription, page, and transfer is exposed through the installed UI, CLI, remote CLI, and browser companion; separately validate every typed local-only exception;
- real browser intent reaching the real Rust authority and returning acknowledged state;
- wrong-password, stale-generation/revision, replay/dedupe, expiry, revocation, reconnect, sleep/resume, and bounded-overload cases;
- saturated bulk transfer while measuring control acknowledgement and byte integrity;
- supported browser engines, phone-width workflows, keyboard and accessibility checks;
- governed-text fixtures proving allow-listed fonts load, Pretext predictions respect declared box policies, and real DOM geometry agrees in every claimed browser and Tauri WebView;
- packaged/installed runtime and public companion bytes when those paths are claimed;
- direct, relayed, and unknown routes reported honestly with latency/throughput percentiles and runtime versions.

Run the reusable-skill checks when changing this skill repository:

```text
python scripts/check_repository.py
python -m unittest discover -s tests -v
cargo test --locked --manifest-path assets/starter/rust/Cargo.toml
npm --prefix assets/starter/browser test
```

## Mandatory Pause Points

Stop and request direction before destructive migrations; changing framework, package manager, Rust edition, or Tauri major version without a migration request; enabling remote WebView privileges, generic filesystem/shell/network authority, public loopback exposure, port forwarding, firewall changes, or background startup; introducing a relay/signaling service, account system, production endpoint, bearer-token fallback, or custom cryptography; adding `unsafe` while a safe design remains plausible; or signing, publishing, notarizing, deploying, or using credentials not already authorized by the user.

## Completion Report

Lead with the observable outcome. State the authority owner, adapters, companion origin, authentication and scopes, important UI decision, changed files, exact checks and counts, measured remote/CLI behavior, installed/device evidence, and every unrun platform or release boundary. Never expose passwords, invitation secrets, grants, private routes, tokens, or user data.
