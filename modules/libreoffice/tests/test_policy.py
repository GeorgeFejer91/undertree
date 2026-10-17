import copy
import json
from pathlib import Path
import sys
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extension"))
from undertree_policy import CONTRACT, authorize, defaults, digest, public_snapshot, validate_metadata, validate_rule, utf16_slice, authorize_highlight
from undertree_mcp import Endpoint


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.mark = {"id": "UnderTree_a", "action": "edit", "mode": "suggestion", "text": "old", "start": 5, "end": 8, "stale": False}
        self.snapshot = {"documentId": "doc", "revision": "rev", "content": "xxxxxold", "context": {"complete": True}, "markers": [self.mark]}
        self.arguments = {"requestId": "r1", "revision": "rev", "contextId": "read-token", "from": 5, "to": 8, "quote": "old", "replacement": "new", "rationale": "Clearer wording"}

    def test_defaults_and_metadata_validation(self):
        self.assertEqual(validate_metadata(defaults()), defaults())
        self.assertTrue(all(rule["mode"] == "suggestion" for rule in defaults()["rules"].values()))
        data = defaults()
        data["version"] = 100
        with self.assertRaises(ValueError):
            validate_metadata(data)

    def test_permission_and_stale_denials(self):
        self.assertEqual(authorize(self.snapshot, self.arguments)["mode"], "suggestion")
        for key, value in (("revision", "old"), ("quote", "partial"), ("from", 0), ("requestId", "bad/id"), ("replacement", "x" * 32769)):
            with self.subTest(key=key), self.assertRaises(ValueError):
                authorize(self.snapshot, dict(self.arguments, **{key: value}))
        for action in ("protect", "reject"):
            self.mark["action"] = action
            with self.assertRaises(ValueError):
                authorize(self.snapshot, self.arguments)

    def test_overlapping_permissions(self):
        self.mark["mode"] = "direct"
        self.assertEqual(authorize(self.snapshot, self.arguments)["mode"], "direct")
        other = dict(self.mark, id="UnderTree_b", start=7, end=10, mode="suggestion")
        self.snapshot["markers"].append(other)
        self.assertEqual(authorize(self.snapshot, self.arguments)["mode"], "suggestion")
        other["action"] = "protect"
        with self.assertRaises(ValueError):
            authorize(self.snapshot, self.arguments)
        other.update(start=10, end=12, stale=True)
        with self.assertRaises(ValueError):
            authorize(self.snapshot, self.arguments)

    def test_discard_and_no_direct_protection(self):
        self.mark["action"] = "discard"
        with self.assertRaises(ValueError):
            authorize(self.snapshot, self.arguments)
        self.assertEqual(authorize(self.snapshot, dict(self.arguments, replacement=""))["mode"], "suggestion")
        for action in ("protect", "reject", "discard"):
            rule = dict(defaults()["rules"]["snappier"], action=action, mode="direct")
            with self.assertRaises(ValueError):
                validate_rule(rule)

    def test_overlapping_discard_cannot_be_bypassed(self):
        self.mark["mode"] = "direct"
        discard = dict(self.mark, id="UnderTree_discard", action="discard", mode="suggestion", start=6, end=7)
        self.snapshot["markers"].append(discard)
        with self.assertRaises(ValueError):
            authorize(self.snapshot, self.arguments)
        self.assertEqual(authorize(self.snapshot, dict(self.arguments, replacement=""))["mode"], "suggestion")
        discard["end"] = 9
        with self.assertRaises(ValueError):
            authorize(self.snapshot, dict(self.arguments, replacement=""))

    def test_consumed_edit_does_not_block_separate_marker(self):
        self.snapshot["markers"].append(dict(self.mark, id="UnderTree_used", stale=True, start=20, end=23))
        self.assertEqual(authorize(self.snapshot, self.arguments)["markers"][0]["id"], self.mark["id"])
        self.mark["stale"] = True
        with self.assertRaises(ValueError):
            authorize(self.snapshot, self.arguments)

    def test_public_scope_and_revision(self):
        self.assertEqual(public_snapshot(self.snapshot)["markers"][0]["from"], 5)
        self.assertNotEqual(digest("private 😀", {}), digest("private 😀!", {}))

    def test_shared_contract_utf16_ranges(self):
        for case in CONTRACT["rangeCases"]:
            with self.subTest(case=case["id"]):
                marks = [{"id": "UnderTree_" + str(index), "start": mark["from"], "end": mark["to"],
                          "action": "edit" if mark["action"] == "prompt" else mark["action"],
                          "mode": "suggestion" if mark["accessMode"] == "suggestions" else "direct", "stale": False,
                          "text": utf16_slice(case["text"], mark["from"], mark["to"])} for index, mark in enumerate(case["marks"])]
                snapshot = {"content": case["text"], "revision": "rev", "markers": marks}
                proposal = {"requestId": case["id"], "revision": "rev", "contextId": "read", "rationale": "Shared fixture", **case["proposal"]}
                if case["result"] == "denied":
                    with self.assertRaises(ValueError): authorize(snapshot, proposal)
                else:
                    mode = authorize(snapshot, proposal)["mode"]
                    self.assertEqual(mode, "direct" if case["result"] == "applied" else "suggestion")
        with self.assertRaises(ValueError): utf16_slice("😀", 1, 2)

    def test_shared_utf8_rule_limits(self):
        rule = dict(defaults()["rules"]["snappier"], name="é" * 50, prompt="😀" * 1000)
        validate_rule(rule)
        with self.assertRaises(ValueError): validate_rule(dict(rule, name=rule["name"] + "x"))
        with self.assertRaises(ValueError): validate_rule(dict(rule, prompt=rule["prompt"] + "x"))

    def test_shared_mark_and_pending_capacity(self):
        data = defaults()
        data["marks"] = {"UnderTree_" + str(index): {"rule": "snappier", "quote": "x"} for index in range(CONTRACT["limits"]["marks"])}
        data["pending"] = [{"proposal": {"requestId": "pending_" + str(index), "from": 0, "to": 1, "quote": "x", "replacement": "y", "rationale": ""},
                            "sourceDigest": "a" * 64, "policyDigest": "b" * 64} for index in range(CONTRACT["limits"]["pendingSuggestions"])]
        validate_metadata(data)
        over = copy.deepcopy(data)
        over["marks"]["UnderTree_extra"] = {"rule": "snappier", "quote": "x"}
        with self.assertRaises(ValueError): validate_metadata(over)
        over = copy.deepcopy(data)
        over["pending"].append(dict(over["pending"][0], proposal=dict(over["pending"][0]["proposal"], requestId="extra")))
        with self.assertRaises(ValueError): validate_metadata(over)

    def test_protected_word_does_not_ban_surrounding_substrings(self):
        text = "the old text"
        snapshot = dict(self.snapshot, content=text, markers=[dict(self.mark, id="outer", start=0, end=len(text), text=text),
            dict(self.mark, id="word", action="protect", start=0, end=3, text="the")])
        proposal = dict(self.arguments, **{"from": 0, "to": len(text), "quote": text, "replacement": "",
            "replacementParts": [{"protectedId": "word"}, {"text": " theory is clearer"}]})
        self.assertEqual(authorize(snapshot, proposal)["replacement"], "the theory is clearer")

    def test_shared_protected_preservation_cases(self):
        for case in CONTRACT["preservationCases"]:
            with self.subTest(case=case["id"]):
                marks = [{"id": mark["id"], "start": mark["from"], "end": mark["to"],
                    "text": utf16_slice(case["text"], mark["from"], mark["to"]), "stale": False,
                    "action": "edit" if mark["action"] == "prompt" else mark["action"],
                    "mode": "suggestion" if mark["accessMode"] == "suggestions" else "direct"} for mark in case["marks"]]
                snapshot = dict(self.snapshot, content=case["text"], markers=marks)
                proposal = dict(self.arguments, **case["proposal"])
                if case["result"] == "denied":
                    with self.assertRaises(ValueError): authorize(snapshot, proposal)
                else:
                    result = authorize(snapshot, proposal)
                    self.assertEqual(result["replacement"], case["expectedText"])
                    self.assertEqual(result["mode"], "direct" if case["result"] == "applied" else "suggestion")

    def test_neutral_highlight_exact_batch_and_no_authority(self):
        marking = {"requestId": "color1", "revision": "rev", "contextId": "read", "ranges": [{"from": 0, "to": 5, "quote": "xxxxx"}]}
        metadata = defaults()
        identifier, neutral = authorize_highlight(self.snapshot, marking, metadata)
        self.assertIsNone(identifier)
        self.assertEqual((neutral["action"], neutral["prompt"], neutral["mode"]), ("neutral", "", "suggestion"))
        metadata["rules"]["neutral"] = neutral
        self.assertEqual(authorize_highlight(self.snapshot, dict(marking, colorId="neutral"), metadata)[0], "neutral")
        for change in ({"action": "edit"}, {"prompt": "change"}, {"colorId": "snappier"}, {"revision": "old"},
                       {"ranges": [{"from": 0, "to": 1, "quote": "forged"}]}, {"ranges": marking["ranges"] * 2}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                authorize_highlight(self.snapshot, dict(marking, **change), metadata)
        metadata["rules"]["neutral"]["action"] = "protect"
        with self.assertRaises(ValueError):
            authorize_highlight(self.snapshot, dict(marking, colorId="neutral"), metadata)

    def test_immutable_identity_reordering_and_denials(self):
        text = "A (One) and (Two)."
        outer = dict(self.mark, id="outer", text=text, start=0, end=len(text), mode="direct")
        units = [dict(self.mark, id="one", action="protect", text="(One)", start=2, end=7),
                 dict(self.mark, id="two", action="reject", text="(Two)", start=12, end=17)]
        snapshot = dict(self.snapshot, content=text, markers=[outer] + units)
        parts = [{"text": "Rewritten "}, {"protectedId": "two"}, {"text": " then "}, {"protectedId": "one"}, {"text": "."}]
        proposal = dict(self.arguments, **{"from": 0, "to": len(text), "quote": text, "replacement": "", "replacementParts": parts})
        result = authorize(snapshot, proposal)
        self.assertEqual(result["replacement"], "Rewritten (Two) then (One).")
        self.assertEqual([part["marker"]["id"] for part in result["protected"]], ["two", "one"])
        for invalid in (parts[:-2], parts + [{"protectedId": "one"}], [{"protectedId": "unknown"}],
                        [{"text": "(One)"}, {"protectedId": "two"}]):
            with self.subTest(parts=invalid), self.assertRaises(ValueError):
                authorize(snapshot, dict(proposal, replacementParts=invalid))
        with self.assertRaises(ValueError):
            authorize(snapshot, dict(proposal, replacement="not empty"))
        snapshot["markers"] = units
        with self.assertRaises(ValueError): authorize(snapshot, proposal)


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.endpoint = Endpoint(lambda name, arguments: self.calls.append((name, arguments)) or {"ok": True})

    def tearDown(self):
        self.endpoint.close()

    def request(self, method, params=None, headers=None, url=None, identifier=1):
        data = json.dumps({"jsonrpc": "2.0", "id": identifier, "method": method, "params": params or {}}).encode()
        request = urllib.request.Request(url or self.endpoint.url, data, {"Content-Type": "application/json", **(headers or {})})
        with urllib.request.urlopen(request, timeout=3) as response:
            raw = response.read()
            return json.loads(raw) if raw else None

    def test_catalogue_and_narrow_calls(self):
        self.assertIn("instructions", self.request("initialize", {"protocolVersion": "2025-03-26"})["result"])
        tools = self.request("tools/list")["result"]["tools"]
        self.assertEqual([item["name"] for item in tools], ["list_manuscripts", "read_manuscript", "suggest_text", "highlight_text"])
        self.request("tools/call", {"name": "list_manuscripts", "arguments": {}})
        self.assertEqual(len(self.calls), 1)
        self.assertIn("error", self.request("tools/call", {"name": "save", "arguments": {}}))
        self.request("tools/call", {"name": "suggest_text", "arguments": {}}, identifier=None)
        self.assertEqual(len(self.calls), 1)

    def test_capability_origin_and_revocation(self):
        for url, headers in ((self.endpoint.url + "x", {}), (self.endpoint.url, {"Origin": "http://evil.invalid"}), (self.endpoint.url, {"Host": "evil.invalid"})):
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.request("tools/list", url=url, headers=headers)
            self.assertEqual(error.exception.code, 403)
        self.endpoint.active = False
        with self.assertRaises(urllib.error.HTTPError):
            self.request("tools/list")

    def test_successful_tools_have_equal_text_and_structured_results(self):
        for name in ("list_manuscripts", "read_manuscript", "suggest_text", "highlight_text"):
            with self.subTest(tool=name):
                result = self.request("tools/call", {"name": name, "arguments": {}})["result"]
                self.assertFalse(result["isError"])
                self.assertEqual(result["structuredContent"], {"ok": True})
                self.assertEqual(json.loads(result["content"][0]["text"]), result["structuredContent"])

    def test_duplicate_and_nonfinite_wire_fields_are_rejected(self):
        for raw in (b'{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"highlight_text","arguments":{"marking":{"colorId":"protect","colorId":"neutral"}}}}',
                    b'{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"highlight_text","arguments":{"marking":{"from":NaN}}}}'):
            request = urllib.request.Request(self.endpoint.url, raw, {"Content-Type": "application/json"})
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(request, timeout=3)
            self.assertEqual(error.exception.code, 400)
        self.assertEqual(self.calls, [])

    def test_failed_tool_has_no_successful_structured_projection(self):
        self.endpoint.close()
        def refuse(name, arguments):
            raise ValueError("Synthetic authority refusal")
        self.endpoint = Endpoint(refuse)
        result = self.request("tools/call", {"name": "read_manuscript", "arguments": {}})["result"]
        self.assertTrue(result["isError"])
        self.assertNotIn("structuredContent", result)


if __name__ == "__main__":
    unittest.main()
