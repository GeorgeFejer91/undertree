# wrAIter

<img src="../../assets/wraiter/icon.svg" width="64" height="64" alt="wrAIter AI waiter and typewriter logo">

The approved icon identifies the toolbar, Extension Manager and native add-on
windows on Windows. [Package guide](../../docs/downloads.md).

wrAIter is the separately installable selective AI editor for LibreOffice Writer.
Its `.oxt` adds the shared selective-editor controls and its own persisted private
MCP/zrok bridge. UnderTree does not need to be installed or running.
Writer keeps its native editor, formatting, storage and undo stack. No suite
fork, Java or pip dependency is required. LibreOffice 7.6+ with Python UNO is
required; the suite is an external dependency rather than extension contents.

## Install

```powershell
python modules/libreoffice/build.py
```

Choose **Tools → Extensions → Add**, select
`artifacts/libreoffice/wrAIter.oxt`, and restart Writer. The **wrAIter**
menu/toolbar button opens the selective editor.
The adjacent tunnel icon opens **Connections** directly.
Use `--zrok-executable PATH` when building to bundle the supported zrok2 binary,
or select an existing supported executable in connection setup. Legacy internal
extension/module IDs remain unchanged for compatibility.
Use `--git-archive PATH` with the pinned MinGit 2.56.0.2 x64 archive to include
Git in the same Windows add-on. The build checks the exact upstream SHA-256;
it preserves the complete runtime and its included licenses. No separate
Secret Tunnel application is required. Without that build option, GitHub tools
require an existing Git installation; document editing and folder access do not.

## The shared flow

All three editors consume `modules/review/selective-editor-contract.json`; the build
copies it into the extension. It owns the four default colors, labels,
behavior/access choices, presets, limits and shared acceptance scenarios.
Native window chrome and document rendering differ.

1. Use the native toolbar's four color slots. **+** adds a color rule and
   **Next colors** pages through up to 24 rules. Single-click a color to mark
   selected prose; with no selection, it arms that color for marking. **Escape**
   disarms it. Double-click a color to open **Edit color rule** without creating
   an accidental mark. With a color focused, **F4** or **Shift+Enter** opens its
   settings. In the document, double-click a highlighted snippet or use
   **Ctrl+F4** with the caret inside it to open the same rule dialog. Overlapping
   highlights require an explicit color/marker choice.
2. Choose **Color**, **Rule name** and **AI behavior for marked text**: follow
   wording instructions, protect text, reject AI changes, or suggest complete
   passage deletion. Tick wording presets and/or enter a **Custom prompt**.
   Presets include Shorten, More detail, Make snappier, Reduce redundancy,
   Make more parsimonious, Make style more grounded, Straightforward reasoning,
   Fewer positive adjectives, Less flowery language and Omit em dashes.
   Protection disables the preset, custom-prompt and edit-access controls.
3. Under **Access for this color**, choose suggestions requiring approval or
   direct edits within highlights. Suggestions are the default. Protect/reject/
   discard cannot grant direct access. **Save color rule** updates every mark
   using that rule, including visible colors.
4. Select prose in Writer and use **Highlight selection**. **Highlight passage**
   shows the text, **Color rule** and optional **Additional prompt for this
   passage**. **Add highlight** stores the native bookmark and instruction.
5. Open **Connections** and configure **Writer's own zrok setup** with a dedicated
   public name and enabled zrok account. Choose **Start access**, then enable **Share complete
   document for context; edits stay inside highlights**. Review **Share manuscript
   context**, including the current document/snapshot and complete text-container
   inventory, then choose **Share context**. Cancel leaves it unshared.
6. **Copy MCP address** and connect ChatGPT to wrAIter's own public endpoint.
   UnderTree can be closed. Optional **Pair another program** accepts UnderTree's
   MCP URL; the reverse direction uses UnderTree **Connections → Apps** with
   wrAIter's URL. Pairing does not share documents or change either target's
   permissions. A paired target must be running to use its tools. Older saved
   pairings stay disconnected until you reconnect locally to approve the four
   Review tools. Later catalogue changes also require local reconnect; remembered
   addresses and labels are preserved. An unchanged approved catalogue may
   reconnect on startup, without restoring document sharing.
7. AI must read complete current context before proposing. **Pending suggestions**
   do not change document text. **View suggestion** shows complete before/after;
   **Accept** revalidates and applies locally; **Reject** leaves text unchanged.
   This is a separate approval queue rather than native Track Changes.

