"""Run with LibreOffice's Python against a disposable --accept socket Writer process.

soffice -env:UserInstallation=file:///.../test-profile --accept=socket,host=127.0.0.1,port=2087;urp;StarOffice.ComponentContext --norestore --nodefault
python uno_smoke.py --port 2087 --output artifacts/libreoffice/uno-smoke.odt
"""
import argparse
import faulthandler
import copy
import json
import os
from pathlib import Path
import sys
import time
import urllib.request

import uno

sys.path.insert(0, str(Path(os.environ.get("UNDERTREE_WRITER_EXTENSION_SOURCE", Path(__file__).resolve().parents[1] / "extension"))))
from undertree_writer import Panel, Session, property_value
from undertree_policy import CONTRACT, defaults, utf16_length, utf16_slice
from undertree_ui import RuleDialog, HighlightDialog, ContextConsent


def select_quote(document, quote):
    document.CurrentController.Frame.activate()
    descriptor = document.createSearchDescriptor()
    descriptor.SearchString = quote
    found = document.findFirst(descriptor)
    assert found is not None and found.String == quote
    document.CurrentController.select(found)
    return found


def arguments(session, marker, replacement, request_id):
    snapshot = session.call("read_manuscript", {"documentId": session.document_id})
    item = next(item for item in snapshot["markers"] if item["id"] == marker)
    return {"documentId": session.document_id, "proposal": {"requestId": request_id, "revision": snapshot["revision"], "contextId": snapshot["contextId"],
            "from": item["from"], "to": item["to"], "quote": item["text"], "replacement": replacement, "rationale": "Native integration test"}}


def denied(function):
    try:
        function()
    except ValueError:
        return
    raise AssertionError("Operation unexpectedly succeeded")


def rpc(url, name, payload):
    request = urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": payload}}).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=35) as response:
        result = json.load(response)["result"]
        assert not result.get("isError"), result
        value = json.loads(result["content"][0]["text"])
        assert result["structuredContent"] == value, "Native MCP structured and text projections differ"
        return value


def prepare_desktop(context):
    desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
    # Configure the disposable desktop before its first visible document;
    # Writer may reset this flag while bootstrapping a fresh headless profile.
    provider = context.ServiceManager.createInstanceWithContext("com.sun.star.configuration.ConfigurationProvider", context)
    settings = provider.createInstanceWithArguments("com.sun.star.configuration.ConfigurationUpdateAccess", (property_value("nodepath", "/org.openoffice.Office.Common/Misc"),))
    settings.FirstRun = False
    settings.ShowTipOfTheDay = False
    settings.commitChanges()
    return desktop


