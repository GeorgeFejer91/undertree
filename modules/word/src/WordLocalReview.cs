using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;

namespace UnderTree.WordAddin
{
    internal sealed partial class WordEditor
    {
        private object SelectionPreview()
        {
            WordDocumentReview state = Current();
            WordSnapshot snapshot = WordSnapshot.Capture(state.Document);
            dynamic selection = application.Selection.Range;
            if ((int)selection.StoryType != 1) throw new InvalidOperationException("Select prose in the main document body.");
            int from = snapshot.VisibleOffset((int)selection.Start), to = snapshot.VisibleOffset((int)selection.End);
            snapshot.RequireProse(state.Document, from, to, OwnedBookmarks(state), null, true);
            selectionProof = snapshot.Revision;
            selectionDocument = state.Id;
            selectionFrom = from;
            selectionTo = to;
            return new { quote = snapshot.MainText.Substring(from, to - from), from = from, to = to, snapshot = snapshot.Revision };
        }

        private object SaveRule(IDictionary<string, object> args)
        {
            WordDocumentReview state = Current();
            var rule = new ColorRule { Id = Text(args, "id", Guid.NewGuid().ToString("N")), Label = Text(args, "label"),
                Color = Text(args, "color"), Action = Text(args, "action"), Prompt = Text(args, "prompt", ""), AccessMode = Text(args, "accessMode", "suggestions") };
            if (String.IsNullOrEmpty(rule.Id)) rule.Id = Guid.NewGuid().ToString("N");
            state.Policy.ValidateRule(rule);
            RequireWritable(state);
            PolicyEngine candidate = PrepareLocalPolicy(state, policy => policy.AddOrUpdateRule(rule));
            state.Policy = candidate;
            RepaintMarks(state);
            Persist(state, true);
            state.NativeEdit.Clear(); state.NativeEdit.Capture(state.Document, state.Policy.ExportState());
            return State();
        }

        private object MarkSelection(IDictionary<string, object> args)
        {
            WordDocumentReview state = Current();
            WordSnapshot snapshot = WordSnapshot.Capture(state.Document);
            if ((int)application.Selection.Range.StoryType != 1) throw new InvalidOperationException("Select prose in the main document body.");
            int from = Number(args, "from"), to = Number(args, "to");
            if (state.Id != selectionDocument || snapshot.Revision != selectionProof || Text(args, "snapshot") != selectionProof ||
                from != selectionFrom || to != selectionTo || snapshot.VisibleOffset((int)application.Selection.Start) != from || snapshot.VisibleOffset((int)application.Selection.End) != to)
                throw new InvalidOperationException("The document or selection changed. Select and preview the passage again.");
            snapshot.RequireProse(state.Document, from, to, OwnedBookmarks(state), null, true);
            string quote = snapshot.MainText.Substring(from, to - from);
            if (Text(args, "quote") != quote) throw new InvalidOperationException("The selected wording changed.");
            string ruleId = Text(args, "ruleId");
            ColorRule rule = state.Policy.Rules.FirstOrDefault(r => r.Id == ruleId);
            if (rule == null) throw new InvalidOperationException("Choose a current color rule.");
            var mark = new PassageMark { Id = "Wrai_" + Guid.NewGuid().ToString("N"), RuleId = ruleId, From = from, To = to, Quote = quote, Prompt = Text(args, "prompt", "") };
            PolicyEngine candidate = PrepareLocalPolicy(state, policy => policy.AddMark(mark, snapshot.MainText));
            state.Document.Bookmarks.Add(mark.Id, snapshot.Range(state.Document, from, to));
            state.Policy = candidate;
            RepaintMarks(state);
            Persist(state, true);
            state.NativeEdit.Clear(); state.NativeEdit.Capture(state.Document, state.Policy.ExportState());
            selectionProof = null;
            return State();
        }

        private object RemoveMark(IDictionary<string, object> args)
        {
            WordDocumentReview state = Current();
            RequireWritable(state);
            string id = Text(args, "id");
            PassageMark mark = state.Policy.Marks.FirstOrDefault(m => m.Id == id);
            if (mark == null) throw new InvalidOperationException("The marker no longer exists.");
            if ((bool)state.Document.Bookmarks.Exists(MarkBookmark(mark))) state.Document.Bookmarks.Item(MarkBookmark(mark)).Delete();
            state.Policy.RemoveMark(id);
            Persist(state, true);
            state.NativeEdit.Clear(); state.NativeEdit.Capture(state.Document, state.Policy.ExportState());
            return State();
        }

        private object SelectMark(IDictionary<string, object> args)
        {
            WordDocumentReview state = Current();
            PassageMark mark = state.Policy.Marks.FirstOrDefault(m => m.Id == Text(args, "id"));
            if (mark == null || mark.Stale) throw new InvalidOperationException("This marker is stale. Mark the passage again locally.");
            WordSnapshot.Capture(state.Document).Range(state.Document, mark.From, mark.To).Select();
            return State();
        }

        private object SelectionRules()
        {
            WordDocumentReview state = Current();
            dynamic range = application.Selection.Range;
            if ((int)range.StoryType != 1) throw new InvalidOperationException("Select a highlighted passage in the main document body.");
            WordSnapshot snapshot = WordSnapshot.Capture(state.Document);
            int from = snapshot.VisibleOffset((int)range.Start), to = snapshot.VisibleOffset((int)range.End);
            return new { documentId = state.Id, choices = state.Policy.Marks.Where(mark => !mark.Stale &&
                (to == from ? mark.From <= from && from < mark.To : mark.From < to && from < mark.To)).Select(mark => new {
                    id = mark.Id, ruleId = mark.RuleId, quote = mark.Quote,
                    label = state.Policy.Rules.First(rule => rule.Id == mark.RuleId).Label,
                    action = state.Policy.Rules.First(rule => rule.Id == mark.RuleId).Action }).ToArray(),
                rules = state.Policy.Rules.Select(rule => new { id = rule.Id, label = rule.Label, color = rule.Color,
                    action = rule.Action, prompt = rule.Prompt, accessMode = rule.AccessMode }).ToArray() };
        }

        private object SelectProposal(IDictionary<string, object> args)
        {
            WordDocumentReview state = Current();
            Proposal proposal = state.Policy.Proposals.FirstOrDefault(p => p.Id == Text(args, "id"));
            WordSnapshot snapshot = WordSnapshot.Capture(state.Document);
            if (proposal == null || proposal.Revision != snapshot.Revision) throw new InvalidOperationException("This proposal's document snapshot is stale.");
            snapshot.Range(state.Document, proposal.From, proposal.To).Select();
            return State();
        }

        private object Reject(IDictionary<string, object> args)
        {
            WordDocumentReview state = Current();
            state.Policy.Reject(Text(args, "id"));
            Persist(state, false);
            return State();
        }

        private static void RequireWritable(WordDocumentReview state)
        {
            if ((bool)state.Document.ReadOnly || (int)state.Document.ProtectionType != -1)
                throw new InvalidOperationException("This document is read-only or protected.");
        }

        private static void Paint(dynamic range, string color)
        {
            Color value = ColorTranslator.FromHtml(color);
            range.Shading.BackgroundPatternColor = value.R | (value.G << 8) | (value.B << 16);
        }
    }
}

