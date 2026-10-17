"""Native installed-package color-only and immutable-unit qualification in a disposable Writer."""
import copy
import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace
import sys
import time
import uno
from com.sun.star.connection import NoConnectException

sys.path.insert(0, os.environ.get("UNDERTREE_WRITER_EXTENSION_SOURCE", str(Path(__file__).resolve().parents[1] / "extension")))
from undertree_writer import Session, HighlightInput, property_value
from undertree_policy import defaults, utf16_length
from undertree_ui import Panel, RuleDialog, HighlightRuleChoice


def denied(function):
    try: function()
    except ValueError: return
    raise AssertionError("Unexpected authorization")


def select(document, quote):
    search = document.createSearchDescriptor()
    search.SearchString, search.SearchCaseSensitive = quote, True
    found = document.findFirst(search)
    assert found is not None and found.String == quote
    document.CurrentController.select(found)
    return found


def read(session): return session.call("read_manuscript", {"documentId": session.document_id})


def mark_request(snapshot, ranges, request_id, **extra):
    return {"documentId": snapshot["documentId"], "marking": {"requestId": request_id, "contextId": snapshot["contextId"],
        "revision": snapshot["revision"], "ranges": ranges, **extra}}


def verify_gestures(session, color):
    import undertree_ui
    document = session.document
    select(document, "(One)")
    seen = []
    original_show = undertree_ui.RuleDialog.show
    def inspect(dialog):
        dialog.modal = False
        original_show(dialog)
        assert not dialog.no_fit and dialog.control("save").isVisible()
        seen.append((type(dialog).__name__, dialog.rule_id, dialog.chosen_action()))
        dialog.dispose()
        return None
    undertree_ui.RuleDialog.show = inspect
    try:
        session.edit_toolbar_rule(color)
        observer = HighlightInput(session)
        observer.mouseReleased(SimpleNamespace(Buttons=1, ClickCount=2))
        observer.notify(None)
        assert observer.keyPressed(SimpleNamespace(KeyCode=uno.getConstantByName("com.sun.star.awt.Key.F4"), Modifiers=2))
        observer.notify(None)
        assert seen == [("RuleDialog", color, "neutral")] * 3
        assert session.data["rules"][color]["action"] == "neutral"
    finally:
        undertree_ui.RuleDialog.show = original_show
    select(document, "(One)")
    overlap = session.mark_selection("protect")
    marks = session.highlight_rule_candidates()
    assert len(marks) == 2
    panel = SimpleNamespace(session=session, dialog=SimpleNamespace(getPeer=lambda: document.CurrentController.Frame.ContainerWindow))
    choice = HighlightRuleChoice(panel, marks)
    choice.modal = False
    choice.show()
    try:
        assert not choice.no_fit and choice.control("choices").getItemCount() == 2
        assert choice.control("choices").getSelectedItemPos() == -1
        denied(lambda: choice.action("open"))
        choice.control("choices").selectItemPos(1, True)
        expected = marks[1]["ruleId"]
        choice.action("open")
        assert choice.result == expected
    finally:
        choice.dispose()
    session.remove_marker(overlap)
    return "native_toolbar_intext_keyboard_same_dialog_explicit_overlap_choice"


def verify_continuous_group(context):
    desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
    document = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
    session = None
    try:
        original = "Intro alpha\nbeta end."
        document.Text.String = original
        session = Session(context, document)
        selected = select(document, "beta")
        selected.ParaAdjust = uno.Enum("com.sun.star.style.ParagraphAdjust", "CENTER")
        centered = selected.ParaAdjust
        assert centered != 0
        cursor = session.document_range(session.snapshot(), 6, 16)
        assert cursor.String == "alpha\nbeta"
        document.CurrentController.select(cursor)
        group = session.mark_selection("protect")
        session.save_rule("outer", dict(defaults()["rules"]["snappier"], mode="direct"))
        cursor = document.Text.createTextCursor(); cursor.gotoEnd(True)
        document.CurrentController.select(cursor); session.mark_selection("outer")
        session.set_shared(True)
        current = read(session)
        payload = {"documentId": session.document_id, "proposal": {"requestId": "continuous-rich-group", "revision": current["revision"],
            "contextId": current["contextId"], "from": 0, "to": utf16_length(original), "quote": original, "replacement": "",
            "replacementParts": [{"text": "Rewritten "}, {"protectedId": group}, {"text": "."}], "rationale": "continuous native group"}}
        result = session.call("suggest_text", payload)
        assert result["status"] == "applied" and document.Text.String == "Rewritten alpha\nbeta."
        assert document.Bookmarks.getByName(group).Anchor.String == "alpha\nbeta"
        assert select(document, "beta").ParaAdjust == centered
        document.UndoManager.undo(); assert document.Text.String == original
        document.UndoManager.redo(); assert document.Text.String == "Rewritten alpha\nbeta."
        return "continuous_multiline_group_layout_identity_undo_redo"
    finally:
        if session: session.close()
        document.setModified(False)
        try: document.close(True)
        except Exception: document.dispose()


