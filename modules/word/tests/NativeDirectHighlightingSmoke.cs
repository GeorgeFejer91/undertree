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

internal static class NativeDirectHighlightingSmoke
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
                    string nativeBeforeColor = WordSnapshot.Capture(document).Revision;
                    var color = Tool(address, "highlight_text", new { documentId = documentId, marking = marking });
                    string colorId = UiState.Text(color, "colorId");
                    state = Local(editor, "state");
                    var neutral = UiState.Records(state, "rules").First(rule => UiState.Text(rule, "id") == colorId);
                    Check(UiState.Text(neutral, "action") == "neutral" && UiState.Text(neutral, "prompt") == "", "The real Word MCP action creates functionless neutral color.");
                    Check(UiState.Records(state, "marks").Count == 2 && WordSnapshot.Capture(document).MainText == text, "Both native structured marks preserve all source wording.");
                    Tool(address, "highlight_text", new { documentId = documentId, marking = marking });
                    Check(UiState.Records(Local(editor, "state"), "marks").Count == 2, "Native lost-reply replay creates no duplicate marks.");
                    Check(FileDigest(path) == diskBefore, "Remote marking never saves the DOCX.");
                    string nativeAfterColor = WordSnapshot.Capture(document).Revision;
                    Check((bool)document.Undo(1), "One native Undo reverses the entire neutral marking batch.");
                    state = Local(editor, "state");
                    Check(WordSnapshot.Capture(document).Revision == nativeBeforeColor && UiState.Records(state, "marks").Count == 0,
                        "Neutral batch Undo restores exact source, native structures, formatting and marker map.");
                    Check(!UiState.Flag(UiState.Map(state["document"]), "shared") && UiState.Records(state, "rules").Any(rule => UiState.Text(rule, "id") == colorId && UiState.Text(rule, "action") == "neutral"),
                        "Undo revokes sharing and retains a functionless consumed color identity.");
                    Check((bool)document.Redo(1), "One native Redo restores the complete neutral marking batch.");
                    state = Local(editor, "state");
                    Check(WordSnapshot.Capture(document).Revision == nativeAfterColor && UiState.Records(state, "marks").Count == 2 && UiState.Records(state, "marks").All(mark => !UiState.Flag(mark, "stale")),
                        "Neutral batch Redo restores exact markers and native formatting without stale anchors.");
                    Check(!UiState.Flag(UiState.Map(state["document"]), "shared") && FileDigest(path) == diskBefore,
                        "Neutral batch Undo/Redo grants no sharing and never saves the source.");
                    preview = Local(editor, "context_preview");
                    Local(editor, "share_context", new { snapshot = preview["snapshot"], documentId = documentId });
                    context = Tool(address, "read_manuscript", new { manuscript_id = documentId });
                    DeniedTool(address, "highlight_text", new { documentId = documentId, marking = marking });
                    context = Tool(address, "read_manuscript", new { manuscript_id = documentId });
                    string beforeRepeat = WordSnapshot.Capture(document).Revision;
                    var repeatMarking = new { requestId = "same_color_repeat", revision = context["revision"], contextId = context["context_id"], colorId = colorId,
                        ranges = new[] { new { from = 0, to = 3, quote = "[B]" }, new { from = fieldFrom, to = fieldTo, quote = text.Substring(fieldFrom, fieldTo - fieldFrom) } } };
                    Tool(address, "highlight_text", new { documentId = documentId, marking = repeatMarking });
                    state = Local(editor, "state");
                    Check(WordSnapshot.Capture(document).Revision == beforeRepeat && UiState.Records(state, "marks").Count == 4 && UiState.Flag(UiState.Map(state["document"]), "shared"),
                        "Identically shaded neutral marking retains its exact four markers and sharing on an ordinary refresh.");
                    Check((bool)document.Undo(1), "One native Undo reverses a bookmark-only neutral marking batch.");
                    state = Local(editor, "state");
                    Check(WordSnapshot.Capture(document).Revision == beforeRepeat && UiState.Records(state, "marks").Count == 2 && !UiState.Flag(UiState.Map(state["document"]), "shared"),
                        "Bookmark-only Undo restores the prior marker map and revokes sharing despite an unchanged body hash.");
                    Check((bool)document.Redo(1), "One native Redo restores a bookmark-only neutral marking batch.");
                    state = Local(editor, "state");
                    Check(WordSnapshot.Capture(document).Revision == beforeRepeat && UiState.Records(state, "marks").Count == 4 && UiState.Records(state, "marks").All(mark => !UiState.Flag(mark, "stale")) &&
                        !UiState.Flag(UiState.Map(state["document"]), "shared") && FileDigest(path) == diskBefore,
                        "Bookmark-only Redo restores exact live markers without sharing or saving.");
                    Check((bool)document.Undo(1), "The repeated neutral batch can be undone again.");
                    state = Local(editor, "state");
                    Check(UiState.Records(state, "marks").Count == 2 && !UiState.Flag(UiState.Map(state["document"]), "shared"),
                        "A second bookmark-only Undo retains the original two markers without restoring permission.");
                    preview = Local(editor, "context_preview");
                    Local(editor, "share_context", new { snapshot = preview["snapshot"], documentId = documentId });
                    context = Tool(address, "read_manuscript", new { manuscript_id = documentId });
                    DeniedTool(address, "highlight_text", new { documentId = documentId, marking = repeatMarking });
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
                    context = Tool(address, "read_manuscript", new { manuscript_id = documentId });
                    var request = new { manuscript_id = documentId, request_id = "native_preserve_pending", revision = context["revision"], context_id = context["context_id"],
                        from = 0, to = text.Length - 1, quote = text.Substring(0, text.Length - 1), replacement = "",
                        replacementParts = new object[] { new { protectedId = fieldId }, new { text = " before " }, new { protectedId = firstId }, new { text = "." } } };
                    if (!directMode)
                    {
                        string beforeRefusal = WordSnapshot.Capture(document).Revision;
                        int bookmarksBefore = (int)document.Bookmarks.Count;
                        var refused = Rpc(address, "suggest_text", request);
                        string reason = UiState.Text(UiState.Map(((IEnumerable)refused["content"]).Cast<object>().First()), "text");
                        Check(UiState.Flag(refused, "isError") && reason.Contains("Preserve text"),
                            "Tracked mode refuses a protected enclosing rewrite it cannot preserve natively.");
                        Check(WordSnapshot.Capture(document).Revision == beforeRefusal && (int)document.Bookmarks.Count == bookmarksBefore
                            && (int)document.Revisions.Count == 0 && UiState.Records(Local(editor, "state"), "proposals").Count == 0,
                            "Refusing a tracked protected overlap preserves native text, structures, markers and review state.");
                        Local(editor, "save_rule", new { documentId = documentId, id = "snappier", label = "Direct enclosing rewrite",
                            color = "#e5be50", action = "prompt", prompt = "Improve clarity.", accessMode = "direct" });
                        context = Tool(address, "read_manuscript", new { manuscript_id = documentId });
                        request = new { manuscript_id = documentId, request_id = "native_preserve_direct", revision = context["revision"], context_id = context["context_id"],
                            from = 0, to = text.Length - 1, quote = text.Substring(0, text.Length - 1), replacement = "",
                            replacementParts = new object[] { new { protectedId = fieldId }, new { text = " before " }, new { protectedId = firstId }, new { text = "." } } };
                    }
                    var applied = Tool(address, "suggest_text", request);
                    Check(UiState.Text(applied, "status") == "applied", "Explicit local direct permission permits the native protected enclosing rewrite.");
                    string expected = text.Substring(fieldFrom, fieldTo - fieldFrom) + " before [B].\r";
                    Check(WordSnapshot.Capture(document).MainText == expected && (int)document.Fields.Count == 2 && (int)document.Hyperlinks.Count == 1,
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
                    Check(!UiState.Flag(UiState.Map(state["document"]), "shared") && UiState.Records(state, "marks").Count == 3,
                        "Normal save/reopen preserves independent protection marks and no sharing authority.");
                    Check(WordSnapshot.Capture(document).MainText == expected && (int)document.Fields.Count == 2 && (int)document.Hyperlinks.Count == 1,
                        "DOCX save/reopen preserves exact reconstructed text, native fields and link.");
                    Local(editor, "connection_stop");
                }
                finally { if (File.Exists(sidecar)) File.Delete(sidecar); }
            }
        }
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
