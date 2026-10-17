"""Check native displayed dropdown text, not only backing selection indices."""
import json
import faulthandler
from pathlib import Path
import sys
import time

import uno

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extension"))
from undertree_policy import CONTRACT
from undertree_writer import Panel, Session, property_value
from undertree_ui import contrasting_text


def visible_text(context, depth=0):
    if depth > 5:
        return []
    values = []
    if hasattr(context, "getText"):
        values.append(context.getText())
    for index in range(context.getAccessibleChildCount()):
        child = context.getAccessibleChild(index)
        if child:
            values.extend(visible_text(child.getAccessibleContext(), depth + 1))
    return values


local = uno.getComponentContext()
faulthandler.dump_traceback_later(45, repeat=True)
resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
deadline = time.monotonic() + 45
while True:
    try:
        context = resolver.resolve("uno:socket,host=127.0.0.1,port=2087;urp;StarOffice.ComponentContext")
        break
    except Exception:
        if time.monotonic() >= deadline:
            raise
        time.sleep(1)
desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
fixture = Path("artifacts/libreoffice/dropdown-qualification.odt").resolve()
source = Path("artifacts/libreoffice/Writer-qualification.odt")
if not source.exists():
    source = Path("artifacts/libreoffice/pending-reopen.odt")
fixture.write_bytes(source.read_bytes())
document = desktop.loadComponentFromURL(uno.systemPathToFileUrl(str(fixture)), "_blank", 0, ())
session = Session(context, document)
try:
    session.panel = panel = Panel(session)
    expected_defaults = [rule["id"] for rule in CONTRACT["defaultRules"]]
    assert panel.rule_ids[:4] == expected_defaults
    display = {}
    for name in ("rules", "marks", "pending"):
        selected = panel.control(name).getSelectedItem()
        assert selected, "Backing selection is empty: " + name
        texts = visible_text(panel.control(name).getAccessibleContext())
        display[name] = {"selected": selected, "accessibleText": texts}
        assert texts and texts[0] == selected, "Native accessible collapsed displayed text is empty: " + name
    for index, key in enumerate(panel.rule_ids[:4]):
        color = int(session.data["rules"][key]["color"][1:], 16)
        assert panel.control("slot" + str(index)).Model.TextColor == contrasting_text(color)
    assert contrasting_text(0xFFFF00) == 0 and contrasting_text(0x000020) == 0xFFFFFF
    for key in ("custom-z", "custom-a"):
        session.save_rule(key, dict(session.data["rules"]["snappier"], name=key))
    expected_order = expected_defaults + ["custom-z", "custom-a"]
    document.store()
    session.close()
    document.close(True)
    document = desktop.loadComponentFromURL(uno.systemPathToFileUrl(str(fixture)), "_blank", 0, ())
    session = Session(context, document)
    session.panel = panel = Panel(session)
    assert panel.rule_ids == expected_order, "Saving/reopening reordered color slots"
    print(json.dumps(display, ensure_ascii=False), flush=True)
    result = {"status": "passed", "defaultRuleOrder": panel.rule_ids[:4], "reopenedRuleOrder": panel.rule_ids, "display": display, "contrast": "black on light / white on dark"}
    Path("artifacts/libreoffice/dropdown-display-result.json").write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
finally:
    session.close()
    document.setModified(False)
    document.close(True)
