"""Writer toolbar component. UNO remains the only document authority."""
import copy
import json
import os
import queue
import sys
import threading
import uuid
from collections import OrderedDict

import uno
import unohelper
from com.sun.star.awt import XCallback
from com.sun.star.awt import XKeyHandler, XMouseClickHandler
from com.sun.star.document import XDocumentEventListener
from com.sun.star.document import XUndoAction
from com.sun.star.frame import XDispatch, XDispatchProvider
from com.sun.star.frame import XTerminateListener
from com.sun.star.lang import XInitialization, XServiceInfo
from com.sun.star.util import XModifyListener
from com.sun.star.task import XJob

# LibreOffice expands the OXT into its user extension cache.
sys.path.insert(0, os.path.dirname(__file__))
from undertree_policy import (PROPERTY, MAX_MARKS, MAX_RULES, MAX_TEXT, MAX_REPLACEMENT,
                              CONTRACT, authorize, defaults, digest, public_snapshot, reconstruct, validate_metadata, validate_rule,
                              utf16_length, utf16_slice)
from undertree_mcp import Endpoint
from undertree_context import collect_context
from undertree_fragments import capture as capture_fragment, restore_paragraphs, verify_paragraphs
from undertree_highlights import HighlightAuthority, MetadataUndo

IMPLEMENTATION = "org.undertree.WriterReview"
SERVICES = ("com.sun.star.frame.ProtocolHandler",)
SESSIONS = {}
CONNECTION = None
STARTUP_CALLBACKS = []


class HighlightInput(unohelper.Base, XMouseClickHandler, XKeyHandler, XCallback):
    """Observe completed native selections; marking never consumes editor input."""
    def __init__(self, session):
        self.session, self.queued = session, False
        self.selection_before, self.selection_generation, self.selection_key = None, None, None
        self.open_rules = False

    def mousePressed(self, event):
        if event.Buttons & 1:
            self.selection_before = self.session.capture_selection()
            self.selection_generation = self.session.generation
        return False

    def mouseReleased(self, event):
        if event.Buttons & 1:
            if event.ClickCount >= 2:
                self.open_rules = True
                self.session.async_callback.addCallback(self, None)
            else:
                self.schedule()
        return False

    def keyPressed(self, event):
        if event.KeyCode == uno.getConstantByName("com.sun.star.awt.Key.F4") and event.Modifiers & 2:
            self.open_rules = True
            self.session.async_callback.addCallback(self, None)
            return True
        if event.KeyCode == uno.getConstantByName("com.sun.star.awt.Key.ESCAPE"):
            self.session.armed_rule = None
            self.session.refresh_toolbar()
        navigation = {uno.getConstantByName("com.sun.star.awt.Key." + name)
                      for name in ("LEFT", "RIGHT", "UP", "DOWN", "HOME", "END", "PAGEUP", "PAGEDOWN")}
        if (event.Modifiers & 1 and event.KeyCode in navigation) or (
                event.Modifiers & 2 and event.KeyCode == uno.getConstantByName("com.sun.star.awt.Key.A")):
            self.selection_before = self.session.capture_selection()
            self.selection_generation = self.session.generation
            self.selection_key = event.KeyCode
        return False

    def keyReleased(self, event):
        if event.KeyCode == self.selection_key:
            self.selection_key = None
            self.schedule()
        return False

    def schedule(self):
        if self.session.armed_rule and not self.queued and not self.session.closed:
            self.queued = True
            self.session.async_callback.addCallback(self, None)

    def notify(self, _):
        self.queued = False
        if self.open_rules:
            self.open_rules = False
            if not self.session.closed:
                try:
                    self.session.edit_highlight_rule()
                except ValueError as error:
                    self.session.toolbar_message(str(error))
            return
        if self.session.closed or not self.session.armed_rule or self.selection_generation != self.session.generation:
            return
        capture = self.session.capture_selection()
        if capture and capture != self.selection_before:
            try:
                self.session.mark_or_arm(self.session.armed_rule, capture)
            except Exception as error:
                self.session.toolbar_message(str(error) if isinstance(error, ValueError) else "Writer could not highlight this selection.")

    def disposing(self, _): pass


def property_value(name, value):
    item = uno.createUnoStruct("com.sun.star.beans.PropertyValue")
    item.Name, item.Value = name, value
    return item


class UiCallback(unohelper.Base, XCallback):
    def __init__(self, session):
        self.session = session

    def notify(self, _):
        self.session.drain()


class DocumentListener(unohelper.Base, XDocumentEventListener, XModifyListener):
    def __init__(self, session):
        self.session = session

    def documentEventOccured(self, event):
        if event.EventName in ("OnUnload", "OnPrepareUnload"):
            self.session.close()
        elif not self.session.closed:
            self.session.protect_project_document()

    def modified(self, _):
        # Even an edit followed by Undo must invalidate earlier proposals.
        if not self.session.metadata_write_depth:
            self.session.generation += 1
            self.session.context_reads.clear()

    def disposing(self, _):
        self.session.close()


class PolicyUndo(unohelper.Base, XUndoAction):
    """Writer does not put custom document properties into its native undo groups."""
    def __init__(self, session, title, collection, key, before, after):
        self.session, self.title, self.collection, self.key = session, title, collection, key
        self.Title = title
        self.before, self.after = copy.deepcopy(before), copy.deepcopy(after)

    def getTitle(self):
        return self.title

    def restore(self, value):
        try:
            self.session.load()
            data = copy.deepcopy(self.session.data)
            if value is None:
                data[self.collection].pop(self.key, None)
            else:
                value = copy.deepcopy(value)
                if self.collection == "marks" and self.key in self.session.consumed_markers:
                    value["consumed"] = True
                data[self.collection][self.key] = value
            self.session.store(data)
        except Exception:
            self.session.stop()
            raise

    def undo(self):
        self.restore(self.before)

    def redo(self):
        self.restore(self.after)


