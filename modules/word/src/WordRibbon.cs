using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.Text;
using System.Windows.Forms;

namespace UnderTree.WordAddin
{
    internal sealed class WordRibbon : IDisposable
    {
        private readonly Func<string, IDictionary<string, object>, object> dispatch;
        private readonly Timer clickTimer = new Timer { Interval = SystemInformation.DoubleClickTime };
        private object ribbonUi;
        private string pendingRule;
        private string pendingDocument;
        private IDictionary<string, object> pendingSelection;
        private Exception pendingSelectionError;
        private List<IDictionary<string, object>> rules = new List<IDictionary<string, object>>();

        internal WordRibbon(Func<string, IDictionary<string, object>, object> dispatch)
        {
            this.dispatch = dispatch;
            clickTimer.Tick += delegate { Attempt(CommitPendingHighlight); };
        }

        internal void Load(object ui) { ribbonUi = ui; Invalidate(); }
        internal void Observe(object result)
        {
            var state = UiState.Map(result);
            if (!state.ContainsKey("rules")) return;
            rules = UiState.Records(state, "rules");
            Invalidate();
        }

        internal void Invalidate()
        {
            if (ribbonUi == null) return;
            try { ((dynamic)ribbonUi).Invalidate(); }
            catch (System.Runtime.InteropServices.COMException) { ribbonUi = null; }
        }

        internal static string GroupXml(string suffix)
        {
            var xml = new StringBuilder("<group id=\"wrAIterColors" + suffix + "\" label=\" \"><box id=\"wrAIterSwatches" + suffix + "\" boxStyle=\"horizontal\">");
            for (int slot = 0; slot < 24; slot++)
            {
                if (slot % 3 == 0) xml.Append("<box id=\"wrAIterColorColumn" + suffix + slot + "\" boxStyle=\"vertical\">");
                xml.Append("<button id=\"wrAIterColor" + suffix + slot + "\" tag=\"" + slot + "\" size=\"normal\" showLabel=\"false\" showImage=\"true\" keytip=\"W" + (slot + 1).ToString("00", CultureInfo.InvariantCulture) + "\" getLabel=\"RibbonColorLabel\" getScreentip=\"RibbonColorLabel\" getImage=\"RibbonColorImage\" getVisible=\"RibbonColorEnabled\" getEnabled=\"RibbonColorEnabled\" onAction=\"RibbonColor\"/>");
                if (slot % 3 == 2) xml.Append("</box>");
            }
            xml.Append("</box><box id=\"wrAIterColorActions" + suffix + "\" boxStyle=\"vertical\">");
            xml.Append("<button id=\"wrAIterNew" + suffix + "\" size=\"normal\" showLabel=\"false\" showImage=\"true\" imageMso=\"TextHighlightColorPicker\" label=\"New color rule\" screentip=\"Define a new color rule\" keytip=\"WN\" onAction=\"RibbonColorRules\"/>");
            xml.Append("<button id=\"wrAIterSelectionRules" + suffix + "\" size=\"normal\" showLabel=\"false\" showImage=\"true\" imageMso=\"ReviewProtectDocument\" label=\"Rules at selection\" screentip=\"Open rules at highlighted selection (keyboard: ribbon keytip WT)\" keytip=\"WT\" onAction=\"RibbonSelectionRules\"/>");
            xml.Append("<button id=\"wrAIterSettings" + suffix + "\" tag=\"brand\" size=\"normal\" showLabel=\"false\" showImage=\"true\" getImage=\"RibbonColorImage\" label=\"Connections\" screentip=\"Connections and document context sharing\" keytip=\"WE\" onAction=\"RibbonConnections\"/>");
            return xml.Append("</box></group>").ToString();
        }

