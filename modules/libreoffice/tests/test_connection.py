"""Real loopback/persistence checks; no UNO, desktop grants or zrok required."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

EXTENSION = Path(__file__).resolve().parents[1] / "extension"
sys.path.insert(0, str(EXTENSION))
from undertree_connection import ConnectionManager, CONFIG
from undertree_mcp import Endpoint


class Session:
    def __init__(self, document_id, shared=False):
        self.document_id = document_id
        self.shared = shared
        self.calls = []

    def dispatch(self, name, arguments):
        self.calls.append((name, arguments, threading.current_thread().name))
        if name == "list_manuscripts":
            return {"manuscripts": [{"documentId": self.document_id, "name": "private path must not propagate"}] if self.shared else []}
        if not self.shared:
            raise ValueError("Explicitly share this document locally first.")
        return {"documentId": self.document_id, "status": "pending", "manuscriptChanged": False}


def call(url, name, arguments=None):
    data = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments or {}}}).encode()
    request = urllib.request.Request(url, data, {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        body = json.load(response)
        if "error" in body:
            assert body["error"]["code"] == -32602
            return {"isError": True, "error": body["error"]}
        return body["result"]


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.profile = Path(self.temp.name) / "connection"
        self.manager = None

    def tearDown(self):
        if self.manager is not None:
            self.manager.close()
        self.temp.cleanup()

    def create(self):
        self.manager = ConnectionManager(self.profile)
        return self.manager

    def test_stable_address_capability_and_desired_after_process_reopen(self):
        manager = self.create()
        session = Session("first", True)
        endpoint = manager.ensure(session, session.dispatch)
        url = endpoint.url
        self.assertTrue(call(url, "list_manuscripts")["structuredContent"]["manuscripts"])
        config = (self.profile / CONFIG).read_bytes()
        manager.close()
        self.manager = None
        reopened = self.create()
        fresh = Session("fresh")
        self.assertFalse(fresh.shared)
        self.assertEqual(reopened.ensure(fresh, fresh.dispatch).url, url)
        self.assertEqual((self.profile / CONFIG).read_bytes(), config)
        self.assertEqual(call(url, "list_manuscripts")["structuredContent"], {"manuscripts": []})
        self.assertTrue(call(url, "read_manuscript", {"documentId": "first"})["isError"])
        self.assertTrue(call(url, "read_manuscript", {"documentId": "fresh"})["isError"])

    def test_stop_persists_and_ensure_cannot_silently_restart(self):
        manager = self.create()
        session = Session("doc")
        url = manager.ensure(session, session.dispatch).url
        manager.stop()
        self.assertFalse(manager.status()["running"])
        self.assertFalse(manager.status()["autoReconnect"])
        self.assertIsNone(manager.ensure(session, session.dispatch))
        manager.close()
        self.manager = None
        reopened = self.create()
        fresh = Session("fresh")
        self.assertIsNone(reopened.ensure(fresh, fresh.dispatch))
        self.assertEqual(reopened.start(fresh, fresh.dispatch).url, url)
        self.assertFalse(fresh.shared)

    def test_reconnect_checkbox_changes_intent_without_disconnecting_or_sharing(self):
        manager = self.create()
        session = Session("doc")
        endpoint = manager.ensure(session, session.dispatch)
        manager.set_auto_reconnect(False)
        self.assertTrue(manager.status()["running"])
        self.assertFalse(manager.status()["autoReconnect"])
        self.assertFalse(session.shared)
        self.assertEqual(call(endpoint.url, "list_manuscripts")["structuredContent"], {"manuscripts": []})
        manager.set_auto_reconnect(True)
        self.assertTrue(manager.status()["running"])
        self.assertTrue(json.loads((self.profile / CONFIG).read_bytes())["autoReconnect"])
        with self.assertRaises(ValueError):
            manager.set_auto_reconnect(1)

    def test_explicit_start_replaces_stopped_session_callback_with_fresh_native_epoch(self):
        manager = self.create()
        session = Session("doc")
        manager.stop()
        self.assertIsNone(manager.ensure(session, lambda *_: {"epoch": "retired"}))
        endpoint = manager.start(session, lambda *_: {"epoch": "fresh"})
        self.assertEqual(call(endpoint.url, "read_manuscript", {"documentId": "doc"})["structuredContent"], {"epoch": "fresh"})
        manager.stop()
        endpoint = manager.start(session, lambda *_: {"epoch": "newer"})
        self.assertEqual(call(endpoint.url, "read_manuscript", {"documentId": "doc"})["structuredContent"], {"epoch": "newer"})

    def test_global_stop_retires_other_callbacks_and_stopped_attach_never_poisons_listing(self):
        manager = self.create()
        first, second, stopped = Session("first"), Session("second"), Session("stopped")
        manager.ensure(first, first.dispatch)
        def retired(*_):
            raise ValueError("Retired native endpoint epoch must never be dispatched.")
        manager.ensure(second, retired)
        manager.stop()
        self.assertIsNone(manager.ensure(stopped, retired))
        endpoint = manager.start(first, first.dispatch)
        self.assertEqual(call(endpoint.url, "list_manuscripts")["structuredContent"], {"manuscripts": []})
        self.assertTrue(call(endpoint.url, "read_manuscript", {"documentId": "second"})["isError"])
        self.assertTrue(call(endpoint.url, "read_manuscript", {"documentId": "stopped"})["isError"])

    def test_initialize_advertises_persisted_owner_id_at_result_meta(self):
        manager = self.create()
        session = Session("doc")
        endpoint = manager.ensure(session, session.dispatch)
        owner = json.loads((self.profile / CONFIG).read_bytes())["writerOwnerId"]
        request = urllib.request.Request(endpoint.url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}).encode(), {"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=5) as response:
            self.assertEqual(json.load(response)["result"]["_meta"], {"undertree/writerOwnerId": owner})
        self.assertEqual(manager.status()["writerOwnerId"], owner)

    def test_failed_atomic_save_preserves_original_config_and_stops_current_endpoint(self):
        manager = self.create()
        session = Session("doc")
        manager.ensure(session, session.dispatch)
        before = (self.profile / CONFIG).read_bytes()
        with patch("undertree_connection.os.replace", side_effect=OSError("simulated disk failure")):
            with self.assertRaises(OSError):
                manager.stop()
        self.assertEqual((self.profile / CONFIG).read_bytes(), before)
        self.assertFalse(manager.status()["running"])
        self.assertEqual(sorted(path.name for path in self.profile.iterdir()), [CONFIG, "connection.lock"])

    def test_detach_keeps_desired_and_other_documents_routed_without_sharing(self):
        manager = self.create()
        shared, private = Session("shared", True), Session("private")
        endpoint = manager.ensure(shared, shared.dispatch)
        self.assertIs(manager.ensure(private, private.dispatch), endpoint)
        listed = call(endpoint.url, "list_manuscripts")["structuredContent"]["manuscripts"]
        self.assertEqual([row["documentId"] for row in listed], ["shared"])
        self.assertNotIn("private path", json.dumps(listed))
        self.assertFalse(private.shared)
        self.assertTrue(call(endpoint.url, "read_manuscript", {"documentId": "private"})["isError"])
        self.assertFalse(call(endpoint.url, "suggest_text", {"documentId": "shared", "proposal": {}})["isError"])
        shared.shared = False  # Native caller revokes first.
        manager.detach(shared)
        self.assertEqual(call(endpoint.url, "list_manuscripts")["structuredContent"], {"manuscripts": []})
        self.assertTrue(call(endpoint.url, "read_manuscript", {"documentId": "shared"})["isError"])
        self.assertTrue(manager.status()["autoReconnect"])
        self.assertTrue(manager.status()["running"])

    def test_profile_lock_refuses_second_process_then_releases(self):
        manager = self.create()
        program = "import sys;sys.path.insert(0,sys.argv[1]);from undertree_connection import ConnectionManager;m=ConnectionManager(sys.argv[2]);m.close()"
        executable = Path(sys.executable)
        if not executable.is_file():
            # LibreOffice's Windows launcher reports python-core's directory as sys.executable.
            direct = executable / "bin" / ("python.exe" if os.name == "nt" else "python")
            executable = direct if direct.is_file() else executable.parent / ("python.exe" if os.name == "nt" else "python")
        self.assertTrue(executable.is_file(), "A runnable Python launcher is required for the independent process lease check.")
        command = [str(executable), "-c", program, str(EXTENSION), str(self.profile)]
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Another LibreOffice process", result.stderr)
        self.assertNotIn(manager.status()["url"].rsplit("/", 1)[-1], result.stderr)
        manager.close()
        self.manager = None
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_occupied_saved_port_preserves_identity_and_never_rotates(self):
        manager = self.create()
        before = (self.profile / CONFIG).read_bytes()
        port = json.loads(before)["port"]
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", port))
            occupied.listen(1)
            session = Session("doc")
            with self.assertRaisesRegex(ValueError, "port is unavailable"):
                manager.ensure(session, session.dispatch)
            self.assertFalse(manager.status()["running"])
            self.assertEqual((self.profile / CONFIG).read_bytes(), before)
        self.assertEqual(manager.ensure(session, session.dispatch).url, manager.status()["url"])

    def test_corrupt_oversized_and_unknown_config_preserved(self):
        manager = self.create()
        original = json.loads((self.profile / CONFIG).read_bytes())
        manager.close()
        self.manager = None
        for raw in [b"{broken", b"x" * 4097, json.dumps(dict(original, extra=True)).encode(), json.dumps(dict(original, port=True)).encode(), json.dumps(dict(original, autoReconnect="yes")).encode(), json.dumps(dict(original, token="../unsafe")).encode(), json.dumps(dict(original, writerOwnerId="not-a-uuid")).encode()]:
            with self.subTest(raw=raw[:20]):
                (self.profile / CONFIG).write_bytes(raw)
                with self.assertRaises(ValueError):
                    ConnectionManager(self.profile)
                self.assertEqual((self.profile / CONFIG).read_bytes(), raw)
        duplicate = json.dumps(original)[:-1] + ',"autoReconnect":false}'
        (self.profile / CONFIG).write_text(duplicate, encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "duplicate"):
            ConnectionManager(self.profile)
        self.assertEqual((self.profile / CONFIG).read_text(encoding="utf-8"), duplicate)

    def test_external_config_change_or_deletion_is_not_overwritten_by_stop(self):
        for missing in [False, True]:
            with self.subTest(missing=missing):
                if self.manager:
                    self.manager.close()
                    self.manager = None
                if self.profile.exists():
                    (self.profile / CONFIG).unlink(missing_ok=True)
                manager = self.create()
                session = Session("doc")
                manager.ensure(session, session.dispatch)
                if missing:
                    (self.profile / CONFIG).unlink()
                else:
                    (self.profile / CONFIG).write_bytes(b"external invalid policy")
                with self.assertRaisesRegex(ValueError, "changed externally|disappeared"):
                    manager.stop()
                self.assertFalse(manager.status()["running"])
                self.assertEqual((self.profile / CONFIG).exists(), not missing)
                if not missing:
                    self.assertEqual((self.profile / CONFIG).read_bytes(), b"external invalid policy")

    def test_broker_cannot_route_tools_or_session_identity_forgery(self):
        manager = self.create()
        session = Session("doc", True)
        endpoint = manager.ensure(session, session.dispatch)
        for name, args in [("save", {}), ("read_manuscript", {"documentId": "../doc"}), ("read_manuscript", {"documentId": []}), ("list_manuscripts", {"shared": True})]:
            self.assertTrue(call(endpoint.url, name, args).get("isError", True))
        other = Session("doc", True)
        with self.assertRaisesRegex(ValueError, "already attached"):
            manager.ensure(other, other.dispatch)
        self.assertEqual(session.calls, [])

    def test_late_callback_result_suppressed_after_detach(self):
        manager = self.create()
        session = Session("doc", True)
        entered, resume = threading.Event(), threading.Event()
        def dispatch(name, arguments):
            entered.set()
            self.assertTrue(resume.wait(3))
            return {"documentId": "doc", "content": "must not escape"}
        endpoint = manager.ensure(session, dispatch)
        result = []
        thread = threading.Thread(target=lambda: result.append(call(endpoint.url, "read_manuscript", {"documentId": "doc"})))
        thread.start()
        self.assertTrue(entered.wait(3))
        session.shared = False
        manager.detach(session)
        resume.set()
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertTrue(result[0]["isError"])
        self.assertNotIn("must not escape", json.dumps(result))

    def test_endpoint_config_validation_and_existing_default(self):
        for options in [{"token": "short"}, {"token": "x" * 31 + "/"}, {"port": True}, {"port": 65536}, {"port": -1}, {"owner_id": "not-a-uuid"}, {"owner_id": "00000000-0000-0000-0000-000000000000"}]:
            with self.assertRaises(ValueError):
                Endpoint(lambda *_: {}, **options)
        endpoint = Endpoint(lambda *_: {"manuscripts": []})
        try:
            self.assertTrue(call(endpoint.url, "list_manuscripts")["structuredContent"] == {"manuscripts": []})
        finally:
            endpoint.close()
            self.assertTrue(endpoint.wait_closed())

    def test_public_host_allowlist_is_exact_revocable_and_never_allows_origin_or_missing_host(self):
        manager = self.create()
        session = Session("doc")
        endpoint = manager.ensure(session, session.dispatch)
        data = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}).encode()
        def request(host, origin=None):
            headers = {"Content-Type": "application/json", "Host": host}
            if origin:
                headers["Origin"] = origin
            return urllib.request.urlopen(urllib.request.Request(endpoint.url, data, headers), timeout=5)
        with self.assertRaises(urllib.error.HTTPError) as denied:
            request("writer.example.test")
        self.assertEqual(denied.exception.code, 403)
        manager.set_public_host("writer.example.test")
        with request("writer.example.test") as response:
            self.assertEqual(len(json.load(response)["result"]["tools"]), 4)
        for host, origin in [("other.example.test", None), ("writer.example.test.evil", None), ("writer.example.test", "https://writer.example.test")]:
            with self.assertRaises(urllib.error.HTTPError) as denied:
                request(host, origin)
            self.assertEqual(denied.exception.code, 403)
        manager.set_public_host(None)
        with self.assertRaises(urllib.error.HTTPError):
            request("writer.example.test")
        with socket.create_connection(endpoint.server.server_address, timeout=5) as channel:
            path = endpoint.url.split(endpoint.url.split("/mcp/")[0], 1)[1]
            channel.sendall(("POST " + path + " HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: " + str(len(data)) + "\r\n\r\n").encode() + data)
            self.assertIn(b"403", channel.recv(256).split(b"\r\n", 1)[0])

    def test_optional_local_peer_hooks_forward_only_frozen_aliases_without_native_wrapping(self):
        manager = self.create()
        session = Session("doc")
        endpoint = manager.ensure(session, session.dispatch)
        class Peers:
            names = [{"name": "peer_fixture_read_manuscript", "inputSchema": {"type": "object"}}]
            calls = []
            def tools(self): return self.names
            def call(self, name, arguments):
                self.calls.append((name, arguments))
                return {"content": [{"type": "text", "text": "paired result"}], "structuredContent": {"paired": True}, "isError": False}
        peers = Peers()
        manager.set_peers(peers)
        paired = call(endpoint.url, "peer_fixture_read_manuscript", {"documentId": "remote"})
        self.assertEqual(paired["structuredContent"], {"paired": True})
        self.assertEqual(paired["content"][0]["text"], "paired result")
        self.assertTrue(call(endpoint.url, "peer_unknown_read_manuscript")["isError"])
        self.assertEqual(len(peers.calls), 1)
        self.assertEqual(session.calls, [])
        manager.set_peers(None)
        self.assertTrue(call(endpoint.url, "peer_fixture_read_manuscript")["isError"])
        self.assertEqual(len(peers.calls), 1)
        for names in [[{"name": "save", "inputSchema": {}}], peers.names * 2, [{"name": "peer_" + "x" * 65, "inputSchema": {}}]]:
            peers.names = names
            manager.set_peers(peers)
            with self.assertRaises(ValueError):
                endpoint.extra_catalogue()

    def test_late_paired_result_is_not_delivered_after_local_unpair(self):
        manager = self.create()
        session = Session("doc")
        endpoint = manager.ensure(session, session.dispatch)
        entered, resume = threading.Event(), threading.Event()
        class Peers:
            def tools(self): return [{"name": "peer_fixture_read_manuscript", "inputSchema": {"type": "object"}}]
            def call(self, *_):
                entered.set()
                if not resume.wait(3): raise ValueError("Fixture timed out.")
                return {"content": [{"type": "text", "text": "revoked private result"}], "isError": False}
        manager.set_peers(Peers())
        result = []
        thread = threading.Thread(target=lambda: result.append(call(endpoint.url, "peer_fixture_read_manuscript")))
        thread.start()
        self.assertTrue(entered.wait(3))
        manager.set_peers(None)
        resume.set()
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertTrue(result[0]["isError"])
        self.assertNotIn("revoked private result", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