class Session(HighlightAuthority):
    def __init__(self, context, document, connection=None):
        self.context, self.document = context, document
        self.document_id = uuid.uuid4().hex
        self.generation = 0
        self.shared = False
        self.closed = False
        self.endpoint = None
        self.endpoint_id = None
        self.panel = None
        self.connections = None
        self.connection = connection
        self.armed_rule = None
        self.highlight_input = None
        self.toolbar_error = ""
        self.pending = OrderedDict()
        self.pending_bindings = {}
        self.receipts = OrderedDict()
        self.context_reads = OrderedDict()
        self.consumed_markers = set()
        self.work = queue.Queue(8)
        self.active_task = None
        self.metadata_write_depth = 0
        self.async_callback = context.ServiceManager.createInstanceWithContext("com.sun.star.awt.AsyncCallback", context)
        self.callback = UiCallback(self)
        self.listener = DocumentListener(self)
        document.addDocumentEventListener(self.listener)
        document.addModifyListener(self.listener)
        self.load()
        self.restore_pending()
        self.protect_project_document()

    def protect_project_document(self):
        if self.connection and getattr(self.connection, "project", None) is not None:
            url = self.document.URL
            path = uno.fileUrlToSystemPath(url) if url.startswith("file:") else None
            self.connection.protect_document(self.document_id, path)

    def attach_toolbar(self):
        if self.highlight_input is None:
            self.highlight_input = HighlightInput(self)
            controller = self.document.CurrentController
            controller.addMouseClickHandler(self.highlight_input)
            controller.addKeyHandler(self.highlight_input)

    def refresh_toolbar(self):
        try:
            from undertree_toolbar import refresh_toolbars
            refresh_toolbars(self.document)
        except ImportError:
            pass
        if self.panel and not self.panel.disposed:
            self.panel.refresh()

    def toolbar_message(self, message):
        self.toolbar_error = message
        if self.panel and not self.panel.disposed:
            self.panel.status(message)

    def capture_selection(self):
        try:
            selection = self.document.CurrentController.getSelection()
            if selection.getCount() != 1:
                return None
            selected = selection.getByIndex(0)
            if not selected.String:
                return None
            body = self.document.Text
            body.compareRegionStarts(selected.Start, body.Start)
            cursor = body.createTextCursorByRange(body.Start)
            cursor.gotoRange(selected.Start, True)
            return (self.generation, utf16_length(cursor.String), selected.String)
        except Exception:
            return None

    def mark_or_arm(self, rule_id, capture=None):
        self.load()
        if rule_id not in self.data["rules"]:
            raise ValueError("This color rule changed. Choose a current color.")
        self.armed_rule = rule_id
        current = self.capture_selection()
        if current and (capture is None or current == capture):
            # Re-clicking an already marked selection does not add duplicate permissions.
            existing = self.snapshot(complete=False)["markers"]
            if not any(item["ruleId"] == rule_id and not item["stale"] and item.get("start") == current[1]
                       and item.get("text") == current[2] for item in existing):
                self.mark_selection(rule_id)
        self.refresh_toolbar()

    def show_panel(self):
        if self.panel is None or self.panel.disposed:
            self.panel = Panel(self)
        else:
            self.panel.dialog.setVisible(True)
            self.panel.dialog.toFront()
        return self.panel

    def show_connections(self):
        from types import SimpleNamespace
        from undertree_ui import Connections
        if self.connections is None or self.connections.disposed:
            owner = self.panel if self.panel and not self.panel.disposed else SimpleNamespace(
                session=self, connections=None,
                dialog=SimpleNamespace(getPeer=lambda: self.document.CurrentController.Frame.ContainerWindow))
            self.connections = Connections(owner)
            owner.connections = self.connections
            self.connections.show()
        else:
            self.connections.dialog.setVisible(True)
            self.connections.dialog.toFront()
        return self.connections

    def edit_toolbar_rule(self, rule_id=None):
        from undertree_ui import RuleDialog
        from types import SimpleNamespace
        panel = self.panel if self.panel and not self.panel.disposed else SimpleNamespace(
            session=self, dialog=SimpleNamespace(getPeer=lambda: self.document.CurrentController.Frame.ContainerWindow))
        result = RuleDialog(panel, rule_id).show()
        if result and self.panel and not self.panel.disposed:
            panel.selected_rule = result
        self.refresh_toolbar()

    def load(self):
        properties = self.document.DocumentProperties.UserDefinedProperties
        if properties.PropertySetInfo.hasPropertyByName(PROPERTY):
            raw = properties.getPropertyValue(PROPERTY)
            if not isinstance(raw, str) or len(raw) > 2000000:
                raise ValueError("Invalid wrAIter metadata; original data was preserved.")
            self.data = validate_metadata(json.loads(raw))
        else:
            self.data = defaults()
        # Earlier metadata alphabetized object keys. Recover the shared default
        # slots, then retain insertion order for every custom rule thereafter.
        rules = self.data["rules"]
        order = [rule["id"] for rule in CONTRACT["defaultRules"] if rule["id"] in rules]
        order.extend(key for key in rules if key not in order)
        self.data["rules"] = {key: rules[key] for key in order}

    def store(self, data, authority=True):
        validate_metadata(data)
        raw = json.dumps(data, ensure_ascii=False)
        if len(raw) > 2000000:
            raise ValueError("wrAIter metadata exceeds its size limit.")
        properties = self.document.DocumentProperties.UserDefinedProperties
        self.metadata_write_depth += 1
        try:
            if properties.PropertySetInfo.hasPropertyByName(PROPERTY):
                properties.setPropertyValue(PROPERTY, raw)
            else:
                properties.addProperty(PROPERTY, 128, raw)  # REMOVABLE
        finally:
            self.metadata_write_depth -= 1
        self.data = data
        if authority:
            self.generation += 1
            self.context_reads.clear()

    def pending_binding(self, snapshot):
        sources = [{"path": item["path"], "content": item["content"]} for item in snapshot["context"]["files"]]
        return (digest(snapshot["content"], sources), digest("", {"rules": self.data["rules"], "marks": self.data["marks"], "ranges": snapshot["markers"]}))

    def restore_pending(self):
        if not self.data.get("pending"):
            return
        try:
            snapshot = self.snapshot()
            current_binding = self.pending_binding(snapshot)
        except ValueError:
            snapshot, current_binding = None, None
        for record in self.data.get("pending", []):
            proposal = dict(record["proposal"], revision=snapshot["revision"] if snapshot else "stale", contextId="local-restored")
            request_id = proposal["requestId"]
            self.pending_bindings[request_id] = (record["sourceDigest"], record["policyDigest"])
            if self.pending_bindings[request_id] != current_binding:
                proposal["revision"] = "stale"
            self.pending[request_id] = proposal

    def persist_pending(self):
        data = copy.deepcopy(self.data)
        data["pending"] = []
        for request_id, proposal in self.pending.items():
            binding = self.pending_bindings[request_id]
            data["pending"].append({"proposal": {key: value for key, value in proposal.items() if key not in ("revision", "contextId")},
                                    "sourceDigest": binding[0], "policyDigest": binding[1]})
        self.store(data, authority=False)

    def snapshot(self, complete=True, attempt=0):
        if self.closed:
            raise ValueError("Writer document is closed.")
        self.load()
        body = self.document.Text
        text = body.String
        if len(text) > MAX_TEXT:
            raise ValueError("This document exceeds the two-million-character review limit.")
        observed_generation = self.generation
        context = collect_context(self.document) if complete else {"content": "", "context": {"complete": False}}
        markers = []
        for marker_id, mark in self.data["marks"].items():
            rule = self.data["rules"][mark["rule"]]
            item = {"id": marker_id, "ruleId": mark["rule"], "name": rule["name"], "color": rule["color"],
                    "prompt": "\n".join(value for value in (rule["prompt"], mark.get("prompt", "")) if value),
                    "passagePrompt": mark.get("prompt", ""), "action": rule["action"], "mode": rule["mode"],
                    "text": "", "start": -1, "end": -1, "stale": True}
            if self.document.Bookmarks.hasByName(marker_id):
                anchor = self.document.Bookmarks.getByName(marker_id).Anchor
                try:
                    prefix = body.createTextCursorByRange(body.Start)
                    prefix.gotoRange(anchor.Start, True)
                    item["start"] = utf16_length(prefix.String)
                    item["text"] = anchor.String
                    item["end"] = item["start"] + utf16_length(anchor.String)
                    item["stale"] = item["text"] != mark["quote"] or not anchor.String or mark.get("consumed", False) or marker_id in self.consumed_markers
                except Exception:
                    pass  # A non-main-body or missing anchor denies changes.
            markers.append(item)
        if self.generation != observed_generation:
            if attempt < 2:
                return self.snapshot(complete, attempt + 1)
            raise ValueError("Writer changed while context was collected. Read the complete document again.")
        policy = {key: self.data[key] for key in ("version", "rules", "marks")}
        revision = digest(text, {"session": self.document_id, "data": policy, "ranges": markers, "context": context,
                                 "generation": self.generation, "shared": self.shared})
        if complete:
            for file in context["context"]["files"]:
                file["revision"] = digest(file["content"], {})
                file["sourceEpoch"] = self.generation
        return {"documentId": self.document_id, "revision": revision, "markers": markers, **context, "content": text}

    def save_rule(self, rule_id, rule):
        self.load()
        validate_rule(rule)
        if rule_id not in self.data["rules"] and len(self.data["rules"]) >= MAX_RULES:
            raise ValueError("At most 24 color rules can be saved.")
        data = copy.deepcopy(self.data)
        before_data = copy.deepcopy(data)
        data["rules"][rule_id] = rule
        if rule["action"] == "neutral":
            for mark in data["marks"].values():
                if mark["rule"] == rule_id:
                    mark["prompt"] = ""
        undo_title = "wrAIter: update color rule " + uuid.uuid4().hex[:8]
        failure = None
        self.document.UndoManager.enterUndoContext(undo_title)
        try:
            for marker_id, mark in self.data["marks"].items():
                if mark["rule"] == rule_id and self.document.Bookmarks.hasByName(marker_id):
                    anchor = self.document.Bookmarks.getByName(marker_id).Anchor
                    cursor = self.document.Text.createTextCursorByRange(anchor.Start)
                    cursor.gotoRange(anchor.End, True)
                    cursor.CharBackColor = int(rule["color"][1:], 16)
            self.store(data)
            self.document.UndoManager.addUndoAction(MetadataUndo(self, undo_title, before_data, data))
        except Exception as error:
            failure = error
        finally:
            self.document.UndoManager.leaveUndoContext()
        if failure is not None:
            manager = self.document.UndoManager
            if manager.isUndoPossible() and manager.getCurrentUndoActionTitle() == undo_title:
                manager.undo()
            raise ValueError("Rule update failed; inspect native Undo locally before changing permissions again.")

    def check_plain_range(self, cursor, protected=(), allow_fields=False):
        body = self.document.Text
        def check(content, field=False):
            anchor = content.Anchor
            try:
                if field and any(body.compareRegionStarts(anchor.Start, unit.Start) <= 0 and body.compareRegionStarts(anchor.End, unit.End) >= 0 for unit in protected):
                    return
                # compareRegionStarts returns positive when its first range is earlier.
                before = body.compareRegionStarts(anchor.End, cursor.Start) > 0
                after = body.compareRegionStarts(anchor.Start, cursor.End) < 0
            except Exception:
                return  # Content in a separate header/cell/shape text object.
            if not before and not after:
                raise ValueError("Choose plain prose without fields, tables, notes or embedded objects.")
        fields = self.document.TextFields.createEnumeration()
        for _ in range(1024):
            if not fields.hasMoreElements():
                break
            field = fields.nextElement()
            if not allow_fields:
                check(field, True)
        else:
            if fields.hasMoreElements():
                raise ValueError("Document fields exceed the safe review inspection limit.")
        for collection in (self.document.TextTables, self.document.Footnotes, self.document.Endnotes, self.document.DrawPage):
            if collection.getCount() > 1024:
                raise ValueError("Document structures exceed the safe review inspection limit.")
            for index in range(collection.getCount()):
                check(collection.getByIndex(index))
        if self.document.Redlines.getCount():
            raise ValueError("Resolve existing native Track Changes before marking or replacing prose.")

    def mark_selection(self, rule_id, passage_prompt=""):
        self.load()
        if len(self.data["marks"]) >= MAX_MARKS:
            raise ValueError("Remove an old highlight before adding more than 500.")
        if rule_id not in self.data["rules"]:
            raise ValueError("Save a rule first.")
        if self.data["rules"][rule_id]["action"] == "neutral" and passage_prompt:
            raise ValueError("Color-only marks cannot carry passage instructions.")
        if not isinstance(passage_prompt, str) or len(passage_prompt.encode("utf-8")) > CONTRACT["limits"]["promptBytes"]:
            raise ValueError("Passage prompt exceeds its text limit.")
        selection = self.document.CurrentController.getSelection()
        if not hasattr(selection, "getCount") or selection.getCount() != 1:
            raise ValueError("Select one main-body text passage in Writer first.")
        selected = selection.getByIndex(0)
        if not selected.String or len(selected.String) > MAX_REPLACEMENT:
            raise ValueError("Select between 1 and 32768 characters of main-body text.")
        body = self.document.Text
        try:
            body.compareRegionStarts(selected.Start, body.Start)
            cursor = body.createTextCursorByRange(selected.Start)
            cursor.gotoRange(selected.End, True)
        except Exception:
            raise ValueError("Only Writer main-body prose is supported; tables, headers and shapes are excluded.")
        # Paragraph-level structures/embedded objects cannot be rewritten as ordinary prose.
        if "\ufffc" in cursor.String:
            raise ValueError("Select prose without embedded objects.")
        self.check_plain_range(cursor, allow_fields=True)
        marker_id = "UnderTree_" + uuid.uuid4().hex
        bookmark = self.document.createInstance("com.sun.star.text.Bookmark")
        bookmark.Name = marker_id
        data = copy.deepcopy(self.data)
        data["marks"][marker_id] = {"rule": rule_id, "quote": cursor.String, "consumed": False, "prompt": passage_prompt}
        undo_title = "wrAIter: mark passage " + uuid.uuid4().hex[:8]
        failure = None
        self.document.UndoManager.enterUndoContext(undo_title)
        try:
            body.insertTextContent(cursor, bookmark, True)
            cursor.CharBackColor = int(self.data["rules"][rule_id]["color"][1:], 16)
            self.store(data)
            self.document.UndoManager.addUndoAction(PolicyUndo(self, undo_title, "marks", marker_id, None, data["marks"][marker_id]))
        except Exception as error:
            failure = error
        finally:
            self.document.UndoManager.leaveUndoContext()
        if failure is not None:
            manager = self.document.UndoManager
            if manager.isUndoPossible() and manager.getCurrentUndoActionTitle() == undo_title:
                manager.undo()
            if self.document.Bookmarks.hasByName(marker_id):
                raise ValueError("Marking failed and could not be rolled back. Inspect native Undo locally.")
            raise ValueError("Marking failed; its native bookmark and formatting were undone.") from failure
        return marker_id

    def remove_marker(self, marker_id):
        self.load()
        if marker_id not in self.data["marks"]:
            raise ValueError("Choose a current marker first.")
        data = copy.deepcopy(self.data)
        before = copy.deepcopy(data["marks"][marker_id])
        del data["marks"][marker_id]
        undo_title = "wrAIter: remove marker " + uuid.uuid4().hex[:8]
        failure = None
        self.document.UndoManager.enterUndoContext(undo_title)
        try:
            if self.document.Bookmarks.hasByName(marker_id):
                self.document.Text.removeTextContent(self.document.Bookmarks.getByName(marker_id))
            self.store(data)
            self.document.UndoManager.addUndoAction(PolicyUndo(self, undo_title, "marks", marker_id, before, None))
        except Exception as error:
            failure = error
        finally:
            self.document.UndoManager.leaveUndoContext()
        if failure is not None:
            manager = self.document.UndoManager
            if manager.isUndoPossible() and manager.getCurrentUndoActionTitle() == undo_title:
                manager.undo()
            raise ValueError("Marker removal failed; inspect native Undo locally.")
        # Highlight is ordinary user formatting; removing policy does not strip it.

    def set_shared(self, shared, expected_revision=None):
        try:
            before = self.snapshot() if self.pending or (shared and expected_revision is not None) else None
        except Exception:
            if shared:
                raise
            before = None  # Revocation must not depend on context extraction succeeding.
        if shared and expected_revision is not None and before["revision"] != expected_revision:
            raise ValueError("Writer changed after the context preview. Review the sharing scope again.")
        self.shared = bool(shared)
        self.generation += 1
        self.receipts.clear()
        self.context_reads.clear()
        if before is not None and self.pending:
            try:
                after = self.snapshot()
            except Exception:
                return
            binding = self.pending_binding(after)
            for request_id, proposal in self.pending.items():
                if proposal["revision"] == before["revision"] and self.pending_bindings.get(request_id) == binding:
                    proposal["revision"] = after["revision"]

    def start(self):
        if self.closed:
            raise ValueError("Writer document is closed.")
        if self.endpoint is None:
            endpoint_id = uuid.uuid4().hex
            self.endpoint_id = endpoint_id
            dispatch = lambda name, arguments: self.dispatch(name, arguments, endpoint_id)
            self.endpoint = self.connection.start(self, dispatch) if self.connection else Endpoint(dispatch)
        if self.connection and self.connection.tunnel.status()["configured"]:
            self.connection.tunnel.start()
        self.refresh_toolbar()
        return self.endpoint.url

    def restore_connection(self):
        if self.connection is not None and self.endpoint is None:
            endpoint_id = uuid.uuid4().hex
            self.endpoint_id = endpoint_id
            self.endpoint = self.connection.ensure(self, lambda name, arguments: self.dispatch(name, arguments, endpoint_id))
            if self.endpoint is None:
                self.endpoint_id = None
            elif self.connection.tunnel.status()["autoReconnect"]:
                self.connection.tunnel.restore()

    def stop(self):
        if self.connection:
            # An explicit Stop revokes every document on this shared connection.
            for session in list(SESSIONS.values()):
                if session.connection is self.connection and not session.closed:
                    session.set_shared(False)
                    session.endpoint_id, session.endpoint = None, None
            try:
                self.connection.tunnel.stop()
            finally:
                self.connection.stop()
                self.endpoint_id, self.endpoint = None, None
            return
        self.set_shared(False)
        self.endpoint_id = None
        if self.endpoint:
            self.endpoint.close()
            self.endpoint = None

    def dispatch(self, name, arguments, endpoint_id):
        if self.closed or self.endpoint is None or not self.endpoint.active or endpoint_id != self.endpoint_id:
            raise ValueError("Writer MCP access was revoked.")
        task = {"name": name, "arguments": arguments, "done": threading.Event(), "cancelled": False,
                "generation": self.generation, "endpointId": endpoint_id}
        try:
            self.work.put_nowait(task)
        except queue.Full:
            raise ValueError("Writer is busy; try again after the current request finishes.")
        try:
            self.async_callback.addCallback(self.callback, None)
        except Exception:
            task["cancelled"] = True
            task["done"].set()
            raise ValueError("Writer could not schedule this request; it was cancelled before execution.")
        if not task["done"].wait(30):
            task["cancelled"] = True
            raise ValueError("Writer did not respond. Inspect locally before retrying the same requestId.")
        if "error" in task:
            raise ValueError(task["error"])
        return task["result"]

    def drain(self):
        for _ in range(8):
            try:
                task = self.work.get_nowait()
            except queue.Empty:
                return
            try:
                if task["cancelled"] or self.closed or self.endpoint is None or task["generation"] != self.generation or task["endpointId"] != self.endpoint_id:
                    raise ValueError("Writer access changed or request expired.")
                self.active_task = task
                task["result"] = self.call(task["name"], task["arguments"])
            except Exception as error:
                task["error"] = str(error) if isinstance(error, ValueError) else "Writer operation failed; inspect the document locally."
            finally:
                self.active_task = None
                task["done"].set()
        
    def call(self, name, arguments):
        if not isinstance(arguments, dict):
            raise ValueError("Tool arguments must be an object.")
        if name == "list_manuscripts":
            if arguments:
                raise ValueError("This tool takes no arguments.")
            return {"manuscripts": [{"documentId": self.document_id, "name": "Shared Writer document", "scope": "complete current document context; highlighted main-body changes only"}] if self.shared and not self.closed else []}
        if self.closed or not self.shared:
            raise ValueError("Explicitly share this document locally first.")
        if name == "read_manuscript":
            if arguments != {"documentId": self.document_id}:
                raise ValueError("Only the explicitly shared document is available.")
            snapshot = self.snapshot()
            if not self.shared or self.closed or (self.active_task and (self.active_task["generation"] != self.generation or self.active_task["endpointId"] != self.endpoint_id or self.active_task["cancelled"])):
                raise ValueError("Document or sharing changed during the context read. Retrieve the complete context again.")
            result = public_snapshot(snapshot)
            context_id = uuid.uuid4().hex + uuid.uuid4().hex
            result["contextId"] = context_id
            # Check the actual nested MCP JSON representation before recording any read authority.
            envelope = {"jsonrpc": "2.0", "id": "x" * 100, "result": {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}], "structuredContent": result, "isError": False}}
            if len(json.dumps(envelope, ensure_ascii=False).encode("utf-8")) > 1572864:
                raise ValueError("Complete Writer context exceeds the MCP response limit. No complete read was recorded.")
            self.context_reads[context_id] = (snapshot["revision"], self.generation, self.endpoint_id)
            while len(self.context_reads) > 64:
                self.context_reads.popitem(last=False)
            return result
        if name == "highlight_text":
            return self.highlight_text(arguments)
        if name != "suggest_text":
            raise ValueError("Unknown tool.")
        if set(arguments) != {"documentId", "proposal"} or arguments["documentId"] != self.document_id or not isinstance(arguments["proposal"], dict):
            raise ValueError("Supply only this shared documentId and a proposal object.")
        arguments = arguments["proposal"]
        request_id = arguments.get("requestId")
        if isinstance(request_id, str) and "highlight:" + request_id in self.receipts:
            raise ValueError("This requestId already belongs to a color-only action.")
        if isinstance(request_id, str) and request_id in self.receipts:
            old_arguments, result = self.receipts[request_id]
            if old_arguments != arguments:
                raise ValueError("This requestId was already used with different arguments.")
            replay = copy.deepcopy(result)
            if "manuscriptChanged" in replay: replay["manuscriptChanged"] = False
            if "appliedDirectly" in replay: replay["appliedDirectly"] = False
            if "documentChanged" in replay: replay["documentChanged"] = False
            replay["replayed"] = True
            return replay
        if isinstance(request_id, str) and request_id in self.pending:
            raise ValueError("This requestId belongs to a restored pending suggestion. Use a fresh requestId; existing suggestions cannot be replaced.")
        if len(self.receipts) >= 500:
            raise ValueError("This session reached its request limit. Stop and restart access locally.")
        snapshot = self.snapshot()
        mark = authorize(snapshot, arguments)
        if self.context_reads.get(arguments["contextId"]) != (snapshot["revision"], self.generation, self.endpoint_id):
            raise ValueError("Read the complete current document context before proposing changes; contextId is missing, stale or forged.")
        self.prepare_rewrite(snapshot, mark)
        if self.context_reads.get(arguments["contextId"]) != (snapshot["revision"], self.generation, self.endpoint_id):
            raise ValueError("Document or policy changed during native validation. Read complete context again.")
        if mark["mode"] == "direct":
            try:
                self.apply(arguments)
            except Exception:
                self.receipts[request_id] = (copy.deepcopy(arguments), {"status": "outcome_uncertain", "requestId": request_id,
                    "instruction": "Inspect the document and Undo locally. This request will not be replayed."})
                raise
            result = {"status": "applied", "mode": "direct", "saved": False, "permissionConsumed": True, "manuscriptChanged": True, "appliedDirectly": True, "requestId": request_id}
        else:
            if len(self.pending) >= CONTRACT["limits"]["pendingSuggestions"]:
                raise ValueError("Review pending suggestions locally before adding more.")
            self.pending[request_id] = copy.deepcopy(arguments)
            self.pending_bindings[request_id] = self.pending_binding(snapshot)
            try:
                self.persist_pending()
            except Exception:
                self.pending.pop(request_id, None)
                self.pending_bindings.pop(request_id, None)
                raise
            result = {"status": "pending_local_approval", "mode": "suggestion", "documentChanged": False, "manuscriptChanged": False, "appliedDirectly": False, "requestId": request_id}
        self.receipts[request_id] = (copy.deepcopy(arguments), result)
        if self.panel:
            self.panel.refresh()
            self.panel.status("AI edit applied; its marker is now stale. Re-mark locally before another edit." if result["status"] == "applied" else "New AI suggestion awaits your local approval.")
        return result

    def native_point(self, marker, offset):
        anchor = self.document.Text if marker["id"] == "body" else self.document.Bookmarks.getByName(marker["id"]).Anchor
        prefix = utf16_slice(marker["text"], 0, offset - marker["start"])
        if not prefix:
            cursor = self.document.Text.createTextCursorByRange(anchor.Start)
            cursor.collapseToStart()
            return cursor
        distances = [len(prefix), utf16_length(prefix)]
        field_adjustments = [0, 0]
        fields = self.document.TextFields.createEnumeration()
        for _ in range(1024):
            if not fields.hasMoreElements():
                break
            field = fields.nextElement().Anchor
            try:
                if self.document.Text.compareRegionStarts(field.Start, anchor.Start) > 0:
                    continue
                before = self.document.Text.createTextCursorByRange(anchor.Start)
                before.gotoRange(field.Start, True)
                after = self.document.Text.createTextCursorByRange(anchor.Start)
                after.gotoRange(field.End, True)
            except Exception:
                continue
            field_start, field_end = utf16_length(before.String), utf16_length(after.String)
            if field_start < utf16_length(prefix) < field_end:
                raise ValueError("A native field is indivisible; choose its complete displayed text.")
            if field_end <= utf16_length(prefix):
                field_adjustments[0] += max(0, len(field.String) - 1)
                field_adjustments[1] += max(0, utf16_length(field.String) - 1)
        else:
            if fields.hasMoreElements():
                raise ValueError("Native field boundary inspection exceeds its bound.")
        distances.extend(distance - adjustment for distance, adjustment in zip(distances[:2], field_adjustments))
        # Accept only a native point whose complete visible prefix exactly matches.
        for distance in dict.fromkeys(distances):
            cursor = self.document.Text.createTextCursorByRange(anchor.Start)
            remaining = distance
            while remaining:
                step = min(remaining, 32767)
                if not cursor.goRight(step, False):
                    break
                remaining -= step
            if remaining:
                continue
            check = self.document.Text.createTextCursorByRange(anchor.Start)
            check.gotoRange(cursor.Start, True)
            if check.String == prefix:
                return cursor
        raise ValueError("Writer could not verify this Unicode text boundary. No edit was applied.")

    def apply(self, arguments):
        snapshot = self.snapshot()
        permission = authorize(snapshot, arguments)
        cursor, protected_format = self.prepare_rewrite(snapshot, permission)
        if cursor.String != arguments["quote"]:
            raise ValueError("The marked quote changed before applying.")
        # Native range replacement preserves surrounding paragraphs and undo history.
        data = copy.deepcopy(self.data)
        replacement = permission["replacement"]
        before_data = copy.deepcopy(self.data)
        touched = [mark for mark in snapshot["markers"] if mark["start"] < arguments["to"] and arguments["from"] < mark["end"]]
        expected_text = utf16_slice(snapshot["content"], 0, arguments["from"]) + replacement + utf16_slice(snapshot["content"], arguments["to"], utf16_length(snapshot["content"]))
        if self.active_task:
            frame = self.document.CurrentController.Frame
            if frame.ContainerWindow.isActive() or frame.ComponentWindow.hasFocus():
                raise ValueError("Finish typing in Writer and move focus to the review popup or ChatGPT before allowing a direct edit.")
        if self.active_task and (self.active_task["cancelled"] or self.active_task["generation"] != self.generation or self.active_task["endpointId"] != self.endpoint_id):
            raise ValueError("Writer request expired or access changed before applying.")
        failure = None
        changed = False
        undo_title = "wrAIter: apply marked edit " + uuid.uuid4().hex[:8]
        self.document.UndoManager.enterUndoContext(undo_title)
        try:
            for placement in permission["protected"]:
                self.document.Text.removeTextContent(self.document.Bookmarks.getByName(placement["marker"]["id"]))
            cursor.String = replacement
            changed = True
            if self.document.Text.String != expected_text:
                raise ValueError("Writer did not preserve text outside the authorized range; its edit will be undone.")
            after_text = dict(snapshot, content=expected_text)
            for placement in reversed(permission["protected"]):
                mark = placement["marker"]
                protected_range = self.document_range(after_text, placement["from"], placement["to"])
                previous_selection = self.document.CurrentController.getSelection()
                try:
                    self.document.CurrentController.select(protected_range)
                    self.document.CurrentController.insertTransferable(protected_format[mark["id"]])
                finally:
                    self.document.CurrentController.select(previous_selection)
                if self.document.Text.String != expected_text:
                    raise ValueError("Native protected insertion changed reconstructed or surrounding text.")
            for placement in permission["protected"]:
                mark = placement["marker"]
                protected_range = self.document_range(after_text, placement["from"], placement["to"])
                restore_paragraphs(protected_range, protected_format[mark["id"]])
            for placement in permission["protected"]:
                mark = placement["marker"]
                protected_range = self.document_range(after_text, placement["from"], placement["to"])
                verify_paragraphs(protected_range, protected_format[mark["id"]])
                restored_fragment = capture_fragment(self.document, protected_range, self.data["marks"])
                if restored_fragment.fingerprint != protected_format[mark["id"]].fingerprint:
                    raise ValueError("Protected native formatting, fields or links did not survive reconstruction.")
                bookmark = self.document.createInstance("com.sun.star.text.Bookmark")
                bookmark.Name = mark["id"]
                self.document.Text.insertTextContent(protected_range, bookmark, True)
            for mark in touched:
                marker_id = mark["id"]
                if mark["action"] in ("protect", "reject"):
                    continue
                if not replacement and arguments["from"] <= mark["start"] and arguments["to"] >= mark["end"]:
                    if self.document.Bookmarks.hasByName(marker_id):
                        self.document.Text.removeTextContent(self.document.Bookmarks.getByName(marker_id))
                    del data["marks"][marker_id]
                else:
                    data["marks"][marker_id]["consumed"] = True
            self.store(data)
            self.document.UndoManager.addUndoAction(MetadataUndo(self, undo_title, before_data, data))
        except Exception as error:
            failure = error
        finally:
            self.document.UndoManager.leaveUndoContext()
        if failure is not None:
            try:
                manager = self.document.UndoManager
                if manager.isUndoPossible() and manager.getCurrentUndoActionTitle() == undo_title:
                    manager.undo()
                elif changed:
                    raise ValueError("Native edit has no owned Undo action.")
            except Exception:
                raise ValueError("Applying failed and Undo could not restore it. Inspect the document locally; do not replay the edit.")
            raise ValueError("Applying failed and its native edit was undone. Inspect the document locally before submitting a new request.") from failure
        self.consumed_markers.update(mark["id"] for mark in touched if mark["action"] in ("edit", "discard"))

    def accept(self, request_id):
        if request_id not in self.pending:
            raise ValueError("Select a pending suggestion.")
        arguments = self.pending[request_id]
        before = self.snapshot()
        if self.pending_bindings.get(request_id) != self.pending_binding(before):
            raise ValueError("This suggestion no longer matches the complete document and highlight policy. Request a fresh proposal.")
        authorize(before, arguments)
        self.apply(arguments)
        del self.pending[request_id]
        self.pending_bindings.pop(request_id, None)
        if request_id in self.receipts:
            self.receipts[request_id] = (self.receipts[request_id][0], {"status": "approved_locally", "saved": False, "requestId": request_id})
        after = self.snapshot()
        # Only our own just-approved edit can refresh other disjoint, unchanged proposals.
        for key, pending in list(self.pending.items()):
            if pending["revision"] != before["revision"]:
                continue
            refreshed = dict(pending, revision=after["revision"])
            if pending["from"] >= arguments["to"]:
                delta = utf16_length(reconstruct(before, arguments)[0]) - (arguments["to"] - arguments["from"])
                refreshed["from"] += delta
                refreshed["to"] += delta
            elif pending["to"] > arguments["from"]:
                continue
            try:
                authorize(before, pending)
                authorize(after, refreshed)
            except ValueError:
                continue
            self.pending[key] = refreshed
            self.pending_bindings[key] = self.pending_binding(after)
        self.persist_pending()

    def reject(self, request_id):
        self.pending.pop(request_id, None)
        self.pending_bindings.pop(request_id, None)
        self.persist_pending()
        if request_id in self.receipts:
            self.receipts[request_id] = (self.receipts[request_id][0], {"status": "rejected_locally", "documentChanged": False, "requestId": request_id})

    def close(self):
        if self.closed:
            return
        if self.connection:
            self.set_shared(False)
            self.connection.detach(self)
            if getattr(self.connection, "project", None) is not None:
                self.connection.protect_document(self.document_id, None)
            self.endpoint_id, self.endpoint = None, None
        else:
            self.stop()
        self.closed = True
        self.pending.clear()
        SESSIONS.pop(self.document_id, None)
        try:
            self.document.removeDocumentEventListener(self.listener)
            self.document.removeModifyListener(self.listener)
            if self.highlight_input:
                self.document.CurrentController.removeMouseClickHandler(self.highlight_input)
                self.document.CurrentController.removeKeyHandler(self.highlight_input)
        except Exception:
            pass
        if self.panel:
            panel, self.panel = self.panel, None
            panel.dispose()
        if self.connections:
            self.connections.close()
            self.connections = None
        try:
            from undertree_toolbar import dispose_toolbars
            dispose_toolbars(self.document)
        except ImportError:
            pass


