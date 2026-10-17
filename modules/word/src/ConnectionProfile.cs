using System;
using System.Collections.Generic;
using System.IO;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;

namespace UnderTree.WordAddin
{
    internal sealed class ConnectionProfile : IDisposable
    {
        private readonly FileStream lease;
        private readonly object persistenceGate = new object();
        private byte[] saved;
        private byte[] savedCleanup;
        private bool closed;
        internal readonly string DirectoryPath;
        internal readonly string Home;
        internal readonly string OwnerId = Guid.NewGuid().ToString("D");
        internal string Reservation { get; private set; }
        internal string PublicOrigin { get; private set; }
        internal string ApiEndpoint { get; private set; }
        internal bool Configured { get; private set; }

        internal ConnectionProfile(string directory)
        {
            DirectoryPath = System.IO.Path.GetFullPath(directory);
            SecureDirectory(DirectoryPath);
            Home = System.IO.Path.Combine(DirectoryPath, "connection-home");
            SecureDirectory(Home);
            string lockPath = System.IO.Path.Combine(DirectoryPath, "connection.lock");
            CheckPlain(lockPath);
            try { lease = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) { throw new InvalidOperationException("Another Word process owns this connection. Close that Word process first."); }
            try
            {
                string path = System.IO.Path.Combine(DirectoryPath, "connection.json");
                CheckPlain(path);
                if (!File.Exists(path))
                {
                    Reservation = "wraiter-word-" + Guid.NewGuid().ToString("N").Substring(0, 12);
                    ApiEndpoint = "https://api-v2.zrok.io";
                    PublicOrigin = "";
                    Save();
                    return;
                }
                saved = ReadBounded(path, 8192);
                IDictionary<string, object> value;
                try { value = McpEndpoint.Json().DeserializeObject(new UTF8Encoding(false, true).GetString(saved)) as IDictionary<string, object>; }
                catch (ArgumentException) { throw InvalidProfile(); }
                if (value == null || value.Count != 5 || !value.ContainsKey("version") || !Object.Equals(value["version"], 1) ||
                    !value.ContainsKey("reservation") || !value.ContainsKey("apiEndpoint") || !value.ContainsKey("publicOrigin") || !value.ContainsKey("configured") || !(value["configured"] is bool))
                    throw InvalidProfile();
                Reservation = value["reservation"] as string;
                ApiEndpoint = value["apiEndpoint"] as string;
                PublicOrigin = value["publicOrigin"] as string;
                Configured = (bool)value["configured"];
                Validate();
            }
            catch { lease.Dispose(); throw; }
        }

        internal void SetApiEndpoint(string endpoint)
        {
            string normalized = ValidateHttpsOrigin(endpoint);
            if (HasEnrollment && !String.Equals(ApiEndpoint, normalized, StringComparison.Ordinal))
                throw new InvalidOperationException("This Word enrollment already belongs to another service. Keep its saved service endpoint.");
            ApiEndpoint = normalized;
            Save();
        }

        internal void MarkConfigured() { Configured = true; Save(); }

