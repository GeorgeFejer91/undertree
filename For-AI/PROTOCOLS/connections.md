# UnderTree connection contract

## AI highlighting and immutable protected passages

Later user direction, 2026-10-17, applies equally to **UnderTree, wrAIter for
LibreOffice Writer, and wrAIter for Microsoft Word**. Add a narrowly scoped
`highlight_text` Review action alongside `list_manuscripts`, `read_manuscript`
and `suggest_text`. This supersedes the earlier fixed-three-tool requirement
only for coloration. It also permits an authorized enclosing rewrite to move
intact protected passages under the preservation rules below. Neither exception
permits remote prompt, action, access-mode or permission assignment. These are
implementation requirements; this documentation change does not enable them.

### Coloration without authority

- After a complete, consented manuscript read, the model may identify arbitrary
  text types, such as citations, and mark the exact occurrences, including
  currently unhighlighted text. This exception authorizes marking only; it
  never authorizes wording changes to that text.
- A marking request names the shared document, current snapshot/revision and
  native prior-read witness, a request ID, and a bounded batch of exact quotes
  and host-defined UTF-16 ranges. It may request a fresh color or a still-neutral
  color ID. Native authority validates every range, quote, snapshot, grant and
  color at commit; reject an invalid batch without partial markings. Requests
  replay idempotently and cannot survive revocation or stale context.
- A fresh AI color has **no assigned function**: no prompt, action, suggestion
  access, direct access, discard behavior or implicit default rule. Neutral
  marks do not count as edit-authorizing coverage. Read responses and UI must
  distinguish neutral coloration from user-authorized prompt markers.
- The native host allocates a distinguishable unused color/identity within its
  existing palette bounds, or reports that no slot is available. Reuse is
  allowed only while that identity is still neutral; a concurrent local rule
  assignment makes the request fail. Never use a rule-bearing color, alias its
  identity, overwrite a configured slot or inherit permissions from its RGB.
- The remote schema and native implementation reject function/prompt/access
  fields and policy mutation attempts. AI may add neutral marks, but cannot
  remove, resize, recolor, rebind or obscure existing authority to weaken it.
  Overlapping visual marks preserve all underlying marker identities/rules;
  the UI must keep protection discoverable.
- Only an explicit local user action in the color-rule dialog can assign or
  change a function. A user asking the model to assign a rule is insufficient:
  there is no remote rule-assignment tool. Highlighting cannot accept proposals,
  save a draft/document, edit source wording, alter consent or invoke a generic
  native operation. Native host formatting/metadata changes remain unsaved
  until the ordinary local save; UnderTree uses its existing adjacent metadata.
- Enforce the same boundary at native Review, imported connector and frozen
  pairing/gateway routes. Extend only the explicit native Review allowlist;
  linked catalogues require local refresh/relink before the new alias appears.
  App controls and Writer project/GitHub tools cannot provide a policy bypass.

### Local rule access from the document

Double-clicking either a toolbar color box or a highlighted text snippet opens
the same local color-rule dialog. Provide an equivalent keyboard action. Opening
the dialog grants nothing; saving a rule remains a deliberate local action.
If several colors overlap at the clicked position, expose the applicable
colors/marker identities for explicit user choice rather than choosing an
edit-authorizing rule implicitly. Neutral AI marks can be configured this way.
Preserve separate snippet boundaries when multiple marks share one color.
Source, supported PDF highlights and native Writer/Word text use their owning
surface's geometry; an unlinked PDF mark never gains guessed source authority.

### Protected text inside an authorized rewrite

Protection is the highest-priority constraint. A protected snippet's exact text
must survive as one contiguous, unchanged unit; its position need not be fixed
inside a separately authorized enclosing rewrite. Apply this to Protect and
Reject changes, retaining their restrictive meaning. Prompts cannot override it.

- A single continuous protected highlight is one immutable unit, including
  internal punctuation, whitespace, citation order and grouped references.
  Three separately marked citations are three units, even with the same color
  or identical text. An enclosing prompt-marked paragraph may reorder those
  units while rewriting its authorized surrounding prose.
- Require valid user-owned prompt coverage for the entire enclosing edit range;
  neutral marks and protection alone grant no rewrite authority. Unmarked gaps
  remain forbidden. Suggestion-only overlaps still require local acceptance;
  direct edits require current complete local direct authorization. Discard
  cannot remove protected content and must be refused if preservation conflicts
  with its required complete deletion.
