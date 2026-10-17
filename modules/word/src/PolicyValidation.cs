using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace UnderTree.WordAddin
{
    public sealed partial class PolicyEngine
    {
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
        private static readonly Regex Identifier = new Regex(@"\A[A-Za-z0-9_-]{1,80}\z", RegexOptions.CultureInvariant);
        private static readonly Regex Color = new Regex(@"\A#[0-9a-fA-F]{6}\z", RegexOptions.CultureInvariant);
        private static readonly Regex Digest = new Regex(@"\A[0-9a-f]{64}\z", RegexOptions.CultureInvariant);

        public void ValidateState(string text)
        {
            ValidateText(text, MaxText, "document text");
            ValidateState();
        }

        public void ValidateState()
        {
            if (Rules == null || Marks == null || Proposals == null || Rules.Count > contract.slots.ruleLimit ||
                Marks.Count > contract.limits.marks || Proposals.Count > MaxReceipts || HighlightReceipts == null || HighlightReceipts.Count > MaxReceipts)
                throw Refusal("Word review metadata is missing or exceeds its limits; preserve the original content.");
            foreach (ColorRule rule in Rules) ValidateRule(rule);
            foreach (PassageMark mark in Marks) ValidateMark(mark);
            foreach (Proposal proposal in Proposals) ValidateProposal(proposal, true);
            foreach (HighlightReceipt receipt in HighlightReceipts) ValidateHighlightReceipt(receipt);
            if (Marks.Any(mark => mark.NativeBookmark != null && !Proposals.Any(proposal => proposal.NativeOriginalMarks != null &&
                proposal.NativeOriginalMarks.Any(witness => witness.Id == mark.Id && witness.Bookmark == mark.NativeBookmark && witness.BeforeQuote == mark.Quote))))
                throw Refusal("A preserved native anchor has no matching original-unit witness.");
            if (Rules.Select(rule => rule.Id).Distinct(StringComparer.Ordinal).Count() != Rules.Count ||
                Marks.Select(mark => mark.Id).Distinct(StringComparer.Ordinal).Count() != Marks.Count ||
                Proposals.Select(proposal => proposal.Id).Distinct(StringComparer.Ordinal).Count() != Proposals.Count ||
                HighlightReceipts.Select(receipt => receipt.Request.RequestId).Distinct(StringComparer.Ordinal).Count() != HighlightReceipts.Count ||
                Proposals.Count(proposal => proposal.Status == "pending") > contract.limits.pendingSuggestions)
                throw Refusal("Word review metadata contains repeated identifiers or too many pending suggestions.");
        }

        public void ValidateRule(ColorRule rule)
        {
            if (rule == null || rule.Id == null || !Identifier.IsMatch(rule.Id)) throw Refusal("Invalid color-rule identifier.");
            ValidateText(rule.Label, 100, "rule name");
            ValidateText(rule.Prompt, contract.limits.promptBytes, "wording instructions");
            if (String.IsNullOrWhiteSpace(rule.Label) || Utf8.GetByteCount(rule.Label) > contract.limits.ruleNameBytes ||
                Utf8.GetByteCount(rule.Prompt) > contract.limits.promptBytes)
                throw Refusal("Enter a rule name and prompt within their UTF-8 text limits.");
            if (rule.Color == null || !Color.IsMatch(rule.Color)) throw Refusal("Use a color such as #B7E4C7.");
            if (!new[] { "neutral", "prompt", "protect", "reject", "discard" }.Contains(rule.Action) ||
                !new[] { "suggestions", "direct" }.Contains(rule.AccessMode) ||
                (rule.Action != "prompt" && rule.AccessMode != "suggestions"))
                throw Refusal("Only a wording-prompt color may authorize direct edits.");
            if (rule.Action == "neutral" && rule.Prompt.Length != 0)
                throw Refusal("A color-only identity has no prompt or AI function.");
        }

        private void ValidateMark(PassageMark mark)
        {
            if (mark == null || mark.Id == null || !Identifier.IsMatch(mark.Id) ||
                !Rules.Any(rule => rule.Id == mark.RuleId) || mark.From < 0 || mark.To <= mark.From || mark.To > MaxText)
                throw Refusal("Invalid passage-highlight identity or range.");
            if (mark.NativeBookmark != null && (mark.NativeBookmark.Length > 40 || !Identifier.IsMatch(mark.NativeBookmark) ||
                !mark.NativeBookmark.StartsWith("WraiO_", StringComparison.Ordinal)))
                throw Refusal("Invalid native preserved-mark anchor.");
            ValidateText(mark.Quote, MaxReplacement, "highlighted quote");
            ValidateText(mark.Prompt, contract.limits.promptBytes, "passage prompt");
            if (mark.Quote.Length == 0 || Utf8.GetByteCount(mark.Prompt) > contract.limits.promptBytes)
                throw Refusal("Highlighted text must be nonempty and its passage prompt must remain within its limit.");
            if (Rules.Any(rule => rule.Id == mark.RuleId && rule.Action == "neutral") && mark.Prompt.Length != 0)
                throw Refusal("Neutral marks have no passage prompt.");
        }

        private static void ValidateProposal(Proposal proposal, bool persisted)
        {
            if (proposal == null || proposal.Id == null || !Identifier.IsMatch(proposal.Id)) throw Refusal("Use a stable requestId of at most 80 letters, digits, underscores or hyphens.");
            ValidateIdentity(proposal.DocumentId, "document identifier");
            ValidateIdentity(proposal.Revision, "revision");
            if (proposal.From < 0 || proposal.To <= proposal.From || proposal.To > MaxText) throw Refusal("Invalid nonempty UTF-16 proposal range.");
            ValidateText(proposal.Quote, MaxReplacement, "quoted text");
            ValidateText(proposal.Replacement, MaxReplacement, "replacement");
            if (proposal.ReplacementParts != null)
            {
                if (proposal.Replacement.Length != 0 || proposal.ReplacementParts.Count == 0 || proposal.ReplacementParts.Count > 128)
                    throw Refusal("Use an empty replacement and a bounded explicit preservation mapping.");
                foreach (ReplacementPart part in proposal.ReplacementParts)
                {
                    if (part == null || ((part.Text == null) == (part.ProtectedId == null)))
                        throw Refusal("Each replacement part is either prose or one native protected identity.");
                    if (part.Text != null) ValidateText(part.Text, MaxReplacement, "replacement prose");
                    else if (!Identifier.IsMatch(part.ProtectedId)) throw Refusal("Invalid protected identity.");
                }
            }
            ValidateText(proposal.Rationale ?? "", 4000, "rationale");
            if (proposal.Quote.Length == 0 || proposal.To - proposal.From != proposal.Quote.Length || Utf8.GetByteCount(proposal.Rationale ?? "") > 4000)
                throw Refusal("Proposal quote length or rationale exceeds its text limit.");
            if (persisted && (!new[] { "pending", "authorized", "applying", "applied", "tracked", "rejected", "outcome_uncertain" }.Contains(proposal.Status) ||
                proposal.SourceHash == null || !Digest.IsMatch(proposal.SourceHash) ||
                proposal.PolicyHash == null || !Digest.IsMatch(proposal.PolicyHash) ||
                proposal.SnapshotHash == null || !Digest.IsMatch(proposal.SnapshotHash)))
                throw Refusal("Invalid persisted suggestion state or snapshot binding.");
            if (persisted && proposal.Status == "tracked" && (proposal.NativeReviewBookmark == null || !Identifier.IsMatch(proposal.NativeReviewBookmark) ||
                proposal.NativeReviewHash == null || !Digest.IsMatch(proposal.NativeReviewHash) || proposal.NativeReviewQuote == null))
                throw Refusal("The tracked suggestion is missing its native paragraph identity.");
            if (proposal.NativeOriginalMarks != null)
            {
                if (proposal.NativeOriginalMarks.Count == 0 || proposal.NativeOriginalMarks.Count > 500 || proposal.NativeOriginalMarks.Any(witness => witness == null) ||
                    proposal.NativeOriginalMarks.Select(witness => witness.Id).Distinct().Count() != proposal.NativeOriginalMarks.Count ||
                    proposal.NativeOriginalMarks.Select(witness => witness.Bookmark).Distinct().Count() != proposal.NativeOriginalMarks.Count)
                    throw Refusal("Invalid bounded native preservation witnesses.");
                ValidateText(proposal.NativeOriginalParagraphQuote, MaxText, "original tracked paragraph");
                foreach (NativeMarkWitness witness in proposal.NativeOriginalMarks)
                {
                    if (witness == null || witness.Id == null || !Identifier.IsMatch(witness.Id) || witness.Bookmark == null ||
                        witness.Bookmark.Length > 40 || !Identifier.IsMatch(witness.Bookmark) || !witness.Bookmark.StartsWith("WraiO_", StringComparison.Ordinal) ||
                        witness.BeforeSignature != null && !Digest.IsMatch(witness.BeforeSignature) ||
                        witness.AfterSignature != null && !Digest.IsMatch(witness.AfterSignature) || (witness.BeforeSignature == null) != (witness.AfterSignature == null))
                        throw Refusal("Invalid native preservation identity or signature.");
                    ValidateText(witness.BeforeQuote, MaxReplacement, "original native marked quote");
                    ValidateText(witness.AfterQuote, MaxReplacement, "revised native marked quote");
                }
            }
            if (proposal.NativeReviewQuote != null) ValidateText(proposal.NativeReviewQuote, MaxText, "tracked paragraph");
            if (proposal.NativeReviewBookmark != null && (proposal.NativeReviewBookmark.Length > 40 || !Identifier.IsMatch(proposal.NativeReviewBookmark) ||
                !proposal.NativeReviewBookmark.StartsWith("WraiReview_", StringComparison.Ordinal)))
                throw Refusal("Invalid native review bookmark identity.");
            if (proposal.NativeReviewHash != null && !Digest.IsMatch(proposal.NativeReviewHash))
                throw Refusal("Invalid native review revision binding.");
        }

        public static string Slice(string text, int from, int to)
        {
            if (text == null || from < 0 || from > to || to > text.Length) throw Refusal("Invalid UTF-16 prose range.");
            if (!Boundary(text, from) || !Boundary(text, to)) throw Refusal("Range boundaries must not split a Unicode character.");
            return text.Substring(from, to - from);
        }

        public static string Hash(string text)
        {
            if (text == null) throw Refusal("Missing native snapshot text.");
            byte[] encoded;
            try { encoded = Utf8.GetBytes(text); }
            catch (EncoderFallbackException) { throw Refusal("Text contains an incomplete Unicode character."); }
            using (SHA256 hash = SHA256.Create())
                return BitConverter.ToString(hash.ComputeHash(encoded)).Replace("-", "").ToLowerInvariant();
        }

        private static bool IsCurrent(PassageMark mark, string text)
        {
            return !mark.Stale && mark.From >= 0 && mark.To > mark.From && mark.To <= text.Length &&
                Boundary(text, mark.From) && Boundary(text, mark.To) && text.Substring(mark.From, mark.To - mark.From) == mark.Quote;
        }

        private static bool Boundary(string text, int offset)
        {
            return offset == 0 || offset == text.Length || !(Char.IsHighSurrogate(text[offset - 1]) && Char.IsLowSurrogate(text[offset]));
        }

        private static void ValidateIdentity(string value, string name)
        {
            ValidateText(value, 256, name);
            if (String.IsNullOrWhiteSpace(value)) throw Refusal("Missing " + name + ".");
        }

        private static void ValidateText(string text, int maximum, string name)
        {
            if (text == null || text.Length > maximum || text.IndexOf('\0') >= 0) throw Refusal("Invalid " + name + " or text limit exceeded.");
            try { Utf8.GetByteCount(text); }
            catch (EncoderFallbackException) { throw Refusal("The " + name + " contains an incomplete Unicode character."); }
        }

        private static InvalidOperationException Refusal(string message) { return new InvalidOperationException(message); }

        private sealed class ContractDefinition
        {
            public int version { get; set; }
            public ContractSlots slots { get; set; }
            public ContractLimits limits { get; set; }
            public List<ColorRule> defaultRules { get; set; }
        }

        private sealed class ContractSlots
        {
            public int visible { get; set; }
            public int ruleLimit { get; set; }
        }

        private sealed class ContractLimits
        {
            public int ruleNameBytes { get; set; }
            public int promptBytes { get; set; }
            public int marks { get; set; }
            public int pendingSuggestions { get; set; }
        }
    }
}
