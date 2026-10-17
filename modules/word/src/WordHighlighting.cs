using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;

namespace UnderTree.WordAddin
{
    internal sealed partial class WordEditor
    {
        private object HighlightText(WordDocumentReview state, WordSnapshot snapshot, IDictionary<string, object> args)
        {
            OnlyKeys(args, "documentId", "marking");
            var marking = Map(args, "marking");
            OnlyKeys(marking, "requestId", "contextId", "revision", "colorId", "ranges");
            object supplied;
            if (!marking.TryGetValue("ranges", out supplied) || !(supplied is IEnumerable) || supplied is string || supplied is IDictionary)
                throw new ArgumentException("ranges must be an array.");
            var ranges = new List<HighlightRange>();
            foreach (object entry in (IEnumerable)supplied)
            {
                var range = entry as IDictionary<string, object>;
                if (range == null) throw new ArgumentException("Invalid marking range.");
                OnlyKeys(range, "from", "to", "quote");
                ranges.Add(new HighlightRange { From = Number(range, "from"), To = Number(range, "to"), Quote = Text(range, "quote") });
            }
            var request = new HighlightRequest { DocumentId = Text(args, "documentId"), RequestId = Text(marking, "requestId"),
                Revision = Text(marking, "revision"), ContextId = Text(marking, "contextId"),
                ColorId = marking.ContainsKey("colorId") ? Text(marking, "colorId") : null, Ranges = ranges };
            bool replay = state.Policy.HighlightReceipts.Any(receipt => receipt.Request.RequestId == request.RequestId);
            if (!replay && request.Revision != snapshot.Revision) throw new InvalidOperationException("The manuscript changed; read complete context again.");
            foreach (HighlightRange range in ranges) snapshot.RequireProse(state.Document, range.From, range.To, OwnedBookmarks(state), null, true);
            if ((int)application.UndoRecord.CustomRecordLevel != 0)
                throw new InvalidOperationException("Finish the current Word operation before marking text.");
            if (!replay && GetForegroundWindow() == new IntPtr((int)application.ActiveWindow.Hwnd))
                throw new InvalidOperationException("Finish typing and move focus from the Word document before AI marking.");
            PolicyEngine original = state.Policy;
            PolicyState beforePolicy = original.ExportState();
            state.NativeEdit.Capture(state.Document, beforePolicy);
            string beforeNative = state.NativeEdit.NativeIdentity(state.Document);
            HighlightReceipt result = original.Highlight(request, snapshot.MainText, snapshot.Revision);
            if (replay) return HighlightResult(result, true);
            bool ended = false, started = false;
            try
            {
                WordReviewStore.ValidateReceipts(new SavedWordReview { DocumentId = state.Id, Policy = state.Policy.ExportState() });
                if (WordSnapshot.Capture(state.Document).Revision != snapshot.Revision)
                    throw new InvalidOperationException("The native document changed before marking.");
                original.ReserveHighlight(request.RequestId);
                Persist(state, false); // Consume the identity durably before native effects.
                application.UndoRecord.StartCustomRecord("wrAIter AI color only"); started = true;
                foreach (string id in result.MarkIds)
                {
                    PassageMark mark = state.Policy.Marks.First(candidate => candidate.Id == id);
                    state.Document.Bookmarks.Add(mark.Id, snapshot.Range(state.Document, mark.From, mark.To));
                }
                RepaintMarks(state);
                state.NativeEdit.AddGuard(state.Document);
                Persist(state, true); // Native Undo includes staged metadata; the durable receipt is still reserved.
                if ((int)application.UndoRecord.CustomRecordLevel != 1)
                    throw new InvalidOperationException("Word ended the marking Undo record before the native transaction completed.");
                application.UndoRecord.EndCustomRecord(); ended = true;
                if (WordSnapshot.Capture(state.Document).FullText != snapshot.FullText)
                    throw new InvalidOperationException("Native marking changed manuscript text.");
                original.CommitHighlightSnapshot(request.RequestId, WordSnapshot.Capture(state.Document).Revision);
                state.NativeEdit.Capture(state.Document, state.Policy.ExportState());
                Persist(state, false); // Only the private replay receipt changes after native verification.
                result = original.HighlightReceipts.First(receipt => receipt.Request.RequestId == request.RequestId);
                return HighlightResult(result, false);
            }
            catch
            {
                if (started && !ended) application.UndoRecord.EndCustomRecord(); ended = true;
                original.FailHighlight(request.RequestId);
                bool restored = false;
                try
                {
                    restored = state.NativeEdit.NativeIdentity(state.Document) == beforeNative;
                    if (!restored) restored = (bool)state.Document.Undo(1) && state.NativeEdit.NativeIdentity(state.Document) == beforeNative;
                }
                catch { restored = false; }
                if (!restored)
                {
                    Persist(state, false);
                    throw new InvalidOperationException("The marking outcome needs inspection in Word before continuing; its request identity remains consumed.");
                }
                beforePolicy.HighlightReceipts = original.ExportState().HighlightReceipts;
                state.Policy = CreatePolicy(beforePolicy);
                state.Policy.Revoke(); state.ReadRevision = null;
                Persist(state, true);
                state.NativeEdit.Clear(); state.NativeEdit.Capture(state.Document, state.Policy.ExportState());
                throw;
            }
            finally { if (started && !ended) application.UndoRecord.EndCustomRecord(); }
        }

