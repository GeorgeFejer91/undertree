using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Xml;

namespace UnderTree.WordAddin
{
    internal sealed class SavedWordReview
    {
        public int Version = 1;
        public string DocumentId;
        public PolicyState Policy;
    }

    internal static class WordReviewStore
    {
        private const string XmlNamespace = "urn:undertree:word:selective-editor:v1";
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4194304 };
        private static readonly string DirectoryPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "wrAIterWord", "reviews");

        public static string Fingerprint(dynamic document)
        {
            dynamic parts = document.CustomXMLParts.SelectByNamespace(XmlNamespace);
            if ((int)parts.Count == 0) return "none";
            if ((int)parts.Count != 1) throw new InvalidOperationException("Conflicting wrAIter metadata was preserved.");
            string source = (string)parts.Item(1).XML;
            if (source.Length > 4194304) throw new InvalidOperationException("Review metadata exceeds its limit.");
            return PolicyEngine.Hash(source);
        }

        public static SavedWordReview Load(dynamic document)
        {
            dynamic parts = document.CustomXMLParts.SelectByNamespace(XmlNamespace);
            if ((int)parts.Count == 0) return null;
            if ((int)parts.Count != 1) throw new InvalidOperationException("Conflicting wrAIter metadata was preserved. Resolve it before editing.");
            var xml = new XmlDocument { XmlResolver = null };
            string source = (string)parts.Item(1).XML;
            if (source.Length > 4194304) throw new InvalidOperationException("Review metadata exceeds its limit.");
            using (var text = new StringReader(source))
            using (var reader = XmlReader.Create(text, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit,
                XmlResolver = null, MaxCharactersInDocument = 4194304 })) xml.Load(reader);
            var saved = Json.Deserialize<SavedWordReview>(xml.DocumentElement.InnerText);
            Guid parsed;
            if (saved == null || saved.Version != 1 || !Guid.TryParseExact(saved.DocumentId, "N", out parsed) || saved.Policy == null)
                throw new InvalidOperationException("Unsupported review metadata was preserved.");
            string sidecar = Sidecar(saved.DocumentId);
            if (File.Exists(sidecar))
            {
                if (new FileInfo(sidecar).Length > 4194304) throw new InvalidOperationException("Pending review data exceeds its limit.");
                byte[] bytes = File.ReadAllBytes(sidecar);
                var local = Json.Deserialize<SavedWordReview>(Encoding.UTF8.GetString(ProtectedData.Unprotect(bytes, null, DataProtectionScope.CurrentUser)));
                if (local == null || local.DocumentId != saved.DocumentId || local.Version != 1)
                    throw new InvalidOperationException("Conflicting pending review data was preserved.");
                saved.Policy.Proposals = local.Policy.Proposals;
                saved.Policy.HighlightReceipts = local.Policy.HighlightReceipts;
            }
            return saved;
        }

        public static void PersistInDocument(dynamic document, SavedWordReview review)
        {
            string source = DocumentXml(review);
            ValidateReceipts(review);
            dynamic parts = document.CustomXMLParts.SelectByNamespace(XmlNamespace);
            if ((int)parts.Count > 1) throw new InvalidOperationException("Conflicting review metadata was preserved.");
            if ((int)parts.Count == 1)
            {
                dynamic previous = parts.Item(1);
                dynamic replacement = document.CustomXMLParts.Add(source);
                try { previous.Delete(); }
                catch { replacement.Delete(); throw; }
            }
            else document.CustomXMLParts.Add(source);
            PersistReceipts(review);
        }

        public static void PersistReceipts(SavedWordReview review)
        {
            Directory.CreateDirectory(DirectoryPath);
            byte[] bytes = Encode(review);
            string destination = Sidecar(review.DocumentId);
            string staging = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (var stream = new FileStream(staging, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
                if (File.Exists(destination)) File.Replace(staging, destination, null);
                else File.Move(staging, destination);
            }
            finally { if (File.Exists(staging)) File.Delete(staging); }
        }

        public static void ValidateReceipts(SavedWordReview review) { Encode(review); DocumentXml(review); }

        private static string DocumentXml(SavedWordReview review)
        {
            var xml = new XmlDocument { XmlResolver = null };
            XmlElement root = xml.CreateElement("review", XmlNamespace);
            root.InnerText = Json.Serialize(review);
            xml.AppendChild(root);
            string source = xml.OuterXml;
            if (source.Length > 4194304) throw new InvalidOperationException("Review metadata reached its safe document limit.");
            return source;
        }

        private static byte[] Encode(SavedWordReview review)
        {
            byte[] bytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(Json.Serialize(review)), null, DataProtectionScope.CurrentUser);
            if (bytes.Length > 4194304) throw new InvalidOperationException("Review data reached its safe persistence limit. Existing data was preserved.");
            return bytes;
        }

        private static string Sidecar(string documentId) { return Path.Combine(DirectoryPath, documentId + ".bin"); }
    }
}
