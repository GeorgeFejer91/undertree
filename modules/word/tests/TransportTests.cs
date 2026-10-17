using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using UnderTree.WordAddin;

internal static class TransportTests
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16777216 };
    private static int checks;
    private static int dispatches;
    private static int revoked;
    private static int actorThread;
    private static string expectedTool;
    private static bool failDispatch;
    private static readonly BlockingCollection<Action> Queue = new BlockingCollection<Action>();

    public static int Main(string[] arguments)
    {
        string root = Path.GetFullPath(arguments[0]);
        string fake = Path.GetFullPath(arguments[1]);
        Environment.SetEnvironmentVariable("ZROK2_API_ENDPOINT", "https://foreign-enrollment.example");
        Environment.SetEnvironmentVariable("ZROK2_UNKNOWN_OVERRIDE", "foreign-profile");
        Thread actor = new Thread(delegate() { actorThread = Thread.CurrentThread.ManagedThreadId; foreach (Action action in Queue.GetConsumingEnumerable()) action(); });
        actor.SetApartmentState(ApartmentState.STA); actor.IsBackground = true; actor.Start();
        try
        {
            LocalEndpoint(Path.Combine(root, "local"), fake);
            TunnelLifecycle(Path.Combine(root, "tunnel"), fake);
            ForeignSharePreserved(Path.Combine(root, "foreign"), fake);
            ChildDeath(Path.Combine(root, "death"), fake);
            FailedCleanupRetry(Path.Combine(root, "cleanup"), fake);
            InvalidStatePreserved(Path.Combine(root, "invalid"), fake);
            QueuedRevocation(Path.Combine(root, "queued"), fake);
            FailedRevocation(Path.Combine(root, "revoke"), fake);
            StaShutdown(Path.Combine(root, "sta-shutdown"), fake);
            InterruptedCleanupRecovery(Path.Combine(root, "shutdown-recovery"), fake);
            PendingWorkerRevocation(Path.Combine(root, "worker-revoke"), fake);
            DisposeRevocationFailure(Path.Combine(root, "dispose-failure"), fake);
            LegalEscapedPayloads(Path.Combine(root, "escaped-payloads"), fake);
            Console.WriteLine("PASS: " + checks + " transport assertions; actual loopback HTTP, isolated filesystem and fake zrok subprocess only.");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        finally { Queue.CompleteAdding(); actor.Join(1000); }
    }

    private static object Marshal(Func<object> callback)
    {
        object result = null; Exception failure = null;
        using (ManualResetEvent finished = new ManualResetEvent(false))
        {
            Queue.Add(delegate { try { result = callback(); } catch (Exception error) { failure = error; } finally { finished.Set(); } });
            if (!finished.WaitOne(10000)) throw new TimeoutException("Test Word actor stalled.");
        }
        if (failure != null) throw failure;
        return result;
    }

    private static ConnectionService Create(string directory, string fake)
    {
        return new ConnectionService(delegate(string name, IDictionary<string, object> values)
        {
            Assert(Thread.CurrentThread.ManagedThreadId == actorThread, "Review dispatch executes on Word STA.");
            dispatches++;
            expectedTool = name;
            if (failDispatch) throw new InvalidOperationException("SECRET C:\\private\\manuscript.docx");
            return new { manuscripts = new object[0], supplied = values.ContainsKey("quote") ? values["quote"] : null };
        }, delegate { Interlocked.Increment(ref revoked); }, Marshal, directory, fake);
    }

    private static void LocalEndpoint(string directory, string fake)
    {
        using (ConnectionService service = Create(directory, fake))
        {
            Assert(!service.Status.LocalRunning && !service.Status.Configured && service.Status.EnrollmentRequired, "Construction restores no listener, tunnel or enrollment.");
            service.StartLocal();
            string address = service.LocalAddress;
            Assert(address.StartsWith("http://127.0.0.1:") && new Uri(address).AbsolutePath.StartsWith("/t/"), "Private listener has random capability path.");
            string initialized = Post(address, "initialize", new { protocolVersion = "2025-06-18" });
            Assert(initialized.Contains("wrAIter Word") && initialized.Contains("2025-06-18") && initialized.Contains("context_id"), "Initialize identifies Word, protocol and complete-read requirement.");
            IDictionary<string, object> catalogue = Result(Post(address, "tools/list", new { }));
            object[] tools = (object[])catalogue["tools"];
            Assert(tools.Length == 4 && ((Dictionary<string, object>)tools[2])["name"].Equals("suggest_text") &&
                ((Dictionary<string, object>)tools[3])["name"].Equals("highlight_text"), "Catalogue has exactly four closed Review tools.");
            string reply = Post(address, "tools/call", new { name = "list_manuscripts", arguments = new { } });
            Assert(reply.Contains("\"manuscripts\":[]") && expectedTool == "list_manuscripts", "Real HTTP response carries native structured results.");
            int before = dispatches;
            string colorOnly = Post(address, "tools/call", new { name = "highlight_text", arguments = new { documentId = "a", marking = new {
                requestId = "mark", revision = "r", contextId = "c", ranges = new[] { new { from = 0, to = 4, quote = "word" } } } } });
            Assert(colorOnly.Contains("isError\":false") && expectedTool == "highlight_text" && dispatches == before + 1, "Only explicit color-only tool reaches native STA authority.");
            before = dispatches;
            foreach (object payload in new object[] {
                new { documentId = "a", action = "prompt", marking = new { requestId = "mark", revision = "r", contextId = "c", ranges = new[] { new { from = 0, to = 4, quote = "word" } } } },
                new { documentId = "a", marking = new { requestId = "mark", revision = "r", contextId = "c", accessMode = "direct", ranges = new[] { new { from = 0, to = 4, quote = "word" } } } },
                new { documentId = "a", marking = new { requestId = "mark", revision = "r", contextId = "c", ranges = new[] { new { from = 0, to = 4, quote = "word", prompt = "edit" } } } }
            }) Assert(Object.Equals(Result(Post(address, "tools/call", new { name = "highlight_text", arguments = payload }))["isError"], true), "Policy injection returns a tool denial at the closed HTTP boundary.");
            Assert(dispatches == before, "Policy fields cannot reach native Word dispatch.");
            string afterPolicyDenial = Post(address, "tools/call", new { name = "read_manuscript", arguments = new { manuscript_id = "a" } });
            Assert(Object.Equals(Result(afterPolicyDenial)["isError"], false) && expectedTool == "read_manuscript" && dispatches == before + 1,
                "A bad tool payload leaves the healthy connection usable for the next valid context read.");
            before = dispatches;
            Assert(Post(address, "tools/call", new { name = "save_document", arguments = new { } }).Contains("Unknown tool"), "Unknown tools denied.");
            Assert(dispatches == before, "Unknown tool cannot reach native authority.");
            int status;
            Post(address, "tools/call", new { name = "suggest_text", arguments = new { } }, out status, null, null, true);
            Assert(status == 202 && dispatches == before, "Notifications never invoke document tools.");
            Post(address, "ping", new { }, out status, "https://malicious.example", null, false);
            Assert(status == 403, "Browser Origin denied.");
            Assert(RawStatus(address, "Host: attacker.example\r\nContent-Type: application/json\r\nContent-Length: 2\r\n", "{}") == 403, "Forged proxy Host denied.");
            Assert(RawStatus(address, "Host: " + new Uri(address).Authority + "\r\nHost: evil.test\r\nContent-Type: application/json\r\nContent-Length: 2\r\n", "{}") == 400, "Ambiguous duplicate headers denied.");
            Assert(RawStatus(address, "Host: " + new Uri(address).Authority + "\r\nContent-Type: application/json\r\nContent-Length: 1048577\r\n", "") == 413, "Requests above the one-MiB encoded contract bound are rejected before reading body.");
            Assert(RawStatus(address, "Host: " + new Uri(address).Authority + "\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n", "{}") == 415, "Non-JSON media type denied.");
            Assert(RawStatus(address, "Host: " + new Uri(address).Authority + "\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nContent-Length: 2\r\n", "{}") == 415, "Ambiguous transfer encoding denied.");
            string ping = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}";
            Assert(RawStatus(address, "Host: " + new Uri(address).Authority + "\r\nAccept: application/json\r\nAccept: text/event-stream\r\nContent-Type: application/json\r\nContent-Length: " + ping.Length + "\r\n", ping) == 200, "Repeated Accept headers remain supported.");
            Post(address + "x", "ping", new { }, out status, null, null, false);
            Assert(status == 403, "Wrong capability denied.");
            Post(address, "ping", new { }, out status, null, "2099-01-01", false);
            Assert(status == 400, "Unsupported explicit MCP version denied.");
            failDispatch = true;
            string denied = Post(address, "tools/call", new { name = "read_manuscript", arguments = new { manuscript_id = "a" } });
            failDispatch = false;
            Assert(denied.Contains("isError\":true") && !denied.Contains("SECRET") && !denied.Contains("manuscript.docx"), "Unexpected native errors do not disclose private text or paths.");
            bool locked = false;
            try { using (ConnectionService duplicate = Create(directory, fake)) { } }
            catch (InvalidOperationException) { locked = true; }
            Assert(locked, "One Word process exclusively owns its private profile.");
            int previousRevoked = revoked;
            service.Stop();
            Assert(!service.Status.LocalRunning && service.LocalAddress == "" && revoked == previousRevoked + 1, "Stop immediately clears listener and native grants.");
            service.StartLocal();
            Assert(new Uri(service.LocalAddress).AbsolutePath != new Uri(address).AbsolutePath, "Restart rotates bearer capability.");
            Assert(!service.Status.ExternallyVerified, "Local success never claims public verification.");
        }
        using (ConnectionService restart = Create(directory, fake))
            Assert(!restart.Status.LocalRunning && !restart.Status.TunnelRunning, "New Word session never restores transport or document sharing.");
        string config = File.ReadAllText(Path.Combine(directory, "connection.json"));
        Assert(!config.Contains("/t/") && !config.Contains("token"), "Persisted public setup contains no bearer capability or raw enrollment token.");
    }

    private static void TunnelLifecycle(string directory, string fake)
    {
        string home = Path.Combine(directory, "connection-home");
        using (ConnectionService service = Create(directory, fake))
        {
            service.Configure("fake-enrollment-token");
            Wait(delegate { return service.Status.Phase != "configuring" && !service.Status.Busy; }, "Fake enrollment completes.");
            Assert(service.Status.Configured && !service.Status.EnrollmentRequired, "Dedicated enrollment and assigned reservation confirmed.");
            string reservation = service.Status.Reservation;
            Assert(!File.ReadAllText(Path.Combine(directory, "connection.json")).Contains("fake-enrollment-token"), "Account enrollment token absent from application configuration.");
            service.Start();
            Wait(delegate { return service.Status.TunnelRunning || service.Status.Phase == "failed"; }, "Owned fake tunnel starts.");
            Assert(service.Status.TunnelRunning && service.PublicAddress.StartsWith("https://" + reservation + ".example.test/t/"), "Public address comes from exact controller frontend, retaining capability.");
            Assert(Post(service.LocalAddress, "ping", new { }).Contains("\"result\":{}"), "Private MCP remains available while tunnel runs.");
            service.Stop();
            Assert(!service.Status.LocalRunning && service.PublicAddress == "", "Stop conceals public address immediately.");
            Wait(delegate { return !service.Status.Busy && (service.Status.Phase == "stopped" || service.Status.Phase == "cleanup_required"); }, "Owned share cleanup finishes.");
            Assert(service.Status.Phase == "stopped" && File.ReadAllText(Path.Combine(home, "fake-shares.json")) == "[]", "Stop removes only exact owned share and independently verifies absence.");
            service.Start();
            Wait(delegate { return service.Status.TunnelRunning || service.Status.Phase == "failed"; }, "Reserved-name reconnect completes.");
            Assert(service.Status.TunnelRunning && service.Status.Reservation == reservation, "Reconnect reuses assigned reservation.");
            service.Stop();
            Wait(delegate { return service.Status.Phase == "stopped" && !service.Status.Busy; }, "Second share cleanup finishes.");
            Assert(File.ReadAllLines(Path.Combine(home, "commands.jsonl")).Count(line => line.StartsWith("[\"create\",\"name\"")) == 1, "Retries and reconnect never allocate another persistent name.");
            Assert(!File.ReadAllText(Path.Combine(home, "commands.jsonl")).Contains("fake-enrollment-token"), "Fake command evidence redacts enrollment credential.");
        }
    }

    private static void ForeignSharePreserved(string directory, string fake)
    {
        using (ConnectionService service = Create(directory, fake))
        {
            service.Configure("fake-enrollment-token");
            Wait(delegate { return service.Status.Configured && !service.Status.Busy; }, "Second independent fake enrollment completes.");
            string home = Path.Combine(directory, "connection-home");
            File.WriteAllText(Path.Combine(home, "scenario"), "foreign-owner");
            service.Start();
            Wait(delegate { return service.Status.Phase == "cleanup_required" && !service.Status.Busy; }, "Foreign share causes honest cleanup-required state.");
            Assert(!service.Status.LocalRunning && !service.Status.TunnelRunning && service.Status.CleanupPending, "Ownership mismatch revokes access and blocks reconnect.");
            Assert(File.ReadAllText(Path.Combine(home, "fake-shares.json")).Contains("foreign-environment"), "Foreign share preserved.");
            Assert(!File.ReadAllLines(Path.Combine(home, "commands.jsonl")).Any(line => line.StartsWith("[\"delete\"")), "Foreign identity never receives delete command.");
            bool rejected = false;
            try { service.Start(); } catch (InvalidOperationException) { rejected = true; }
            Assert(rejected, "Cleanup-required state refuses reconnect.");
            Assert(!service.Status.LocalRunning, "Blocked reconnect cannot leave a fresh local listener behind.");
        }
    }

    private static void ChildDeath(string directory, string fake)
    {
        using (ConnectionService service = Create(directory, fake))
        {
            service.Configure("fake-enrollment-token");
            Wait(delegate { return service.Status.Configured && !service.Status.Busy; }, "Death-case enrollment completes.");
            string home = Path.Combine(directory, "connection-home");
            File.WriteAllText(Path.Combine(home, "scenario"), "die");
            int previousRevoked = revoked;
            service.Start();
            Wait(delegate { return service.Status.Phase == "failed" && !service.Status.Busy; }, "Exited fake tunnel is observed and cleaned.");
            Assert(!service.Status.LocalRunning && !service.Status.TunnelRunning && revoked > previousRevoked, "Unexpected child death revokes both transport and native sharing.");
            Assert(File.ReadAllText(Path.Combine(home, "fake-shares.json")) == "[]", "Child-death rollback retires its exact controller share.");
        }
    }

    private static void FailedCleanupRetry(string directory, string fake)
    {
        using (ConnectionService service = Create(directory, fake))
        {
            service.Configure("fake-enrollment-token");
            Wait(delegate { return service.Status.Configured && !service.Status.Busy; }, "Cleanup-case enrollment completes.");
            service.Start();
            Wait(delegate { return service.Status.TunnelRunning; }, "Cleanup-case fake tunnel starts.");
            string home = Path.Combine(directory, "connection-home");
            File.WriteAllText(Path.Combine(home, "scenario"), "cleanup-fail");
            service.Stop();
            Wait(delegate { return service.Status.Phase == "cleanup_required" && !service.Status.Busy; }, "Unconfirmed delete is reported.");
            Assert(!service.Status.LocalRunning && service.Status.CleanupPending && service.PublicAddress == "", "Cleanup failure keeps ownership privately and exposes no capability.");
            File.Delete(Path.Combine(home, "scenario"));
            service.Stop();
            Wait(delegate { return service.Status.Phase == "stopped" && !service.Status.Busy; }, "Explicit Stop retries exact-share cleanup.");
            Assert(!service.Status.CleanupPending && File.ReadAllText(Path.Combine(home, "fake-shares.json")) == "[]", "Explicit cleanup retry clears pinned ownership only after verified absence.");
        }
    }

    private static void InvalidStatePreserved(string directory, string fake)
    {
        using (ConnectionService service = Create(directory, fake)) { }
        string path = Path.Combine(directory, "connection.json");
        const string invalid = "{\"version\":99,\"private-existing-value\":\"preserve\"}";
        File.WriteAllText(path, invalid);
        bool rejected = false;
        try { using (ConnectionService service = Create(directory, fake)) { } }
        catch (InvalidOperationException) { rejected = true; }
        Assert(rejected && File.ReadAllText(path) == invalid, "Corrupt or unknown persisted setup is refused and preserved byte-for-byte.");
    }

    private static void QueuedRevocation(string directory, string fake)
    {
        using (ManualResetEvent queued = new ManualResetEvent(false))
        using (ManualResetEvent release = new ManualResetEvent(false))
        {
            int executed = 0;
            using (ConnectionService service = new ConnectionService(delegate(string name, IDictionary<string, object> values) { executed++; return new { }; },
                delegate { }, delegate(Func<object> callback) { queued.Set(); if (!release.WaitOne(10000)) throw new TimeoutException(); return Marshal(callback); }, directory, fake))
            {
                service.StartLocal();
                string address = service.LocalAddress;
                Exception failure = null;
                Thread request = new Thread(delegate()
                {
                    try { Post(address, "tools/call", new { name = "suggest_text", arguments = new { } }); }
                    catch (Exception error) { failure = error; }
                });
                request.Start();
                Assert(queued.WaitOne(5000), "Remote request reaches pending Word marshal queue.");
                service.Stop();
                release.Set();
                Assert(request.Join(5000) && failure == null && executed == 0, "Stop cancels already queued remote work before native authority executes.");
            }
        }
    }

    private static void FailedRevocation(string directory, string fake)
    {
        bool fail = true;
        using (ConnectionService service = new ConnectionService(delegate(string name, IDictionary<string, object> values) { return new { }; },
            delegate { if (fail) throw new InvalidOperationException("Synthetic revocation failure"); }, Marshal, directory, fake))
        {
            service.StartLocal();
            bool failed = false;
            try { service.Stop(); } catch (InvalidOperationException) { failed = true; }
            Assert(failed && service.Status.Phase == "revocation_required" && !service.Status.LocalRunning, "Failed native revocation closes listener and reports unresolved authority.");
            bool blocked = false;
            try { service.StartLocal(); } catch (InvalidOperationException) { blocked = true; }
            Assert(blocked && !service.Status.LocalRunning, "Unresolved document revocation blocks fresh bearer capabilities.");
            fail = false;
            service.Stop(); service.StartLocal();
            Assert(service.Status.LocalRunning, "Explicit successful revoke permits a fresh local connection.");
        }
    }

    private static void StaShutdown(string directory, string fake)
    {
        ConnectionService service = Create(directory, fake);
        try
        {
            service.Configure("fake-enrollment-token");
            Wait(delegate { return service.Status.Configured && !service.Status.Busy; }, "STA-shutdown enrollment completes.");
            service.Start();
            Wait(delegate { return service.Status.TunnelRunning; }, "STA-shutdown tunnel starts.");
            Marshal(delegate { service.Dispose(); return null; });
            string home = Path.Combine(directory, "connection-home");
            Assert(File.ReadAllText(Path.Combine(home, "fake-shares.json")) == "[]", "Disposal on the Word STA completes exact cleanup without waiting for its own blocked marshal queue.");
            Assert(!File.Exists(Path.Combine(directory, "share-cleanup.bin")), "Successful STA shutdown leaves no false persistent cleanup barrier.");
        }
        finally { service.Dispose(); }
    }

    private static void InterruptedCleanupRecovery(string directory, string fake)
    {
        ConnectionService service = Create(directory, fake);
        string home = Path.Combine(directory, "connection-home");
        try
        {
            service.Configure("fake-enrollment-token");
            Wait(delegate { return service.Status.Configured && !service.Status.Busy; }, "Interrupted-cleanup enrollment completes.");
            service.Start();
            Wait(delegate { return service.Status.TunnelRunning; }, "Interrupted-cleanup tunnel starts.");
            string barrier = Path.Combine(directory, "share-cleanup.bin");
            Assert(File.Exists(barrier) && !Encoding.UTF8.GetString(File.ReadAllBytes(barrier)).Contains("fake-word-share"), "Exact ownership is durably protected with per-user encryption before a running share is exposed.");
            File.WriteAllText(Path.Combine(home, "scenario"), "slow-cleanup");
            Stopwatch shutdown = Stopwatch.StartNew();
            Marshal(delegate { service.Dispose(); return null; });
            Assert(shutdown.ElapsedMilliseconds < 6000 && File.Exists(barrier), "Slow controller cleanup cannot hang Word; encrypted ownership barrier survives bounded shutdown.");
            File.Delete(Path.Combine(home, "scenario"));
            using (ConnectionService restart = Create(directory, fake))
            {
                Assert(restart.Status.CleanupPending && restart.Status.Phase == "cleanup_required" && !restart.Status.LocalRunning, "New Word session restores cleanup barrier without exposing transport or shares.");
                bool blocked = false;
                try { restart.Start(); } catch (InvalidOperationException) { blocked = true; }
                Assert(blocked && !restart.Status.LocalRunning, "Persisted cleanup uncertainty blocks all fresh tunnel capabilities.");
                restart.Stop();
                Wait(delegate { return restart.Status.Phase == "stopped" && !restart.Status.Busy; }, "Restart Stop independently retires exactly pinned share.");
                Assert(!File.Exists(barrier) && File.ReadAllText(Path.Combine(home, "fake-shares.json")) == "[]", "Restart clears barrier only after exact token, environment, target and frontend revalidation plus verified absence.");
            }
        }
        finally { service.Dispose(); }
    }

    private static void PendingWorkerRevocation(string directory, string fake)
    {
        using (ManualResetEvent queued = new ManualResetEvent(false))
        using (ManualResetEvent release = new ManualResetEvent(false))
        using (ManualResetEvent finished = new ManualResetEvent(false))
        {
            int nativeRevokes = 0;
            using (ConnectionService service = new ConnectionService(delegate(string name, IDictionary<string, object> values) { return new { }; },
                delegate { nativeRevokes++; }, delegate(Func<object> callback)
                {
                    queued.Set();
                    try { if (!release.WaitOne(10000)) throw new TimeoutException(); return Marshal(callback); }
                    finally { finished.Set(); }
                }, directory, fake))
            {
                service.Configure("fake-enrollment-token");
                Wait(delegate { return service.Status.Configured && !service.Status.Busy; }, "Worker-revoke enrollment completes.");
                File.WriteAllText(Path.Combine(directory, "connection-home", "scenario"), "die");
                service.Start();
                Assert(queued.WaitOne(5000), "Background failure queues native revocation.");
                Wait(delegate { return !service.Status.Busy; }, "Controller cleanup proceeds while the Word STA is unavailable.");
                bool blocked = false;
                try { service.StartLocal(); } catch (InvalidOperationException) { blocked = true; }
                Assert(blocked && !service.Status.LocalRunning && service.Status.Phase == "revocation_required", "Pending STA revoke blocks fresh capability even after controller cleanup completed.");
                service.Stop();
                service.StartLocal();
                int settledRevokes = nativeRevokes;
                release.Set();
                Assert(finished.WaitOne(5000) && nativeRevokes == settledRevokes && service.Status.LocalRunning, "A stale queued revoke cannot revoke a fresh session after explicit Stop resolved it.");
            }
        }
    }

    private static void DisposeRevocationFailure(string directory, string fake)
    {
        ConnectionService service = new ConnectionService(delegate(string name, IDictionary<string, object> values) { return new { }; },
            delegate { throw new InvalidOperationException("Synthetic shutdown revoke failure"); }, Marshal, directory, fake);
        service.StartLocal();
        service.Dispose();
        Assert(service.LocalAddress == "" && service.Status.Phase == "shutdown_unverified" && service.Status.Error.Length != 0,
            "Native revoke failure cannot throw into Word shutdown or leave an exposed listener; unresolved shutdown remains visible in status.");
        service.Dispose();
    }

    private static void LegalEscapedPayloads(string directory, string fake)
    {
        string prompt = new string('\\', 4000);
        object[] highlights = Enumerable.Range(0, 500).Select(index => (object)new {
            id = "Wrai_" + index, ruleId = "shorten", from = 0, to = 1, prompt = prompt, stale = false }).ToArray();
        object context = new { manuscript_id = "payload-test", revision = new string('a', 64), text = "a", from = 0, to = 1,
            total = 1, complete = true, context_id = new string('b', 32), highlights = highlights };
        Assert(Encoding.UTF8.GetByteCount(Json.Serialize(context)) < 4194304, "Legal compact context metadata fits the admitted four-MiB persisted aggregate.");
        bool oversizedResponse = false;
        string nativeQuote = null, nativeReplacement = null;
        using (ConnectionService service = new ConnectionService(delegate(string name, IDictionary<string, object> values)
        {
            Assert(Thread.CurrentThread.ManagedThreadId == actorThread, "Large encoded requests retain Word STA dispatch.");
            if (name == "read_manuscript") return oversizedResponse ? (object)new { text = new string('x', 8388609) } : context;
            nativeQuote = (string)values["quote"]; nativeReplacement = (string)values["replacement"];
            return new { request_id = values["request_id"], status = "pending" };
        }, delegate { }, Marshal, directory, fake))
        {
            service.StartLocal();
            string response = Post(service.LocalAddress, "tools/call", new { name = "read_manuscript", arguments = new { manuscript_id = "payload-test" } });
            int encoded = Encoding.UTF8.GetByteCount(response);
            Assert(encoded > 4194304 && encoded <= 16777216, "Escaped duplicated MCP context exceeds the old cap and fits the explicit sixteen-MiB response bound.");
            IDictionary<string, object> result = Result(response);
            IDictionary<string, object> structured = (IDictionary<string, object>)result["structuredContent"];
            object[] returned = (object[])structured["highlights"];
            Assert(returned.Length == 500 && returned.All(mark => Object.Equals(((IDictionary<string, object>)mark)["prompt"], prompt)), "All 500 legal escaped prompts arrive intact in structured content.");
            object[] content = (object[])result["content"];
            IDictionary<string, object> textResult = (IDictionary<string, object>)Json.DeserializeObject((string)((IDictionary<string, object>)content[0])["text"]);
            Assert(((object[])textResult["highlights"]).Length == 500 && Object.Equals(textResult["context_id"], new string('b', 32)), "MCP text content contains the same complete metadata and context witness.");
            string quote = new string('"', 32768), replacement = new string('\\', 32768);
            object proposal = new { name = "suggest_text", arguments = new { manuscript_id = "payload-test", revision = new string('a', 64),
                context_id = new string('b', 32), from = 0, to = 32768, quote = quote, replacement = replacement, request_id = "escaped-pair" } };
            int requestBytes = Encoding.UTF8.GetByteCount(Json.Serialize(new { jsonrpc = "2.0", id = 1, method = "tools/call", @params = proposal }));
            Assert(requestBytes > 131072 && requestBytes <= 1048576, "Legal maximum UTF-16 quote and replacement require more than the old encoded request cap.");
            IDictionary<string, object> submitted = Result(Post(service.LocalAddress, "tools/call", proposal));
            IDictionary<string, object> recorded = (IDictionary<string, object>)submitted["structuredContent"];
            Assert(nativeQuote == quote && nativeReplacement == replacement && Object.Equals(recorded["status"], "pending"), "Maximum escaped quote and replacement reach native authority unchanged and remain a pending suggestion.");
            oversizedResponse = true;
            int status;
            string rejected = Post(service.LocalAddress, "tools/call", new { name = "read_manuscript", arguments = new { manuscript_id = "payload-test" } }, out status, null, null, false);
            Assert(status == 413 && rejected.Length == 0, "Responses above the sixteen-MiB encoded contract bound remain rejected without a misleading partial result.");
        }
    }

    private static string Post(string url, string method, object parameters)
    { int status; string response = Post(url, method, parameters, out status, null, null, false); Assert(status == 200, "MCP request returns valid HTTP response."); return response; }

    private static string Post(string url, string method, object parameters, out int status, string origin, string version, bool notification)
    {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
        request.Proxy = null; request.Method = "POST"; request.ContentType = "application/json"; request.Timeout = 10000;
        if (origin != null) request.Headers["Origin"] = origin;
        if (version != null) request.Headers["MCP-Protocol-Version"] = version;
        object message = notification ? (object)new { jsonrpc = "2.0", method = method, @params = parameters } : new { jsonrpc = "2.0", id = 1, method = method, @params = parameters };
        byte[] body = Encoding.UTF8.GetBytes(Json.Serialize(message));
        request.ContentLength = body.Length;
        using (Stream stream = request.GetRequestStream()) stream.Write(body, 0, body.Length);
        HttpWebResponse response;
        try { response = (HttpWebResponse)request.GetResponse(); }
        catch (WebException error) { response = (HttpWebResponse)error.Response; if (response == null) throw; }
        using (response)
        using (StreamReader source = new StreamReader(response.GetResponseStream())) { status = (int)response.StatusCode; return source.ReadToEnd(); }
    }

    private static IDictionary<string, object> Result(string json)
    { return (IDictionary<string, object>)((IDictionary<string, object>)Json.DeserializeObject(json))["result"]; }

    private static int RawStatus(string url, string headers, string body)
    {
        Uri parsed = new Uri(url);
        using (TcpClient socket = new TcpClient())
        {
            socket.Connect(parsed.Host, parsed.Port); socket.ReceiveTimeout = 10000;
            using (NetworkStream stream = socket.GetStream())
            {
                byte[] request = Encoding.ASCII.GetBytes("POST " + parsed.AbsolutePath + " HTTP/1.1\r\n" + headers + "\r\n" + body);
                stream.Write(request, 0, request.Length);
                using (StreamReader source = new StreamReader(stream)) return Int32.Parse(source.ReadLine().Split(' ')[1]);
            }
        }
    }

    private static void Wait(Func<bool> condition, string label)
    {
        Stopwatch timeout = Stopwatch.StartNew();
        using (ManualResetEvent tick = new ManualResetEvent(false))
            while (!condition()) { if (timeout.ElapsedMilliseconds > 15000) throw new Exception("Timeout: " + label); tick.WaitOne(30); }
    }

    private static void Assert(bool condition, string label)
    { if (!condition) throw new Exception("FAILED: " + label); Interlocked.Increment(ref checks); }
}
