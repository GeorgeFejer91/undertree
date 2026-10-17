using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;

namespace UnderTree.WordAddin
{
    internal sealed partial class WordEditor
    {
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        private object Review(string tool, IDictionary<string, object> args)
        {
            if (operationActive) throw new McpOperationException("Word is finishing another review operation. Read the current context again when it completes.");
            operationActive = true;
            try { return ReviewCore(tool, args); }
            finally
            {
                operationActive = false;
                if ((tool == "suggest_text" || tool == "highlight_text") && ReviewChanged != null) ReviewChanged();
            }
        }

        private object ReviewCore(string tool, IDictionary<string, object> args)
        {
            try
            {
                if (tool == "list_manuscripts")
                {
                    OnlyKeys(args);
                    if ((int)application.Documents.Count == 0) return new { manuscripts = new object[0] };
                    WordDocumentReview listed = Current();
                    return new { manuscripts = listed.Policy.IsShared
                        ? new[] { new { manuscript_id = listed.Id, documentId = listed.Id, title = (string)listed.Document.Name } }
                        : new object[0] };
                }
                WordDocumentReview state = Current();
                if (!state.Policy.IsShared || state.Id != Text(args, tool == "highlight_text" ? "documentId" : "manuscript_id"))
                    throw new InvalidOperationException("This active document is not shared for review.");
                WordSnapshot snapshot = WordSnapshot.Capture(state.Document);
                if (tool == "read_manuscript") return ReadContext(state, snapshot, args);
                if (tool == "suggest_text")
                    return Suggest(state, snapshot, args);
                if (tool == "highlight_text") return HighlightText(state, snapshot, args);
                throw new InvalidOperationException("This tool is unavailable.");
            }
            catch (InvalidOperationException error) { throw new McpOperationException(error.Message); }
            catch (ArgumentException) { throw new McpOperationException("Invalid review arguments."); }
        }

        private object ReadContext(WordDocumentReview state, WordSnapshot snapshot, IDictionary<string, object> args)
        {
            OnlyKeys(args, "manuscript_id", "offset");
            int from = Number(args, "offset", 0);
            if (from == 0) { state.ReadRevision = snapshot.Revision; state.ReadOffset = 0; }
            if (state.ReadRevision != snapshot.Revision || from != state.ReadOffset || from < 0 || from > snapshot.FullText.Length)
                throw new InvalidOperationException("Read the complete current context sequentially from offset zero.");
            int to = Math.Min(from + 32768, snapshot.FullText.Length);
            if (to < snapshot.FullText.Length && Char.IsLowSurrogate(snapshot.FullText[to])) to--;
            state.ReadOffset = to;
            bool complete = to == snapshot.FullText.Length;
            string witness = complete ? state.Policy.ReadContext(state.Id, snapshot.Revision, snapshot.MainText, snapshot.Revision) : null;
            return new { manuscript_id = state.Id, documentId = state.Id, revision = snapshot.Revision,
                text = snapshot.FullText.Substring(from, to - from), from = from, to = to, total = snapshot.FullText.Length,
                complete = complete, next_offset = complete ? (int?)null : to, context_id = witness,
                main_body_length = snapshot.MainText.Length,
                review = snapshot.Review,
                paragraph_instruction = "Replace one complete highlighted paragraph at a time, excluding its paragraph mark. A partial highlight permits only that highlighted fragment; never expand it into unmarked text. Read review.feedback and its replies together with the color prompts before revising.",
                highlights = state.Policy.Marks.Select(m => new { id = m.Id, ruleId = m.RuleId, from = m.From, to = m.To, prompt = m.Prompt, stale = m.Stale,
                    protectedId = state.Policy.Rules.Any(r => r.Id == m.RuleId && (r.Action == "protect" || r.Action == "reject")) ? m.Id : null }).ToArray(),
                rules = state.Policy.Rules.Select(r => new { id = r.Id, label = r.Label, color = r.Color, action = r.Action, prompt = r.Prompt, accessMode = r.AccessMode }).ToArray() };
        }

