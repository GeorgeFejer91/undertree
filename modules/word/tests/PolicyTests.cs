using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Web.Script.Serialization;
using UnderTree.WordAddin;

internal static class PolicyTests
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16777216 };
    private static string contract;
    private static int assertions;
    private const string Text = "Alpha \ud83d\ude00 beta gamma.";
    private const string DocumentId = "word_test_document";
    private const string Revision = "revision_1";
    private const string Snapshot = "all-stories-native-identity-1";

    public static int Main(string[] arguments)
    {
        try
        {
            contract = File.ReadAllText(arguments.Length > 0 ? arguments[0] : "modules/review/selective-editor-contract.json");
            SharedRangeCases();
            SharedPreservationCases();
            NeutralHighlighting();
            DistinctNeutralColor();
            ExactUtf16Boundaries();
            ContextAndRevocation();
            OverlapAndStalePermissions();
            DiscardRequiresCompleteLocalApproval();
            PendingAcceptanceRechecksCurrentState();
            ReplayCannotApplyAgainOrUpgrade();
            PersistenceDoesNotRestoreSharing();
            LimitsAndCorruptState();
            Console.WriteLine("Word policy: " + assertions + " assertions passed.");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }

    private static void SharedPreservationCases()
    {
        Dictionary<string, object> shared = Json.Deserialize<Dictionary<string, object>>(contract);
        foreach (Dictionary<string, object> scenario in (IEnumerable)shared["preservationCases"])
        {
            string text = (string)scenario["text"];
            PolicyEngine engine = new PolicyEngine(contract);
            engine.Rules.Clear();
            var identities = new Dictionary<string, string>();
            foreach (Dictionary<string, object> highlight in (IEnumerable)scenario["marks"])
            {
                string id = "Wrai_" + Guid.NewGuid().ToString("N");
                identities.Add((string)highlight["id"], id);
                engine.Rules.Add(Rule(id, (string)highlight["action"], (string)highlight["accessMode"]));
                engine.Marks.Add(Mark(id, id, (int)highlight["from"], (int)highlight["to"], text));
            }
            var change = (Dictionary<string, object>)scenario["proposal"];
            Proposal request = Request((string)scenario["id"], (int)change["from"], (int)change["to"], (string)change["quote"], (string)change["replacement"]);
            request.ReplacementParts = new List<ReplacementPart>();
            foreach (Dictionary<string, object> part in (IEnumerable)change["replacementParts"])
                request.ReplacementParts.Add(part.ContainsKey("text") ? new ReplacementPart { Text = (string)part["text"] } :
                    new ReplacementPart { ProtectedId = identities[(string)part["protectedId"]] });
            string token = Read(engine, text);
            string expected = (string)scenario["result"];
            if (expected == "denied")
            {
                Denied(() => engine.Submit(request, token, text, Snapshot), (string)scenario["id"]);
                Equal(0, engine.Proposals.Count, "Denied preservation creates no receipt.");
                continue;
            }
            Authorization result = engine.Submit(request, token, text, Snapshot);
            Equal(expected == "applied" ? "direct" : "suggestions", result.Mode, "Preservation mode: " + scenario["id"]);
            Equal((string)scenario["expectedText"], engine.ResolveReplacement(result.Proposal, text), "Protected units reconstruct the exact expected wording.");
            List<ProtectedPlacement> placements = engine.ProtectedPlacements(result.Proposal, text);
            Equal(request.ReplacementParts.Count(part => part.ProtectedId != null), placements.Count, "Every original identity has one reanchor destination.");
            foreach (ProtectedPlacement placement in placements)
            {
                string unit = engine.Marks.First(mark => mark.Id == placement.Id).Quote;
                Equal(unit, PolicyEngine.Slice((string)scenario["expectedText"], placement.From, placement.To), "Native identity maps to the whole immutable unit.");
            }
            if (result.Mode == "direct") engine.ValidateDirect(request.Id, DocumentId, Revision, text, Snapshot);
            else engine.ValidateAcceptance(request.Id, DocumentId, Revision, text, Snapshot);
            engine.Rules[0].Prompt += " changed";
            if (result.Mode == "direct") Denied(() => engine.ValidateDirect(request.Id, DocumentId, Revision, text, Snapshot), "Policy changed before direct preservation.");
            else Denied(() => engine.ValidateAcceptance(request.Id, DocumentId, Revision, text, Snapshot), "Policy changed before preservation acceptance.");
        }
    }

    private static void NeutralHighlighting()
    {
        PolicyEngine engine = new PolicyEngine(contract);
        engine.Rules.Clear();
        engine.Share(DocumentId);
        var request = new HighlightRequest { DocumentId = DocumentId, Revision = Revision, RequestId = "highlight", ContextId = "forged",
            Ranges = new List<HighlightRange> { new HighlightRange { From = 9, To = 13, Quote = "beta" }, new HighlightRange { From = 14, To = 19, Quote = "gamma" } } };
        Denied(() => engine.Highlight(request, Text, Snapshot), "Coloring needs complete context.");
        request.ContextId = engine.ReadContext(DocumentId, Revision, Text, Snapshot);
        request.Ranges[1].Quote = "wrong";
        Denied(() => engine.Highlight(request, Text, Snapshot), "A bad batch range rejects the whole batch.");
        Equal(0, engine.Rules.Count, "A bad batch allocates no color.");
        Equal(0, engine.Marks.Count, "A bad batch leaves no partial marks.");
        request.Ranges[1].Quote = "gamma";
        HighlightReceipt receipt = engine.Highlight(request, Text, Snapshot);
        Equal(2, engine.Marks.Count, "Batch marks both exact occurrences.");
        Equal("neutral", engine.Rules[0].Action, "Fresh AI color has no function.");
        Equal("", engine.Rules[0].Prompt, "Fresh AI color has no prompt.");
        Equal(2, engine.Highlight(request, Text, Snapshot).MarkIds.Count, "Lost marking reply replays the original receipt.");
        Equal(2, engine.Marks.Count, "Replay adds no duplicate marks.");
        string context = engine.ReadContext(DocumentId, Revision, Text, Snapshot);
        Denied(() => engine.Submit(Request("neutral_edit", 9, 13, "beta", "changed"), context, Text, Snapshot), "Neutral is not suggestion or direct permission.");
        request.RequestId = "reuse_neutral"; request.ColorId = receipt.ColorId; request.ContextId = context;
        engine.Highlight(request, Text, Snapshot);
        Equal(1, engine.Rules.Count, "Still-neutral reuse retains its identity.");
        engine.AddOrUpdateRule(new ColorRule { Id = receipt.ColorId, Label = "Protect citations", Color = engine.Rules[0].Color,
            Action = "protect", Prompt = "", AccessMode = "suggestions" });
        request.RequestId = "rule_bearing"; request.ContextId = engine.ReadContext(DocumentId, Revision, Text, Snapshot);
        Denied(() => engine.Highlight(request, Text, Snapshot), "A local rule assignment closes remote reuse.");
        request.RequestId = "highlight";
        Denied(() => engine.Highlight(request, Text, Snapshot), "Changed policy cannot revive a previous color request.");
        engine.Revoke(); engine.Share(DocumentId);
        Denied(() => engine.Highlight(request, Text, Snapshot), "Marking requests cannot survive a revoked sharing epoch.");
        PolicyEngine reopened = new PolicyEngine(contract, engine.ExportState());
        reopened.Share(DocumentId);
        Denied(() => reopened.Highlight(request, Text, Snapshot), "Reopen cannot revive a marking receipt.");
        ColorRule neutral = Rule("invalid_neutral", "neutral", "direct");
        Denied(() => engine.AddOrUpdateRule(neutral), "Neutral cannot assign direct access.");
        neutral.AccessMode = "suggestions"; neutral.Prompt = "hidden rule";
        Denied(() => engine.AddOrUpdateRule(neutral), "Neutral cannot contain a hidden prompt.");
    }

    private static void DistinctNeutralColor()
    {
        var policy = new PolicyEngine(contract);
        policy.Rules.Clear();
        policy.AddOrUpdateRule(new ColorRule { Id = "near_user_color", Label = "User's citation color", Color = "#F6BD61", Action = "protect", Prompt = "", AccessMode = "suggestions" });
        policy.Share(DocumentId);
        string context = policy.ReadContext(DocumentId, Revision, Text, Snapshot);
        HighlightReceipt receipt = policy.Highlight(new HighlightRequest { DocumentId = DocumentId, Revision = Revision, RequestId = "distinct_neutral",
            ContextId = context, Ranges = new List<HighlightRange> { new HighlightRange { From = 9, To = 13, Quote = "beta" } } }, Text, Snapshot);
        string chosen = policy.Rules.First(rule => rule.Id == receipt.ColorId).Color;
        double red = Convert.ToInt32(chosen.Substring(1, 2), 16) - 246;
        double green = Convert.ToInt32(chosen.Substring(3, 2), 16) - 189;
        double blue = Convert.ToInt32(chosen.Substring(5, 2), 16) - 97;
        Equal(true, Math.Sqrt(red * red + green * green + blue * blue) >= 40,
            "A fresh neutral color remains visually distinct from a nearly identical user-defined palette hue.");
        Equal("#F6BD61", policy.Rules.First(rule => rule.Id == "near_user_color").Color, "Allocation never changes the user's existing color.");
    }

    private static void SharedRangeCases()
    {
        Dictionary<string, object> shared = Json.Deserialize<Dictionary<string, object>>(contract);
        foreach (Dictionary<string, object> scenario in (IEnumerable)shared["rangeCases"])
        {
            string text = (string)scenario["text"];
            PolicyEngine engine = new PolicyEngine(contract);
            engine.Rules.Clear();
            int index = 0;
            foreach (Dictionary<string, object> highlight in (IEnumerable)scenario["marks"])
            {
                string id = "rule_" + index;
                engine.Rules.Add(Rule(id, (string)highlight["action"], (string)highlight["accessMode"]));
                engine.Marks.Add(Mark("mark_" + index, id, (int)highlight["from"], (int)highlight["to"], text));
                index++;
            }
            Dictionary<string, object> change = (Dictionary<string, object>)scenario["proposal"];
            Proposal request = Request((string)scenario["id"], (int)change["from"], (int)change["to"], (string)change["quote"], (string)change["replacement"]);
            string token = Read(engine, text);
            string expected = (string)scenario["result"];
            if (expected == "denied")
            {
                Denied(() => engine.Submit(request, token, text, Snapshot), (string)scenario["id"]);
                Equal(0, engine.Proposals.Count, "Denied proposals create no pending state.");
            }
            else
            {
                Authorization result = engine.Submit(request, token, text, Snapshot);
                Equal(expected == "applied" ? "direct" : "suggestions", result.Mode, "Shared range mode: " + scenario["id"]);
                Equal(expected == "applied" ? "authorized" : "pending", result.Proposal.Status, "Shared range state: " + scenario["id"]);
                Equal(Text, text, "Policy never mutates source text.");
            }
        }
    }

    private static void ExactUtf16Boundaries()
    {
        PolicyEngine engine = DirectEngine();
        string token = Read(engine, Text);
        Equal("\ud83d\ude00 beta", PolicyEngine.Slice(Text, 6, 13), "UTF-16 astral quote.");
        Denied(() => PolicyEngine.Slice(Text, 7, 13), "Split surrogate start.");
        Denied(() => PolicyEngine.Slice(Text, 0, 7), "Split surrogate end.");
        Denied(() => PolicyEngine.Slice(Text, -1, 2), "Negative boundary.");
        Denied(() => PolicyEngine.Slice(Text, 0, Int32.MaxValue), "Range overflow.");
        Denied(() => engine.Submit(Request("split", 7, 13, Text.Substring(7, 6), "new"), token, Text, Snapshot), "Incomplete quoted Unicode.");
        Denied(() => engine.Submit(Request("unpaired", 9, 13, "beta", "\ud800"), token, Text, Snapshot), "Incomplete replacement Unicode.");
        Denied(() => engine.Submit(Request("null", 9, 13, "beta", "a\0b"), token, Text, Snapshot), "Null replacement.");
        Denied(() => engine.Submit(Request("unchanged", 9, 13, "beta", "beta"), token, Text, Snapshot), "No-op proposal.");
        Denied(() => engine.Submit(Request("empty", 9, 9, "", "new"), token, Text, Snapshot), "Insertion has no authorized source range.");
        Denied(() => engine.Submit(Request("bad_quote", 9, 13, "Beta", "new"), token, Text, Snapshot), "Quote exactness.");
        Denied(() => engine.Submit(Request("long", 9, 13, "beta", new string('x', PolicyEngine.MaxReplacement + 1)), token, Text, Snapshot), "Replacement bound.");
        Equal(0, engine.Proposals.Count, "Malformed text never creates a proposal.");
    }

    private static void ContextAndRevocation()
    {
        PolicyEngine engine = DirectEngine();
        Proposal request = Request("context", 9, 13, "beta", "clear beta");
        Denied(() => engine.ReadContext(DocumentId, Revision, Text, Snapshot), "Reading without sharing.");
        engine.Share(DocumentId);
        Denied(() => engine.Submit(request, "guessed", Text, Snapshot), "No native prior read.");
        string token = engine.ReadContext(DocumentId, Revision, Text, Snapshot);
        Denied(() => engine.Submit(request, "forged", Text, Snapshot), "Forged witness.");
        Denied(() => engine.Submit(request, token, Text + "!", Snapshot), "Source changed without a claimed revision update.");
        Denied(() => engine.Submit(request, token, Text, "another-story-changed"), "Ancillary manuscript story changed.");
        request.Revision = "another_revision";
        Denied(() => engine.Submit(request, token, Text, Snapshot), "Revision changed.");
        request.Revision = Revision;
        request.DocumentId = "another_document";
        Denied(() => engine.Submit(request, token, Text, Snapshot), "Cross-document proposal.");
        request.DocumentId = DocumentId;
        engine.Marks[0].Prompt = "Passage instructions changed locally.";
        Denied(() => engine.Submit(request, token, Text, Snapshot), "Direct mark field changes invalidate witness.");
        token = engine.ReadContext(DocumentId, Revision, Text, Snapshot);
        engine.Rules[0].AccessMode = "suggestions";
        Denied(() => engine.Submit(request, token, Text, Snapshot), "Direct rule field changes invalidate witness.");
        token = engine.ReadContext(DocumentId, Revision, Text, Snapshot);
        engine.InvalidateContext();
        Denied(() => engine.Submit(request, token, Text, Snapshot), "Explicit native invalidation.");
        token = engine.ReadContext(DocumentId, Revision, Text, Snapshot);
        engine.Revoke();
        Denied(() => engine.Submit(request, token, Text, Snapshot), "Revoked sharing.");
        engine.Share(DocumentId);
        Denied(() => engine.Submit(request, token, Text, Snapshot), "Re-sharing does not revive old witness.");
        token = engine.ReadContext(DocumentId, Revision, Text, Snapshot);
        Equal("pending", engine.Submit(request, token, Text, Snapshot).Proposal.Status, "Fresh complete read restores permission.");
        PolicyEngine other = DirectEngine();
        other.Share(DocumentId);
        Denied(() => other.Submit(Request("other", 9, 13, "beta", "new"), token, Text, Snapshot), "Witness cannot be moved to another native engine.");
        Denied(() => other.ReadContext(DocumentId, Revision, Text, ""), "Missing native complete-context identity.");
    }

    private static void OverlapAndStalePermissions()
    {
        foreach (string action in new[] { "protect", "reject", "discard" })
        {
            PolicyEngine engine = DirectEngine();
            engine.Rules.Add(Rule("restriction", action, "suggestions"));
            engine.Marks.Add(Mark("restriction_mark", "restriction", 14, 19, Text));
            engine.Marks[1].Stale = true;
            string token = Read(engine, Text);
            Denied(() => engine.Submit(Request("stale_" + action, 9, 13, "beta", "new"), token, Text, Snapshot), "Stale restrictive marker fails closed globally: " + action);
            engine.Marks[1].Stale = false;
            engine.Marks[1].Quote = "wrong";
            token = engine.ReadContext(DocumentId, Revision, Text, Snapshot);
            Denied(() => engine.Submit(Request("wrong_" + action, 9, 13, "beta", "new"), token, Text, Snapshot), "Mismatching restrictive quote is stale even without its flag.");
        }
        PolicyEngine consumed = DirectEngine();
        consumed.Marks.Add(Mark("used", "prompt", 14, 19, Text));
        consumed.Marks[1].Stale = true;
        string read = Read(consumed, Text);
        Equal("direct", consumed.Submit(Request("separate", 9, 13, "beta", "new"), read, Text, Snapshot).Mode, "Separate stale prompt marker does not expand or block current permission.");
        consumed.Marks[0].Stale = true;
        read = consumed.ReadContext(DocumentId, Revision, Text, Snapshot);
        Denied(() => consumed.Submit(Request("no_current", 9, 13, "beta", "new"), read, Text, Snapshot), "Stale prompt supplies no coverage.");
    }

    private static void DiscardRequiresCompleteLocalApproval()
    {
        PolicyEngine engine = DirectEngine();
        engine.Rules.Add(Rule("delete", "discard", "suggestions"));
        engine.Marks.Add(Mark("delete_mark", "delete", 9, 13, Text));
        string token = Read(engine, Text);
        Denied(() => engine.Submit(Request("discard_reword", 9, 13, "beta", "new"), token, Text, Snapshot), "Discard cannot be bypassed by overlapping direct prompt.");
        Denied(() => engine.Submit(Request("discard_partial", 10, 13, "eta", ""), token, Text, Snapshot), "Partial discard deletion.");
        Authorization allowed = engine.Submit(Request("discard_full", 9, 13, "beta", ""), token, Text, Snapshot);
        Equal("suggestions", allowed.Mode, "Discard always awaits approval.");
        Denied(() => engine.ValidateDirect("discard_full", DocumentId, Revision, Text, Snapshot), "Discard is never direct.");
        Equal("pending", engine.ValidateAcceptance("discard_full", DocumentId, Revision, Text, Snapshot).Proposal.Status, "Local acceptance can validate full deletion.");
        engine.BeginApplication("discard_full");
        engine.RecordApplied("discard_full");
        Equal("applied", engine.Proposals[0].Status, "Native deletion receipt.");
    }

    private static void PendingAcceptanceRechecksCurrentState()
    {
        PolicyEngine engine = SuggestionEngine();
        string token = Read(engine, Text);
        engine.Submit(Request("approval", 9, 13, "beta", "new"), token, Text, Snapshot);
        Denied(() => engine.ValidateAcceptance("approval", DocumentId, "new_revision", Text, Snapshot), "Acceptance rechecks revision.");
        Denied(() => engine.ValidateAcceptance("approval", DocumentId, Revision, Text.Replace("beta", "Beta"), Snapshot), "Acceptance rechecks source and quote.");
        Denied(() => engine.ValidateAcceptance("approval", DocumentId, Revision, Text, "changed_header"), "Acceptance rechecks complete-context snapshot.");
        engine.Marks[0].From = 10;
        Denied(() => engine.ValidateAcceptance("approval", DocumentId, Revision, Text, Snapshot), "Acceptance rechecks current highlights.");
        engine.Marks[0].From = 0;
        engine.Rules[0].Action = "protect";
        Denied(() => engine.ValidateAcceptance("approval", DocumentId, Revision, Text, Snapshot), "Acceptance rechecks protection.");
        engine.Rules[0].Action = "prompt";
        engine.Revoke();
        Equal("pending", engine.ValidateAcceptance("approval", DocumentId, Revision, Text, Snapshot).Proposal.Status, "A local user can accept while offline and unshared.");
        engine.BeginApplication("approval");
        Denied(() => engine.ValidateAcceptance("approval", DocumentId, Revision, Text, Snapshot), "A native edit already in progress cannot be accepted again.");
        engine.RecordOutcomeUncertain("approval");
        Equal("outcome_uncertain", engine.Proposals[0].Status, "Failed native outcome is terminal.");
        Denied(() => engine.BeginApplication("approval"), "An uncertain outcome cannot be replayed.");
    }

    private static void ReplayCannotApplyAgainOrUpgrade()
    {
        PolicyEngine engine = DirectEngine();
        string token = Read(engine, Text);
        Proposal request = Request("replay", 9, 13, "beta", "new");
        request.Status = "applied";
        request.SourceHash = new string('a', 64);
        Authorization first = engine.Submit(request, token, Text, Snapshot);
        Equal("authorized", first.Proposal.Status, "A remote status assertion is ignored.");
        Equal(PolicyEngine.Hash(Text), first.Proposal.SourceHash, "Native source binding overrides supplied hash.");
        Equal(false, first.AlreadyRecorded, "First direct request is new.");
        Equal(true, engine.Submit(request, token, Text, Snapshot).AlreadyRecorded, "Repeated prepared direct request cannot be reapplied.");
        Equal("direct", engine.ValidateDirect("replay", DocumentId, Revision, Text, Snapshot).Mode, "Native direct recheck.");
        engine.BeginApplication("replay");
        Equal("applying", engine.Submit(request, token, Text, Snapshot).Proposal.Status, "Reentrant retry returns existing unfinished receipt.");
        engine.RecordApplied("replay");
        Authorization replay = engine.Submit(request, token, Text.Replace("beta", "new"), "new_snapshot");
        Equal(true, replay.AlreadyRecorded, "Lost acknowledgement replay is idempotent after source changed.");
        Equal("applied", replay.Proposal.Status, "Replay retains terminal receipt.");
        Denied(() => engine.ValidateDirect("replay", DocumentId, Revision, Text, Snapshot), "An applied edit cannot be applied again.");
        request.Replacement = "different";
        Denied(() => engine.Submit(request, token, Text, Snapshot), "A reused id cannot replace its original request.");
        engine.RecordOutcomeUncertain("replay");
        Equal("outcome_uncertain", engine.Proposals[0].Status, "A metadata failure after native replacement must not report confirmed success.");
        Denied(() => engine.BeginApplication("replay"), "A changed document with uncertain metadata cannot be replayed.");

        PolicyEngine pending = SuggestionEngine();
        token = Read(pending, Text);
        Proposal suggestion = Request("no_upgrade", 9, 13, "beta", "new");
        pending.Submit(suggestion, token, Text, Snapshot);
        pending.Rules[0].AccessMode = "direct";
        Authorization stillPending = pending.Submit(suggestion, token, Text, Snapshot);
        Equal(true, stillPending.AlreadyRecorded, "Existing suggestion is a replay.");
        Equal("pending", stillPending.Proposal.Status, "Replay cannot upgrade a suggestion after permissions change.");
        Equal("suggestions", stillPending.Mode, "Pending always requires local approval.");

        PolicyEngine revoked = DirectEngine();
        token = Read(revoked, Text);
        revoked.Submit(Request("revoke_direct", 9, 13, "beta", "new"), token, Text, Snapshot);
        revoked.Revoke();
        Denied(() => revoked.ValidateDirect("revoke_direct", DocumentId, Revision, Text, Snapshot), "Revocation before native direct application.");
        revoked.Share(DocumentId);
        Denied(() => revoked.ValidateDirect("revoke_direct", DocumentId, Revision, Text, Snapshot), "A new sharing epoch cannot revive a prepared direct edit.");
    }

    private static void PersistenceDoesNotRestoreSharing()
    {
        PolicyEngine original = SuggestionEngine();
        string token = Read(original, Text);
        Proposal request = Request("persisted", 9, 13, "beta", "new");
        original.Submit(request, token, Text, Snapshot);
        PolicyState saved = Json.Deserialize<PolicyState>(Json.Serialize(original.ExportState()));
        PolicyEngine restored = new PolicyEngine(contract, saved);
        Equal(false, restored.IsShared, "Reopen never restores sharing.");
        Equal("pending", restored.Proposals[0].Status, "Pending survives reopen.");
        Equal("suggestions", restored.ValidateAcceptance("persisted", DocumentId, Revision, Text, Snapshot).Mode, "Current persisted suggestion can be approved locally.");
        Denied(() => restored.ReadContext(DocumentId, Revision, Text, Snapshot), "Reopen requires sharing consent.");
        restored.Share(DocumentId);
        Denied(() => restored.Submit(Request("old_read", 9, 13, "beta", "new"), token, Text, Snapshot), "Reopen never restores prior-read authority.");
        restored.Reject("persisted");
        Equal("rejected", restored.Proposals[0].Status, "Rejection is a persisted receipt.");
        Equal("rejected", restored.Submit(request, token, Text, Snapshot).Proposal.Status, "A rejected id cannot become pending again.");
        Equal("pending", original.Proposals[0].Status, "Export/reopen use independent state copies.");

        PolicyEngine direct = DirectEngine();
        token = Read(direct, Text);
        direct.Submit(Request("unfinished", 9, 13, "beta", "new"), token, Text, Snapshot);
        PolicyEngine uncertain = new PolicyEngine(contract, direct.ExportState());
        Equal("outcome_uncertain", uncertain.Proposals[0].Status, "Reopen cannot replay an unacknowledged direct edit.");
        direct.BeginApplication("unfinished");
        uncertain = new PolicyEngine(contract, direct.ExportState());
        Equal("outcome_uncertain", uncertain.Proposals[0].Status, "Reopen cannot replay an interrupted native transaction.");
    }

    private static void LimitsAndCorruptState()
    {
        PolicyEngine engine = new PolicyEngine(contract);
        Equal(4, engine.Rules.Count, "Shared default color count.");
        Equal("Keep unchanged", engine.Rules[0].Label, "Shared rule labels loaded from contract.");
        Equal(true, engine.Rules.All(candidate => candidate.AccessMode == "suggestions"), "Suggestions are the default.");
        ColorRule rule = Rule("utf8", "prompt", "suggestions");
        rule.Label = new string('\u00e9', 50);
        rule.Prompt = String.Concat(Enumerable.Repeat("\ud83d\ude00", 1000));
        engine.AddOrUpdateRule(rule);
        Equal(5, engine.Rules.Count, "UTF-8 limits permit exact boundaries.");
        rule.Label += "x";
        Denied(() => engine.AddOrUpdateRule(rule), "UTF-8 name byte overrun.");
        rule.Label = "Valid";
        rule.Prompt += "x";
        Denied(() => engine.AddOrUpdateRule(rule), "UTF-8 prompt byte overrun.");
        foreach (string action in new[] { "protect", "reject", "discard" })
            Denied(() => engine.AddOrUpdateRule(Rule("forbidden_" + action, action, "direct")), "Restrictive colors cannot authorize direct: " + action);
        for (int index = engine.Rules.Count; index < 24; index++) engine.AddOrUpdateRule(Rule("rule_" + index, "prompt", "suggestions"));
        Denied(() => engine.AddOrUpdateRule(Rule("extra", "prompt", "suggestions")), "Rule count bound.");

        PolicyEngine marks = DirectEngine();
        for (int index = 1; index < 500; index++) marks.Marks.Add(Mark("mark_" + index, "prompt", 9, 13, Text));
        marks.ValidateState(Text);
        Denied(() => marks.AddMark(Mark("extra", "prompt", 9, 13, Text), Text), "Mark count bound.");
        Equal(true, marks.RemoveMark("mark_499"), "Local mark removal.");
        marks.AddMark(Mark("replacement", "prompt", 9, 13, Text), Text);
        Equal(500, marks.Marks.Count, "Capacity restored by explicit mark removal.");

        PolicyEngine pending = SuggestionEngine();
        string token = Read(pending, Text);
        Proposal template = pending.Submit(Request("template", 9, 13, "beta", "new"), token, Text, Snapshot).Proposal;
        for (int index = 1; index < 500; index++)
        {
            Proposal proposal = Json.Deserialize<Proposal>(Json.Serialize(template));
            proposal.Id = "pending_" + index;
            pending.Proposals.Add(proposal);
        }
        Denied(() => pending.Submit(Request("too_many", 9, 13, "beta", "new"), token, Text, Snapshot), "Pending count bound.");
        Equal(500, pending.Proposals.Count, "Full pending queue remains unchanged.");
        PolicyState corrupted = pending.ExportState();
        corrupted.Proposals[0].PolicyHash = "forged";
        Denied(() => new PolicyEngine(contract, corrupted), "Corrupted binding is preserved by refusal.");
        corrupted = pending.ExportState();
        corrupted.Proposals[0].Status = "model_says_applied";
        Denied(() => new PolicyEngine(contract, corrupted), "Unknown persisted status.");
        corrupted = pending.ExportState();
        corrupted.Marks.Add(Json.Deserialize<PassageMark>(Json.Serialize(corrupted.Marks[0])));
        Denied(() => new PolicyEngine(contract, corrupted), "Duplicate persisted markers.");
        corrupted = pending.ExportState();
        corrupted.Version = 99;
        Denied(() => new PolicyEngine(contract, corrupted), "Future metadata version is never reset.");

        PolicyEngine receipts = DirectEngine();
        token = Read(receipts, Text);
        Proposal receipt = receipts.Submit(Request("receipt", 9, 13, "beta", "new"), token, Text, Snapshot).Proposal;
        receipts.Proposals[0].Status = "rejected";
        for (int index = 1; index < PolicyEngine.MaxReceipts; index++)
        {
            Proposal previous = Json.Deserialize<Proposal>(Json.Serialize(receipt));
            previous.Id = "receipt_" + index;
            previous.Status = "rejected";
            receipts.Proposals.Add(previous);
        }
        Denied(() => receipts.Submit(Request("extra_receipt", 9, 13, "beta", "new"), token, Text, Snapshot), "Receipt history is bounded without evicting replay protection.");
        Equal(PolicyEngine.MaxReceipts, receipts.Proposals.Count, "Full receipt history remains unchanged.");
    }

    private static PolicyEngine DirectEngine()
    {
        PolicyEngine engine = new PolicyEngine(contract);
        engine.Rules.Clear();
        engine.Rules.Add(Rule("prompt", "prompt", "direct"));
        engine.Marks.Add(Mark("editable", "prompt", 0, 13, Text));
        return engine;
    }

    private static PolicyEngine SuggestionEngine()
    {
        PolicyEngine engine = DirectEngine();
        engine.Rules[0].AccessMode = "suggestions";
        return engine;
    }

    private static ColorRule Rule(string id, string action, string access)
    {
        return new ColorRule { Id = id, Label = id, Color = "#e5be50", Action = action, Prompt = action == "neutral" ? "" : "Keep meaning.", AccessMode = access };
    }

    private static PassageMark Mark(string id, string rule, int from, int to, string text)
    {
        return new PassageMark { Id = id, RuleId = rule, From = from, To = to, Quote = PolicyEngine.Slice(text, from, to), Prompt = "", Stale = false };
    }

    private static Proposal Request(string id, int from, int to, string quote, string replacement)
    {
        return new Proposal { Id = id, DocumentId = DocumentId, Revision = Revision, From = from, To = to, Quote = quote, Replacement = replacement, Rationale = "Clearer wording." };
    }

    private static string Read(PolicyEngine engine, string text)
    {
        engine.Share(DocumentId);
        return engine.ReadContext(DocumentId, Revision, text, Snapshot);
    }

    private static void Equal<T>(T expected, T actual, string message)
    {
        assertions++;
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
            throw new Exception(message + " Expected " + expected + ", got " + actual + ".");
    }

    private static void Denied(Action action, string message)
    {
        assertions++;
        try { action(); }
        catch (InvalidOperationException) { return; }
        throw new Exception("Expected policy refusal: " + message);
    }
}
