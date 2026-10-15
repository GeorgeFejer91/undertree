# Reverse-engineering behavior for UnderTree

Use this protocol when a requested answer depends on a shipped artifact, decompilation, a running application or a comparison between versions. Its instruction dependency is the nested [Reverse Engineer Anything skill](../skills/reverse-engineer-anything/SKILL.md). [skills.md](../skills.md) owns version provenance, skill order and the For-AI control-plane adaptation.

For behavior established by a complete source checkout, use ordinary source searches, focused reads and existing tests. The pinned Overleaf public-source baseline and current UnderTree source follow this route. A remaining runtime question can then use REA on the specifically selected application. Installing or reading a skill does not establish that an app was observed.

## Select the question and target

Write the observable question first: trigger, initial state, action, result and failure/edge cases. Resolve the actual application, package path, version or existing runtime endpoint from the user's request. If the user names only "my app" and there is no selected target, ask which app; do not choose a nearby fixture or a path from an unrelated report.

Record the target's canonical path and artifact SHA-256, or the running build identity and selected target/endpoint. Preserve the source commit and relevant file ranges for a source-only answer. Reuse matching saved evidence before repeating analysis.

| Target or evidence needed | Initial REA route | Read only the relevant guide |
| --- | --- | --- |
| Supplied ASAR or extracted Electron/JavaScript artifact | `analyze_javascript_application`; request summary for large targets when the schema supports it | [JavaScript applications](../skills/reverse-engineer-anything/references/javascript-applications.md) |
| Native executable/library or ZIP/APK/IPA/MSIX/AppX/DMG inventory | `open_binary`, then focused analysis or artifact inventory; choose an available native provider when needed | [Native and packaged artifacts](../skills/reverse-engineer-anything/references/native-and-artifacts.md) |
| Managed assembly | `inspect_managed_artifact` | [Native and packaged artifacts](../skills/reverse-engineer-anything/references/native-and-artifacts.md) |
| Android code and references | `inspect_android_package`, then advertised focused tools | [Android applications](../skills/reverse-engineer-anything/references/android-applications.md) |
| User-owned browser or Electron runtime already open | `list_browser_targets` or `list_electron_targets`, then the selected passive observation | [Runtime observation](../skills/reverse-engineer-anything/references/runtime-observation.md) |
| Browser actions the agent must perform | `capture_browser_scenario` with explicit target, start URL and declared actions | [Runtime observation](../skills/reverse-engineer-anything/references/runtime-observation.md) |
| Version comparison or static/runtime reconciliation | Analyze each exact target once, then use the advertised comparison/reconciliation tool with its returned evidence | [Evidence workflows](../skills/reverse-engineer-anything/references/evidence-workflows.md) and the relevant artifact guide |
| Firmware, recorded traffic/crashes/signals, WASM, EVM, Go/Rust metadata or SQLite snapshot | Use the explicit target-free route in the nested `SKILL.md`; read its linked provider/format requirements | [Complete target router](../skills/reverse-engineer-anything/SKILL.md) |

Tool names here are routes, not a claim that the current connection advertises them. Use the connected server's actual schemas and availability. A missing provider limits the route that requires it; static JavaScript does not require a native decompiler.

## Investigate and retain evidence

