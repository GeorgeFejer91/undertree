"""Real private-file and loopback MCP pairing checks, without UNO or public tunnels."""
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest
from urllib.request import Request, urlopen
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extension"))
from undertree_mcp import Endpoint, TOOLS
from undertree_peers import PeerConnections, SCHEMAS, _url


class Upstream:
    def __init__(self, mode="json", tools=None, name="UnderTree manuscript review"):
        self.mode, self.tools, self.name = mode, copy.deepcopy(TOOLS if tools is None else tools), name
        self.calls, self.headers, self.effects = [], [], 0
        self.entered, self.release = threading.Event(), threading.Event()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                owner.calls.append(request)
                owner.headers.append(dict(self.headers))
                method = request["method"]
                if owner.mode == "redirect":
                    self.send_response(302)
                    self.send_header("Location", owner.redirect)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if method != "initialize" and self.headers.get("Mcp-Session-Id") != "fixture-session":
                    self.send_error(403)
                    return
                if method == "notifications/initialized":
                    self.send_response(202)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if method == "initialize":
                    if owner.mode == "held-link":
                        owner.entered.set()
                        owner.release.wait(3)
                    result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": owner.name, "version": "1"}}
                elif method == "tools/list":
                    result = {"tools": owner.tools}
                elif method == "tools/call":
                    owner.effects += 1
                    owner.entered.set()
                    if owner.mode == "held":
                        owner.release.wait(3)
                    if owner.mode == "lost":
                        self.connection.shutdown(socket.SHUT_RDWR)
                        self.connection.close()
                        return
                    result = {"content": [{"type": "text", "text": "native result"}], "structuredContent": {"owner": "upstream", "effect": owner.effects}, "isError": False}
                    if owner.mode == "refused":
                        result = {"content": [{"type": "text", "text": owner.url}], "isError": True}
                else:
                    self.send_error(405)
                    return
                reply = {"jsonrpc": "2.0", "id": request["id"], "result": result}
                if owner.mode == "wrong-id":
                    reply["id"] = True
                raw = json.dumps(reply).encode("utf-8")
                media = "application/json"
                if owner.mode == "sse":
                    raw = b': heartbeat\r\nevent: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\r\n\r\ndata: ' + raw + b"\r\n\r\n"
                    media = "text/event-stream"
                if owner.mode == "oversized":
                    raw = b" " * (1536 * 1024 + 1)
                self.send_response(200)
                self.send_header("Content-Type", media)
                self.send_header("Content-Length", str(len(raw) + (10 if owner.mode == "truncated" else 0)))
                if method == "initialize":
                    self.send_header("Mcp-Session-Id", "fixture-session")
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    self.wfile.write(raw)
                except ConnectionError:
                    if owner.mode != "held":
                        raise

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d/mcp/private-fixture" % self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)


class PairingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        if os.name != "nt":
            self.directory.chmod(0o700)
        self.peers = PeerConnections(self.directory)
        self.upstreams = []

    def tearDown(self):
        self.peers.close()
        for upstream in self.upstreams:
            upstream.close()
        self.temporary.cleanup()

    def upstream(self, *args, **kwargs):
        upstream = Upstream(*args, **kwargs)
        self.upstreams.append(upstream)
        return upstream

    def linked(self, upstream):
        return self.peers.link(upstream.url).result(3)

    def alias(self, native):
        return next(tool["name"] for tool in self.peers.tools() if tool["name"].endswith("_" + native))

    def proposal(self):
        return {"documentId": "doc", "proposal": {"requestId": "stable-1", "revision": "current", "contextId": "native-context", "from": 0, "to": 4, "quote": "text", "replacement": "word", "rationale": "Follow local prompt."}}

    def marking(self):
        return {"documentId": "doc", "marking": {"requestId": "color-1", "revision": "current", "contextId": "native-context",
                "ranges": [{"from": 0, "to": 4, "quote": "text"}]}}

    def test_native_review_roundtrip_aliases_and_no_generic_proxy(self):
        upstream = self.upstream()
        receipt = self.linked(upstream)
        self.assertEqual(receipt["toolCount"], 4)
        tools = self.peers.tools()
        self.assertTrue(all(len(tool["name"]) <= 64 for tool in tools))
        self.assertNotIn(upstream.url, json.dumps(tools))
        self.assertNotIn(upstream.url, json.dumps(receipt))
        self.assertEqual(self.peers.status()[0]["url"], upstream.url)
        tools[0]["inputSchema"]["additionalProperties"] = True
        self.assertFalse(self.peers.tools()[0]["inputSchema"]["additionalProperties"])
        result = self.peers.call(self.alias("list_manuscripts"), {})
        self.assertEqual(result["structuredContent"], {"owner": "upstream", "effect": 1})
        for name in ("list_manuscripts", "tools/call", "shell", "peer_other_read_manuscript", "peer_" + receipt["id"] + "_unlink"):
            with self.assertRaises(ValueError):
                self.peers.call(name, {})
        with self.assertRaises(ValueError):
            self.peers.call(self.alias("list_manuscripts"), {"url": upstream.url})
        self.assertEqual(upstream.effects, 1)
        self.assertEqual([call["method"] for call in upstream.calls[:3]], ["initialize", "notifications/initialized", "tools/list"])
        self.assertTrue(all(headers["MCP-Protocol-Version"] == "2025-06-18" for headers in upstream.headers))

    def test_saved_pair_restores_same_alias_then_unlink_removes_future_grant(self):
        upstream = self.upstream()
        first = self.linked(upstream)
        aliases = [tool["name"] for tool in self.peers.tools()]
        self.peers.close()
        self.peers = PeerConnections(self.directory)
        self.assertEqual(self.peers.tools(), [])
        restored = self.peers.restore()
        self.assertEqual(len(restored), 1)
        self.assertEqual(restored[0].result(3)["id"], first["id"])
        self.assertEqual([tool["name"] for tool in self.peers.tools()], aliases)
        self.peers.unlink(first["id"])
        self.assertEqual(self.peers.tools(), [])
        self.peers.close()
        self.peers = PeerConnections(self.directory)
        self.assertEqual(self.peers.restore(), [])
        self.assertEqual(self.peers.status(), [])

    def test_legacy_pair_requires_local_catalogue_approval_without_contact_or_alias(self):
        upstream = self.upstream()
        first = self.linked(upstream)
        path = self.directory / "peers" / "peers.json"
        saved = json.loads(path.read_text())
        legacy = {"version": 1, "peers": [{key: entry[key] for key in ("id", "url", "label")} for entry in saved["peers"]]}
        self.peers.close()
        path.write_text(json.dumps(legacy))
        self.peers = PeerConnections(self.directory)
        upstream.tools = upstream.tools[:3]
        calls = len(upstream.calls)
        self.assertEqual(self.peers.restore(), [])
        self.assertEqual(len(upstream.calls), calls)
        self.assertEqual(self.peers.tools(), [])
        self.assertIn("Reconnect locally", self.peers.status()[0]["error"])
        self.assertEqual(json.loads(path.read_text()), legacy, "Startup must preserve legacy configuration without silent enrollment.")
        upstream.tools = copy.deepcopy(TOOLS)
        approved = self.linked(upstream)
        self.assertEqual((approved["id"], approved["toolCount"]), (first["id"], 4))
        pinned = json.loads(path.read_text())
        self.assertEqual(pinned["version"], 2)
        self.assertEqual({key: pinned["peers"][0][key] for key in ("id", "url", "label")}, legacy["peers"][0])
        self.assertRegex(pinned["peers"][0]["catalogueHash"], "^[0-9a-f]{64}$")

    def test_saved_catalogue_ignores_descriptions_but_schema_upgrade_requires_local_relink(self):
        upstream = self.upstream()
        first = self.linked(upstream)
        self.peers.close()
        for tool in upstream.tools:
            tool["description"] = "Updated explanatory text only."
        self.peers = PeerConnections(self.directory)
        self.assertEqual(self.peers.restore()[0].result(3)["id"], first["id"])
        self.peers.close()
        for tool in upstream.tools:
            tool["inputSchema"] = copy.deepcopy(SCHEMAS[1][tool["name"]])
        self.peers = PeerConnections(self.directory)
        with self.assertRaisesRegex(ValueError, "catalogue changed"):
            self.peers.restore()[0].result(3)
        self.assertEqual(self.peers.tools(), [])
        self.assertIn("Reconnect locally", self.peers.status()[0]["error"])
        self.assertEqual(self.linked(upstream)["toolCount"], 4)

    def test_gateway_aliases_cannot_create_cycles(self):
        tools = copy.deepcopy(TOOLS) + [{"name": "peer_other_suggest_text", "inputSchema": {"type": "object"}}, {"name": "app_123_0", "inputSchema": {}}, {"name": "delete_file", "inputSchema": {}}]
        self.linked(self.upstream(tools=tools, name="UnderTree connected apps gateway"))
        self.assertEqual(len(self.peers.tools()), 4)
        with self.assertRaises(ValueError):
            self.peers.call("peer_other_suggest_text", self.proposal())

    def test_real_writer_endpoint_with_native_catalogue(self):
        calls = []
        endpoint = Endpoint(lambda name, args: calls.append((name, args)) or {"manuscripts": []})
        try:
            self.peers.link(endpoint.url).result(3)
            result = self.peers.call(self.alias("list_manuscripts"), {})
            self.assertEqual(result["structuredContent"], {"manuscripts": []})
            self.assertEqual(calls, [("list_manuscripts", {})])
        finally:
            endpoint.close()
            self.assertTrue(endpoint.wait_closed())

    def test_serialized_paired_catalogue_preserves_read_and_color_mutation_semantics(self):
        self.linked(self.upstream())
        endpoint = Endpoint(lambda *_: {}, extra_tools=self.peers.tools, extra_dispatch=self.peers.call)
        try:
            request = Request(endpoint.url, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}).encode("utf-8"),
                              headers={"Content-Type": "application/json"})
            with urlopen(request, timeout=3) as response:
                catalogue = json.load(response)["result"]["tools"]
            paired = {tool["name"].split("_", 2)[2]: tool for tool in catalogue if tool["name"].startswith("peer_")}
            self.assertEqual(set(paired), {"list_manuscripts", "read_manuscript", "suggest_text", "highlight_text"})
            self.assertEqual(len(catalogue), 8)
            for name in ("list_manuscripts", "read_manuscript"):
                self.assertTrue(paired[name]["annotations"]["readOnlyHint"])
                self.assertFalse(paired[name]["annotations"]["destructiveHint"])
            color = paired["highlight_text"]["annotations"]
            self.assertFalse(color["readOnlyHint"], "Color-only marking still writes native formatting/metadata.")
            self.assertFalse(color["destructiveHint"])
            self.assertTrue(color["idempotentHint"], "Identical marking request IDs replay without duplicating marks.")
            self.assertFalse(paired["suggest_text"]["annotations"]["readOnlyHint"])
            self.assertTrue(paired["suggest_text"]["annotations"]["destructiveHint"])
        finally:
            endpoint.close()
            self.assertTrue(endpoint.wait_closed())

    def test_rust_nested_native_schema_bounds_are_frozen(self):
        schema = SCHEMAS[1]
        proposal = schema["suggest_text"]["properties"]["proposal"]["properties"]
        self.assertEqual(proposal["replacementParts"]["items"]["oneOf"][0]["properties"]["text"]["maxLength"], 32000)
        self.assertEqual(proposal["replacementParts"]["items"]["oneOf"][1]["properties"]["protectedId"]["maxLength"], 100)
        marking = schema["highlight_text"]["properties"]["marking"]["properties"]
        self.assertEqual(marking["requestId"]["maxLength"], 100)
        self.assertEqual(marking["colorId"]["maxLength"], 64)
        self.assertEqual(marking["ranges"]["items"]["properties"]["quote"]["maxLength"], 32000)

    def test_native_rust_schema_variant_and_wrong_schema_refusal(self):
        tools = copy.deepcopy(TOOLS)
        for tool in tools:
            tool["inputSchema"] = copy.deepcopy(SCHEMAS[1][tool["name"]])
        self.linked(self.upstream(tools=tools))
        tools[2]["inputSchema"]["additionalProperties"] = True
        bad = self.upstream(tools=tools)
        with self.assertRaises(ValueError):
            self.peers.link(bad.url).result(3)
        self.assertEqual(len(self.peers.tools()), 4)

    def test_frozen_color_only_alias_and_closed_nested_parts(self):
        upstream = self.upstream()
        self.linked(upstream)
        marking = {"documentId": "doc", "marking": {"requestId": "color", "revision": "rev", "contextId": "read",
            "ranges": [{"from": 0, "to": 3, "quote": "old"}]}}
        self.peers.call(self.alias("highlight_text"), marking)
        self.assertEqual(upstream.effects, 1)
        for extra in ({"prompt": "edit"}, {"accessMode": "direct"}, {"action": "prompt"}):
            invalid = copy.deepcopy(marking)
            invalid["marking"].update(extra)
            with self.assertRaises(ValueError): self.peers.call(self.alias("highlight_text"), invalid)
        self.assertEqual(upstream.effects, 1)
        proposal = self.proposal()
        proposal["proposal"].update(replacement="", replacementParts=[{"text": "new "}, {"protectedId": "native"}])
        self.peers.call(self.alias("suggest_text"), proposal)
        self.assertEqual(upstream.effects, 2)
        invalid = copy.deepcopy(proposal)
        invalid["proposal"]["replacementParts"] = [{"text": "forged", "protectedId": "native"}]
        with self.assertRaises(ValueError): self.peers.call(self.alias("suggest_text"), invalid)
        self.assertEqual(upstream.effects, 2)

    def test_color_replay_changed_id_loss_and_revocation_never_redispatch(self):
        upstream = self.upstream()
        receipt = self.linked(upstream)
        alias = self.alias("highlight_text")
        marking = self.marking()
        result = self.peers.call(alias, marking)
        self.assertEqual(self.peers.call(alias, copy.deepcopy(marking)), result)
        self.assertEqual(upstream.effects, 1)
        changed = copy.deepcopy(marking)
        changed["marking"]["ranges"][0]["quote"] = "word"
        with self.assertRaises(ValueError):
            self.peers.call(alias, changed)
        self.assertEqual(upstream.effects, 1)
        upstream.mode = "lost"
        lost = self.marking()
        lost["marking"]["requestId"] = "lost-color"
        uncertain = self.peers.call(alias, lost)
        self.assertTrue(uncertain["isError"])
        self.assertEqual(self.peers.call(alias, lost), uncertain)
        self.assertEqual(upstream.effects, 2)
        self.peers.unlink(receipt["id"])
        with self.assertRaises(ValueError):
            self.peers.call(alias, marking)
        self.assertEqual(upstream.effects, 2)

    def test_color_policy_refusal_does_not_poison_later_healthy_read(self):
        upstream = self.upstream(mode="refused")
        self.linked(upstream)
        refused = self.peers.call(self.alias("highlight_text"), self.marking())
        self.assertTrue(refused["isError"])
        self.assertNotIn(upstream.url, json.dumps(refused))
        upstream.mode = "json"
        read = self.peers.call(self.alias("read_manuscript"), {"documentId": "doc"})
        self.assertFalse(read["isError"])
        self.assertEqual(read["structuredContent"]["owner"], "upstream")
    def test_url_rules_and_redirects_never_follow(self):
        for url in ("file:///tmp/mcp", "http://localhost/mcp", "http://127.1/mcp", "http://[::1]/mcp", "https://user:pass@example.com/mcp", "https://example.com/mcp?", "https://example.com/mcp#", "https://example.com/\\mcp", "https://example.com:0/mcp", "https://example.com/\nmcp"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.peers.link(url)
        self.assertEqual(_url("https://EXAMPLE.com:443/mcp"), "https://example.com/mcp")
        sink, upstream = self.upstream(), self.upstream(mode="redirect")
        upstream.redirect = sink.url
        with self.assertRaises(ValueError):
            self.peers.link(upstream.url).result(3)
        self.assertEqual(sink.calls, [])
        self.assertEqual(self.peers.tools(), [])

    def test_sse_and_protocol_session_headers(self):
        upstream = self.upstream(mode="sse")
        self.linked(upstream)
        self.assertEqual(self.peers.call(self.alias("list_manuscripts"), {})["structuredContent"]["owner"], "upstream")
        self.assertTrue(all(headers.get("Mcp-Session-Id") == "fixture-session" for headers in upstream.headers[1:]))

    def test_mutation_reply_loss_is_never_replayed(self):
        upstream = self.upstream()
        self.linked(upstream)
        upstream.mode = "lost"
        alias, arguments = self.alias("suggest_text"), self.proposal()
        first = self.peers.call(alias, arguments)
        self.assertTrue(first["isError"])
        self.assertIn("unknown", first["content"][0]["text"])
        self.assertEqual(self.peers.call(alias, arguments), first)
        arguments["proposal"]["replacement"] = "changed"
        with self.assertRaises(ValueError):
            self.peers.call(alias, arguments)
        self.assertEqual(upstream.effects, 1)

    def test_successful_mutation_is_cached_and_error_is_sanitized(self):
        upstream = self.upstream()
        self.linked(upstream)
        alias, arguments = self.alias("suggest_text"), self.proposal()
        result = self.peers.call(alias, arguments)
        self.assertEqual(self.peers.call(alias, arguments), result)
        self.assertEqual(upstream.effects, 1)
        upstream.mode = "refused"
        refused = self.peers.call(self.alias("read_manuscript"), {"documentId": "doc"})
        self.assertTrue(refused["isError"])
        self.assertNotIn(upstream.url, json.dumps(refused))

    def test_corrupt_config_preserved_and_exclusive_owner(self):
        with self.assertRaises(ValueError):
            PeerConnections(self.directory)
        path = self.directory / "peers" / "peers.json"
        self.peers.close()
        raw = b'{"version":1,"version":1,"peers":[]}'
        path.write_bytes(raw)
        path.chmod(0o600)
        with self.assertRaises(ValueError):
            PeerConnections(self.directory)
        self.assertEqual(path.read_bytes(), raw)

    def test_bounds_bad_peer_and_duplicate_native_names(self):
        for upstream in (self.upstream(mode="wrong-id"), self.upstream(mode="oversized"), self.upstream(mode="truncated"), self.upstream(name="generic proxy"), self.upstream(tools=TOOLS + [TOOLS[0]])):
            with self.assertRaises(ValueError):
                self.peers.link(upstream.url).result(3)
        self.assertEqual(self.peers.tools(), [])
        first, second, third = self.upstream(), self.upstream(), self.upstream()
        self.linked(first)
        self.linked(second)
        with self.assertRaises(ValueError):
            self.peers.link(third.url)
        self.assertEqual(len(self.peers.tools()), 8)
        self.assertEqual(third.calls, [])

    def test_unlink_during_call_revokes_result_without_repeating_effect(self):
        upstream = self.upstream()
        receipt = self.linked(upstream)
        upstream.mode = "held"
        errors = []
        alias = self.alias("suggest_text")

        def request():
            try:
                self.peers.call(alias, self.proposal())
            except ValueError as error:
                errors.append(str(error))

        thread = threading.Thread(target=request)
        thread.start()
        self.assertTrue(upstream.entered.wait(2))
        with self.assertRaises(ValueError):
            self.peers.call(alias, self.proposal())
        self.peers.unlink(receipt["id"])
        upstream.release.set()
        thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertEqual(upstream.effects, 1)
        self.assertEqual(self.peers.tools(), [])

    def test_pending_link_is_nonblocking_and_cannot_persist_before_validation(self):
        slow, ready = self.upstream(mode="held-link"), self.upstream()
        future = self.peers.link(slow.url)
        self.assertTrue(slow.entered.wait(2))
        self.assertFalse(future.done())
        self.assertEqual(self.peers.status()[0]["status"], "connecting")
        self.linked(ready)
        saved = json.loads((self.directory / "peers" / "peers.json").read_text("utf-8"))
        self.assertEqual([peer["url"] for peer in saved["peers"]], [ready.url])
        pending_id = next(peer["id"] for peer in self.peers.status() if peer["url"] == slow.url)
        self.peers.unlink(pending_id)
        slow.release.set()
        with self.assertRaises(ValueError):
            future.result(3)
        self.assertEqual(len(self.peers.tools()), 4)
        self.assertEqual(len(self.peers.status()), 1)

    def test_wire_timeout_has_one_effect_and_no_automatic_retry(self):
        upstream = self.upstream()
        self.linked(upstream)
        upstream.mode = "held"
        arguments, alias = self.proposal(), self.alias("suggest_text")
        started = time.monotonic()
        with patch("undertree_peers.TIMEOUT", 0.2):
            result = self.peers.call(alias, arguments)
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertTrue(result["isError"])
        self.assertEqual(self.peers.call(alias, arguments), result)
        self.assertEqual(upstream.effects, 1)
        upstream.release.set()


if __name__ == "__main__":
    unittest.main()
