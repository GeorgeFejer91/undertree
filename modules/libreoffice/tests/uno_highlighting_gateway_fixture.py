"""Keep a disposable installed Writer authority available for real frozen gateway tests."""
import json
import os
from pathlib import Path
import sys
import time

import uno
from com.sun.star.connection import NoConnectException

sys.path.insert(0, os.environ.get("UNDERTREE_WRITER_EXTENSION_SOURCE", str(Path(__file__).resolve().parents[1] / "extension")))
from undertree_policy import defaults, utf16_length
from undertree_writer import Session
from undertree_ui import Panel


def select(document, quote):
    search = document.createSearchDescriptor()
    search.SearchString, search.SearchCaseSensitive = quote, True
    cursor = document.findFirst(search)
    assert cursor is not None and cursor.String == quote
    document.CurrentController.select(cursor)
    return cursor


def run(context, path):
    desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
    document = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
    initial = "PRIVATE UNMARKED CONTEXT\nOne [A]. Two [B].\nOne [C]. Two [D].\nClassify (One) and (Two)."
    document.Text.String = initial
    session = Session(context, document)
    protected = {}
    for quote in ("[A]", "[B]", "[C]", "[D]"):
        select(document, quote)
        protected[session.mark_selection("protect")] = quote
    session.save_rule("gateway-direct", dict(defaults()["rules"]["snappier"], mode="direct"))
    select(document, "One [A]. Two [B].")
    direct = session.mark_selection("gateway-direct")
    select(document, "One [C]. Two [D].")
    suggestion = session.mark_selection("snappier")
    session.panel = Panel(session)
    session.set_shared(True)
    endpoint = session.start()
    session.panel.refresh()
    session.panel.dialog.toFront()
    session.panel.control("connections").setFocus()
    ready = Path(path).resolve()
    stopped = ready.with_suffix(".stop")
    stopped.unlink(missing_ok=True)
    ranges = []
    for quote in ("(One)", "(Two)"):
        start = utf16_length(initial[:initial.index(quote)])
        ranges.append({"from": start, "to": start + utf16_length(quote), "quote": quote})
    ready.write_text(json.dumps({"url": endpoint, "documentId": session.document_id, "initialText": initial,
        "protected": protected, "directMarker": direct, "suggestionMarker": suggestion, "neutralRanges": ranges,
        "installedSource": str(Path(sys.modules["undertree_writer"].__file__).resolve())}), encoding="utf-8")
    print("Final installed Writer gateway fixture ready; private address remains in the readiness artifact.", flush=True)
    try:
        deadline = time.monotonic() + 900
        while not stopped.exists() and time.monotonic() < deadline and not session.closed:
            time.sleep(.2)
        snapshot = session.snapshot()
        assert document.Text.String.startswith("PRIVATE UNMARKED CONTEXT\n")
        assert all(document.Bookmarks.getByName(identifier).Anchor.String == quote for identifier, quote in protected.items())
        ready.with_suffix(".result.json").write_text(json.dumps({"status": "passed", "stoppedByTest": stopped.exists(),
            "content": document.Text.String, "pending": len(session.pending), "markers": snapshot["markers"],
            "nativeProtectedIdentitiesIntact": True, "noSavedFile": not document.URL}, indent=2), encoding="utf-8")
    finally:
        session.close()
        ready.unlink(missing_ok=True)
        stopped.unlink(missing_ok=True)
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