def verify_fields(context):
    desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
    document = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
    session = None
    try:
        document.Text.String = "First "
        fields = []
        for identifier, separator in (("Smith2020", " then "), ("Jones2021", ".")):
            field = document.createInstance("com.sun.star.text.TextField.Bibliography")
            field.Fields = (property_value("Identifier", identifier), property_value("Author", identifier[:-4]),
                            property_value("Year", identifier[-4:]), property_value("BibliographicType", 0))
            cursor = document.Text.createTextCursor(); cursor.gotoEnd(False)
            document.Text.insertTextContent(cursor, field, False)
            cursor = document.Text.createTextCursor(); cursor.gotoEnd(False)
            document.Text.insertString(cursor, separator, False)
            fields.append(field)
        original = document.Text.String
        session = Session(context, document)
        units = []
        for field in fields:
            document.CurrentController.select(field.Anchor)
            units.append(session.mark_selection("protect"))
        session.save_rule("outer", dict(defaults()["rules"]["snappier"], mode="direct"))
        cursor = document.Text.createTextCursor(); cursor.gotoEnd(True)
        document.CurrentController.select(cursor); session.mark_selection("outer")
        session.set_shared(True)
        current = read(session)
        proposal = {"documentId": session.document_id, "proposal": {"requestId": "native-fields", "revision": current["revision"],
            "contextId": current["contextId"], "from": 0, "to": utf16_length(original), "quote": original, "replacement": "",
            "replacementParts": [{"protectedId": units[1]}, {"text": " before "}, {"protectedId": units[0]}, {"text": "."}], "rationale": "Native field preservation"}}
        foreign = document.createInstance("com.sun.star.text.Bookmark")
        foreign.Name = "UnderTree_foreign_user_bookmark"
        document.Text.insertTextContent(document.Bookmarks.getByName(units[0]).Anchor, foreign, True)
        forged = copy.deepcopy(proposal)
        current = read(session)
        forged["proposal"].update(requestId="foreign-native-identity", contextId=current["contextId"], revision=current["revision"])
        denied(lambda: session.call("suggest_text", forged))
        assert document.Text.String == original and foreign.Anchor.String == "[Smith2020]"
        document.Text.removeTextContent(foreign)
        current = read(session)
        proposal["proposal"].update(contextId=current["contextId"], revision=current["revision"])
        expected_fields = [{prop.Name: prop.Value for prop in field.Fields} for field in fields]
        result = session.call("suggest_text", proposal)
        assert result["status"] == "applied" and document.Text.String == "[Jones2021] before [Smith2020]."
        enumeration = document.TextFields.createEnumeration(); actual = []
        while enumeration.hasMoreElements(): actual.append({prop.Name: prop.Value for prop in enumeration.nextElement().Fields})
        assert len(actual) == 2 and all(record in actual for record in expected_fields)
        assert document.Bookmarks.getByName(units[0]).Anchor.String == "[Smith2020]"
        assert document.Bookmarks.getByName(units[1]).Anchor.String == "[Jones2021]"
        document.UndoManager.undo()
        assert document.Text.String == original
        document.UndoManager.redo()
        assert document.Text.String == "[Jones2021] before [Smith2020]."
        return "native_bibliographic_fields_metadata_identity_undo_redo"
    finally:
        if session: session.close()
        document.setModified(False)
        try: document.close(True)
        except Exception: document.dispose()


