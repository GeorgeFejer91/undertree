"""Gesture and toolbar contracts; native rendering remains a UNO integration gate."""
import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

EXTENSION = Path(__file__).resolve().parents[1] / "extension"
sys.path.insert(0, str(EXTENSION))


def load_toolbar():
    native = {}
    for name in ("uno", "unohelper", "com", "com.sun", "com.sun.star", "com.sun.star.awt",
                 "com.sun.star.frame", "com.sun.star.lang", "com.sun.star.util", "com.sun.star.datatransfer"):
        native[name] = ModuleType(name)
    native["unohelper"].Base = type("Base", (), {})
    native["uno"].createUnoStruct = lambda _: SimpleNamespace()
    native["uno"].getConstantByName = lambda name: 771 if name.endswith("F4") else 1280
    for package, interfaces in {
        "awt": ("XActionListener", "XCallback", "XKeyListener", "XMouseListener", "XItemListener", "XWindowListener", "XTopWindowListener"),
        "frame": ("XStatusListener", "XToolbarController"),
        "lang": ("XComponent", "XInitialization", "XServiceInfo"),
        "util": ("XUpdatable",), "datatransfer": ("XTransferable",)
    }.items():
        for interface in interfaces:
            setattr(native["com.sun.star." + package], interface, type(interface, (), {}))
    spec = importlib.util.spec_from_file_location("toolbar_under_test", EXTENSION / "undertree_toolbar.py")
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, native):
        spec.loader.exec_module(module)
    return module


toolbar = load_toolbar()


class Timer:
    instances = []

    def __init__(self, interval, callback):
        self.interval, self.callback, self.cancelled = interval, callback, False
        self.instances.append(self)

    def start(self): pass
    def cancel(self): self.cancelled = True
    def fire(self): self.callback()


class GestureTests(unittest.TestCase):
    def setUp(self):
        Timer.instances = []
        self.source = {"quote": "Original selected passage", "revision": 1}
        self.marks, self.edits, self.queue = [], [], []
        self.gesture = toolbar.ClickGesture(lambda: dict(self.source),
                                            lambda rule, captured: self.marks.append((rule, captured)),
                                            self.edits.append, self.queue.append, Timer)

    def test_mouse_single_uses_original_capture_and_ui_dispatch(self):
        self.gesture.press("green", 1)
        self.gesture.release("green", 1)
        self.assertEqual(self.marks, [])
        self.source["quote"] = "A different later selection"
        Timer.instances[0].fire()
        self.assertEqual(self.marks, [], "A timer thread must never mark a document")
        self.gesture.deliver(self.queue.pop())
        self.assertEqual(self.marks, [("green", {"quote": "Original selected passage", "revision": 1})])

    def test_double_click_cancels_even_already_queued_single_without_marking(self):
        self.gesture.press("green", 1)
        self.gesture.release("green", 1)
        Timer.instances[0].fire()
        stale = self.queue.pop()
        self.gesture.press("green", 2)
        self.gesture.release("green", 2)
        self.gesture.deliver(stale)
        self.assertEqual(self.edits, [], "An obsolete callback must not open settings early")
        self.gesture.deliver(self.queue.pop())
        self.assertEqual(self.marks, [])
        self.assertEqual(self.edits, ["green"])
        self.assertTrue(Timer.instances[0].cancelled)

    def test_keyboard_is_immediate_and_cancels_pending_mouse(self):
        self.gesture.press("green", 1)
        self.gesture.release("green", 1)
        timer = Timer.instances[0]
        self.gesture.keyboard("yellow")
        timer.fire()
        self.gesture.deliver(self.queue.pop())
        self.assertEqual([rule for rule, _ in self.marks], ["yellow"])
        self.gesture.keyboard("yellow", settings=True)
        self.assertEqual(self.edits, ["yellow"])

    def test_cancel_and_unmatched_release_never_apply(self):
        self.gesture.press("green", 1)
        self.gesture.release("yellow", 1)
        self.assertEqual(Timer.instances, [])
        self.gesture.release("green", 1)
        timer = Timer.instances[0]
        self.gesture.cancel()
        timer.fire()
        self.gesture.deliver(self.queue.pop())
        self.assertEqual(self.marks, [])

    def test_empty_slot_opens_editor_with_no_selection_capture(self):
        self.gesture.press(None, 1)
        self.gesture.release(None, 1)
        self.gesture.deliver(self.queue.pop())
        self.assertEqual(self.edits, [None])
        self.assertEqual(self.marks, [])
        self.assertEqual(Timer.instances, [])