- Native authority must enumerate every protected unit intersecting the edit
  from current metadata. Require whole-unit inclusion; reject boundary cuts,
  stale/ambiguous anchors or unsupported host structures. Conflicting overlapping
  protected spans must remain intact together, or fail closed. A unit may move
  only within the same authorized enclosing replacement, never into unrelated
  text, another file or another document.
- Use native-issued identities and an explicit validated preservation mapping
  (for example, ordered protected-unit references among replacement prose).
  Reinsert original native text/rich-text objects; do not trust a model's claim
  of preservation or a substring search. Every original unit must appear once,
  without edits, splitting, merging, loss or duplication. Reject unknown,
  missing or repeated identities, injected replacement content for a protected
  unit and ambiguous matches between identical citation occurrences. Preserve
  fields, links, formatting and other protected native structure as well as text.
  Cardinality is by native unit identity: incidental matching words/substrings
  in new prose neither preserve a missing unit nor duplicate its native object.
- Retain and reanchor the same protection/group identities and applicable
  overlapping marker metadata after a move. Do not retire protection or grant
  new direct access as a side effect. Revalidate the final reconstruction at
  proposal admission, direct application and local acceptance, with the usual
  quote/revision/policy, read-witness, draft/IME/conflict and revocation guards.
  Local acceptance of a stale proposal cannot bypass protection. Until a host
  implements this proof, keep its conservative overlapping-edit refusal.

Example: yellow authorizes rewriting a paragraph containing three separate green
citation marks. After the user assigns green Protect, a rewrite may reorder the
three exact citations inside that paragraph. Deleting or changing any citation
fails. If all three citations were marked by one continuous green highlight,
their entire combined text and internal order must remain unchanged.

### Cross-target completion gates

The active implementation goal covers all three subprojects independently:

| Gate | Required evidence in each native host |
| --- | --- |
| AI classification/marking | Complete read, then batch-mark citations in previously unmarked and overlapping text using a fresh neutral color; source wording, existing policy and unrelated content remain unchanged. |
| No authority escalation | Neutral marks cannot receive suggestions/direct edits by themselves; rule-bearing colors, hidden prompt/access payloads, forged identities, concurrent assignment, stale reads, replay and revoked access are denied. |
| Local rule gestures | Toolbar and in-text double-click plus keyboard access reach the same dialog; overlap choice is explicit; only the user can save a rule. |
| Protected rearrangement | Separate citations can reorder inside an authorized paragraph in suggestion and direct modes; a continuous citation group retains its internal text/order. Duplicate text occurrences retain distinct identities. |
| Preservation denials | Changed, removed, split, duplicated, partially intersected or out-of-scope units fail; nested/conflicting protection, discard conflicts, forged mappings, Unicode and host fields retain exact protection. |
| Lifecycle and parity | Recheck at acceptance/application, local rule changes, Undo/Redo, save/reopen and revoke; preserve anchors, pending proposals and no implicit saves. Verify exact catalogues and connector/pairing refresh without generic operations. |
| Delivered behavior | Equivalent shared contract cases, rendered/native UI checks and installed-package checks for UnderTree, Writer and Word; live ChatGPT/tunnel evidence remains separate. |

