using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace UnderTree.WordAddin
{
    internal sealed class WordTextMap
    {
        private sealed class HiddenFieldRange { internal int From, To; internal bool Closing; internal bool Deleted; }
        private readonly int[] offsets;
        private readonly Dictionary<int, int> aliases;
        private readonly List<HiddenFieldRange> deletions = new List<HiddenFieldRange>();
        internal readonly string Text;

        internal WordTextMap(dynamic document)
        {
            var hidden = new List<HiddenFieldRange>();
            foreach (object entry in (IEnumerable)document.Revisions)
            {
                dynamic revision = entry;
                int type = (int)revision.Type;
                if ((int)revision.Range.StoryType == 1 && (type == 2 || type == 14 || type == 21))
                    deletions.Add(new HiddenFieldRange { From = (int)revision.Range.Start, To = (int)revision.Range.End, Closing = true, Deleted = true });
                if (deletions.Count > 10000) throw new InvalidOperationException("Too many deleted revision ranges to map safely.");
            }
            hidden.AddRange(deletions);
            CollectFields(document.Fields, hidden, 0);
            int cursor = (int)document.Content.Start;
            int end = (int)document.Content.End;
            var boundaries = new List<int> { cursor };
            var text = new StringBuilder();
            aliases = new Dictionary<int, int>();
            foreach (HiddenFieldRange interval in hidden.OrderBy(part => part.From).ThenByDescending(part => part.To))
            {
                if (interval.To <= cursor) continue;
                if (interval.From < cursor) throw new InvalidOperationException("Conflicting native revision or field positions require local resolution.");
                Append(document, cursor, interval.From, text, boundaries);
                if (interval.Closing)
                {
                    boundaries[boundaries.Count - 1] = interval.To;
                    aliases[interval.From] = interval.To;
                }
                else aliases[interval.To] = interval.From;
                cursor = interval.To;
            }
            Append(document, cursor, end, text, boundaries);
            offsets = boundaries.ToArray();
            Text = text.ToString();
        }

        private void CollectFields(dynamic fields, List<HiddenFieldRange> ranges, int depth)
        {
            if (depth > 16) throw new InvalidOperationException("Nested fields exceed the native mapping bound.");
            foreach (object entry in (IEnumerable)fields)
            {
                if (ranges.Count >= 20000) throw new InvalidOperationException("Too many fields to map safely.");
                dynamic field = entry;
                if (deletions.Any(deleted => deleted.From <= (int)field.Code.Start - 1 && (int)field.Result.End + 1 <= deleted.To)) continue;
                if ((int)field.Result.Start >= (int)field.Result.End)
                    throw new InvalidOperationException("An empty field result cannot be mapped to a nonempty protected passage.");
                ranges.Add(new HiddenFieldRange { From = (int)field.Code.Start - 1, To = (int)field.Result.Start, Closing = false });
                ranges.Add(new HiddenFieldRange { From = (int)field.Result.End, To = (int)field.Result.End + 1, Closing = true });
                CollectFields(field.Result.Fields, ranges, depth + 1);
            }
        }

        private static void Append(dynamic document, int from, int to, StringBuilder text, List<int> boundaries)
        {
            if (to <= from) return;
            dynamic range = document.Range(from, to);
            range.TextRetrievalMode.IncludeHiddenText = true;
            string value = (string)range.Text ?? "";
            if (value.Length != to - from || text.Length + value.Length > PolicyEngine.MaxText)
                throw new InvalidOperationException("Word's native positions cannot be mapped safely in this document.");
            text.Append(value);
            for (int index = from + 1; index <= to; index++) boundaries.Add(index);
        }

        internal int NativeOffset(int visible)
        {
            if (visible < 0 || visible >= offsets.Length) throw new InvalidOperationException("Invalid visible UTF-16 range.");
            return offsets[visible];
        }

        internal IEnumerable<int[]> NativeSegments(int from, int to)
        {
            int cursor = NativeOffset(from), end = NativeOffset(to);
            foreach (HiddenFieldRange deleted in deletions.OrderBy(interval => interval.From))
            {
                if (deleted.To <= cursor || deleted.From >= end) continue;
                if (cursor < deleted.From) yield return new[] { cursor, deleted.From };
                cursor = Math.Max(cursor, deleted.To);
            }
            if (cursor < end) yield return new[] { cursor, end };
        }

        internal dynamic Range(dynamic document, int from, int to)
        {
            if (from == to) return document.Range(NativeOffset(from), NativeOffset(to));
            var segments = NativeSegments(from, to).ToList();
            if (segments.Count == 0) throw new InvalidOperationException("The requested current text has no native range.");
            return document.Range(segments[0][0], segments[segments.Count - 1][1]);
        }

        internal int VisibleOffset(int native)
        {
            native = ResolveAlias(native);
            int result = Array.BinarySearch(offsets, native);
            if (result < 0)
            {
                HiddenFieldRange deleted = deletions.FirstOrDefault(interval => interval.From <= native && native <= interval.To);
                if (deleted != null) result = Array.BinarySearch(offsets, ResolveAlias(deleted.To));
            }
            if (result < 0) throw new InvalidOperationException("This native boundary cuts a field's hidden structure.");
            return result;
        }

        private int ResolveAlias(int native)
        {
            int mapped, hops = 0;
            while (aliases.TryGetValue(native, out mapped))
            {
                if (++hops > aliases.Count) throw new InvalidOperationException("Native range aliases contain a cycle.");
                native = mapped;
            }
            return native;
        }
    }
}
