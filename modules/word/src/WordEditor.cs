using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;

namespace UnderTree.WordAddin
{
    internal sealed class WordDocumentReview
    {
        public dynamic Document;
        public string Id;
        public PolicyEngine Policy;
        public string Preview;
        public string ReadRevision;
        public string MetadataDigest;
        public int ReadOffset;
        public readonly WordNativeEditState NativeEdit = new WordNativeEditState();
    }

    internal sealed partial class WordEditor : IDisposable
    {
        private readonly dynamic application;
        private readonly ConnectionService connections;
        private readonly Dictionary<long, WordDocumentReview> documents = new Dictionary<long, WordDocumentReview>();
        private string selectionProof;
        private string selectionDocument;
        private string previewDocument;
        private int selectionFrom, selectionTo;
        private bool operationActive;
        private delegate void DocumentClosing(object document, ref bool cancel);
        private readonly DocumentClosing documentClosing;
        private static readonly Guid WordApplicationEvents = new Guid("00020A01-0000-0000-C000-000000000046");
        internal event Action ReviewChanged;

        public WordEditor(object application, Func<Func<object>, object> marshal) : this(application, marshal, null, null) { }

        internal WordEditor(object application, Func<Func<object>, object> marshal, string profileDirectory, string zrokExecutable)
        {
            this.application = application;
            connections = profileDirectory == null ? new ConnectionService(Review, RevokeAll, marshal) :
                new ConnectionService(Review, RevokeAll, marshal, profileDirectory, zrokExecutable);
            documentClosing = RevokeClosingDocument;
            try { ComEventsHelper.Combine(application, WordApplicationEvents, 6, documentClosing); }
            catch { connections.Dispose(); throw; }
        }

        private void RevokeClosingDocument(object document, ref bool cancel)
        {
            long id = WordSnapshot.Identity(document);
            WordDocumentReview state;
            if (!documents.TryGetValue(id, out state)) return;
            state.Policy.Revoke(); documents.Remove(id); selectionProof = null;
        }

        private WordDocumentReview Current()
        {
            if ((int)application.Documents.Count == 0) throw new InvalidOperationException("Open a Word document first.");
            dynamic document = application.ActiveDocument;
            long identity = WordSnapshot.Identity(document);
            var open = new HashSet<long> { identity };
            foreach (object entry in (System.Collections.IEnumerable)application.Documents) open.Add(WordSnapshot.Identity(entry));
            foreach (long closed in documents.Keys.Where(key => !open.Contains(key)).ToArray())
            { documents[closed].Policy.Revoke(); documents.Remove(closed); }
            WordDocumentReview state;
            if (!documents.TryGetValue(identity, out state))
            {
                if (documents.Count >= 32) throw new InvalidOperationException("Restart Word to begin another review session.");
                SavedWordReview saved = WordReviewStore.Load(document);
                if (saved != null && documents.Values.Any(value => value.Id == saved.DocumentId))
                    throw new InvalidOperationException("A copy of this reviewed document is already open. Close that copy before starting another review.");
                state = new WordDocumentReview { Document = document,
                    Id = saved == null ? Guid.NewGuid().ToString("N") : saved.DocumentId,
                    Policy = CreatePolicy(saved == null ? null : saved.Policy), MetadataDigest = WordReviewStore.Fingerprint(document) };
                documents.Add(identity, state);
            }
            string currentMetadata;
            try { currentMetadata = WordReviewStore.Fingerprint(document); }
            catch { state.Policy.Revoke(); throw; }
            if (state.MetadataDigest != currentMetadata)
            {
                state.Policy.Revoke();
                SavedWordReview changed = WordReviewStore.Load(document);
                if (changed == null || changed.DocumentId != state.Id)
                    throw new InvalidOperationException("The document's native review identity changed; close and reopen it before reviewing.");
                // Native metadata Undo cannot restore old rules or erase terminal request ledgers.
                state.Preview = null; state.ReadRevision = null;
                state.MetadataDigest = currentMetadata;
                Persist(state, true);
            }
            if (documents.Values.Any(value => !Object.ReferenceEquals(value, state) && value.Id == state.Id))
            {
                state.Policy.Revoke();
                throw new InvalidOperationException("Another open copy has this review identity. Close that copy before reviewing this document.");
            }
            ReconcileNativeEdit(state);
            ReconcileProtectedNativeReview(state);
            RefreshMarks(state);
            return state;
        }