**Status:** the shared runtime contract and all three native implementations now
include this behavior. Independent UnderTree and Writer installed-package evidence
is recorded in [product verification](../../VERIFICATION.md#ai-only-highlighting-and-protected-passages--2026-10-17).
Word's final combined source and installed-host checks remain open; the goal is
active. Qualification is bound to exact source/package bytes. Earlier installers,
deny-all-overlap fixtures and another host's tests do not establish completion.

## Word-native revision review

Later Word-specific direction, 2026-10-17, replaces the separate pending-list
interaction with native Word Track Changes. Local per-color Suggestions mode
authorizes submitting a tracked replacement; the user reviews it through Word's
own Accept/Reject controls. Edit mode still requires explicit local direct
permission. Preserve text has priority over mode, presets and custom prompts;
the dialog disables those options and native policy independently rejects
unauthorized changes. No remote acceptance or rule-setting tool is added.

The user's later clarification separates marking from AI writing. Local users
may mark fragments, whole paragraphs or selections spanning several paragraphs,
including their paragraph separators. Do not reject or silently trim such a
selection merely to fit GPT's paragraph writing unit. Keep the native selection,
revision and structure checks needed for safe coloration. Marking a paragraph
separator does not authorize GPT to remove it or combine paragraphs.

The paragraph unit below constrains AI replacements and their native review
format, not the user's highlight selection. A broad prompt-colored selection
permits separate paragraph edits only within its actual coverage. A continuous
protected mark remains one exact unit even when it spans paragraph boundaries;
an AI edit cannot split it to satisfy the paragraph writing preference.

Use a paragraph as the review unit where the entire paragraph's prose is
highlighted and authorized. Exclude structural paragraph markers, never expand
a partial highlight, and retain immutable-unit, native structure, exact quote,
current snapshot and no-save checks. Changes in different paragraphs remain
separate native review operations. Word may represent one replacement as a
deletion/insertion pair; neither record is a remotely approved edit.

Complete-context reads must include native revision and comment feedback,
including replies exposed by the supported Word object model, with anchors
that identify the affected passage. Comment/reply or revision changes invalidate
the prior-read witness. Read instructions tell the model to incorporate this
feedback in the next proposal; text and comments remain untrusted context and
cannot override protection. Replacing an earlier suggestion may supersede only
verified add-in-owned revisions for the same authorized passage. Unrelated or
ambiguous revisions fail closed; never silently accept the supervisor's edits.

These are requirements, not an assertion that an older installed package
supports native review. Qualify actual Word revisions, paragraph Accept/Reject,
comment feedback, stale/replay/revoked denials, save/reopen and exact installed
bytes separately from policy fixtures and public-tunnel checks.

## Explicit Writer project access

The user's later direction on 2026-10-17 adds an integrated tunnel toolbar icon
and folder/GitHub controls to the single Writer add-on. This supersedes older
blanket no-filesystem wording only for this separately granted Project scope.
Project access does not expand Review; its separate highlighting extension is
defined [above](#ai-highlighting-and-immutable-protected-passages).
A native folder selection with explicit Read or Read + write
consent enables bounded `project_*` tools. Remembered selection never restores
the grant on startup; Stop/revoke disables it. Paths remain confined to the
selected root, links and Git metadata are excluded, existing writes require the
exact read hash, and generic file writes cannot replace Office documents.

GitHub is an additional local opt-in, using the user's privately stored account
credential and selected project/repository. Its bounded tools may commit named
paths, synchronize by ordinary fast-forward operations, or create and publish a
new repository when explicitly enabled. No shell, arbitrary Git arguments,
force push, remote permission/account/root change or document-save tool is
exposed. Private tokens never enter MCP responses or process command arguments.
Qualification must separately cover root confinement, read-only/disabled/revoked
denials, stale writes, Git divergence and failure preservation. Local fixture
checks do not establish actual account login or a live GitHub publication.

## Native Word connection boundary

The additional Word target follows the same complete-context/highlighted-only
Review meanings. `modules/word/` owns its native COM authority, in-process MCP
endpoint, native dialogs and internal zrok child. It is one installed product
and never depends on another editor's process or credentials. It exposes only
the closed Review catalogue, including the required color-only `highlight_text`
extension above; no generic COM operation,
local dispatcher, document save, acceptance or policy mutation is remotely callable.

Word's Connections setup must include an ordinary clickable zrok account/help
link and short instructions for obtaining the account token, pasting it locally,
configuring the bundled connection, starting access and adding its MCP address
to the AI client. Link only to fixed public HTTPS destinations; never include a
token or document information in a link. The installed add-in already includes
the connection engine, so setup instructions do not require a separate CLI.
The current hosted account-token flow is described in the
[official zrok guide](https://netfoundry.io/docs/zrok/get-started/get-token/).

The UI must explain the two local decisions clearly. Starting the connection
opens transport without sharing a document. The document-access page previews
and grants complete read context for the active document, including unsaved
content; highlight rules independently determine edit authority. Document
Revoke withdraws that document's access. Stop / revoke stops the connection and
revokes all session grants. Reopening Word requires fresh document consent.

Word requires sequential bounded complete-story reads before an opaque native
context witness is issued. The witness binds document, text, policy, snapshot
and sharing epoch. Only currently highlighted main-body prose can be replaced;
other document stories remain context. Replacements use a native Word Undo
record and never save. Source edits, marker changes and external/native Undo
changes to persisted policy invalidate the relevant authority. Reopening or
reloading changed native metadata revokes sharing. Explicit local acceptance
can operate offline on a still-current proposal.

Its private Windows-user profile contains enrollment and an encrypted exact-share
cleanup barrier. A process exit, uncertain controller response or delayed cleanup
cannot authorize a replacement share; restored pending cleanup blocks Start
until exact retirement is verified. Only Word's own reservation can be reused.
The source/ABI/loopback/fake-process gates are separate from actual installed
Word, live zrok and actual AI-client qualification. See the Word evidence entry
in [reference-evidence.md](../reference-evidence.md).

Scope: **Review and separately granted non-content App controls** in UnderTree's Rust/Tauri manuscript workspace, plus **wrAIter** for native LibreOffice Writer and **wrAIter for Word**. Each program owns its independent MCP/zrok bridge and local **Connections** controls. User direction on 2026-10-17 permits direct wording edits only through current locally authorized prompt markers; suggestions remain the default. The later color-only and protected-unit requirements above supersede older three-tool and blanket-overlap wording. [The App control plan](../PLANNER/CHATGPT-FULL-CONTROL.md) still excludes source/tree/policy mutation, remote buffer saves and indirect autosave. A Review capability never upgrades into App authority. Source implementation does not establish integrated/native/public qualification. UI rules have one owner: [ui-layout.md](../ui-layout.md).

## Locally authorized marked edits

The [full-context, highlighted-only requirement](#full-manuscript-context-and-highlighted-only-changes)
below applies to both access modes. Read permission never grants edit permission.

Rules carry `accessMode: "suggestions"` by default, or `"direct"` for a local
prompt rule. The model cannot change access mode. The fixed `suggest_text` tool
may apply a proposal only when current direct prompt markers cover its entire
prose range and no overlapping suggestion-only rule requires approval. Current
protect/reject must remain intact under the protected-unit contract above;
unproven overlap and stale restrictive markers block it. Discard remains an
approval-required deletion. Revision, exact quote, prose/escape, editor-session
and save-journal checks are required on the native write path. Direct edits must
not overwrite an unsaved/composing/conflicted registered buffer; clean editors
adopt only a verified native direct-edit receipt. Replays cannot apply twice or
upgrade an earlier pending suggestion. Prompts guide wording; a color does not
mechanically prove that a proposed sentence follows its semantic instruction.

`modules/libreoffice/` supplies wrAIter as an installable Writer `.oxt`, not a fork of
LibreOffice. UNO owns document-local rules/bookmarks, exact ranges and mutations.
The required opt-in capability endpoint supplies complete active-document
context while permitting proposals/mutations only within highlighted ranges,
under the same [selective-editor parity contract](../product-goal.md#three-deliverables-one-selective-ai-editing-contract)
as UnderTree. Older marked-passages-only reads do not satisfy full-context
parity; complete context needs explicit local document-sharing consent and
separate qualification. The native popup controls sharing, suggestion approval and endpoint
revocation; it does not expose paths, shell commands or a general UNO API.
LibreOffice remains the document editor and UnderTree is not required.

## Independent connections and optional pairing

wrAIter owns its private persisted MCP identity, zrok enrollment/setup and child
supervision. Its public reservation is distinct from UnderTree's; neither
program may stop or take over the other's connection. No UnderTree executable,
running process or runtime file is required. Explicit local reconnect intent
may restore wrAIter's saved connection on Writer startup. Ordinary exit retains
that intent; explicit Stop/revoke blocks automatic restart until a new local
Start. Restoring transport or saved pairings never restores document sharing or
prior-read witnesses. Retained marker settings do not replace fresh sharing
consent at each target.

Pairing is optional in either direction: paste wrAIter's MCP URL into UnderTree
**Connections → Apps**, or paste UnderTree's MCP URL into wrAIter's **Pair another
program** controls. Each target retains its own complete-context, highlight,
approval and revocation authority. wrAIter imports only the target's explicitly
allowed native Review tools as frozen opaque aliases, with the new color-only
action requiring explicit local catalogue refresh; upstream gateway/peer aliases are ignored
to prevent recursive pairing. Pairing configuration stays local and grants no
generic endpoint, file, shell, policy or acceptance proxy. A pair works only
while its target is running and its current permissions allow the operation.

Reserved-name hygiene: reuse each app's saved reservation across starts and
tests; a stopped share does not release its reserved name. Do not allocate a
fresh persistent name for each retry. Tests that genuinely need a temporary
reservation must record ownership and release only that reservation after
verified share cleanup, unless it is deliberately retained for user delivery.
User-authorized cleanup must inventory current bindings and saved app references,
preserve assigned names, and recheck each explicit candidate before deletion.
Never remove a share or environment merely to free a name quota slot.

wrAIter 0.3.0 passed installed default-profile archive/toolbar checks and native
marking/settings gestures without source changes. Private packaged-broker restart
checks passed with synthetic callbacks, not UNO. Initial standalone public qualification
hit HTTP 409 at the 50-name reservation quota before creating any name/share.
The user's subsequent cleanup removed 42 unbound, unreferenced reservations,
preserving seven existing bindings and one name for wrAIter; that quota blocker
is cleared. The actual installed standalone public bridge passes 22 HTTPS
identity, catalogue, unshared-access and denied-tool/authentication checks.
Normal installed Writer restart also passes 26 public checks before any MCP
settings/Start interaction, with the same address/owner/configuration and no
shared documents. Actual ChatGPT client/model pairing remains unqualified.
See [verification](../../VERIFICATION.md)
for exact evidence and limits; earlier UnderTree-bridge receipts do not qualify
this standalone path.

## Full manuscript context and highlighted-only changes

User direction, 2026-10-17: the reviewing agent must receive the entire manuscript
the user is working on before making a proposal. Unhighlighted text supplies
context for meaning, terminology, argument, citations and consistency; it must
not be targeted for changes. This applies to pending suggestions as well as
locally authorized direct edits. A highlighted passage grants no authority over
the rest of its page, file or project. This requirement supersedes older wording
that permits suggestions anywhere in shared prose. This contract applies equally
to UnderTree, LibreOffice Writer and Microsoft Word. No host may substitute
marked excerpts for the required full-document context or grant broader writes
as a side effect of exposing that context.

- **Complete context:** identify the active manuscript and its main document,
  and supply its complete text across all pages and constituent chapters. For a
  multi-file manuscript, a single open source file is insufficient. Include the
  manuscript's necessary included text only within explicitly authorized local
  context sharing; do not enumerate or disclose unrelated project files, other
  documents, private PDF annotations or other apps. Context-only files remain
  read-only and do not become editable merely because they were read.
- **Snapshot identity:** expose which document, source revisions and policy the
  context describes. Do not silently save, discard or overwrite the user's
  draft to obtain context. A saved snapshot must be identified as saved;
  unresolved draft differences must not be presented as the user's current
  complete text. Direct edits retain the dirty/composing/conflicted editor
  barriers. Partial dependencies, extraction failures, size limits or incomplete
  pagination must not be reported as a complete read. Provide complete bounded
  retrieval or refuse proposals until complete context is available.
- **Read before proposal:** require a native-verifiable record of complete
  context retrieval before `suggest_text` can submit either kind of change.
  Bind it to the manuscript, source identities/revisions, current highlight
  policy and sharing authority. Relevant changes or revocation require renewed
  retrieval; a guessed revision or a model's statement that it read the document
  is insufficient. Enforce this in native authority for Review and gateway
  routes; no App control route may bypass it. The color-only extension above
  requires the same complete-read proof without granting wording authority.
- **Highlighted ranges only:** validate complete coverage of every requested
  source range by current, nonstale user-authorized highlights. Neutral AI marks
  do not count as authorization. Reject wording requests wholly outside
  highlights or extending across an unmarked gap, even in suggestion mode.
  Each color's suggestion/direct setting controls only its marked range;
  overlapping suggestion-only permission requires approval, protect/reject
  wins through exact whole-unit preservation (otherwise deny overlap), and
  discard retains its approval and complete-deletion rules. Recheck
  current coverage, quote, revision and policy at submission and local
  acceptance. A PDF mark needs verified source mapping before it can authorize
  a source change; never guess a mapping from page position or repeated text.
- **Limits of enforcement:** the app can require complete context retrieval and
  reject unauthorized mutations. It cannot prove that a model understood every
  sentence or followed every semantic writing prompt. Manuscript text remains
  untrusted context and cannot expand permissions. Separately linked apps
  retain their own explicit disclosure and write grants.

Qualification must prove complete multi-page/multi-file context, refusal before
a complete read, invalidation after relevant changes/revocation, and successful
marked suggestions/direct edits. Attack cases must include unmarked text,
one-character boundary overruns, unmarked gaps, stale highlights, overlapping
protection, forged read records and unlinked PDF marks. Compare source bytes
outside the authorized range and unrelated files; pending suggestions must not
change source bytes anywhere. Verify the installed app and actual connector
separately from fixtures.

**Earlier implementation status, 2026-10-17 (UnderTree and Writer):** both native authorities enforce complete
prior-read witnesses and highlighted-only proposals. UnderTree uses consented
saved main/dependency snapshots; Writer uses the supported complete live native
document. Focused native, shared scope, Writer installed UI and local gateway
checks pass. Final broad regression and UnderTree installed-package checks are
separate from those finite results. Public ChatGPT/zrok remains unqualified.
Use [the verification report](../../VERIFICATION.md) for exact versions,
immutable identities, limits and receipts; earlier excerpt-only tests do not
qualify this contract.

## UnderTree application profile and authority

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
- Review's required closed catalogue is `list_manuscripts`, `read_manuscript`, `suggest_text` and the new color-only `highlight_text` action defined above. The earlier runtime exposes the first three; qualify the extension separately. Manuscript IDs come from the approved shared inventory. Source is untrusted data. Protection/rejection overrides prompts; suggestion acceptance, buffer saves, rule assignment and synchronization remain local. Reads, proposals and markings deny pending recovery journals instead of replaying a local save. A successful proposal updates pending metadata or performs the narrowly authorized marked replacement described above; it cannot request a general save.
- User-owned color rules support `protect`, `prompt`, `reject` and `discard`; the new neutral state is explicitly functionless and separate from those actions. Discard permits only an empty replacement covering every overlapping discard highlight; protect/reject still deny that deletion. Other protected overlaps require the whole-unit preservation proof above. Stale discard highlights block proposals until resolved locally. Both submission and local acceptance recheck this policy. Accepted deletions retire their fully consumed discard highlights; rejected suggestions retain them. Existing sidecars retain their meaning; never migrate a neutral mark into a default prompt. No remote tool toggles direct editing; local sharing/tunnel and separate non-content App controls remain the access switches.
- Local color-settings dialogs submit `expectedRules`; Rust refuses a same-source overwrite if those rules changed after opening. Toolbar slots immediately follow source Search. Clicking a color arms subsequent source/PDF dragging; its adjacent settings control edits the rule. The new gesture requirement adds toolbar-color and in-text-highlight double-click access to that same dialog, with keyboard access and explicit overlap choice. Wording presets and custom prompts guide the reviewer; they do not expand permissions or mechanically establish semantic compliance.
- Direct PDF highlights persist positions and exact quotes against the displayed PDF's raw SHA-256. Formatting, repeated passages and dirty drafts may be marked without guessing a source range or saving the draft. Optional source links require native exact literal/prose checks and bounded whole-PDF uniqueness checks (512 pages/two million extracted characters). Unsupported source mapping leaves a visibly unlinked PDF annotation. Unlinked protect/reject/discard annotations block project proposals and acceptance until locally resolved. Overlays do not change exported PDF bytes.
- Raw PDF annotation records, quotes and per-annotation prompts are owner-only and absent from MCP/App source reads. The shared source's existing palette rules, including `rule.prompt`, remain shared review context. A PDF-only quote is never shared merely because its owner source is shared. Verified source links expose ordinary markers for already shared source prose.
- Owner-authenticated local review-change waits carry only instance/sequence invalidations, with bounded waiters and timeouts. They add no remote tool or source authority. The UI reads current metadata after an invalidation, preserving unsaved content and source identity; new pending wording remains subject to local Accept/Reject. The new color-only action is a separate explicit catalogue change, not authority provided by notifications.
- Suggestion-only enforcement applies to UnderTree's own Review, App and gateway-dispatched UnderTree tools. A separately linked app with independent filesystem, command or editing grants retains those grants. The UnderTree Review capability does not constrain another app or every tool available to GPT.
- By default, a fresh random capability is generated for every successful session at `/mcp/<secret>`. The explicit imported-connector exception below preserves the existing bearer address. The URL is a bearer capability, not OAuth or per-user authentication. Anyone holding it can exercise the enabled closed Review catalogue against shared manuscripts until revocation. Do not log, commit, put in browser storage or publish it.
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
The imported listener mounts only `/t/<private-token>/mcp`, with the closed
Review catalogue, including the required color-only extension above. App controls, artifact downloads, alternate bearer routes
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
PDF permission does not expand Review's closed catalogue.

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
capability. Review keeps its closed native catalogue; the local operation registry remains
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
