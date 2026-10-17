using System;
using System.Collections.Generic;
using System.Linq;

namespace UnderTree.WordAddin
{
    public sealed partial class PolicyEngine
    {
        private readonly string highlightingSession = Guid.NewGuid().ToString("N");
        public const int MaxHighlightRanges = 64;

        public HighlightReceipt Highlight(HighlightRequest request, string text, string snapshotBinding)
        {
            ValidateHighlightRequest(request);
            RequireShared(request.DocumentId);
            ValidateState(text);
            ReadWitness current = MakeWitness(request.DocumentId, request.Revision, text, snapshotBinding);
            HighlightReceipt existing = HighlightReceipts.Find(receipt => receipt.Request.RequestId == request.RequestId);
            if (existing != null)
            {
                if (existing.Outcome != null && existing.Outcome != "applied") throw Refusal("This marking identity was consumed by an incomplete native operation; inspect Word before continuing.");
                if (json.Serialize(existing.Request) != json.Serialize(request) || existing.SessionId != highlightingSession ||
                    existing.ShareEpoch != shareEpoch || existing.PolicyHash != current.PolicyHash || existing.SnapshotHash != current.SnapshotHash ||
                    existing.SourceHash != current.SourceHash)
                    throw Refusal("This marking request is changed, stale or revoked; its identity cannot be reused.");
                return Copy(existing);
            }
            if (contextRead == null || contextRead.Id != request.ContextId || !contextRead.Matches(current))
                throw Refusal("Read the complete current manuscript before marking text.");
            if (Marks.Count + request.Ranges.Count > contract.limits.marks || HighlightReceipts.Count >= MaxReceipts)
                throw Refusal("The marking or replay-receipt limit has been reached.");
            foreach (HighlightRange range in request.Ranges)
                if (Slice(text, range.From, range.To) != range.Quote)
                    throw Refusal("Every marking quote must match its exact current UTF-16 range.");
            ColorRule color;
            if (request.ColorId != null)
            {
                color = Rules.FirstOrDefault(rule => rule.Id == request.ColorId);
                if (color == null || color.Action != "neutral" || color.Prompt != "" || color.AccessMode != "suggestions")
                    throw Refusal("AI may reuse only a still-neutral functionless color identity.");
            }
            else
            {
                if (Rules.Count >= contract.slots.ruleLimit) throw Refusal("No unused color slot is available.");
                string rgb = UnusedColor();
                color = new ColorRule { Id = "ai_" + Guid.NewGuid().ToString("N"), Label = "AI color " + (Rules.Count + 1),
                    Color = rgb, Action = "neutral", Prompt = "", AccessMode = "suggestions" };
            }
            var marks = request.Ranges.Select(range => new PassageMark { Id = "Wrai_" + Guid.NewGuid().ToString("N"),
                RuleId = color.Id, From = range.From, To = range.To, Quote = range.Quote, Prompt = "", Stale = false }).ToList();
            foreach (PassageMark mark in marks) ValidateText(mark.Quote, MaxReplacement, "highlight quote");
            if (request.ColorId == null) Rules.Add(color);
            Marks.AddRange(marks);
            var result = new HighlightReceipt { Outcome = "applied", Request = Copy(request), ColorId = color.Id, MarkIds = marks.Select(mark => mark.Id).ToList(),
                ShareEpoch = shareEpoch, SessionId = highlightingSession, SourceHash = current.SourceHash, PolicyHash = PolicyHash(), SnapshotHash = current.SnapshotHash };
            HighlightReceipts.Add(result);
            InvalidateContext();
            return Copy(result);
        }

        public void ReserveHighlight(string requestId)
        {
            HighlightReceipts.First(receipt => receipt.Request.RequestId == requestId).Outcome = "reserved";
        }

        public void FailHighlight(string requestId)
        {
            HighlightReceipts.First(receipt => receipt.Request.RequestId == requestId).Outcome = "outcome_uncertain";
            Revoke();
        }

