using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading;

namespace UnderTree.WordAddin
{
    internal sealed class TunnelSupervisor : IDisposable
    {
        private readonly object gate = new object();
        private readonly ConnectionProfile profile;
        private readonly TunnelProcess commands;
        private readonly Action revoke;
        private readonly Action<string> allowHost;
        private CancellationTokenSource cancellation = new CancellationTokenSource();
        private Thread worker;
        private Process child;
        private OwnedShare owned;
        private string preparedTarget, preparedEnvironment;
        private string phase = "stopped", error = "";
        private bool disposed;
        private bool recovered;

        internal TunnelSupervisor(ConnectionProfile profile, string executable, Action revoke, Action<string> allowHost)
        {
            this.profile = profile; this.revoke = revoke; this.allowHost = allowHost;
            commands = new TunnelProcess(executable, profile.Home);
            try { RestoreCleanupBarrier(); }
            catch { commands.Dispose(); throw; }
        }

        internal void Configure(string token, string apiEndpoint)
        {
            string endpoint = ConnectionProfile.ValidateHttpsOrigin(apiEndpoint);
            if (!profile.HasEnrollment && (String.IsNullOrEmpty(token) || token.Length < 8 || token.Length > 4096 || token.Any(c => Char.IsWhiteSpace(c) || Char.IsControl(c))))
                throw new InvalidOperationException("Enter your zrok account enrollment token. It is used only for this Word enrollment.");
            lock (gate)
            {
                RequireIdle();
                if (preparedTarget != null) throw new InvalidOperationException("Verify the previous Word share cleanup before changing setup.");
                profile.SetApiEndpoint(endpoint);
                Begin("configuring", delegate(CancellationToken cancel)
                {
                    if (!profile.HasEnrollment)
                    {
                        commands.Run(new[] { "config", "set", "apiEndpoint", profile.ApiEndpoint }, cancel);
                        commands.Run(new[] { "enable", token, "--headless", "--description", "wrAIter Word" }, cancel);
                    }
                    profile.EnrollmentIdentity();
                    if (!ReservedNameExists(cancel))
                    {
                        commands.Run(new[] { "create", "name", profile.Reservation, "-n", "public" }, cancel);
                        if (!ReservedNameExists(cancel)) throw new InvalidOperationException("The dedicated Word reservation could not be confirmed. Its assigned name was preserved for retry.");
                    }
                    cancel.ThrowIfCancellationRequested();
                    profile.MarkConfigured();
                    lock (gate) phase = "configured";
                });
            }
        }

        internal void Start(string localAddress)
        {
            lock (gate)
            {
                RequireIdle();
                if (!profile.Configured || !profile.HasEnrollment) throw new InvalidOperationException("Configure this Word connection with your zrok account token first.");
                if (preparedTarget != null) throw new InvalidOperationException("Previous Word share cleanup is unverified. Retry Stop before reconnecting.");
                Uri local = new Uri(localAddress);
                if (local.Scheme != "http" || local.Host != "127.0.0.1" || local.Port == 0 || !local.AbsolutePath.StartsWith("/t/", StringComparison.Ordinal))
                    throw new InvalidOperationException("The private Word MCP listener is unavailable.");
                Begin("starting", delegate(CancellationToken cancel)
                {
                    Launch(local.GetLeftPart(UriPartial.Authority), cancel);
                    while (!cancel.WaitHandle.WaitOne(200))
                        if (child.HasExited) throw new InvalidOperationException("The Word tunnel stopped. Current sharing was revoked; reconnect locally.");
                });
            }
        }

        private void Begin(string nextPhase, Action<CancellationToken> operation)
        {
            cancellation.Dispose();
            cancellation = new CancellationTokenSource();
            CancellationToken cancel = cancellation.Token;
            phase = nextPhase; error = "";
            worker = new Thread(delegate()
            {
                bool failed = false;
                try { operation(cancel); }
                catch (OperationCanceledException) { }
                catch (Exception)
                {
                    failed = true;
                    lock (gate) error = nextPhase == "configuring"
                        ? "Word connection setup failed. Check your token, service and account quota; its assigned reservation was preserved."
                        : "Word connection failed. Check its private enrollment and reservation; current sharing was revoked.";
                }
                finally
                {
                    if (nextPhase == "starting")
                    {
                        lock (gate) phase = "stopping";
                        allowHost(null);
                        revoke();
                    }
                    try
                    {
                        Cleanup();
                        lock (gate) if (nextPhase != "configuring" || cancel.IsCancellationRequested || failed) phase = failed ? "failed" : "stopped";
                    }
                    catch (Exception)
                    {
                        lock (gate)
                        {
                            phase = "cleanup_required";
                            error = "Word share cleanup is unverified. Retry Stop; no unrelated share will be removed.";
                        }
                    }
                }
            }) { IsBackground = true, Name = "wrAIter Word connection" };
            worker.Start();
        }

