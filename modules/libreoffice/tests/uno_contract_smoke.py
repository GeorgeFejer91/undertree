"""Shared selective-editor acceptance cases exercised against actual Writer UNO."""
import copy
import hashlib
import json
import time
from pathlib import Path
import urllib.request

import uno

from undertree_policy import CONTRACT, defaults, public_snapshot, utf16_length, utf16_slice
from undertree_writer import Panel, Session, property_value
from undertree_ui import ContextConsent, HighlightDialog, RuleDialog


def denied(function):
    try:
        function()
    except ValueError:
        return
    raise AssertionError("Operation unexpectedly succeeded")


def select(document, quote):
    descriptor = document.createSearchDescriptor()
    descriptor.SearchString, descriptor.SearchCaseSensitive = quote, True
    found = document.findFirst(descriptor)
    assert found is not None and found.String == quote, "Native quote was not found"
    document.CurrentController.select(found)
    return found


def request(read, proposal, request_id):
    return {"documentId": read["documentId"], "proposal": {"requestId": request_id, "revision": read["revision"],
            "contextId": read["contextId"], "rationale": "Shared native acceptance fixture", **proposal}}


def rpc(url, name, arguments, error=False):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}).encode()
    with urllib.request.urlopen(urllib.request.Request(url, body, {"Content-Type": "application/json"}), timeout=35) as response:
        result = json.load(response)["result"]
    assert bool(result.get("isError")) == error, result
    if error:
        assert "structuredContent" not in result
        return result
    value = json.loads(result["content"][0]["text"])
    assert result["structuredContent"] == value, "Native MCP structured and text projections differ"
    return value


def close(session, document):
    if session: session.close()
    document.setModified(False)
    document.close(True)


def verify(context, output):
    desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
    results = []
    for case in CONTRACT["rangeCases"]:
        print("Native shared case: " + case["id"], flush=True)
        document = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
        session = None
        try:
            document.Text.String = case["text"]
            session = Session(context, document)
            for index, mark in enumerate(case["marks"]):
                rule_id = "case" + str(index)
                session.save_rule(rule_id, {"name": rule_id, "color": "#e5be50", "prompt": "" if mark["action"] == "neutral" else "Preserve the scientific claim.",
                    "action": "edit" if mark["action"] == "prompt" else mark["action"],
                    "mode": "suggestion" if mark["accessMode"] == "suggestions" else "direct"})
                select(document, utf16_slice(case["text"], mark["from"], mark["to"]))
                session.mark_selection(rule_id, "" if mark["action"] == "neutral" else "Additional passage instructions.")
            session.set_shared(True)
            guessed = session.snapshot()
            forged = request({"documentId": session.document_id, "revision": guessed["revision"], "contextId": "forged"}, case["proposal"], "no-full-read")
            denied(lambda: session.call("suggest_text", forged))
            session.panel = Panel(session)
            endpoint = session.start()
            read = rpc(endpoint, "read_manuscript", {"documentId": session.document_id})
            assert read["context"]["complete"] and read["snapshot"] == "live" and read["content"] == case["text"]
            if case["marks"][0]["action"] != "neutral":
                assert "Additional passage instructions." in read["markers"][0]["prompt"]
            payload = request(read, case["proposal"], case["id"])
            if case["id"] == "adjacent_highlight_union":
                document.CurrentController.Frame.activate()
                document.CurrentController.Frame.ContainerWindow.toFront()
                document.CurrentController.Frame.ComponentWindow.setFocus()
                frame = document.CurrentController.Frame
                deadline = time.monotonic() + 3
                while not (frame.ContainerWindow.isActive() or frame.ComponentWindow.hasFocus()) and time.monotonic() < deadline:
                    time.sleep(0.02)
                assert frame.ContainerWindow.isActive() or frame.ComponentWindow.hasFocus(), "Native Writer focus was not established for the typing guard test"
                focused = request(read, case["proposal"], "writer-canvas-has-focus")
                rpc(endpoint, "suggest_text", focused, error=True)
                assert document.Text.String == case["text"]
            if case["result"] == "denied":
                rpc(endpoint, "suggest_text", payload, error=True)
                assert document.Text.String == case["text"]
            else:
                session.panel.dialog.toFront()
                session.panel.control("connections").setFocus()
                frame = document.CurrentController.Frame
                deadline = time.monotonic() + 3
                while (frame.ContainerWindow.isActive() or frame.ComponentWindow.hasFocus()) and time.monotonic() < deadline:
                    time.sleep(0.02)
                assert not frame.ContainerWindow.isActive() and not frame.ComponentWindow.hasFocus(), "Native review popup did not take focus away from Writer before the authorized request"
                result = rpc(endpoint, "suggest_text", payload)
                if case["result"] == "pending":
                    assert result["status"] == "pending_local_approval" and document.Text.String == case["text"]
                    session.accept(case["id"])
                else:
                    assert result["status"] == "applied" and result["appliedDirectly"]
                proposal = case["proposal"]
                expected = utf16_slice(case["text"], 0, proposal["from"]) + proposal["replacement"] + utf16_slice(case["text"], proposal["to"], utf16_length(case["text"]))
                assert document.Text.String == expected, case["id"]
            results.append({"case": case["id"], "status": "passed"})
        finally:
            close(session, document)

    verify_preservation_cases(desktop, context, results)
    verify_complete_context(desktop, context, results)
    verify_pending_reopen(desktop, context, output, results)
    verify_dialogs(desktop, context, results)
    path = Path(output).resolve().parent / "native-contract-result.json"
    path.write_text(json.dumps({"status": "passed", "sharedContractVersion": CONTRACT["version"], "cases": results}, indent=2), encoding="utf-8")
    print("PASS: shared UTF-16 subranges/unions, complete native text, read witnesses, full-context bounds, persisted suggestions and native contract controls", flush=True)