        private static object HighlightResult(HighlightReceipt receipt, bool replay)
        { return new { requestId = receipt.Request.RequestId, colorId = receipt.ColorId, markIds = receipt.MarkIds.ToArray(), action = "neutral", replayed = replay }; }

        private static List<ReplacementPart> ParseReplacementParts(object supplied)
        {
            if (!(supplied is IEnumerable) || supplied is string || supplied is IDictionary) throw new ArgumentException("replacementParts must be an array.");
            var parts = new List<ReplacementPart>();
            foreach (object entry in (IEnumerable)supplied)
            {
                var part = entry as IDictionary<string, object>;
                if (part == null || part.Count != 1) throw new ArgumentException("Each replacement part contains only text or protectedId.");
                OnlyKeys(part, "text", "protectedId");
                parts.Add(part.ContainsKey("text") ? new ReplacementPart { Text = Text(part, "text") } : new ReplacementPart { ProtectedId = Text(part, "protectedId") });
            }
            return parts;
        }

        private static IDictionary<string, object> Map(IDictionary<string, object> values, string key)
        {
            object value;
            if (!values.TryGetValue(key, out value) || !(value is IDictionary<string, object>)) throw new ArgumentException("Invalid " + key + ".");
            return (IDictionary<string, object>)value;
        }

        private static void OnlyKeys(IDictionary<string, object> values, params string[] allowed)
        {
            if (values.Keys.Any(key => !allowed.Contains(key))) throw new ArgumentException("Unknown or policy-changing review argument.");
        }

        private static void RepaintMarks(WordDocumentReview state)
        {
            WordSnapshot snapshot = WordSnapshot.CaptureTextPositions(state.Document);
            bool originalTrackFormatting = (bool)state.Document.TrackFormatting;
            try
            {
                state.Document.TrackFormatting = false;
                foreach (PassageMark mark in state.Policy.Marks.Where(mark => !mark.Stale).OrderBy(mark => {
                    string action = state.Policy.Rules.First(rule => rule.Id == mark.RuleId).Action;
                    return action == "protect" || action == "reject" ? 2 : action == "neutral" ? 0 : 1;
                })) foreach (int[] span in snapshot.NativeSegments(mark.From, mark.To))
                    Paint(state.Document.Range(span[0], span[1]), state.Policy.Rules.First(rule => rule.Id == mark.RuleId).Color);
            }
            finally { state.Document.TrackFormatting = originalTrackFormatting; }
        }
    }
}