1. Load REA and the relevant guide. If its tools are connected, go directly to the selected target. Diagnose only an observed connection/provider blocker through [connection and recovery](../skills/reverse-engineer-anything/references/connection-and-recovery.md); preserve its reviewed setup/approval boundary for configuration writes. No per-investigation setup or unrelated tool installation is required.
2. Start with the smallest inventory or summary that answers the question. Trace a concrete string, route, IPC channel, function or state transition; expand only for a specific remaining gap. Source selections, pagination and truncation bound conclusions.
3. Reuse retained Evidence IDs for module views and traces. Export before closing a session when evidence must survive it. Record exact identities and limitations; static strings, handler registrations and graph relationships do not prove execution or causation.
4. Observe runtime only when the question needs it and the target/lifecycle is within the requested scope. Passive observations do not click or execute page JavaScript. Agent-driven actions must use declared scenarios; connect-mode navigation can replace temporary page state. A browser capture does not qualify native Tauri window behavior.
5. Separate observations, inferences and unknowns. For version comparisons, incomplete opposite-side coverage cannot establish absence or equivalence. Do not label all reached graph nodes as participants in a feature.
6. Place raw JSON evidence, exports, screenshots, captures and reconstructed/generated output in an investigation-specific directory under ignored `artifacts/reverse-engineering/`. Commit only deliberately reviewed, minimal fixtures through the owning test workflow. Keep credential/capability values out of tracked findings.

For an explicitly supplied JavaScript artifact, the upstream CLI fallback is:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/artifact --json
```

Prefer an existing `rea` CLI. `npx` can download a package and update npm's cache; use it only within the authorized investigation. Retain the actual CLI version with the output. This fallback does not register MCP. The snapshot can describe features absent from a published release, so inspect the actual CLI/tool surface. Save raw output under the ignored artifact directory, not in this Markdown control plane. Do not run this command merely to analyze UnderTree's complete source tree.

## Apply findings to UnderTree

Translate each supported finding into an observable acceptance case before implementing it. Keep the reference behavior separate from an UnderTree design choice, adaptation or unsupported surface. [module-map.md](../module-map.md) remains the ownership authority:

| Behavior being reconstructed | UnderTree owner and acceptance boundary |
| --- | --- |
| Workspace navigation, panes, review cards, PDF controls and editing interactions | `modules/frontend/` for state and `src/` / HTML for DOM adapters; apply [Overleaf parity](../overleaf-ui-parity.md), [UI layout](../ui-layout.md), Uncodixfy Pretext and rendered interaction checks |
| Revision, protection, acceptance, persistence, Typst, import, Git or authenticated MCP behavior | `modules/review/`; reuse the one Rust authority and test allowed, denied, stale and failure paths. Reference behavior cannot expand Review-mode grants or enable planned Full control |
| Native dialogs, window lifecycle, Close/Minimize and typed IPC | `native/tauri/`, or the retained Windows adapter where applicable; qualify actual native behavior separately from browser observations |
| Retained TeX compiler/service scheduling or process behavior | `modules/compiler/` and its established adapters; preserve offline operation, save guards, explicit builds and the last good preview |
| Analysis/verification automation and packaging | `modules/maintenance/` and its command adapters; no executable or runtime dependency under `For-AI/` |

Inspect upstream licensing before copying code or assets. The existing Overleaf reference policy uses independent implementation and a pinned baseline; a REA result does not change that boundary. Keep the original evidence and unknowns when adapting behavior to Typst or UnderTree's native authority.

## Findings and completion gate

Use [reference-evidence.md](../reference-evidence.md) as the canonical findings ledger. For each relevant claim, record target/version/digest or source revision, observed behavior, evidence type and exact Evidence ID/source range, coverage/limitations, the UnderTree owner and acceptance result, and remaining unknowns. Link raw ignored artifacts by relative path for the local investigation; do not claim those files travel with a fresh clone.

Before closing an investigation, revisit each requested question and mark it answered, partial or unresolved. Run the normal focused checks from [workflows.md](../workflows.md) for any implementation. Use `VERIFIED`, `PARTIAL`, `BLOCKED` or `NOT RUN` with a named gate. A build or unit test cannot substitute for rendered parity, a live connection or native integration. Close any native REA session opened for the completed investigation.

Example task requests:

- "Use REA to explain how this supplied Electron package preserves editor state when switching files; retain evidence and map findings to UnderTree's frontend owner."
- "Compare the two supplied application versions' review behavior and report evidence, coverage limits and UnderTree acceptance cases."
- "Inspect the pinned public Overleaf source for pane behavior first; use runtime observation only for the specific interaction the source cannot establish."
