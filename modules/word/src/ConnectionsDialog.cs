using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;

namespace UnderTree.WordAddin
{
    internal sealed class ConnectionsDialog : NativeDialog
    {
        private readonly Func<string, IDictionary<string, object>, object> dispatch;
        private readonly TextBox address;
        private readonly TextBox enrollmentToken;
        private readonly TextBox documentTitle;
        private readonly Label status;
        private readonly Label sharingStatus;
        private readonly Label setupStatus;
        private readonly Button start;
        private readonly Button stop;
        private readonly Button copy;
        private readonly Button revoke;
        private readonly Button configureConnection;
        private readonly Timer refreshTimer;
        private string statusDetails = "";
        private string documentId = "";
        private bool refreshing;
        private bool previouslyRunning;

        internal ConnectionsDialog(Func<string, IDictionary<string, object>, object> dispatch)
            : this(dispatch, address => Process.Start(new ProcessStartInfo(address) { UseShellExecute = true })) { }

        internal ConnectionsDialog(Func<string, IDictionary<string, object>, object> dispatch, Action<string> openDocumentation)
            : base("Connections", new Size(640, 560))
        {
            this.dispatch = dispatch;
            TabControl tabs = new TabControl { Dock = DockStyle.Fill, AccessibleName = "Connection settings" };
            TabPage overview = NewTab(tabs, "Overview");
            TabPage setup = NewTab(tabs, "Setup");
            TabPage sharing = NewTab(tabs, "Document access");
            address = NativeLayout.TextBox("Public MCP address", false, true);
            copy = NativeLayout.Button("Copy MCP address", delegate
            {
                NativeLayout.Attempt(this, delegate { if (address.Text.Length > 0) Clipboard.SetText(address.Text); });
            });
            start = NativeLayout.Button("Start access", delegate { RunOperation("connection_start", null); });
            stop = NativeLayout.Button("Stop / revoke", delegate { RunOperation("connection_stop", null); });
            status = NativeLayout.Label("Reading connection status…");
            Button details = NativeLayout.Button("View status details", delegate
            {
                using (TextDetailDialog dialog = new TextDetailDialog("Connection status", statusDetails)) dialog.ShowDialog(this);
            });
            TableLayoutPanel overviewBody = NativeLayout.Column();
            overviewBody.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            overviewBody.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
            overviewBody.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
            overviewBody.Controls.Add(NativeLayout.Stack(NativeLayout.Label("Public MCP address"), address,
                NativeLayout.Actions(copy)), 0, 0);
            overviewBody.Controls.Add(NativeLayout.Stack(status, NativeLayout.Actions(details)), 0, 1);
            overviewBody.Controls.Add(NativeLayout.Stack(NativeLayout.Label("Add this address to your AI client's MCP connector. Internet is required for a public tunnel. Starting the connection shares no document."),
                NativeLayout.Actions(start, stop)), 0, 2);
            overview.Controls.Add(overviewBody);

            enrollmentToken = NativeLayout.TextBox("zrok enrollment token", false, false);
            enrollmentToken.UseSystemPasswordChar = true;
            enrollmentToken.MaxLength = 4096;
            CheckBox showToken = new CheckBox { Text = "Show token", AutoSize = true, AccessibleName = "Show enrollment token" };
            showToken.CheckedChanged += delegate { enrollmentToken.UseSystemPasswordChar = !showToken.Checked; };
            configureConnection = NativeLayout.Button("Configure connection", delegate
            {
                if (RunOperation("connection_configure", UiState.Args("enrollmentToken", enrollmentToken.Text.Trim())))
                    enrollmentToken.Clear();
            });
            setupStatus = NativeLayout.Label("Paste your zrok account token to configure this Word connection.");
            TableLayoutPanel setupBody = NativeLayout.Column();
            setupBody.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            setupBody.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            setupBody.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            setupBody.Controls.Add(NativeLayout.Stack(
                NativeLayout.Label("The connection engine is included. Set up your zrok account once."),
                SetupLink("1. Sign in or create an account at myzrok.io", "https://myzrok.io", openDocumentation),
                NativeLayout.Label("2. Open the zrok icon / API console, then Getting started. Copy your account token."),
                SetupLink("View token instructions", "https://netfoundry.io/docs/zrok/get-started/get-token/", openDocumentation),
                NativeLayout.Label("3. Paste the token below and choose Configure connection."),
                NativeLayout.Label("4. In Overview, choose Start access. Copy the MCP address into your AI client's connector.")), 0, 0);
            setupBody.Controls.Add(NativeLayout.Stack(NativeLayout.Label("Account token for zrok enrollment"), enrollmentToken, showToken), 0, 1);
            setupBody.Controls.Add(NativeLayout.Stack(NativeLayout.Label("Keep the token private; it is never part of the MCP address. Configuring the connection shares no document."),
                setupStatus, NativeLayout.Actions(configureConnection)), 0, 2);
            setup.Controls.Add(setupBody);

            documentTitle = NativeLayout.TextBox("Active Word document", false, true);
            sharingStatus = NativeLayout.Label("No document context shared.");
            Button share = NativeLayout.Button("Preview / share context…", PreviewContext);
            revoke = NativeLayout.Button("Revoke", delegate { RunOperation("revoke_context", null); });
            TableLayoutPanel sharingBody = NativeLayout.Column();
            sharingBody.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            sharingBody.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
            sharingBody.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
            sharingBody.Controls.Add(NativeLayout.Stack(NativeLayout.Label("Active Word document"), documentTitle, sharingStatus), 0, 0);
            sharingBody.Controls.Add(NativeLayout.Label("This tab controls what the AI may read. Preview the complete document, including unsaved text, then explicitly share it for context. Starting a connection grants no document access."), 0, 1);
            sharingBody.Controls.Add(NativeLayout.Stack(
                NativeLayout.Label("Edit rights are separate: your color rules govern highlighted passages. Unmarked text stays read-only, and MCP edits never save the document."),
                NativeLayout.Label("Share again after reopening Word. Revoke removes access to this document; Stop / revoke in Overview stops access to every document and closes the tunnel."),
                NativeLayout.Actions(share, revoke)), 0, 2);
            sharing.Controls.Add(sharingBody);

            Button refresh = NativeLayout.Button("Refresh", delegate { NativeLayout.Attempt(this, RefreshAll); });
            Button close = NativeLayout.Button("Close", delegate { Close(); });
            CancelButton = close;
            Shell.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            Shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Shell.Controls.Add(tabs, 0, 0);
            Shell.Controls.Add(NativeLayout.Actions(refresh, close), 0, 1);
            refreshTimer = new Timer { Interval = 1500 };
            refreshTimer.Tick += delegate { RefreshConnectionStatus(); };
            Shown += delegate { NativeLayout.Attempt(this, RefreshAll); refreshTimer.Start(); };
            Activated += delegate { if (IsHandleCreated) NativeLayout.Attempt(this, RefreshAll); };
        }

