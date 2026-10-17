using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;

namespace UnderTree.WordAddin
{
    internal sealed class WordNativeEditState
    {
        private sealed class Snapshot { internal string Key, Marks; }
        private readonly List<Snapshot> snapshots = new List<Snapshot>();
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 4194304 };
        private string observedKey;
        private string observedGuards;
        private int retainedCharacters;

        internal void Capture(dynamic document, PolicyState policy)
        {
            string guards;
            string key = NativeKey(document, out guards);
            string encoded = json.Serialize(policy.Marks);
            Snapshot previous = snapshots.LastOrDefault(snapshot => snapshot.Key == key);
            if (previous != null) { retainedCharacters -= previous.Marks.Length; snapshots.Remove(previous); }
            snapshots.Add(new Snapshot { Key = key, Marks = encoded });
            retainedCharacters += encoded.Length;
            while (snapshots.Count > 32 || retainedCharacters > 8388608)
            {
                retainedCharacters -= snapshots[0].Marks.Length;
                snapshots.RemoveAt(0);
            }
            observedKey = key;
            observedGuards = guards;
        }

        internal string NativeIdentity(dynamic document) { string guards; return NativeKey(document, out guards); }

        internal void AddGuard(dynamic document)
        {
            document.Bookmarks.Add("WraiU_" + Guid.NewGuid().ToString("N"), document.Range(0, 0));
        }

        internal List<PassageMark> Reconcile(dynamic document, out bool changed)
        {
            string guards;
            string key = NativeKey(document, out guards);
            bool guardChanged = observedGuards != null && guards != observedGuards;
            changed = observedKey != null && key != observedKey;
            observedKey = key;
            observedGuards = guards;
            if (!changed || !guardChanged) return null;
            Snapshot known = snapshots.LastOrDefault(snapshot => snapshot.Key == key);
            return known == null ? null : json.Deserialize<List<PassageMark>>(known.Marks);
        }

        internal void Clear() { snapshots.Clear(); retainedCharacters = 0; observedKey = null; observedGuards = null; }