def verify_preservation_cases(desktop, context, results):
    for case in CONTRACT["preservationCases"]:
        print("Native protected case: " + case["id"], flush=True)
        document = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
        session = None
        try:
            document.Text.String = case["text"]
            session = Session(context, document)
            native_ids = {}
            for index, mark in enumerate(case["marks"]):
                rule_id = "preserve" + str(index)
                session.save_rule(rule_id, {"name": rule_id, "color": "#e5be50", "prompt": "",
                    "action": "edit" if mark["action"] == "prompt" else mark["action"],
                    "mode": "suggestion" if mark["accessMode"] == "suggestions" else "direct"})
                cursor = session.document_range(session.snapshot(), mark["from"], mark["to"])
                document.CurrentController.select(cursor)
                native_ids[mark["id"]] = session.mark_selection(rule_id)
            proposal = copy.deepcopy(case["proposal"])
            for part in proposal["replacementParts"]:
                if "protectedId" in part:
                    part["protectedId"] = native_ids.get(part["protectedId"], part["protectedId"])
            session.set_shared(True)
            snapshot = session.call("read_manuscript", {"documentId": session.document_id})
            payload = request(snapshot, proposal, case["id"])
            if case["result"] == "denied":
                denied(lambda: session.call("suggest_text", payload))
                assert document.Text.String == case["text"]
            else:
                result = session.call("suggest_text", payload)
                if case["result"] == "pending":
                    assert result["status"] == "pending_local_approval" and document.Text.String == case["text"]
                    session.accept(case["id"])
                assert document.Text.String == case["expectedText"]
                after = session.snapshot()
                for mark in case["marks"]:
                    if mark["action"] in ("protect", "reject"):
                        identifier = native_ids[mark["id"]]
                        assert document.Bookmarks.getByName(identifier).Anchor.String == utf16_slice(case["text"], mark["from"], mark["to"])
                        assert not next(item for item in after["markers"] if item["id"] == identifier)["stale"]
            results.append({"case": case["id"], "status": "passed"})
        finally:
            close(session, document)


