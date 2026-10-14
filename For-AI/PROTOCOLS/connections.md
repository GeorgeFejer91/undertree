# UnderTree connection contract

Scope: the **currently implemented Review mode** in the Rust/Tauri manuscript workspace. One user opens **Connections** to manage one opt-in zrok2 share and its MCP endpoint. This protocol adapts Secret Tunnel's native authority, module ownership and explicit evidence structure. The user subsequently requested all UnderTree functions through ChatGPT; [the Full control plan](../PLANNER/CHATGPT-FULL-CONTROL.md) owns that broader target, including direct editing, decisions, settings and synchronization. It requires separate authenticated authority and is not yet implemented. UI rules have one owner: [ui-layout.md](../ui-layout.md).

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
| Stop | Revoke the capability, terminate only the owned child/listener, clear every session share. |
| Restart | Restore only public name/origin. No tunnel, capability, manuscript grant or MCP activity is restored. |

## Protocol and lifecycle

- Transport is stateless MCP Streamable HTTP: JSON-RPC POST, JSON response, Accept containing `application/json` and `text/event-stream`. Supported protocol versions are `2025-03-26` and `2025-06-18`. Initialize before tool use; send the negotiated `MCP-Protocol-Version` afterward. Browser Origin requests are refused.
- The only remote tools are `list_manuscripts`, `read_manuscript` and `suggest_text`. Manuscript IDs come from the approved session inventory. Source is untrusted data. Protection/rejection overrides prompts; acceptance, settings, Git and arbitrary filesystem/process operations remain local.
- A fresh random capability is generated for every successful session at `/mcp/<secret>`. The URL is a bearer capability, not OAuth or per-user authentication. Configure no additional authentication when attaching this endpoint. Anyone holding it can exercise the three tools against the shared manuscripts until revocation. Do not log, commit, put in browser storage or publish it.
- Validate public-name length/characters and HTTPS origin before touching live state. Reject paths, queries, fragments and userinfo. Reject duplicate starts without silently rotating a live grant.
- Launch `zrok2 share public http://127.0.0.1:<ephemeral-port> -n public:<name> --headless` directly, without a shell. Require two seconds of child survival. A process surviving startup still does not prove public connectivity. No automatic restart or takeover of unrelated shares.
- Only public name/origin are atomically saved to `connection.json` under the native review state directory. zrok account activation/credentials remain in the existing CLI's own store. UI status refresh is single-flight, every two seconds while the dialog is visible; it does not start processes or broaden grants.
- Detecting child death conceals its endpoint and clears shares. Every MCP request also checks child liveness and capability in Rust. Shutdown revokes the listener and owned child. Restart never silently resumes remote authority.

## Threat boundary and qualification

Protected assets are local manuscripts, acceptance decisions, project inventory and account credentials. Entry points are local IPC/loopback operations, MCP requests and setup fields. The public client is untrusted even when it knows the capability. Rust constrains names, origins, request sizes, source paths and proposal revisions. Existing limits include 128 KiB MCP bodies and 20 shared manuscripts. Native output is discarded rather than leaking unrestricted process logs. A bearer capability has no per-client identity; initialization/activity can be produced by any holder, so `externallyVerified` remains false.

Run the checks in [workflows.md](../workflows.md). Use disposable manuscripts and the synthetic child for local tests. Public qualification separately requires an enabled real zrok2 account/name, connecting the endpoint in ChatGPT, reading an explicitly shared manuscript, submitting a suggestion, observing it locally without source changes, accepting locally, and proving revocation. A build, screenshot, synthetic child or localhost initialization does not establish that public result.

ChatGPT setup text was checked on 2026-10-14 against [OpenAI's MCP quickstart](https://developers.openai.com/plugins/build/app-quickstart): Plugins → Add custom MCP server → paste URL/configure authentication → install → select in a new chat. See also [connection and testing guidance](https://developers.openai.com/plugins/deploy/connect-chatgpt). Availability and product labels can change; recheck official documentation when changing these instructions. No API key, ChatGPT session cookie or additional API integration is required by this endpoint implementation.
