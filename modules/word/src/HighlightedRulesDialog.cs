using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace UnderTree.WordAddin
{
    internal sealed class HighlightedRulesDialog : NativeDialog
    {
        internal HighlightedRulesDialog(Func<string, IDictionary<string, object>, object> dispatch, IDictionary<string, object> state)
            : base("Choose highlighted color", new Size(570, 410))
        {
            var choices = new PagedRecordList("Overlapping highlight identities", mark => UiState.Text(mark, "label") + " · " +
                UiState.Text(mark, "action") + " · " + UiState.Text(mark, "id") + " · " + UiState.Text(mark, "quote"));
            choices.UpdateRecords(UiState.Records(state, "choices"));
            Action open = delegate {
                if (choices.Selected == null) return;
                string ruleId = UiState.Text(choices.Selected, "ruleId");
                var rule = UiState.Records(state, "rules").First(candidate => UiState.Text(candidate, "id") == ruleId);
                using (var dialog = new RuleDialog(dispatch, rule, UiState.Text(state, "documentId"), UiState.Text(choices.Selected, "id"))) dialog.ShowDialog(this);
            };
            choices.RecordOpened += delegate { NativeLayout.Attempt(this, open); };
            Button choose = NativeLayout.Button("Open selected color rule", delegate { NativeLayout.Attempt(this, open); });
            Button close = NativeLayout.Button("Close", delegate { Close(); });
            AcceptButton = choose;
            CancelButton = close;
            Shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Shell.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            Shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Shell.Controls.Add(NativeLayout.Label("Choose the exact highlighted color. Opening its rule changes no permissions; only Save color rule assigns a function."), 0, 0);
            Shell.Controls.Add(choices, 0, 1);
            Shell.Controls.Add(NativeLayout.Actions(choose, close), 0, 2);
        }

        internal static bool OpenAtSelection(Func<string, IDictionary<string, object>, object> dispatch)
        {
            var state = UiState.Map(dispatch("selection_rules", new Dictionary<string, object>()));
            var marks = UiState.Records(state, "choices");
            if (marks.Count == 0) return false;
            if (marks.Count == 1)
            {
                string ruleId = UiState.Text(marks[0], "ruleId");
                var rule = UiState.Records(state, "rules").First(candidate => UiState.Text(candidate, "id") == ruleId);
                using (var dialog = new RuleDialog(dispatch, rule, UiState.Text(state, "documentId"), UiState.Text(marks[0], "id"))) dialog.ShowDialog();
            }
            else using (var dialog = new HighlightedRulesDialog(dispatch, state)) dialog.ShowDialog();
            return true;
        }
    }
}
