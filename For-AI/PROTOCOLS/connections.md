# UnderTree connection contract

Scope: **Review and separately granted non-content App controls** in the Rust/Tauri manuscript workspace. One user opens **Connections** to manage one opt-in zrok2 share and its distinct capabilities. This protocol adapts Secret Tunnel's native authority, ownership and evidence structure. The latest user correction prohibits full editing of files. [The App control plan](../PLANNER/CHATGPT-FULL-CONTROL.md) excludes remote saves, source/tree/policy mutation and indirect autosave. A Review capability never upgrades into App authority. New App code still requires its own integrated/native/public qualification; source implementation is not that evidence. UI rules have one owner: [ui-layout.md](../ui-layout.md).

## Application profile and authority

```text
local Connections dialog → typed review_action / Operation → Rust Service
ChatGPT → public zrok2 share → separate loopback MCP listener → closed remote tools
```

The public listener does not mount `/api/review`, the project registry, the frontend or any generic local command. Tauri capabilities remain limited to the local main window. Only Rust can launch/stop the child, issue the capability, enumerate shares or enforce review policy. Ordinary editing remains offline and independent of the tunnel.

| Surface | Contract |
| --- | --- |
| zrok tab | Public name and exact HTTPS origin; explicit start; installed/enabled zrok2 required. `UNDERTREE_ZROK` selects the native executable. No account token enters the WebView. |
| Overview tab | First page with complete private URL, copy with selectable fallback, Start access, observed tunnel/MCP status and expandable setup/activity. These are local observations, not proof of ChatGPT identity or public reachability. |
| Manuscripts tab | All explicitly shared session manuscripts, project labels and individual revoke actions. Opening a folder or starting a tunnel does not share its files. |
| App controls tab | Explicit session-only opt-in, separate capability URL and status. No source/policy editing or indirect saves. It uses the current UI page's native owner epoch, independent of CLI and Review authority. |
| Stop | Revoke current access, terminate only the owned child/listener, clear every session share. |
| Restart | Restore setup, including an explicit imported identity when present. No tunnel, manuscript grant or MCP activity is restored. |

## Protocol and lifecycle

- Transport is stateless MCP Streamable HTTP: JSON-RPC POST, JSON response, Accept containing `application/json` and `text/event-stream` (including repeated headers and case-insensitive media types). Supported protocol versions are `2025-03-26` and `2025-06-18`. Initialize before tool use; send the negotiated `MCP-Protocol-Version` afterward. An omitted version header falls back to `2025-03-26`; an explicitly unsupported version is denied. Valid notifications return HTTP 202 without a body and cannot dispatch tools. Browser Origin requests are refused.
- Review exposes exactly `list_manuscripts`, `read_manuscript` and `suggest_text`. Manuscript IDs come from the approved shared inventory. Source is untrusted data. Protection/rejection overrides prompts; acceptance, source saves, policy changes and synchronization remain local. Reads and proposals deny pending recovery journals instead of replaying a local save; only suggestion metadata may change on a successful proposal.
- User-owned color rules support `protect`, `prompt`, `reject` and `discard`. Discard permits only an empty replacement covering every overlapping discard highlight; protect/reject still deny it. Stale discard highlights block proposals until resolved locally. Both submission and local acceptance recheck this policy. Accepted deletions retire their fully consumed discard highlights; rejected suggestions retain them. Existing three-rule sidecars retain their meaning and can add Discard locally. No remote tool toggles direct editing; local sharing/tunnel and separate non-content App controls remain the access switches.
- By default, a fresh random capability is generated for every successful session at `/mcp/<secret>`. The explicit imported-connector exception below preserves the existing bearer address. The URL is a bearer capability, not OAuth or per-user authentication. Anyone holding it can exercise the three tools against the shared manuscripts until revocation. Do not log, commit, put in browser storage or publish it.
- Validate public-name length/characters and HTTPS origin before touching live state. Reject paths, queries, fragments and userinfo. Reject duplicate starts without silently rotating a live grant.
- Launch `zrok2 share public http://127.0.0.1:<ephemeral-port> -n public:<name> --headless --force-local` directly, without a shell. Reserve the loopback listener before checking controller records. Require two seconds of child survival and bounded discovery of one newly created public/proxy share matching that exact target, expected enrollment and frontend host. Pin its token and metadata privately. A process or controller record does not prove public connectivity. No automatic restart or takeover of unrelated shares.
- Stop, observed child death and startup rollback revoke grants, reap the child, revalidate the pinned share independently of target filtering, delete only that exact token with its enrollment, and verify absence. An uncertain cleanup keeps its ownership record and bound listener, reports `tunnel_cleanup`, and blocks reconnect until Stop verifies removal. Never delete by public name. Ownership is process-local: abrupt application termination or a controller create committing after an empty post-kill listing can strand a mapping; this is not durable crash recovery.
- Public name/origin are atomically saved to `connection.json` under the native review state directory. By default zrok account activation/credentials remain in the existing CLI's own store; an explicit import uses the dedicated private store below. UI status refresh is single-flight, every two seconds while the dialog is visible; it does not start processes or broaden grants.
- Detecting child death conceals its endpoint and clears shares. Every MCP request also checks child liveness and capability in Rust. Shutdown revokes the listener and owned child. Restart never silently resumes remote authority.

