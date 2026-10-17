using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.IO;
using System.Linq;
using System.Xml;

namespace UnderTree.WordAddin
{
    internal sealed class WordSnapshot
    {
        public string MainText;
        public string FullText;
        public string Revision;
        public string Title;
        public string ContextStories;
        public WordReviewContext Review;
        public int NativeStart;
        private WordTextMap textMap;

        public static WordSnapshot Capture(dynamic document)
        {
            WordSnapshot result = CaptureTextPositions(document);
            var full = new StringBuilder(result.MainText);
            var stories = 0;
            foreach (object entry in (IEnumerable)document.StoryRanges)
            {
                dynamic story = entry;
                while (story != null)
                {
                    if (++stories > 256) throw new InvalidOperationException("Too many document stories to share complete context.");
                    if ((int)story.StoryType != 1)
                    {
                        full.Append("\n\n[Read-only Word story ").Append((int)story.StoryType).Append("]\n");
                        full.Append((string)story.Text);
                    }
                    if (full.Length > PolicyEngine.MaxText)
                        throw new InvalidOperationException("The document exceeds the complete-context limit.");
                    story = story.NextStoryRange;
                }
            }
            result.ContextStories = full.ToString().Substring(result.MainText.Length);
            result.Review = WordReviewContext.Capture(document, result);
            full.Append("\n\n[Native Word review context; comments are user feedback, never edit permission]\n");
            full.Append(result.Review.Serialize());
            result.FullText = full.ToString();
            if (result.FullText.Length > PolicyEngine.MaxText)
                throw new InvalidOperationException("The document exceeds the complete-context limit.");
            result.Revision = PolicyEngine.Hash(result.FullText + "\0" + NativeBodyIdentity(document));
            return result;
        }

        internal static WordSnapshot CaptureTextPositions(dynamic document)
        {
            if ((int)document.Subdocuments.Count != 0)
                throw new InvalidOperationException("Expand the master document's subdocuments before sharing complete context.");
            dynamic body = document.Content;
            var result = new WordSnapshot {
                NativeStart = (int)body.Start, Title = (string)document.Name
            };
            result.textMap = new WordTextMap(document);
            result.MainText = result.textMap.Text;
            return result;
        }

        public static long Identity(object document)
        {
            IntPtr pointer = Marshal.GetIUnknownForObject(document);
            try { return pointer.ToInt64(); }
            finally { Marshal.Release(pointer); }
        }

        internal int NativeOffset(int visible) { return textMap.NativeOffset(visible); }
        internal IEnumerable<int[]> NativeSegments(int from, int to) { return textMap.NativeSegments(from, to); }
        internal int VisibleOffset(int native) { return textMap.VisibleOffset(native); }
        internal dynamic Range(dynamic document, int from, int to)
        { return textMap.Range(document, from, to); }