        private static PolicyEngine CreatePolicy(PolicyState state)
        {
            using (var stream = typeof(WordEditor).Assembly.GetManifestResourceStream("SelectiveEditorContract"))
            using (var reader = new System.IO.StreamReader(stream)) return new PolicyEngine(reader.ReadToEnd(), state);
        }

        private void RefreshMarks(WordDocumentReview state)
        {
            WordSnapshot snapshot = WordSnapshot.Capture(state.Document);
            foreach (PassageMark mark in state.Policy.Marks)
            {
                if (!(bool)state.Document.Bookmarks.Exists(MarkBookmark(mark))) { mark.Stale = true; continue; }
                dynamic range = state.Document.Bookmarks.Item(MarkBookmark(mark)).Range;
                if ((int)range.StoryType != 1) { mark.Stale = true; continue; }
                try
                {
                    int from = snapshot.VisibleOffset((int)range.Start), to = snapshot.VisibleOffset((int)range.End);
                    if (PolicyEngine.Slice(snapshot.MainText, from, to) != mark.Quote) { mark.Stale = true; continue; }
                    mark.From = from; mark.To = to;
                }
                catch (InvalidOperationException) { mark.Stale = true; }
            }
        }

        private static string MarkBookmark(PassageMark mark) { return mark.NativeBookmark ?? mark.Id; }

        private static ISet<string> OwnedBookmarks(WordDocumentReview state)
        { return new HashSet<string>(state.Policy.Marks.Select(mark => mark.Id).Concat(state.Policy.Marks.Select(MarkBookmark))
            .Concat(state.Policy.Proposals.Where(proposal => proposal.NativeOriginalMarks != null).SelectMany(proposal => proposal.NativeOriginalMarks).Select(witness => witness.Bookmark))
            .Concat(state.Policy.Proposals.Where(proposal => proposal.NativeReviewBookmark != null).Select(proposal => proposal.NativeReviewBookmark))); }

        public object Dispatch(string operation, IDictionary<string, object> args)
        {
            if (operationActive) throw new InvalidOperationException("Word is finishing another review operation. Try again when it completes.");
            operationActive = true;
            try { return DispatchCore(operation, args); }
            finally { operationActive = false; }
        }

        private object DispatchCore(string operation, IDictionary<string, object> args)
        {
            args = args ?? new Dictionary<string, object>();
            if (args.ContainsKey("documentId") && Text(args, "documentId") != Current().Id)
                throw new InvalidOperationException("The active document changed. Refresh the selective editor before continuing.");
            switch (operation)
            {
                case "state": return State();
                case "connection_status": return ConnectionStatus();
                case "connection_configure": connections.Configure(Text(args, "enrollmentToken", "")); return ConnectionStatus();
                case "connection_start": connections.Start(); return ConnectionStatus();
                case "connection_local": connections.StartLocal(); return ConnectionStatus();
                case "connection_stop": connections.Stop(); return ConnectionStatus();
                case "context_preview": return ContextPreview();
                case "share_context": return ShareContext(args);
                case "revoke_context": Current().Policy.Revoke(); return State();
                case "selection_preview": return SelectionPreview();
                case "save_rule": return SaveRule(args);
                case "mark_selection": return MarkSelection(args);
                case "remove_mark": return RemoveMark(args);
                case "select_mark": return SelectMark(args);
                case "selection_rules": return SelectionRules();
                case "select_proposal": return SelectProposal(args);
                case "accept": return Accept(args);
                case "reject": return Reject(args);
                default: throw new ArgumentException("Unknown local Word operation.");
            }
        }

        private object State()
        {
            if ((int)application.Documents.Count == 0)
                return new { document = new { id = "", title = "", shared = false }, rules = new object[0], marks = new object[0], proposals = new object[0], connection = ConnectionStatus() };
            WordDocumentReview state = Current();
            WordSnapshot snapshot = WordSnapshot.Capture(state.Document);
            return new { document = new { id = state.Id, title = snapshot.Title, shared = state.Policy.IsShared, revision = snapshot.Revision,
                    notice = state.Policy.Proposals.Any(p => p.Status == "outcome_uncertain") ? "An earlier edit needs inspection in Word. Its request cannot be replayed." : "" },
                rules = state.Policy.Rules.Select(r => new { id = r.Id, label = r.Label, color = r.Color, action = r.Action, prompt = r.Prompt, accessMode = r.AccessMode }).ToArray(),
                marks = state.Policy.Marks.Select(m => new { id = m.Id, ruleId = m.RuleId, from = m.From, to = m.To, quote = m.Quote, prompt = m.Prompt, stale = m.Stale }).ToArray(),
                proposals = state.Policy.Proposals.Where(p => p.Status == "pending").Select(p => new { id = p.Id, quote = p.Quote, replacement = DisplayReplacement(state.Policy, p, snapshot.MainText), rationale = p.Rationale, status = p.Status }).ToArray(),
                connection = ConnectionStatus() };
        }

