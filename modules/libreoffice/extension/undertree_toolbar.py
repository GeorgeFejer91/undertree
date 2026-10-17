"""Native, document-local Writer palette. The session owns all marking authority."""
import threading
import weakref

import uno
import unohelper
from com.sun.star.awt import XActionListener, XCallback, XKeyListener, XMouseListener
from com.sun.star.frame import XStatusListener, XToolbarController
from com.sun.star.lang import XComponent, XInitialization, XServiceInfo
from com.sun.star.util import XUpdatable

from undertree_policy import MAX_RULES
from undertree_ui import contrasting_text

IMPLEMENTATION = "org.undertree.WriterPaletteController"
SERVICES = (IMPLEMENTATION, "com.sun.star.frame.ToolbarController")
COMMAND = "vnd.undertree:palette"
_resolver = None
_controllers = weakref.WeakSet()


def configure(resolver):
    """Resolver(frame) returns rules/chosen and the document-local UI callbacks."""
    global _resolver
    _resolver = resolver
    refresh_toolbars()


def refresh_toolbars(document=None):
    for controller in list(_controllers):
        if document is None or controller.document() == document:
            controller.update()


def dispose_toolbars(document):
    for controller in list(_controllers):
        if controller.document() == document:
            controller.dispose()


class ClickGesture:
    """Only the UI dispatcher may deliver a click; timer threads merely post it."""
    def __init__(self, capture, activate, edit, post, timer_factory=threading.Timer):
        self.capture, self.activate, self.edit, self.post = capture, activate, edit, post
        self.timer_factory, self.timer = timer_factory, None
        self.generation, self.pressed, self.pending = 0, None, None

    def cancel(self):
        self.generation += 1
        self.pressed, self.pending = None, None
        if self.timer:
            self.timer.cancel()
            self.timer = None

    def press(self, rule, count):
        self.cancel()
        self.pressed = (rule, count, self.capture() if count == 1 and rule is not None else None)

    def release(self, rule, count):
        if self.pressed is None or self.pressed[:2] != (rule, count):
            return
        _, _, captured = self.pressed
        self.pressed = None
        self.pending = (rule, captured, count >= 2 or rule is None)
        token = self.generation
        if count >= 2 or rule is None:
            self.post(token)
        else:
            self.timer = self.timer_factory(0.5, lambda: self.post(token))
            self.timer.daemon = True
            self.timer.start()

    def deliver(self, token):
        if token != self.generation or self.pending is None:
            return
        rule, captured, settings = self.pending
        self.pending, self.timer = None, None
        if settings:
            self.edit(rule)
        else:
            self.activate(rule, captured)

    def keyboard(self, rule, settings=False):
        self.cancel()
        if settings or rule is None:
            self.edit(rule)
        else:
            self.activate(rule, self.capture())


class ButtonEvents(unohelper.Base, XActionListener, XMouseListener, XKeyListener):
    def __init__(self, owner, name):
        self.owner, self.name, self.pointer, self.key_settings = owner, name, False, False

    def actionPerformed(self, _):
        if not self.pointer and not self.key_settings:
            self.owner.invoke(self.name)

    def mousePressed(self, event):
        if event.Buttons != 1 or event.PopupTrigger or self.name == "next":
            return
        self.pointer = True
        self.owner.pointer_press(self.name, event.ClickCount)

    def mouseReleased(self, event):
        if self.pointer and not event.PopupTrigger:
            size = event.Source.getPosSize()
            if 0 <= event.X < size.Width and 0 <= event.Y < size.Height:
                self.owner.pointer_release(self.name, event.ClickCount)
            else:
                self.owner.gesture.cancel()

    def keyPressed(self, event):
        self.pointer = False
        self.key_settings = event.KeyCode == uno.getConstantByName("com.sun.star.awt.Key.F4") or (
            event.KeyCode == uno.getConstantByName("com.sun.star.awt.Key.RETURN") and event.Modifiers & 1)
        if self.key_settings:
            self.owner.invoke(self.name, settings=True)

    def mouseEntered(self, _): pass
    def mouseExited(self, _): pass
    def keyReleased(self, _): pass
    def disposing(self, _): pass