from undertree_ui import Panel


def connection_for(context):
    global CONNECTION
    if CONNECTION is None:
        from pathlib import Path
        from undertree_connection import ConnectionManager
        from undertree_tunnel import TunnelSupervisor
        from undertree_peers import PeerConnections
        from undertree_project import ProjectAccess
        from undertree_github import GitHubAccess
        substitution = context.ServiceManager.createInstanceWithContext("com.sun.star.util.PathSubstitution", context)
        profile = Path(uno.fileUrlToSystemPath(substitution.substituteVariables("$(user)", True)))
        connection = ConnectionManager(profile / "undertree-connection")
        try:
            project = ProjectAccess(connection.directory)
            connection.set_project_access(project, GitHubAccess(connection.directory, project))
            connection.tunnel = TunnelSupervisor(connection)
            connection.peers = PeerConnections(connection.directory)
            connection.set_peers(connection.peers)
            connection.peers.restore()
            desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
            connection.termination = WriterTermination(connection)
            desktop.addTerminateListener(connection.termination)
        except Exception:
            connection.close()
            raise
        CONNECTION = connection
    return CONNECTION


class WriterTermination(unohelper.Base, XTerminateListener):
    def __init__(self, connection): self.connection = connection
    def queryTermination(self, _): pass
    def notifyTermination(self, _):
        try:
            self.connection.tunnel.close(timeout=15)
        finally:
            self.connection.peers.close()
            self.connection.close()
    def disposing(self, _): pass