        private object Suggest(WordDocumentReview state, WordSnapshot snapshot, IDictionary<string, object> args)
        {
            OnlyKeys(args, "manuscript_id", "request_id", "revision", "context_id", "from", "to", "quote", "replacement", "rationale", "replacementParts");
            var proposal = new Proposal { Id = Text(args, "request_id"), DocumentId = state.Id, Revision = Text(args, "revision"),
                From = Number(args, "from"), To = Number(args, "to"), Quote = Text(args, "quote"), Replacement = Text(args, "replacement"), Rationale = Text(args, "rationale", "") };
            if (args.ContainsKey("replacementParts")) proposal.ReplacementParts = ParseReplacementParts(args["replacementParts"]);
            if (state.Policy.Proposals.Any(p => p.Id == proposal.Id))
            {
                Authorization replay = state.Policy.Submit(proposal, Text(args, "context_id"), snapshot.MainText, snapshot.Revision);
                return SuggestResult(replay.Proposal);
            }
            if (proposal.Revision != snapshot.Revision) throw new InvalidOperationException("The manuscript changed. Read complete context again.");
            RequireParagraphUnit(state, snapshot, proposal);
            snapshot.RequireProse(state.Document, proposal.From, proposal.To, OwnedBookmarks(state), state.Policy.ProtectedUnits(proposal, snapshot.MainText));
            PolicyState beforeRequest = state.Policy.ExportState();
            Authorization authorization;
            try
            {
                authorization = state.Policy.Submit(proposal, Text(args, "context_id"), snapshot.MainText, snapshot.Revision);
                Persist(state, false);
            }
            catch
            {
                state.Policy = CreatePolicy(beforeRequest);
                state.Policy.Share(state.Id);
                throw;
            }
            if (!authorization.AlreadyRecorded)
            {
                try { Apply(state, authorization.Proposal.Id, authorization.Mode == "direct", authorization.Mode == "suggestions"); }
                catch
                {
                    if (state.Policy.Proposals.Any(p => p.Id == proposal.Id && (p.Status == "authorized" || p.Status == "pending")))
                    {
                        state.Policy = CreatePolicy(beforeRequest);
                        state.Policy.Share(state.Id);
                        Persist(state, false);
                    }
                    throw;
                }
            }
            Proposal recorded = state.Policy.Proposals.First(p => p.Id == proposal.Id);
            return SuggestResult(recorded);
        }

        private object Accept(IDictionary<string, object> args)
        {
            WordDocumentReview state = Current();
            Apply(state, Text(args, "id"), false);
            return State();
        }