        internal void SetPublicOrigin(string origin)
        {
            string normalized = ValidateHttpsOrigin(origin);
            if (!new Uri(normalized).Host.StartsWith(Reservation + ".", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The controller returned a frontend belonging to another reservation.");
            if (PublicOrigin.Length != 0 && PublicOrigin != normalized)
                throw new InvalidOperationException("The saved Word reservation frontend changed. Review its configuration locally.");
            PublicOrigin = normalized;
            Save();
        }

        internal bool HasEnrollment
        {
            get
            {
                string path = System.IO.Path.Combine(Home, ".zrok2", "environment.json");
                CheckPlain(path);
                return File.Exists(path);
            }
        }

        internal string EnrollmentIdentity()
        {
            string directory = System.IO.Path.Combine(Home, ".zrok2");
            SecureDirectory(directory);
            SecureEnrollmentTree(directory, 0, new int[1]);
            string path = System.IO.Path.Combine(directory, "environment.json");
            CheckPlain(path);
            object raw;
            IDictionary<string, object> value = McpEndpoint.Json().DeserializeObject(new UTF8Encoding(false, true).GetString(ReadBounded(path, 1048576))) as IDictionary<string, object>;
            string identity = value != null && value.TryGetValue("ziti_identity", out raw) ? raw as string : null;
            if (identity == null || !Regex.IsMatch(identity, @"\A[A-Za-z0-9_.-]{1,128}\z"))
                throw new InvalidOperationException("The private Word enrollment is invalid. Existing state was preserved.");
            return identity;
        }

        private void Validate()
        {
            if (Reservation == null || !Regex.IsMatch(Reservation, @"\Awraiter-word-[a-f0-9]{12}\z") || PublicOrigin == null)
                throw InvalidProfile();
            ApiEndpoint = ValidateHttpsOrigin(ApiEndpoint);
            if (PublicOrigin.Length > 0)
            {
                PublicOrigin = ValidateHttpsOrigin(PublicOrigin);
                if (!new Uri(PublicOrigin).Host.StartsWith(Reservation + ".", StringComparison.OrdinalIgnoreCase)) throw InvalidProfile();
            }
        }

        private void Save()
        {
            lock (persistenceGate) { RequireLease(); SaveCore(); }
        }

        private void SaveCore()
        {
            Validate();
            string path = System.IO.Path.Combine(DirectoryPath, "connection.json");
            CheckPlain(path);
            if (File.Exists(path))
            {
                if (saved == null || !SameBytes(ReadBounded(path, 8192), saved))
                    throw new InvalidOperationException("Word connection settings changed externally. Existing state was preserved.");
            }
            else if (saved != null) throw new InvalidOperationException("Word connection settings disappeared. Existing state was preserved.");
            byte[] content = Encoding.UTF8.GetBytes(McpEndpoint.Json().Serialize(new { version = 1, reservation = Reservation,
                apiEndpoint = ApiEndpoint, publicOrigin = PublicOrigin, configured = Configured }));
            string temporary = System.IO.Path.Combine(DirectoryPath, "connection-" + Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                using (FileStream output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
                { output.Write(content, 0, content.Length); output.Flush(true); }
                if (saved == null) File.Move(temporary, path);
                else File.Replace(temporary, path, null);
                saved = content;
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }

        internal string ReadCleanupBarrier()
        {
            lock (persistenceGate)
            {
                RequireLease();
                string path = System.IO.Path.Combine(DirectoryPath, "share-cleanup.bin");
                CheckPlain(path);
                if (!File.Exists(path)) return null;
                savedCleanup = ReadBounded(path, 8192);
                return new UTF8Encoding(false, true).GetString(ProtectedData.Unprotect(savedCleanup, null, DataProtectionScope.CurrentUser));
            }
        }

        internal void WriteCleanupBarrier(string value)
        {
            lock (persistenceGate)
            {
                RequireLease();
                string path = System.IO.Path.Combine(DirectoryPath, "share-cleanup.bin");
                VerifyCleanupFile(path);
                byte[] bytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(value), null, DataProtectionScope.CurrentUser);
                if (bytes.Length > 8192) throw new InvalidOperationException("The Word share cleanup identity exceeded its limit.");
                string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
                try
                {
                    using (FileStream output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
                    { output.Write(bytes, 0, bytes.Length); output.Flush(true); }
                    if (savedCleanup == null) File.Move(temporary, path);
                    else File.Replace(temporary, path, null);
                    savedCleanup = bytes;
                }
                finally { if (File.Exists(temporary)) File.Delete(temporary); }
            }
        }

        internal void ClearCleanupBarrier()
        {
            lock (persistenceGate)
            {
                RequireLease();
                string path = System.IO.Path.Combine(DirectoryPath, "share-cleanup.bin");
                VerifyCleanupFile(path);
                if (savedCleanup != null) File.Delete(path);
                savedCleanup = null;
            }
        }

        private void VerifyCleanupFile(string path)
        {
            CheckPlain(path);
            if (File.Exists(path))
            {
                if (savedCleanup == null || !SameBytes(ReadBounded(path, 8192), savedCleanup))
                    throw new InvalidOperationException("Word share cleanup state changed externally. Existing ownership was preserved.");
            }
            else if (savedCleanup != null) throw new InvalidOperationException("Word share cleanup state disappeared. Reconnect remains blocked.");
        }

        private void RequireLease() { if (closed) throw new ObjectDisposedException("Word connection profile"); }

        internal static string ValidateHttpsOrigin(string value)
        {
            Uri parsed;
            if (String.IsNullOrEmpty(value) || value.Length > 2048 || value.IndexOf('\\') >= 0 ||
                !Uri.TryCreate(value, UriKind.Absolute, out parsed) || parsed.Scheme != "https" || parsed.Port != 443 ||
                parsed.UserInfo.Length != 0 || parsed.Query.Length != 0 || parsed.Fragment.Length != 0 || parsed.AbsolutePath != "/" ||
                !Regex.IsMatch(parsed.Host, @"\A[A-Za-z0-9.-]+\z") || !String.Equals(parsed.Host, parsed.DnsSafeHost, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Use a plain HTTPS service origin without credentials, paths or query parameters.");
            foreach (char character in value) if (Char.IsWhiteSpace(character) || Char.IsControl(character))
                throw new InvalidOperationException("Use a plain HTTPS service origin.");
            return parsed.GetLeftPart(UriPartial.Authority).TrimEnd('/');
        }

        internal static void SecureDirectory(string path)
        {
            CheckPlain(path);
            if (!System.IO.Directory.Exists(path)) System.IO.Directory.CreateDirectory(path);
            CheckPlain(path);
            DirectorySecurity permissions = new DirectorySecurity();
            permissions.SetAccessRuleProtection(true, false);
            SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
            permissions.SetOwner(user);
            permissions.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            permissions.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            System.IO.Directory.SetAccessControl(path, permissions);
        }

        private static void SecureEnrollmentTree(string directory, int depth, int[] count)
        {
            if (depth > 3) throw new InvalidOperationException("The private Word enrollment contains unsupported nested state.");
            foreach (string entry in System.IO.Directory.EnumerateFileSystemEntries(directory))
            {
                if (++count[0] > 128) throw new InvalidOperationException("The private Word enrollment exceeds its file limit.");
                CheckPlain(entry);
                if (System.IO.Directory.Exists(entry))
                { SecureDirectory(entry); SecureEnrollmentTree(entry, depth + 1, count); continue; }
                FileSecurity permissions = new FileSecurity();
                permissions.SetAccessRuleProtection(true, false);
                SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
                permissions.SetOwner(user);
                permissions.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl, AccessControlType.Allow));
                permissions.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, AccessControlType.Allow));
                File.SetAccessControl(entry, permissions);
            }
        }

        internal static void CheckPlain(string path)
        {
            string current = System.IO.Path.GetFullPath(path);
            while (!String.IsNullOrEmpty(current))
            {
                if ((File.Exists(current) || System.IO.Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidOperationException("Linked Word connection state is not permitted.");
                current = System.IO.Path.GetDirectoryName(current);
            }
        }

        internal static byte[] ReadBounded(string path, int limit)
        {
            CheckPlain(path);
            using (FileStream source = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (source.Length > limit) throw new InvalidOperationException("Word connection state exceeds its limit. Existing state was preserved.");
                byte[] bytes = new byte[(int)source.Length];
                int offset = 0;
                while (offset < bytes.Length)
                {
                    int count = source.Read(bytes, offset, bytes.Length - offset);
                    if (count == 0) throw new IOException("Connection state ended unexpectedly.");
                    offset += count;
                }
                return bytes;
            }
        }

        private static bool SameBytes(byte[] left, byte[] right)
        {
            if (left.Length != right.Length) return false;
            for (int index = 0; index < left.Length; index++) if (left[index] != right[index]) return false;
            return true;
        }

        private static InvalidOperationException InvalidProfile()
        { return new InvalidOperationException("Word connection settings are invalid. Existing state was preserved."); }

        public void Dispose() { lock (persistenceGate) { closed = true; lease.Dispose(); } }
    }
}