        private static string DisplayReplacement(PolicyEngine policy, Proposal proposal, string text)
        {
            try { return policy.ResolveReplacement(proposal, text); }
            catch (InvalidOperationException) { return "[Stale protected mapping: read the current document before reviewing this suggestion.]"; }
        }

        private object ConnectionStatus()
        {
            ConnectionStatus status = connections.Status;
            return new { running = status.LocalRunning, status = status.Phase, publicMcpUrl = status.PublicAddress ?? "",
                localMcpUrl = connections.LocalAddress ?? "", lastError = status.Error ?? "", configured = status.Configured,
                tunnelRunning = status.TunnelRunning, enrollmentRequired = status.EnrollmentRequired, busy = status.Busy, cleanupPending = status.CleanupPending };
        }

        private object ContextPreview()
        {
            WordDocumentReview state = Current();
            WordSnapshot snapshot = WordSnapshot.Capture(state.Document);
            state.Preview = snapshot.Revision;
            previewDocument = state.Id;
            return new { documentId = state.Id, text = snapshot.FullText, title = snapshot.Title, characters = snapshot.FullText.Length, complete = true, snapshot = snapshot.Revision };
        }

        private object ShareContext(IDictionary<string, object> args)
        {
            WordDocumentReview state = Current();
            WordSnapshot snapshot = WordSnapshot.Capture(state.Document);
            if (previewDocument != state.Id || state.Preview == null || state.Preview != Text(args, "snapshot") || snapshot.Revision != state.Preview)
                throw new InvalidOperationException("The document changed. Preview its complete context again before sharing.");
            if (!connections.Status.LocalRunning) throw new InvalidOperationException("Start access before sharing the document.");
            state.Policy.Share(state.Id);
            state.ReadRevision = null;
            state.ReadOffset = 0;
            return State();
        }

        private void RevokeAll()
        {
            foreach (WordDocumentReview state in documents.Values) { state.Policy.Revoke(); state.ReadRevision = null; }
        }

        private void Persist(WordDocumentReview state, bool inDocument)
        {
            var saved = new SavedWordReview { DocumentId = state.Id, Policy = state.Policy.ExportState() };
            if (inDocument)
            {
                WordReviewStore.PersistInDocument(state.Document, saved);
                state.MetadataDigest = WordReviewStore.Fingerprint(state.Document);
            }
            else WordReviewStore.PersistReceipts(saved);
        }

        private PolicyEngine PrepareLocalPolicy(WordDocumentReview state, Action<PolicyEngine> change)
        {
            PolicyEngine candidate = CreatePolicy(state.Policy.ExportState());
            change(candidate);
            WordReviewStore.ValidateReceipts(new SavedWordReview { DocumentId = state.Id, Policy = candidate.ExportState() });
            state.NativeEdit.Clear();
            if (state.Policy.IsShared) candidate.Share(state.Id);
            return candidate;
        }

        private static string Text(IDictionary<string, object> values, string key, string fallback = null)
        {
            object value;
            if (!values.TryGetValue(key, out value))
            { if (fallback != null) return fallback; throw new ArgumentException("Missing " + key + "."); }
            if (!(value is string)) throw new ArgumentException("Invalid " + key + ".");
            return (string)value;
        }
        private static int Number(IDictionary<string, object> values, string key, int? fallback = null)
        {
            object value;
            if (!values.TryGetValue(key, out value))
            { if (fallback.HasValue) return fallback.Value; throw new ArgumentException("Missing " + key + "."); }
            if (!(value is int)) throw new ArgumentException("Invalid " + key + ".");
            return (int)value;
        }
        public void Dispose()
        {
            try { ComEventsHelper.Remove(application, WordApplicationEvents, 6, documentClosing); }
            finally { connections.Dispose(); RevokeAll(); documents.Clear(); }
        }
    }
}



