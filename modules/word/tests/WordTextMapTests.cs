using System;
using System.Collections.Generic;
using System.Linq;
using UnderTree.WordAddin;

public sealed class MapTestRetrieval { public bool IncludeHiddenText { get; set; } }
public sealed class MapTestRange
{
    public int Start { get; set; }
    public int End { get; set; }
    public int StoryType { get { return 1; } }
    public string Text { get; set; }
    public List<MapTestField> Fields { get; set; }
    public MapTestRetrieval TextRetrievalMode { get { return new MapTestRetrieval(); } }
}
public sealed class MapTestRevision
{
    public int Type { get { return 2; } }
    public MapTestRange Range { get; set; }
}
public sealed class MapTestField
{
    public MapTestRange Code { get; set; }
    public MapTestRange Result { get; set; }
}
public sealed class MapTestDocument
{
    public string NativeText;
    public List<MapTestRevision> Revisions { get; set; }
    public List<MapTestField> Fields { get; set; }
    public MapTestRange Content { get { return Range(0, NativeText.Length); } }
    public MapTestRange Range(int from, int to)
    { return new MapTestRange { Start = from, End = to, Text = NativeText.Substring(from, to - from), Fields = new List<MapTestField>() }; }
}

internal static class WordTextMapTests
{
    private static int assertions;
    public static int Main()
    {
        try
        {
            var document = Document("abcdeX", 0, 3, 3, 5);
            var map = new WordTextMap(document);
            Equal("X", map.Text, "Adjacent deleted revisions leave only final text.");
            for (int native = 0; native <= 5; native++) Equal(0, map.VisibleOffset(native), "Every adjacent deleted position maps to the same final boundary.");
            Equal(1, map.VisibleOffset(6), "Visible suffix preserves its final boundary.");
            Equal(5, map.NativeOffset(0), "The writable final range starts after both deletion revisions.");
            Equal(6, map.NativeOffset(1), "The visible suffix maps to its exact native endpoint.");
            Denied(() => map.VisibleOffset(-1), "Out-of-bounds native positions stay invalid.");
            Denied(() => map.VisibleOffset(7), "Native positions cannot overrun the document.");

            map = new WordTextMap(Document("ab\ud83d\ude00cdX", 0, 2, 2, 4, 4, 6));
            Equal("X", map.Text, "Three adjacent deletions preserve the Unicode suffix.");
            for (int native = 0; native <= 6; native++) Equal(0, map.VisibleOffset(native), "A transitive deletion chain maps starts, interiors and endpoints.");
            Equal(6, map.NativeOffset(0), "A transitive deletion chain never exposes deleted source as editable text.");

            document = Document("###AB#cdX", 6, 8);
            document.Fields.Add(new MapTestField { Code = document.Range(1, 2), Result = document.Range(3, 5) });
            map = new WordTextMap(document);
            Equal("ABX", map.Text, "Field codes and deleted revisions are omitted from final text.");
            Equal(0, map.VisibleOffset(3), "Field result starts map through the native opening boundary.");
            Equal(2, map.VisibleOffset(5), "A field closing boundary resolves through an adjacent deletion.");
            Equal(2, map.VisibleOffset(7), "An interior deletion after a field stays at the same final boundary.");
            Equal(8, map.NativeOffset(2), "Native editing begins after the hidden field closing and deletion.");
            Equal(9, map.NativeOffset(3), "Final text still maps to the exact document end.");
            Denied(() => new WordTextMap(Document("abcdeX", 0, 3, 2, 5)), "Conflicting native deletion ranges fail closed.");
            document = Document("AxxByyCzz", 1, 3, 4, 6, 7, 9);
            map = new WordTextMap(document);
            Equal("ABC", map.Text, "Multiple removed native spans leave the exact logical current body.");
            Equal("0..1|3..4|6..7", String.Join("|", map.NativeSegments(0, 3).Select(span => span[0] + ".." + span[1])),
                "Formatting traverses only current native segments and never touches original deleted text.");
            MapTestRange currentUnit = map.Range(document, 2, 3);
            Equal(6, currentUnit.Start, "A protected current unit begins at its own native object.");
            Equal(7, currentUnit.End, "A trailing deletion cannot expand a protected current unit's native range.");
            Equal("C", currentUnit.Text, "Tight native unit ranges exclude original deleted content.");
            document = Document("###AB#cdX", 6, 8);
            document.Fields.Add(new MapTestField { Code = document.Range(1, 2), Result = document.Range(3, 5) });
            map = new WordTextMap(document);
            currentUnit = map.Range(document, 0, 2);
            Equal(0, currentUnit.Start, "Whole current fields retain their native opening structure.");
            Equal(6, currentUnit.End, "Whole current fields retain their closing structure while excluding adjacent deleted text.");
            Console.WriteLine("PASS " + assertions + " native final-text mapping assertions.");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }

    private static MapTestDocument Document(string text, params int[] deleted)
    {
        var document = new MapTestDocument { NativeText = text, Fields = new List<MapTestField>(), Revisions = new List<MapTestRevision>() };
        for (int index = 0; index < deleted.Length; index += 2)
            document.Revisions.Add(new MapTestRevision { Range = document.Range(deleted[index], deleted[index + 1]) });
        return document;
    }

    private static void Equal<T>(T expected, T actual, string message)
    { assertions++; if (!EqualityComparer<T>.Default.Equals(expected, actual)) throw new Exception(message); }
    private static void Denied(Action action, string message)
    {
        assertions++;
        try { action(); }
        catch (InvalidOperationException) { return; }
        throw new Exception(message);
    }
}
