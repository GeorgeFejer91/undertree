"""Measure every wrAIter popup in a disposable native Writer profile."""
import argparse
import json
import os
from pathlib import Path
import sys
import time
from types import SimpleNamespace

import uno

extension = Path(os.environ.get("UNDERTREE_WRITER_EXTENSION_SOURCE", Path(__file__).resolve().parents[1] / "extension"))
sys.path.insert(0, str(extension))
from undertree_writer import Session, property_value
from undertree_ui import (Panel, RuleDialog, ColorPicker, HighlightDialog, ContextConsent, TunnelSetup,
                          PairedPrograms, Connections, ConnectionDetails, GitHubSetup, SuggestionDialog, HighlightRuleChoice)


def check_bounds(dialog):
    if os.name == "nt":
        icons = dialog.window_icons
        assert icons is not None and len(icons.icons) == 2, type(dialog).__name__ + " needs its application icons"
        for index, icon in enumerate(icons.icons):
            assert icons.api.SendMessageW(icons.window, 0x7F, index, 0) == icon, type(dialog).__name__ + " lost its native window icon"
    outer = dialog.dialog.getPosSize()
    names = ("layoutDetail", "layoutClose") if dialog.no_fit and dialog.layout_fallback else dialog.positions
    boxes = []
    for name in names:
        control = dialog.control(name)
        if not control.isVisible():
            continue
        box = control.getPosSize()
        if dialog.kinds[name] == "FixedText" and not control.Model.Label:
            continue
        assert box.Width > 0 and box.Height > 0, (type(dialog).__name__, name, box)
        assert box.X >= 0 and box.Y >= 0 and box.X + box.Width <= outer.Width and box.Y + box.Height <= outer.Height, (type(dialog).__name__, name, box, outer)
        kind = dialog.kinds[name]
        if kind in ("FixedText", "RadioButton", "CheckBox", "Button"):
            size = uno.createUnoStruct("com.sun.star.awt.Size")
            size.Width = box.Width
            required = control.calcAdjustedSize(size)
            assert required.Height <= box.Height, (type(dialog).__name__, name, required, box)
            if kind == "Button":
                assert control.getMinimumSize().Width <= box.Width, (name, box)
        for other_name, other in boxes:
            assert box.X >= other.X + other.Width or other.X >= box.X + box.Width or box.Y >= other.Y + other.Height or other.Y >= box.Y + box.Height, (type(dialog).__name__, name, other_name)
        boxes.append((name, box))
    return {"width": outer.Width, "height": outer.Height, "noFit": dialog.no_fit, "visibleControls": len(boxes)}


def native_font_height(control):
    size = uno.createUnoStruct("com.sun.star.awt.Size")
    size.Height = control.getPeer().getFont(control.Model.FontDescriptor).getFontDescriptor().Height
    return control.getPeer().convertSizeToLogic(size, uno.getConstantByName("com.sun.star.util.MeasureUnit.POINT")).Height


