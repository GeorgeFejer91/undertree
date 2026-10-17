using System.Collections.Generic;

namespace UnderTree.WordAddin
{
    public sealed class ColorRule
    {
        public string Id { get; set; }
        public string Label { get; set; }
        public string Color { get; set; }
        public string Action { get; set; }
        public string Prompt { get; set; }
        public string AccessMode { get; set; }
    }

    public sealed class PassageMark
    {
        public string Id { get; set; }
        public string RuleId { get; set; }
        public int From { get; set; }
        public int To { get; set; }
        public string Quote { get; set; }
        public string Prompt { get; set; }
        public bool Stale { get; set; }
        public string NativeBookmark { get; set; }
    }

    public sealed class Proposal
    {
        public string Id { get; set; }
        public string DocumentId { get; set; }
        public string Revision { get; set; }
        public int From { get; set; }
        public int To { get; set; }
        public string Quote { get; set; }
        public string Replacement { get; set; }
        public List<ReplacementPart> ReplacementParts { get; set; }
        public string Rationale { get; set; }
        public string Status { get; set; }
        public string SourceHash { get; set; }
        public string PolicyHash { get; set; }
        public string SnapshotHash { get; set; }
        public string NativeReviewBookmark { get; set; }
        public string NativeReviewHash { get; set; }
        public string NativeReviewQuote { get; set; }
        public string NativeOriginalParagraphQuote { get; set; }
        public List<NativeMarkWitness> NativeOriginalMarks { get; set; }
    }

    public sealed class NativeMarkWitness
    {
        public string Id { get; set; }
        public string Bookmark { get; set; }
        public string BeforeQuote { get; set; }
        public string BeforeSignature { get; set; }
        public string AfterQuote { get; set; }
        public string AfterSignature { get; set; }
    }

    public sealed class ReplacementPart
    {
        public string Text { get; set; }
        public string ProtectedId { get; set; }
    }

    public sealed class HighlightRange
    {
        public int From { get; set; }
        public int To { get; set; }
        public string Quote { get; set; }
    }

    public sealed class HighlightRequest
    {
        public string RequestId { get; set; }
        public string DocumentId { get; set; }
        public string Revision { get; set; }
        public string ContextId { get; set; }
        public string ColorId { get; set; }
        public List<HighlightRange> Ranges { get; set; }
    }

    public sealed class HighlightReceipt
    {
        public string Outcome { get; set; }
        public string SessionId { get; set; }
        public string SourceHash { get; set; }
        public HighlightRequest Request { get; set; }
        public string ColorId { get; set; }
        public List<string> MarkIds { get; set; }
        public long ShareEpoch { get; set; }
        public string PolicyHash { get; set; }
        public string SnapshotHash { get; set; }
    }

    public sealed class ProtectedPlacement
    {
        public string Id { get; set; }
        public int From { get; set; }
        public int To { get; set; }
    }

    public sealed class PolicyState
    {
        public int Version { get; set; }
        public List<ColorRule> Rules { get; set; }
        public List<PassageMark> Marks { get; set; }
        public List<Proposal> Proposals { get; set; }
        public List<HighlightReceipt> HighlightReceipts { get; set; }
    }

    public sealed class Authorization
    {
        public string Mode { get; set; }
        public Proposal Proposal { get; set; }
        public bool AlreadyRecorded { get; set; }
    }
}