def verify_complete_context(desktop, context, results):
    print("Native full-text containers and bounds", flush=True)
    document = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
    session = None
    try:
        document.Text.String = "Opening paragraph.\nEditable body passage.\nFinal paragraph.\n"
        table = document.createInstance("com.sun.star.text.TextTable")
        table.initialize(2, 2)
        document.Text.insertTextContent(document.Text.End, table, False)
        for cell in table.getCellNames(): table.getCellByName(cell).String = "TABLE CONTEXT " + cell
        style = document.StyleFamilies.getByName("PageStyles").getByName("Standard")
        style.HeaderIsOn, style.FooterIsOn = True, True
        style.HeaderText.String, style.FooterText.String = "HEADER CONTEXT SENTINEL", "FOOTER CONTEXT SENTINEL"
        footnote = document.createInstance("com.sun.star.text.Footnote")
        document.Text.insertTextContent(document.Text.Start, footnote, False)
        footnote.String = "FOOTNOTE CONTEXT SENTINEL"
        endnote = document.createInstance("com.sun.star.text.Endnote")
        document.Text.insertTextContent(document.Text.Start, endnote, False)
        endnote.String = "ENDNOTE CONTEXT SENTINEL"
        frame = document.createInstance("com.sun.star.text.TextFrame")
        frame.Width, frame.Height = 4000, 1000
        document.Text.insertTextContent(document.Text.Start, frame, False)
        frame.Text.String = "FRAME CONTEXT SENTINEL"
        field = document.createInstance("com.sun.star.text.TextField.Annotation")
        field.Content, field.Author = "ANNOTATION CONTEXT SENTINEL", "Native QA"
        document.Text.insertTextContent(document.Text.Start, field, False)
        drawing = document.createInstance("com.sun.star.drawing.TextShape")
        size = uno.createUnoStruct("com.sun.star.awt.Size")
        size.Width, size.Height = 4000, 1000
        drawing.setSize(size)
        document.DrawPage.add(drawing)
        drawing.String = "DRAWING CONTEXT SENTINEL"
        session = Session(context, document)
        select(document, "Editable body passage.")
        marker = session.mark_selection("snappier")
        session.set_shared(True)
        read = session.call("read_manuscript", {"documentId": session.document_id})
        complete = json.dumps(read, ensure_ascii=False)
        for sentinel in ("Opening paragraph.", "Final paragraph.", "TABLE CONTEXT A1", "TABLE CONTEXT B2", "HEADER CONTEXT SENTINEL", "FOOTER CONTEXT SENTINEL", "FOOTNOTE CONTEXT SENTINEL", "ENDNOTE CONTEXT SENTINEL", "FRAME CONTEXT SENTINEL", "ANNOTATION CONTEXT SENTINEL", "DRAWING CONTEXT SENTINEL"):
            assert sentinel in complete, "Missing full context: " + sentinel
        marked = next(item for item in read["markers"] if item["id"] == marker)
        payload = request(read, {"from": marked["from"], "to": marked["to"], "quote": marked["text"], "replacement": "Improved body wording."}, "complete-context")
        original = document.Text.String
        style.HeaderText.String = "CHANGED HEADER CONTEXT SENTINEL"
        denied(lambda: session.call("suggest_text", payload))
        assert document.Text.String == original
        new_read = session.call("read_manuscript", {"documentId": session.document_id})
        assert new_read["revision"] != read["revision"]
        assert "CHANGED HEADER" in json.dumps(new_read)
        denied(lambda: session.call("suggest_text", request(new_read, {"from": 0, "to": 3, "quote": utf16_slice(new_read["content"], 0, 3), "replacement": "Unmarked edit"}, "context-is-readonly")))
        results.append({"case": "complete_body_tables_headers_notes_frames_fields_drawings_and_stale_context", "status": "passed"})
    finally:
        close(session, document)
    for text, expect_success in ((("\"" * 1000 + "\n") * 100, True), (("\"" * 1000 + "\n") * 140, False), (("\"" * 1000 + "\n") * 210, False), (("😀" * 1000 + "\n") * 140, False)):
        document = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, (property_value("Hidden", True),))
        session = None
        try:
            document.Text.String = "Wire response preflight fixture."
            session = Session(context, document)
            session.set_shared(True)
            # The native collector is exercised above. Inject its already-collected
            # result here so this tests actual nested MCP escaping/receipt commit,
            # rather than Writer's unrelated bulk typesetting of huge paragraphs.
            snapshot = session.snapshot()
            snapshot["content"] = text
            snapshot["context"]["files"] = [{"path": "writer:body", "content": text}]
            if text.count('"') == 140000:
                prior_value = dict(public_snapshot(snapshot), contextId="0" * 64)
                text_only = {"jsonrpc": "2.0", "id": "x" * 100, "result": {"content": [{"type": "text", "text": json.dumps(prior_value, ensure_ascii=False)}], "isError": False}}
                assert len(json.dumps(text_only, ensure_ascii=False).encode("utf-8")) < 1572864, "Boundary fixture must fit the prior text-only response"
            session.snapshot = lambda: snapshot
            endpoint = session.start()
            if expect_success:
                assert rpc(endpoint, "read_manuscript", {"documentId": session.document_id})["contextId"]
            else:
                rpc(endpoint, "read_manuscript", {"documentId": session.document_id}, error=True)
                assert not session.context_reads
        finally:
            close(session, document)
    import undertree_context
    document = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
    session = Session(context, document)
    old_limit = undertree_context.MAX_CONTEXT_BYTES
    try:
        document.Text.String = "😀" * 2000
        session.set_shared(True)
        undertree_context.MAX_CONTEXT_BYTES = 4096
        denied(lambda: session.call("read_manuscript", {"documentId": session.document_id}))
        assert not session.context_reads
    finally:
        undertree_context.MAX_CONTEXT_BYTES = old_limit
        close(session, document)
    results.append({"case": "quote_heavy_multibyte_complete_response_bounds", "status": "passed"})


