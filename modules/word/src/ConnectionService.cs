using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Threading;

namespace UnderTree.WordAddin
{
    public sealed class ConnectionStatus
    {
        public bool LocalRunning { get; internal set; }
        public bool TunnelRunning { get; internal set; }
        public bool Configured { get; internal set; }
        public bool EnrollmentRequired { get; internal set; }
        public bool CleanupPending { get; internal set; }
        public bool Busy { get; internal set; }
        public string Phase { get; internal set; }
        public string Error { get; internal set; }
        public string Reservation { get; internal set; }
        public string PublicAddress { get; internal set; }
        public string LocalAddress { get; internal set; }
        public string PublicOrigin { get; internal set; }
        public bool ExternallyVerified { get { return false; } }
    }

    public sealed class ConnectionService : IDisposable
    {
        private readonly object gate = new object();
        private readonly Func<string, IDictionary<string, object>, object> reviewDispatch;
        private readonly Action revokeDocuments;
        private readonly Func<Func<object>, object> marshal;
        private readonly ConnectionProfile profile;
        private readonly TunnelSupervisor tunnel;
        private McpEndpoint endpoint;
        private bool disposed;
        private bool revocationPending;
        private long revocationGeneration;
        private string shutdownError = "";

        public ConnectionService(Func<string, IDictionary<string, object>, object> reviewDispatch,
            Action revokeDocuments, Func<Func<object>, object> marshalToWord)
            : this(reviewDispatch, revokeDocuments, marshalToWord,
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "wrAIterWord"),
                Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), "runtime", "zrok.exe")) { }

        internal ConnectionService(Func<string, IDictionary<string, object>, object> reviewDispatch,
            Action revokeDocuments, Func<Func<object>, object> marshalToWord, string profileDirectory, string zrokExecutable)
        {
            if (reviewDispatch == null || revokeDocuments == null || marshalToWord == null) throw new ArgumentNullException("Word connection callbacks");
            this.reviewDispatch = reviewDispatch; this.revokeDocuments = revokeDocuments; marshal = marshalToWord;
            profile = new ConnectionProfile(profileDirectory);
            try { tunnel = new TunnelSupervisor(profile, zrokExecutable, RevokeFromWorker, SetPublicHost); }
            catch { profile.Dispose(); throw; }
        }

        public string LocalAddress { get { lock (gate) return endpoint != null && endpoint.Active ? endpoint.LocalAddress : ""; } }
        public string PublicAddress { get { return Status.PublicAddress; } }

        public ConnectionStatus Status
        {
            get
            {
                ConnectionStatus status = new ConnectionStatus();
                try { tunnel.FillStatus(status); }
                catch (Exception)
                {
                    lock (gate) if (!disposed) throw;
                    status.Error = "Word connection shutdown could not verify its private state. Inspect Connections before reconnecting.";
                    status.Phase = "shutdown_unverified";
                }
                lock (gate)
                {
                    status.LocalRunning = !disposed && endpoint != null && endpoint.Active;
                    status.LocalAddress = status.LocalRunning ? endpoint.LocalAddress : "";
                    status.PublicAddress = status.TunnelRunning && status.LocalRunning ? status.PublicOrigin + endpoint.Path : "";
                    if (revocationPending)
                    {
                        status.Phase = "revocation_required";
                        status.Error = "Word document access could not be fully revoked. Stop access again before reconnecting.";
                    }
                    if (shutdownError.Length != 0) { status.Phase = "shutdown_unverified"; status.Error = shutdownError; }
                    return status;
                }
            }
        }

        public void StartLocal()
        {
            ConnectionStatus current = Status;
            if (current.CleanupPending || current.Busy) throw new InvalidOperationException("Wait for Word connection cleanup before restarting access.");
            lock (gate)
            {
                RequireOpen();
                if (revocationPending) throw new InvalidOperationException("Stop Word access again before reconnecting; document revocation is pending.");
                if (endpoint != null && endpoint.Active) return;
                endpoint = new McpEndpoint(reviewDispatch, marshal, profile.OwnerId);
            }
        }

        public void Configure(string enrollmentToken, string apiEndpoint = "https://api-v2.zrok.io")
        {
            lock (gate) RequireOpen();
            tunnel.Configure(enrollmentToken, apiEndpoint);
        }

        public void Start()
        {
            lock (gate) RequireOpen();
            ConnectionStatus current = Status;
            if (!current.Configured) throw new InvalidOperationException("Configure this Word connection with your zrok account token first.");
            if (current.CleanupPending || current.Busy) throw new InvalidOperationException("Wait for Word connection cleanup before restarting access.");
            StartLocal();
            tunnel.Start(LocalAddress);
        }

        public void Stop()
        {
            lock (gate) RequireOpen();
            CloseEndpoint();
            try { RevokeOnCurrentThread(); }
            finally { tunnel.Stop(); }
        }

        private void RevokeFromWorker()
        {
            CloseEndpoint();
            long generation;
            lock (gate)
            {
                if (disposed) return;
                revocationPending = true;
                generation = ++revocationGeneration;
            }
            ThreadPool.QueueUserWorkItem(delegate
            {
                lock (gate) if (disposed || revocationGeneration != generation) return;
                try { marshal(delegate { lock (gate) if (disposed || revocationGeneration != generation) return null; RevokeOnCurrentThread(); return null; }); }
                catch (Exception) { }
            });
        }

        private void RevokeOnCurrentThread()
        {
            lock (gate) { revocationPending = true; revocationGeneration++; }
            revokeDocuments();
            lock (gate) revocationPending = false;
        }

        private void CloseEndpoint()
        {
            lock (gate)
            {
                if (endpoint != null) { endpoint.Dispose(); endpoint = null; }
            }
        }

        private void SetPublicHost(string host)
        { lock (gate) if (endpoint != null) endpoint.SetPublicHost(host); }

        private void RequireOpen() { if (disposed) throw new ObjectDisposedException("Word connection"); }

        public void Dispose()
        {
            lock (gate) { if (disposed) return; disposed = true; }
            try { CloseEndpoint(); RevokeOnCurrentThread(); }
            catch (Exception) { RecordShutdownFailure(); }
            try { tunnel.Dispose(); }
            catch (Exception) { RecordShutdownFailure(); }
            finally
            {
                try { profile.Dispose(); }
                catch (Exception) { RecordShutdownFailure(); }
            }
        }

        private void RecordShutdownFailure()
        { lock (gate) shutdownError = "Word connection shutdown could not verify every operation. Pending cleanup ownership was preserved; inspect Connections before reconnecting."; }
    }
}