        private LinkLabel SetupLink(string text, string address, Action<string> openDocumentation)
        {
            LinkLabel link = new LinkLabel {
                Text = text, AccessibleName = text, AutoSize = true, Dock = DockStyle.Fill,
                Margin = new Padding(0, 3, 0, 6), UseMnemonic = false, TabStop = true,
                LinkBehavior = LinkBehavior.AlwaysUnderline
            };
            link.Links.Add(0, text.Length, address);
            link.ForeColorChanged += delegate {
                link.LinkColor = link.ForeColor; link.ActiveLinkColor = link.ForeColor; link.VisitedLinkColor = link.ForeColor;
            };
            link.LinkClicked += delegate { NativeLayout.Attempt(this, delegate { openDocumentation(address); }); };
            return link;
        }

        private static TabPage NewTab(TabControl tabs, string label)
        {
            TabPage page = new TabPage(label) { Padding = new Padding(12), BackColor = SystemColors.Control };
            tabs.TabPages.Add(page);
            return page;
        }

        private bool RunOperation(string operation, IDictionary<string, object> arguments)
        {
            bool succeeded = false;
            NativeLayout.Attempt(this, delegate
            {
                arguments = arguments ?? new Dictionary<string, object>();
                if (operation == "revoke_context") arguments["documentId"] = documentId;
                dispatch(operation, arguments);
                succeeded = true;
                RefreshAll();
            });
            return succeeded;
        }