class PaletteToolbarController(unohelper.Base, XToolbarController, XInitialization, XServiceInfo,
                               XStatusListener, XUpdatable, XComponent, XCallback):
    def __init__(self, context, *arguments):
        self.context, self.frame, self.window = context, None, None
        self.controls, self.events, self.listeners = {}, {}, []
        self.page, self.last_chosen, self.rules, self.slot_ids = 0, None, [], []
        self.bound_document, self.disposed, self.enabled = None, False, True
        self.creation_error = None
        self.callback = context.ServiceManager.createInstanceWithContext("com.sun.star.awt.AsyncCallback", context)
        self.gesture = ClickGesture(self.capture, self.activate, self.edit, self.post)
        _controllers.add(self)
        self.initialize(arguments)

    def initialize(self, arguments):
        for argument in arguments:
            if argument.Name == "Frame":
                self.frame = argument.Value

    def getImplementationName(self): return IMPLEMENTATION
    def supportsService(self, service): return service in SERVICES
    def getSupportedServiceNames(self): return SERVICES
    def createPopupWindow(self): return None
    def click(self): pass
    def doubleClick(self): pass

    def execute(self, _modifiers):
        if self.window and not self.disposed:
            self.controls["slot0"].setFocus()
        elif self.creation_error and not self.disposed:
            self.report(ValueError(self.creation_error))

    def document(self):
        return self.frame.Controller.Model if self.frame and self.frame.Controller else None

    def bridge(self):
        if self.disposed or not _resolver or self.document() is None:
            return None
        return _resolver(self.frame)

    def create(self, service):
        return self.context.ServiceManager.createInstanceWithContext("com.sun.star.awt." + service, self.context)

    def createItemWindow(self, parent):
        if self.disposed:
            return None
        if self.window:
            return self.window
        try:
            return self.create_palette_window(parent)
        except Exception:
            # LibreOffice holds its layout lock while calling this factory.
            self.creation_error = "The color toolbar could not open. Use the wrAIter menu to open settings."
            window, self.window = self.window, None
            self.controls.clear()
            self.events.clear()
            if window:
                window.dispose()
            return None

    def create_palette_window(self, parent):
        self.window = self.create("UnoControlContainer")
        self.window.setModel(self.create("UnoControlContainerModel"))
        for index, name in enumerate(["slot0", "slot1", "slot2", "slot3", "add", "next"]):
            control, model = self.create("UnoControlButton"), self.create("UnoControlButtonModel")
            model.Label = "+" if name == "add" else str(index + 1)
            model.Tabstop, model.FocusOnClick = True, False
            control.setModel(model)
            control.setActionCommand(name)
            events = ButtonEvents(self, name)
            control.addActionListener(events)
            control.addMouseListener(events)
            control.addKeyListener(events)
            self.window.addControl(name, control)
            self.controls[name], self.events[name] = control, events
        self.window.createPeer(self.create("Toolkit"), parent)
        tab_model, tab_controller = self.create("TabControllerModel"), self.create("TabController")
        tab_model.setControlModels(tuple(control.getModel() for control in self.controls.values()))
        tab_controller.setModel(tab_model)
        tab_controller.setContainer(self.window)
        self.window.setTabControllers((tab_controller,))
        tab_controller.activateTabOrder()
        self.window.setVisible(True)
        self.update()
        self.creation_error = None
        return self.window

    def update(self):
        if self.disposed or not self.window:
            return
        try:
            bridge = self.bridge()
            rules = [dict(rule) for rule in bridge["rules"]] if bridge else []
            if len(rules) > MAX_RULES:
                raise ValueError("The toolbar supports up to 24 colors. Manage older rules in wrAIter settings.")
            document = self.document()
            if rules != self.rules or document != self.bound_document:
                self.gesture.cancel()
            self.rules, self.bound_document = rules, document
            chosen = bridge.get("chosen") if bridge else None
            ids = [rule["id"] for rule in rules]
            if chosen != self.last_chosen and chosen in ids:
                self.page = ids.index(chosen) // 4
            self.last_chosen = chosen
            self.page = min(self.page, max(0, (len(rules) - 1) // 4))
            self.slot_ids = ids[self.page * 4:self.page * 4 + 4]
            for index in range(4):
                control = self.controls["slot" + str(index)]
                rule = rules[self.page * 4 + index] if index < len(self.slot_ids) else None
                control.Model.Label = str(self.page * 4 + index + 1) if rule else "+"
                control.Model.Toggle = bool(rule)
                control.Model.State = int(bool(rule) and rule["id"] == chosen)
                control.Model.BackgroundColor = int(rule["color"][1:], 16) if rule else -1
                control.Model.TextColor = contrasting_text(int(rule["color"][1:], 16)) if rule else -1
                control.Model.HelpText = (rule["name"] + ": click to highlight or arm; double-click, F4 or Shift+Enter for settings.") if rule else "Add a color rule"
                control.setEnable(bool(bridge) and self.enabled and (bool(rule) or len(rules) < MAX_RULES))
            self.controls["add"].Model.HelpText = "Add a color rule"
            self.controls["add"].setEnable(bool(bridge) and self.enabled and len(rules) < MAX_RULES)
            total = len(rules)
            start, end = (self.page * 4 + 1, min(self.page * 4 + 4, total)) if total else (0, 0)
            self.controls["next"].Model.Label = "%s–%s ›" % (start, end)
            self.controls["next"].Model.HelpText = "Next colors (%s–%s of %s)" % (start, end, total)
            self.controls["next"].setEnable(bool(bridge) and self.enabled and total > 4)
            self.layout()
        except Exception as error:
            self.gesture.cancel()
            for control in self.controls.values():
                control.setEnable(False)
                control.Model.HelpText = str(error) if isinstance(error, ValueError) else "wrAIter palette unavailable. Open wrAIter settings."
            self.layout()

    def layout(self):
        sizes = {name: control.getMinimumSize() for name, control in self.controls.items()}
        height = max(28, max(size.Height for size in sizes.values()))
        x = 0
        for name, control in self.controls.items():
            width = max(height, sizes[name].Width)
            control.setPosSize(x, 0, width, height, 15)
            x += width + 2
        self.window.setPosSize(0, 0, x - 2, height, 12)

    def rule_for(self, name):
        index = int(name[4:]) if name.startswith("slot") else len(self.slot_ids)
        return self.slot_ids[index] if index < len(self.slot_ids) else None

    def capture(self):
        bridge = self.bridge()
        if not bridge:
            raise ValueError("Open a Writer document before highlighting.")
        return bridge["capture_selection"]()

    def report(self, error):
        bridge = self.bridge()
        if bridge:
            bridge["status"](str(error) if isinstance(error, ValueError) else "Writer could not complete the toolbar action.")

    def invoke(self, name, settings=False):
        if self.disposed or not self.enabled:
            return
        try:
            if name == "next":
                self.gesture.cancel()
                self.page = (self.page + 1) % max(1, (len(self.rules) + 3) // 4)
                self.update()
            else:
                self.gesture.keyboard(self.rule_for(name), settings)
        except Exception as error:
            self.report(error)

    def pointer_press(self, name, count):
        try:
            self.gesture.press(self.rule_for(name), count)
        except Exception as error:
            self.gesture.cancel()
            self.report(error)

    def pointer_release(self, name, count):
        self.gesture.release(self.rule_for(name), count)

    def post(self, token):
        callback = self.callback
        if not self.disposed and callback:
            callback.addCallback(self, token)

    def notify(self, token):
        if not self.disposed:
            try:
                self.gesture.deliver(token)
            except Exception as error:
                self.report(error)

    def activate(self, rule, captured):
        bridge = self.bridge()
        if not bridge or self.document() != self.bound_document or bridge["rules"] != self.rules:
            raise ValueError("Document or color rules changed. Select the passage and color again.")
        if not any(item["id"] == rule for item in bridge["rules"]):
            raise ValueError("This color rule is no longer available.")
        bridge["mark_or_arm"](rule, capture=captured)
        self.update()

    def edit(self, rule):
        bridge = self.bridge()
        if bridge:
            bridge["edit_rule"](rule)
            self.update()

    def statusChanged(self, event):
        self.enabled = event.IsEnabled
        if not self.enabled:
            self.gesture.cancel()
        self.update()

    def addEventListener(self, listener): self.listeners.append(listener)
    def removeEventListener(self, listener):
        if listener in self.listeners:
            self.listeners.remove(listener)

    def disposing(self, _): self.dispose()

    def dispose(self):
        if self.disposed:
            return
        self.disposed = True
        self.gesture.cancel()
        _controllers.discard(self)
        window, self.window = self.window, None
        if window:
            window.dispose()
        self.controls.clear()
        self.events.clear()
        event = uno.createUnoStruct("com.sun.star.lang.EventObject")
        event.Source = self
        for listener in self.listeners:
            listener.disposing(event)
        self.listeners.clear()
        self.frame, self.callback = None, None