        public void CommitHighlightSnapshot(string requestId, string snapshotBinding)
        {
            HighlightReceipt receipt = HighlightReceipts.First(candidate => candidate.Request.RequestId == requestId);
            receipt.SnapshotHash = SnapshotHash(snapshotBinding);
            receipt.Outcome = "applied";
        }

        private string UnusedColor()
        {
            string[] palette = { "#F6BD60", "#84A59D", "#F28482", "#A9DEF9", "#CDB4DB", "#B9FBC0", "#FFCFD2", "#CFBAF0",
                "#98F5E1", "#90DBF4", "#F1C0E8", "#A3C4F3", "#FFC6FF", "#CAFFBF", "#FDFFB6", "#FFD6A5", "#9BF6FF", "#BDB2FF",
                "#E4C1F9", "#D0F4DE", "#FCF6BD", "#A9D6E5", "#E9C46A", "#E8AEB7", "#BDD5EA", "#C7E9B0", "#D8B4A0", "#B8D8BA" };
            string result = palette.FirstOrDefault(candidate => Rules.All(rule => Distinguishable(rule.Color, candidate)));
            if (result == null) throw Refusal("No distinguishable unused color is available.");
            return result;
        }

        private static bool Distinguishable(string left, string right)
        {
            int squaredDistance = 0;
            for (int channel = 1; channel < 7; channel += 2)
            {
                int difference = Convert.ToInt32(left.Substring(channel, 2), 16) - Convert.ToInt32(right.Substring(channel, 2), 16);
                squaredDistance += difference * difference;
            }
            return squaredDistance >= 1600;
        }

        private static void ValidateHighlightRequest(HighlightRequest request)
        {
            if (request == null || request.RequestId == null || !Identifier.IsMatch(request.RequestId)) throw Refusal("Invalid marking requestId.");
            ValidateIdentity(request.DocumentId, "document identifier");
            ValidateIdentity(request.Revision, "revision");
            ValidateIdentity(request.ContextId, "contextId");
            if (request.ColorId != null && !Identifier.IsMatch(request.ColorId)) throw Refusal("Invalid neutral color identity.");
            if (request.Ranges == null || request.Ranges.Count == 0 || request.Ranges.Count > MaxHighlightRanges)
                throw Refusal("A marking batch requires between one and 64 exact ranges.");
            int previousEnd = -1, total = 0;
            foreach (HighlightRange range in request.Ranges)
            {
                if (range == null || range.From < 0 || range.To <= range.From || range.To > MaxText || range.From < previousEnd)
                    throw Refusal("Marking ranges must be ordered, distinct and nonoverlapping within their batch.");
                ValidateText(range.Quote, MaxReplacement, "highlight quote");
                total += range.Quote.Length;
                if (range.Quote.Length != range.To - range.From || total > MaxReplacement)
                    throw Refusal("A marking batch exceeds its exact quote or total character bound.");
                previousEnd = range.To;
            }
        }

        private static void ValidateHighlightReceipt(HighlightReceipt receipt)
        {
            if (receipt == null || receipt.Outcome != null && !new[] { "applied", "reserved", "outcome_uncertain" }.Contains(receipt.Outcome)) throw Refusal("Invalid marking receipt.");
            ValidateHighlightRequest(receipt.Request);
            if (receipt.ColorId == null || !Identifier.IsMatch(receipt.ColorId) || receipt.MarkIds == null ||
                receipt.MarkIds.Count != receipt.Request.Ranges.Count || receipt.MarkIds.Distinct().Count() != receipt.MarkIds.Count ||
                receipt.MarkIds.Any(id => id == null || !Identifier.IsMatch(id)) || receipt.PolicyHash == null || !Digest.IsMatch(receipt.PolicyHash) ||
                receipt.SnapshotHash == null || !Digest.IsMatch(receipt.SnapshotHash) || receipt.SessionId == null || !Identifier.IsMatch(receipt.SessionId))
                throw Refusal("Invalid persisted marking identity or snapshot binding.");
            if (receipt.SourceHash == null || !Digest.IsMatch(receipt.SourceHash)) throw Refusal("Invalid marking source binding.");
        }
    }
}