def session_for(context, document):
    for session in list(SESSIONS.values()):
        if session.document == document and not session.closed:
            return session
    session = Session(context, document, connection_for(context))
    SESSIONS[session.document_id] = session
    session.attach_toolbar()
    try:
        session.restore_connection()
    except ValueError as error:
        session.toolbar_message(str(error))
    return session


def toolbar_bridge(frame):
    document = frame.Controller.Model
    if not document.supportsService("com.sun.star.text.TextDocument"):
            raise ValueError("AI highlighters require a Writer document.")
    session = session_for(uno.getComponentContext(), document)
    session.load()
    return {"rules": [{"id": key, **rule} for key, rule in session.data["rules"].items()],
            "chosen": session.armed_rule, "capture_selection": session.capture_selection,
            "mark_or_arm": session.mark_or_arm, "edit_rule": session.edit_toolbar_rule,
            "status": session.toolbar_message}


class StartupCallback(unohelper.Base, XCallback):
    def __init__(self, context, document):
        self.context, self.document = context, document

    def notify(self, _):
        try:
            if self.document and self.document.supportsService("com.sun.star.text.TextDocument"):
                session_for(self.context, self.document)
                layout = self.document.CurrentController.Frame.LayoutManager
                resource = "private:resource/toolbar/addon_org.undertree.WriterReview.Toolbar"
                layout.requestElement(resource)
                layout.showElement(resource)
        except Exception:
            # A startup failure never prevents Writer opening the user's document.
            pass
        finally:
            if self in STARTUP_CALLBACKS:
                STARTUP_CALLBACKS.remove(self)