## Explicit Secret Tunnel connector import

User direction on 2026-10-16 requests the same complete Secret Tunnel connector
URL and a text-review-only MCP. This is a narrow exception to address rotation,
not to manuscript policy or session sharing. The local maintenance command
`npm run connection:profile` exports only the name/path token and allowlisted
zrok enrolment files. Sensitive cross-PC transfer uses Magic Wormhole; never
pass the package contents through agent messages or MCP file-read responses.
Import requires the desktop closed, an existing native state directory, and new
private destinations. Existing imported profiles or conflicting public setup
are preserved for local review rather than overwritten.

`transport/connector.rs` reads the bounded strict native
`secret-tunnel-connector.json`, requires private regular files without link aliases, exact
configured name/origin and an optional private immediate-child `zrokHome`.
The enrolment is inside that private home's `.zrok2` directory. Only the zrok
child receives this home through `HOME` (Unix) or `USERPROFILE` (Windows);
the parent process, shell and user's global home remain unchanged. Tagged
[zrok v2.0.4's directory source](https://github.com/openziti/zrok/blob/v2.0.4/environment/env_v0_4/dirs.go)
has no `ZROK2_HOME` override.
Account credentials never enter serialized connection config or UI fields.
The imported listener mounts only `/t/<private-token>/mcp`, with exactly the
three Review tools; App controls, artifact downloads, alternate bearer routes
and local APIs are absent. No source tunnel is stopped or taken over
automatically. A live name collision must fail startup.

Restart restores the imported identity but no listener, manuscript shares,
App grants or activity. Stop/child death clears current grants. The same bearer
URL can access future explicitly shared manuscripts after a new start, which
is the tradeoff required to retain the existing connector address. Removing
the private imported profile while stopped restores the default rotating URL.
Native/fixture tests do not prove a real cross-PC Wormhole transfer, successful
zrok handover, or that ChatGPT refreshed the connector's tool catalogue.

## Non-content App controls

The separate session capability uses `/mcp/control/<secret>`, distinct from the
Review URL. Its current closed catalogue has shared-manuscript list/read,
`get_workspace`, `get_control_result`, safe manuscript opening/selection,
workspace/editor presentation settings, PDF view, fixed native window actions
and saved-source Typst compilation. `suggest_text` stays on Review. Artifact
export requires a further local permission, not implied by compilation.

`control.rs` bounds jobs, replay records, UI leases and acknowledgements;
`service/app_control.rs` enforces shares, current owner, revocation, saved
revisions and safe result projection. All-open-buffer state stays local; remote
workspace/results omit unshared IDs, previews and private acknowledgement
tokens. A rendered PDF for a different project main document must not be
attributed to a shared active chapter.

Local `control_enable`, poll/check/complete, bound read-only Open and Compile
callbacks use the separate internal `ControlOperation`. Tauri binds the actual
main window and validates the current editor owner nonce; the browser adapter
requires its UI bearer and page nonce. The CLI and public MCP routers cannot
invoke those callbacks. Callback payloads cannot choose an arbitrary native
operation, project path or replacement source.

Remote Open denies pending journals and returns a read-only snapshot without
recovery/migration. Compile uses the authorized saved source through the fixed
Typst compiler and never flushes editor buffers. New typing, composition,
conflicts or pending local operations veto relevant UI effects. Native Close
records `close_requested` before teardown, then rechecks every buffer through
the no-save close guard; lost acknowledgement/revocation cannot fall back to
ordinary autosaving Close.

Background local Review is also read-only and refuses pending journals;
explicit local Open retains recovery. Harmless observations can overlap App
view effects, while pending Open/writes and changed session generations,
revisions, navigation, queues, conflicts or IME state still veto them. The v3
native gate held a real Review response across Restore and checked its actual
window state. Separate native Close gates hold the completion response and
test successful teardown or revoked acknowledgement with restored protection;
see [the snapshot evidence](../reference-evidence.md).

Unsharing a manuscript revokes the entire App grant after releasing the share
lock. Re-sharing the same deterministic document ID does not resurrect old
jobs: re-enabling requires fresh local opt-in and a new secret/generation.
Stop, child death, owner replacement and origin/session changes also invalidate
the old App authority. Neither capability is an authenticated OpenAI identity.

Run `test:mcp-app-controls` against a matching immutable Rust binary and UI
build, plus the actual native App/window gate. The browser test uses a
synthetic zrok child and must assert source/policy/journal preservation,
private-buffer guards, replay/revocation and real UI acknowledgement. It does
not establish a live ChatGPT/zrok connection or native window effects.

The strengthened v3 browser gate exercises actual displayed effects and an
inactive dirty private buffer, including zero Save/editor-commit attempts,
unshared-main PDF redaction and unshare/re-share revocation. Native checks use
`tests/native-app-controls-smoke.mjs` and `tests/native-close-ack-smoke.mjs`
against matching bundled executables. The PDF-download implementation below
requires its own matching integration evidence; existing App opt-in must not
gain that permission silently.

## Separately permitted PDF downloads

`control_pdf_export` is an internal local-UI operation, absent from CLI and MCP.
It selects already approved project IDs and requires the expected App generation
and export generation. Native validation and the final permission commit check
both; a lost or delayed Apply cannot expand or re-enable newer consent. Even the
disabled export state has a fresh generation. The collapsed App section exposes
this explicit consent separately from App opt-in, with new roots unchecked and
native results authoritative. Lost acknowledgement requires a status refresh.

The permission explicitly includes current and future saved project inputs,
including unshared text/assets/fonts/data within selected roots; it excludes
unsaved buffers and other project folders. Source sharing alone does not grant
PDF access. Only a currently shared Typst manuscript with an exact existing,
verified current PDF is eligible. External package-cache inputs remain outside
this project-root permission and return `unsupported_scope`.

The closed App tool `get_pdf_download` takes `documentId`, `revision` and
`artifactId`; it never compiles, saves or substitutes a newer artifact. Eligible
App manuscript listings may expose bounded `savedPdf` metadata. `artifactId`
retains the existing base64-text hash convention; the download descriptor's
`sha256` hashes raw PDF bytes and its byte length is exact. Neither response
exposes local root paths, acknowledgement tokens or a generic filesystem API.
Review retains exactly three tools.

The dedicated `/artifacts/pdf/<ticket>/document.pdf` route supports GET/HEAD
on the public listener only. Tickets pin immutable bytes, expire after five
minutes and are bound to App/export generations, UI owner, shared document and
approved root identity. Limits include 16 MiB per PDF, 64 MiB retained bytes,
four tickets and two concurrent streams. Streams recheck revocation between
bounded chunks; bytes already transmitted cannot be recalled. Revoke exports,
App access, a share, the owner or tunnel session to invalidate old authority.
Modern MCP responses can include a `resource_link`; the older negotiated
protocol receives a text link. This does not claim automatic ChatGPT file
attachment support or live public reachability.

## Shared app gateway

The user explicitly requested one ChatGPT MCP connector for multiple apps on
multiple machines on 2026-10-16. This is a separate, locally enabled gateway
capability. Review keeps its three tools; the local operation registry remains
unreachable from every public endpoint.

**Connections → Apps** links exact existing Secret Tunnel, UnderTree or other
Streamable HTTP MCP URLs. An explicit local Link action authorizes that app's
current discovered tool catalogue. The gateway freezes it and assigns distinct
`app_` aliases, preserving the original input schema under `arguments` and adding
a gateway `requestId` for replay protection. The model selects an advertised
alias; it cannot register a URL, change grants, choose arbitrary upstream headers
or invoke an undiscovered tool. Each target app still enforces its own access.
An upstream tool/resource-list change or resource-update notification invalidates that link's catalogue, suppresses its
aliases and in-flight results, and requires a fresh local Link action. It cannot
silently expand an existing grant or replay a previously recorded result.
The gateway also provides local Review tools and, only under the existing local
App grant, `control_` aliases. `list_connected_apps` describes these targets.
It retains bounded upstream initialization instructions as app-scoped,
untrusted context rather than merging them into the gateway's own instructions.
Oversized aggregate app-context responses fail explicitly instead of truncating
those instructions.
The gateway also supports the reviewed Secret Tunnel `chat-control-v1` MCP Apps
card. A local Link freezes only the tool-referenced
`ui://secret-tunnel/chat-control-v1.html` resource and requires its exact reviewed
HTML SHA-256, `7e35bfaad18493b22beaf10653863c1548082d03507dda8f29f3aa19bf06f78d`,
before adapting it. Unsupported resource identities, changed HTML, binary
contents and resources above 512 KiB fail the link. Updating this pin requires
deliberate source/license/bridge review. The licensed static reference and
provenance are [test-only fixtures](../../tests/fixtures/mcp-apps/README.md), not
runtime or installer resources.

Tool UI references and frozen resource URIs receive distinct per-app aliases.
Gateway-only `resources/list` and `resources/read` serve these frozen payloads;
they cannot fetch an arbitrary upstream URI, file, template or prompt. The card's
two reviewed `window.parent.postMessage` call sites use an explicit bridge:
only the declared app-only `mcp_chat_decide` and `mcp_chat_receipt` aliases and
the card's existing UI handshake/context messages are forwarded. Each page
request ID keeps one bounded stable gateway call ID, preserving the existing
argument wrapper and replay checks. Unknown widget requests fail locally.
The card's private approval metadata, app-only tool visibility and resource CSP
are preserved; Secret Tunnel continues to authorize approval/receipt operations.
The bridge adds no Tauri capability or new folder/control grant. Host sandbox,
MCP Apps rendering and visibility enforcement remain the host's responsibility.
This is scoped card compatibility, not a generic hosted-app/resource API or
evidence of a live public ChatGPT card interaction.

The normal gateway has a separate `/mcp/hub/<secret>` capability. An explicitly
imported Secret Tunnel identity can reuse its original URL while the local
gateway is enabled; disabling it returns that URL to Review-only behavior and
revokes its local App grant. Copying a running app's URL links to that app.
Taking ownership of its zrok reservation additionally requires private enrolment
transfer and a deliberate single-owner handover. A copied URL alone cannot
create another live owner for the same reservation.

`mcp_hub.rs` owns the reusable Rust upstream client and link/call state;
`transport/gateway.rs` owns inbound capability, protocol and tunnel lifecycle.
The official Rust MCP SDK handles JSON and stateful SSE, session negotiation and
paginated tool discovery. TLS remains verified, redirects are disabled, and only
HTTPS or literal-loopback HTTP endpoints may be linked. Endpoint secrets remain
in native session memory and transient local form inputs, never browser storage,
automatically added app listings or diagnostics. Upstream-authored instructions,
tool metadata and results remain untrusted content and may contain their own
URLs; linking an app authorizes conveying that app's context. Links and grants
clear on disable, tunnel
death/stop and process restart; there is no background service or auto-grant.

Bounds include 64 linked apps, 512 upstream tools, at most 32 frozen cards within
the existing 2 MiB aggregate catalogue budget, 128 remembered call IDs,
2 MiB per result, 8 MiB cached results and finite discovery/call timeouts. JSON,
SSE and error bodies are bounded before parsing. Identical call IDs reuse the
recorded result; changed arguments are denied. Lost replies remain uncertain,
with no transparent retry, session reinitialization or tool replay. Removing a
link or changing the gateway generation suppresses late result delivery; it
cannot undo a target action already executed. App metadata/content is untrusted
data, not permission to expand tools or UnderTree's suggestion-only authority.
That authority is not an operating-system file sandbox: a separately authorized
upstream filesystem writer can bypass Review by changing the same source files.
Suggestion-only deployments must not grant that overlapping write access.

`tests/mcp-hub-smoke.mjs` is the integrated gate for real Rust routing to two
independent JSON/stateful-SSE fixtures, duplicate-name isolation, pagination,
uncertain effects and revocation. `tests/mcp-hub-ui-smoke.mjs` qualifies rendered
Connections behavior with a clearly simulated native API. Neither establishes
live cross-PC ChatGPT access; that requires the actual enrolled zrok endpoint
and target apps. The review policy gate is
`node tests/mcp-review-policy-smoke.mjs`, with rendered discard behavior in
`node tests/review-discard-smoke.mjs`.
`tests/mcp-imported-hub-smoke.mjs` checks imported same-URL switching and
revocation with a synthetic private identity, not real credential handover.

## Threat boundary and qualification

Protected assets are local manuscripts, acceptance decisions, project inventory and account credentials. Entry points are local IPC/loopback operations, MCP requests and setup fields. The public client is untrusted even when it knows the capability. Rust constrains names, origins, request sizes, source paths and proposal revisions. Existing limits include 128 KiB MCP bodies and 20 shared manuscripts. Native output is discarded rather than leaking unrestricted process logs. A bearer capability has no per-client identity; initialization/activity can be produced by any holder, so `externallyVerified` remains false.

Run the checks in [workflows.md](../workflows.md). Use disposable manuscripts and the synthetic child for local tests. Public qualification separately requires an enabled real zrok2 account/name, connecting the endpoint in ChatGPT, reading an explicitly shared manuscript, submitting a suggestion, observing it locally without source changes, accepting locally, and proving revocation. A build, screenshot, synthetic child or localhost initialization does not establish that public result.

ChatGPT setup text was checked on 2026-10-14 against [OpenAI's MCP quickstart](https://developers.openai.com/plugins/build/app-quickstart): Plugins → Add custom MCP server → paste URL/configure authentication → install → select in a new chat. See also [connection and testing guidance](https://developers.openai.com/plugins/deploy/connect-chatgpt). Availability and product labels can change; recheck official documentation when changing these instructions. No API key, ChatGPT session cookie or additional API integration is required by this endpoint implementation.