class Control:
    def __init__(self):
        self.controls, self.Model = {}, SimpleNamespace()
        self.size, self.enabled, self.visible = SimpleNamespace(Width=28, Height=28), True, False
        self.disposed = False

    def setModel(self, model): self.Model = model
    def getModel(self): return self.Model
    def setActionCommand(self, name): self.command = name
    def addActionListener(self, events): self.action = events
    def addMouseListener(self, events): self.mouse = events
    def addKeyListener(self, events): self.key = events
    def addControl(self, name, control): self.controls[name] = control
    def setTabControllers(self, controllers): self.tab_controllers = controllers
    def createPeer(self, _toolkit, parent): self.parent = parent
    def setVisible(self, visible): self.visible = visible
    def setEnable(self, enabled): self.enabled = enabled
    def setFocus(self): self.focused = True
    def dispose(self): self.disposed = True
    def getMinimumSize(self): return SimpleNamespace(Width=len(self.Model.Label) * 8 + 12, Height=24)
    def getPosSize(self): return self.size

    def setPosSize(self, x, y, width, height, _flags):
        self.size = SimpleNamespace(X=x, Y=y, Width=width, Height=height)


class ServiceManager:
    def __init__(self): self.queue = []

    def createInstanceWithContext(self, service, _context):
        if service.endswith("AsyncCallback"):
            return SimpleNamespace(addCallback=lambda callback, token: self.queue.append((callback, token)))
        if service.endswith("TabControllerModel"):
            return SimpleNamespace(setControlModels=lambda models: setattr(self, "tab_models", models))
        if service.endswith("TabController"):
            return SimpleNamespace(setModel=lambda model: None, setContainer=lambda window: None,
                                   activateTabOrder=lambda: setattr(self, "tab_active", True))
        if service.endswith("UnoControlButtonModel"):
            return ButtonModel()
        if service.endswith("Model"):
            return SimpleNamespace()
        return Control()

    def drain(self):
        while self.queue:
            callback, token = self.queue.pop(0)
            callback.notify(token)


class ButtonModel(SimpleNamespace):
    def __setattr__(self, name, value):
        if name in ("Name", "TabIndex"):
            raise AttributeError("Standalone UnoControlButtonModel does not support " + name)
        super().__setattr__(name, value)