def run(context, output, extension_check=False):
    desktop = prepare_desktop(context)
    document = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
    second = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
    session = other = None
    try:
        from uno_contract_smoke import verify
        verify(context, output)
        document.Text.String = "UNSHARED SECRET 😀\nMarked bold passage.\nProtected paragraph.\nSecond editable passage."
        second.Text.String = "OTHER DOCUMENT SECRET"
        session, other = Session(context, document), Session(context, second)
        denied(lambda: session.call("read_manuscript", {"documentId": session.document_id}))
        selected = select_quote(document, "Marked bold passage.")
        selected.CharWeight = 150.0
        before_color = selected.CharBackColor
        before_metadata = copy.deepcopy(session.data)
        original_store = session.store
        def fail_mark_store(_):
            raise ValueError("Injected marker metadata failure")
        session.store = fail_mark_store
        denied(lambda: session.mark_selection("snappier"))
        session.store = original_store
        assert selected.CharBackColor == before_color and session.data == before_metadata
        assert document.Bookmarks.getCount() == 0
        marker = session.mark_selection("snappier")
        document.UndoManager.undo()
        session.load()
        assert marker not in session.data["marks"] and not document.Bookmarks.hasByName(marker)
        document.UndoManager.redo()
        session.load()
        assert marker in session.data["marks"] and document.Bookmarks.hasByName(marker)
        old_rule = copy.deepcopy(session.data["rules"]["snappier"])
        changed_rule = dict(old_rule, color="#C0D9FF", mode="direct")
        session.save_rule("snappier", changed_rule)
        assert document.Bookmarks.getByName(marker).Anchor.CharBackColor == 0xC0D9FF
        document.UndoManager.undo()
        session.load()
        assert session.data["rules"]["snappier"] == old_rule
        assert document.Bookmarks.getByName(marker).Anchor.CharBackColor == int(old_rule["color"][1:], 16)
        document.UndoManager.redo()
        session.load()
        assert session.data["rules"]["snappier"] == changed_rule
        session.save_rule("snappier", old_rule)
        select_quote(document, "Protected paragraph.")
        protection = session.mark_selection("protect")
        session.set_shared(True)
        snapshot = session.call("read_manuscript", {"documentId": session.document_id})
        assert "UNSHARED SECRET" in json.dumps(snapshot) and "OTHER DOCUMENT" not in json.dumps(snapshot)
        assert not any(item["stale"] for item in snapshot["markers"])
        denied(lambda: other.call("read_manuscript", {"documentId": session.document_id}))
        proposal = arguments(session, marker, "Clearer bold passage.", "suggest1")
        original = document.Text.String
        response = session.call("suggest_text", proposal)
        assert response["status"] == "pending_local_approval" and document.Text.String == original
        replay = session.call("suggest_text", proposal)
        assert replay["status"] == response["status"] and replay["replayed"] and not replay["manuscriptChanged"]
        denied(lambda: session.call("suggest_text", {**proposal, "proposal": {**proposal["proposal"], "replacement": "Different"}}))
        session.accept("suggest1")
        assert "Clearer bold passage." in document.Text.String and "Protected paragraph." in document.Text.String
        assert document.Bookmarks.getByName(marker).Anchor.CharWeight == 150.0
        assert next(item for item in session.snapshot()["markers"] if item["id"] == marker)["stale"]
        session.remove_marker(marker)
        select_quote(document, "Clearer bold passage.")
        marker = session.mark_selection("snappier")
        select_quote(document, "Second editable passage.")
        batch_marker = session.mark_selection("snappier")
        session.call("suggest_text", arguments(session, marker, "Batch first wording.", "batch1"))
        session.call("suggest_text", arguments(session, batch_marker, "Batch second wording.", "batch2"))
        session.accept("batch1")
        session.accept("batch2")
        assert "Batch first wording." in document.Text.String and "Batch second wording." in document.Text.String
        session.remove_marker(marker)
        session.remove_marker(batch_marker)
        select_quote(document, "Batch first wording.")
        marker = session.mark_selection("snappier")
        # Exact quote and whole-document revision are checked again on local acceptance.
        proposal = arguments(session, marker, "Late proposal.", "stale1")
        session.call("suggest_text", proposal)
        document.Text.insertString(document.Text.End, " User edit.", False)
        denied(lambda: session.accept("stale1"))
        session.reject("stale1")
        rule = dict(defaults()["rules"]["snappier"], mode="direct")
        session.save_rule("snappier", rule)
        direct = arguments(session, marker, "Direct authorized wording.", "direct1")
        assert session.call("suggest_text", direct)["status"] == "applied"
        assert "Direct authorized wording." in document.Text.String
        assert next(item for item in session.snapshot()["markers"] if item["id"] == marker)["stale"]
        document.UndoManager.undo()
        assert next(item for item in session.snapshot()["markers"] if item["id"] == marker)["stale"], "Undo revived consumed permission"
        assert session.data["marks"][marker].get("consumed"), "Undo reverted durable permission consumption"
        denied(lambda: session.call("suggest_text", arguments(session, marker, "Do not reapply after Undo.", "undo_replay")))
        document.UndoManager.redo()
        session.remove_marker(marker)
        select_quote(document, "Direct authorized wording.")
        marker = session.mark_selection("snappier")
        # A metadata persistence failure must undo the source mutation, not leave a partial edit.
        before_failure = document.Text.String
        original_store = session.store
        def fail_store(_):
            raise ValueError("Injected metadata write failure")
        session.store = fail_store
        rollback_arguments = arguments(session, marker, "Rollback required.", "rollback1")
        denied(lambda: session.call("suggest_text", rollback_arguments))
        session.store = original_store
        assert document.Text.String == before_failure
        assert document.Bookmarks.hasByName(marker)
        assert session.call("suggest_text", rollback_arguments)["status"] == "outcome_uncertain"
        # A protect overlap always wins over direct access.
        select_quote(document, "authorized")
        overlap = session.mark_selection("protect")
        denied(lambda: session.call("suggest_text", arguments(session, marker, "Cannot replace protected overlap.", "denied1")))
        session.remove_marker(overlap)
        # A suggestion overlap downgrades direct access, including nested marker ranges.
        session.save_rule("suggest", dict(defaults()["rules"]["snappier"], name="Suggestion only"))
        select_quote(document, "authorized")
        nested = session.mark_selection("suggest")
        before = document.Text.String
        assert session.call("suggest_text", arguments(session, marker, "Requires approval.", "overlap1"))["status"] == "pending_local_approval"
        assert document.Text.String == before
        session.reject("overlap1")
        session.remove_marker(nested)
        # Markers and custom rules survive the user's ordinary save/reopen workflow.
        output = Path(output).resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        url = uno.systemPathToFileUrl(str(output))
        document.storeAsURL(url, (property_value("FilterName", "writer8"), property_value("Overwrite", True)))
        session.close()
        document.close(True)
        document = desktop.loadComponentFromURL(url, "_blank", 0, ())
        session = Session(context, document)
        assert marker in session.data["marks"] and protection in session.data["marks"]
        assert session.data["rules"]["snappier"]["mode"] == "direct"
        assert not any(item["stale"] for item in session.snapshot()["markers"])
        assert not session.shared
        # Native popup creation, copy address, modeless Writer selection, callbacks and stop.
        session.panel = Panel(session)
        session.panel.action("connections")
        session.panel.connections.action("start")
        endpoint = session.endpoint.url
        assert rpc(endpoint, "list_manuscripts", {})["manuscripts"] == []
        session.set_shared(True)
        remote = rpc(endpoint, "read_manuscript", {"documentId": session.document_id})
        assert remote["documentId"] == session.document_id
        session.panel.connections.action("copy")
        # Native geometry and minimum label widths, including expansion and minimum restoration.
        panel = session.panel
        def check_geometry():
            size = panel.dialog.getPosSize()
            for name in panel.model.ElementNames:
                control = panel.control(name)
                box = control.getPosSize()
                assert box.X >= 0 and box.Y >= 0 and box.X + box.Width <= size.Width + 2 and box.Y + box.Height <= size.Height + 2, name
                if name in ("mark", "remove", "connections", "inspect", "accept", "reject", "close"):
                    assert control.getMinimumSize().Width <= box.Width + 2, "Clipped native label: " + name
        check_geometry()
        panel.dialog.setPosSize(0, 0, panel.base.Width + 120, panel.base.Height + 100, 12)
        panel.resize()
        check_geometry()
        panel.dialog.setPosSize(0, 0, panel.base.Width - 20, panel.base.Height - 20, 12)
        panel.resize()
        check_geometry()
        original_scheduler = session.async_callback
        class FailedScheduler:
            def addCallback(self, *_):
                raise RuntimeError("Injected callback scheduling failure")
        session.async_callback = FailedScheduler()
        denied(lambda: session.dispatch("list_manuscripts", {}, session.endpoint_id))
        session.async_callback = original_scheduler
        session.drain()
        old_endpoint_id = session.endpoint_id
        session.stop()
        session.start()
        session.set_shared(True)
        denied(lambda: session.dispatch("list_manuscripts", {}, old_endpoint_id))
        # A live bookmark must not disclose newly inserted, unapproved text after it becomes stale.
        anchor = document.Bookmarks.getByName(marker).Anchor
        insert = document.Text.createTextCursorByRange(anchor.Start)
        insert.goRight(2, False)
        document.Text.insertString(insert, "NEW PRIVATE SENTINEL", False)
        private_read = rpc(session.endpoint.url, "read_manuscript", {"documentId": session.document_id})
        assert "NEW PRIVATE SENTINEL" in json.dumps(private_read)
        private_marker = next(item for item in private_read["markers"] if item["id"] == marker)
        assert private_marker["stale"] and private_marker["text"] == ""
        if extension_check:
            parsed = uno.createUnoStruct("com.sun.star.util.URL")
            parsed.Complete, parsed.Protocol, parsed.Path = "vnd.undertree:review", "vnd.undertree:", "review"
            assert document.CurrentController.Frame.queryDispatch(parsed, "_self", 0) is not None, "Installed toolbar protocol not registered"
        session.stop()
        assert not session.shared and session.endpoint is None
        print("PASS: UNO native markers, metadata reopen, Unicode, formatting, suggestion approval, direct permission, overlaps, stale rejection, isolation, popup, HTTP callbacks and revocation")
    finally:
        for item in (session, other):
            if item:
                item.close()
        for item in (document, second):
            try:
                item.setModified(False)
                item.close(True)
            except Exception:
                pass