        private IDictionary<string, object> Rule(object control)
        {
            int slot = Int32.Parse(Convert.ToString(((dynamic)control).Tag, CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);
            return slot >= 0 && slot < rules.Count && slot < 24 ? rules[slot] : null;
        }

        internal string Label(object control)
        {
            try { var rule = Rule(control); return rule == null ? "No color rule in this slot" : "Highlight selection: " + UiState.Text(rule, "label") + ". Double-click to configure this color."; }
            catch (Exception error) { return "wrAIter: " + error.Message; }
        }

        internal bool Enabled(object control)
        {
            try { return Rule(control) != null; }
            catch (Exception) { return false; }
        }

        internal object Image(object control)
        {
            if (Convert.ToString(((dynamic)control).Tag, CultureInfo.InvariantCulture) == "brand")
                using (var image = AppBranding.RibbonImage()) return RibbonPicture.Convert(image);
            Color color = SystemColors.Control;
            try { var rule = Rule(control); if (rule != null) color = ColorTranslator.FromHtml(UiState.Text(rule, "color")); }
            catch (Exception) { color = SystemColors.Control; }
            using (var image = new Bitmap(16, 16))
            using (Graphics graphics = Graphics.FromImage(image))
            using (var fill = new SolidBrush(color))
            {
                graphics.Clear(Color.Transparent);
                graphics.FillRectangle(fill, 1, 1, 13, 13);
                graphics.DrawRectangle(SystemPens.ControlDarkDark, 1, 1, 13, 13);
                return RibbonPicture.Convert(image);
            }
        }

        internal void Highlight(object control)
        {
            Attempt(delegate {
                var state = UiState.Map(dispatch("state", new Dictionary<string, object>()));
                Observe(state);
                var rule = Rule(control);
                if (rule == null) throw new InvalidOperationException("Choose an available color rule.");
                string id = UiState.Text(rule, "id");
                string documentId = UiState.Text(UiState.Map(UiState.Get(state, "document")), "id");
                if (clickTimer.Enabled && pendingRule == id && pendingDocument == documentId)
                {
                    CancelPendingHighlight();
                    using (var dialog = new RuleDialog(dispatch, rule, documentId)) dialog.ShowDialog();
                }
                else
                {
                    if (clickTimer.Enabled) CommitPendingHighlight();
                    pendingRule = id;
                    pendingDocument = documentId;
                    try { pendingSelection = UiState.Map(dispatch("selection_preview", UiState.Args("documentId", documentId))); }
                    catch (Exception error) { pendingSelectionError = error; }
                    clickTimer.Start();
                }
            });
        }

        private void CommitPendingHighlight()
        {
            var selection = pendingSelection;
            var error = pendingSelectionError;
            string ruleId = pendingRule;
            string documentId = pendingDocument;
            CancelPendingHighlight();
            if (error != null) throw error;
            if (selection == null || UiState.Text(selection, "quote").Length == 0)
                throw new InvalidOperationException("Select a passage to highlight, or double-click the color to configure it.");
            var arguments = new Dictionary<string, object>(selection);
            arguments["ruleId"] = ruleId;
            arguments["documentId"] = documentId;
            arguments["prompt"] = "";
            Observe(dispatch("mark_selection", arguments));
        }

        internal void CancelPendingHighlight()
        {
            clickTimer.Stop();
            pendingRule = null;
            pendingDocument = null;
            pendingSelection = null;
            pendingSelectionError = null;
        }

        internal void Configure()
        {
            CancelPendingHighlight();
            Attempt(delegate {
                var state = UiState.Map(dispatch("state", new Dictionary<string, object>()));
                Observe(state);
                if (rules.Count >= 24) throw new InvalidOperationException("The document already has 24 color rules. Double-click a color to edit it.");
                using (var dialog = new RuleDialog(dispatch, null, UiState.Text(UiState.Map(UiState.Get(state, "document")), "id"))) dialog.ShowDialog();
            });
        }

        private void Attempt(Action action)
        {
            try { action(); }
            catch (Exception error) { MessageBox.Show(error.Message, "wrAIter for Word", MessageBoxButtons.OK, MessageBoxIcon.Information); }
            finally { Invalidate(); }
        }

        public void Dispose() { CancelPendingHighlight(); clickTimer.Dispose(); }

        private sealed class RibbonPicture : AxHost
        {
            private RibbonPicture() : base("") { }
            internal static object Convert(Image image) { return GetIPictureDispFromPicture(image); }
        }
    }
}