class WriterStartup(unohelper.Base, XJob, XServiceInfo):
    def __init__(self, context): self.context = context
    def getImplementationName(self): return "org.undertree.WriterStartup"
    def supportsService(self, service): return service == "org.undertree.WriterStartup"
    def getSupportedServiceNames(self): return ("org.undertree.WriterStartup",)

    def execute(self, arguments):
        environment = next((item.Value for item in arguments if item.Name == "Environment"), ())
        model = next((item.Value for item in environment if item.Name == "Model"), None)
        if model is not None and len(STARTUP_CALLBACKS) < 32:
            callback = StartupCallback(self.context, model)
            STARTUP_CALLBACKS.append(callback)
            asynchronous = self.context.ServiceManager.createInstanceWithContext("com.sun.star.awt.AsyncCallback", self.context)
            asynchronous.addCallback(callback, None)
        return ()


class WriterReview(unohelper.Base, XInitialization, XServiceInfo, XDispatchProvider, XDispatch):
    def __init__(self, context):
        self.context = context
        self.frame = None

    def initialize(self, arguments):
        if arguments:
            self.frame = arguments[0]

    def getImplementationName(self):
        return IMPLEMENTATION

    def supportsService(self, service):
        return service in SERVICES

    def getSupportedServiceNames(self):
        return SERVICES

    def queryDispatch(self, url, _target, _flags):
        return self if url.Protocol == "vnd.undertree:" and url.Path in ("review", "connections") else None

    def queryDispatches(self, descriptors):
        return tuple(self.queryDispatch(item.FeatureURL, item.FrameName, item.SearchFlags) for item in descriptors)

    def dispatch(self, url, _arguments):
        if url.Protocol != "vnd.undertree:" or url.Path not in ("review", "connections"):
            return
        desktop = self.context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", self.context)
        document = self.frame.Controller.Model if self.frame else desktop.CurrentComponent
        if document is None or not document.supportsService("com.sun.star.text.TextDocument"):
            return
        try:
            session = session_for(self.context, document)
            if url.Path == "connections":
                session.show_connections()
            else:
                session.show_panel()
        except Exception as error:
            toolkit = self.context.ServiceManager.createInstanceWithContext("com.sun.star.awt.Toolkit", self.context)
            parent = document.CurrentController.Frame.ContainerWindow
            box = toolkit.createMessageBox(parent, uno.Enum("com.sun.star.awt.MessageBoxType", "ERRORBOX"), 1,
                                           "wrAIter", str(error) if isinstance(error, ValueError) else "Unable to open wrAIter. Existing document data was preserved.")
            box.execute()

    def addStatusListener(self, _listener, _url):
        pass

    def removeStatusListener(self, _listener, _url):
        pass


g_ImplementationHelper = unohelper.ImplementationHelper()
g_ImplementationHelper.addImplementation(WriterReview, IMPLEMENTATION, SERVICES)
g_ImplementationHelper.addImplementation(WriterStartup, "org.undertree.WriterStartup", ("org.undertree.WriterStartup",))
import undertree_toolbar
undertree_toolbar.configure(toolbar_bridge)
g_ImplementationHelper.addImplementation(undertree_toolbar.PaletteToolbarController, undertree_toolbar.IMPLEMENTATION, undertree_toolbar.SERVICES)