        private void Launch(string target, CancellationToken cancel)
        {
            string environment = profile.EnrollmentIdentity();
            if (!ReservedNameExists(cancel)) throw new InvalidOperationException("The saved Word reservation is unavailable. Configure it locally before connecting.");
            if (TargetRecords(target, cancel).Count != 0)
                throw new InvalidOperationException("This Word target is already occupied. No existing share was adopted or changed.");
            cancel.ThrowIfCancellationRequested();
            preparedTarget = target; preparedEnvironment = environment;
            PersistCleanupBarrier();
            child = commands.Spawn(new[] { "share", "public", target, "-n", "public:" + profile.Reservation, "--headless", "--force-local" });
            TunnelProcess.Drain(child);
            Stopwatch startup = Stopwatch.StartNew();
            while (!cancel.WaitHandle.WaitOne(200))
            {
                if (child.HasExited) throw new InvalidOperationException("The bundled Word tunnel exited during startup.");
                bool discovered = Discover(cancel);
                if (discovered && startup.ElapsedMilliseconds >= 2000)
                {
                    cancel.ThrowIfCancellationRequested();
                    if (child.HasExited) throw new InvalidOperationException("The Word tunnel exited during startup.");
                    profile.SetPublicOrigin(owned.Origin);
                    lock (gate)
                    {
                        cancel.ThrowIfCancellationRequested();
                        allowHost(new Uri(owned.Origin).Authority);
                        phase = "running";
                    }
                    return;
                }
                if (startup.ElapsedMilliseconds > 25000) throw new InvalidOperationException("The Word tunnel did not confirm ownership before its startup deadline.");
            }
            cancel.ThrowIfCancellationRequested();
        }

        private bool ReservedNameExists(CancellationToken cancel)
        {
            object raw = McpEndpoint.Json().DeserializeObject(commands.Run(new[] { "list", "names", "--json", "-n", "public" }, cancel));
            IEnumerable rows = raw as IEnumerable;
            if (rows == null || raw is IDictionary || raw is string) throw new InvalidOperationException("The reservation listing was invalid.");
            int matches = 0, count = 0;
            foreach (object entry in rows)
            {
                if (++count > 1000) throw new InvalidOperationException("The reservation listing exceeded its limit.");
                IDictionary<string, object> row = entry as IDictionary<string, object>;
                if (row == null) throw new InvalidOperationException("The reservation listing was invalid.");
                if (Text(row, "name") == profile.Reservation && Text(row, "namespaceToken") == "public")
                {
                    object reserved;
                    if (!row.TryGetValue("reserved", out reserved) || !Object.Equals(reserved, true))
                        throw new InvalidOperationException("The Word name is not an owned persistent reservation.");
                    object bound;
                    if (row.TryGetValue("shareToken", out bound) && bound != null && !String.IsNullOrEmpty(bound as string) && preparedTarget == null)
                        throw new InvalidOperationException("The Word name is already bound. No existing share will be changed.");
                    matches++;
                }
            }
            if (matches > 1) throw new InvalidOperationException("The Word reservation has ambiguous ownership.");
            return matches == 1;
        }

        private List<IDictionary<string, object>> Records(string flag, string value, CancellationToken cancel)
        {
            IDictionary<string, object> listing = McpEndpoint.Json().DeserializeObject(commands.Run(new[] { "list", "shares", "--json", flag, value }, cancel)) as IDictionary<string, object>;
            object raw;
            IEnumerable rows = listing != null && listing.TryGetValue("shares", out raw) ? raw as IEnumerable : null;
            if (rows == null || rows is IDictionary || rows is string) throw new InvalidOperationException("The Word share listing was invalid.");
            List<IDictionary<string, object>> records = new List<IDictionary<string, object>>();
            foreach (object entry in rows)
            {
                IDictionary<string, object> row = entry as IDictionary<string, object>;
                if (row == null || records.Count >= 1000) throw new InvalidOperationException("The Word share listing exceeded its contract.");
                records.Add(row);
            }
            return records;
        }

