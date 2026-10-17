# Tauri Application Foundation

Use this reference when creating, migrating, or broadly restructuring the underlying Rust/Tauri application before adding remote access. Pinned project versions and current official Tauri/platform documentation override version-sensitive examples.

## Orient Before Editing

1. Read every applicable repository instruction file.
2. Inspect `git status` and preserve unrelated changes.
3. Detect the frontend package manager from its lockfile; never introduce a second one casually.
4. Read workspace manifests/lockfiles, `rust-version`, Tauri configuration, capability/permission files, Rust entry points, frontend build scripts, CI, and existing tests.
5. Inspect exact resolved versions and Cargo features.
6. Run a cheap baseline and record pre-existing failures.

Do not apply current tutorial commands blindly to a pinned project.

## Scaffold Deliberately

For a new app, determine target platforms, frontend framework/language, package manager, product name, bundle identifier, native features, data locations, and distribution targets. Ask before inventing a production identity, signing owner, remote service, or background-start policy.

Use the current official Tauri scaffolder. Before adding features:

- compile the untouched Rust crate;
- build the untouched frontend;
- inspect generated configuration and capabilities;
- launch the development app when possible;
- record the baseline.

Add one vertical feature slice at a time and rerun relevant checks.

## Rust Core Quality

- keep domain logic in ordinary crates/modules independent of Tauri;
- model states and actions with enums/newtypes rather than stringly typed maps;
- use `Result` and stable error categories; reserve panics for violated internal invariants;
- validate at trust boundaries and avoid duplicated partial validation;
- keep ownership explicit; do not reach for global mutable state;
- use bounded channels/queues and cancellation for asynchronous work;
- never hold locks across `.await`, disk, network, process, or expensive computation;
- use `spawn_blocking` for actual blocking work;
- attach structured tracing spans/correlation IDs and redact sensitive fields;
- pin a Rust edition/MSRV intentionally and test that exact compiler with the resolved lockfile;
- run formatting, Clippy with warnings denied, unit/integration tests, and dependency/license policy appropriate to the product.

Prefer a single Cargo workspace/lockfile for the Tauri shell and shared Rust crates. Feature flags should represent real build/platform choices rather than silently enabling broad native authority.

## Frontend Boundary

Build a static/client-rendered frontend compatible with Tauri's asset model unless a separately justified local/server architecture exists. Keep one typed native client module around `invoke`, events, and channels. Do not scatter raw command names or deserialize `any` throughout components.

- render useful UI early and defer noncritical services;
- clean timers, event/channel listeners, watchers, and async subscriptions on unmount/window teardown;
- if subscription setup is asynchronous, dispose the eventual handle even when unmount happens first;
- paginate/virtualize large collections and batch stream renders;
- treat WebView engines as different runtimes and test Chromium/WebView2, WebKitGTK, and WKWebView behavior actually promised;
- preserve accessibility, keyboard/native conventions, safe areas, zoom, dynamic text, and reduced motion.

Frontend environment variables and bundled assets are public. Secrets remain native.

## Commands, Events, Channels, and State

- commands for typed request/response;
- channels for ordered streaming/progress;
- events for small notifications/multi-consumer signals without return values;
- managed state for initialized services/handles, not a monolithic lock.

Keep commands thin: validate caller/input, call a service, map to a frontend-safe DTO/error. Coalesce related native facts into one snapshot rather than repeated expensive polling. Push changes from native state where appropriate; if polling is required, prevent overlap, pause when hidden, and back off on failures.

## Plugins and Native Authority

Use only required plugins and inspect their generated permissions/scopes for the exact version. Separate capabilities by window, action, platform, and remote origin. An initialized plugin does not require granting its full frontend API; Rust can use native functionality behind a narrower product command.

Avoid broad filesystem, shell, HTTP, SQL, clipboard, process, window-creation, or arbitrary URL scopes. Application-defined command scopes need application enforcement. Re-review capability unions and generated schemas after upgrades.

For a reusable native integration, prefer:

- pure Rust crate for domain logic;
- Tauri plugin for a reusable native/WebView API;
- sidecar for crash/license/runtime isolation;
- small `unsafe` FFI adapter only when an in-process SDK is necessary.

## Files, Databases, and Secrets