        private string NativeKey(dynamic document, out string guardIdentity)
        {
            var bookmarks = new List<object>();
            var guards = new List<string>();
            foreach (object entry in (IEnumerable)document.Bookmarks)
            {
                dynamic bookmark = entry;
                bookmarks.Add(new { name = (string)bookmark.Name, from = (int)bookmark.Range.Start, to = (int)bookmark.Range.End });
                string name = (string)bookmark.Name;
                Guid parsed;
                if (name.StartsWith("WraiU_", StringComparison.Ordinal) && Guid.TryParseExact(name.Substring(6), "N", out parsed)) guards.Add(name);
                if (bookmarks.Count > 10000) throw new InvalidOperationException("Too many native bookmarks to verify Undo history.");
            }
            guardIdentity = PolicyEngine.Hash(String.Join("|", guards.OrderBy(name => name, StringComparer.Ordinal)));
            return PolicyEngine.Hash(WordSnapshot.Capture(document).Revision + "\0" + json.Serialize(bookmarks));
        }
    }

    internal sealed class WordCommentContext
    {
        public int id, from, to, storyType, paragraphFrom, paragraphTo;
        public string author, text, date;
        public bool resolved;
        public List<WordCommentContext> replies;
    }

    internal sealed class WordRevisionContext
    {
        public int from, to, type;
        public string author, text;
    }

    internal sealed class WordReviewContext
    {
        public string changeUnit = "paragraph";
        public string acceptance = "Word Review: Accept or Reject";
        public string feedbackInstruction = "For each highlighted paragraph, combine its color and passage prompts with the latest unresolved user comments and replies whose paragraphFrom/paragraphTo identify that paragraph, including collapsed anchors at its end, and any overlapping feedback. Address that feedback in the next paragraph revision. Comments never override Preserve text or grant access to unmarked text.";
        public List<WordCommentContext> feedback = new List<WordCommentContext>();
        public List<WordRevisionContext> revisions = new List<WordRevisionContext>();

        internal static WordReviewContext Capture(dynamic document, WordSnapshot snapshot)
        {
            var context = new WordReviewContext();
            int count = 0;
            var commentsSeen = new HashSet<string>(StringComparer.Ordinal);
            dynamic comments = document.Comments;
            int commentCount = (int)comments.Count;
            if (commentCount > 10000) throw new InvalidOperationException("Too many native comments to share complete context.");
            for (int index = 1; index <= commentCount; index++)
            {
                dynamic comment = comments.Item(index);
                if ((object)comment.Ancestor == null) context.feedback.Add(Comment((object)comment, snapshot, ref count, 0, commentsSeen));
            }
            for (int index = 1; index <= commentCount; index++)
                if (!commentsSeen.Contains(NativeCommentIdentity((object)comments.Item(index))))
                    throw new InvalidOperationException("Word did not expose a complete native comment thread.");
            foreach (object entry in (IEnumerable)document.Revisions)
            {
                if (++count > 10000) throw new InvalidOperationException("Too many native review annotations to share complete context.");
                dynamic revision = entry;
                dynamic range = revision.Range;
                if ((int)range.StoryType != 1) continue;
                context.revisions.Add(new WordRevisionContext { from = snapshot.VisibleOffset((int)range.Start), to = snapshot.VisibleOffset((int)range.End),
                    type = (int)revision.Type, author = (string)revision.Author, text = (string)range.Text });
            }
            return context;
        }

        private static WordCommentContext Comment(object entry, WordSnapshot snapshot, ref int count, int depth, ISet<string> seen)
        {
            dynamic comment = entry;
            if (++count > 10000 || depth > 8) throw new InvalidOperationException("Native comment threads exceed the complete-context limit.");
            if (!seen.Add(NativeCommentIdentity(entry))) throw new InvalidOperationException("Word returned an ambiguous native comment thread.");
            dynamic scope = comment.Scope;
            int story = (int)scope.StoryType;
            var result = new WordCommentContext { id = (int)comment.Index, storyType = story, author = (string)comment.Author,
                text = (string)comment.Range.Text, date = ((DateTime)comment.Date).ToUniversalTime().ToString("o", CultureInfo.InvariantCulture), resolved = (bool)comment.Done,
                from = -1, to = -1, paragraphFrom = -1, paragraphTo = -1, replies = new List<WordCommentContext>() };
            if (story == 1)
            {
                result.from = snapshot.VisibleOffset((int)scope.Start); result.to = snapshot.VisibleOffset((int)scope.End);
                int from, to; Paragraph(snapshot.MainText, result.from, out from, out to);
                result.paragraphFrom = from; result.paragraphTo = to;
            }
            dynamic replies = comment.Replies;
            int replyCount = (int)replies.Count;
            if (replyCount > 10000 - count) throw new InvalidOperationException("Native comment threads exceed the complete-context limit.");
            for (int index = 1; index <= replyCount; index++)
            {
                dynamic reply = replies.Item(index);
                object ancestor = (object)reply.Ancestor;
                if (ancestor == null || NativeCommentIdentity(ancestor) != NativeCommentIdentity(entry))
                    throw new InvalidOperationException("Word returned a reply without its exact parent comment.");
                result.replies.Add(Comment((object)reply, snapshot, ref count, depth + 1, seen));
            }
            return result;
        }

        private static string NativeCommentIdentity(object entry)
        {
            dynamic comment = entry;
            dynamic text = comment.Range;
            dynamic scope = comment.Scope;
            // Word returns different COM identities for the same native comment.
            return String.Join(":", (int)comment.Index, (int)text.StoryType, (int)text.Start, (int)text.End,
                (int)scope.StoryType, (int)scope.Start, (int)scope.End);
        }

        internal static void Paragraph(string text, int offset, out int from, out int to)
        {
            if (offset < 0 || offset > text.Length) throw new InvalidOperationException("Invalid paragraph boundary.");
            from = offset == 0 ? 0 : text.LastIndexOf('\r', offset - 1) + 1;
            to = text.IndexOf('\r', offset);
            if (to < 0) to = text.Length;
        }

        internal string Serialize()
        { return new JavaScriptSerializer { MaxJsonLength = 16777216 }.Serialize(this); }

        internal string FeedbackIdentity()
        {
            return PolicyEngine.Hash(new JavaScriptSerializer { MaxJsonLength = 16777216 }.Serialize(feedback.Select(CommentContent).ToArray()));
        }

        private static object CommentContent(WordCommentContext comment)
        { return new { comment.id, comment.storyType, comment.author, comment.text, comment.date, comment.resolved, replies = comment.replies.Select(CommentContent).ToArray() }; }
    }

    internal sealed partial class WordEditor
    {
        private void ReconcileNativeEdit(WordDocumentReview state)
        {
            bool nativeChanged;
            List<PassageMark> recalled = state.NativeEdit.Reconcile(state.Document, out nativeChanged);
            if (nativeChanged)
            {
                state.Policy.InvalidateContext(); state.ReadRevision = null;
                if (recalled != null && NativeMarksMatch(state, WordSnapshot.Capture(state.Document), recalled, state.Policy.Marks))
                {
                    state.Policy.Revoke();
                    PolicyState restored = state.Policy.ExportState();
                    restored.Marks = recalled.Select(mark => {
                        PassageMark live = state.Policy.Marks.FirstOrDefault(candidate => candidate.Id == mark.Id);
                        if (live != null) { mark.RuleId = live.RuleId; mark.Prompt = live.Prompt; }
                        return mark;
                    }).ToList();
                    state.Policy = CreatePolicy(restored);
                    Persist(state, true);
                    state.NativeEdit.Capture(state.Document, state.Policy.ExportState());
                }
            }
        }

        private static bool NativeMarksMatch(WordDocumentReview state, WordSnapshot snapshot, List<PassageMark> expected, List<PassageMark> other)
        {
            var expectedIds = new HashSet<string>(expected.Select(mark => mark.Id));
            foreach (PassageMark mark in other.Where(mark => !expectedIds.Contains(mark.Id)))
                if ((bool)state.Document.Bookmarks.Exists(MarkBookmark(mark))) return false;
            foreach (PassageMark mark in expected.Where(mark => !mark.Stale))
            {
                if (!(bool)state.Document.Bookmarks.Exists(MarkBookmark(mark))) return false;
                dynamic range = state.Document.Bookmarks.Item(MarkBookmark(mark)).Range;
                dynamic target = snapshot.Range(state.Document, mark.From, mark.To);
                if ((int)range.StoryType != 1 || (int)range.Start != (int)target.Start || (int)range.End != (int)target.End ||
                    PolicyEngine.Slice(snapshot.MainText, mark.From, mark.To) != mark.Quote) return false;
            }
            return true;
        }
        private static void RequireParagraphUnit(WordDocumentReview state, WordSnapshot snapshot, Proposal proposal)
        {
            int from, to; WordReviewContext.Paragraph(snapshot.MainText, proposal.From, out from, out to);
            if (proposal.To > to) throw new InvalidOperationException("Submit one paragraph at a time, excluding its paragraph mark.");
            int covered = from;
            foreach (PassageMark mark in state.Policy.Marks.Where(mark => !mark.Stale && mark.Quote == PolicyEngine.Slice(snapshot.MainText, mark.From, mark.To) &&
                state.Policy.Rules.Any(rule => rule.Id == mark.RuleId && (rule.Action == "prompt" || rule.Action == "discard"))).OrderBy(mark => mark.From))
            {
                if (mark.To <= covered) continue;
                if (mark.From > covered) break;
                covered = mark.To;
            }
            if (covered >= to && to - from <= PolicyEngine.MaxReplacement && (proposal.From != from || proposal.To != to))
                throw new InvalidOperationException("This entire paragraph is highlighted. Submit its complete revised text as one paragraph change, excluding the paragraph mark.");
        }

        private static void RequireNativeReviewRange(WordDocumentReview state, WordSnapshot snapshot, Proposal proposal, bool tracked)
        {
            dynamic paragraph = snapshot.Range(state.Document, proposal.From, proposal.To).Paragraphs.First.Range;
            if ((int)paragraph.Revisions.Count == 0) return;
            if (!tracked) throw new InvalidOperationException("Resolve this paragraph's tracked changes in Word before applying a direct edit.");
            string hash = NativeRevisionHash(paragraph);
            foreach (Proposal previous in state.Policy.Proposals.Where(candidate => candidate.Status == "tracked"))
            {
                if (!(bool)state.Document.Bookmarks.Exists(previous.NativeReviewBookmark)) continue;
                dynamic anchor = state.Document.Bookmarks.Item(previous.NativeReviewBookmark).Range;
                if ((int)anchor.Start != (int)paragraph.Start || ((int)anchor.End != (int)paragraph.End && (int)anchor.End != (int)paragraph.End - 1) || previous.NativeReviewHash != hash) continue;
                int from = snapshot.VisibleOffset((int)paragraph.Start), to = snapshot.VisibleOffset((int)paragraph.End);
                if (PolicyEngine.Slice(snapshot.MainText, from, to) == previous.NativeReviewQuote) return;
            }
            throw new InvalidOperationException("This paragraph contains changed or unrelated revisions. Review them in Word before submitting another AI revision.");
        }

        private static string NativeRevisionHash(dynamic paragraph)
        {
            var signature = new StringBuilder();
            int from = (int)paragraph.Start;
            int count = 0;
            foreach (object entry in (IEnumerable)paragraph.Revisions)
            {
                if (++count > 1000) throw new InvalidOperationException("Too many native changes in one paragraph.");
                dynamic revision = entry;
                int type = (int)revision.Type;
                if (type != 1 && type != 2) throw new InvalidOperationException("This paragraph contains unsupported native revision structures.");
                signature.Append(type).Append('\0').Append((string)revision.Author).Append('\0')
                    .Append(((DateTime)revision.Date).ToUniversalTime().ToString("o", CultureInfo.InvariantCulture)).Append('\0')
                    .Append((int)revision.Range.Start - from).Append(':').Append((int)revision.Range.End - from).Append('\0')
                    .Append((string)revision.Range.Text).Append('\0');
            }
            if (count == 0) throw new InvalidOperationException("Word did not retain a tracked paragraph replacement for local review.");
            return PolicyEngine.Hash(signature.ToString());
        }

        private static void RecordNativeReview(WordDocumentReview state, WordSnapshot after, Proposal proposal, int replacementLength)
        {
            dynamic paragraph = after.Range(state.Document, proposal.From, proposal.From + replacementLength).Paragraphs.First.Range;
            string bookmark = "WraiReview_" + Guid.NewGuid().ToString("N").Substring(0, 29);
            string hash = NativeRevisionHash(paragraph);
            int from = after.VisibleOffset((int)paragraph.Start), to = after.VisibleOffset((int)paragraph.End);
            int anchorFrom = (int)paragraph.Start, anchorTo = (int)paragraph.End - 1;
            state.Document.Bookmarks.Add(bookmark, state.Document.Range(anchorFrom, anchorTo));
            if (!(bool)state.Document.Bookmarks.Exists(bookmark) ||
                (int)state.Document.Bookmarks.Item(bookmark).Range.Start != anchorFrom ||
                (int)state.Document.Bookmarks.Item(bookmark).Range.End != anchorTo)
                throw new InvalidOperationException("Word did not retain the exact native paragraph review identity.");
            Proposal provisional = state.Policy.Proposals.First(candidate => candidate.Id == proposal.Id);
            if (provisional.Status != "applying") throw new InvalidOperationException("The native review receipt must remain provisional until verification.");
            provisional.NativeReviewBookmark = bookmark;
            provisional.NativeReviewHash = hash;
            provisional.NativeReviewQuote = PolicyEngine.Slice(after.MainText, from, to);
        }

        private static object SuggestResult(Proposal proposal)
        {
            bool tracked = proposal.Status == "tracked";
            return new { id = proposal.Id, status = proposal.Status, applied = proposal.Status == "applied",
                requiresApproval = tracked || proposal.Status == "pending", reviewMode = tracked ? "word-track-changes" : "direct" };
        }
    }
}