        private List<IDictionary<string, object>> TargetRecords(string target, CancellationToken cancel)
        { return Records("--target", target, cancel).Where(row => Text(row, "target") == target || Text(row, "target") == target.Substring(7)).ToList(); }

        private bool Discover(CancellationToken cancel)
        {
            List<IDictionary<string, object>> rows = TargetRecords(preparedTarget, cancel);
            if (rows.Count == 0) return false;
            if (rows.Count != 1) throw new InvalidOperationException("The Word target has ambiguous share ownership.");
            OwnedShare current = Identity(rows[0]);
            if (owned != null && !owned.Same(current)) throw new InvalidOperationException("Word share ownership changed.");
            if (owned == null) { owned = current; PersistCleanupBarrier(); }
            return true;
        }

        private OwnedShare Identity(IDictionary<string, object> row)
        {
            OwnedShare identity = new OwnedShare { Token = Text(row, "shareToken"), Environment = Text(row, "envZId"), Target = Text(row, "target") };
            object raw;
            IList endpoints = row.TryGetValue("frontendEndpoints", out raw) ? raw as IList : null;
            if (endpoints == null || endpoints.Count != 1 || !(endpoints[0] is string) || identity.Token == null ||
                !System.Text.RegularExpressions.Regex.IsMatch(identity.Token, @"\A[A-Za-z0-9_.-]{1,128}\z") || identity.Environment != preparedEnvironment ||
                (identity.Target != preparedTarget && identity.Target != preparedTarget.Substring(7)) || Text(row, "shareMode") != "public" || Text(row, "backendMode") != "proxy")
                throw new InvalidOperationException("Word share ownership could not be verified.");
            string frontend = (string)endpoints[0];
            identity.Origin = ConnectionProfile.ValidateHttpsOrigin(frontend.StartsWith("https://", StringComparison.Ordinal) ? frontend : "https://" + frontend);
            if (!new Uri(identity.Origin).Host.StartsWith(profile.Reservation + ".", StringComparison.OrdinalIgnoreCase) ||
                (profile.PublicOrigin.Length != 0 && profile.PublicOrigin != identity.Origin))
                throw new InvalidOperationException("The controller frontend belongs to another reservation.");
            identity.Target = preparedTarget;
            return identity;
        }

        internal void Stop()
        {
            lock (gate)
            {
                if (disposed) return;
                cancellation.Cancel();
                allowHost(null);
                if (worker != null && worker.IsAlive) { phase = "stopping"; return; }
                if (preparedTarget != null) Begin("stopping", delegate(CancellationToken ignored) { });
                else phase = "stopped";
            }
        }

        private void Cleanup()
        {
            allowHost(null);
            TunnelProcess.Kill(child);
            if (child != null) { child.Dispose(); child = null; }
            if (preparedTarget == null) return;
            if (recovered && owned == null)
            {
                if (TargetRecords(preparedTarget, CancellationToken.None).Count != 0)
                    throw new InvalidOperationException("A previous Word share has no pinned ownership token. No existing share will be adopted or removed.");
                ClearCleanupBarrier();
                return;
            }
            if (owned == null && !Discover(CancellationToken.None)) { ClearCleanupBarrier(); return; }
            List<IDictionary<string, object>> rows = Records("--share-token", owned.Token, CancellationToken.None).Where(row => Text(row, "shareToken") == owned.Token).ToList();
            if (rows.Count > 1 || (rows.Count == 1 && !owned.Same(Identity(rows[0]))))
                throw new InvalidOperationException("Word share cleanup ownership changed. No replacement share was removed.");
            if (rows.Count == 1)
            {
                try { commands.Run(new[] { "delete", "share", owned.Token, "--envzid", owned.Environment }, CancellationToken.None); }
                catch (InvalidOperationException) { }
                if (Records("--share-token", owned.Token, CancellationToken.None).Any(row => Text(row, "shareToken") == owned.Token))
                    throw new InvalidOperationException("The Word share cleanup could not be confirmed.");
            }
            ClearCleanupBarrier();
        }

        private void PersistCleanupBarrier()
        {
            profile.WriteCleanupBarrier(McpEndpoint.Json().Serialize(new { version = 1, target = preparedTarget,
                environment = preparedEnvironment, token = owned == null ? null : owned.Token, origin = owned == null ? null : owned.Origin }));
        }

