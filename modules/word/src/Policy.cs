using System;
using System.Collections.Generic;
using System.Linq;
using System.Web.Script.Serialization;

namespace UnderTree.WordAddin
{
    // Word owns the STA transaction; this engine never writes or saves a document.
    public sealed partial class PolicyEngine
    {
        public const int MaxText = 2000000;
        public const int MaxTextLength = MaxText;
        public const int MaxReplacement = 32768;
        public const int MaxReceipts = 1000;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 16777216 };
        private readonly ContractDefinition contract;
        private readonly Dictionary<string, ReadWitness> directWitnesses = new Dictionary<string, ReadWitness>();
        private string sharedDocumentId;
        private long shareEpoch;
        private ReadWitness contextRead;

        public List<ColorRule> Rules { get; private set; }
        public List<PassageMark> Marks { get; private set; }
        public List<Proposal> Proposals { get; private set; }
        public List<HighlightReceipt> HighlightReceipts { get; private set; }
        public bool IsShared { get { return sharedDocumentId != null; } }

        public PolicyEngine(string contractJson) : this(contractJson, null) { }

        public PolicyEngine(string contractJson, PolicyState savedState)
        {
            contract = json.Deserialize<ContractDefinition>(contractJson);
            if (contract == null || (contract.version != 1 && contract.version != 2) || contract.slots == null ||
                contract.slots.visible != 4 || contract.slots.ruleLimit != 24 || contract.limits == null ||
                contract.limits.ruleNameBytes != 100 || contract.limits.promptBytes != 4000 ||
                contract.limits.marks != 500 || contract.limits.pendingSuggestions != 500 || contract.defaultRules == null)
                throw Refusal("Unsupported selective-editor contract.");
            PolicyState state = savedState == null
                ? new PolicyState { Version = 1, Rules = contract.defaultRules, Marks = new List<PassageMark>(), Proposals = new List<Proposal>() }
                : Copy(savedState);
            if (state.Version != 1) throw Refusal("Unsupported Word review metadata; preserve its original content.");
            Rules = state.Rules;
            Marks = state.Marks;
            Proposals = state.Proposals;
            HighlightReceipts = state.HighlightReceipts ?? new List<HighlightReceipt>();
            ValidateState();
            foreach (Proposal proposal in Proposals)
                if (proposal.Status == "authorized" || proposal.Status == "applying") proposal.Status = "outcome_uncertain";
        }

        public PolicyState ExportState()
        {
            ValidateState();
            return Copy(new PolicyState { Version = 1, Rules = Rules, Marks = Marks, Proposals = Proposals, HighlightReceipts = HighlightReceipts });
        }

        public void AddOrUpdateRule(ColorRule rule)
        {
            ValidateState();
            ValidateRule(rule);
            int index = Rules.FindIndex(candidate => candidate.Id == rule.Id);
            if (index < 0)
            {
                if (Rules.Count >= contract.slots.ruleLimit) throw Refusal("The color-rule limit has been reached.");
                Rules.Add(Copy(rule));
            }
            else Rules[index] = Copy(rule);
            InvalidateContext();
        }

        public void AddMark(PassageMark mark, string text)
        {
            ValidateState(text);
            ValidateMark(mark);
            if (mark.Stale || !IsCurrent(mark, text)) throw Refusal("The highlighted quote must exactly match the current selection.");
            int index = Marks.FindIndex(candidate => candidate.Id == mark.Id);
            if (index < 0)
            {
                if (Marks.Count >= contract.limits.marks) throw Refusal("The passage-highlight limit has been reached.");
                Marks.Add(Copy(mark));
            }
            else Marks[index] = Copy(mark);
            InvalidateContext();
        }

        public bool RemoveMark(string id)
        {
            bool removed = Marks.RemoveAll(mark => mark.Id == id) != 0;
            if (removed) InvalidateContext();
            return removed;
        }

        public void Share(string documentId)
        {
            ValidateIdentity(documentId, "document identifier");
            sharedDocumentId = documentId;
            shareEpoch++;
            InvalidateContext();
        }

        public void Revoke()
        {
            sharedDocumentId = null;
            shareEpoch++;
            InvalidateContext();
        }

        public void InvalidateContext()
        {
            contextRead = null;
        }

        // Called only after native complete-story extraction and full response-size admission.
        public string ReadContext(string documentId, string revision, string text, string snapshotBinding)
        {
            RequireShared(documentId);
            ValidateState(text);
            ValidateIdentity(revision, "revision");
            contextRead = MakeWitness(documentId, revision, text, snapshotBinding);
            return contextRead.Id;
        }

