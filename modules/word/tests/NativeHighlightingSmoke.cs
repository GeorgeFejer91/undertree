using System;
using System.Collections.Generic;
using System.Collections;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Threading.Tasks;
using UnderTree.WordAddin;

internal static class NativeHighlightingSmoke
{
    private delegate bool Enumerate(IntPtr window, IntPtr state);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Enumerate callback, IntPtr state);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr window, Enumerate callback, IntPtr state);
    [DllImport("user32.dll")] private static extern int GetClassName(IntPtr window, StringBuilder name, int length);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder name, int length);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("oleacc.dll")] private static extern int AccessibleObjectFromWindow(IntPtr window, uint objectId, ref Guid iid, [MarshalAs(UnmanagedType.IDispatch)] out object value);
    private static int assertions;
    private static bool directMode;

    [STAThread]
    public static int Main(string[] args)
    {
        dynamic application = null;
        Process process = null;
        WordTestAutomation filter = null;
        try
        {
            directMode = args.Length > 2 && args[2] == "direct";
            filter = new WordTestAutomation();
            string output = Path.GetFullPath(args[1]);
            Directory.CreateDirectory(output);
            string fixture = Path.Combine(output, "isolated-native-highlighting.rtf");
            File.WriteAllText(fixture, @"{\rtf1\ansi One [A]. Two [B].\par}");
            process = Process.Start(new ProcessStartInfo(args[0], "/a /x /q \"" + fixture + "\"") {
                UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden });
            IntPtr target = IntPtr.Zero;
            DateTime deadline = DateTime.UtcNow.AddSeconds(30);
            while (target == IntPtr.Zero && DateTime.UtcNow < deadline)
            {
                EnumWindows(delegate(IntPtr parent, IntPtr unused) {
                    uint pid; GetWindowThreadProcessId(parent, out pid);
                    if (pid != process.Id) return true;
                    EnumChildWindows(parent, delegate(IntPtr child, IntPtr ignored) {
                        var name = new StringBuilder(80); GetClassName(child, name, name.Capacity);
                        if (name.ToString() == "_WwG") target = child;
                        return true;
                    }, IntPtr.Zero);
                    return true;
                }, IntPtr.Zero);
                if (target == IntPtr.Zero) { Application.DoEvents(); Thread.Sleep(50); }
            }
            if (target == IntPtr.Zero)
                EnumWindows(delegate(IntPtr parent, IntPtr unused) {
                    uint pid; GetWindowThreadProcessId(parent, out pid);
                    if (pid != process.Id) return true;
                    var title = new StringBuilder(512); GetWindowText(parent, title, title.Capacity);
                    Console.WriteLine("OWNED STARTUP WINDOW: " + title);
                    EnumChildWindows(parent, delegate(IntPtr child, IntPtr ignored) {
                        var childTitle = new StringBuilder(512); GetWindowText(child, childTitle, childTitle.Capacity);
                        if (childTitle.Length > 0) Console.WriteLine("OWNED STARTUP CONTROL: " + childTitle);
                        return true;
                    }, IntPtr.Zero);
                    return true;
                }, IntPtr.Zero);
            Check(target != IntPtr.Zero, "A separate /a /x Word instance exposes the disposable document.");
            object native = null; Guid dispatch = new Guid("00020400-0000-0000-C000-000000000046");
            while (native == null && DateTime.UtcNow < deadline)
            {
                int status = AccessibleObjectFromWindow(target, 0xfffffff0, ref dispatch, out native);
                if (status != 0) { native = null; Application.DoEvents(); Thread.Sleep(50); }
            }
            Check(native != null, "The separate Word native object is ready before automation.");
            application = ((dynamic)native).Application;
            uint nativePid; GetWindowThreadProcessId(new IntPtr((int)application.ActiveWindow.Hwnd), out nativePid);
            Check(nativePid == process.Id, "Native Word authority belongs to the exact separate process.");
            application.Visible = false;
            dynamic document = application.ActiveDocument;
            Console.WriteLine("Word " + application.Version + " isolated PID " + process.Id);
            Check((string)document.Content.Text == "One [A]. Two [B].\r", "Only the synthetic document is opened.");
            if (args.Length > 2 && args[2] == "adversarial-only")
            {
                using (var dispatcher = new Control())
                {
                    IntPtr handle = dispatcher.Handle;
                    int thread = Thread.CurrentThread.ManagedThreadId;
                    Func<Func<object>, object> marshal = callback => Thread.CurrentThread.ManagedThreadId == thread ? callback() : dispatcher.Invoke(callback);
                    using (var editor = new WordEditor(application, marshal, Path.Combine(output, "isolated-profile"), Path.Combine(output, "unused-zrok.exe")))
                    {
                        string address = UiState.Text(Local(editor, "connection_local"), "localMcpUrl");
                        AdversarialHistory(application, editor, address, output);
                        Local(editor, "connection_stop");
                    }
                }
                File.WriteAllText(Path.Combine(output, "result.txt"), "PASS " + assertions + " isolated adversarial native assertions.");
                return 0;
            }
            var proposal = new Proposal { From = 0, To = 17 };
            var units = new List<PassageMark> {
                new PassageMark { Id = "Wrai_first", From = 4, To = 7, Quote = "[A]" },
                new PassageMark { Id = "Wrai_second", From = 13, To = 16, Quote = "[B]" } };
            document.Range(4, 7).Font.Italic = -1;
            document.Range(13, 16).Font.Bold = -1;
            foreach (PassageMark unit in units) document.Bookmarks.Add(unit.Id, document.Range(unit.From, unit.To));
            var placements = new List<ProtectedPlacement> {
                new ProtectedPlacement { Id = "Wrai_second", From = 0, To = 3 },
                new ProtectedPlacement { Id = "Wrai_first", From = 9, To = 12 } };
            WordSnapshot before = WordSnapshot.Capture(document);
            using (var preserved = new WordProtectedContent(application, document, proposal, units, placements))
            {
                application.UndoRecord.StartCustomRecord("Qualification protected rearrangement");
                try
                {
                    document.Range(0, 17).Text = "[B] then [A].";
                    preserved.Restore(document, 0, 13);
                    foreach (ProtectedPlacement placement in placements) document.Bookmarks.Add(placement.Id, document.Range(placement.From, placement.To));
                    preserved.Verify(document);
                }
                finally { application.UndoRecord.EndCustomRecord(); }
            }
            Check((string)document.Content.Text == "[B] then [A].\r", "Native FormattedText reconstruction reorders exact units.");
            Check((int)document.Range(0, 3).Font.Bold == -1 && (int)document.Range(9, 12).Font.Italic == -1, "Each protected unit retains its original distinct formatting.");
            Check(!(bool)document.Saved, "Native rearrangement remains unsaved.");
            Check((bool)document.Undo(1), "Word Undo reverses the entire enclosing native transaction.");
            Check(WordSnapshot.Capture(document).FullText == before.FullText, "Undo restores the exact complete original text.");
            Check((bool)document.Bookmarks.Exists("Wrai_first") && (int)document.Bookmarks.Item("Wrai_first").Range.Start == 4,
                "Undo restores the protected bookmark identity and original range.");
            dynamic field = document.Fields.Add(document.Range(4, 7), -1, "CITATION NativeTest", false);
            WordSnapshot fieldSnapshot = WordSnapshot.Capture(document);
            string fieldQuote = (string)field.Result.Text;
            string fieldCode = (string)field.Code.Text;
            int citationFrom = fieldSnapshot.MainText.IndexOf("[B]", StringComparison.Ordinal);
            var fieldUnit = new PassageMark { Id = "Wrai_field", From = 4, To = 4 + fieldQuote.Length, Quote = fieldQuote };
            var plainUnit = new PassageMark { Id = "Wrai_second", From = citationFrom, To = citationFrom + 3, Quote = "[B]" };
            units = new List<PassageMark> { fieldUnit, plainUnit };
            foreach (PassageMark unit in units) document.Bookmarks.Add(unit.Id, fieldSnapshot.Range(document, unit.From, unit.To));
            proposal = new Proposal { From = 0, To = fieldSnapshot.MainText.Length - 1 };
            placements = new List<ProtectedPlacement> {
                new ProtectedPlacement { Id = plainUnit.Id, From = 0, To = 3 },
                new ProtectedPlacement { Id = fieldUnit.Id, From = 9, To = 9 + fieldQuote.Length } };
            fieldSnapshot.RequireProse(document, proposal.From, proposal.To, new HashSet<string> { "Wrai_first", "Wrai_second", "Wrai_field" }, units);
            string fieldReplacement = "[B] then " + fieldQuote + ".";
            using (var preserved = new WordProtectedContent(application, document, proposal, units, placements))
            {
                fieldSnapshot.Range(document, proposal.From, proposal.To).Text = fieldReplacement;
                preserved.Restore(document, 0, fieldReplacement.Length);
                WordSnapshot moved = WordSnapshot.Capture(document);
                foreach (ProtectedPlacement placement in placements) document.Bookmarks.Add(placement.Id, moved.Range(document, placement.From, placement.To));
                preserved.Verify(document);
            }
            Check((int)document.Fields.Count == 1 && (string)document.Fields.Item(1).Code.Text == fieldCode,
                "An immutable citation field reorders with its exact native field code intact.");
            Check(WordSnapshot.Capture(document).MainText == fieldReplacement + "\r", "Mapped UTF-16 offsets preserve field results and surrounding prose.");
            IntegratedReview(application, document, output);
            File.WriteAllText(Path.Combine(output, "result.txt"), "PASS " + assertions + " isolated native assertions. Installed add-in and live tunnel are not qualified.");
            Console.WriteLine("PASS " + assertions + " isolated native assertions; installed package and public tunnel NOT RUN.");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        finally
        {
            if (application != null) application.Quit(0);
            else if (process != null && !process.HasExited) process.Kill();
            if (filter != null) filter.Dispose();
        }
    }

    private static void IntegratedReview(dynamic application, dynamic document, string output)
    {
        foreach (string id in new[] { "Wrai_first", "Wrai_second", "Wrai_field" })
            if ((bool)document.Bookmarks.Exists(id)) document.Bookmarks.Item(id).Delete();
        WordSnapshot initial = WordSnapshot.Capture(document);
        document.Hyperlinks.Add(Anchor: initial.Range(document, 0, 3), Address: "https://example.invalid/citation-b", TextToDisplay: "[B]");
        string path = Path.Combine(output, "structured-qualification.docx");
        document.SaveAs2(path, 16);
        string diskBefore = FileDigest(path);
        using (var dispatcher = new Control())
        {
            IntPtr handle = dispatcher.Handle;
            int thread = Thread.CurrentThread.ManagedThreadId;
            Func<Func<object>, object> marshal = callback => Thread.CurrentThread.ManagedThreadId == thread ? callback() : dispatcher.Invoke(callback);
            using (var editor = new WordEditor(application, marshal, Path.Combine(output, "isolated-profile"), Path.Combine(output, "unused-zrok.exe")))
            {
                var state = Local(editor, "state");
                string documentId = UiState.Text(UiState.Map(state["document"]), "id");
                string sidecar = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "wrAIterWord", "reviews", documentId + ".bin");
                Check(!File.Exists(sidecar), "The synthetic review identity has no pre-existing private receipt.");
                try
                {
                    string address = UiState.Text(Local(editor, "connection_local"), "localMcpUrl");
                    var preview = Local(editor, "context_preview");
                    Local(editor, "share_context", new { snapshot = preview["snapshot"], documentId = documentId });
                    var context = Tool(address, "read_manuscript", new { manuscript_id = documentId });
                    string completeText = UiState.Text(context, "text");
                    int mainLength = (int)context["main_body_length"];
                    string text = completeText.Substring(0, mainLength);
                    if (completeText.Length > mainLength + 4)
                        DeniedTool(address, "highlight_text", new { documentId = documentId, marking = new { requestId = "no_review_context_marking",
                            revision = context["revision"], contextId = context["context_id"], ranges = new[] {
                                new { from = mainLength + 1, to = mainLength + 4, quote = completeText.Substring(mainLength + 1, 3) } } } });
                    dynamic feedback = document.Comments.Add(WordSnapshot.Capture(document).Range(document, 0, 3), "Native qualification feedback.");
                    DeniedTool(address, "highlight_text", new { documentId = documentId, marking = new { requestId = "stale_feedback_witness",
                        revision = context["revision"], contextId = context["context_id"], ranges = new[] { new { from = 0, to = 3, quote = "[B]" } } } });
                    feedback.Delete();
                    context = Tool(address, "read_manuscript", new { manuscript_id = documentId });
                    int fieldFrom = 9, fieldTo = text.Length - 2;
                    var marking = new { requestId = "native_batch", revision = context["revision"], contextId = context["context_id"],
                        ranges = new[] { new { from = 0, to = 3, quote = "[B]" }, new { from = fieldFrom, to = fieldTo, quote = text.Substring(fieldFrom, fieldTo - fieldFrom) } } };
                    var badMarking = new { requestId = "bad_batch", revision = context["revision"], contextId = context["context_id"],
                        ranges = new[] { new { from = 0, to = 3, quote = "[B]" }, new { from = fieldFrom, to = fieldTo, quote = "wrong" } } };
                    DeniedTool(address, "highlight_text", new { documentId = documentId, marking = badMarking });
                    Check(UiState.Records(Local(editor, "state"), "marks").Count == 0, "An invalid native batch leaves no partial color or marker.");
                    var color = Tool(address, "highlight_text", new { documentId = documentId, marking = marking });
                    string colorId = UiState.Text(color, "colorId");
                    state = Local(editor, "state");
                    var neutral = UiState.Records(state, "rules").First(rule => UiState.Text(rule, "id") == colorId);
                    Check(UiState.Text(neutral, "action") == "neutral" && UiState.Text(neutral, "prompt") == "", "The real Word MCP action creates functionless neutral color.");
                    Check(UiState.Records(state, "marks").Count == 2 && WordSnapshot.Capture(document).MainText == text, "Both native structured marks preserve all source wording.");
                    Tool(address, "highlight_text", new { documentId = documentId, marking = marking });
                    Check(UiState.Records(Local(editor, "state"), "marks").Count == 2, "Native lost-reply replay creates no duplicate marks.");
                    Check(FileDigest(path) == diskBefore, "Remote marking never saves the DOCX.");
                    Check((bool)document.Undo(1), "Color-only marking is one native Undo operation.");
                    state = Local(editor, "state");
                    Check(UiState.Records(state, "marks").Count == 0 && !UiState.Flag(UiState.Map(state["document"]), "shared"),
                        "Undo removes neutral native marks and revokes context without erasing consumed IDs.");
                    preview = Local(editor, "context_preview");
                    Local(editor, "share_context", new { snapshot = preview["snapshot"], documentId = documentId });
                    context = Tool(address, "read_manuscript", new { manuscript_id = documentId });
                    DeniedTool(address, "highlight_text", new { documentId = documentId, marking = marking });
                    DeniedTool(address, "highlight_text", new { documentId = documentId, marking = new { requestId = "native_batch",
                        revision = context["revision"], contextId = context["context_id"], ranges = new[] { new { from = 4, to = 8, quote = "then" } } } });
                    Check(UiState.Records(Local(editor, "state"), "marks").Count == 0, "Neither original nor changed-context reused marking IDs can have a new effect after Undo.");
                    Check((bool)document.Redo(1), "Redo reapplies the original marking transaction exactly once.");
                    state = Local(editor, "state");
                    Check(UiState.Records(state, "marks").Count == 2 && UiState.Records(state, "marks").All(mark => !UiState.Flag(mark, "stale")),
                        "Native Redo restores geometry while retaining the current rule and receipt ledgers.");
                    preview = Local(editor, "context_preview");
                    Local(editor, "share_context", new { snapshot = preview["snapshot"], documentId = documentId });
                    context = Tool(address, "read_manuscript", new { manuscript_id = documentId });
                    DeniedTool(address, "suggest_text", new { manuscript_id = documentId, request_id = "neutral_cannot_edit", revision = context["revision"], context_id = context["context_id"],
                        from = 0, to = 3, quote = "[B]", replacement = "changed" });
                    Local(editor, "save_rule", new { documentId = documentId, id = colorId, label = "Protected citations", color = neutral["color"], action = "protect", prompt = "", accessMode = "suggestions" });
                    DeniedTool(address, "highlight_text", new { documentId = documentId, marking = marking });
                    WordSnapshot current = WordSnapshot.Capture(document);
                    current.Range(document, 0, current.MainText.Length - 1).Select();
                    var selected = Local(editor, "selection_preview");
                    Local(editor, "mark_selection", new { ruleId = "snappier", prompt = "", quote = selected["quote"], from = selected["from"], to = selected["to"], snapshot = selected["snapshot"] });
                    state = Local(editor, "state");
                    var protectedMarks = UiState.Records(state, "marks").Where(mark => UiState.Text(mark, "ruleId") == colorId).ToList();
                    string firstId = UiState.Text(protectedMarks.First(mark => (int)mark["from"] == 0), "id");
                    string fieldId = UiState.Text(protectedMarks.First(mark => (int)mark["from"] == fieldFrom), "id");
                    if (directMode) Local(editor, "save_rule", new { documentId = documentId, id = "snappier", label = "Direct enclosing rewrite",
                        color = "#e5be50", action = "prompt", prompt = "Improve clarity.", accessMode = "direct" });
                    Local(editor, "save_rule", new { documentId = documentId, id = "partial_direct", label = "Original gap only", color = "#C1C7E9",
                        action = "prompt", prompt = "Only change this exact fragment.", accessMode = "direct" });
                    Mark(editor, document, documentId, "partial_direct", 3, fieldFrom);
                    context = Tool(address, "read_manuscript", new { manuscript_id = documentId });
                    string beforePartialDirect = new WordNativeEditState().NativeIdentity(document);
                    var partialDirectResponse = Rpc(address, "suggest_text", new { manuscript_id = documentId, request_id = "ambiguous_partial_direct",
                        revision = context["revision"], context_id = context["context_id"], from = 0, to = text.Length - 1, quote = text.Substring(0, text.Length - 1), replacement = "",
                        replacementParts = new object[] { new { protectedId = fieldId }, new { text = " before " }, new { protectedId = firstId }, new { text = "." } } });
                    string partialDirectReason = UiState.Text(UiState.Map(((IEnumerable)partialDirectResponse["content"]).Cast<object>().First()), "text");
                    state = Local(editor, "state");
                    var partialDirect = UiState.Records(state, "marks").Single(mark => UiState.Text(mark, "ruleId") == "partial_direct");
                    Check(UiState.Flag(partialDirectResponse, "isError") && partialDirectReason.Contains("overlapping marker"),
                        "A protected enclosing rewrite refuses an ambiguously overlapping partial direct marker.");
                    Check((int)partialDirect["from"] == 3 && (int)partialDirect["to"] == fieldFrom && !UiState.Flag(partialDirect, "stale") &&
                        new WordNativeEditState().NativeIdentity(document) == beforePartialDirect && FileDigest(path) == diskBefore,
                        "Refusal retains only the original direct range without native changes, broader authority or saving.");
                    Local(editor, "remove_mark", new { documentId = documentId, id = partialDirect["id"] });
                    Local(editor, "state");
                    context = Share(editor, address, documentId);
                    var request = new { manuscript_id = documentId, request_id = "native_preserve_pending", revision = context["revision"], context_id = context["context_id"],
                        from = 0, to = text.Length - 1, quote = text.Substring(0, text.Length - 1), replacement = "",
                        replacementParts = new object[] { new { protectedId = fieldId }, new { text = " before " }, new { protectedId = firstId }, new { text = "." } } };
                    Task<SavedWordReview> stagedReceipt = Task.Run(delegate {
                        DateTime deadline = DateTime.UtcNow.AddSeconds(20);
                        while (DateTime.UtcNow < deadline)
                        {
                            try
                            {
                                if (File.Exists(sidecar))
                                {
                                    byte[] bytes = File.ReadAllBytes(sidecar);
                                    string encoded = Encoding.UTF8.GetString(System.Security.Cryptography.ProtectedData.Unprotect(bytes, null, System.Security.Cryptography.DataProtectionScope.CurrentUser));
                                    SavedWordReview saved = McpEndpoint.Json().Deserialize<SavedWordReview>(encoded);
                                    if (saved.Policy.Proposals.Any(proposal => proposal.Id == "native_preserve_pending" && proposal.Status == "applying" &&
                                        proposal.NativeReviewBookmark != null && proposal.NativeOriginalMarks != null)) return saved;
                                }
                            }
                            catch (IOException) { }
                            Thread.Sleep(1);
                        }
                        return null;
                    });
                    var applied = Tool(address, "suggest_text", request);
                    SavedWordReview staged = stagedReceipt.GetAwaiter().GetResult();
                    Check(staged != null && staged.Policy.Proposals.First(proposal => proposal.Id == "native_preserve_pending").Status == "applying",
                        "The actual durable preverification receipt stays applying with original native witnesses.");
                    File.WriteAllText(Path.Combine(output, "staged-preverification-receipt.json"), McpEndpoint.Json().Serialize(staged));
                    string contract;
                    using (var stream = typeof(WordEditor).Assembly.GetManifestResourceStream("SelectiveEditorContract"))
                    using (var reader = new StreamReader(stream)) contract = reader.ReadToEnd();
                    var recovered = new PolicyEngine(contract, staged.Policy);
                    Check(recovered.Proposals.First(proposal => proposal.Id == "native_preserve_pending").Status == "outcome_uncertain" && !recovered.IsShared,
                        "Reopening a captured preverification receipt cannot claim native success or restore sharing.");
                    bool prematureAcceptDenied = false;
                    try { recovered.ValidateAcceptance("native_preserve_pending", documentId, UiState.Text(context, "revision"), text, UiState.Text(context, "revision")); }
                    catch (InvalidOperationException) { prematureAcceptDenied = true; }
                    Check(prematureAcceptDenied, "A captured provisional native receipt cannot be accepted or replayed as a new effect.");
                    Check(UiState.Text(applied, "status") == "tracked", "Suggestion mode creates a native tracked protected enclosing rewrite.");
                    string expected = text.Substring(fieldFrom, fieldTo - fieldFrom) + " before [B].\r";
                    Check(WordSnapshot.Capture(document).MainText == expected && (int)document.Fields.Count == 4 && (int)document.Hyperlinks.Count == 2,
                        "Native local acceptance preserves and reorders citation fields and hyperlink objects.");
                    Check((string)document.Hyperlinks.Item(1).Address == "https://example.invalid/citation-b", "The protected link keeps its original target.");
                    Check(FileDigest(path) == diskBefore && !(bool)document.Saved, "Remote proposal and local acceptance leave disk unchanged and Word unsaved.");
                    Check((bool)document.Undo(1), "Native selective acceptance is one Undo operation.");
                    Console.WriteLine("UNDO observed text: " + WordSnapshot.Capture(document).MainText.Replace("\r", "\\r"));
                    state = Local(editor, "state");
                    Check(WordSnapshot.Capture(document).MainText == text, "Undo restores the exact original native source text.");
                    Check(!UiState.Flag(UiState.Map(state["document"]), "shared"), "Undo revokes sharing after native metadata restoration.");
                    Check((bool)document.Redo(1), "Redo reapplies the whole native selective transaction.");
                    state = Local(editor, "state");
                    Check(WordSnapshot.Capture(document).MainText == expected && UiState.Records(state, "marks").All(mark => !UiState.Flag(mark, "stale")), "Redo restores exact protected identities without stale anchors.");
                    document.Save();
                    document.Close(0);
                    document = application.Documents.Open(path, ReadOnly: false, Visible: false);
                    document.Activate();
                    state = Local(editor, "state");
                    Check(!UiState.Flag(UiState.Map(state["document"]), "shared") && UiState.Records(state, "marks").Count == 3 &&
                        UiState.Records(state, "marks").All(mark => !UiState.Flag(mark, "stale")), "Tracked DOCX save/reopen retains exact independent native identities without sharing.");
                    Check(WordSnapshot.Capture(document).MainText == expected && (int)document.Revisions.Count == 2,
                        "Tracked DOCX save/reopen preserves current text and real native revisions.");
                    document.Revisions.Item(1).Accept();
                    context = Share(editor, address, documentId);
                    string partialBefore = WordSnapshot.Capture(document).Revision;
                    DeniedTool(address, "suggest_text", new { manuscript_id = documentId, request_id = "partial_accept_denied", revision = context["revision"], context_id = context["context_id"],
                        from = 0, to = expected.Length - 1, quote = expected.Substring(0, expected.Length - 1), replacement = "",
                        replacementParts = new object[] { new { text = "Reconsider " }, new { protectedId = fieldId }, new { text = " alongside " }, new { protectedId = firstId }, new { text = "." } } });
                    Check(WordSnapshot.Capture(document).Revision == partialBefore && (int)document.Revisions.Count == 1,
                        "Partially accepted native revisions deny further remote paragraph edits without source mutation.");
                    Check((bool)document.Undo(1), "Undo restores the untouched native tracked review after partial acceptance.");
                    state = Local(editor, "state");
                    document.Revisions.Item(2).Reject();
                    context = Share(editor, address, documentId);
                    partialBefore = WordSnapshot.Capture(document).Revision;
                    DeniedTool(address, "suggest_text", new { manuscript_id = documentId, request_id = "partial_reject_denied", revision = context["revision"], context_id = context["context_id"],
                        from = 0, to = expected.Length - 1, quote = expected.Substring(0, expected.Length - 1), replacement = "",
                        replacementParts = new object[] { new { text = "Reconsider " }, new { protectedId = fieldId }, new { text = " alongside " }, new { protectedId = firstId }, new { text = "." } } });
                    Check(WordSnapshot.Capture(document).Revision == partialBefore && (int)document.Revisions.Count == 1,
                        "Partially rejected native revisions deny further remote paragraph edits without source mutation.");
                    Check((bool)document.Undo(1), "Undo restores the untouched native tracked review after partial rejection.");
                    state = Local(editor, "state");
                    document.AcceptAllRevisions();
                    state = Local(editor, "state");
                    Check(WordSnapshot.Capture(document).MainText == expected && (int)document.Fields.Count == 2 && (int)document.Hyperlinks.Count == 1 &&
                        UiState.Records(state, "marks").All(mark => !UiState.Flag(mark, "stale")), "Native Accept keeps protected fields, link and current stable mark identities.");
                    Check((bool)document.Undo(1), "Native Accept needs one Undo after metadata reconciliation.");
                    state = Local(editor, "state");
                    Check((int)document.Revisions.Count == 2 && UiState.Records(state, "marks").All(mark => !UiState.Flag(mark, "stale")),
                        "Undo Accept restores native tracked revisions and stable protection identities.");
                    document.RejectAllRevisions();
                    string nativeReadBefore = ((Dictionary<long, WordDocumentReview>)typeof(WordEditor).GetField("documents", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic).GetValue(editor))[WordSnapshot.Identity(document)].NativeEdit.NativeIdentity(document);
                    state = Local(editor, "state");
                    Check(((Dictionary<long, WordDocumentReview>)typeof(WordEditor).GetField("documents", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic).GetValue(editor))[WordSnapshot.Identity(document)].NativeEdit.NativeIdentity(document) == nativeReadBefore, "Native rejection reconciliation never rewrites Word text, formatting or bookmarks during a read.");
                    Check(WordSnapshot.Capture(document).MainText == text && (int)document.Fields.Count == 2 && (int)document.Hyperlinks.Count == 1 &&
                        UiState.Records(state, "marks").All(mark => !UiState.Flag(mark, "stale")), "Native Reject restores exact original fields/link and stable IDs from native witnesses.");
                    Check((bool)document.Undo(1), "Native Reject needs one Undo after reconciliation without bookmark rewrites.");
                    state = Local(editor, "state");
                    Check(WordSnapshot.Capture(document).MainText == expected && (int)document.Revisions.Count == 2 &&
                        UiState.Records(state, "marks").All(mark => !UiState.Flag(mark, "stale")), "Undo Reject restores current tracked text and canonical protected identities.");
                    document.RejectAllRevisions();
                    nativeReadBefore = ((Dictionary<long, WordDocumentReview>)typeof(WordEditor).GetField("documents", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic).GetValue(editor))[WordSnapshot.Identity(document)].NativeEdit.NativeIdentity(document);
                    state = Local(editor, "state");
                    Check(((Dictionary<long, WordDocumentReview>)typeof(WordEditor).GetField("documents", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic).GetValue(editor))[WordSnapshot.Identity(document)].NativeEdit.NativeIdentity(document) == nativeReadBefore, "Native rejection reconciliation never rewrites Word text, formatting or bookmarks during a read.");
                    WordSnapshot beforeRepeatedReview = WordSnapshot.Capture(document);
                    string repeatedSourceFile = FileDigest(path);
                    string repeatedProtectedSignature = WordSnapshot.FormattingSignature(beforeRepeatedReview.Range(document, 0, 3)) +
                        WordSnapshot.FormattingSignature(beforeRepeatedReview.Range(document, fieldFrom, fieldTo));
                    context = Share(editor, address, documentId);
                    var repeatedReview = Tool(address, "suggest_text", new { manuscript_id = documentId, request_id = "second_protected_round",
                        revision = context["revision"], context_id = context["context_id"], from = 0, to = text.Length - 1, quote = text.Substring(0, text.Length - 1), replacement = "",
                        replacementParts = new object[] { new { protectedId = fieldId }, new { text = " once more before " }, new { protectedId = firstId }, new { text = "." } } });
                    Check(UiState.Text(repeatedReview, "status") == "tracked", "A second protected review creates a distinct native tracked paragraph.");
                    document.Activate();
                    document.RejectAllRevisions();
                    string repeatedNative = new WordNativeEditState().NativeIdentity(document);
                    state = Local(editor, "state");
                    WordSnapshot repeatedOriginal = WordSnapshot.Capture(document);
                    Check(repeatedOriginal.Revision == beforeRepeatedReview.Revision && (int)document.Fields.Count == 2 && (int)document.Hyperlinks.Count == 1 &&
                        WordSnapshot.FormattingSignature(repeatedOriginal.Range(document, 0, 3)) + WordSnapshot.FormattingSignature(repeatedOriginal.Range(document, fieldFrom, fieldTo)) == repeatedProtectedSignature,
                        "Rejecting the second review restores exact original text, native fields, hyperlink and protected formatting.");
                    preview = Local(editor, "context_preview");
                    var repeatedShare = Local(editor, "share_context", new { documentId = documentId, snapshot = preview["snapshot"] });
                    Check(UiState.Flag(UiState.Map(repeatedShare["document"]), "shared"), "Fresh sharing remains active after two rejected protected reviews.");
                    Local(editor, "state");
                    state = Local(editor, "state");
                    context = Tool(address, "read_manuscript", new { manuscript_id = documentId });
                    Check(UiState.Flag(UiState.Map(state["document"]), "shared") && UiState.Flag(context, "complete") &&
                        UiState.Records(state, "marks").Count == 3 && UiState.Records(state, "marks").All(mark => !UiState.Flag(mark, "stale")) &&
                        new WordNativeEditState().NativeIdentity(document) == repeatedNative && FileDigest(path) == repeatedSourceFile,
                        "Repeated reads retain the newest valid protected anchors and sharing without native changes or saving.");
                    document.Save();
                    document.Close(0);
                    document = application.Documents.Open(path, ReadOnly: false, Visible: false);
                    document.Activate();
                    state = Local(editor, "state");
                    Check(WordSnapshot.Capture(document).MainText == text && (int)document.Fields.Count == 2 && (int)document.Hyperlinks.Count == 1 &&
                        UiState.Records(state, "marks").Count == 3 && UiState.Records(state, "marks").All(mark => !UiState.Flag(mark, "stale")) &&
                        !UiState.Flag(UiState.Map(state["document"]), "shared"), "Rejected DOCX save/reopen retains exact original native protection and no sharing authority.");                    Local(editor, "remove_mark", new { documentId = documentId, id = fieldId });
                    Check((bool)document.Undo(1), "A local marker removal leaves native Undo available.");
                    state = Local(editor, "state");
                    Check(!UiState.Records(state, "marks").Any(mark => UiState.Text(mark, "id") == fieldId),
                        "Native metadata or bookmark Undo cannot resurrect an explicitly removed local mark.");
                    AdversarialHistory(application, editor, address, output);
                    Local(editor, "connection_stop");
                }
                finally { if (File.Exists(sidecar)) File.Delete(sidecar); }
            }
        }
    }

    private static void AdversarialHistory(dynamic application, WordEditor editor, string address, string output)
    {
        dynamic document = application.Documents.Add(Visible: false);
        document.TrackRevisions = false;
        document.Content.Text = "First paragraph.\rSecond paragraph.";
        document.Activate();
        string path = Path.Combine(output, "history-adversarial.docx");
        document.SaveAs2(path, 16);
        var state = Local(editor, "state");
        string id = UiState.Text(UiState.Map(state["document"]), "id");
        string sidecar = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "wrAIterWord", "reviews", id + ".bin");
        Check(!File.Exists(sidecar), "The adversarial synthetic identity has no prior receipt.");
        File.WriteAllText(Path.Combine(output, "adversarial-identity.txt"), id);
        try
        {
            Local(editor, "save_rule", new { documentId = id, id = "history_suggest", label = "First pending", color = "#ABCDD1", action = "prompt", prompt = "Improve wording.", accessMode = "suggestions" });
            Local(editor, "save_rule", new { documentId = id, id = "history_direct", label = "Second direct", color = "#AABDCC", action = "prompt", prompt = "Improve wording.", accessMode = "direct" });
            string original = WordSnapshot.Capture(document).MainText;
            int firstEnd = original.IndexOf('\r'), secondFrom = firstEnd + 1, secondTo = original.IndexOf('\r', secondFrom);
            Console.WriteLine("ADVERSARY BODY " + original.Replace("\r", "\\r") + " ranges0.." + firstEnd + " / " + secondFrom + ".." + secondTo);
            Mark(editor, document, id, "history_suggest", 0, firstEnd);
            Mark(editor, document, id, "history_direct", secondFrom, secondTo);
            var context = Share(editor, address, id);
            var nativeDocuments = (Dictionary<long, WordDocumentReview>)typeof(WordEditor).GetField("documents", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic).GetValue(editor);
            WordDocumentReview native = nativeDocuments[WordSnapshot.Identity(document)];
            WordSnapshot before = WordSnapshot.Capture(document);
            native.Policy.Submit(new Proposal { Id = "pending_P", DocumentId = id, Revision = before.Revision, From = 0, To = firstEnd,
                Quote = original.Substring(0, firstEnd), Replacement = "First clarified paragraph.", Rationale = "" }, UiState.Text(context, "context_id"), before.MainText, before.Revision);
            WordReviewStore.PersistReceipts(new SavedWordReview { DocumentId = id, Policy = native.Policy.ExportState() });
            var q = Tool(address, "suggest_text", new { manuscript_id = id, request_id = "direct_Q", revision = context["revision"], context_id = context["context_id"],
                from = secondFrom, to = secondTo, quote = original.Substring(secondFrom, secondTo - secondFrom), replacement = "Second revised paragraph." });
            Check(UiState.Text(q, "status") == "applied", "A disjoint direct edit creates native Undo history while another receipt is pending.");
            Local(editor, "reject", new { id = "pending_P", documentId = id });
            Check((bool)document.Undo(1), "The disjoint native direct edit can be undone once.");
            state = Local(editor, "state");
            Check(WordSnapshot.Capture(document).MainText == original && native.Policy.Proposals.First(proposal => proposal.Id == "pending_P").Status == "rejected",
                "Native Undo retains a later local terminal rejection instead of resurrecting pending authority.");
            bool denied = false;
            try { Local(editor, "accept", new { id = "pending_P", documentId = id }); }
            catch (InvalidOperationException) { denied = true; }
            Check(denied && WordSnapshot.Capture(document).MainText == original, "Local acceptance cannot revive a rejected pending request after unrelated Undo.");

            context = Share(editor, address, id);
            Tool(address, "suggest_text", new { manuscript_id = id, request_id = "direct_Q2", revision = context["revision"], context_id = context["context_id"],
                from = secondFrom, to = secondTo, quote = original.Substring(secondFrom, secondTo - secondFrom), replacement = "Second revised paragraph." });
            Local(editor, "save_rule", new { documentId = id, id = "history_suggest", label = "First is now protected", color = "#ABCDD1", action = "protect", prompt = "", accessMode = "suggestions" });
            bool reachedOriginal = false;
            for (int undo = 0; undo < 8; undo++)
            {
                if (!(bool)document.Undo(1)) break;
                state = Local(editor, "state");
                Check(UiState.Records(state, "rules").First(rule => UiState.Text(rule, "id") == "history_suggest")["action"].ToString() == "protect",
                    "Native source or CustomXML Undo cannot weaken the current local Protect rule.");
                if (WordSnapshot.Capture(document).MainText == original) { reachedOriginal = true; break; }
            }
            Check(reachedOriginal, "The adversarial Undo sequence reaches the older direct edit while retaining newer protection.");

            context = Share(editor, address, id);
            native = nativeDocuments[WordSnapshot.Identity(document)];
            string nativeBefore = native.NativeEdit.NativeIdentity(document);
            int marksBefore = native.Policy.Marks.Count, rulesBefore = native.Policy.Rules.Count;
            DateTime stamp = File.GetLastWriteTimeUtc(sidecar);
            var release = new ManualResetEvent(false);
            bool locked = false;
            var blocker = Task.Run(delegate {
                DateTime deadline = DateTime.UtcNow.AddSeconds(20);
                while (DateTime.UtcNow < deadline && !release.WaitOne(0))
                {
                    if (File.Exists(sidecar) && File.GetLastWriteTimeUtc(sidecar) != stamp)
                        try { using (var hold = new FileStream(sidecar, FileMode.Open, FileAccess.Read, FileShare.Read)) { locked = true; release.WaitOne(15000); return; } }
                        catch (IOException) { }
                    Thread.Sleep(1);
                }
            });
            Dictionary<string, object> failed;
            try { failed = Rpc(address, "highlight_text", new { documentId = id, marking = new { requestId = "fault_final_persist",
                revision = context["revision"], contextId = context["context_id"], ranges = new[] { new { from = 0, to = 5, quote = "First" } } } }); }
            finally { release.Set(); blocker.Wait(); release.Dispose(); }
            Check(locked && UiState.Flag(failed, "isError"), "A real private-receipt file lock injects failure after durable reservation and native marking.");
            state = Local(editor, "state");
            native = nativeDocuments[WordSnapshot.Identity(document)];
            Check(native.NativeEdit.NativeIdentity(document) == nativeBefore && native.Policy.Marks.Count == marksBefore && native.Policy.Rules.Count == rulesBefore,
                "Failed final persistence rolls back exact native bookmark, shading, field and body identity with no partial policy addition.");
            Check(!native.Policy.IsShared && native.Policy.HighlightReceipts.First(receipt => receipt.Request.RequestId == "fault_final_persist").Outcome == "outcome_uncertain",
                "Failed marking retains a consumed uncertain tombstone and revokes authority.");
            context = Share(editor, address, id);
            DeniedTool(address, "highlight_text", new { documentId = id, marking = new { requestId = "fault_final_persist",
                revision = context["revision"], contextId = context["context_id"], ranges = new[] { new { from = 6, to = 15, quote = "paragraph" } } } });
            Check(Directory.GetFiles(Path.GetDirectoryName(sidecar), id + ".*.tmp").Length == 0, "Failed atomic receipt writes leave no private staging files.");
            Check(native.Policy.Marks.Count == marksBefore && native.Policy.Rules.First(rule => rule.Id == "history_suggest").Action == "protect",
                "A failed consumed request cannot be reused to create an effect or weaken current protection.");
        }
        finally { document.Close(0); if (File.Exists(sidecar)) File.Delete(sidecar); }
    }

    private static Dictionary<string, object> Share(WordEditor editor, string address, string id)
    {
        var preview = Local(editor, "context_preview");
        Local(editor, "share_context", new { documentId = id, snapshot = preview["snapshot"] });
        return Tool(address, "read_manuscript", new { manuscript_id = id });
    }

    private static void Mark(WordEditor editor, dynamic document, string id, string rule, int from, int to)
    {
        WordSnapshot.Capture(document).Range(document, from, to).Select();
        var selected = Local(editor, "selection_preview");
        Console.WriteLine("ADVERSARY SELECT " + selected["from"] + ".." + selected["to"] + " " + selected["quote"].ToString().Replace("\r", "\\r"));
        Local(editor, "mark_selection", new { documentId = id, ruleId = rule, prompt = "", quote = selected["quote"], from = selected["from"], to = selected["to"], snapshot = selected["snapshot"] });
    }
    private static Dictionary<string, object> Local(WordEditor editor, string operation, object arguments = null)
    { return Map(editor.Dispatch(operation, arguments == null ? new Dictionary<string, object>() : Map(arguments))); }

    private static Dictionary<string, object> Map(object value)
    { return McpEndpoint.Json().Deserialize<Dictionary<string, object>>(McpEndpoint.Json().Serialize(value)); }

    private static Dictionary<string, object> Tool(string address, string name, object arguments)
    {
        var response = Rpc(address, name, arguments);
        if (UiState.Flag(response, "isError")) throw new Exception(UiState.Text(UiState.Map(((IEnumerable)response["content"]).Cast<object>().First()), "text"));
        return Map(response["structuredContent"]);
    }

    private static void DeniedTool(string address, string name, object arguments)
    { Check(UiState.Flag(Rpc(address, name, arguments), "isError"), name + " rejects an unauthorized native request."); }

    private static Dictionary<string, object> Rpc(string address, string name, object arguments)
    {
        Task<string> pending = Task.Run(delegate {
            var request = (HttpWebRequest)WebRequest.Create(address);
            request.Method = "POST"; request.ContentType = "application/json"; request.Timeout = 20000;
            byte[] payload = Encoding.UTF8.GetBytes(McpEndpoint.Json().Serialize(new { jsonrpc = "2.0", id = 1, method = "tools/call", @params = new { name = name, arguments = arguments } }));
            using (Stream stream = request.GetRequestStream()) stream.Write(payload, 0, payload.Length);
            using (WebResponse response = request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream())) return reader.ReadToEnd();
        });
        DateTime deadline = DateTime.UtcNow.AddSeconds(25);
        while (!pending.IsCompleted && DateTime.UtcNow < deadline) { Application.DoEvents(); Thread.Sleep(10); }
        if (!pending.IsCompleted) throw new TimeoutException("The isolated native MCP operation did not complete.");
        var result = McpEndpoint.Json().Deserialize<Dictionary<string, object>>(pending.GetAwaiter().GetResult());
        if (result.ContainsKey("error")) throw new Exception(UiState.Text(UiState.Map(result["error"]), "message"));
        return Map(result["result"]);
    }

    private static string FileDigest(string path)
    {
        using (var stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        using (var sha = System.Security.Cryptography.SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(stream));
    }

    private static void Check(bool condition, string message)
    { assertions++; if (!condition) throw new Exception(message); Console.WriteLine("PASS: " + message); }
}