        private void ClearCleanupBarrier()
        {
            profile.ClearCleanupBarrier();
            owned = null; preparedTarget = null; preparedEnvironment = null; recovered = false;
        }

        private void RestoreCleanupBarrier()
        {
            string saved = profile.ReadCleanupBarrier();
            if (saved == null) return;
            IDictionary<string, object> value = McpEndpoint.Json().DeserializeObject(saved) as IDictionary<string, object>;
            Uri target;
            if (value == null || value.Count != 5 || !value.ContainsKey("version") || !Object.Equals(value["version"], 1) ||
                !value.ContainsKey("target") || !value.ContainsKey("environment") || !value.ContainsKey("token") || !value.ContainsKey("origin") ||
                !Uri.TryCreate(Text(value, "target"), UriKind.Absolute, out target) || target.Scheme != "http" || target.Host != "127.0.0.1" ||
                target.UserInfo.Length != 0 || target.Query.Length != 0 || target.Fragment.Length != 0 || target.AbsolutePath != "/" ||
                target.GetLeftPart(UriPartial.Authority) != Text(value, "target") || !Identifier(Text(value, "environment")))
                throw new InvalidOperationException("Word share cleanup state is invalid. Existing ownership was preserved.");
            preparedTarget = Text(value, "target");
            preparedEnvironment = Text(value, "environment");
            string token = Text(value, "token");
            if (value["token"] != null)
            {
                string origin = ConnectionProfile.ValidateHttpsOrigin(Text(value, "origin"));
                if (!Identifier(token) || !new Uri(origin).Host.StartsWith(profile.Reservation + ".", StringComparison.OrdinalIgnoreCase) ||
                    (profile.PublicOrigin.Length != 0 && profile.PublicOrigin != origin))
                    throw new InvalidOperationException("Word share cleanup ownership is invalid. Existing state was preserved.");
                owned = new OwnedShare { Token = token, Environment = preparedEnvironment, Target = preparedTarget, Origin = origin };
            }
            else if (value["origin"] != null) throw new InvalidOperationException("Word share cleanup state is inconsistent. Existing state was preserved.");
            recovered = true;
            phase = "cleanup_required";
            error = "A previous Word share needs exact ownership cleanup. Press Stop before reconnecting.";
        }

        private static bool Identifier(string value)
        { return value != null && System.Text.RegularExpressions.Regex.IsMatch(value, @"\A[A-Za-z0-9_.-]{1,128}\z"); }

        internal void FillStatus(ConnectionStatus status)
        {
            lock (gate)
            {
                status.Configured = profile.Configured;
                status.EnrollmentRequired = !profile.HasEnrollment;
                status.Phase = phase;
                status.Error = error;
                status.Reservation = profile.Reservation;
                status.TunnelRunning = phase == "running" && child != null && !child.HasExited && !cancellation.IsCancellationRequested;
                status.CleanupPending = preparedTarget != null && phase != "running";
                status.Busy = worker != null && worker.IsAlive && phase != "running";
                status.PublicOrigin = status.TunnelRunning ? profile.PublicOrigin : "";
            }
        }

        private void RequireIdle()
        {
            if (disposed) throw new ObjectDisposedException("Word connection");
            if (worker != null && worker.IsAlive) throw new InvalidOperationException("The Word connection is busy. Wait for its current operation or stop it first.");
        }

        private static string Text(IDictionary<string, object> row, string key)
        { object value; return row.TryGetValue(key, out value) ? value as string : null; }

        private sealed class OwnedShare
        {
            internal string Token, Environment, Target, Origin;
            internal bool Same(OwnedShare other)
            { return Token == other.Token && Environment == other.Environment && Target == other.Target && Origin == other.Origin; }
        }

        public void Dispose()
        {
            Thread current;
            lock (gate) { if (disposed) return; cancellation.Cancel(); disposed = true; allowHost(null); current = worker; }
            try
            {
                TunnelProcess.Kill(child);
                if (current != null && current != Thread.CurrentThread && !current.Join(3000))
                {
                    lock (gate)
                    {
                        phase = preparedTarget == null ? "stopped" : "cleanup_required";
                        error = "Word connection shutdown reached its time limit. Pending share ownership is preserved for exact cleanup on the next start.";
                    }
                }
            }
            finally { commands.Dispose(); }
        }
    }
}