def verify_pending_reopen(desktop, context, output, results):
    print("Native persisted pending suggestions", flush=True)
    document = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
    session = None
    path = Path(output).resolve().parent / "pending-reopen.odt"
    path.parent.mkdir(parents=True, exist_ok=True)
    url = uno.systemPathToFileUrl(str(path))
    try:
        document.Text.String = "Read-only whole-document context.\nPending passage."
        session = Session(context, document)
        select(document, "Pending passage.")
        marker = session.mark_selection("snappier", "Preserve this passage's specific meaning.")
        document.storeAsURL(url, (property_value("FilterName", "writer8"), property_value("Overwrite", True)))
        before_file = hashlib.sha256(path.read_bytes()).hexdigest()
        session.set_shared(True)
        read = session.call("read_manuscript", {"documentId": session.document_id})
        marked = next(item for item in read["markers"] if item["id"] == marker)
        session.call("suggest_text", request(read, {"from": marked["from"], "to": marked["to"], "quote": marked["text"], "replacement": "Persisted proposed wording."}, "persisted-proposal"))
        assert hashlib.sha256(path.read_bytes()).hexdigest() == before_file, "Proposal saved the document implicitly"
        assert "contextId" not in json.dumps(session.data["pending"])
        document.store()
        session.close()
        document.close(True)
        document = desktop.loadComponentFromURL(url, "_blank", 0, ())
        session = Session(context, document)
        assert len(session.pending) == 1 and not session.shared and not session.endpoint
        session.set_shared(True)
        immutable = copy.deepcopy(session.pending["persisted-proposal"])
        read = session.call("read_manuscript", {"documentId": session.document_id})
        marked = next(item for item in read["markers"] if item["id"] == marker)
        denied(lambda: session.call("suggest_text", request(read, {"from": marked["from"], "to": marked["to"], "quote": marked["text"], "replacement": "Must not overwrite a restored proposal."}, "persisted-proposal")))
        assert session.pending["persisted-proposal"] == immutable
        session.close()
        session = Session(context, document)
        before_file = hashlib.sha256(path.read_bytes()).hexdigest()
        session.accept("persisted-proposal")
        assert document.Text.String == "Read-only whole-document context.\nPersisted proposed wording."
        assert hashlib.sha256(path.read_bytes()).hexdigest() == before_file, "Local Accept saved implicitly"
        results.append({"case": "pending_persists_explicit_save_reopen_without_share_or_save_regrant", "status": "passed"})
    finally:
        close(session, document)


