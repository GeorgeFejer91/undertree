using System;
using System.Collections.Generic;
using System.Drawing;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace UnderTree.WordAddin
{
    public sealed class UiRibbonControl
    {
        public string Tag { get; set; }
    }

    internal static class UiLayoutSmoke
    {
        [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr argument, IntPtr value);
        [DllImport("user32.dll")] private static extern uint GetGuiResources(IntPtr process, uint flags);
        [DllImport("gdi32.dll")] private static extern uint GetObjectType(IntPtr handle);
        private static readonly List<string> checks = new List<string>();
        private static readonly List<string> captures = new List<string>();
        private static readonly List<Tuple<string, IDictionary<string, object>>> calls = new List<Tuple<string, IDictionary<string, object>>>();
        private static readonly List<IDictionary<string, object>> rules = new List<IDictionary<string, object>>();
        private static readonly Dictionary<string, object> document = new Dictionary<string, object>
        {
            { "id", "synthetic-ui-document" }, { "title", "Synthetic manuscript · no user document.docx" },
            { "shared", false }, { "revision", "revision-1" }
        };
        private static string output;
        private static string assetDirectory;
        private static bool selectionUnavailable;

        [STAThread]
        private static int Main(string[] arguments)
        {
            output = Path.GetFullPath(arguments.Length == 0 ? "artifacts/word-ui" : arguments[0]);
            assetDirectory = Path.GetFullPath(arguments.Length > 1 ? arguments[1] : Path.Combine("assets", "wraiter"));
            Directory.CreateDirectory(output);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            AddRules();
            try
            {
                CheckRules();
                CheckRibbon();
                CheckOverlappingRules();
                CheckContext();
                CheckConnections();
                CheckSmallPaging();
                CheckDetails();
                CheckBranding();
                WriteReport(true, null);
                Console.WriteLine("PASS: " + checks.Count + " native UI checks; " + captures.Count + " control renders.");
                return 0;
            }
            catch (Exception error)
            {
                WriteReport(false, error.ToString());
                Console.Error.WriteLine(error);
                return 1;
            }
        }

        private static void AddRules()
        {
            string[] names = { "Keep unchanged", "Make snappier", "Reject changes", "Discard idea", "Shorten" };
            string[] colors = { "#74b9a4", "#e5be50", "#d86e6e", "#bc8fc7", "#668ddd" };
            string[] actions = { "protect", "prompt", "reject", "discard", "prompt" };
            for (int index = 0; index < names.Length; index++)
                rules.Add(new Dictionary<string, object>
                {
                    { "id", "rule-" + index }, { "label", names[index] }, { "color", colors[index] },
                    { "action", actions[index] }, { "prompt", index == 1 ? "Keep the meaning; improve the wording." : "" },
                    { "accessMode", "suggestions" }
                });
        }

        private static object Dispatch(string operation, IDictionary<string, object> arguments)
        {
            calls.Add(Tuple.Create(operation, arguments));
            if (operation == "state") return new Dictionary<string, object>
            {
                { "document", document }, { "rules", rules.ToArray() },
                { "marks", Enumerable.Range(0, 27).Select(index => new Dictionary<string, object>
                    { { "id", "mark-" + index }, { "ruleId", "rule-1" }, { "quote", "Marked passage " + index + " with complete original text, 😀 and e\u0301." }, { "prompt", "Passage instruction " + index }, { "stale", index == 3 } }).ToArray() },
                { "proposals", Enumerable.Range(0, 19).Select(index => new Dictionary<string, object>
                    { { "id", "proposal-" + index }, { "quote", "Original passage " + index }, { "replacement", "Revised passage " + index }, { "status", "pending" } }).ToArray() },
                { "connection", Connection() }
            };
            if (operation == "connection_status") return Connection();
            if (operation == "selection_preview" && selectionUnavailable) throw new InvalidOperationException("Select prose first.");
            if (operation == "selection_preview") return new Dictionary<string, object>
            {
                { "quote", "Selected passage 😀 with a composed e\u0301." }, { "from", 10 }, { "to", 48 }, { "snapshot", "selection-proof" }
            };
            if (operation == "context_preview") return Preview();
            if (operation == "share_context") document["shared"] = true;
            if (operation == "revoke_context" || operation == "connection_stop") document["shared"] = false;
            return new Dictionary<string, object>();
        }

        private static Dictionary<string, object> Connection()
        {
            return new Dictionary<string, object>
            {
                { "running", false }, { "status", "Access is stopped." }, { "lastError", "" }, { "configured", true },
                { "publicMcpUrl", "https://example.invalid/synthetic-mcp-capability-do-not-use" }
            };
        }

        private static Dictionary<string, object> Preview()
        {
            string text = String.Join("\r\n\r\n", Enumerable.Repeat("Synthetic complete manuscript context. Unmarked text remains read-only. Highlighted passages may have prompt instructions, protection or proposal-only approval.", 12));
            return new Dictionary<string, object>
            {
                { "documentId", document["id"] }, { "text", text }, { "title", document["title"] }, { "characters", text.Length }, { "complete", true }, { "snapshot", "context-proof" }
            };
        }

        private static void CheckRules()
        {
            using (RuleDialog form = new RuleDialog(Dispatch, rules[1]))
            {
                Open(form);
                foreach (Size size in new[] { form.MinimumSize, new Size(700, 950), new Size(1050, 720), new Size(1050, 950), form.MinimumSize })
                {
                    form.Size = size;
                    Settle(form);
                    CheckBounds(form);
                    CheckChoiceText(form);
                }
                Capture(form, "color-rule-minimum");
                RadioButton direct = Descendants(form).OfType<RadioButton>().First(button => button.Text == "Edit text directly");
                CheckBox preserve = Descendants(form).OfType<CheckBox>().First(box => box.Text.StartsWith("Preserve text"));
                direct.Checked = true;
                preserve.Checked = true;
                Require(!direct.Enabled && !direct.Checked && !FindText(form, "Custom prompt").Enabled
                    && Descendants(form).OfType<CheckBox>().Where(box => box != preserve).All(box => !box.Enabled),
                    "Preserve text disables direct edits, all presets and the custom prompt.");
                Capture(form, "color-rule-preserve");
                preserve.Checked = false;
                ComboBox function = Descendants(form).OfType<ComboBox>().Single();
                function.SelectedIndex = 1;
                Require(!direct.Enabled && !FindText(form, "Custom prompt").Enabled, "Neutral colors expose no prompt or direct permission.");
                function.SelectedIndex = 0;
                direct.Checked = true;
                RadioButton shorten = Descendants(form).OfType<RadioButton>().First(box => box.Text == "Shorten");
                RadioButton detail = Descendants(form).OfType<RadioButton>().First(box => box.Text == "More detail");
                shorten.Checked = true;
                detail.Checked = true;
                Require(!shorten.Checked && detail.Checked, "Shorten and More detail are mutually exclusive.");
                shorten.Checked = true;
                Descendants(form).OfType<CheckBox>().First(box => box.Text == "Make snappier").Checked = true;
                Require(Descendants(form).OfType<CheckBox>().Any(box => box.Text == "Remove")
                    && Descendants(form).OfType<CheckBox>().Any(box => box.Text == "Get to the point"), "Requested remove and get-to-the-point presets are available.");
                FindText(form, "Custom prompt").Text = "Preserve measured results.";
                FindButton(form, "Save color rule").PerformClick();
                IDictionary<string, object> saved = calls.Last(call => call.Item1 == "save_rule").Item2;
                Require(UiState.Text(saved, "accessMode") == "direct" && UiState.Text(saved, "prompt").Contains("Shorten this passage")
                    && UiState.Text(saved, "prompt").Contains("Preserve measured results.") && UiState.Text(saved, "prompt").Contains("make the wording snappier")
                    && !UiState.Text(saved, "prompt").Contains("Add useful detail"), "Saving combines enabled presets, custom wording and explicit direct permission.");
                Require(UiState.Text(saved, "documentId") == "synthetic-ui-document", "Color rule changes carry the displayed document identity.");
            }
            using (RuleDialog form = new RuleDialog(Dispatch, rules[1]))
            {
                Open(form);
                FindText(form, "Custom prompt").Text = "This cannot override protection.";
                Descendants(form).OfType<CheckBox>().First(box => box.Text.StartsWith("Preserve text")).Checked = true;
                FindButton(form, "Save color rule").PerformClick();
                var saved = calls.Last(call => call.Item1 == "save_rule").Item2;
                Require(UiState.Text(saved, "action") == "protect" && UiState.Text(saved, "prompt") == "" && UiState.Text(saved, "accessMode") == "suggestions",
                    "Saving Preserve text produces protection with no effective prompt or direct permission.");
            }
            foreach (string action in new[] { "neutral", "reject", "discard" })
            {
                var rule = new Dictionary<string, object>(rules[1]);
                rule["action"] = action;
                using (RuleDialog form = new RuleDialog(Dispatch, rule))
                {
                    Open(form);
                    FindButton(form, "Save color rule").PerformClick();
                    Require(UiState.Text(calls.Last(call => call.Item1 == "save_rule").Item2, "action") == action,
                        "Opening and saving retains the existing " + action + " function.");
                }
            }
            using (RuleDialog form = new RuleDialog(Dispatch, rules[1]))
            {
                Open(form);
                form.Font = new Font(form.Font.FontFamily, form.Font.SizeInPoints * 2);
                form.Size = new Size(1600, 884);
                Settle(form);
                CheckBounds(form);
                CheckChoiceText(form);
                Capture(form, "color-rule-enlarged-text");
            }
            using (RuleDialog form = new RuleDialog(Dispatch, rules[1], "synthetic-ui-document", "exact-marker"))
            {
                Open(form);
                form.Size = form.MinimumSize;
                Settle(form);
                CheckBounds(form);
                Capture(form, "color-rule-context-marker");
                form.Font = new Font(form.Font.FontFamily, form.Font.SizeInPoints * 2);
                form.Size = new Size(1600, 884);
                Settle(form);
                CheckBounds(form);
                CheckChoiceText(form);
                Capture(form, "color-rule-context-marker-enlarged");
                FindButton(form, "Remove this marker").PerformClick();
                var removed = calls.Last(call => call.Item1 == "remove_mark").Item2;
                Require(UiState.Text(removed, "id") == "exact-marker" && UiState.Text(removed, "documentId") == "synthetic-ui-document",
                    "In-text rule dialog removes only the exact selected document marker.");
            }
        }

        private static void CheckRibbon()
        {
            int before = calls.Count(call => call.Item1 == "mark_selection");
            using (WordRibbon ribbon = new WordRibbon(Dispatch))
            {
                ribbon.Observe(new Dictionary<string, object> { { "rules", Enumerable.Range(0, 24).Select(index => new Dictionary<string, object> {
                    { "id", "slot-" + index }, { "label", "Color " + (index + 1) }, { "color", "#ffffff" }
                }).ToArray() } });
                Require(ribbon.Enabled(new UiRibbonControl { Tag = "23" }) && ribbon.Label(new UiRibbonControl { Tag = "23" }).Contains("Color 24"),
                    "The twenty-fourth color is directly available without paging.");
                ribbon.Observe(Dispatch("state", new Dictionary<string, object>()));
                ribbon.Highlight(new UiRibbonControl { Tag = "1" });
                Require(calls.Count(call => call.Item1 == "mark_selection") == before, "A first swatch click waits for the double-click decision.");
                typeof(WordRibbon).GetMethod("CommitPendingHighlight", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(ribbon, null);
                var added = calls.Last(call => call.Item1 == "mark_selection").Item2;
                Require(calls.Count(call => call.Item1 == "mark_selection") == before + 1
                    && UiState.Text(added, "ruleId") == "rule-1" && UiState.Text(added, "snapshot") == "selection-proof"
                    && UiState.Text(added, "documentId") == "synthetic-ui-document" && UiState.Text(added, "prompt") == "",
                    "A single swatch click marks the captured selection directly without a confirmation window.");
                foreach (bool unavailable in new[] { false, true })
                {
                    bool opened = false;
                    selectionUnavailable = unavailable;
                    try
                    {
                        using (Timer close = new Timer { Interval = 50 })
                        {
                            close.Tick += delegate {
                                var form = Application.OpenForms.OfType<RuleDialog>().FirstOrDefault();
                                if (form == null) return;
                                opened = true;
                                close.Stop();
                                form.Close();
                            };
                            close.Start();
                            ribbon.Highlight(new UiRibbonControl { Tag = "1" });
                            ribbon.Highlight(new UiRibbonControl { Tag = "1" });
                        }
                    }
                    finally { selectionUnavailable = false; }
                    Require(opened && calls.Count(call => call.Item1 == "mark_selection") == before + 1,
                        "Double-click opens only that color rule without marking, with " + (unavailable ? "no selected text." : "a selected passage."));
                }
            }
        }

        private static void CheckOverlappingRules()
        {
            var state = new Dictionary<string, object> {
                { "documentId", "synthetic-ui-document" }, { "rules", rules.ToArray() },
                { "choices", new[] {
                    new Dictionary<string, object> { { "id", "overlap-1" }, { "ruleId", "rule-0" }, { "label", "Keep unchanged" }, { "quote", "Protected words" } },
                    new Dictionary<string, object> { { "id", "overlap-2" }, { "ruleId", "rule-1" }, { "label", "Make snappier" }, { "quote", "Complete paragraph containing protected words" } }
                } }
            };
            using (HighlightedRulesDialog form = new HighlightedRulesDialog(Dispatch, state))
            {
                Open(form);
                form.Size = form.MinimumSize;
                Settle(form);
                CheckBounds(form);
                CheckPagedLists(form);
                Require(Descendants(form).OfType<ListBox>().Single().Items.Count == 2, "Overlapping colors remain an explicit choice.");
                Capture(form, "overlapping-color-choice");
                CheckEnlarged(form, "overlapping-color-enlarged");
            }
        }

        private static void CheckContext()
        {
            int before = calls.Count(call => call.Item1 == "share_context");
            using (ContextConsentDialog form = new ContextConsentDialog(Dispatch, Preview()))
            {
                Open(form);
                form.Size = form.MinimumSize;
                Settle(form);
                CheckBounds(form);
                Capture(form, "context-consent");
                CheckEnlarged(form, "context-consent-enlarged");
                Require(calls.Count(call => call.Item1 == "share_context") == before, "Previewing complete context does not share it.");
                FindButton(form, "Share context").PerformClick();
                Require(UiState.Text(calls.Last(call => call.Item1 == "share_context").Item2, "snapshot") == "context-proof",
                    "Context consent returns the exact preview snapshot for native revalidation.");
                Require(UiState.Text(calls.Last(call => call.Item1 == "share_context").Item2, "documentId") == "synthetic-ui-document",
                    "Context sharing is bound to the document shown in the preview.");
            }
            IDictionary<string, object> incomplete = Preview();
            incomplete["complete"] = false;
            bool denied = false;
            try { using (ContextConsentDialog form = new ContextConsentDialog(Dispatch, incomplete)) { } }
            catch (InvalidOperationException) { denied = true; }
            Require(denied, "Incomplete context cannot expose a Share action.");
        }

        private static void CheckConnections()
        {
            var openedLinks = new List<string>();
            bool sharedBefore = UiState.Flag(document, "shared");
            int effectsBefore = calls.Count(call => call.Item1 != "state" && call.Item1 != "connection_status");
            using (ConnectionsDialog form = new ConnectionsDialog(Dispatch, openedLinks.Add))
            {
                Open(form);
                form.Size = form.MinimumSize;
                TabControl tabs = Descendants(form).OfType<TabControl>().First();
                for (int index = 0; index < tabs.TabPages.Count; index++)
                {
                    tabs.SelectedIndex = index;
                    Settle(form);
                    CheckBounds(form);
                    CheckConnectionGuidance(form);
                    Capture(form, "connections-" + index);
                }
                Require(tabs.TabPages[2].Text == "Document access", "Document access identifies the separate document-read consent tab.");
                tabs.SelectedIndex = 1;
                Settle(form);
                LinkLabel[] links = Descendants(tabs.SelectedTab).OfType<LinkLabel>().ToArray();
                Require(links.Length == 2 && links.All(link => link.TabStop && link.CanSelect && link.Links.Count == 1),
                    "Two native setup links are keyboard-focusable and expose one complete target each.");
                Require((string)links[0].Links[0].LinkData == "https://myzrok.io"
                    && (string)links[1].Links[0].LinkData == "https://netfoundry.io/docs/zrok/get-started/get-token/",
                    "Setup links target only the fixed public zrok account and official token instructions.");
                TextBox token = FindText(form, "zrok enrollment token");
                token.Text = "synthetic-account-token-not-a-credential";
                links[0].Focus();
                bool activated = (bool)typeof(LinkLabel).GetMethod("ProcessDialogKey", BindingFlags.Instance | BindingFlags.NonPublic)
                    .Invoke(links[0], new object[] { Keys.Enter });
                Require(activated && openedLinks.SequenceEqual(new[] { "https://myzrok.io" }),
                    "Enter on the focused account link opens exactly its fixed public address.");
                form.SelectNextControl(links[0], true, true, true, false);
                Require(links[1].Focused, "Tab reaches the token instructions after the account link.");
                typeof(LinkLabel).GetMethod("OnLinkClicked", BindingFlags.Instance | BindingFlags.NonPublic)
                    .Invoke(links[1], new object[] { new LinkLabelLinkClickedEventArgs(links[1].Links[0]) });
                Require(openedLinks.SequenceEqual(new[] { "https://myzrok.io", "https://netfoundry.io/docs/zrok/get-started/get-token/" }),
                    "Clicking token help opens its fixed official instructions without a token or document value.");
                Require(token.Text == "synthetic-account-token-not-a-credential", "Opening setup instructions preserves the unsubmitted account-token input.");
                form.SelectNextControl(links[1], true, true, true, false);
                Require(FindText(form, "zrok enrollment token").Focused, "Keyboard order continues from documentation to the masked token input.");
                Require(UiState.Flag(document, "shared") == sharedBefore
                    && calls.Count(call => call.Item1 != "state" && call.Item1 != "connection_status") == effectsBefore,
                    "Opening Connections and its setup links neither starts a connection nor grants document access.");
                form.Font = new Font(form.Font.FontFamily, form.Font.SizeInPoints * 2);
                form.Size = new Size(1600, 884);
                for (int index = 0; index < tabs.TabPages.Count; index++)
                {
                    tabs.SelectedIndex = index;
                    Settle(form);
                    CheckBounds(form);
                    CheckConnectionGuidance(form);
                    CheckAppearance(form, SystemInformation.HighContrast);
                    Capture(form, "connections-enlarged-" + index);
                }
                Require(FindText(form, "zrok enrollment token").UseSystemPasswordChar, "Enrollment token is masked by default.");
                FindButton(form, "Revoke").PerformClick();
                Require(!UiState.Flag(document, "shared"), "The local Revoke action removes sharing.");
                Require(UiState.Text(calls.Last(call => call.Item1 == "revoke_context").Item2, "documentId") == "synthetic-ui-document", "Revoke identifies the displayed document.");
            }
        }

        private static void CheckConnectionGuidance(ConnectionsDialog form)
        {
            TabPage page = Descendants(form).OfType<TabControl>().Single().SelectedTab;
            foreach (Label label in Descendants(page).OfType<Label>().Where(label => label.Visible))
            {
                Size required = TextRenderer.MeasureText(label.Text, label.Font,
                    new Size(Math.Max(1, label.ClientSize.Width), Int32.MaxValue), TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix);
                Require(required.Height <= label.ClientSize.Height + 1,
                    "Connection guidance fits its native text allocation: " + label.Text);
            }
            Require(!page.AutoScroll && Descendants(page).OfType<ScrollableControl>().All(control => !control.AutoScroll),
                "Connection instructions fit without an internal panel scrollbar.");
            if (page.Text == "Setup")
            {
                Label[] steps = Descendants(page).OfType<Label>().Where(label => label.Text.Length > 2
                    && label.Text[0] >= '1' && label.Text[0] <= '4' && label.Text[1] == '.').ToArray();
                Require(steps.Length == 4 && steps.Select(label => label.Text[0]).SequenceEqual(new[] { '1', '2', '3', '4' })
                    && steps.Zip(steps.Skip(1), (first, next) => first.PointToScreen(Point.Empty).Y < next.PointToScreen(Point.Empty).Y).All(value => value),
                    "Four setup steps retain their reading order from account creation through the AI connector.");
                Require(steps[1].Text.Contains("API console") && steps[1].Text.Contains("Getting started") && steps[1].Text.Contains("account token")
                    && steps[2].Text.Contains("Configure connection") && steps[3].Text.Contains("Start access") && steps[3].Text.Contains("MCP address"),
                    "Setup explains where to obtain the account token and how to configure and start the bundled connection.");
                Require(Descendants(page).OfType<LinkLabel>().All(link => link.LinkBehavior == LinkBehavior.AlwaysUnderline && link.LinkColor == link.ForeColor
                    && link.ActiveLinkColor == link.ForeColor && link.VisitedLinkColor == link.ForeColor),
                    "Setup links retain visible underlines and the active native surface text palette.");
            }
            if (page.Text == "Document access")
            {
                string text = String.Join(" ", Descendants(page).OfType<Label>().Select(label => label.Text));
                Require(text.Contains("what the AI may read") && text.Contains("unsaved text") && text.Contains("explicitly share")
                    && text.Contains("Starting a connection grants no document access") && text.Contains("Edit rights are separate")
                    && text.Contains("color rules") && text.Contains("Unmarked text stays read-only") && text.Contains("Share again after reopening Word")
                    && text.Contains("Revoke removes access to this document") && text.Contains("every document"),
                    "Document access explains full-context consent, separate highlighted edit rights, session sharing and document versus global revocation.");
            }
        }

        private static void CheckDetails()
        {
            using (TextDetailDialog form = new TextDetailDialog("Complete native status", "A complete read-only native detail value. Long content retains its own editor scroll behavior."))
            {
                Open(form);
                form.Size = form.MinimumSize;
                Settle(form);
                CheckBounds(form);
                Capture(form, "detail-minimum");
                CheckEnlarged(form, "detail-enlarged");
            }
        }

        private static void CheckBranding()
        {
            foreach (string resource in new[] { "wrAIter.Icon.ico", "wrAIter.Ribbon.png" })
            {
                string file = resource.EndsWith("ico") ? "icon.ico" : "icon16.png";
                using (var stream = typeof(AppBranding).Assembly.GetManifestResourceStream(resource))
                using (var bytes = new MemoryStream())
                {
                    stream.CopyTo(bytes);
                    Require(bytes.ToArray().SequenceEqual(File.ReadAllBytes(Path.Combine(assetDirectory, file))),
                        "The embedded " + resource + " bytes exactly match the canonical export.");
                }
            }
            using (Bitmap image = AppBranding.DialogImage(32))
                Require(image.Size == new Size(32, 32) && image.GetPixel(0, 0).A == 0, "The dialog uses a square transparent 32px frame from the canonical ICO.");
            using (Button swatch = new Button { BackColor = Color.FromArgb(116, 185, 164) })
            {
                AppBranding.ApplyPalette(swatch, false);
                Require(swatch.BackColor == Color.FromArgb(116, 185, 164), "Brand styling preserves a functional highlight swatch color.");
                AppBranding.ApplyPalette(swatch, true);
                Require(swatch.BackColor == Color.FromArgb(116, 185, 164), "System contrast fallback preserves a functional highlight swatch color.");
            }
            using (TextDetailDialog form = new TextDetailDialog("System palette fallback", "Synthetic style check; Windows high contrast is not changed."))
            {
                Open(form);
                form.ApplyAppearance(true);
                Settle(form);
                CheckAppearance(form, true);
                CheckBounds(form);
                Capture(form, "system-palette-simulated");
                form.ApplyAppearance(false);
                Settle(form);
                CheckAppearance(form, false);
                Capture(form, "brand-palette-restored");
            }
            for (int index = 0; index < 3; index++) CloseBrandedDetail();
            CollectNativeWrappers();
            uint gdiBefore = GetGuiResources(Process.GetCurrentProcess().Handle, 0);
            uint userBefore = GetGuiResources(Process.GetCurrentProcess().Handle, 1);
            for (int index = 0; index < 20; index++) CloseBrandedDetail();
            CollectNativeWrappers();
            checks.Add("Native resource counts: GDI " + gdiBefore + " → " + GetGuiResources(Process.GetCurrentProcess().Handle, 0)
                + "; USER " + userBefore + " → " + GetGuiResources(Process.GetCurrentProcess().Handle, 1));
            Require(GetGuiResources(Process.GetCurrentProcess().Handle, 0) <= gdiBefore + 2,
                "Twenty dialog open/close cycles retain no GDI handle growth after framework font wrappers are finalized.");
            Require(GetGuiResources(Process.GetCurrentProcess().Handle, 1) <= userBefore + 2,
                "Twenty dialog open/close cycles do not accumulate native window/icon handles.");
        }

        private static void CollectNativeWrappers()
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
            Application.DoEvents();
        }

        private static void CloseBrandedDetail()
        {
            Image ownedImage;
            IntPtr ownedFont;
            using (TextDetailDialog form = new TextDetailDialog("Logo lifetime", "Synthetic disposal check."))
            {
                Open(form);
                ownedImage = Descendants(form).OfType<PictureBox>().Single(box => box.AccessibleName == "wrAIter").Image;
                ownedFont = (IntPtr)typeof(Control).GetProperty("FontHandle", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(form, null);
                form.Close();
            }
            bool disposed = false;
            try { int width = ownedImage.Width; }
            catch (ArgumentException) { disposed = true; }
            catch (ObjectDisposedException) { disposed = true; }
            Require(disposed, "Closing a dialog disposes its owned logo bitmap.");
            Require(GetObjectType(ownedFont) == 0, "Closing a dialog releases its allocated native font handle.");
        }

        private static void CheckAppearance(NativeDialog form, bool highContrast)
        {
            Color surface = highContrast ? SystemColors.Control : Color.FromArgb(251, 248, 239);
            Color text = highContrast ? SystemColors.ControlText : Color.FromArgb(27, 53, 48);
            Require(form.BackColor == surface && form.ForeColor == text, "The shared native window uses the " + (highContrast ? "system contrast fallback." : "approved cream and deep-green palette."));
            Require(Descendants(form).OfType<Label>().All(label => label.BackColor == surface && label.ForeColor == text),
                "Native body labels follow the selected surface/text palette.");
            PictureBox[] marks = Descendants(form).OfType<PictureBox>().Where(box => box.AccessibleName == "wrAIter").ToArray();
            Require(marks.Length == 1 && marks[0].Visible && marks[0].Width == marks[0].Height && marks[0].Width >= 24
                && !marks[0].TabStop && marks[0].Image != null, "One visible square logo occupies the existing footer without entering the keyboard order.");
            Require(SendMessage(form.Handle, 0x007f, new IntPtr(1), IntPtr.Zero) != IntPtr.Zero
                && SendMessage(form.Handle, 0x007f, IntPtr.Zero, IntPtr.Zero) != IntPtr.Zero, "The dialog retains its own large and small native icon handles.");
            Require(!form.AutoScroll && Descendants(form).OfType<ScrollableControl>().All(control => !control.AutoScroll),
                "Brand styling adds no internal panel scrollbar.");
            Require(Descendants(form).OfType<Button>().All(button => button.UseVisualStyleBackColor), "Actions retain native Windows rendering and focus behavior.");
        }

        private static void CheckEnlarged(NativeDialog form, string capture)
        {
            form.Font = new Font(form.Font.FontFamily, form.Font.SizeInPoints * 2);
            form.Size = new Size(1600, 884);
            Settle(form);
            CheckBounds(form);
            CheckChoiceText(form);
            CheckAppearance(form, SystemInformation.HighContrast);
            Capture(form, capture);
        }

        private static void CheckSmallPaging()
        {
            using (Form form = new Form { ClientSize = new Size(350, 95) })
            using (PagedRecordList records = new PagedRecordList("Small list", record => UiState.Text(record, "quote")))
            {
                form.Controls.Add(records);
                Open(form);
                records.UpdateRecords(Enumerable.Range(0, 40).Select(index => (IDictionary<string, object>)new Dictionary<string, object>
                    { { "id", "small-" + index }, { "quote", "Passage " + index } }).ToList());
                Settle(form);
                CheckPagedLists(form);
                string first = UiState.Text(records.Selected, "id");
                FindButton(form, "Next").PerformClick();
                Require(UiState.Text(records.Selected, "id") != first, "Paging reaches records beyond the bounded visible list.");
            }
        }

        private static void Open(Form form)
        {
            form.StartPosition = FormStartPosition.Manual;
            form.Location = new Point(-5000, -5000);
            form.ShowInTaskbar = false;
            form.Show();
            Settle(form);
            NativeDialog branded = form as NativeDialog;
            if (branded != null)
            {
                CheckAppearance(branded, SystemInformation.HighContrast);
                branded.ApplyAppearance(true);
                CheckAppearance(branded, true);
                branded.ApplyAppearance(SystemInformation.HighContrast);
            }
        }

        private static void Settle(Form form)
        {
            form.PerformLayout();
            Application.DoEvents();
            form.PerformLayout();
            Application.DoEvents();
        }

        private static IEnumerable<Control> Descendants(Control root)
        {
            foreach (Control child in root.Controls)
            {
                yield return child;
                foreach (Control descendant in Descendants(child)) yield return descendant;
            }
        }

        private static Button FindButton(Control form, string label)
        {
            return Descendants(form).OfType<Button>().First(button => button.Text == label);
        }

        private static TextBox FindText(Control form, string name)
        {
            return Descendants(form).OfType<TextBox>().First(box => box.AccessibleName == name);
        }

        private static void CheckBounds(Form form)
        {
            foreach (Control control in Descendants(form).Where(control => control.Visible && !(control is TabPage)))
            {
                Rectangle bounds = control.Bounds;
                if (bounds.Left < 0 || bounds.Top < 0 || bounds.Right > control.Parent.ClientSize.Width + 1 || bounds.Bottom > control.Parent.ClientSize.Height + 1)
                {
                    Capture(form, "layout-failure");
                    throw new InvalidOperationException(form.Text + " at " + form.Size + " minimum " + form.MinimumSize + ": " + control.GetType().Name + " " + control.Text + " is outside its parent. " + bounds + " in " + control.Parent.ClientSize);
                }
                if (control is Button && (bounds.Width < 20 || bounds.Height < 20))
                    throw new InvalidOperationException(form.Text + ": action control is too small: " + control.Text);
                var table = control.Parent as TableLayoutPanel;
                if (table != null)
                {
                    TableLayoutPanelCellPosition cell = table.GetCellPosition(control);
                    int[] rowHeights = table.GetRowHeights();
                    int[] columnWidths = table.GetColumnWidths();
                    if (cell.Row >= 0 && cell.Column >= 0)
                    {
                        int top = table.Padding.Top + rowHeights.Take(cell.Row).Sum();
                        int left = table.Padding.Left + columnWidths.Take(cell.Column).Sum();
                        Require(bounds.Left >= left && bounds.Top >= top && bounds.Right <= left + columnWidths[cell.Column] + 1
                            && bounds.Bottom <= top + rowHeights[cell.Row] + 1,
                            "Native table cell contains " + control.GetType().Name + " " + control.Text + " " + bounds
                            + " in cell " + cell + " " + new Rectangle(left, top, columnWidths[cell.Column], rowHeights[cell.Row])
                            + (cell.Row < table.RowStyles.Count ? " row style " + table.RowStyles[cell.Row].SizeType + " " + table.RowStyles[cell.Row].Height : " implicit row style"));
                    }
                }
            }
            checks.Add(form.Text + " native control bounds at " + form.Size + " / " + form.Font.SizeInPoints + "pt");
        }

        private static void CheckChoiceText(Form form)
        {
            foreach (ButtonBase choice in Descendants(form).OfType<ButtonBase>().Where(choice => choice.Visible && (choice is RadioButton || choice is CheckBox)))
            {
                Size required = TextRenderer.MeasureText(choice.Text, choice.Font, new Size(Math.Max(1, choice.ClientSize.Width - 24), Int32.MaxValue), TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix);
                if (required.Height > choice.ClientSize.Height) Capture(form, "choice-text-failure");
                Require(required.Height <= choice.ClientSize.Height, "Choice text fits its measured native allocation: " + choice.Text + " needs " + required.Height + " in " + choice.ClientSize);
            }
        }

        private static void CheckPagedLists(Control form)
        {
            foreach (ListBox list in Descendants(form).OfType<ListBox>().Where(list => list.Visible))
                Require(list.Items.Count * list.ItemHeight <= list.ClientSize.Height,
                    "Paged list has no internal scrollbar: " + list.AccessibleName);
        }

        private static void Capture(Form form, string name)
        {
            using (Bitmap bitmap = new Bitmap(form.Width, form.Height))
            {
                form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
                string path = Path.Combine(output, name + ".png");
                bitmap.Save(path, System.Drawing.Imaging.ImageFormat.Png);
                captures.Add(path);
            }
        }

        private static void Require(bool value, string message)
        {
            if (!value) throw new InvalidOperationException(message);
            checks.Add(message);
        }

        private static void WriteReport(bool passed, string error)
        {
            File.WriteAllText(Path.Combine(output, "ui-report.json"), new JavaScriptSerializer().Serialize(
                new { passed = passed, checks = checks, captures = captures, error = error, scope = "Native WinForms component geometry and UI dispatch contract with synthetic document data; no installed Word or public connection qualification. System palette fallback is simulated without changing Windows high contrast settings." }));
        }
    }
}