        public Authorization Submit(Proposal request, string contextId, string text, string snapshotBinding)
        {
            ValidateProposal(request, false);
            RequireShared(request.DocumentId);
            Proposal existing = Proposals.Find(candidate => candidate.Id == request.Id);
            if (existing != null)
            {
                if (!SameRequest(existing, request)) throw Refusal("This requestId was already used with different wording or coordinates.");
                return Result(existing, true);
            }
            ValidateState(text);
            ReadWitness current = MakeWitness(request.DocumentId, request.Revision, text, snapshotBinding);
            if (contextRead == null || contextRead.Id != contextId || !contextRead.Matches(current))
                throw Refusal("Read the complete current manuscript context again; contextId is missing, stale or forged.");
            string mode = AuthorizeRange(request, text);
            if (Proposals.Count >= MaxReceipts) throw Refusal("The document reached its recorded-request limit; existing receipts must be retained to prevent replay.");
            if (mode == "suggestions" && Proposals.Count(proposal => proposal.Status == "pending") >= contract.limits.pendingSuggestions)
                throw Refusal("Review pending suggestions locally before adding more.");
            Proposal recorded = CopyRequest(request);
            recorded.Status = mode == "direct" ? "authorized" : "pending";
            recorded.SourceHash = current.SourceHash;
            recorded.PolicyHash = current.PolicyHash;
            recorded.SnapshotHash = current.SnapshotHash;
            Proposals.Add(recorded);
            if (mode == "direct") directWitnesses.Add(recorded.Id, current);
            return Result(recorded, false);
        }

        public Authorization ValidateAcceptance(string id, string documentId, string revision, string text, string snapshotBinding)
        {
            Proposal proposal = FindProposal(id);
            if (proposal.Status != "pending") throw Refusal("Only a pending suggestion can be accepted locally.");
            ValidateApplication(proposal, documentId, revision, text, snapshotBinding);
            return new Authorization { Mode = "suggestions", Proposal = Copy(proposal), AlreadyRecorded = false };
        }

        public Authorization ValidateDirect(string id, string documentId, string revision, string text, string snapshotBinding)
        {
            Proposal proposal = FindProposal(id);
            if (proposal.Status != "authorized") throw Refusal("This direct edit has already been consumed or is awaiting local approval.");
            RequireShared(documentId);
            ValidateApplication(proposal, documentId, revision, text, snapshotBinding);
            ReadWitness original;
            if (!directWitnesses.TryGetValue(id, out original) || !original.Matches(MakeWitness(documentId, revision, text, snapshotBinding)))
                throw Refusal("Direct access changed before the edit; read the complete context again.");
            return new Authorization { Mode = "direct", Proposal = Copy(proposal), AlreadyRecorded = false };
        }

        public void BeginApplication(string id)
        {
            Proposal proposal = FindProposal(id);
            if (proposal.Status != "pending" && proposal.Status != "authorized") throw Refusal("This request has already been consumed.");
            proposal.Status = "applying";
            directWitnesses.Remove(id);
        }

        public void RecordApplied(string id)
        {
            Proposal proposal = FindProposal(id);
            if (proposal.Status != "applying") throw Refusal("A native edit transaction must begin before it can be recorded as applied.");
            proposal.Status = "applied";
            InvalidateContext();
        }

        public void RecordTracked(string id, string bookmark, string revisionHash, string quote)
        {
            Proposal proposal = FindProposal(id);
            if (proposal.Status != "applying") throw Refusal("A native tracked replacement must begin before it can be recorded.");
            if (bookmark == null || bookmark.Length > 40 || !Identifier.IsMatch(bookmark) || !bookmark.StartsWith("WraiReview_", StringComparison.Ordinal) || revisionHash == null || !Digest.IsMatch(revisionHash))
                throw Refusal("The tracked paragraph has no verifiable native review identity.");
            ValidateText(quote, MaxText, "tracked paragraph");
            proposal.Status = "tracked";
            proposal.NativeReviewBookmark = bookmark;
            proposal.NativeReviewHash = revisionHash;
            proposal.NativeReviewQuote = quote;
            InvalidateContext();
        }

        public void RecordOutcomeUncertain(string id)
        {
            Proposal proposal = FindProposal(id);
            if (proposal.Status != "applying" && proposal.Status != "authorized" && proposal.Status != "applied" && proposal.Status != "tracked")
                throw Refusal("This request has no native edit whose outcome can be uncertain.");
            proposal.Status = "outcome_uncertain";
            directWitnesses.Remove(id);
            InvalidateContext();
        }

        public void Reject(string id)
        {
            Proposal proposal = FindProposal(id);
            if (proposal.Status != "pending") throw Refusal("Only a pending suggestion can be rejected locally.");
            proposal.Status = "rejected";
        }

        private void ValidateApplication(Proposal proposal, string documentId, string revision, string text, string snapshotBinding)
        {
            ValidateState(text);
            if (proposal.DocumentId != documentId || proposal.Revision != revision || proposal.SourceHash != Hash(text) ||
                proposal.PolicyHash != PolicyHash() || proposal.SnapshotHash != SnapshotHash(snapshotBinding))
                throw Refusal("The document, context or permissions changed; this suggestion cannot be applied.");
            AuthorizeRange(proposal, text);
        }

