using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace UnderTree.WordAddin
{
    public sealed partial class PolicyEngine
    {
        public List<PassageMark> ProtectedUnits(Proposal proposal, string text)
        {
            List<PassageMark> units = Marks.Where(mark => mark.From < proposal.To && proposal.From < mark.To &&
                (Rule(mark).Action == "protect" || Rule(mark).Action == "reject")).OrderBy(mark => mark.From).ToList();
            int previousEnd = -1;
            foreach (PassageMark unit in units)
            {
                if (!IsCurrent(unit, text) || unit.From < proposal.From || unit.To > proposal.To)
                    throw Refusal("The rewrite must include each current protected unit completely.");
                if (unit.From < previousEnd)
                    throw Refusal("Overlapping protected units require local resolution before a rewrite.");
                previousEnd = unit.To;
            }
            return Copy(units);
        }

        public string ResolveReplacement(Proposal proposal, string text)
        {
            List<PassageMark> units = ProtectedUnits(proposal, text);
            if (proposal.ReplacementParts == null)
            {
                if (units.Count != 0) throw Refusal("Protected units require an explicit native-identity preservation mapping.");
                return proposal.Replacement;
            }
            var used = new HashSet<string>(StringComparer.Ordinal);
            var replacement = new StringBuilder();
            foreach (ReplacementPart part in proposal.ReplacementParts)
            {
                if (part.Text != null) replacement.Append(part.Text);
                else
                {
                    PassageMark unit = units.FirstOrDefault(mark => mark.Id == part.ProtectedId);
                    if (unit == null || !used.Add(unit.Id)) throw Refusal("Protected identity is unknown, outside this rewrite or duplicated.");
                    replacement.Append(unit.Quote);
                }
                if (replacement.Length > MaxReplacement) throw Refusal("Reconstructed replacement exceeds its wording limit.");
            }
            if (used.Count != units.Count) throw Refusal("Every protected unit must occur exactly once in the replacement mapping.");
            foreach (PassageMark mark in Marks.Where(mark => !mark.Stale && mark.From < proposal.To && proposal.From < mark.To))
            {
                if (units.Any(unit => unit.Id == mark.Id)) continue;
                if (mark.From <= proposal.From && mark.To >= proposal.To) continue;
                if (units.Any(unit => mark.From >= unit.From && mark.To <= unit.To)) continue;
                throw Refusal("An overlapping marker cannot be reanchored unambiguously; resolve it locally before rearranging protection.");
            }
            return replacement.ToString();
        }

        public List<ProtectedPlacement> ProtectedPlacements(Proposal proposal, string text)
        {
            ResolveReplacement(proposal, text);
            var placements = new List<ProtectedPlacement>();
            if (proposal.ReplacementParts == null) return placements;
            int offset = proposal.From;
            foreach (ReplacementPart part in proposal.ReplacementParts)
            {
                if (part.Text != null) offset += part.Text.Length;
                else
                {
                    PassageMark unit = Marks.First(mark => mark.Id == part.ProtectedId);
                    placements.Add(new ProtectedPlacement { Id = unit.Id, From = offset, To = offset + unit.Quote.Length });
                    offset += unit.Quote.Length;
                }
            }
            return placements;
        }
    }
}
