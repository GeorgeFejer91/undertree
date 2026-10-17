"""Separate project grants on the real Writer HTTP endpoint, without native document sharing."""
import json
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extension"))
from undertree_connection import ConnectionManager
from undertree_project import ProjectAccess
from undertree_github import GitHubAccess
from undertree_mcp import Endpoint, TOOLS
from undertree_tunnel import TunnelSupervisor


def rpc(endpoint, method, params=None):
    request = urllib.request.Request(endpoint.url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


class ProjectTransportTests(unittest.TestCase):
    def test_only_explicit_folder_tools_appear_and_revocation_removes_them(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project_root = root / "project"
            project_root.mkdir()
            (project_root / "source.txt").write_text("Exact source context", encoding="utf-8")
            manager = ConnectionManager(root / "profile")
            project = ProjectAccess(manager.directory)
            manager.set_project_access(project, None)
            session = type("Session", (), {"document_id": "unshared-document"})()
            def document_call(name, arguments):
                if name == "list_manuscripts": return {"manuscripts": []}
                raise ValueError("Document is not shared.")
            try:
                endpoint = manager.ensure(session, document_call)
                original = {tool["name"] for tool in TOOLS}
                catalogue = lambda: {tool["name"] for tool in rpc(endpoint, "tools/list")["result"]["tools"]}
                self.assertEqual(catalogue(), original)
                project.grant(str(project_root), "read")
                self.assertEqual(catalogue(), original | {"project_read_file", "project_list_directory"})
                self.assertEqual(TunnelSupervisor(manager)._broker().port, endpoint.server.server_port)
                result = rpc(endpoint, "tools/call", {"name": "project_read_file", "arguments": {"path": "source.txt"}})["result"]
                self.assertFalse(result["isError"])
                self.assertIn("Exact source context", json.dumps(result["structuredContent"]))
                denied = rpc(endpoint, "tools/call", {"name": "project_write_file", "arguments": {"path": "source.txt", "content": "forbidden", "expectedSha256": None}})
                self.assertTrue("error" in denied or denied["result"]["isError"])
                self.assertEqual((project_root / "source.txt").read_text(), "Exact source context")
                denied = rpc(endpoint, "tools/call", {"name": "read_manuscript", "arguments": {"documentId": session.document_id}})
                self.assertTrue(denied["result"]["isError"])
                project.revoke()
                self.assertEqual(catalogue(), original)
                denied = rpc(endpoint, "tools/call", {"name": "project_read_file", "arguments": {"path": "source.txt"}})
                self.assertIn("error", denied)
                project.grant(str(project_root), "read_write")
                self.assertEqual(TunnelSupervisor(manager)._broker().port, endpoint.server.server_port)
                manager.protect_document("native-writer-text", str(project_root / "source.txt"))
                write = {"path": "source.txt", "content": "forbidden", "expectedSha256": hashlib.sha256(b"Exact source context").hexdigest()}
                denied = rpc(endpoint, "tools/call", {"name": "project_write_file", "arguments": write})
                self.assertTrue(denied["result"]["isError"])
                self.assertEqual((project_root / "source.txt").read_text(), "Exact source context")
                manager.protect_document("native-writer-text", None)
                write["content"] = "Long emoji source " + "\U0001f333" * 50000
                written = rpc(endpoint, "tools/call", {"name": "project_write_file", "arguments": write})["result"]
                self.assertFalse(written["isError"])
                self.assertEqual((project_root / "source.txt").read_text(encoding="utf-8"), write["content"])
                github = GitHubAccess(manager.directory, project)
                github.configure("LOCAL_FIXTURE_TOKEN_1234567890", "fixture/project")
                manager.set_project_access(project, github)
                github.set_enabled(True)
                self.assertIn("github_sync", catalogue())
                self.assertEqual(TunnelSupervisor(manager)._broker().port, endpoint.server.server_port)
                manager.stop()
                self.assertFalse(project.state()["active"])
                self.assertFalse(github.state()["enabled"])
            finally:
                manager.close()

    def test_project_catalogue_cannot_register_other_tool_names_or_peer_aliases(self):
        endpoint = Endpoint(lambda *_: {})
        try:
            for name in ("run_shell", "save_document", "peer_untrusted", "read_manuscript"):
                endpoint.set_project_handlers(lambda: [{"name": name, "inputSchema": {"type": "object"}}], lambda *_: {})
                with self.assertRaises(ValueError): endpoint.project_catalogue()
        finally:
            endpoint.close()
            endpoint.wait_closed(2)


if __name__ == "__main__": unittest.main()
