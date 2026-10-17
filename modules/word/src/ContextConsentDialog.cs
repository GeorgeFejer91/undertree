using System;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;

namespace UnderTree.WordAddin
{
    internal sealed class ContextConsentDialog : NativeDialog
    {
        internal ContextConsentDialog(Func<string, IDictionary<string, object>, object> dispatch,
            IDictionary<string, object> preview) : base("Share manuscript context", new Size(650, 570))
        {
            if (!UiState.Flag(preview, "complete") || UiState.Get(preview, "snapshot") == null)
                throw new InvalidOperationException("Word could not prepare a complete current context snapshot. Nothing was shared.");
            TextBox title = NativeLayout.TextBox("Complete context document", false, true);
            title.Text = UiState.Text(preview, "title");
            TextBox manuscript = NativeLayout.TextBox("Complete current Word document preview", true, true);
            manuscript.Text = UiState.Text(preview, "text");
            Label scope = NativeLayout.Label("Snapshot: current Word document, including unsaved text · "
                + UiState.Text(preview, "characters") + " characters");
            Label instructions = NativeLayout.Label("Share the complete active document as read-only context for this session. Suggestions and direct edits remain limited to highlights. Sharing never saves or discards drafts.\n\nAI must retrieve complete current context before proposing a change. A document, policy or sharing change requires a fresh complete read.");
            Button share = NativeLayout.Button("Share context", delegate
            {
                NativeLayout.Attempt(this, delegate
                {
                    Dictionary<string, object> arguments = UiState.Args("snapshot", UiState.Get(preview, "snapshot"));
                    if (UiState.Get(preview, "documentId") != null) arguments["documentId"] = UiState.Get(preview, "documentId");
                    dispatch("share_context", arguments);
                    DialogResult = DialogResult.OK;
                    Close();
                });
            });
            Button cancel = NativeLayout.Button("Cancel", delegate { DialogResult = DialogResult.Cancel; Close(); });
            CancelButton = cancel;
            Shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Shell.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            Shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Shell.Controls.Add(title, 0, 0);
            Shell.Controls.Add(scope, 0, 1);
            Shell.Controls.Add(manuscript, 0, 2);
            Shell.Controls.Add(instructions, 0, 3);
            Shell.Controls.Add(NativeLayout.Actions(share, cancel), 0, 4);
        }
    }
}