        private void PreviewContext(object sender, EventArgs args)
        {
            NativeLayout.Attempt(this, delegate
            {
                IDictionary<string, object> preview = UiState.Map(dispatch("context_preview", new Dictionary<string, object>()));
                using (ContextConsentDialog consent = new ContextConsentDialog(dispatch, preview)) consent.ShowDialog(this);
                RefreshAll();
            });
        }

        private void RefreshAll()
        {
            if (refreshing || IsDisposed) return;
            refreshing = true;
            try { ReadDocumentState(); }
            finally { refreshing = false; }
        }

        private void ReadDocumentState()
        {
            IDictionary<string, object> state = UiState.Map(dispatch("state", new Dictionary<string, object>()));
            IDictionary<string, object> document = UiState.Map(UiState.Get(state, "document"));
            documentId = UiState.Text(document, "id");
            documentTitle.Text = UiState.Text(document, "title");
            bool shared = UiState.Flag(document, "shared");
            sharingStatus.Text = shared ? "Complete context is shared for this session." : "No document context shared.";
            revoke.Enabled = shared;
            RenderConnection(UiState.Map(UiState.Get(state, "connection")));
        }

        private void RefreshConnectionStatus()
        {
            if (refreshing || IsDisposed || !Visible) return;
            refreshing = true;
            try
            {
                IDictionary<string, object> connection = UiState.Map(dispatch("connection_status", new Dictionary<string, object>()));
                bool stopped = previouslyRunning && !UiState.Flag(connection, "running");
                RenderConnection(connection);
                if (stopped) ReadDocumentState();
            }
            catch (Exception error)
            {
                statusDetails = error.GetBaseException().Message;
                status.Text = "Connection status unavailable. View status details or refresh.";
            }
            finally { refreshing = false; }
        }

        private void RenderConnection(IDictionary<string, object> connection)
        {
            string publicAddress = UiState.Text(connection, "publicMcpUrl");
            if (address.Text != publicAddress) address.Text = publicAddress;
            bool running = UiState.Flag(connection, "running");
            string phase = UiState.Text(connection, "status");
            bool busy = UiState.Flag(connection, "busy") || phase == "configuring" || phase == "starting" || phase == "stopping";
            bool cleanup = UiState.Flag(connection, "cleanupPending") || phase == "cleanup_required" || phase == "revocation_required";
            bool tunnelRunning = UiState.Get(connection, "tunnelRunning") == null ? running : UiState.Flag(connection, "tunnelRunning");
            statusDetails = phase;
            string error = UiState.Text(connection, "lastError");
            if (error.Length > 0) statusDetails += "\r\n\r\n" + error;
            if (statusDetails.Trim().Length == 0) statusDetails = running ? "Connection process is running." : "Access is stopped.";
            status.Text = error.Length > 0 ? "Connection needs attention. View status details." : StatusLabel(phase, running);
            setupStatus.Text = busy ? "Connection setup or access is in progress. See Overview for status."
                : UiState.Flag(connection, "configured") ? "The Word connection is configured." : "Paste your zrok account token, then choose Configure connection.";
            start.Enabled = !tunnelRunning && !busy && !cleanup;
            stop.Enabled = running || busy || cleanup || publicAddress.Length > 0 || error.Length > 0;
            configureConnection.Enabled = !busy && !cleanup && !tunnelRunning;
            copy.Enabled = publicAddress.Length > 0;
            previouslyRunning = running;
        }

        private static string StatusLabel(string phase, bool running)
        {
            switch (phase)
            {
                case "configured": return "Connection is configured. Start access when you are ready.";
                case "configuring": return "Configuring this Word connection…";
                case "starting": return "Starting access…";
                case "running": return "Public tunnel process is running. Copy the MCP address to your AI client.";
                case "stopping": return "Stopping access and revoking document sharing…";
                case "cleanup_required": return "Connection cleanup needs attention. Use Stop / revoke to retry.";
                case "revocation_required": return "Document access still needs revocation. Use Stop / revoke again.";
                case "failed": return "Connection needs attention. View status details.";
                case "stopped": return "Access is stopped.";
                default: return running ? "Connection process is running." : "Access is stopped.";
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && refreshTimer != null) refreshTimer.Dispose();
            base.Dispose(disposing);
        }
    }
}
