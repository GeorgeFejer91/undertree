# wrAIter for Microsoft Word

<img src="../../assets/wraiter/icon.svg" width="64" height="64" alt="wrAIter AI waiter and typewriter logo">

The approved icon is shared across the ribbon, add-on windows, setup/uninstall
and Windows installed-app entry. [Package guide](../../docs/downloads.md).
Dialogs use its cream and deep-green palette, with a small logo beside the
bottom actions. Controls keep their native behavior; high contrast uses system
colors.

A native Windows Word add-in with a single installer. Select prose, then click
a color square on Word's **Home** or **wrAIter** ribbon to mark it. Double-click
the square or an already marked passage to open that color's rule dialog.
Color selections may span paragraphs, include their paragraph marks and contain
manual soft line breaks. AI wording edits still stay within one authorized paragraph.
Overlapping colors offer an explicit choice. Ribbon keytips provide keyboard
access. Each of up to 24 colors has its own dialog; there is no central highlight
or suggestion window. **New color rule** adds a color; **Connections** manages
AI access. No separate application, tray utility,
UnderTree installation or LibreOffice installation is needed. The installed
add-in owns its internal tunnel process and private connection profile.

Requires installed desktop Word on Windows 10/11 and .NET Framework 4.8 (included
in supported current Windows installations). The installer registers only this
add-in for the current Windows user. Close Word before installing/updating.

Each color dialog offers a name, native color picker, **Preserve text**, mode,
wording presets and a custom prompt. Shorten and More detail are mutually
exclusive. Preserve text disables conflicting controls and prevents AI wording
changes even when an overlapping color requests edits. Color-only marks grant
no editing permission until you assign a function locally. Existing protect,
reject and discard rules retain their restrictive meanings; ordinary Word
shading is not itself an AI permission.

**Suggestion mode** submits replacements through Word's Track Changes. Use
Word's native Review controls to accept or reject the changes in a paragraph.
A replacement may appear as a deletion/insertion pair. **Edit mode** requires
explicit permission for that color and applies the wording directly. AI should
replace an entire paragraph when the paragraph is fully authorized; a partial
highlight authorizes only that fragment. Neither mode saves the document.

Add Word comments to a suggested paragraph to give feedback. The next complete
context read includes comments, replies and revision information for the AI to
use with the color's instructions. Changing feedback invalidates an earlier
context read. A follow-up may replace a verified add-in suggestion in the same
passage; unrelated or ambiguous revisions must be resolved locally first.
For comments anchored in a prior suggestion, a shared ending must remain inside
each affected comment and outside protected units. Unsupported anchors are
refused before editing; native comment threads are never recreated.

Connections contains zrok setup, Start access, Stop / revoke, a copyable public
MCP URL and complete-document sharing consent. Initial public setup requires a
zrok account enrollment token and internet. Marking, prompts and local review
work offline. ChatGPT and public tunnels require internet; a local AI model is
not included. Sharing never saves a Word document and is never restored on
restart. Tunnel setup and document sharing are separate choices.

The remote tools are `list_manuscripts`, `read_manuscript`, `suggest_text` and
the color-only `highlight_text`. Complete current document context must be read sequentially
before proposals. UTF-16 offsets address highlighted main-body prose only;
headers, footnotes and other stories are read-only context. Stale snapshots,
unmarked gaps, boundary overruns, protection and revoked grants reject writes.
No remote file, shell, settings, save or approval operation exists.

Edits use one Word undo record and leave the document unsaved. Passage rules,
bookmarks, native revisions and comments persist with an explicit Word save. Request receipts
are stored encrypted for the current Windows user, independently from the
document. Uncertain outcomes cannot be replayed as a fresh write.

Selective replacements edit prose within a paragraph, outside tables,
equations, embedded objects and locked controls. Unsupported revision overlap
and mixed character formatting are rejected rather than flattened. Protected
fields require verified native preservation. These structures remain available as reading
context. Word on Mac and browser-based Word are not supported by this package.
Tracked and direct enclosing rewrites preserve whole protected native units through
explicit `replacementParts`: use each `protectedId` exactly once. Separate units may
move; continuous units stay intact with their original fields, links and formatting.
Native Word Accept/Reject and Undo/Redo retain their identities. Resolve partial
native review states locally before requesting another change to that paragraph.
Bookmark protection requires inspecting the document's Word XML; exports above
64 MiB are refused, including documents whose embedded images exceed that limit.

Build on Windows with PowerShell 7:

```powershell
./modules/word/build.ps1 -ZrokExecutable C:/path/to/zrok2.exe -Installer
```

The build embeds the repository's shared selective-editor contract and records
source/payload SHA-256 identities. Executable outputs and native qualification
documents belong under ignored `artifacts/word/`, never in source control.

Run `./modules/word/test.ps1` for source-bound policy, COM ABI, actual loopback
transport and native control checks. Its report explicitly leaves installed
Word and public connectivity unqualified. Add `-NativeWord` for the isolated
real-Word tracked-revision and comment-feedback tests on disposable documents.
Add `-InstalledWord` only after Word
is activated and opened normally; that gate uses its installed add-in and a
synthetic DOCX, leaving the demonstration document open. Public zrok/AI-client
verification remains a distinct gate.