- OS dialog filters improve UX but do not validate content;
- keep consequential file selection/verified handles native when path authority matters;
- hash and parse the same bounded bytes or stage an immutable app-owned copy to avoid time-of-check/use races;
- validate inner declared sizes before allocation/decompression/decoding;
- use atomic save/finalize patterns and explicit crash recovery;
- put app data/config/cache/logs in platform directories;
- use typed settings with schema migration for non-secrets;
- use Rust-owned SQLite/repository methods and immutable ordered migrations for structured data;
- never expose arbitrary SQL or database credentials to the WebView;
- keep credentials/private keys in an OS credential store or reviewed vault with documented recovery and platform behavior;
- test symlinks, traversal, path replacement, oversized/truncated containers, disk-full, locked database, corrupt settings, and interrupted migration/save.

Mobile dialogs may return content/file URIs rather than desktop paths. Use current Tauri abstractions and physical-device tests.

## Networking

Choose browser networking for ordinary public APIs and Rust networking for native TLS/proxy/client certificates, secrets, strict host policy, shared connections, or streaming to disk. Parse and constrain URLs, redirects, hosts, schemes, ports, sizes, timeouts, cancellation, and retries.

Do not disable certificate validation. Certificate pinning creates rotation/recovery obligations. For OAuth/OIDC, use system browser, PKCE, state/nonce, validated callback/deep link, and native/keychain-owned refresh tokens.

Test offline, DNS/TLS/proxy failure, redirect escapes, oversized/malformed responses, throttling, cancellation, reconnect storms, sleep/wake, and shutdown during I/O.

## Sidecars and Child Processes

Bundle deterministic per-target artifacts, hashes, signatures/notarization, notices, and exact permissions. Prefer typed Rust commands that construct arguments over frontend-supplied argv. Define bounded framing, startup handshake, readiness timeout, backpressure, output capture, cancellation, child ownership, restart, and shutdown/orphan policy.

Never download and execute a runtime binary without an independently authorized, signed, rollback-capable update design.

## Desktop and Mobile Lifecycle

Define tray/menu/window-close/background/quit ownership rather than inheriting accidental defaults. Platform-specific integrations need platform-specific capabilities and tests.

On Android/iOS test generated native projects, permissions, deep links/file associations, cold/warm start, background/foreground, process death, rotation, network changes, safe areas, keyboard, physical devices, signing, and store artifacts. Simulator/browser emulation is complementary evidence.

## Legacy or Python-to-Rust Migration

Inventory behaviors and create golden fixtures before translating. Extract a pure Rust core behind the existing interface, compare outputs/performance, then move one boundary at a time. Keep one authority during the transition; do not run Python and Rust as competing mutable backends.

Use PyO3 when Python remains the caller/extension host, a sidecar when isolation/runtime/library constraints dominate, or a service only when network deployment is genuinely required. Preserve numeric/file/data semantics, cancellation, error mapping, licensing, packaging, and platform tests. Remove the migration bridge only after the new path passes equivalent evidence.

## Performance

Measure frontend, IPC, Rust, OS API, database, network, and sidecar segments separately in release builds. Share cached snapshots, batch calls, push updates instead of expensive polling, bound streaming buffers, discard stale async results, and remove unused plugins/features before exotic optimization.

Do not claim “native performance” or quote tutorial bundle/memory numbers without reproducing the conditions.

## Distribution and Updates

- use frozen lockfiles and host-native builds for supported platform/architecture pairs;
- separate untrusted PR tests from secret-bearing signing/publishing;
- pin high-assurance CI actions and minimize token permissions;
- sign/notarize nested binaries, sidecars, installers, and updater artifacts as required;
- test the exact draft artifacts before promotion; never rebuild and call them identical;
- choose one update owner per distribution channel;
- coordinate updater signatures, private-key recovery, app/schema migrations, interruption, and rollback;
- test clean install, upgrade from every supported source, launch, deep links/files/tray, repair/uninstall/data retention, offline and locked-file behavior.

Building locally does not authorize release, signing, store submission, production endpoint changes, or publishing.

## Foundation Completion Evidence

Report exact format/lint/type/unit/integration/build commands, test counts, compiler/package versions, target runtime/installer checks, pre-existing failures, unrun platforms, signing/release state, and residual risk. Then apply the stricter remote qualification in [10-qualification.md](10-qualification.md).
