# ChatGPT app control implementation plan

The later [AI highlighting and protected-passage requirement](../PROTOCOLS/connections.md#ai-highlighting-and-immutable-protected-passages)
adds one color-only Review action across UnderTree, Writer and Word. It does not
expand App controls or permit remote rule assignment. Earlier three-tool and
blanket suggestion-only wording below describes the preceding boundary; use
the current connection contract for Review behavior and qualification status.

User direction on 2026-10-17 adds a narrow Review exception: current locally configured prompt markers may authorize direct wording edits through `suggest_text`; suggestions remain the default. See [the connection contract](../PROTOCOLS/connections.md). This does not broaden this non-content App control plan. The earlier 2026-10-15 correction prohibited full file editing and superseded the 2026-10-14 general-authoring proposal. The historical filename does not authorize withdrawn generic mutation tools. The final product stack is Rust, Tauri v2, HTML/CSS and Typst, with a separately installable native UNO Writer extension.

The intended experience is to connect ChatGPT, explicitly enable session-only App controls, then inspect the approved workspace, navigate safe views, adjust bounded presentation settings, build saved snapshots, inspect/export artifacts and invoke guarded native window actions. Review remains a separate suggestion-only capability. Local UI and local CLI editing are not remote permissions.

## Modes and authority

| Mode | Permitted authority |
| --- | --- |
| Review | The existing `list_manuscripts`, `read_manuscript`, and `suggest_text` tools for explicitly shared manuscripts. Suggestions never apply themselves. |
| App controls | A separate, opt-in authenticated capability with named non-content actions for explicitly authorized projects and the current app session. It cannot reuse or upgrade a Review bearer. |
| Local desktop and CLI | Native editing/save/review workflows under their own caller context, revision checks and editor-session barrier. Their operations are never automatically exported to MCP. |

MCP App controls must reject direct source replacement, patching, formatting, undo/redo of content, saves/autosaves, source/asset creation/import/upload, rename/move/duplicate/delete/restore, accepting/rejecting suggestions, protection/prompt/palette policy changes, and synchronization that changes project sources. A raw API, CLI, shell, Tauri invoke, DOM selector, script or keyboard/mouse proxy is not an app-control tool. Tool descriptions and annotations do not replace native enforcement.

Application presentation settings are a closed set of validated names, enums and ranges. Credentials, executable paths, project-root approval, grants and endpoint authentication cannot be changed through a generic settings object. Changes that increase access require a real local owner action; the model cannot approve itself.

## Non-content contract

| Product feature | Required behavior |
| --- | --- |
| App/capability/project inventory and status | Bounded, grant-filtered IDs and revisions; no tokens, unapproved paths or credentials. Report implemented capabilities rather than a historical operation count. |
| Document/tree/review reads and search | Approved-root confinement and bounded results. Read-only MCP inspection does not create or migrate project sidecars. |
| Project/document/tab navigation | A distinct no-save path; reject if navigation would save, discard or reconcile dirty/conflicted/composing buffers. Never call an ordinary click handler merely because it usually navigates. |
| Selection, outline, search panel and review-card location | Named view actions bound to the exact document/session and revision; no replacement/format/decision payload. |
| Pane visibility/size, editor display, logs and dialogs | Closed presentation actions with actual UI acknowledgement, normal keyboard/accessibility behavior and real Pretext/layout checks. No generic DOM/CSS evaluation. |
| PDF page, zoom, fit and preview refresh | Apply to an identified artifact/view and report actual rendered state. Source or build completion alone does not prove preview application. |
| Compile and artifact export | Build an exact saved revision through fixed installed Typst profiles, leaving dirty buffers untouched. Preserve the last good PDF. Reject source writes, shell escape, arbitrary commands and implicit autosave. Return bounded job/artifact status and truthful stale/current results. |
| Native minimize/maximize/focus/close | Fixed actions with native acknowledgement. Remote Close must reject any condition requiring an implicit save or discarded buffer, and use an honest close-requested receipt before disconnection. |
| Connection status/revocation | Safe status and explicit revocation without credential output or grant expansion. Stop/revoke invalidates pending UI work and the old capability. The remote client cannot restart a fully stopped authority without a separately authorized local mechanism. |

Each action has a closed input schema, stable request ID, relevant expected state/session/revision and a bounded result. Identical replays return the recorded result; the same ID with different content fails. Native policy is authoritative for permissions and side effects. The UI owns view application and must acknowledge the actual result. An event dispatch or desired-setting write is not success.

Before navigation, compile or Close, recheck all affected buffers and composition both when preparing and when applying the action. A newer edit cancels/defer/rejects queued work. Builds use saved snapshots instead of flushing local text. Failed or disconnected UI acknowledgement must not trigger a fallback save, replacement or generic replay. Bind pending work to the capability generation and current document/view session; revoke it on stop, navigation or session replacement.

PDF download has an additional explicit local project-root permission. It is
off by default and covers the selected folders' current and future saved inputs,
including unshared files, while other roots and unsaved buffers remain excluded.
Native consent checks both expected App and export generations through commit.
`get_pdf_download` names an exact saved document/revision/artifact, never builds
or falls back, and returns bounded expiring immutable bytes. External package
inputs are outside this permission. See the [connection contract](../PROTOCOLS/connections.md#separately-permitted-pdf-downloads)
for scope, revocation and limits. Matching local browser, Linux native and HTTP
checks pass for the immutable v4 snapshot in [reference-evidence.md](../reference-evidence.md#integrated-pdf-export-and-native-checkpoint-2026-10-15);
live-public ChatGPT qualification remains outstanding.

## Shared authority and ownership

`modules/review/` remains the framework-independent Rust authority. `native/tauri/` hosts thin typed IPC, native windows and least-privilege capabilities. `modules/frontend/` owns save/session coordination; `src/` supplies narrow DOM adapters. Neither a browser callback nor the MCP transport is a second authority.

The Connections implementation owns `modules/review/src/control.rs`, `src/mcp-control.js` and `src/connection-manager.js`. Shared `lib.rs`, `service.rs`, `transport.rs`, native IPC and manuscript hooks require an exact handoff to their active owners. Do not duplicate editor/session state or weaken existing local revision/save rules to add app controls.

The desktop already hosts private local CLI discovery against the same `Arc<Service>`, with an instance-bound token, per-state process lock and API-only ephemeral loopback listener. Duplicate hosts and stale discovery are rejected. The separately invoked headless/browser qualification adapter remains explicit. Missing UI returns `ui_unavailable`; it cannot fabricate window/view success.

The local-only editor-save foundation uses a distinct service-enforced `LocalCli` context. `save <project> <path>` accepts no replacement text and requires a registered live buffer. Internal UI register/update/unregister/poll/commit/complete operations are absent from the CLI/MCP catalogues. Native-issued session IDs, monotonic generations, SHA-256 captures, composition/conflict checks and journal-linked durable receipts protect concurrent typing and lost acknowledgements. This work does not authorize MCP saves; its implemented state must be established by the current tests and capability contract before claiming support.

## Transport and authentication

Keep zrok2 supervision and the dedicated MCP listener. Preserve `/mcp/<secret>` as the closed Review capability, including its narrowly scoped color-only `highlight_text` extension. App controls need their own opt-in authenticated capability and revocation generation; never expose the private CLI/editor API, reuse a Review secret or derive authority from MCP session IDs, client names or forwarded headers. Shares/grants are session-only and stop/restart invalidates them. The configured public HTTPS origin must be exact and validated.

Use supported Streamable HTTP negotiation and truthful tool schemas/annotations. Validate MCP Origins, bound messages/queues/results and keep capability URLs and tokens out of logs, commits and diagnostics. Connection-process status is not proof of public reachability or client identity. Actual ChatGPT/zrok qualification remains mandatory.

The previous Full-control OAuth investigation is **research, not implemented support or a new requirement to install a provider**. If OAuth account linking is selected for App controls, use the current [OpenAI authentication contract](https://developers.openai.com/plugins/build/auth) and [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization). Prefer CIMD; that MCP revision deprecates DCR for new implementations. Require S256, exact callbacks, issuer/resource binding, approved scopes, bounded token/code state and grant-wide revocation. CIMD with public-client PKCE alone does not cryptographically prove OpenAI identity; mTLS verification must occur at the actual TLS edge, which the local zrok proxy has not established.

The researched embedded candidate is `oxide-auth` 0.6.1 plus `oxide-auth-axum` 0.6.0 for Axum 0.8. It supplies server primitives, not a complete MCP provider. Native owner authentication, CIMD/discovery, exact raw callback comparison during token exchange, scope-intersection enforcement, replay tombstones and refresh-family revocation still need implementation/conformance. Its [owner-consent interface](https://docs.rs/oxide-auth/0.6.1/oxide_auth/endpoint/trait.OwnerSolicitor.html) leaves authentication to the application. The Linux research option uses an OS Polkit agent through patched `zbus_polkit` 5.1.0 or later, application-specific `auth_self` without retained authorization and a trusted system-bus subject; UnderTree would not collect the OS password. See [Polkit](https://polkit.pages.freedesktop.org/polkit/polkit.8.html), [binding advisory](https://rustsec.org/advisories/RUSTSEC-2026-0278.html), [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html), [resource indicators](https://www.rfc-editor.org/rfc/rfc8707.html) and [revocation](https://www.rfc-editor.org/rfc/rfc7009.html). [Rauthy](https://github.com/sebadob/rauthy) is the larger researched alternative. No provider, account, Polkit integration or additional dependency has been installed by that investigation.

## Implementation and qualification sequence

1. Freeze the non-content inventory and closed action/result/error schemas. Preserve the exact Review catalogue, explicit local caller context and truthful capability discovery.
2. Finish local CLI/editor session coordination independently. Prove UI and CLI share one authority, preserve typing/IME/conflicts and reconcile lost acknowledgements. Keep that save operation unreachable from MCP.
3. Implement App controls in the reserved owning module, separate endpoint/grant and Connections UI. Test absent/wrong/revoked/expired capabilities, cross-project paths and explicit local opt-in.
4. Integrate no-save UI hooks and fixed saved-source compile/artifact actions. Require real acknowledgements, session/revision guards and bounded jobs. Assert source and policy bytes unchanged for every remote action.
5. Qualify real Tauri native behavior, layout, replay/revocation/disconnects and the packaged installer. Exercise dirty/IME/source races with remote navigation/compile/Close.
6. Run real ChatGPT over the configured zrok origin: inspect a shared manuscript, propose a change without applying it, control safe views, compile/export the saved source, then revoke. Verify actual artifacts/state and denial of every source-write route. A local mock or a catalogue entry does not satisfy this gate.

Record evidence in [reference-evidence.md](../reference-evidence.md) and product qualification in [VERIFICATION.md](../../VERIFICATION.md). Missing live credentials, platform tests or implemented actions remain explicit gaps, not product completion. The obsolete direct-edit scenarios are withdrawn; they must not reappear as acceptance requirements or agent tasks.