def bridge_fixture(context, ready_path):
    """Private, disposable marked document for exercising the real Rust gateway."""
    desktop = prepare_desktop(context)
    document = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
    document.Text.String = "PRIVATE UNMARKED CONTEXT\nSuggestion gateway passage.\nDirect gateway passage."
    session = Session(context, document)
    select_quote(document, "Suggestion gateway passage.")
    suggestion = session.mark_selection("snappier")
    session.save_rule("direct", dict(defaults()["rules"]["snappier"], name="Direct gateway rule", mode="direct"))
    select_quote(document, "Direct gateway passage.")
    direct = session.mark_selection("direct")
    session.panel = Panel(session)
    session.set_shared(True)
    endpoint = session.start()
    session.panel.refresh()
    session.panel.dialog.toFront()
    session.panel.control("connections").setFocus()
    ready = Path(ready_path).resolve()
    ready.parent.mkdir(parents=True, exist_ok=True)
    stopped = ready.with_suffix(".stop")
    stopped.unlink(missing_ok=True)
    ready.with_suffix(".result.json").unlink(missing_ok=True)
    ready.write_text(json.dumps({"url": endpoint, "documentId": session.document_id, "suggestionMarker": suggestion, "directMarker": direct}), encoding="utf-8")
    print("Writer gateway fixture ready; capability stored only in the requested private artifact.", flush=True)
    try:
        deadline = time.monotonic() + 600
        while not stopped.exists() and time.monotonic() < deadline and not session.closed:
            time.sleep(0.2)
        if stopped.exists():
            expected = "PRIVATE UNMARKED CONTEXT\nSuggestion gateway passage.\nApplied through the Rust gateway."
            assert document.Text.String == expected, "Gateway unexpectedly altered private or suggestion-only text"
            assert len(session.pending) == 1, "Gateway suggestion did not remain pending local approval"
            ready.with_suffix(".result.json").write_text(json.dumps({"status": "passed", "privateTextUnchanged": True, "suggestionTextUnchanged": True, "pendingSuggestions": 1, "directApplied": True}), encoding="utf-8")
            print("PASS: real Rust gateway left private/suggestion-only text unchanged, queued one suggestion and applied only the explicitly direct range.", flush=True)
    finally:
        session.close()
        ready.unlink(missing_ok=True)
        stopped.unlink(missing_ok=True)
        document.setModified(False)
        document.close(True)


if __name__ == "__main__":
    faulthandler.dump_traceback_later(60, repeat=True)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=2087)
    parser.add_argument("--output", default="artifacts/libreoffice/uno-smoke.odt")
    parser.add_argument("--extension-check", action="store_true")
    parser.add_argument("--fixture", help="Write a private bridge fixture readiness JSON, then wait up to ten minutes for its .stop file")
    args = parser.parse_args()
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    deadline = time.monotonic() + 45
    while True:
        try:
            context = resolver.resolve("uno:socket,host=127.0.0.1,port=%d;urp;StarOffice.ComponentContext" % args.port)
            break
        except Exception:
            if time.monotonic() >= deadline:
                raise
            time.sleep(1)
    if args.fixture:
        bridge_fixture(context, args.fixture)
    else:
        run(context, args.output, args.extension_check)