def verify(context):
    desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
    provider = context.ServiceManager.createInstanceWithContext("com.sun.star.configuration.ConfigurationProvider", context)
    settings = provider.createInstanceWithArguments("com.sun.star.configuration.ConfigurationUpdateAccess", (property_value("nodepath", "/org.openoffice.Office.Common/Misc"),))
    settings.FirstRun, settings.ShowTipOfTheDay = False, False
    settings.commitChanges()
    document = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
    session, dialogs = None, []
    results = {}
    try:
        document.Text.String = "Native popup fixture. Full selected passage remains unchanged."
        session = Session(context, document)
        session.connection = SimpleNamespace(tunnel=SimpleNamespace(settings=lambda: {"zrokExecutable": ""}, status=lambda: {"phase": "stopped"}),
                                             peers=SimpleNamespace(status=lambda: []), status=lambda: {},
                                             github=SimpleNamespace(state=lambda: {"configured": False, "enabled": False, "branch": "main"}))
        session.panel = panel = Panel(session)
        dialogs.append(panel)
        cursor = document.Text.createTextCursor()
        cursor.gotoEnd(True)
        document.CurrentController.select(cursor)
        connections = Connections(panel)
        dialogs.append(connections)
        factories = [lambda: HighlightRuleChoice(panel, [{"name": "AI color", "color": "#aaccff", "action": "neutral", "id": "UnderTree_first", "ruleId": "neutral"},
                     {"name": "Keep unchanged", "color": "#74b9a4", "action": "protect", "id": "UnderTree_second", "ruleId": "protect"}]), lambda: RuleDialog(panel), lambda: ColorPicker(panel, "#90caf9"), lambda: HighlightDialog(panel),
                     lambda: ContextConsent(connections, {"revision": "layout-only", "context": {"files": [{"path": "writer:body", "content": document.Text.String}]}}),
                     lambda: TunnelSetup(connections), lambda: PairedPrograms(connections),
                     lambda: ConnectionDetails(connections),
                     lambda: GitHubSetup(connections),
                     lambda: SuggestionDialog(panel, {"quote": document.Text.String, "replacement": "Unapplied layout fixture."})]
        for factory in factories:
            dialog = factory()
            dialog.modal = False
            dialogs.append(dialog)
        connections.show()
        connection_default = connections.dialog.getPosSize()
        assert connections.control("reconnect").Model.Label == "Reconnect at startup"
        assert connections.control("share").Model.HelpText == "Share complete document for context; edits stay inside highlights"
        assert connections.control("url").Model.ReadOnly and connections.control("scope").Model.ReadOnly
        assert connections.control("addressLabel").Model.Label == "MCP Address"
        assert connections.control("scopeLabel").Model.Label == "Selected document"
        long_title = "Forschungsbericht 研究結果 " * 20 + "TITLE-END"
        document.setTitle(long_title)
        session.connection.status = lambda: {"autoReconnect": True}
        session.connection.tunnel.status = lambda: {"phase": "running", "endpoint": "https://example.invalid/mcp/" + "long-address-" * 30}
        connections.refresh()
        assert connections.control("scope").Model.Text == long_title
        assert connections.control("url").Model.Text.endswith("long-address-")
        assert connections.control("reconnect").Model.State == 1 and connections.control("share").Model.State == 0 and not session.shared
        error = "Complete connection error 研究結果. " * 30 + "ERROR-END"
        session.connection.tunnel.status = lambda: {"phase": "failed", "error": error}
        connections.refresh()
        assert connections.control("status").Model.Label == error
        if connections.no_fit:
            assert "ERROR-END" in connections.control("layoutDetail").Model.Text
        document.setTitle("Native popup fixture")
        session.connection.status = lambda: {}
        session.connection.tunnel.status = lambda: {"phase": "stopped"}
        connections.refresh()
        connections.dialog.setPosSize(connection_default.X, connection_default.Y, connection_default.Width, connection_default.Height, 15)
        connections.resize()
        for dialog in dialogs:
            if not dialog.positions:
                dialog.show()
            identity = type(dialog).__name__
            results[identity] = {"default": check_bounds(dialog), "states": []}
            assert not dialog.no_fit, identity + " must fit at the default native font"
            assert dialog.dialog.getPosSize().Width < 750, identity + " opened with an oversized default width"
            if isinstance(dialog, Panel):
                slots = [dialog.control("slot" + str(index)).getPosSize() for index in range(4)]
                assert max(box.Width for box in slots) - min(box.Width for box in slots) <= 1
                assert slots[0].Y == slots[1].Y < slots[2].Y == slots[3].Y, "Compact palette must use two equal columns"
            if isinstance(dialog, TunnelSetup) and extension.joinpath("zrok2.exe").is_file():
                assert Path(dialog.control("zrokExecutable").Model.Text).resolve() == extension.joinpath("zrok2.exe").resolve(), "An empty saved path must use the installed bundled bridge"
            original_fonts = {name: native_font_height(dialog.control(name)) for name in dialog.model.ElementNames if hasattr(dialog.control(name).Model, "FontHeight")}
            for label, width, height, font in (("narrow-tall", 420, 900, None), ("wide-short", 1100, 360, None),
                                                ("compact", 675, 650, None), ("expanded", 1100, 950, None),
                                                ("18pt-narrow", 675, 700, 18), ("18pt-wide", 1100, 950, 18)):
                for name, original in original_fonts.items():
                    dialog.control(name).Model.FontHeight = font or original
                dialog.dialog.setPosSize(0, 0, width, height, 12)
                dialog.resize()
                state = check_bounds(dialog)
                results[identity]["states"].append({"state": label, **state})
                if isinstance(dialog, Connections):
                    dialog.action("projectPage")
                    results[identity]["states"].append({"state": "project/" + label, **check_bounds(dialog)})
                    dialog.action("reviewPage")
                if isinstance(dialog, RuleDialog):
                    for page in ("wordingPage", "accessPage", "colorPage"):
                        dialog.action(page)
                        results[identity]["states"].append({"state": page + "/" + label, **check_bounds(dialog)})
                        if font == 18:
                            assert not dialog.no_fit and dialog.control("save").isVisible() and dialog.control("cancel").isVisible(), page + " must remain editable at 18pt"
                if dialog.no_fit and dialog.layout_fallback:
                    detail = dialog.control("layoutDetail")
                    assert "More room is needed" in detail.Model.Text
                    assert detail.isVisible() and dialog.control("layoutClose").isVisible()
            for name, original in original_fonts.items():
                dialog.control(name).Model.FontHeight = original
            dialog.dialog.setPosSize(0, 0, 675, 700, 12)
            dialog.resize()
            assert not dialog.no_fit, identity + " failed to recover after font/size restoration"
            if isinstance(dialog, Connections):
                dialog.action("projectPage")
                check_bounds(dialog)
                assert dialog.control("folder").isVisible() and not dialog.control("url").isVisible()
                dialog.action("reviewPage")
                check_bounds(dialog)
                assert dialog.control("url").isVisible() and not dialog.control("folder").isVisible()
            if isinstance(dialog, GitHubSetup):
                dialog.control("token").Model.Text = "NATIVE-SECRET-MUST-NOT-APPEAR"
                dialog.show_layout_detail(675, 500, 20, 10)
                assert "NATIVE-SECRET-MUST-NOT-APPEAR" not in dialog.control("layoutDetail").Model.Text
                assert dialog.control("token").Model.EchoChar != 0
        rule = next(dialog for dialog in dialogs if isinstance(dialog, RuleDialog))
        rule.action("wordingPage")
        positions = []
        for width, height in ((675, 700), (675, 950), (1100, 950), (675, 700)):
            rule.dialog.setPosSize(0, 0, width, height, 12)
            rule.resize()
            positions.append((rule.control("promptLabel").getPosSize().Y, rule.control("save").getPosSize().Y,
                              rule.control("prompt").getPosSize().Width))
        assert positions[1][0] > positions[0][0], "Extra height must separate ordered groups"
        assert positions[1][1] > positions[0][1], "Footer must remain attached to the bottom"
        assert positions[2][2] > positions[1][2], "Extra width must grow the editable field"
        assert positions[3] == positions[0], "Restoring dimensions must restore the same layout"
        rule.action("accessPage")
        rule.control("help").Model.Label = "Langer lokalisierter Hinweis 研究結果 " * 30 + "FULL-LABEL-END"
        rule.control("status").Model.Label = "A complete critical error must remain readable. " * 15 + "FULL-ERROR-END"
        rule.resize()
        check_bounds(rule)
        if rule.no_fit:
            detail = rule.control("layoutDetail")
            assert "FULL-LABEL-END" in detail.Model.Text and "FULL-ERROR-END" in detail.Model.Text
            assert not rule.control("save").isVisible()
            rules_before = json.dumps(session.data["rules"], sort_keys=True)
            rule.events.actionPerformed(SimpleNamespace(ActionCommand="save"))
            assert json.dumps(session.data["rules"], sort_keys=True) == rules_before and rule.result is None
        assert document.Text.String == "Native popup fixture. Full selected passage remains unchanged."
        assert not session.shared and not session.endpoint and not session.pending
        session.connection.tunnel.settings = lambda: {"zrokExecutable": "C:/explicit/saved/zrok2.exe"}
        saved_setup = TunnelSetup(connections)
        try:
            assert saved_setup.control("zrokExecutable").Model.Text == "C:/explicit/saved/zrok2.exe"
        finally:
            saved_setup.dispose()
        return {"status": "passed", "nativeTheme": "inherited Writer fonts and control colors", "dialogs": results,
                "contentUnchanged": True, "sharingStarted": False, "panelScrollbars": False}
    finally:
        for dialog in reversed(dialogs):
            if isinstance(dialog, (Connections, PairedPrograms)):
                dialog.pulse.close()
            dialog.dispose()
        if session:
            session.connection = None
            session.close()
        document.setModified(False)
        document.close(True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=2094)
    parser.add_argument("--output", default="artifacts/libreoffice/dialog-layout-result.json")
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
            time.sleep(.2)
    result = verify(context)
    Path(args.output).write_text(json.dumps(result, indent=2), encoding="utf-8")
    print("PASS: all eleven native popup layouts, page switching, credential redaction, width/height stretch, reflow and unchanged document")