## Project folder and GitHub

The tunnel icon opens one native **Connections** window with **Document review**
and **Project & GitHub** pages. Its fonts/colors follow LibreOffice and its
measured layout stretches both dimensions without a panel scrollbar.

Choose a folder on **Project & GitHub**, select **Read** or **Read + write**, then
click **Allow folder access**. Choosing a folder alone grants nothing. These
tools list directories in bounded pages, read complete UTF-8 text files up to
256 KiB with their SHA-256, and write ordinary text only with the exact read
hash (or explicit `null` for a new file). Parent directories must already exist.
Links, Git metadata and Writer private state are excluded. Generic writes cannot
replace Office/PDF files or currently open Writer files, including plain text
and HTML documents. Use the native highlighted editor for those documents.

**GitHub…** accepts a personal access token in a masked field and the exact
`owner/repository` and branch. Leave the repository blank only when preparing
to create a new one. The token stays in Writer's private user profile; it is
never returned to MCP or included in Git command arguments. Saving it grants
nothing. **Enable GitHub writes** additionally requires active folder Read +
write access. Ordinary repository writes require token Contents access;
creation additionally requires Administration or Repository creation access.
See [GitHub's token documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
and [repository creation permissions](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user).

GitHub tools commit explicitly named files, synchronize the configured branch
without force, and create a personal repository with explicit visibility. They
preserve staged/dirty/diverged work and require local resolution. Existing
origin/branch identity must match; linked repositories, submodules, custom Git
helpers/filters/hooks and other unsupported configuration are refused. Incoming
sync cannot overwrite Office/PDF or open Writer documents. Stop/revoke disables
all grants; restarting remembers folder/account choices but restores no grant.
Refresh the AI client's tool list after granting or revoking these scopes.
**Attach saved repository** explicitly initializes the chosen folder or adds
its missing origin from the saved connection, without contacting GitHub or
changing project files. It leaves GitHub writes off and refuses a conflicting
origin. For existing remote history, use its existing local clone; divergent or
unrelated histories require local resolution.

The Windows package includes unchanged [MinGit 2.56.0.2](https://github.com/git-for-windows/git/releases/tag/v2.56.0.windows.2),
SHA-256 `da35e72aa21c005a5a0d298cfbae110bc1609a815730ea0dde84b01a1b3cd3be`.
Its GPLv2 and component notices remain under `git-runtime/`; the matching
[upstream source archive](https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/Git-2.56.0.2-64-bit.tar.bz2)
is separate from the add-on's Python source. Local fixture tests do not establish
a live GitHub login, publication or synchronization.

Editing targets are highlighted main-body prose. Fully highlighted subranges
and adjacent highlight unions are supported. Unmarked gaps, boundary overruns
and plain string replacements crossing protect/reject units are denied.
An authorized enclosing prompt rewrite can preserve and reorder whole protected
units using exact native-issued `protectedId` references. Overlapping suggestion permission forces
approval. Discard requires empty replacement covering every overlapping discard
range and always awaits approval. Extra passage prompts cannot expand access.
The app cannot prove that a model understood semantic writing instructions.

Changes consume touched permissions. Undo does not reactivate them; remove and
re-mark locally. Separate current editable ranges remain usable. Stale
protection/discard blocks proposals until resolved. Native Undo/Redo keeps rule
colors and bookmark metadata synchronized. New wording inherits native range
formatting. Protected units are copied through bounded native ODF fragments,
including mixed character styles, links and bibliography fields; their exact text
and native structure are checked again before the original IDs reanchor.
Conflicting overlapping protection, embedded objects, foreign bookmark identities
external-data fields and event-bound fragments fail closed. No system clipboard or external file is used. Resolve
existing native Track Changes before marking or replacing prose.

## Complete context and prior-read enforcement

Context is the current in-memory document, including unsaved text. Reading
never saves/discards it. Complete native text includes body paragraphs, table
cells, page-style header/footer variants, footnotes/endnotes, text frames, native
drawing text, native comment contents, graphic alternative text and cached field presentations. Fields are not updated and external
files/documents are not followed. Unsupported embedded/text containers or bounds
refuse complete retrieval and therefore proposals. Graphic objects are counted
as non-text objects; figure pixels are not OCR'd.

The native MCP catalogue contains exactly `list_manuscripts`, `read_manuscript`,
`suggest_text` and color-only `highlight_text`. Optional pairing adds only frozen aliases for another
editor's native four Review tools; other gateway aliases are not imported.
Reading returns `snapshot: "live"`, `context.complete: true`, complete
`context.files`, editable body `content`, UTF-16 highlight ranges, revision and
opaque `contextId`. Other documents and local filesystem paths are unavailable.
Unhighlighted text, tables, headers, notes, frames and drawings are read-only
context. Reading them never grants editing permission.

`suggest_text` takes `{documentId, proposal}`. The proposal contains `requestId`,
`revision`, `contextId`, UTF-16 `from`/`to` offsets in body `content`, exact `quote`,
`replacement` and `rationale`. Native authority requires a completed full read
bound to document/session/revision/policy/share/endpoint. Guessed/old tokens do
not grant access. Relevant changes or revocation require renewed retrieval.

For a protected overlap, `replacement` must be empty and optional
`replacementParts` must name every intersecting native protected identity once,
interleaved with `{text: ...}` prose. Each `{protectedId: ...}` reinserts the
original native rich fragment. Partial, stale, missing, repeated and out-of-scope
identities fail at proposal, direct application and local acceptance. Movement
requires one current enclosing prompt marker; crossing partial prompt overlays
without one enclosing marker remains unsupported. Protection
alone and neutral color never authorize the enclosing rewrite.

`highlight_text` takes `{documentId, marking: {requestId, contextId, revision,
colorId?, ranges: [{from, to, quote}]}}`. Batches contain 1–64 ordered, disjoint
exact UTF-16 main-body ranges with at most 32768 quoted characters. Missing
`colorId` allocates a distinguishable unused neutral color; a named identity must
still be functionless. Color-only marks have no prompt and grant neither
suggestions nor direct edits. Only a local user can save a color function.
Unknown rule/access fields are rejected. The native atomic batch preserves
wording and every existing marker, supports Undo/Redo, and never saves.
Repeated IDs return their recorded result without adding marks; changed
arguments, stale context, active typing and revoked sharing fail closed.

All document access runs through Writer's UI-thread asynchronous callback. HTTP
threads never access UNO documents. Remote direct requests also refuse while
the document window/canvas has focus: finish typing and move focus to the review
popup or ChatGPT so native preedit can commit. Immediate revision/quote checks
and exact comparison outside the permitted replacement guard the native edit.
Writer's live model is its authority; this differs from UnderTree's saved-source
buffer barrier and does not claim a generic external IME-composition API.

## Persistence and revocation

Ordinary Writer saves retain rules, bookmarks, passage prompts and pending
suggestions in ODT metadata. Proposal creation updates review metadata in memory,
never document text or the saved file. Reopening restores proposals against
exact full-text/policy hashes; changed ones remain stale. Local approval never
restores sharing. Restored proposal IDs cannot be overwritten remotely. Incoming
proposals preserve the selected suggestion. Local acceptance safely refreshes
only disjoint unchanged queued proposals after its own edit. Revoking remote
access leaves current local suggestions reviewable; already stale suggestions
stay stale. Other source/policy changes
invalidate them.

ODT is the persistence target. Foreign formats may lose bookmarks/metadata;
missing anchors fail closed. Highlight appearance alone never grants permission.
Removing a marker keeps ordinary highlight formatting.

Private connection setup, identity, pairings and reconnect intent are retained
in the Writer profile. Writer can restore its own MCP/zrok connection and saved
pairings at startup without UnderTree. Ordinary exit preserves connection intent;
**Stop / revoke** prevents automatic restart until a new explicit local Start.
Remembered connection intent never restores document sharing, read witnesses or
permission to change text. Closing a document revokes that document's access;
ordinary connection-dialog closure is not a Stop action. Each reopened document
needs fresh sharing consent and a complete read before proposals. No save,
policy, shell, generic filesystem or other-document MCP operation exists.

## Bounds and verification

wrAIter 0.3.0 passed installed default-profile checks: all 22 archive entries
matched, the toolbar was visible with layout lock count zero, and actual
single/double-click, arming and keyboard-selection checks preserved source text.
The 72 pure tests passed before a label-only Close correction. A private packaged
broker restart retained URL/owner identity, fresh unshared state and read/Host
denials using synthetic callbacks, not UNO. Initial standalone public testing
stopped at HTTP 409 (50 reserved names) before creating a name/share. Subsequent
user-authorized cleanup reduced the count to eight, preserving all seven
existing bindings and one reservation for wrAIter; the quota blocker is cleared.
The actual installed standalone bridge now passes 22 public HTTPS identity,
catalogue, unshared-access and denied-tool/authentication checks.
Automatic public reconnection after normal Writer restart passes 26 checks
without opening MCP settings or pressing Start; the address/owner/configuration
remain unchanged and documents stay unshared. Actual ChatGPT client/model
pairing remains unqualified. See [verification](../../VERIFICATION.md) for
evidence and limits; the older versioned results below used UnderTree's bridge.

Bounds: 24 newly configured rules (legacy metadata is preserved), 500 highlights/
pending proposals/receipts, 64 read witnesses, two million body characters,
32768 characters per replacement, 2 MiB per protected native fragment / 8 MiB
per reconstruction, 128 native paragraphs per protected unit, 2 MiB review metadata, and 512 KiB/1024 parts
of native text. The actual nested MCP response is measured before recording a
read witness and must fit 1.5 MiB. Quote-heavy/multibyte overflow is refused,
never truncated. Requests are capped at 1 MiB; connections/UI requests at eight.
The listener binds literal loopback, checks Host, rejects browser Origins and
uses random capabilities plus exact endpoint identities.

```powershell
python -m unittest discover -s modules/libreoffice/tests -p 'test_*.py' -v
python modules/libreoffice/build.py
```

`tests/uno_smoke.py` documents disposable UNO test-profile startup. Its native
cases exercise shared UTF-16 ranges/unions, complete containers, prior reads,
stale context, response bounds, durable pending, rollback, immutable protected
reordering (including distinct identical occurrences), native Undo and the
actual settings/highlight/consent controls. `--extension-check` checks protocol
registration. `tests/uno_highlighting_smoke.py` separately exercises neutral
coloration, rule escalation denials, rich-text/bibliography-field preservation,
Undo/Redo, save/reopen and revocation. Version 0.2.1 was installed into a disposable LibreOffice 26.8.1.1
profile and every installed package entry matched the built archive. Actual
Windows toolbar/menu interaction confirmed the color order, readable labels,
populated dropdowns, presets, access choices and suggestion view. Accepting the
synthetic suggestion changed only its marked passage, consumed its permission,
and left the saved ODT hash unchanged. Receipts are under ignored
`artifacts/libreoffice/` (`native-qualification.json`, `installed-byte-audit.json`
and `installed-ui-result.json`). Public ChatGPT/zrok remains a separate
qualification gate. Native widgets use platform fonts and a minimum outer size,
with extra space between ordered groups; Writer makes no HTML/Pretext claim.
Native rendered keyboard/focus, enlarged fonts and installed controls require
their own evidence.

Version 0.3.1 uses the same native measured stretch layout for all eight
extension dialogs: the selective-editor panel, color rule, highlight,
connections, zrok setup, paired programs, suggestion preview and context
consent. Defaults are compact, labels and inputs stay together, palette cells
use equal columns, and extra height separates ordered groups while actions stay
at the bottom. Width changes reflow rows using Writer's native text metrics;
fonts and ordinary colors follow the host theme. The suite's built-in color
picker retains its native interface. The panel itself has no scrollbar;
editable/read-only document values retain their normal native scrolling.
When the current font and display cannot fit the controls, a selectable
full-value detail replaces the form until a larger window fits; content actions
are unavailable in that state. Sharing consent keeps its separate fail-closed
native preview. An empty saved zrok executable now defaults to the actual
installed bundled bridge. A saved path to wrAIter's own previous extension-cache
bundle follows the current installed bundle after its extension identity and
pinned executable hash are verified; other executable choices remain unchanged.
The migration preserves the reservation, connection identity and reconnect
preferences. A successful retry also clears the earlier connection error.
Version 0.3.2 keeps the panel's save guidance independent of bridge state;
Connections displays the observed bridge and document-sharing state.

Version 0.4.0 integrates the tunnel toolbar command, the two Connections pages,
and separate session-only folder/GitHub grants in one package. Color settings
use Color & behavior, Wording and Access pages; all ten presets and custom text
remain intact across page changes. A compact native twelve-swatch picker and
exact hex field replace the suite picker invocation. Native document URL updates
protect even open plain-text/HTML documents from generic writes. Folder status
and GitHub status remain nonblocking during network work; revoke cancels owned
Git children and prevents further local mutations. An already-sent repository
creation can finish remotely after cancellation, so that failure asks the user
to inspect the account before retrying.
Version 0.4.1 includes explicitly granted project/GitHub tools in the independent
tunnel's exact catalogue verification, so granting a folder before Start or
reconnect does not block the bridge.

`tests/uno_dialog_layout_smoke.py` checks all eleven actual native dialogs,
independent width/height changes, native/default and 18 pt text, reflow, group
stretch, regrowth, full-value no-fit, and unchanged/unshared document state.
It also checks each Connections and color-settings page. The focused
`tests/uno_connections_access_smoke.py` checks actual consent/control wiring,
protected live plain-text/Save As paths, token clearing, local attachment,
double-click behavior and the minimal color picker without network calls.
Source-runtime checks do not establish deployment in the user's live profile.

Version 0.2.2 measures the context-consent labels and actions with Writer's
native layout constraints, grows/reflows their rows at the current font size,
and gives surplus space to the selectable context detail. The complete document
title and sharing instructions are also available in that detail. If the native
display area cannot fit the preview at the current text size, the dialog gives
no-fit guidance and refuses Share through both the button and action path.
`tests/uno_consent_smoke.py --extension-check` checks actual installed widgets at
the default font, 18 pt at minimum/expanded sizes and a 36 pt no-fit state, without
sharing its synthetic inventory. It records the Toolkit work area; multi-monitor
placement and arbitrary text sizes are separate qualification questions.
The exact 0.2.2 package passed 12 pure tests, all 11 native scenario groups,
the complete UNO smoke and an installed-byte/protocol audit. Actual Windows
capture at 18 pt confirmed the complete 200-character title, sharing help,
inventory and footer remain visible (`installed-v022-consent-visual-result.json`).
The real Writer-to-Rust gateway regression also passed against frozen CLI
`690311f6…`, including exact native body/pending, replay and close-revocation
checks; its zrok child was simulated. A subsequent actual public HTTPS gate
passed all 12 connector checks with 0.2.2, including the native final-body,
pending and revocation assertions. The signed-in ChatGPT attempt did not
complete proposals and is recorded separately as not client-qualified.
Receipts and logs remain under ignored
`artifacts/libreoffice/` and `artifacts/marker-access/`.

Version 0.2.3 adds the same successful tool value as MCP `structuredContent`
alongside the unchanged text result. Both projections count toward the response
limit before a complete-read witness is recorded. This is a supported
interoperability addition; text-only MCP results were valid. The exact package passed 14
pure tests, all 11 native scenario groups, the full installed-source UNO smoke,
installed protocol/consent checks and the fourteen-entry source/archive/cache
audit. Mutation checks detect removal of each tool's structured projection and
omission of duplicated response bytes from the native size preflight. The
initial disposable-profile close-veto log is retained alongside the passing
rerun (`uno-v023-first-run-close-failure.log`, `uno-v023-smoke.log`). The consent
geometry is byte-identical to the visually verified 0.2.2 implementation.
The actual public HTTPS gate also passed all twelve checks with 0.2.3, including
equal structured/text projections, exact native final text, one pending
suggestion and endpoint revocation. Its fresh-profile Welcome dialog was
dismissed locally before normal UNO cleanup; the initial close veto and final
cleanup receipts are both retained.
The signed-in ChatGPT gate then passed in a fresh conversation after refreshing
the existing connection's tools: complete-context reads, one queued suggestion,
one locally authorized direct edit, and an independent final native assertion
that private and suggestion-only text stayed unchanged with one proposal
pending. Normal UNO cleanup revoked the endpoint and terminated only the owned
disposable desktop (`gateway-chatgpt-v023-qualified.json`). This client result
does not establish why the earlier text-only result displayed empty.

After the native suite, `tests/uno_dropdown_smoke.py` also checks the collapsed
native accessibility text of rule/marker/pending dropdowns, canonical default
slots, insertion order across ordinary ODT save/reopen, and light/dark swatch
label contrast. It uses its own copy of the synthetic pending document.

Official references:
[extension examples](https://api.libreoffice.org/examples/DevelopersGuide/examples.html),
[native asynchronous callback](https://api.libreoffice.org/docs/idl/ref/servicecom_1_1sun_1_1star_1_1awt_1_1AsyncCallback.html),
[native undo actions](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1document_1_1XUndoAction.html).
