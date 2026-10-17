using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Web.Script.Serialization;

internal static class FakeZrok
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly string Home = Environment.GetEnvironmentVariable("USERPROFILE");
    private static string SharePath { get { return Path.Combine(Home, "fake-shares.json"); } }

    public static int Main(string[] arguments)
    {
        try
        {
            if (Environment.GetEnvironmentVariable("HOME") != Home) return 12;
            foreach (string key in Environment.GetEnvironmentVariables().Keys)
                if (key.StartsWith("ZROK2_", StringComparison.OrdinalIgnoreCase) || key.StartsWith("ZROK_", StringComparison.OrdinalIgnoreCase)) return 13;
            string[] logged = arguments.Length > 0 && arguments[0] == "enable" ? new[] { "enable", "[redacted]" } : arguments;
            File.AppendAllText(Path.Combine(Home, "commands.jsonl"), Json.Serialize(logged) + "\n");
            string scenarioPath = Path.Combine(Home, "scenario");
            string scenario = File.Exists(scenarioPath) ? File.ReadAllText(scenarioPath) : "";
            if (arguments[0] == "config") return 0;
            if (arguments[0] == "enable")
            {
                Directory.CreateDirectory(Path.Combine(Home, ".zrok2"));
                File.WriteAllText(Path.Combine(Home, ".zrok2", "environment.json"), "{\"ziti_identity\":\"fake-word-environment\"}");
                return 0;
            }
            if (arguments[0] == "create")
            { File.WriteAllText(Path.Combine(Home, "name"), arguments[2]); return 0; }
            if (arguments[0] == "list" && arguments[1] == "names")
            {
                string path = Path.Combine(Home, "name");
                Console.WriteLine(File.Exists(path) ? Json.Serialize(new[] { new { name = File.ReadAllText(path), namespaceToken = "public", reserved = true, shareToken = (string)null } }) : "[]");
                return 0;
            }
            if (arguments[0] == "list" && arguments[1] == "shares")
            {
                if (scenario == "slow-cleanup" && arguments[3] == "--share-token") Thread.Sleep(12000);
                if (scenario == "bad-list") { Console.WriteLine("not json"); return 0; }
                Console.WriteLine(Json.Serialize(new { shares = Shares() }));
                return 0;
            }
            if (arguments[0] == "share")
            {
                string name = arguments[4].Substring("public:".Length);
                string target = arguments[2];
                object row = new { shareToken = "fake-word-share", envZId = scenario == "foreign-owner" ? "foreign-environment" : "fake-word-environment",
                    target = target, frontendEndpoints = new[] { "https://" + name + ".example.test" }, shareMode = "public", backendMode = "proxy" };
                File.WriteAllText(SharePath, Json.Serialize(new[] { row }));
                if (scenario == "die") return 7;
                while (true) Thread.Sleep(1000);
            }
            if (arguments[0] == "delete")
            {
                if (scenario == "cleanup-fail") return 8;
                object[] retained = Shares().Where(row => !Object.Equals(row["shareToken"], arguments[2]) || !Object.Equals(row["envZId"], arguments[4])).Cast<object>().ToArray();
                File.WriteAllText(SharePath, Json.Serialize(retained));
                return 0;
            }
            return 9;
        }
        catch { return 10; }
    }

    private static List<Dictionary<string, object>> Shares()
    {
        if (!File.Exists(SharePath)) return new List<Dictionary<string, object>>();
        IEnumerable rows = (IEnumerable)Json.DeserializeObject(File.ReadAllText(SharePath));
        return rows.Cast<Dictionary<string, object>>().ToList();
    }
}
