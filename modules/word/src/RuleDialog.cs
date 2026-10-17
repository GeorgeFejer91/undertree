using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace UnderTree.WordAddin
{
    internal sealed class RuleDialog : NativeDialog
    {
        private readonly Func<string, IDictionary<string, object>, object> dispatch;
        private readonly string ruleId;
        private readonly string documentId;
        private readonly TextBox nameInput;
        private readonly TextBox colorInput;
        private readonly TextBox promptInput;
        private readonly CheckBox preserve;
        private readonly ComboBox function;
        private readonly RadioButton suggestions;
        private readonly RadioButton direct;
        private readonly GroupBox accessGroup;
        private readonly GroupBox presetGroup;
        private readonly GroupBox lengthGroup;
        private readonly TableLayoutPanel presetChoices;
        private readonly TableLayoutPanel behaviorLayout;
        private readonly TableLayoutPanel functionRow;
        private readonly Dictionary<CheckBox, string> presets = new Dictionary<CheckBox, string>();
        private readonly Dictionary<RadioButton, string> lengths = new Dictionary<RadioButton, string>();
        private bool arrangingRows;
        private bool geometryQueued;
        private static readonly string[] Actions = { "prompt", "neutral", "reject", "discard" };

        internal RuleDialog(Func<string, IDictionary<string, object>, object> dispatch, IDictionary<string, object> rule, string documentId = null, string markId = null)
            : base(rule == null ? "New color rule" : UiState.Text(rule, "label") + " · color rule", new Size(700, 720))
        {
            this.dispatch = dispatch;
            if (documentId == null)
            {
                var state = UiState.Map(dispatch("state", new Dictionary<string, object>()));
                documentId = UiState.Text(UiState.Map(UiState.Get(state, "document")), "id");
            }
            this.documentId = documentId;
            rule = rule ?? new Dictionary<string, object>
            {
                { "label", "New color rule" }, { "color", "#6c8fb5" }, { "action", "prompt" },
                { "prompt", "" }, { "accessMode", "suggestions" }
            };
            ruleId = UiState.Text(rule, "id");
            if (ruleId.Length == 0) ruleId = Guid.NewGuid().ToString("N");
            nameInput = NativeLayout.TextBox("Rule name", false, false);
            nameInput.Text = UiState.Text(rule, "label");
            nameInput.MaxLength = 100;
            colorInput = NativeLayout.TextBox("Color", false, false);
            colorInput.Text = UiState.Text(rule, "color");
            colorInput.MaxLength = 7;
            Button choose = NativeLayout.Button("Choose color…", ChooseColor);
            TableLayoutPanel color = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 2 };
            color.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            color.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            color.Controls.Add(colorInput, 0, 0);
            color.Controls.Add(choose, 1, 0);
            TableLayoutPanel identity = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 2 };
            identity.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 55));
            identity.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 45));
            identity.Controls.Add(NativeLayout.Stack(NativeLayout.Label("Rule name"), nameInput), 0, 0);
            identity.Controls.Add(NativeLayout.Stack(NativeLayout.Label("Color"), color), 1, 0);

            preserve = Choice("Preserve text · AI cannot change this text");
            preserve.Checked = UiState.Text(rule, "action") == "protect";
            function = new ComboBox { Anchor = AnchorStyles.Left | AnchorStyles.Right, DropDownStyle = ComboBoxStyle.DropDownList, AccessibleName = "Rule function" };
            function.MinimumSize = new Size(0, function.PreferredHeight);
            function.FontChanged += delegate { function.MinimumSize = new Size(0, function.PreferredHeight); };
            function.Items.AddRange(new object[] { "Follow wording instructions", "Color only · no AI function", "Reject AI changes", "Suggest deleting the complete passage" });
            int actionIndex = Array.IndexOf(Actions, UiState.Text(rule, "action"));
            function.SelectedIndex = Math.Max(0, actionIndex);
            functionRow = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 2 };
            functionRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            functionRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            functionRow.Controls.Add(NativeLayout.Label("Function"), 0, 0);
            functionRow.Controls.Add(function, 1, 0);

            suggestions = AccessChoice("Suggestions · Track Changes");
            direct = AccessChoice("Edit text directly");
            direct.Checked = UiState.Text(rule, "accessMode") == "direct";
            suggestions.Checked = !direct.Checked;
            accessGroup = NativeLayout.Group("Mode", ChoiceRow(suggestions, direct));
            behaviorLayout = NativeLayout.Column();
            behaviorLayout.AutoSize = true;
            behaviorLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            behaviorLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            behaviorLayout.Controls.Add(functionRow, 0, 0);
            behaviorLayout.Controls.Add(accessGroup, 0, 1);

            List<string> lines = UiState.Text(rule, "prompt").Replace("\r\n", "\n").Split('\n').ToList();
            var presetDefinitions = ReadPresets();
            presetChoices = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2 };
            presetChoices.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
            presetChoices.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
            foreach (var definition in presetDefinitions.Where(entry => UiState.Text(entry, "id") != "shorten" && UiState.Text(entry, "id") != "detail"))
            {
                string prompt = UiState.Text(definition, "prompt");
                CheckBox choice = Choice(UiState.Text(definition, "label"));
                choice.Checked = lines.Remove(prompt);
                presets.Add(choice, prompt);
                int index = presetChoices.Controls.Count;
                if (index % 2 == 0) presetChoices.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
                presetChoices.Controls.Add(choice, index % 2, index / 2);
            }
            presetGroup = NativeLayout.Group("Wording instructions · choose any", presetChoices);
            var unchanged = AccessChoice("Keep current length");
            unchanged.Checked = true;
            lengths.Add(unchanged, "");
            foreach (var definition in presetDefinitions.Where(entry => UiState.Text(entry, "id") == "shorten" || UiState.Text(entry, "id") == "detail"))
            {
                string prompt = UiState.Text(definition, "prompt");
                RadioButton choice = AccessChoice(UiState.Text(definition, "label"));
                lengths.Add(choice, prompt);
                if (lines.Remove(prompt)) choice.Checked = true;
            }
            lengthGroup = NativeLayout.Group("Length", ChoiceRow(lengths.Keys.ToArray()));
            promptInput = NativeLayout.TextBox("Custom prompt", true, false);
            promptInput.MinimumSize = new Size(0, 54);
            promptInput.MaxLength = 4000;
            promptInput.Text = String.Join(Environment.NewLine, lines);
            Label help = NativeLayout.Label("Save applies to every passage with this color. Review suggestions in Word's Review tab.");
            Button save = NativeLayout.Button("Save color rule", SaveRule);
            Button cancel = NativeLayout.Button("Cancel", delegate { DialogResult = DialogResult.Cancel; Close(); });
            List<Control> actions = new List<Control> { save, cancel };
            if (markId != null)
            {
                Button remove = NativeLayout.Button("Remove this marker", delegate {
                    NativeLayout.Attempt(this, delegate {
                        dispatch("remove_mark", new Dictionary<string, object> { { "id", markId }, { "documentId", this.documentId } });
                        DialogResult = DialogResult.OK;
                        Close();
                    });
                });
                remove.AccessibleDescription = "Remove only this passage's AI color marker. Keep its text and formatting.";
                actions.Insert(0, remove);
            }
            AcceptButton = save;
            CancelButton = cancel;
            Shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Shell.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
            Shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Shell.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
            Shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Shell.Controls.Add(identity, 0, 0);
            Shell.Controls.Add(preserve, 0, 1);
            Shell.Controls.Add(behaviorLayout, 0, 2);
            Shell.Controls.Add(presetGroup, 0, 4);
            Shell.Controls.Add(lengthGroup, 0, 5);
            Shell.Controls.Add(NativeLayout.Group("Custom prompt", promptInput), 0, 6);
            Shell.Controls.Add(help, 0, 7);
            Shell.Controls.Add(NativeLayout.Actions(actions.ToArray()), 0, 8);
            foreach (GroupBox group in Shell.Controls.OfType<GroupBox>()) group.Padding = new Padding(10, 6, 10, 9);
            accessGroup.Padding = new Padding(10, 6, 10, 9);
            presetChoices.SizeChanged += delegate { ReflowPresets(); };
            presetChoices.FontChanged += delegate { ReflowPresets(); };
            behaviorLayout.SizeChanged += delegate { ReflowBehavior(); };
            behaviorLayout.FontChanged += delegate { ReflowBehavior(); };
            SizeChanged += delegate { QueueGeometry(); };
            FontChanged += delegate { QueueGeometry(); };
            Shown += delegate { QueueGeometry(); };
            preserve.CheckedChanged += BehaviorChanged;
            function.SelectedIndexChanged += BehaviorChanged;
            BehaviorChanged(this, EventArgs.Empty);
        }

        private static List<IDictionary<string, object>> ReadPresets()
        {
            List<IDictionary<string, object>> definitions;
            using (var stream = typeof(RuleDialog).Assembly.GetManifestResourceStream("SelectiveEditorContract"))
            using (var reader = new StreamReader(stream))
                definitions = UiState.Records(UiState.Map(new JavaScriptSerializer().DeserializeObject(reader.ReadToEnd())), "presets");
            definitions.Add(new Dictionary<string, object> { { "id", "remove" }, { "label", "Remove" }, { "prompt", "Remove this passage." } });
            definitions.Add(new Dictionary<string, object> { { "id", "point" }, { "label", "Get to the point" }, { "prompt", "Get to the point; state the main claim directly and remove unnecessary lead-ins." } });
            return definitions;
        }

        private void ReflowPresets()
        {
            int preferredWidth = presets.Keys.Max(choice => TextRenderer.MeasureText(choice.Text, choice.Font).Width + 34);
            int columns = Math.Max(2, Math.Min(4, presetChoices.ClientSize.Width / Math.Max(1, preferredWidth)));
            int rows = (presets.Count + columns - 1) / columns;
            int minimumHeight = rows * presets.Keys.Max(choice => choice.PreferredSize.Height + choice.Margin.Vertical);
            presetChoices.MinimumSize = new Size(0, minimumHeight);
            presetGroup.MinimumSize = new Size(0, minimumHeight + presetGroup.Font.Height + presetGroup.Padding.Vertical);
            AllocateRows();
            if (columns == presetChoices.ColumnCount) return;
            presetChoices.SuspendLayout();
            try
            {
                presetChoices.Controls.Clear();
                presetChoices.ColumnStyles.Clear();
                presetChoices.RowStyles.Clear();
                presetChoices.ColumnCount = columns;
                presetChoices.RowCount = rows;
                for (int index = 0; index < columns; index++) presetChoices.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f / columns));
                for (int index = 0; index < presetChoices.RowCount; index++) presetChoices.RowStyles.Add(new RowStyle(SizeType.Percent, 100f / presetChoices.RowCount));
                int position = 0;
                foreach (CheckBox choice in presets.Keys)
                {
                    presetChoices.Controls.Add(choice, position % columns, position / columns);
                    position++;
                }
            }
            finally { presetChoices.ResumeLayout(); }
        }

        private void ReflowBehavior()
        {
            int functionWidth = function.Items.Cast<string>().Max(label => TextRenderer.MeasureText(label, function.Font).Width)
                + TextRenderer.MeasureText("Function", function.Font).Width + 60;
            int accessWidth = Math.Max(TextRenderer.MeasureText(suggestions.Text, suggestions.Font).Width,
                TextRenderer.MeasureText(direct.Text, direct.Font).Width) * 2 + 80;
            int columns = behaviorLayout.ClientSize.Width >= functionWidth + accessWidth ? 2 : 1;
            int functionHeight = function.PreferredHeight + function.Margin.Vertical + functionRow.Margin.Vertical;
            int allocatedAccessWidth = columns == 1 ? behaviorLayout.ClientSize.Width : behaviorLayout.ClientSize.Width * 55 / 100;
            int choiceWidth = Math.Max(1, (allocatedAccessWidth - accessGroup.Padding.Horizontal) / 2 - suggestions.Margin.Horizontal);
            int accessHeight = accessGroup.Font.Height + accessGroup.Padding.Vertical
                + Math.Max(suggestions.GetPreferredSize(new Size(choiceWidth, 0)).Height + suggestions.Margin.Vertical,
                    direct.GetPreferredSize(new Size(choiceWidth, 0)).Height + direct.Margin.Vertical) + 6;
            accessGroup.MinimumSize = new Size(0, accessHeight);
            behaviorLayout.MinimumSize = new Size(0, columns == 1 ? functionHeight + accessHeight + accessGroup.Margin.Vertical : Math.Max(functionHeight, accessHeight + accessGroup.Margin.Vertical));
            AllocateRows();
            if (columns == behaviorLayout.ColumnCount) return;
            behaviorLayout.SuspendLayout();
            try
            {
                behaviorLayout.Controls.Clear();
                behaviorLayout.ColumnStyles.Clear();
                behaviorLayout.RowStyles.Clear();
                behaviorLayout.ColumnCount = columns;
                behaviorLayout.RowCount = columns == 1 ? 2 : 1;
                behaviorLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, columns == 1 ? 100 : 45));
                if (columns == 2) behaviorLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 55));
                behaviorLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
                if (columns == 1) behaviorLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
                behaviorLayout.Controls.Add(functionRow, 0, 0);
                behaviorLayout.Controls.Add(accessGroup, columns == 2 ? 1 : 0, columns == 2 ? 0 : 1);
            }
            finally { behaviorLayout.ResumeLayout(); }
        }

        private void AllocateRows()
        {
            if (arrangingRows || Shell.RowStyles.Count < 9) return;
            arrangingRows = true;
            try
            {
                Shell.RowStyles[2].SizeType = SizeType.Absolute;
                Shell.RowStyles[2].Height = Math.Max(behaviorLayout.MinimumSize.Height, behaviorLayout.PreferredSize.Height) + behaviorLayout.Margin.Vertical;
                Shell.RowStyles[4].SizeType = SizeType.Absolute;
                Shell.RowStyles[4].Height = presetGroup.MinimumSize.Height + presetGroup.Margin.Vertical;
                Shell.RowStyles[6].SizeType = SizeType.Percent;
                Shell.RowStyles[6].Height = 100;
            }
            finally { arrangingRows = false; }
        }

        private void QueueGeometry()
        {
            if (geometryQueued || !IsHandleCreated || IsDisposed) return;
            geometryQueued = true;
            BeginInvoke((Action)delegate {
                geometryQueued = false;
                if (IsDisposed) return;
                ReflowBehavior();
                ReflowPresets();
                AllocateRows();
                Shell.PerformLayout();
            });
        }

        private static CheckBox Choice(string label)
        {
            return new CheckBox { Text = label, AccessibleName = label, AutoSize = true, Dock = DockStyle.Fill, Margin = new Padding(0, 4, 6, 4) };
        }

        private static RadioButton AccessChoice(string label)
        {
            return new RadioButton { Text = label, AccessibleName = label, AutoSize = true, Dock = DockStyle.Fill, Margin = new Padding(0, 4, 6, 4) };
        }

        private static TableLayoutPanel ChoiceRow(params RadioButton[] choices)
        {
            var row = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = choices.Length };
            RadioButton selected = choices.LastOrDefault(choice => choice.Checked);
            for (int index = 0; index < choices.Length; index++)
            {
                row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f / choices.Length));
                row.Controls.Add(choices[index], index, 0);
            }
            if (selected != null) selected.Checked = true;
            return row;
        }

        private void BehaviorChanged(object sender, EventArgs args)
        {
            bool wording = !preserve.Checked && Actions[function.SelectedIndex] == "prompt";
            function.Enabled = !preserve.Checked;
            accessGroup.Enabled = wording;
            presetGroup.Enabled = wording;
            lengthGroup.Enabled = wording;
            promptInput.Enabled = !preserve.Checked && Actions[function.SelectedIndex] != "neutral" && Actions[function.SelectedIndex] != "reject";
            if (!wording) { direct.Checked = false; suggestions.Checked = true; }
        }

        private void ChooseColor(object sender, EventArgs args)
        {
            using (ColorDialog picker = new ColorDialog { Color = NativeLayout.ColorValue(colorInput.Text), FullOpen = true })
                if (picker.ShowDialog(this) == DialogResult.OK)
                    colorInput.Text = "#" + picker.Color.R.ToString("x2") + picker.Color.G.ToString("x2") + picker.Color.B.ToString("x2");
        }

        private void SaveRule(object sender, EventArgs args)
        {
            NativeLayout.Attempt(this, delegate
            {
                string label = nameInput.Text.Trim();
                if (label.Length == 0 || Encoding.UTF8.GetByteCount(label) > 100)
                    throw new InvalidOperationException("Enter a rule name using at most 100 UTF-8 bytes.");
                if (!Regex.IsMatch(colorInput.Text, "^#[0-9a-fA-F]{6}$"))
                    throw new InvalidOperationException("Enter a color as # followed by six hexadecimal digits, or use Choose color.");
                string action = preserve.Checked ? "protect" : Actions[function.SelectedIndex];
                List<string> instructions = new List<string>();
                if (action == "prompt")
                {
                    instructions.AddRange(presets.Where(pair => pair.Key.Checked).Select(pair => pair.Value));
                    instructions.AddRange(lengths.Where(pair => pair.Key.Checked && pair.Value.Length > 0).Select(pair => pair.Value));
                }
                if (promptInput.Enabled && promptInput.Text.Trim().Length > 0) instructions.Add(promptInput.Text.Trim());
                string prompt = String.Join("\n", instructions);
                if (Encoding.UTF8.GetByteCount(prompt) > 4000)
                    throw new InvalidOperationException("Wording instructions must use at most 4,000 UTF-8 bytes, including presets.");
                dispatch("save_rule", new Dictionary<string, object>
                {
                    { "id", ruleId }, { "label", label }, { "color", colorInput.Text.ToLowerInvariant() },
                    { "action", action }, { "prompt", prompt },
                    { "accessMode", action == "prompt" && direct.Checked ? "direct" : "suggestions" },
                    { "documentId", documentId }
                });
                DialogResult = DialogResult.OK;
                Close();
            });
        }
    }
}