def run(context, output):
    desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
    document = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
    session = None
    checks = [verify_fields(context), verify_continuous_group(context)]
    try:
        text = "A (One) and (Two) with 😀 context."
        document.Text.String = text
        session = Session(context, document)
        session.set_shared(True)
        unrecorded = session.snapshot()
        unrecorded["contextId"] = "forged-complete-read"
        denied(lambda: session.call("highlight_text", mark_request(unrecorded, [{"from": 2, "to": 7, "quote": "(One)"}], "missing-full-read")))
        snapshot = read(session)
        ranges = [{"from": 2, "to": 7, "quote": "(One)"}, {"from": 12, "to": 17, "quote": "(Two)"}]
        payload = mark_request(snapshot, ranges, "ai-colors")
        for extra in ({"prompt": "edit"}, {"action": "edit"}, {"colorId": "snappier"}):
            forged = copy.deepcopy(payload)
            forged["marking"].update(extra)
            denied(lambda: session.call("highlight_text", forged))
        bad = mark_request(snapshot, ranges + [{"from": 18, "to": 22, "quote": "bad"}], "bad-batch")
        denied(lambda: session.call("highlight_text", bad))
        assert session.data["marks"] == {} and document.Text.String == text
        result = session.call("highlight_text", payload)
        assert result["status"] == "highlighted" and not result["editAuthorized"] and not result["saved"]
        color = result["colorId"]
        markers = result["markerIds"]
        assert len(markers) == 2 and session.data["rules"][color]["action"] == "neutral"
        assert document.Text.String == text
        assert session.call("highlight_text", payload)["replayed"]
        document.UndoManager.undo()
        assert not session.data["marks"] and color not in session.data["rules"] and document.Text.String == text
        document.UndoManager.redo()
        assert set(markers) == set(session.data["marks"]) and color in session.data["rules"]
        checks.append("atomic_neutral_batch_replay_and_undo_redo")
        checks.append(verify_gestures(session, color))
        current = read(session)
        reuse = session.call("highlight_text", mark_request(current, [{"from": 18, "to": 22, "quote": "with"}], "reuse-neutral", colorId=color))
        assert reuse["colorId"] == color and len(session.data["rules"]) == 5
        session.remove_marker(reuse["markerIds"][0])
        before_failed_batch = copy.deepcopy(session.data)
        current = read(session)
        failed_payload = mark_request(current, [{"from": 18, "to": 22, "quote": "with"}], "failed-batch")
        original_store = session.store
        calls = []
        def fail_first_store(data, authority=True):
            calls.append(True)
            if len(calls) == 1:
                raise ValueError("Injected atomic metadata failure")
            return original_store(data, authority)
        session.store = fail_first_store
        try:
            denied(lambda: session.call("highlight_text", failed_payload))
        finally:
            session.store = original_store
        assert session.data == before_failed_batch and document.Text.String == text
        assert session.call("highlight_text", failed_payload)["status"] == "outcome_uncertain"
        assert set(document.Bookmarks.ElementNames) == set(before_failed_batch["marks"])
        checks.append("prior_read_neutral_reuse_and_atomic_failure_rollback")
        current = read(session)
        proposal = {"documentId": session.document_id, "proposal": {"requestId": "no-neutral-edit", "contextId": current["contextId"],
            "revision": current["revision"], "from": 2, "to": 7, "quote": "(One)", "replacement": "changed", "rationale": "denied"}}
        denied(lambda: session.call("suggest_text", proposal))
        stale_neutral = read(session)
        session.save_rule(color, dict(session.data["rules"][color], action="protect"))
        denied(lambda: session.call("highlight_text", mark_request(stale_neutral, ranges, "concurrent-local-assignment", colorId=color)))
        denied(lambda: session.call("highlight_text", mark_request(read(session), ranges, "cannot-reuse-assigned", colorId=color)))
        for mode in ("suggestion", "direct"):
            if mode == "direct":
                for marker in list(session.data["marks"]): session.remove_marker(marker)
                document.Text.String = text
                session.save_rule(color, dict(session.data["rules"][color], action="protect"))
                for quote in ("(One)", "(Two)"):
                    selected = select(document, quote)
                    selected.CharWeight = 150.0
                    selected.HyperLinkURL = "https://example.org/citation/" + quote[1:4]
                    if quote == "(One)":
                        mixed = document.Text.createTextCursorByRange(selected.Start)
                        mixed.goRight(2, True)
                        mixed.CharPosture = uno.Enum("com.sun.star.awt.FontSlant", "ITALIC")
                    session.mark_selection(color)
            session.save_rule("outer", dict(defaults()["rules"]["snappier"], mode=mode))
            select(document, text)
            outer = session.mark_selection("outer")
            if mode == "direct":
                assert select(document, "(One)").CharWeight == 150.0, "Bold missing before rewrite"
                assert select(document, "(One)").HyperLinkURL == "https://example.org/citation/One", "Link missing before rewrite"
            current = read(session)
            units = [mark for mark in current["markers"] if mark["action"] == "protect"]
            one = next(mark for mark in units if mark["text"] == "(One)")
            two = next(mark for mark in units if mark["text"] == "(Two)")
            parts = [{"text": "Rewritten "}, {"protectedId": two["id"]}, {"text": " then "}, {"protectedId": one["id"]}, {"text": "."}]
            change = {"documentId": session.document_id, "proposal": {"requestId": "rewrite-" + mode, "contextId": current["contextId"],
                "revision": current["revision"], "from": 0, "to": utf16_length(text), "quote": text, "replacement": "", "replacementParts": parts, "rationale": "native proof"}}
            result = session.call("suggest_text", change)
            if mode == "suggestion":
                assert document.Text.String == text
                session.accept(change["proposal"]["requestId"])
            assert document.Text.String == "Rewritten (Two) then (One)."
            for unit in (one, two):
                anchor = document.Bookmarks.getByName(unit["id"]).Anchor
                assert anchor.String == unit["text"]
                assert not next(mark for mark in session.snapshot()["markers"] if mark["id"] == unit["id"])["stale"]
                if mode == "direct":
                    assert anchor.CharWeight == 150.0 and anchor.HyperLinkURL == "https://example.org/citation/" + unit["text"][1:4], (unit["text"], anchor.CharWeight, anchor.HyperLinkURL)
                    if unit["text"] == "(One)":
                        mixed = document.Text.createTextCursorByRange(anchor.Start)
                        mixed.goRight(2, True)
                        assert mixed.CharPosture.value == "ITALIC"
            document.UndoManager.undo()
            assert document.Text.String == text
            assert all(document.Bookmarks.getByName(unit["id"]).Anchor.String == unit["text"] for unit in (one, two))
            document.UndoManager.redo()
            assert document.Text.String == "Rewritten (Two) then (One)."
            checks.append(mode + "_protected_reorder_format_identity_undo_redo")
        destination = Path(output).resolve()
        document.storeAsURL(uno.systemPathToFileUrl(str(destination)), (property_value("FilterName", "writer8"),))
        session.close(); session = None
        document.close(True)
        document = desktop.loadComponentFromURL(uno.systemPathToFileUrl(str(destination)), "_blank", 0, ())
        session = Session(context, document)
        assert not session.shared and len(session.data["marks"]) == 3
        assert all(document.Bookmarks.getByName(unit["id"]).Anchor.String == unit["text"] for unit in (one,two))
        checks.append("native_save_reopen_protection_and_no_restored_consent")
        session.set_shared(True)
        current = read(session)
        session.set_shared(False)
        denied(lambda: session.call("highlight_text", mark_request(current, ranges, "revoked")))
        checks.append("revoked_highlight")
        destination.with_suffix(".json").write_text(json.dumps({"status": "passed", "checks": checks,
            "source": str(Path(sys.modules["undertree_writer"].__file__).resolve()), "documentSha256": hashlib.sha256(destination.read_bytes()).hexdigest()}, indent=2))
        print("PASS: " + ", ".join(checks), flush=True)
    finally:
        if session: session.close()
        document.setModified(False)
        try: document.close(True)
        except Exception: document.dispose()


if __name__ == "__main__":
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    deadline = time.monotonic() + 45
    while True:
        try:
            context = resolver.resolve("uno:socket,host=127.0.0.1,port=" + sys.argv[1] + ";urp;StarOffice.ComponentContext")
            break
        except NoConnectException:
            if time.monotonic() >= deadline:
                raise
            time.sleep(.2)
    run(context, sys.argv[2])