class ToolbarTests(unittest.TestCase):
    def setUp(self):
        self.service = ServiceManager()
        self.context = SimpleNamespace(ServiceManager=self.service)
        self.document = object()
        self.frame = SimpleNamespace(Controller=SimpleNamespace(Model=self.document))
        self.rules = [{"id": "r%d" % index, "name": "Rule %d" % index, "color": "#00AA00"} for index in range(24)]
        self.marks, self.edits, self.errors = [], [], []
        self.binding = {"rules": self.rules, "chosen": "r0", "capture_selection": lambda: "captured-range",
                        "mark_or_arm": lambda rule, capture=None: self.marks.append((rule, capture)),
                        "edit_rule": self.edits.append, "status": self.errors.append}
        toolbar.configure(lambda frame: self.binding if frame is self.frame else None)
        self.controller = toolbar.PaletteToolbarController(self.context)
        self.controller.initialize((SimpleNamespace(Name="Frame", Value=self.frame),))
        self.window = self.controller.createItemWindow(object())
        self.controller.gesture.timer_factory = Timer

    def tearDown(self):
        self.controller.dispose()
        toolbar.configure(None)

    def test_four_native_swatches_and_all_twenty_four_rules_are_reachable(self):
        self.assertEqual(len(self.window.controls), 6)
        self.assertTrue(self.window.visible)
        self.assertEqual(self.service.tab_models, tuple(control.Model for control in self.controller.controls.values()))
        self.assertTrue(self.service.tab_active)
        reached = []
        for _ in range(6):
            reached.extend(self.controller.slot_ids)
            for index in range(4):
                model = self.controller.controls["slot%d" % index].Model
                self.assertEqual(model.BackgroundColor, 0x00AA00)
                self.assertIn("double-click", model.HelpText)
            self.controller.invoke("next")
        self.assertEqual(reached, [rule["id"] for rule in self.rules])
        self.assertEqual(self.controller.page, 0)
        self.assertFalse(self.controller.controls["add"].enabled)
        self.assertIn("1–4 of 24", self.controller.controls["next"].Model.HelpText)
        self.binding["chosen"] = "r20"
        self.controller.update()
        self.assertEqual(self.controller.slot_ids, ["r20", "r21", "r22", "r23"])

    def test_python_uno_factory_constructor_accepts_initialization_arguments(self):
        arguments = tuple(SimpleNamespace(Name=name, Value=value) for name, value in (
            ("ModuleIdentifier", "com.sun.star.text.TextDocument"), ("Frame", self.frame),
            ("CommandURL", "vnd.undertree:palette"), ("ServiceManager", self.service),
            ("ParentWindow", object()), ("Identifier", 1)))
        controller = toolbar.PaletteToolbarController(self.context, *arguments)
        try:
            window = controller.createItemWindow(object())
            self.assertIsNotNone(window)
            self.assertIs(controller.frame, self.frame)
            self.assertEqual(controller.slot_ids, ["r0", "r1", "r2", "r3"])
        finally:
            controller.dispose()

    def test_native_action_mouse_order_does_not_duplicate_single_or_double(self):
        events = self.controller.events["slot0"]
        event = SimpleNamespace(Buttons=1, PopupTrigger=False, ClickCount=1, X=5, Y=5,
                                Source=self.controller.controls["slot0"])
        events.mousePressed(event)
        events.actionPerformed(None)
        events.mouseReleased(event)
        Timer.instances[-1].fire()
        self.assertEqual(self.marks, [])
        self.service.drain()
        self.assertEqual(self.marks, [("r0", "captured-range")])
        self.marks.clear()
        events.mousePressed(event)
        events.mouseReleased(event)
        first = Timer.instances[-1]
        event.ClickCount = 2
        events.mousePressed(event)
        events.actionPerformed(None)
        events.mouseReleased(event)
        first.fire()
        self.service.drain()
        self.assertEqual(self.marks, [])
        self.assertEqual(self.edits, ["r0"])

    def test_keyboard_settings_and_activation_work_after_mouse_use(self):
        events = self.controller.events["slot0"]
        events.pointer = True
        events.keyPressed(SimpleNamespace(KeyCode=1280, Modifiers=0))
        events.actionPerformed(None)
        self.assertEqual(self.marks, [("r0", "captured-range")])
        events.keyPressed(SimpleNamespace(KeyCode=771, Modifiers=0))
        events.actionPerformed(None)
        self.assertEqual(self.edits, ["r0"])
        self.assertEqual(len(self.marks), 1)

    def test_policy_change_and_disposal_invalidate_queued_marks(self):
        self.controller.pointer_press("slot0", 1)
        self.controller.pointer_release("slot0", 1)
        Timer.instances[-1].fire()
        self.binding["rules"] = [dict(rule, color="#FF0000") for rule in self.rules]
        self.controller.update()
        self.service.drain()
        self.assertEqual(self.marks, [])
        self.controller.pointer_press("slot0", 1)
        self.controller.pointer_release("slot0", 1)
        timer = Timer.instances[-1]
        self.controller.dispose()
        timer.fire()
        self.service.drain()
        self.assertEqual(self.marks, [])
        self.assertTrue(self.window.disposed)

    def test_failed_capture_reports_and_never_marks(self):
        def stale(): raise ValueError("Selection changed; select the passage again.")
        self.binding["capture_selection"] = stale
        self.controller.pointer_press("slot0", 1)
        self.controller.pointer_release("slot0", 1)
        self.service.drain()
        self.assertEqual(self.marks, [])
        self.assertEqual(self.errors, ["Selection changed; select the passage again."])

    def test_unpainted_rule_change_and_document_switch_refuse_delayed_mark(self):
        for change in ("rule", "document"):
            with self.subTest(change=change):
                self.controller.pointer_press("slot0", 1)
                self.controller.pointer_release("slot0", 1)
                Timer.instances[-1].fire()
                if change == "rule":
                    self.rules[0]["color"] = "#FF0000"
                else:
                    self.frame.Controller.Model = object()
                self.service.drain()
                self.assertEqual(self.marks, [])
                self.assertIn("Document or color rules changed", self.errors[-1])
                self.controller.update()

    def test_factory_failure_disposes_partial_control_without_escaping_layout_lock(self):
        self.controller.dispose()
        controller = toolbar.PaletteToolbarController(self.context)
        original = controller.create
        partial = []

        def broken(service):
            if service == "UnoControlButtonModel":
                raise AttributeError("Native property unavailable")
            result = original(service)
            if service == "UnoControlContainer":
                partial.append(result)
            return result

        controller.create = broken
        self.assertIsNone(controller.createItemWindow(object()))
        self.assertTrue(partial[0].disposed)
        self.assertEqual(controller.controls, {})
        self.assertIn("could not open", controller.creation_error)
        controller.dispose()


class RegistrationTests(unittest.TestCase):
    def test_palette_precedes_review_and_toolbar_defaults_visible(self):
        ns = {"oor": "http://openoffice.org/2001/registry"}
        key = "{" + ns["oor"] + "}name"
        addons = ET.parse(EXTENSION / "Addons.xcu").getroot()
        toolbar_node = next(node for node in addons.iter("node") if node.get(key) == "org.undertree.WriterReview.Toolbar")
        self.assertEqual([node.get(key) for node in toolbar_node], ["Palette", "Review", "Connections"])
        self.assertEqual(toolbar_node[0].find("prop/value").text, "vnd.undertree:palette")
        self.assertEqual(toolbar_node[2].find("prop/value").text, "vnd.undertree:connections")
        images = next(node for node in addons.iter("node") if node.get(key) == "Images")
        tunnel = next(node for node in images if node.get(key) == "org.undertree.WriterReview.TunnelImage")
        self.assertEqual(tunnel.find("prop/value").text, "vnd.undertree:connections")
        self.assertEqual([prop.find("value").text for prop in tunnel.find("node")], ["%origin%/tunnel16.png", "%origin%/tunnel24.png"])
        state = ET.parse(EXTENSION / "WriterWindowState.xcu").getroot()
        properties = {prop.get(key): prop.find("value").text for prop in state.iter("prop")}
        self.assertEqual(properties["Visible"], "true")
        self.assertEqual(properties["Docked"], "true")
        self.assertEqual(properties["Locked"], "false")


if __name__ == "__main__":
    unittest.main()
