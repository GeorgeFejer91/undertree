# CLI and Automation Contract

Read this reference whenever creating, extending, or testing the local CLI, remote CLI, machine-readable output, service administration, or agent automation surface.

## Purpose

The CLI gives humans, scripts, and authorized agents a stable way to operate the same Rust product authority used by Tauri and the browser companion. Its typed product vocabulary is also the automation counterpart of the companion's complete semantic control surface. It is not a wrapper around arbitrary shell commands and not a second backend.

## Required Command Families

Use fixed verbs appropriate to the product. A remote-capable app should normally provide:

```text
appctl remote start
appctl remote status
appctl remote stop
appctl devices list
appctl devices revoke <device-id>
appctl doctor
appctl <typed-product-command> ...
```

- `remote start` activates the configured readiness profile; it does not execute a product action.
- `remote status` distinguishes stopped, discovering, authenticating, control-ready, media-ready, degraded, reconnecting, and revoked states where relevant.
- `remote stop` closes the declared session/service set and applies the profile's authority/grant rotation policy.
- `devices` operates only on Rust-owned remembered-device records and never prints credential material.
- `doctor` runs bounded read-only diagnostics and reports what it actually tested.
- Product commands map explicitly to the complete domain operation registry and scopes, including bounded queries, JSON-lines subscriptions/progress, pagination, and transactional transfer commands. The paired browser exposes equivalent semantics without sending raw CLI strings. Do not forward a raw function name, Tauri command, argv tail, JSON object, URL, path, SQL string, or script for dynamic dispatch.

## One Authority

Select one of these patterns:

1. The running Tauri process owns authority and exposes a narrow authenticated local IPC endpoint to `appctl`.
2. A user-session daemon owns authority; both Tauri and `appctl` use its local IPC contract.
3. A one-shot CLI owns authority only for a genuinely offline, exclusive operation with explicit locking and migration semantics.

Do not instantiate a second in-memory authority merely to make a CLI command appear to work. Do not mutate the database or configuration files behind the running authority.

Local IPC should use an OS-appropriate user-scoped mechanism such as a Unix-domain socket, named pipe, XPC, or narrowly bound loopback channel with independently authenticated bootstrap. Validate peer/user identity where the platform permits it. Bound frames, connections, queues, timeouts, output, and diagnostic detail.

## Parsing and Type Safety

- Use a closed command enum or equivalent typed parser.
- Require explicit values for booleans and enums; avoid flags that can express only one direction when both are meaningful.
- Reject unknown subcommands, duplicated mutually exclusive flags, trailing arguments, invalid ranges, invalid UTF-8 boundaries, and oversized input.
- Keep identifiers opaque and validate their grammar and maximum length.
- Read bulk input as bounded streams or files; do not serialize large byte arrays into argv or JSON.
- Version machine-readable request and response schemas.
- Keep product parsing separate from transport selection and credential acquisition.

The reusable `assets/starter/cli/` demonstrates typed parsing and an injected authority client. Replace its example product operations with generated or explicitly mapped commands covering the application's Rust-derived operation registry, then wire the client to the chosen running authority. Generate the CLI registry and compare it with the Tauri, remote CLI, browser, and profile registries using `assets/starter/contracts/validate_application_profile.py`.

## Human and JSON Output

Human output should be concise, actionable, and safe to paste into a support request. JSON output should be one stable object per requested operation unless a documented streaming mode is selected.

A useful result shape is:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "commandId": "opaque-command-id",
  "revision": 42,
  "data": {}
}
```

Failures use a stable code, bounded safe message, and nonzero exit status:

```json
{
  "schemaVersion": 1,
  "ok": false,
  "error": {
    "code": "scope_denied",
    "message": "The current grant cannot perform that action."
  }
}
```

Never include password material, invitations, session keys, bearer tokens, bootstrap fragments, full private routes, native paths, raw grants, unredacted logs, or sidecar output in either format. Keep structured diagnostics opt-in and redacted.

## Credentials

- Do not accept reusable secrets directly in argv; argv and process listings are commonly observable.
- Avoid long-lived secrets in environment variables, URLs, shell history, current directories, or command output.
- Prefer an OS credential store, proof-of-possession device key, user-scoped local peer credentials, or interactive stdin/TTY flow designed for the chosen authentication protocol.
- Keep local admin credentials distinct from hosted-browser cookies, invitation secrets, and remote grants.
- Bind a remote CLI to the same principal, role, scopes, authority generation, expiry, replay sequence, and revocation rules as another remote client.
- Password change, explicit revoke, remote stop, and authority rotation must invalidate the records defined by the application profile.

## Remote CLI

A remote CLI is another public protocol client. It must complete the same reviewed authentication flow and use the same command envelopes, acknowledgements, expected revisions, dedupe, snapshot recovery, rate limits, and transfer framing as the browser companion.

For every ordinary product action, test that the installed UI, CLI, remote CLI, and paired browser resolve to the same typed Rust action and observe the same authoritative result. Any local-only exception must name a trust, consent, physical-presence, OS-permission, or safety reason. “Not implemented in the companion yet” is not an exception.

Do not give the CLI a secret private daemon endpoint that bypasses the documented remote protocol. Do not widen `upload` into `control`, infer authorization from transport identity, or reuse a signaling/room password as an application grant.

For consequential commands:

- generate or accept a stable command ID for safe retries;
- state the timeout separately from the application result;
- distinguish unknown outcome from rejected outcome;
- on ambiguous acknowledgement loss, retry with the same ID and bytes;
- reconcile against the returned authoritative revision or snapshot.

## Automation and Agent Use

Automation should prefer `--json`, explicit timeouts, deterministic exit codes, and idempotency keys. It must not parse decorative human prose or scrape the UI.

Document which commands are read-only, reversible, consequential, destructive, or externally mutating. A CLI command's existence does not grant an agent permission to invoke it. Preserve the user's authorization and pause before publishing, production deployment, account changes, background installation, firewall changes, destructive migrations, or secret use.

## Exit Status

Define a small stable mapping. One reasonable starting point is:

| Status | Meaning |
|---:|---|
| `0` | Operation applied or read completed |
| `2` | CLI usage or validation error |
| `3` | Authentication failed or absent |
| `4` | Authorization or scope denied |
| `5` | Conflict, stale revision, or rejected precondition |
| `6` | Authority unavailable or transport failure |
| `7` | Timed out with unknown outcome |
| `8` | Internal failure with safe diagnostics available locally |

Projects may adapt the codes, but once published they form part of the automation contract.

## Verification

Test the built executable, not only parser functions.

- help and version output;
- every verb, boolean direction, enum, and output mode;
- malformed, oversized, missing, duplicated, and trailing input;
- JSON schema/version and no secret/path leakage;
- exact exit codes;
- authority unavailable, timeout, cancellation, and unknown outcome;
- stale authority generation and revision;
- expired/revoked/insufficient grants;
- duplicate command retry with identical bytes and reuse with different bytes;
- concurrent local UI and CLI actions through one authority;
- remote CLI and browser clients observing the same resulting revision;
- remote stop and device revoke taking effect immediately;
- packaged/installed executable using the real local IPC boundary.

Do not claim the starter itself supplies production local IPC, transport, authentication, or service supervision. It supplies the typed adapter contract and tests that generated applications must complete.
