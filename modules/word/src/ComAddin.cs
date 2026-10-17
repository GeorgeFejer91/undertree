using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("wrAIter for Microsoft Word")]
[assembly: AssemblyVersion("0.1.0.0")]
[assembly: AssemblyFileVersion("0.1.0.0")]
[assembly: ComVisible(false)]

namespace UnderTree.WordAddin
{
    [ComImport, ComVisible(true), Guid("B65AD801-ABAF-11D0-BB8B-00A0C90F2744"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
    public interface IOfficeLifecycle
    {
        [DispId(1)] void OnConnection([MarshalAs(UnmanagedType.IDispatch)] object application, int mode,
            [MarshalAs(UnmanagedType.IDispatch)] object addin, [In, MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_VARIANT)] ref Array custom);
        [DispId(2)] void OnDisconnection(int mode, [In, MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_VARIANT)] ref Array custom);
        [DispId(3)] void OnAddInsUpdate([In, MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_VARIANT)] ref Array custom);
        [DispId(4)] void OnStartupComplete([In, MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_VARIANT)] ref Array custom);
        [DispId(5)] void OnBeginShutdown([In, MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_VARIANT)] ref Array custom);
    }

    [ComImport, ComVisible(true), Guid("000C0396-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
    public interface IOfficeRibbon
    {
        [DispId(1)] [return: MarshalAs(UnmanagedType.BStr)] string GetCustomUI([MarshalAs(UnmanagedType.BStr)] string ribbonId);
    }

    [ComVisible(true), Guid("4F8A9DB3-56E6-473F-B1A5-D1D4661D2E74"), InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
    public interface IWordEditorAutomation
    {
        [DispId(1)] string Execute(string operation, string arguments);
        [DispId(2)] void ShowEditor();
        [DispId(3)] void RibbonOpen([MarshalAs(UnmanagedType.IDispatch)] object control);
        [DispId(4)] void RibbonConnections([MarshalAs(UnmanagedType.IDispatch)] object control);
        [DispId(5)] void RibbonLoaded([MarshalAs(UnmanagedType.IDispatch)] object ribbon);
        [DispId(6)] [return: MarshalAs(UnmanagedType.IDispatch)] object RibbonColorImage([MarshalAs(UnmanagedType.IDispatch)] object control);
        [DispId(7)] string RibbonColorLabel([MarshalAs(UnmanagedType.IDispatch)] object control);
        [DispId(8)] bool RibbonColorEnabled([MarshalAs(UnmanagedType.IDispatch)] object control);
        [DispId(9)] void RibbonColor([MarshalAs(UnmanagedType.IDispatch)] object control);
        [DispId(10)] void RibbonNextColors([MarshalAs(UnmanagedType.IDispatch)] object control);
        [DispId(11)] void RibbonColorRules([MarshalAs(UnmanagedType.IDispatch)] object control);
        [DispId(12)] void RibbonSelectionRules([MarshalAs(UnmanagedType.IDispatch)] object control);
    }

    [ComVisible(true), Guid("12E46C89-0A1D-4E2E-AECB-2C51D78F1907"), ProgId("UnderTree.WordAddin"),
     ClassInterface(ClassInterfaceType.None), ComDefaultInterface(typeof(IWordEditorAutomation))]
    public sealed class ComAddin : IOfficeLifecycle, IOfficeRibbon, IWordEditorAutomation
    {
        private Control dispatcher;
        private WordEditor editor;
        private ConnectionsDialog connections;
        private WordRibbon ribbon;
        private object wordApplication;
        private Action documentChanged;
        private delegate void BeforeDoubleClick(object selection, ref bool cancel);
        private BeforeDoubleClick documentDoubleClick;
        private bool paletteRefreshPending;
        private bool paletteRefreshQueued;
        private int authorityDepth;
        private static readonly Guid WordEvents = new Guid("00020A01-0000-0000-C000-000000000046");
        private int ownerThread;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 8388608 };

        public void OnConnection(object application, int mode, object addin, ref Array custom)
        {
            ownerThread = Thread.CurrentThread.ManagedThreadId;
            dispatcher = new Control();
            IntPtr handle = dispatcher.Handle;
            editor = new WordEditor(application, MarshalToWord);
            ribbon = new WordRibbon(LocalDispatch);
            wordApplication = application;
            documentChanged = QueuePaletteRefresh;
            ComEventsHelper.Combine(wordApplication, WordEvents, 3, documentChanged);
            documentDoubleClick = OpenHighlightedRules;
            ComEventsHelper.Combine(wordApplication, WordEvents, 14, documentDoubleClick);
            QueuePaletteRefresh();
            editor.ReviewChanged += delegate {
                if (ribbon != null) ribbon.Invalidate();
            };
            ((dynamic)addin).Object = this;
        }

        private object MarshalToWord(Func<object> operation)
        {
            if (dispatcher == null || dispatcher.IsDisposed) throw new InvalidOperationException("Word is closing.");
            if (Thread.CurrentThread.ManagedThreadId == ownerThread) return InvokeWord(operation);
            var completion = new System.Threading.Tasks.TaskCompletionSource<object>();
            var pending = 0;
            dispatcher.BeginInvoke((Action)(() => {
                if (Interlocked.CompareExchange(ref pending, 1, 0) != 0) return;
                try { completion.SetResult(InvokeWord(operation)); }
                catch (Exception error) { completion.SetException(error); }
            }));
            bool completed;
            try { completed = completion.Task.Wait(TimeSpan.FromSeconds(15)); }
            catch (AggregateException) { return completion.Task.GetAwaiter().GetResult(); }
            if (!completed)
            {
                Interlocked.CompareExchange(ref pending, 2, 0);
                throw new InvalidOperationException("Word is busy. Inspect the current proposal before retrying.");
            }
            return completion.Task.GetAwaiter().GetResult();
        }

        public string Execute(string operation, string arguments)
        {
            try
            {
                if (arguments == null || arguments.Length > 131072) throw new ArgumentException("Invalid local request.");
                var values = json.Deserialize<Dictionary<string, object>>(arguments);
                return json.Serialize(new { ok = true, result = MarshalToWord(() => LocalDispatch(operation, values)) });
            }
            catch (Exception error)
            {
                while (error is TargetInvocationException || error is AggregateException) error = error.InnerException;
                return json.Serialize(new { ok = false, error = error.Message });
            }
        }

        public void ShowEditor()
        {
            MarshalToWord(delegate { ShowConnectionsCore(); return null; });
        }

        private void ShowConnectionsCore()
        {
            if (editor == null) throw new InvalidOperationException("Open Word normally to use wrAIter.");
            if (ribbon != null) ribbon.CancelPendingHighlight();
            if (connections == null || connections.IsDisposed) connections = new ConnectionsDialog(LocalDispatch);
            if (!connections.Visible) connections.Show();
            connections.Activate();
        }

        public void RibbonOpen(object control) { ShowEditor(); }
        public void RibbonConnections(object control)
        {
            MarshalToWord(delegate { ShowConnectionsCore(); return null; });
        }
        private object LocalDispatch(string operation, IDictionary<string, object> arguments)
        {
            return InvokeWord(delegate {
                object result = json.DeserializeObject(json.Serialize(editor.Dispatch(operation, arguments)));
                if (ribbon != null) ribbon.Observe(result);
                return result;
            });
        }
        private object InvokeWord(Func<object> operation)
        {
            authorityDepth++;
            try { return operation(); }
            finally { authorityDepth--; if (authorityDepth == 0 && paletteRefreshPending) QueuePaletteRefresh(); }
        }
        private void QueuePaletteRefresh()
        {
            paletteRefreshPending = true;
            if (paletteRefreshQueued || dispatcher == null || dispatcher.IsDisposed) return;
            paletteRefreshQueued = true;
            dispatcher.BeginInvoke((Action)delegate {
                paletteRefreshQueued = false;
                if (authorityDepth != 0 || editor == null) return;
                paletteRefreshPending = false;
                try { LocalDispatch("state", new Dictionary<string, object>()); }
                catch (Exception) { if (ribbon != null) ribbon.Observe(new Dictionary<string, object> { { "rules", new object[0] } }); }
            });
        }
        public void RibbonLoaded(object ui) { if (ribbon != null) { ribbon.Load(ui); QueuePaletteRefresh(); } }
        public object RibbonColorImage(object control) { return ribbon == null ? null : ribbon.Image(control); }
        public string RibbonColorLabel(object control) { return ribbon == null ? "Open a Word document" : ribbon.Label(control); }
        public bool RibbonColorEnabled(object control) { return ribbon != null && ribbon.Enabled(control); }
        public void RibbonColor(object control) { if (ribbon != null) ribbon.Highlight(control); }
        public void RibbonNextColors(object control) { if (ribbon != null) ribbon.Configure(); }
        public void RibbonColorRules(object control) { if (ribbon != null) ribbon.Configure(); }
        public void RibbonSelectionRules(object control)
        {
            try { MarshalToWord(delegate {
                if (ribbon != null) ribbon.CancelPendingHighlight();
                if (!HighlightedRulesDialog.OpenAtSelection(LocalDispatch))
                    MessageBox.Show("Place the cursor in highlighted text to open its color rule.", "wrAIter for Word", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return null;
            }); }
            catch (Exception error) { MessageBox.Show(error.Message, "wrAIter for Word", MessageBoxButtons.OK, MessageBoxIcon.Information); }
        }
        private void OpenHighlightedRules(object selection, ref bool cancel)
        {
            if (editor == null || authorityDepth != 0) return;
            try {
                if (ribbon != null) ribbon.CancelPendingHighlight();
                if (HighlightedRulesDialog.OpenAtSelection(LocalDispatch)) cancel = true;
            }
            catch (Exception error) { MessageBox.Show(error.Message, "wrAIter for Word", MessageBoxButtons.OK, MessageBoxIcon.Information); }
        }
        public string GetCustomUI(string ribbonId)
        {
            return "<customUI xmlns=\"http://schemas.microsoft.com/office/2009/07/customui\" onLoad=\"RibbonLoaded\"><ribbon><tabs>" +
                "<tab idMso=\"TabHome\">" + WordRibbon.GroupXml("Home") + "</tab>" +
                "<tab id=\"wrAIterTab\" label=\"wrAIter\">" + WordRibbon.GroupXml("Tab") + "</tab></tabs></ribbon></customUI>";
        }

        private void Shutdown()
        {
            if (wordApplication != null && documentChanged != null)
            {
                try { ComEventsHelper.Remove(wordApplication, WordEvents, 3, documentChanged); }
                catch (COMException) { }
            }
            if (wordApplication != null && documentDoubleClick != null)
            {
                try { ComEventsHelper.Remove(wordApplication, WordEvents, 14, documentDoubleClick); }
                catch (COMException) { }
            }
            wordApplication = null;
            documentChanged = null;
            documentDoubleClick = null;
            if (ribbon != null) ribbon.Dispose();
            if (connections != null && !connections.IsDisposed) connections.Close();
            if (editor != null) { editor.Dispose(); editor = null; }
            ribbon = null;
            if (dispatcher != null) { dispatcher.Dispose(); dispatcher = null; }
        }
        public void OnDisconnection(int mode, ref Array custom) { Shutdown(); }
        public void OnBeginShutdown(ref Array custom) { Shutdown(); }
        public void OnAddInsUpdate(ref Array custom) { }
        public void OnStartupComplete(ref Array custom) { }
    }
}
