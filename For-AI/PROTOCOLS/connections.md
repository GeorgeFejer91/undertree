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
| MCP tab | Complete private URL, copy with selectable fallback, protocol/tool catalogue, observed initialization, request time and tool-call count. These are local observations, not proof of ChatGPT identity or public reachability. |
| Manuscripts tab | All explicitly shared session manuscripts, project labels and individual revoke actions. Opening a folder or starting a tunnel does not share its files. |
| App controls tab | Explicit session-only opt-in, separate capability URL and status. No source/policy editing or indirect saves. It uses the current UI page's native owner epoch, independent of CLI and Review authority. |
| Stop | Revoke the capability, terminate only the owned child/listener, clear every session share. |
| Restart | Restore only public name/origin. No tunnel, capability, manuscript grant or MCP activity is restored. |

## Protocol and lifecycle

- Transport is stateless MCP Streamable HTTP: JSON-RPC POST, JSON response, Accept containing `application/json` and `text/event-stream`. Supported protocol versions are `2025-03-26` and `2025-06-18`. Initialize before tool use; send the negotiated `MCP-Protocol-Version` afterward. Browser Origin requests are refused.
- Review exposes exactly `list_manuscripts`, `read_manuscript` and `suggest_text`. Manuscript IDs come from the approved shared inventory. Source is untrusted data. Protection/rejection overrides prompts; acceptance, source saves, policy changes and synchronization remain local. Reads and proposals deny pending recovery journals instead of replaying a local save; only suggestion metadata may change on a successful proposal.
- A fresh random capability is generated for every successful session at `/mcp/<secret>`. The URL is a bearer capability, not OAuth or per-user authentication. Configure no additional authentication when attaching this endpoint. Anyone holding it can exercise the three tools against the shared manuscripts until revocation. Do not log, commit, put in browser storage or publish it.
- Validate public-name length/characters and HTTPS origin before touching live state. Reject paths, queries, fragments and userinfo. Reject duplicate starts without silently rotating a live grant.
- Launch `zrok2 share public http://127.0.0.1:<ephemeral-port> -n public:<name> --headless` directly, without a shell. Require two seconds of child survival. A process surviving startup still does not prove public connectivity. No automatic restart or takeover of unrelated shares.
- Only public name/origin are atomically saved to `connection.json` under the native review state directory. zrok account activation/credentials remain in the existing CLI's own store. UI status refresh is single-flight, every two seconds while the dialog is visible; it does not start processes or broaden grants.
- Detecting child death conceals its endpoint and clears shares. Every MCP request also checks child liveness and capability in Rust. Shutdown revokes the listener and owned child. Restart never silently resumes remote authority.

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

## Threat boundary and qualification

Protected assets are local manuscripts, acceptance decisions, project inventory and account credentials. Entry points are local IPC/loopback operations, MCP requests and setup fields. The public client is untrusted even when it knows the capability. Rust constrains names, origins, request sizes, source paths and proposal revisions. Existing limits include 128 KiB MCP bodies and 20 shared manuscripts. Native output is discarded rather than leaking unrestricted process logs. A bearer capability has no per-client identity; initialization/activity can be produced by any holder, so `externallyVerified` remains false.

Run the checks in [workflows.md](../workflows.md). Use disposable manuscripts and the synthetic child for local tests. Public qualification separately requires an enabled real zrok2 account/name, connecting the endpoint in ChatGPT, reading an explicitly shared manuscript, submitting a suggestion, observing it locally without source changes, accepting locally, and proving revocation. A build, screenshot, synthetic child or localhost initialization does not establish that public result.

ChatGPT setup text was checked on 2026-10-14 against [OpenAI's MCP quickstart](https://developers.openai.com/plugins/build/app-quickstart): Plugins → Add custom MCP server → paste URL/configure authentication → install → select in a new chat. See also [connection and testing guidance](https://developers.openai.com/plugins/deploy/connect-chatgpt). Availability and product labels can change; recheck official documentation when changing these instructions. No API key, ChatGPT session cookie or additional API integration is required by this endpoint implementation.
