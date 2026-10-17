using System;
using System.Collections.Generic;
using System.Linq;

namespace UnderTree.WordAddin
{
    internal sealed class WordProtectedContent : IDisposable
    {
        private dynamic staging;
        private readonly List<PassageMark> units;
        private readonly List<ProtectedPlacement> placements;
        private readonly Dictionary<string, int> offsets = new Dictionary<string, int>();
        private readonly Dictionary<string, int> lengths = new Dictionary<string, int>();
        private readonly Dictionary<string, string> signatures = new Dictionary<string, string>();
        private dynamic proseFont;
        private readonly int nativeFrom;

        internal WordProtectedContent(dynamic application, dynamic document, Proposal proposal, List<PassageMark> units, List<ProtectedPlacement> placements)
        {
            this.units = units;
            this.placements = placements;
            if (units.Count == 0) return;
            WordSnapshot snapshot = WordSnapshot.Capture(document);
            nativeFrom = snapshot.NativeOffset(proposal.From);
            int cursor = proposal.From;
            foreach (PassageMark unit in units.Concat(new[] { new PassageMark { From = proposal.To, To = proposal.To } }))
            {
                if (cursor < unit.From)
                {
                    dynamic prose = snapshot.Range(document, cursor, unit.From);
                    WordSnapshot.RequireUniformFormatting(prose);
                    if (proseFont == null) proseFont = prose.Font.Duplicate;
                }
                cursor = unit.To;
            }
            if (proseFont == null) proseFont = document.Range(nativeFrom, nativeFrom + 1).Font.Duplicate;
            try
            {
                staging = application.Documents.Add(Visible: false);
                foreach (PassageMark unit in units)
                {
                    int offset = (int)staging.Content.End - 1;
                    offsets.Add(unit.Id, offset);
                    dynamic source = snapshot.Range(document, unit.From, unit.To);
                    int nativeLength = (int)source.End - (int)source.Start;
                    lengths.Add(unit.Id, nativeLength);
                    signatures.Add(unit.Id, WordSnapshot.FormattingSignature(source));
                    staging.Range(offset, offset).FormattedText = source.FormattedText;
                    staging.Range(offset + nativeLength, offset + nativeLength).InsertAfter("\r");
                    if ((string)staging.Range(offset, offset + nativeLength).Text != unit.Quote)
                        throw new InvalidOperationException("Word could not stage an intact protected unit.");
                }
                document.Activate();
            }
            catch { Dispose(); throw; }
        }

        internal void Restore(dynamic document, int from, int length)
        {
            if (staging == null) return;
            WordTextMap native = new WordTextMap(document);
            foreach (int[] span in native.NativeSegments(from, from + length)) document.Range(span[0], span[1]).Font = proseFont;
            foreach (ProtectedPlacement placement in placements.OrderByDescending(candidate => candidate.From))
            {
                PassageMark unit = units.First(candidate => candidate.Id == placement.Id);
                int offset = offsets[unit.Id];
                native = new WordTextMap(document);
                native.Range(document, placement.From, placement.To).FormattedText = staging.Range(offset, offset + lengths[unit.Id]).FormattedText;
            }
        }

        internal void Verify(dynamic document)
        {
            WordSnapshot snapshot = WordSnapshot.Capture(document);
            foreach (ProtectedPlacement placement in placements)
            {
                PassageMark unit = units.First(candidate => candidate.Id == placement.Id);
                dynamic range = snapshot.Range(document, placement.From, placement.To);
                if ((string)range.Text != unit.Quote || WordSnapshot.FormattingSignature(range) != signatures[unit.Id])
                    throw new InvalidOperationException("Word did not preserve a protected unit's exact native text and formatting.");
                if (!(bool)document.Bookmarks.Exists(unit.Id) || (int)document.Bookmarks.Item(unit.Id).Range.Start != (int)range.Start ||
                    (int)document.Bookmarks.Item(unit.Id).Range.End != (int)range.End)
                    throw new InvalidOperationException("Word did not retain the protected native identity.");
            }
        }

        public void Dispose()
        {
            if (staging == null) return;
            dynamic closing = staging;
            staging = null;
            closing.Close(0);
        }
    }
}
