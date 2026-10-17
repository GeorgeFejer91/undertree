"""Native neutral coloration and local color-rule entry points for Writer sessions."""
import copy
import uuid

import unohelper
from com.sun.star.document import XUndoAction

from undertree_policy import authorize_highlight, utf16_length, utf16_slice
from undertree_fragments import capture as capture_fragment


class MetadataUndo(unohelper.Base, XUndoAction):
    def __init__(self, session, title, before, after):
        self.session, self.Title = session, title
        self.before, self.after = copy.deepcopy(before), copy.deepcopy(after)

    def getTitle(self): return self.Title

    def restore(self, value):
        restored = copy.deepcopy(value)
        restored["pending"] = copy.deepcopy(self.session.data.get("pending", []))
        for marker_id in self.session.consumed_markers:
            if marker_id in restored["marks"] and restored["rules"][restored["marks"][marker_id]["rule"]]["action"] in ("edit", "discard"):
                restored["marks"][marker_id]["consumed"] = True
        self.session.store(restored)
        self.session.refresh_toolbar()

    def undo(self): self.restore(self.before)
    def redo(self): self.restore(self.after)


class HighlightAuthority:
    def highlight_rule_candidates(self):
        selection = self.document.CurrentController.getSelection()
        if not hasattr(selection, "getCount") or selection.getCount() != 1:
            raise ValueError("Place the caret inside a highlight first.")
        selected = selection.getByIndex(0)
        prefix = self.document.Text.createTextCursorByRange(self.document.Text.Start)
        try:
            prefix.gotoRange(selected.Start, True)
        except Exception:
            raise ValueError("Choose a main-body highlight.") from None
        start = utf16_length(prefix.String)
        end = start + utf16_length(selected.String)
        return [mark for mark in self.snapshot(complete=False)["markers"] if mark["start"] >= 0 and mark["end"] > mark["start"] and
                ((mark["start"] <= start < mark["end"]) if start == end else (mark["start"] < end and start < mark["end"]))]

    def edit_highlight_rule(self):
        from undertree_ui import HighlightRuleChoice
        from types import SimpleNamespace
        marks = self.highlight_rule_candidates()
        if not marks:
            raise ValueError("Place the caret inside a highlight. Ctrl+F4 opens its color rule.")
        if len(marks) == 1:
            self.edit_toolbar_rule(marks[0]["ruleId"])
            return
        panel = self.panel if self.panel and not self.panel.disposed else SimpleNamespace(
            session=self, dialog=SimpleNamespace(getPeer=lambda: self.document.CurrentController.Frame.ContainerWindow))
        rule_id = HighlightRuleChoice(panel, marks).show()
        if rule_id:
            self.edit_toolbar_rule(rule_id)

    def document_range(self, snapshot, start, end):
        whole = {"id": "body", "start": 0, "text": snapshot["content"]}
        cursor = self.native_point(whole, start)
        cursor.gotoRange(self.native_point(whole, end).Start, True)
        if cursor.String != utf16_slice(snapshot["content"], start, end):
            raise ValueError("Native Unicode range changed.")
        return cursor

    def check_rewrite_identities(self, cursor):
        body = self.document.Text
        for collection, owned in ((self.document.Bookmarks, self.data["marks"]), (self.document.ReferenceMarks, {})):
            names = collection.ElementNames
            if len(names) > 4096:
                raise ValueError("Native bookmark/reference identities exceed the safe reconstruction bound.")
            for name in names:
                if name in owned:
                    continue
                anchor = collection.getByName(name).Anchor
                try:
                    before = body.compareRegionStarts(anchor.End, cursor.Start) > 0
                    after = body.compareRegionStarts(anchor.Start, cursor.End) < 0
                except Exception:
                    continue
                if not before and not after:
                    raise ValueError("This rewrite crosses a native bookmark/reference identity outside wrAIter. It remains protected in place.")

    def prepare_rewrite(self, snapshot, permission):
        cursor = self.document_range(snapshot, permission["start"], permission["end"])
        anchors = tuple(self.document.Bookmarks.getByName(item["marker"]["id"]).Anchor for item in permission["protected"])
        self.check_plain_range(cursor, protected=anchors)
        self.check_rewrite_identities(cursor)
        return cursor, self.validate_protected_native(permission["protected"])

    def validate_protected_native(self, placements):
        captured = {}
        total = 0
        for placement in placements:
            mark = placement["marker"]
            anchor = self.document.Bookmarks.getByName(mark["id"]).Anchor
            cursor = self.document.Text.createTextCursorByRange(anchor.Start)
            cursor.gotoRange(anchor.End, True)
            self.check_plain_range(cursor, allow_fields=True)
            self.check_rewrite_identities(cursor)
            if cursor.String != mark["text"]:
                raise ValueError("Protected native text changed.")
            fragment = capture_fragment(self.document, cursor, self.data["marks"])
            total += len(fragment.raw)
            if total > 8388608:
                raise ValueError("Protected native fragments exceed the 8 MiB reconstruction bound.")
            captured[mark["id"]] = fragment
        return captured

    def highlight_text(self, arguments):
        if set(arguments) != {"documentId", "marking"} or arguments["documentId"] != self.document_id or not isinstance(arguments["marking"], dict):
            raise ValueError("Supply only this shared documentId and marking object.")
        marking = arguments["marking"]
        request_id = marking.get("requestId")
        receipt_key = "highlight:" + request_id if isinstance(request_id, str) else None
        if isinstance(request_id, str) and (request_id in self.receipts or request_id in self.pending):
            raise ValueError("This requestId already belongs to a wording proposal.")
        if receipt_key in self.receipts:
            old, result = self.receipts[receipt_key]
            if old != marking:
                raise ValueError("This requestId already has different marking arguments.")
            return dict(copy.deepcopy(result), replayed=True, documentChanged=False)
        if len(self.receipts) >= 500:
            raise ValueError("This session reached its request limit. Stop and restart access locally.")
        snapshot = self.snapshot()
        color_id, rule = authorize_highlight(snapshot, marking, self.data)
        if self.context_reads.get(marking["contextId"]) != (snapshot["revision"], self.generation, self.endpoint_id):
            raise ValueError("Read complete current context before highlighting; contextId is missing, stale or forged.")
        cursors = [self.document_range(snapshot, item["from"], item["to"]) for item in marking["ranges"]]
        for cursor in cursors:
            self.check_plain_range(cursor, allow_fields=True)
        if self.active_task:
            frame = self.document.CurrentController.Frame
            if frame.ContainerWindow.isActive() or frame.ComponentWindow.hasFocus():
                raise ValueError("Finish typing in Writer before adding AI highlights.")
            if self.active_task["cancelled"] or self.active_task["generation"] != self.generation or self.active_task["endpointId"] != self.endpoint_id:
                raise ValueError("Marking request expired or access changed.")
        before = copy.deepcopy(self.data)
        data = copy.deepcopy(before)
        color_id = color_id or "color_" + uuid.uuid4().hex
        data["rules"][color_id] = rule
        identifiers = []
        title = "wrAIter: AI color-only batch " + uuid.uuid4().hex[:8]
        failure = None
        self.document.UndoManager.enterUndoContext(title)
        try:
            for cursor in cursors:
                identifier = "UnderTree_" + uuid.uuid4().hex
                bookmark = self.document.createInstance("com.sun.star.text.Bookmark")
                bookmark.Name = identifier
                data["marks"][identifier] = {"rule": color_id, "quote": cursor.String, "consumed": False, "prompt": ""}
                self.document.Text.insertTextContent(cursor, bookmark, True)
                cursor.CharBackColor = int(rule["color"][1:], 16)
                identifiers.append(identifier)
            if self.document.Text.String != snapshot["content"]:
                raise ValueError("Coloration changed document wording.")
            self.store(data)
            self.document.UndoManager.addUndoAction(MetadataUndo(self, title, before, data))
        except Exception as error:
            failure = error
        finally:
            self.document.UndoManager.leaveUndoContext()
        if failure:
            manager = self.document.UndoManager
            if manager.isUndoPossible() and manager.getCurrentUndoActionTitle() == title:
                manager.undo()
            self.store(before)
            self.receipts[receipt_key] = (copy.deepcopy(marking), {"status": "outcome_uncertain", "requestId": request_id})
            raise ValueError("AI coloration failed; inspect native Undo locally before retrying.") from failure
        result = {"status": "highlighted", "requestId": request_id, "colorId": color_id, "markerIds": identifiers,
                  "action": "neutral", "editAuthorized": False, "saved": False, "documentChanged": True, "manuscriptChanged": False}
        self.receipts[receipt_key] = (copy.deepcopy(marking), result)
        self.refresh_toolbar()
        return result