        private static int CommentAnchorSuffix(WordDocumentReview state, WordSnapshot before, Proposal proposal, string replacement, bool tracked, List<PassageMark> protectedUnits)
        {
            if (!tracked || (int)before.Range(state.Document, proposal.From, proposal.To).Paragraphs.First.Range.Revisions.Count == 0) return 0;
            var feedback = new List<WordCommentContext>(before.Review.feedback);
            for (int index = 0; index < feedback.Count; index++) feedback.AddRange(feedback[index].replies);
            var affected = feedback.Where(comment => comment.storyType == 1 &&
                (comment.from == comment.to ? proposal.From <= comment.from && comment.from < proposal.To : comment.from < proposal.To && proposal.From < comment.to)).ToList();
            if (affected.Count == 0) return 0;
            // Word deletes a comment whose entire inserted anchor is replaced. Keep its original shared ending.
            int retained = 0;
            while (retained < proposal.Quote.Length && retained < replacement.Length &&
                proposal.Quote[proposal.Quote.Length - retained - 1] == replacement[replacement.Length - retained - 1]) retained++;
            foreach (PassageMark unit in protectedUnits)
                if (unit.To > proposal.To - retained) retained = Math.Min(retained, proposal.To - unit.To);
            if (retained > 0 && Char.IsLowSurrogate(proposal.Quote[proposal.Quote.Length - retained])) retained--;
            int endingFrom = proposal.To - retained;
            if (retained == 0 || affected.Any(comment => comment.from == comment.to ? comment.from < endingFrom : comment.to <= endingFrom))
                throw new InvalidOperationException("Word cannot preserve this native comment anchor for that replacement. Keep a shared ending within the commented text, or review the change locally.");
            return retained;
        }
        private void Apply(WordDocumentReview state, string id, bool direct, bool tracked = false)
        {
            WordSnapshot before = WordSnapshot.Capture(state.Document);
            Authorization authorization = direct
                ? state.Policy.ValidateDirect(id, state.Id, before.Revision, before.MainText, before.Revision)
                : state.Policy.ValidateAcceptance(id, state.Id, before.Revision, before.MainText, before.Revision);
            Proposal proposal = authorization.Proposal;
            string replacement = state.Policy.ResolveReplacement(proposal, before.MainText);
            List<PassageMark> protectedUnits = state.Policy.ProtectedUnits(proposal, before.MainText);
            List<ProtectedPlacement> placements = state.Policy.ProtectedPlacements(proposal, before.MainText);
            RequireParagraphUnit(state, before, proposal);
            before.RequireProse(state.Document, proposal.From, proposal.To, OwnedBookmarks(state), protectedUnits);
            RequireNativeReviewRange(state, before, proposal, tracked);
            if (direct && GetForegroundWindow() == new IntPtr((int)application.ActiveWindow.Hwnd))
                throw new InvalidOperationException("Finish typing and move focus from the Word document before a direct AI edit.");
            if ((int)application.UndoRecord.CustomRecordLevel != 0)
                throw new InvalidOperationException("Finish the current Word editing operation before applying a suggestion.");
            dynamic range = before.Range(state.Document, proposal.From, proposal.To);
            if (protectedUnits.Count == 0) WordSnapshot.RequireUniformFormatting(range);
            dynamic originalFont = range.Font.Duplicate;
            if (protectedUnits.Count == 0 && ((string)range.Font.Name == "" || (int)range.Font.Bold == 9999999 || (int)range.Font.Italic == 9999999 ||
                (float)range.Font.Size == 9999999 || (int)range.Font.Underline == 9999999 || (int)range.Font.Color == 9999999 ||
                (int)range.Font.Subscript == 9999999 || (int)range.Font.Superscript == 9999999 || (int)range.Font.Hidden == 9999999 ||
                (int)range.Font.SmallCaps == 9999999 || (int)range.LanguageID == 9999999))
                throw new InvalidOperationException("Select a passage with consistent character formatting so Word can preserve it.");
            if (replacement.Any(c => c < 32 && c != '\t'))
                throw new InvalidOperationException("Replacement wording cannot introduce structural paragraph or field characters.");
            int retainedSuffix = CommentAnchorSuffix(state, before, proposal, replacement, tracked, protectedUnits);
            WordTrackedProtection trackedProtection = tracked && protectedUnits.Count != 0 ? new WordTrackedProtection(state, before, proposal) : null;
            using (var preserved = new WordProtectedContent(application, state.Document, proposal, protectedUnits, placements))
            {
            if (WordSnapshot.Capture(state.Document).Revision != before.Revision)
                throw new InvalidOperationException("The native document changed before replacement.");
            PolicyState beforePolicy = state.Policy.ExportState();
            state.NativeEdit.Capture(state.Document, beforePolicy);
            string beforeNative = state.NativeEdit.NativeIdentity(state.Document);
            state.Policy.BeginApplication(id);
            Persist(state, false);
            bool ended = false;
            bool originalTracking = (bool)state.Document.TrackRevisions;
            bool originalTrackFormatting = (bool)state.Document.TrackFormatting;
            bool committed = false;
            bool settingsRestored = false;
            application.UndoRecord.StartCustomRecord("wrAIter selective edit");
            try
            {
                state.Document.TrackFormatting = false;
                state.Document.TrackRevisions = tracked;
                if (trackedProtection != null) trackedProtection.AddOriginalBookmarks(state.Document, before);
                before.Range(state.Document, proposal.From, proposal.To - retainedSuffix).Text = replacement.Substring(0, replacement.Length - retainedSuffix);
                if (protectedUnits.Count == 0 && replacement.Length > retainedSuffix)
                    foreach (int[] span in new WordTextMap(state.Document).NativeSegments(proposal.From, proposal.From + replacement.Length - retainedSuffix))
                        state.Document.Range(span[0], span[1]).Font = originalFont;
                preserved.Restore(state.Document, proposal.From, replacement.Length);
                WordSnapshot reconstructed = WordSnapshot.CaptureTextPositions(state.Document);
                int delta = replacement.Length - (proposal.To - proposal.From);
                foreach (PassageMark mark in state.Policy.Marks.ToArray())
                {
                    if (mark.Stale) continue;
                    int from = mark.From, to = mark.To;
                    if (to <= proposal.From) continue;
                    if (from >= proposal.To) { from += delta; to += delta; }
                    else
                    {
                        ProtectedPlacement placement = placements.FirstOrDefault(candidate => candidate.Id == mark.Id);
                        PassageMark owner = protectedUnits.FirstOrDefault(unit => mark.From >= unit.From && mark.To <= unit.To);
                        if (placement != null) { from = placement.From; to = placement.To; }
                        else if (owner != null)
                        {
                            ProtectedPlacement moved = placements.First(candidate => candidate.Id == owner.Id);
                            from = moved.From + mark.From - owner.From; to = moved.From + mark.To - owner.From;
                        }
                        else
                        {
                            bool enclosing = from <= proposal.From && to >= proposal.To;
                            from = Math.Min(from, proposal.From); to = to <= proposal.To ? proposal.From + replacement.Length : to + delta;
                            mark.Stale = !enclosing;
                        }
                    }
                    if (to == from)
                    {
                        state.Policy.RemoveMark(mark.Id);
                        if ((bool)state.Document.Bookmarks.Exists(mark.Id)) state.Document.Bookmarks.Item(mark.Id).Delete();
                        continue;
                    }
                    mark.NativeBookmark = null;
                    mark.From = from; mark.To = to;
                    mark.Quote = PolicyEngine.Slice(reconstructed.MainText, from, to);
                    state.Document.Bookmarks.Add(mark.Id, reconstructed.Range(state.Document, from, to));
                }
                RepaintMarks(state);
                if (tracked) RecordNativeReview(state, reconstructed, proposal, replacement.Length);
                if (trackedProtection != null) trackedProtection.PrepareWitnesses(state, proposal.Id);
                state.NativeEdit.AddGuard(state.Document);
                Persist(state, true);
                if (tracked) state.Document.ShowRevisions = true;
                state.Document.TrackFormatting = originalTrackFormatting;
                state.Document.TrackRevisions = tracked ? true : originalTracking;
                settingsRestored = true;
                if ((int)application.UndoRecord.CustomRecordLevel != 1)
                    throw new InvalidOperationException("Word ended the selective edit's Undo record before its native transaction completed.");
                // WordOpenXML export terminates native Undo recording; verify after all grouped mutations.
                application.UndoRecord.EndCustomRecord();
                ended = true;
                preserved.Verify(state.Document);
                string expected = before.MainText.Substring(0, proposal.From) + replacement + before.MainText.Substring(proposal.To);
                WordSnapshot after = WordSnapshot.Capture(state.Document);
                if (after.MainText != expected || after.ContextStories != before.ContextStories || after.Review.FeedbackIdentity() != before.Review.FeedbackIdentity())
                    throw new InvalidOperationException("Word's replacement did not preserve the surrounding manuscript.");
                if (tracked)
                {
                    Proposal verified = state.Policy.Proposals.First(candidate => candidate.Id == proposal.Id);
                    state.Policy.RecordTracked(id, verified.NativeReviewBookmark, verified.NativeReviewHash, verified.NativeReviewQuote);
                }
                else state.Policy.RecordApplied(id);
                Persist(state, true);
                state.NativeEdit.Capture(state.Document, state.Policy.ExportState());
                committed = true;
            }
            catch
            {
                if (!ended) { application.UndoRecord.EndCustomRecord(); ended = true; }
                settingsRestored = false;
                try
                {
                    // A failed COM call may already have changed bookmarks or text.
                    bool restored = state.NativeEdit.NativeIdentity(state.Document) == beforeNative;
                    if (!restored) restored = (bool)state.Document.Undo(1) && state.NativeEdit.NativeIdentity(state.Document) == beforeNative;
                    if (!restored)
                        throw new InvalidOperationException("The selective edit outcome is uncertain. Inspect Word and its Undo history before continuing.");
                }
                catch
                {
                    state.Policy.RecordOutcomeUncertain(id);
                    state.Policy.Revoke();
                    Persist(state, false);
                    throw;
                }
                state.Policy.RecordOutcomeUncertain(id);
                beforePolicy.Proposals = state.Policy.ExportState().Proposals;
                beforePolicy.HighlightReceipts = state.Policy.ExportState().HighlightReceipts;
                state.Policy = CreatePolicy(beforePolicy);
                state.Policy.Revoke(); state.ReadRevision = null;
                Persist(state, true);
                state.NativeEdit.Clear(); state.NativeEdit.Capture(state.Document, state.Policy.ExportState());
                throw;
            }
            finally
            {
                if (!settingsRestored)
                {
                    state.Document.TrackFormatting = originalTrackFormatting;
                    state.Document.TrackRevisions = committed && tracked ? true : originalTracking;
                }
                if (!ended) application.UndoRecord.EndCustomRecord();
            }
            }
        }
    }
}