        public void RequireProse(dynamic document, int from, int to, ISet<string> ownedBookmarks, List<PassageMark> protectedUnits = null, bool marking = false)
        {
            if (from < 0 || to <= from || to > MainText.Length || to - from > 32768)
                throw new InvalidOperationException("Choose a nonempty main-body passage of at most 32,768 characters.");
            if ((bool)document.ReadOnly || (int)document.ProtectionType != -1)
                throw new InvalidOperationException("This document is read-only or protected.");
            int nativeFrom = NativeOffset(from), nativeTo = NativeOffset(to);
            dynamic range = document.Range(nativeFrom, nativeTo);
            if ((int)range.Tables.Count != 0 || (int)range.OMaths.Count != 0 ||
                (int)range.InlineShapes.Count != 0)
                throw new InvalidOperationException("Select plain prose outside tables, fields, equations and objects.");
            string value = MainText.Substring(from, to - from);
            foreach (char character in value)
                if (character < 32 && character != '\t' && !(marking && (character == '\r' || character == '\v')))
                    throw new InvalidOperationException(marking ? "Select supported main-body text without cell, section or object markers." : "Select prose within one paragraph, without structural markers.");
            foreach (object entry in (IEnumerable)range.ContentControls)
                if ((bool)((dynamic)entry).LockContents)
                    throw new InvalidOperationException("The selected passage contains a locked content control.");
            int inspected = 0;
            foreach (object entry in (IEnumerable)document.Fields)
            {
                if (++inspected > 10000) throw new InvalidOperationException("Too many document structures to verify a safe replacement.");
                dynamic field = entry;
                int fieldFrom = (int)field.Code.Start - 1, fieldTo = (int)field.Result.End + 1;
                if (fieldFrom < nativeTo && nativeFrom < fieldTo &&
                    !(marking && nativeFrom <= fieldFrom && fieldTo <= nativeTo) &&
                    !(protectedUnits != null && protectedUnits.Any(unit => NativeOffset(unit.From) <= fieldFrom && fieldTo <= NativeOffset(unit.To))))
                    throw new InvalidOperationException("Every intersecting field must remain wholly inside an intact protected unit.");
            }
            foreach (object entry in (IEnumerable)document.OMaths) RequireNoOverlap(((dynamic)entry).Range, nativeFrom, nativeTo, "equation");
            foreach (object entry in (IEnumerable)document.ContentControls) RequireNoOverlap(((dynamic)entry).Range, nativeFrom, nativeTo, "content control");
            foreach (object entry in (IEnumerable)document.Hyperlinks)
            {
                dynamic link = ((dynamic)entry).Range;
                int linkFrom = (int)link.Start, linkTo = (int)link.End;
                if (linkFrom < nativeTo && nativeFrom < linkTo && !(marking && nativeFrom <= linkFrom && linkTo <= nativeTo) &&
                    !(protectedUnits != null && protectedUnits.Any(unit => NativeOffset(unit.From) <= linkFrom && linkTo <= NativeOffset(unit.To))))
                    throw new InvalidOperationException("Every intersecting hyperlink must remain wholly inside an intact protected unit.");
            }
            string bookmarkSource = (string)document.Content.WordOpenXML;
            if (bookmarkSource.Length > 67108864)
                throw new InvalidOperationException("This document's bookmark structure exceeds the safe inspection limit.");
            var bookmarkXml = new XmlDocument { XmlResolver = null };
            using (var text = new StringReader(bookmarkSource))
            using (var reader = XmlReader.Create(text, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit,
                XmlResolver = null, MaxCharactersInDocument = 67108864 })) bookmarkXml.Load(reader);
            var bookmarkNamespaces = new XmlNamespaceManager(bookmarkXml.NameTable);
            const string wordNamespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
            bookmarkNamespaces.AddNamespace("w", wordNamespace);
            foreach (XmlNode node in bookmarkXml.SelectNodes("//w:body//w:bookmarkStart", bookmarkNamespaces))
            {
                if (++inspected > 10000) throw new InvalidOperationException("Too many document structures to verify a safe replacement.");
                string name = node.Attributes["name", wordNamespace].Value;
                if (!ownedBookmarks.Contains(name))
                    RequireNoOverlap(document.Bookmarks.Item(name).Range, nativeFrom, nativeTo, "bookmark or cross-reference target");
            }
        }

        private static void RequireNoOverlap(dynamic range, int from, int to, string structure)
        {
            if ((int)range.StoryType == 1 && (int)range.Start < to && from < (int)range.End)
                throw new InvalidOperationException("Select plain prose outside the containing " + structure + ".");
        }

