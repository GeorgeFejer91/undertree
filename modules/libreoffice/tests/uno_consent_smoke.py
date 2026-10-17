"""Actual native consent layout; synthetic scope never grants access."""
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
from undertree_ui import ContextConsent, Dialog


def property_value(name, value):
    item = uno.createUnoStruct("com.sun.star.beans.PropertyValue")
    item.Name, item.Value = name, value
    return item


def verify(context, installed=False):
    desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
    provider = context.ServiceManager.createInstanceWithContext("com.sun.star.configuration.ConfigurationProvider", context)
    settings = provider.createInstanceWithArguments("com.sun.star.configuration.ConfigurationUpdateAccess", (property_value("nodepath", "/org.openoffice.Office.Common/Misc"),))
    settings.FirstRun = False
    settings.ShowTipOfTheDay = False
    settings.commitChanges()
    document = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, (property_value("Hidden", False),))
    host = consent = None
    states = []
    work = context.ServiceManager.createInstanceWithContext("com.sun.star.awt.Toolkit", context).getWorkArea()
    assert work.Width > 0 and work.Height > 0
    title = ("UnderTree native consent – Forschungsbericht zur internationalen Zusammenarbeit – Methodische Erläuterungen 研究結果 – " * 3)[:181] + " TITLE-END-SENTINEL"
    try:
        document.setTitle(title)
        document.Text.String = "Disposable native consent layout qualification only."
        if installed:
            command = uno.createUnoStruct("com.sun.star.util.URL")
            command.Complete, command.Protocol, command.Path = "vnd.undertree:review", "vnd.undertree:", "review"
            dispatch = document.CurrentController.Frame.queryDispatch(command, "_self", 0)
            assert dispatch is not None and dispatch.getImplementationName() == "org.undertree.WriterReview"
        def forbidden_share(*_args, **_kwargs):
            raise AssertionError("A layout-only preview must never grant access")
        session = SimpleNamespace(context=context, document=document, set_shared=forbidden_share)
        host = Dialog(session, "Native consent qualification", 470, 296)
        host.show()
        files = [{"path": "writer:frame:%03d:" % index + "Kapitel zur internationalen Zusammenarbeit 研究結果 – " * 3, "content": "layout fixture"} for index in range(96)]
        files[-1]["path"] += " FINAL-INVENTORY-SENTINEL"
        consent = ContextConsent(SimpleNamespace(session=session, dialog=host.dialog), {"revision": "layout-only", "context": {"files": files}})
        consent.modal = False
        consent.show()
        fonts = {name: consent.control(name).Model.FontHeight for name in consent.model.ElementNames if hasattr(consent.control(name).Model, "FontHeight")}
        for name, font, expanded in (("native-minimum", None, False), ("18pt-minimum", 18, False), ("18pt-expanded", 18, True), ("36pt-no-fit", 36, False)):
            for control_name, original in fonts.items():
                consent.control(control_name).Model.FontHeight = font if font else original
            consent.dialog.setPosSize(0, 0, consent.base.Width + (300 if expanded else 0), consent.base.Height + (200 if expanded else 0), 12)
            consent.resize()
            dialog = consent.dialog.getPosSize()
            labels = {}
            for control_name in ("document", "snapshotLabel", "snapshot", "scopeLabel", "help", "status"):
                control = consent.control(control_name)
                if not control.isVisible() or not control.Model.Label:
                    continue
                bounds = control.getPosSize()
                size = uno.createUnoStruct("com.sun.star.awt.Size")
                size.Width = bounds.Width
                required = control.calcAdjustedSize(size)
                assert required.Height <= bounds.Height, "Clipped native consent label: " + name + "/" + control_name
                assert bounds.X >= 0 and bounds.Y >= 0 and bounds.X + bounds.Width <= dialog.Width and bounds.Y + bounds.Height <= dialog.Height
                labels[control_name] = {"allocatedHeight": bounds.Height, "requiredHeight": required.Height}
            scope = consent.control("scope")
            value = scope.getText()
            assert title in value, "Full title must remain keyboard-selectable in the context detail"
            assert "FINAL-INVENTORY-SENTINEL" in value
            scope.setFocus()
            selection = uno.createUnoStruct("com.sun.star.awt.Selection")
            selection.Min, selection.Max = 0, len(value)
            scope.setSelection(selection)
            assert scope.getSelectedText() == value
            assert scope.getAccessibleContext().getText() == value
            scope_box = scope.getPosSize()
            assert scope_box.Height > 0 and scope_box.Y + scope_box.Height < consent.control("share").getPosSize().Y
            for button_name in ("share", "cancel"):
                button = consent.control(button_name)
                bounds, minimum = button.getPosSize(), button.getMinimumSize()
                assert bounds.Width >= minimum.Width and bounds.Height >= minimum.Height
                assert bounds.Y + bounds.Height <= dialog.Height
            no_fit = font == 36
            assert consent.control("share").isEnabled() != no_fit
            if no_fit:
                assert "More room is needed" in consent.control("status").Model.Label
                assert not consent.control("document").isVisible() and not consent.control("help").isVisible()
                try:
                    consent.action("share")
                except ValueError:
                    pass
                else:
                    raise AssertionError("No-fit must refuse sharing through the action path too")
            assert consent.control("scope").Model.TabIndex < consent.control("share").Model.TabIndex < consent.control("cancel").Model.TabIndex
            consent.laying_out = True
            try:
                consent.action("share")
            except ValueError:
                pass
            else:
                raise AssertionError("Measuring layout must refuse sharing")
            finally:
                consent.laying_out = False
            states.append({"state": name, "width": dialog.Width, "height": dialog.Height, "labels": labels,
                           "scopeCharacters": len(value), "fullScopeSelectable": True, "shareEnabled": not no_fit})
        consent.dispose()
        consent = None
        return {"status": "passed", "layoutOnly": True, "sharingAttempted": False, "nativeContextPerformanceQualified": False, "installedProtocolChecked": installed,
                "nativeWorkArea": {"width": work.Width, "height": work.Height},
                "screenScope": "UNO Toolkit work area; multi-monitor placement is not qualified", "states": states}
    finally:
        if consent: consent.dispose()
        if host: host.dispose()
        document.setModified(False)
        document.close(True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=2087)
    parser.add_argument("--extension-check", action="store_true")
    parser.add_argument("--output", default="artifacts/libreoffice/consent-layout-v022-result.json")
    args = parser.parse_args()
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    deadline = time.monotonic() + 45
    while True:
        try:
            context = resolver.resolve("uno:socket,host=127.0.0.1,port=%d;urp;StarOffice.ComponentContext" % args.port)
            break
        except Exception:
            if time.monotonic() >= deadline: raise
            time.sleep(0.2)
    desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
    assert not desktop.getComponents().createEnumeration().hasMoreElements(), "Use an empty disposable profile"
    try:
        result = verify(context, args.extension_check)
        Path(args.output).write_text(json.dumps(result, indent=2), encoding="utf-8")
        print("PASS: native consent labels, long full-value scope, actions and explicit no-fit state")
    finally:
        assert desktop.terminate(), "Disposable native process did not terminate"