def verify_dialogs(desktop, context, results):
    print("Native shared dialog controls", flush=True)
    document = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
    session = None
    try:
        document.Text.String = "Native contract controls passage."
        session = Session(context, document)
        session.panel = Panel(session)
        panel = session.panel
        assert len([name for name in panel.model.ElementNames if name.startswith("slot")]) == CONTRACT["slots"]["visible"]
        rule = RuleDialog(panel)
        rule.modal = False
        rule.show()
        for action in CONTRACT["actions"]:
            assert rule.control("action_" + action["id"]).Model.Label == action["label"]
        rule.action("accessPage")
        for mode in CONTRACT["accessModes"]:
            assert rule.control("mode_" + mode["id"]).isVisible()
            assert rule.control("mode_" + mode["id"]).Model.Label == mode["label"]
        rule.action("colorPage")
        rule.control("name").Model.Text = "Native custom rule"
        rule.action("wordingPage")
        assert rule.control("prompt").isVisible() and not rule.control("color").isVisible()
        for preset in CONTRACT["presets"]:
            assert rule.control("preset_" + preset["id"]).isVisible()
            rule.control("preset_" + preset["id"]).Model.State = 1
        rule.control("prompt").Model.Text = "Keep all cited evidence."
        rule.action("colorPage")
        assert rule.control("name").Model.Text == "Native custom rule"
        rule.action("wordingPage")
        rule.action("save")
        key = rule.result
        panel.selected_rule = key
        assert session.data["rules"][key]["prompt"] == "\n".join([preset["prompt"] for preset in CONTRACT["presets"]] + ["Keep all cited evidence."])
        select(document, "Native contract controls passage.")
        highlight = HighlightDialog(panel)
        highlight.modal = False
        highlight.show()
        highlight.control("prompt").Model.Text = "Additional native passage prompt."
        highlight.action("add")
        assert session.data["marks"][highlight.result]["prompt"] == "Additional native passage prompt."
        panel.action("connections")
        connection = panel.connections
        assert connection.control("share").Model.Label == "Share document context"
        assert connection.control("share").Model.HelpText == CONTRACT["labels"]["shareContext"]
        consent = ContextConsent(connection, session.snapshot())
        consent.modal = False
        consent.show()
        consent.action("cancel")
        assert not session.shared
        consent = ContextConsent(connection, session.snapshot())
        consent.modal = False
        consent.show()
        consent.action("share")
        assert session.shared
        read = session.call("read_manuscript", {"documentId": session.document_id})
        marked = next(item for item in read["markers"] if item["id"] == highlight.result)
        for index in range(2):
            session.call("suggest_text", request(read, {"from": marked["from"], "to": marked["to"], "quote": marked["text"], "replacement": "Alternative " + str(index)}, "selection-" + str(index)))
        panel.control("pending").selectItemPos(1, True)
        selected_request = panel.request_ids[panel.control("pending").getSelectedItemPos()]
        session.call("suggest_text", request(read, {"from": marked["from"], "to": marked["to"], "quote": marked["text"], "replacement": "A third incoming alternative"}, "selection-2"))
        assert panel.request_ids[panel.control("pending").getSelectedItemPos()] == selected_request
        connection.action("stop")
        assert not session.shared
        session.accept(selected_request)
        assert document.Text.String == "Alternative 1", "Revoking remote access must leave valid local review available"
        results.append({"case": "native_slot_rule_presets_access_passage_and_context_consent_controls", "status": "passed"})
    finally:
        close(session, document)