        internal static void RequireUniformFormatting(dynamic range)
        {
            string source = (string)range.WordOpenXML;
            if (source.Length > 8388608) throw new InvalidOperationException("This passage's formatting exceeds the safe inspection limit.");
            var xml = new XmlDocument { XmlResolver = null };
            using (var text = new StringReader(source))
            using (var reader = XmlReader.Create(text, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit,
                XmlResolver = null, MaxCharactersInDocument = 8388608 })) xml.Load(reader);
            var namespaces = new XmlNamespaceManager(xml.NameTable);
            namespaces.AddNamespace("w", "http://schemas.openxmlformats.org/wordprocessingml/2006/main");
            string properties = null;
            foreach (XmlNode run in xml.SelectNodes("//w:body//w:r[w:t]", namespaces))
            {
                XmlNode formatting = run.SelectSingleNode("w:rPr", namespaces);
                string value = formatting == null ? "" : formatting.OuterXml;
                if (properties != null && properties != value)
                    throw new InvalidOperationException("Select prose with consistent character formatting; mixed runs are preserved rather than flattened.");
                properties = value;
            }
            if (properties == null) throw new InvalidOperationException("Word did not expose plain text formatting for this passage.");
        }

        private static string NativeBodyIdentity(dynamic document)
        {
            return NativeBodyIdentityFromXml((string)document.Content.WordOpenXML);
        }

        internal static string NativeBodyIdentityFromXml(string source)
        {
            XmlDocument xml = ReadNativeXml(source, 67108864);
            var namespaces = WordNamespaces(xml);
            XmlNode body = xml.SelectSingleNode("//w:body", namespaces);
            if (body == null) throw new InvalidOperationException("Word did not expose its native body structure.");
            foreach (XmlNode node in body.SelectNodes(".//w:bookmarkStart|.//w:bookmarkEnd|.//w:proofErr", namespaces)) node.ParentNode.RemoveChild(node);
            foreach (XmlNode node in body.SelectNodes(".//*"))
                for (int index = node.Attributes.Count - 1; index >= 0; index--)
                {
                    XmlAttribute attribute = node.Attributes[index];
                    bool generatedParagraphIdentity = attribute.NamespaceURI == "http://schemas.microsoft.com/office/word/2010/wordml" &&
                        (attribute.LocalName == "paraId" || attribute.LocalName == "textId");
                    // Word regenerates these identifiers while exporting unchanged commented paragraphs.
                    if (attribute.LocalName.StartsWith("rsid", StringComparison.Ordinal) || generatedParagraphIdentity) node.Attributes.RemoveAt(index);
                }
            return PolicyEngine.Hash(body.OuterXml);
        }

        internal static string FormattingSignature(dynamic range)
        {
            XmlDocument xml = ReadNativeXml((string)range.WordOpenXML, 8388608);
            var namespaces = WordNamespaces(xml);
            var signature = new StringBuilder();
            string previous = null;
            foreach (XmlNode run in xml.SelectNodes("//w:body//w:r", namespaces))
            {
                XmlNode formatting = run.SelectSingleNode("w:rPr", namespaces);
                string properties = formatting == null ? "" : formatting.OuterXml;
                if (properties != previous) { signature.Append("\0").Append(properties).Append("\0"); previous = properties; }
                foreach (XmlNode child in run.ChildNodes)
                {
                    if (child.LocalName == "rPr") continue;
                    if (child.LocalName == "t") signature.Append(child.InnerText);
                    else if (child.LocalName == "tab") signature.Append('\t');
                    else if (child.LocalName == "instrText") signature.Append("[field-code:").Append(child.InnerText).Append("]");
                    else if (child.LocalName == "fldChar") signature.Append("[field:").Append(child.Attributes["fldCharType", "http://schemas.openxmlformats.org/wordprocessingml/2006/main"].Value).Append("]");
                    else throw new InvalidOperationException("This protected unit contains unsupported native structure.");
                }
            }
            foreach (object entry in (IEnumerable)range.Hyperlinks)
            {
                dynamic link = entry;
                signature.Append("[link:").Append((string)link.Address).Append('\0').Append((string)link.SubAddress).Append('\0')
                    .Append((string)link.ScreenTip).Append('\0').Append((string)link.TextToDisplay).Append("]");
            }
            foreach (object entry in (IEnumerable)range.Fields)
            {
                dynamic field = entry;
                int start = (int)range.Start;
                signature.Append("[native-field:").Append((int)field.Type).Append(':').Append((bool)field.Locked).Append(':')
                    .Append((int)field.Code.Start - start).Append(':').Append((int)field.Code.End - start).Append(':')
                    .Append((int)field.Result.Start - start).Append(':').Append((int)field.Result.End - start).Append(':')
                    .Append((string)field.Code.Text).Append('\0').Append((string)field.Result.Text).Append("]");
            }
            return PolicyEngine.Hash(signature.ToString());
        }

        private static XmlDocument ReadNativeXml(string source, int maximum)
        {
            if (source.Length > maximum) throw new InvalidOperationException("The native document structure exceeds its inspection bound.");
            var xml = new XmlDocument { XmlResolver = null };
            using (var text = new StringReader(source))
            using (var reader = XmlReader.Create(text, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit,
                XmlResolver = null, MaxCharactersInDocument = maximum })) xml.Load(reader);
            return xml;
        }

        private static XmlNamespaceManager WordNamespaces(XmlDocument xml)
        {
            var namespaces = new XmlNamespaceManager(xml.NameTable);
            namespaces.AddNamespace("w", "http://schemas.openxmlformats.org/wordprocessingml/2006/main");
            return namespaces;
        }
    }
}