        private string AuthorizeRange(Proposal proposal, string text)
        {
            string replacement = ResolveReplacement(proposal, text);
            if (Slice(text, proposal.From, proposal.To) != proposal.Quote || proposal.Quote == replacement)
                throw Refusal("Quote must exactly match a nonempty changed prose range.");
            if (Marks.Any(mark => !IsCurrent(mark, text) && (Rule(mark).Action == "protect" || Rule(mark).Action == "reject" || Rule(mark).Action == "discard")))
                throw Refusal("A restrictive marker is stale; resolve it locally before submitting changes.");
            List<PassageMark> overlaps = Marks.Where(mark => mark.From < proposal.To && proposal.From < mark.To).ToList();
            foreach (PassageMark mark in overlaps.Where(mark => Rule(mark).Action == "discard"))
                if (replacement.Length != 0 || proposal.From > mark.From || proposal.To < mark.To)
                    throw Refusal("Every overlapping discard marker requires a complete removal suggestion.");
            List<PassageMark> current = overlaps.Where(mark => IsCurrent(mark, text) && (Rule(mark).Action == "prompt" || Rule(mark).Action == "discard")).OrderBy(mark => mark.From).ToList();
            int covered = proposal.From;
            foreach (PassageMark mark in current)
            {
                if (mark.From > covered) break;
                covered = Math.Max(covered, mark.To);
            }
            if (covered < proposal.To)
                throw Refusal("The complete requested range must be highlighted; unmarked gaps and boundary overruns are forbidden.");
            return current.Any(mark => Rule(mark).AccessMode == "suggestions" || Rule(mark).Action == "discard") ? "suggestions" : "direct";
        }

        private ReadWitness MakeWitness(string documentId, string revision, string text, string snapshotBinding)
        {
            return new ReadWitness { Id = Guid.NewGuid().ToString("N"), DocumentId = documentId, Revision = revision,
                SourceHash = Hash(text), PolicyHash = PolicyHash(), SnapshotHash = SnapshotHash(snapshotBinding), ShareEpoch = shareEpoch };
        }

        private string PolicyHash()
        {
            return Hash(json.Serialize(new { Rules = Rules.OrderBy(rule => rule.Id, StringComparer.Ordinal).ToArray(),
                Marks = Marks.OrderBy(mark => mark.Id, StringComparer.Ordinal).ToArray() }));
        }

        private static string SnapshotHash(string snapshotBinding)
        {
            if (String.IsNullOrEmpty(snapshotBinding) || snapshotBinding.Length > MaxText)
                throw Refusal("Native complete-context identity is missing or exceeds its limit.");
            return Hash(snapshotBinding);
        }

        private ColorRule Rule(PassageMark mark) { return Rules.First(rule => rule.Id == mark.RuleId); }

        private Proposal FindProposal(string id)
        {
            Proposal proposal = Proposals.Find(candidate => candidate.Id == id);
            if (proposal == null) throw Refusal("Select a recorded suggestion.");
            return proposal;
        }

        private void RequireShared(string documentId)
        {
            if (sharedDocumentId == null || sharedDocumentId != documentId) throw Refusal("This document is not currently shared.");
        }

        private Authorization Result(Proposal proposal, bool replay)
        {
            return new Authorization { Mode = proposal.Status == "authorized" ? "direct" : "suggestions", Proposal = Copy(proposal), AlreadyRecorded = replay };
        }

        private static bool SameRequest(Proposal previous, Proposal request)
        {
            return previous.Id == request.Id && previous.DocumentId == request.DocumentId && previous.Revision == request.Revision &&
                previous.From == request.From && previous.To == request.To && previous.Quote == request.Quote &&
                previous.Replacement == request.Replacement && (previous.Rationale ?? "") == (request.Rationale ?? "") &&
                new JavaScriptSerializer().Serialize(previous.ReplacementParts) == new JavaScriptSerializer().Serialize(request.ReplacementParts);
        }

        private Proposal CopyRequest(Proposal request)
        {
            return new Proposal { Id = request.Id, DocumentId = request.DocumentId, Revision = request.Revision,
                From = request.From, To = request.To, Quote = request.Quote, Replacement = request.Replacement,
                ReplacementParts = Copy(request.ReplacementParts), Rationale = request.Rationale ?? "" };
        }

        private T Copy<T>(T value) { return json.Deserialize<T>(json.Serialize(value)); }

        private sealed class ReadWitness
        {
            public string Id, DocumentId, Revision, SourceHash, PolicyHash, SnapshotHash;
            public long ShareEpoch;
            public bool Matches(ReadWitness other)
            {
                return DocumentId == other.DocumentId && Revision == other.Revision && SourceHash == other.SourceHash &&
                    PolicyHash == other.PolicyHash && SnapshotHash == other.SnapshotHash && ShareEpoch == other.ShareEpoch;
            }
        }
    }
}
