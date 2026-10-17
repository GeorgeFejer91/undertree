"""Native Writer selective-editor controls, driven by the shared UI contract."""
import json
import uuid
import threading
from pathlib import Path

import uno
import unohelper
from com.sun.star.awt import XActionListener, XCallback, XItemListener, XMouseListener, XWindowListener, XTopWindowListener
from com.sun.star.datatransfer import XTransferable

from undertree_policy import CONTRACT, defaults, validate_rule
from undertree_branding import WindowIcons

LABELS = CONTRACT["labels"]


def contrasting_text(color):
    channels = [((color >> shift) & 255) / 255 for shift in (16, 8, 0)]
    linear = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in channels]
    luminance = sum(value * weight for value, weight in zip(linear, (0.2126, 0.7152, 0.0722)))
    return 0x000000 if (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) else 0xFFFFFF


class Events(unohelper.Base, XActionListener, XItemListener, XWindowListener, XTopWindowListener):
    def __init__(self, owner):
        self.owner = owner

    def actionPerformed(self, event):
        try:
            if event.ActionCommand == "layoutClose":
                self.owner.close()
            elif event.ActionCommand in ("cancel", "close") or not self.owner.no_fit:
                self.owner.action(event.ActionCommand)
        except Exception as error:
            self.owner.status(str(error) if isinstance(error, ValueError) else "Writer could not complete this action. Review the document locally.")

    def itemStateChanged(self, event):
        if not self.owner.updating:
            try:
                self.owner.changed(event.Source.Model.Name)
            except Exception as error:
                self.owner.status(str(error) if isinstance(error, ValueError) else "Writer could not update this control.")

    def windowClosing(self, _):
        self.owner.close()

    def windowResized(self, _):
        self.owner.resize()

    def windowMoved(self, _): pass
    def windowShown(self, _): pass
    def windowHidden(self, _): pass
    def windowOpened(self, _): pass
    def windowClosed(self, _): pass
    def windowMinimized(self, _): pass
    def windowNormalized(self, _): pass
    def windowActivated(self, _): pass
    def windowDeactivated(self, _): pass
    def disposing(self, _): pass


class Dialog:
    def __init__(self, session, title, width, height, parent=None, modal=False):
        self.session, self.context, self.modal = session, session.context, modal
        self.events, self.updating, self.positions = Events(self), False, None
        self.result, self.disposed = None, False
        self.window_icons = None
        self.width, self.height = width, height
        self.stretch, self.right, self.groups = set(), set(), {}
        self.kinds, self.laying_out, self.no_fit = {}, False, False
        self.first_layout, self.layout_fallback = True, True
        self.active_page, self.pages, self.sensitive = None, {}, set()
        self.dialog = self.create("com.sun.star.awt.UnoControlDialog")
        self.model = self.create("com.sun.star.awt.UnoControlDialogModel")
        self.model.Width, self.model.Height, self.model.Title, self.model.Sizeable = min(width, 270), height, title, True
        self.dialog.setModel(self.model)
        self.parent = parent or session.document.CurrentController.Frame.ContainerWindow

    def create(self, name):
        return self.context.ServiceManager.createInstanceWithContext(name, self.context)

    def add(self, name, kind, x, y, width, height, group=0, stretch=False, right=False, page=None, sensitive=False, **properties):
        model = self.model.createInstance("com.sun.star.awt.UnoControl" + kind + "Model")
        model.Name, model.PositionX, model.PositionY, model.Width, model.Height = name, x, y, width, height
        model.TabIndex = len(self.model.ElementNames)
        if kind in ("FixedText", "CheckBox", "RadioButton") and model.PropertySetInfo.hasPropertyByName("MultiLine"):
            model.MultiLine = True
        for key, value in properties.items():
            if key != "ActionCommand":
                setattr(model, key, value)
        self.model.insertByName(name, model)
        control = self.control(name)
        self.groups[name] = group
        self.kinds[name] = kind
        self.pages[name] = page
        if sensitive: self.sensitive.add(name)
        if stretch: self.stretch.add(name)
        if right: self.right.add(name)
        if kind == "Button":
            control.setActionCommand(properties.get("ActionCommand", name))
            control.addActionListener(self.events)
        elif kind in ("CheckBox", "RadioButton", "ListBox"):
            control.addItemListener(self.events)
        return control

    def control(self, name):
        return self.dialog.getControl(name)

    def show(self):
        if self.layout_fallback:
            self.add("layoutDetail", "Edit", 0, 0, 1, 1, ReadOnly=True, MultiLine=True, VScroll=True)
            self.add("layoutClose", "Button", 0, 0, 1, 1, Label="Close")
        self.dialog.createPeer(self.create("com.sun.star.awt.Toolkit"), self.parent)
        self.window_icons = WindowIcons(self.dialog.getPeer())
        self.base = self.dialog.getPosSize()
        self.all_positions = {name: self.control(name).getPosSize() for name in self.model.ElementNames if not name.startswith("layout")}
        self.set_page(self.active_page, resize=False)
        if self.layout_fallback:
            self.control("layoutDetail").setVisible(False)
            self.control("layoutClose").setVisible(False)
        self.resize()
        self.dialog.addWindowListener(self.events)
        self.dialog.addTopWindowListener(self.events)
        self.dialog.setVisible(True)
        if self.modal:
            self.dialog.execute()
            self.dispose()
        return self.result

    def set_page(self, page, resize=True):
        self.active_page = page
        if not hasattr(self, "all_positions"): return
        self.positions = {name: box for name, box in self.all_positions.items() if self.pages[name] in (None, page)}
        for name in self.all_positions: self.control(name).setVisible(name in self.positions)
        if resize: self.resize()

    def resize(self):
        if not self.positions or self.disposed or self.laying_out:
            return
        self.laying_out = True
        try:
            current = self.dialog.getPosSize()
            work = self.create("com.sun.star.awt.Toolkit").getWorkArea()
            if work.Width <= 0 or work.Height <= 0:
                raise ValueError("Writer could not determine a usable display area.")
            margin = max(12, min(box.X for box in self.positions.values()))
            width = min(max(360, current.Width), max(360, work.Width - 2 * margin))
            inner = width - 2 * margin
            gap = max(6, min(12, min(width // 80, current.Height // 60)))
            groups = []
            too_wide = False
            for group in sorted(set(self.groups[name] for name in self.positions)):
                names = sorted((name for name in self.positions if self.groups[name] == group), key=lambda name: (self.positions[name].Y, self.positions[name].X))
                bands = []
                for name in names:
                    box = self.positions[name]
                    if not bands or box.Y >= bands[-1][0]:
                        bands.append([box.Y + box.Height, []])
                    bands[-1][0] = max(bands[-1][0], box.Y + box.Height)
                    bands[-1][1].append(name)
                rows = []
                for _, band in bands:
                    cells = []
                    for name in sorted(band, key=lambda name: self.positions[name].X):
                        control, kind = self.control(name), self.kinds[name]
                        minimum = control.getMinimumSize()
                        if kind in ("Edit", "ListBox"):
                            preferred = min(180, self.positions[name].Width)
                        elif name in self.stretch:
                            preferred = min(inner, max(120, minimum.Width))
                        else:
                            preferred = max(24, minimum.Width)
                        too_wide = too_wide or (kind == "Button" and preferred > inner)
                        preferred = min(inner, preferred)
                        cells.append([name, preferred, 0])
                    units = []
                    for cell in cells:
                        if units and (units[-1][-1][0].endswith("Label") or (cell[0].startswith("configure") and units[-1][-1][0].startswith("slot"))):
                            units[-1].append(cell)
                        else:
                            units.append([cell])
                    if units and all(unit[0][0].startswith("slot") for unit in units):
                        widest = max(sum(cell[1] for cell in unit) + gap * (len(unit) - 1) for unit in units)
                        columns = 4 if 4 * widest + 3 * gap <= inner else 2 if 2 * widest + gap <= inner else 1
                        for unit in units:
                            unit[0][1] = (inner - gap * (columns - 1)) // columns - gap - unit[1][1]
                    row, used = [], 0
                    for unit in units:
                        unit_width = sum(cell[1] for cell in unit) + gap * (len(unit) - 1)
                        if row and used + gap + unit_width > inner:
                            rows.append(row)
                            row, used = [], 0
                        if unit_width > inner:
                            rows.extend([[cell] for cell in unit])
                        else:
                            used += unit_width + (gap if row else 0)
                            row.extend(unit)
                    if row: rows.append(row)
                for row in rows:
                    surplus = inner - sum(cell[1] for cell in row) - gap * (len(row) - 1)
                    flexible = [cell for cell in row if cell[0] in self.stretch or cell[0].startswith("slot")]
                    for index, cell in enumerate(flexible):
                        cell[1] += surplus // len(flexible) + int(index < surplus % len(flexible))
                    for cell in row:
                        name, allocated, _ = cell
                        control, kind = self.control(name), self.kinds[name]
                        size = uno.createUnoStruct("com.sun.star.awt.Size")
                        size.Width = allocated
                        required = control.calcAdjustedSize(size)
                        cell[2] = max(1, required.Height)
                        if kind in ("Edit", "ListBox"):
                            multiline = getattr(control.Model, "MultiLine", False) or (kind == "ListBox" and not control.Model.Dropdown)
                            cell[2] = max(cell[2], int(self.positions[name].Height * .7) if multiline else control.getMinimumSize().Height)
                groups.append(rows)
            group_heights = [sum(max(cell[2] for cell in row) for row in rows) + gap * (len(rows) - 1) for rows in groups]
            minimum_height = 2 * margin + sum(group_heights) + gap * (len(groups) - 1)
            height = min(minimum_height if self.first_layout else max(current.Height, minimum_height), max(1, work.Height - 2 * margin))
            self.no_fit = too_wide or minimum_height > height
            self.place_window(current, work, width, height)
            for name in self.positions: self.control(name).setVisible(not self.no_fit)
            if self.no_fit:
                self.show_layout_detail(width, height, margin, gap)
            else:
                self.control("layoutDetail").setVisible(False)
                self.control("layoutClose").setVisible(False)
                surplus = height - minimum_height
                y = margin
                for index, rows in enumerate(groups):
                    for row in rows:
                        row_height = max(cell[2] for cell in row)
                        used = sum(cell[1] for cell in row) + gap * (len(row) - 1)
                        right = all(cell[0] in self.right for cell in row)
                        paired = any(cell[0].endswith("Label") or cell[0].startswith("configure") for cell in row)
                        inline_gap = gap + ((inner - used) // (len(row) - 1) if len(row) > 1 and not right and not paired else 0)
                        x = margin + (inner - used if right else 0)
                        for name, cell_width, cell_height in row:
                            self.control(name).setPosSize(x, y + (row_height - cell_height) // 2, cell_width, cell_height, 15)
                            x += cell_width + inline_gap
                        y += row_height + gap
                    if index + 1 < len(groups):
                        y += surplus // max(1, len(groups) - 1) + int(index < surplus % max(1, len(groups) - 1))
            self.first_layout = False
        finally:
            self.laying_out = False

    def place_window(self, current, work, width, height):
        x, y, flags = current.X, current.Y, 12
        if self.first_layout:
            parent = self.parent.getPosSize()
            x = max(work.X, min(work.X + work.Width - width, parent.X + (parent.Width - width) // 2))
            y = max(work.Y, min(work.Y + work.Height - height, parent.Y + (parent.Height - height) // 2))
            flags = 15
        self.dialog.setPosSize(x, y, width, height, flags)

    def show_layout_detail(self, width, height, margin, gap):
        lines = ["More room is needed at this text size. Enlarge the window or display to use these controls."]
        for name in self.positions:
            model = self.control(name).Model
            value = "[Hidden credential]" if name in self.sensitive else getattr(model, "Label", "") or getattr(model, "Text", "")
            if value: lines.append(value)
        detail, close = self.control("layoutDetail"), self.control("layoutClose")
        detail.Model.Text = "\n\n".join(lines)
        minimum = close.getMinimumSize()
        close.setPosSize(width - margin - minimum.Width, height - margin - minimum.Height, minimum.Width, minimum.Height, 15)
        detail.setPosSize(margin, margin, width - 2 * margin, max(1, height - 2 * margin - gap - minimum.Height), 15)
        detail.setVisible(True)
        close.setVisible(True)

    def status(self, text):
        if self.model.hasByName("status"):
            if self.control("status").Model.Label != text:
                self.control("status").Model.Label = text
                self.resize()

    def close(self):
        if self.modal:
            self.dialog.endExecute()
        else:
            self.dispose()

    def dispose(self):
        if not self.disposed:
            self.disposed = True
            try:
                self.dialog.dispose()
            finally:
                if self.window_icons:
                    self.window_icons.close()

    def changed(self, _): pass
    def action(self, _): pass


class HighlightRuleChoice(Dialog):
    def __init__(self, panel, marks):
        super().__init__(panel.session, "Choose overlapping highlight", 440, 190, panel.dialog.getPeer(), True)
        self.marks = marks
        self.add("intro", "FixedText", 8, 8, 424, 30, stretch=True, MultiLine=True,
                 Label="Several highlights overlap here. Choose the exact color/marker whose local rule you want to open.")
        self.add("choices", "ListBox", 8, 45, 424, 85, group=1, stretch=True, Dropdown=False,
                 StringItemList=tuple(mark["name"] + " " + mark["color"] + " · " + mark["action"] + " · " + mark["id"][-8:] for mark in marks),
                 HelpText="\n".join(mark["name"] + " " + mark["color"] + " · " + mark["action"] + " · " + mark["id"] for mark in marks))
        self.add("status", "FixedText", 8, 136, 424, 20, group=2, stretch=True, Label="")
        self.add("open", "Button", 220, 164, 108, 20, group=3, right=True, Label="Open color rule")
        self.add("cancel", "Button", 336, 164, 96, 20, group=3, right=True, Label="Cancel")

    def action(self, name):
        if name == "cancel": self.close()
        elif name == "open":
            selected = self.control("choices").getSelectedItemPos()
            if selected < 0:
                raise ValueError("Choose a highlight explicitly.")
            self.result = self.marks[selected]["ruleId"]
            self.close()


class RuleDialog(Dialog):
    def __init__(self, panel, rule_id=None):
        super().__init__(panel.session, LABELS["editRule"] if rule_id else LABELS["newRule"], 450, 383, panel.dialog.getPeer(), True)
        self.panel, self.rule_id = panel, rule_id or uuid.uuid4().hex
        existing = panel.session.data["rules"].get(self.rule_id)
        rule = existing or {"name": "New color rule", "color": "#6c8fb5", "action": "edit", "prompt": "", "mode": "suggestion"}
        self.active_page = "color"
        self.add("colorPage", "Button", 8, 8, 138, 20, Label="Color & behavior", Toggle=True, State=1)
        self.add("wordingPage", "Button", 154, 8, 134, 20, Label="Wording", Toggle=True)
        self.add("accessPage", "Button", 296, 8, 146, 20, right=True, Label="Access", Toggle=True)
        self.add("colorLabel", "FixedText", 8, 43, 44, 12, group=1, page="color", Label=LABELS["color"])
        self.add("color", "Edit", 55, 40, 82, 18, group=1, page="color", Text=rule["color"], MaxTextLen=7)
        self.add("chooseColor", "Button", 143, 40, 65, 18, group=1, page="color", Label="Choose…")
        self.add("nameLabel", "FixedText", 216, 43, 66, 12, group=1, page="color", Label=LABELS["ruleName"])
        self.add("name", "Edit", 285, 40, 157, 18, group=1, page="color", stretch=True, Text=rule["name"], MaxTextLen=100)
        self.add("behavior", "FixedText", 8, 72, 434, 13, group=2, page="color", stretch=True, Label=LABELS["actionGroup"])
        for index, action in enumerate(CONTRACT["actions"]):
            self.add("action_" + action["id"], "RadioButton", 12 + index % 2 * 215, 89 + index // 2 * 18, 210, 16, group=2, page="color",
                     Label=action["label"], GroupName="behavior", State=int(("prompt" if rule["action"] == "edit" else rule["action"]) == action["id"]))
        self.add("instructions", "FixedText", 8, 40, 434, 13, group=2, page="wording", stretch=True, Label=LABELS["instructionsGroup"])
        lines = rule["prompt"].split("\n")
        extra = max(0, (len(CONTRACT["presets"]) + 1) // 2 - 1) * 18
        for index, preset in enumerate(CONTRACT["presets"]):
            checked = preset["prompt"] in lines
            if checked: lines.remove(preset["prompt"])
            self.add("preset_" + preset["id"], "CheckBox", 12 + index % 2 * 215, 57 + index // 2 * 18, 210, 17, group=2, page="wording", Label=preset["label"], State=int(checked))
        self.add("promptLabel", "FixedText", 8, 78 + extra, 434, 12, group=2, page="wording", stretch=True, Label=LABELS["customPrompt"])
        self.add("prompt", "Edit", 8, 94 + extra, 434, 48, group=2, page="wording", stretch=True, MultiLine=True, VScroll=True, Text="\n".join(lines), MaxTextLen=4000)
        self.add("access", "FixedText", 8, 40, 434, 13, group=3, page="access", stretch=True, Label=LABELS["accessGroup"])
        for index, mode in enumerate(CONTRACT["accessModes"]):
            self.add("mode_" + mode["id"], "RadioButton", 12, 57 + index * 19, 430, 17, group=3, page="access", stretch=True,
                     Label=mode["label"], GroupName="access", State=int(("suggestions" if rule["mode"] == "suggestion" else rule["mode"]) == mode["id"]))
        self.add("help", "FixedText", 8, 104, 434, 30, group=4, page="access", stretch=True, Label=LABELS["ruleHelp"], MultiLine=True)
        self.add("status", "FixedText", 8, 332 + extra, 434, 22, group=4, stretch=True, Label="", MultiLine=True)
        self.add("save", "Button", 202, 359 + extra, 145, 20, group=5, right=True, Label=LABELS["saveRule"], DefaultButton=True)
        self.add("cancel", "Button", 355, 359 + extra, 87, 20, group=5, right=True, Label=LABELS["cancel"])
        self.changed("action")

    def chosen_action(self):
        return next(action["id"] for action in CONTRACT["actions"] if self.control("action_" + action["id"]).Model.State == 1)

    def changed(self, name):
        if name.startswith("action"):
            editable = self.chosen_action() == "prompt"
            self.control("mode_direct").setEnable(editable)
            for control_name in ("prompt", "promptLabel", "instructions", "mode_suggestions", *("preset_" + preset["id"] for preset in CONTRACT["presets"])):
                self.control(control_name).setEnable(editable)
            if not editable:
                self.control("mode_direct").Model.State = 0
                self.control("mode_suggestions").Model.State = 1

    def action(self, name):
        if name in ("colorPage", "wordingPage", "accessPage"):
            self.set_page(name[:-4])
            for page in ("color", "wording", "access"):
                self.control(page + "Page").Model.State = int(self.active_page == page)
        elif name == "cancel": self.close()
        elif name == "chooseColor":
            value = ColorPicker(self, self.control("color").Model.Text).show()
            if value is not None: self.control("color").Model.Text = value
        elif name == "save":
            action = self.chosen_action()
            prompt = "\n".join([preset["prompt"] for preset in CONTRACT["presets"] if self.control("preset_" + preset["id"]).Model.State == 1] + [self.control("prompt").Model.Text.strip()]).strip()
            rule = {"name": self.control("name").Model.Text.strip(), "color": self.control("color").Model.Text.lower(),
                    "prompt": prompt if action == "prompt" else "", "action": "edit" if action == "prompt" else action,
                    "mode": "direct" if action == "prompt" and self.control("mode_direct").Model.State == 1 else "suggestion"}
            validate_rule(rule)
            self.session.save_rule(self.rule_id, rule)
            self.result = self.rule_id
            self.close()


class ColorPicker(Dialog):
    COLORS = (("Yellow", "#fff59d"), ("Green", "#a5d6a7"), ("Blue", "#90caf9"), ("Purple", "#ce93d8"),
              ("Orange", "#ffcc80"), ("Pink", "#f48fb1"), ("Red", "#ef9a9a"), ("Teal", "#80cbc4"),
              ("White", "#ffffff"), ("Gray", "#bdbdbd"), ("Brown", "#bcaaa4"), ("Black", "#000000"))

    def __init__(self, owner, value):
        super().__init__(owner.session, "Choose color", 270, 175, owner.dialog.getPeer(), True)
        self.add("intro", "FixedText", 8, 8, 254, 14, stretch=True, Label="Choose a color or enter its exact hex value.")
        for index, (label, color) in enumerate(self.COLORS):
            numeric = int(color[1:], 16)
            self.add("swatch" + str(index), "Button", 8 + index % 4 * 64, 31 + index // 4 * 25, 62, 22,
                     group=1, Label=label, HelpText=label + " " + color, BackgroundColor=numeric, TextColor=contrasting_text(numeric))
        self.add("hexLabel", "FixedText", 8, 112, 62, 14, group=2, Label="Hex color")
        self.add("hex", "Edit", 78, 109, 184, 20, group=2, stretch=True, Text=value, MaxTextLen=7, HelpText="Six hexadecimal digits, for example #90caf9.")
        self.add("status", "FixedText", 8, 138, 254, 18, group=3, stretch=True, Label="")
        self.add("save", "Button", 124, 164, 66, 20, group=4, right=True, Label="Use color")
        self.add("cancel", "Button", 198, 164, 64, 20, group=4, right=True, Label="Cancel")

    def action(self, name):
        if name.startswith("swatch"):
            self.control("hex").Model.Text = self.COLORS[int(name[6:])][1]
        elif name == "save":
            value = self.control("hex").Model.Text.strip().lower()
            if len(value) != 7 or value[0] != "#" or any(character not in "0123456789abcdef" for character in value[1:]):
                raise ValueError("Enter # followed by six hexadecimal digits.")
            self.result = value
            self.close()
        elif name == "cancel": self.close()


class HighlightDialog(Dialog):
    def __init__(self, panel):
        super().__init__(panel.session, LABELS["highlightTitle"], 440, 263, panel.dialog.getPeer(), True)
        self.panel = panel
        selection = self.session.document.CurrentController.getSelection()
        if not hasattr(selection, "getCount") or selection.getCount() != 1 or not selection.getByIndex(0).String:
            raise ValueError("Select one main-body passage in Writer first.")
        selected = selection.getByIndex(0)
        self.selection = self.session.document.Text.createTextCursorByRange(selected.Start)
        self.selection.gotoRange(selected.End, True)
        self.quote = self.selection.String
        self.rule_ids = list(self.session.data["rules"])
        self.add("quote", "Edit", 8, 8, 424, 62, stretch=True, Text=self.quote, ReadOnly=True, MultiLine=True, VScroll=True)
        self.add("ruleLabel", "FixedText", 8, 80, 94, 12, group=1, Label=LABELS["highlightRule"])
        self.add("rules", "ListBox", 105, 76, 327, 20, group=1, stretch=True, Dropdown=True,
                 StringItemList=tuple(self.session.data["rules"][key]["name"] for key in self.rule_ids))
        self.control("rules").Model.SelectedItems = (self.rule_ids.index(panel.selected_rule),)
        self.add("promptLabel", "FixedText", 8, 105, 424, 13, group=2, stretch=True, Label=LABELS["passagePrompt"])
        self.add("prompt", "Edit", 8, 123, 424, 55, group=2, stretch=True, MultiLine=True, VScroll=True, MaxTextLen=4000)
        self.add("help", "FixedText", 8, 187, 424, 28, group=3, stretch=True, Label=LABELS["highlightHelp"], MultiLine=True)
        self.add("status", "FixedText", 8, 217, 424, 18, group=3, stretch=True, Label="")
        self.add("add", "Button", 212, 239, 128, 20, group=4, right=True, Label=LABELS["addHighlight"], DefaultButton=True)
        self.add("cancel", "Button", 348, 239, 84, 20, group=4, right=True, Label=LABELS["cancel"])

    def action(self, name):
        if name == "cancel": self.close()
        elif name == "add":
            if self.selection.String != self.quote:
                raise ValueError("The selected passage changed. Select and highlight it again.")
            self.session.document.CurrentController.select(self.selection)
            rule_id = self.rule_ids[self.control("rules").getSelectedItemPos()]
            self.result = self.session.mark_selection(rule_id, self.control("prompt").Model.Text)
            self.panel.selected_rule = rule_id
            self.close()


class ContextConsent(Dialog):
    def __init__(self, connections, snapshot):
        super().__init__(connections.session, LABELS["contextTitle"], 440, 278, connections.dialog.getPeer(), True)
        self.snapshot = snapshot
        self.layout_fallback = False
        self.laying_out = False
        self.no_fit = True
        files = snapshot["context"]["files"]
        self.add("document", "FixedText", 8, 8, 424, 24, stretch=True, MultiLine=True, Label=self.session.document.Title)
        self.add("snapshotLabel", "FixedText", 8, 36, 80, 13, group=1, Label=LABELS["contextSnapshot"])
        self.add("snapshot", "FixedText", 92, 36, 340, 26, group=1, stretch=True, MultiLine=True, Label=LABELS["currentSnapshot"])
        self.add("scopeLabel", "FixedText", 8, 67, 424, 12, group=2, stretch=True, Label=LABELS["contextFiles"])
        listing = self.session.document.Title + "\n" + LABELS["currentSnapshot"] + "\n" + LABELS["contextHelp"] + "\n" + LABELS["currentContextHelp"] + "\n\n"
        listing += "\n".join(file["path"] + " — " + str(len(file["content"])) + " characters" for file in files)
        self.add("scope", "Edit", 8, 84, 424, 88, group=2, stretch=True, Text=listing or "Empty current Writer document", ReadOnly=True, MultiLine=True, VScroll=True)
        self.add("help", "FixedText", 8, 180, 424, 45, group=3, stretch=True, Label=LABELS["contextHelp"] + "\n" + LABELS["currentContextHelp"], MultiLine=True)
        self.add("status", "FixedText", 8, 227, 424, 22, group=3, stretch=True, Label="", MultiLine=True)
        self.add("share", "Button", 216, 253, 128, 20, group=4, right=True, Label=LABELS["shareContextAction"], DefaultButton=True)
        self.add("cancel", "Button", 352, 253, 80, 20, group=4, right=True, Label=LABELS["cancel"])

    def show(self):
        modal, self.modal = self.modal, False
        super().show()
        self.modal = modal
        self.resize()
        if modal:
            self.dialog.execute()
            self.dispose()
        return self.result

    def resize(self):
        if not self.positions or self.disposed or self.laying_out:
            return
        self.laying_out = True
        self.no_fit = True
        self.control("share").setEnable(False)
        try:
            current = self.dialog.getPosSize()
            margin = self.positions["document"].X
            gap = max(8, margin // 2)
            work = self.create("com.sun.star.awt.Toolkit").getWorkArea()
            if work.Width <= 0 or work.Height <= 0:
                self.no_fit = True
                self.control("share").setEnable(False)
                raise ValueError("Writer could not determine a usable display area. Nothing was shared.")
            width = max(min(self.base.Width, work.Width - 2 * margin), current.Width)
            buttons = {name: self.control(name).getMinimumSize() for name in ("share", "cancel")}
            button_widths = {name: max(self.positions[name].Width, size.Width) for name, size in buttons.items()}
            width = max(width, min(sum(button_widths.values()) + gap + 2 * margin, work.Width - 2 * margin))
            inner = width - 2 * margin
            def required(name, allocated_width):
                size = uno.createUnoStruct("com.sun.star.awt.Size")
                size.Width = max(1, allocated_width)
                return self.control(name).calcAdjustedSize(size).Height
            snapshot_label_width = max(self.positions["snapshotLabel"].Width, self.control("snapshotLabel").getMinimumSize().Width)
            snapshot_width = max(1, inner - snapshot_label_width - gap)
            heights = {name: required(name, inner) for name in ("document", "scopeLabel", "help")}
            heights["snapshot"] = max(required("snapshotLabel", snapshot_label_width), required("snapshot", snapshot_width))
            button_height = max(self.positions["share"].Height, *(size.Height for size in buttons.values()))
            stacked_buttons = sum(button_widths.values()) + gap > inner
            footer_height = button_height * (2 if stacked_buttons else 1) + (gap if stacked_buttons else 0)
            minimum_scope = max(self.positions["scope"].Height // 2, heights["scopeLabel"] * 3)
            status_text = self.control("status").Model.Label
            if status_text.startswith("More room is needed at this text size."):
                self.control("status").Model.Label = status_text = ""
            status_height = required("status", inner) if status_text else 0
            minimum_height = 2 * margin + sum(heights.values()) + minimum_scope + status_height + footer_height + 6 * gap
            height = min(max(minimum_height if self.first_layout else current.Height, minimum_height), work.Height - 2 * margin)
            no_fit = minimum_height > height or sum(button_widths.values()) + gap > inner or snapshot_label_width + gap >= inner
            for name in ("document", "snapshotLabel", "snapshot", "help"):
                self.control(name).setVisible(not no_fit)
            if no_fit:
                self.control("status").Model.Label = "More room is needed at this text size. Enlarge the display before sharing."
                status_height = required("status", inner)
            self.place_window(current, work, width, height)
            y = margin
            if not no_fit:
                self.control("document").setPosSize(margin, y, inner, heights["document"], 15)
                y += heights["document"] + gap
                self.control("snapshotLabel").setPosSize(margin, y, snapshot_label_width, heights["snapshot"], 15)
                self.control("snapshot").setPosSize(margin + snapshot_label_width + gap, y, snapshot_width, heights["snapshot"], 15)
                y += heights["snapshot"] + gap
            self.control("scopeLabel").setPosSize(margin, y, inner, heights["scopeLabel"], 15)
            y += heights["scopeLabel"] + gap
            footer_y = height - margin - footer_height
            help_height = heights["help"] if not no_fit else 0
            scope_height = footer_y - y - help_height - status_height - gap * (2 + bool(help_height) + bool(status_height))
            self.control("scope").setVisible(scope_height > 0)
            self.control("scope").setPosSize(margin, y, inner, max(1, scope_height), 15)
            y += max(0, scope_height) + gap
            if help_height:
                self.control("help").setPosSize(margin, y, inner, help_height, 15)
                y += help_height + gap
            self.control("status").setPosSize(margin, y, inner, status_height, 15)
            cancel_width = button_widths["cancel"]
            share_width = button_widths["share"]
            self.control("cancel").setPosSize(width - margin - cancel_width, footer_y + (button_height + gap if stacked_buttons else 0), cancel_width, button_height, 15)
            self.control("share").setPosSize(margin if stacked_buttons else width - margin - cancel_width - gap - share_width,
                                              footer_y, min(inner, share_width), button_height, 15)
            self.no_fit = no_fit
            self.control("share").setEnable(not no_fit)
            self.first_layout = False
        finally:
            self.laying_out = False

    def action(self, name):
        if name == "cancel": self.close()
        elif name == "share":
            if self.no_fit or self.laying_out:
                raise ValueError("This context preview needs more room before sharing.")
            self.session.set_shared(True, expected_revision=self.snapshot["revision"])
            self.result = True
            self.close()


class RefreshPulse(unohelper.Base, XCallback):
    def __init__(self, owner):
        self.owner, self.timer, self.closed = owner, None, False

    def start(self):
        if not self.closed:
            self.timer = threading.Timer(1, self.post)
            self.timer.daemon = True
            self.timer.start()

    def post(self):
        if not self.closed:
            try: self.owner.session.async_callback.addCallback(self, None)
            except Exception: self.close()

    def notify(self, _):
        if not self.closed and not self.owner.disposed:
            try: self.owner.refresh()
            finally: self.start()

    def close(self):
        self.closed = True
        if self.timer: self.timer.cancel()


class TunnelSetup(Dialog):
    def __init__(self, connections):
        super().__init__(connections.session, "Writer's own zrok connection", 490, 310, connections.dialog.getPeer(), True)
        self.connections = connections
        tunnel = self.session.connection.tunnel
        settings = tunnel.settings()
        bundled = Path(__file__).with_name("zrok2.exe")
        values = {"reservation": "", "publicUrl": "", "zrokExecutable": str(bundled) if bundled.is_file() else "", "enrollmentHome": "", **settings}
        if not values["zrokExecutable"] and bundled.is_file():
            values["zrokExecutable"] = str(bundled)
        self.add("intro", "FixedText", 8, 8, 474, 36, stretch=True, MultiLine=True,
                 Label="Writer runs its own bridge. Use a dedicated zrok public name and an enabled zrok account. UnderTree is not required.")
        for index, (name, label) in enumerate((("reservation", "Writer public name"), ("publicUrl", "Exact public HTTPS origin"),
                                              ("zrokExecutable", "zrok2 executable"), ("enrollmentHome", "Enrollment home (blank uses your zrok account)"))):
            self.add(name + "Label", "FixedText", 8, 51 + index * 43, 474, 14, group=index + 1, stretch=True, Label=label)
            self.add(name, "Edit", 8, 67 + index * 43, 474, 20, group=index + 1, stretch=True, Text=values[name])
        self.add("status", "FixedText", 8, 232, 474, 38, group=5, stretch=True, MultiLine=True, Label="No document is shared by saving connection setup.")
        self.add("save", "Button", 268, 282, 120, 20, group=6, right=True, Label="Save connection")
        self.add("cancel", "Button", 396, 282, 86, 20, group=6, right=True, Label="Cancel")

    def action(self, name):
        if name == "cancel": self.close()
        elif name == "save":
            values = {key: self.control(key).Model.Text.strip() for key in ("reservation", "publicUrl", "zrokExecutable", "enrollmentHome")}
            self.session.connection.tunnel.configure(values)
            self.close()


class PairedPrograms(Dialog):
    def __init__(self, connections):
        super().__init__(connections.session, "Pair another program", 500, 300, connections.dialog.getPeer())
        self.peer_ids, self.future = [], None
        self.add("intro", "FixedText", 8, 8, 484, 40, stretch=True, MultiLine=True,
                 Label="Paste the other program's MCP URL to use its separately permitted review tools through Writer's bridge. Each program works independently; pairing does not share documents or change permissions.")
        self.add("urlLabel", "FixedText", 8, 55, 484, 13, group=1, stretch=True, Label="Other program's MCP URL")
        self.add("url", "Edit", 8, 72, 354, 21, group=1, stretch=True)
        self.add("connect", "Button", 370, 72, 122, 21, group=1, right=True, Label="Pair program")
        self.add("peers", "ListBox", 8, 105, 484, 66, group=2, stretch=True)
        self.add("remove", "Button", 354, 181, 138, 21, group=3, right=True, Label="Remove pairing")
        self.add("status", "FixedText", 8, 214, 484, 45, group=4, stretch=True, MultiLine=True,
                 Label="For the other direction, copy this Writer MCP URL into the other program's connected-app settings.")
        self.add("close", "Button", 370, 272, 122, 20, group=5, right=True, Label="Close")
        self.pulse = RefreshPulse(self)
        self.refresh()

    def show(self):
        result = super().show()
        self.pulse.start()
        return result

    def refresh(self):
        peers = self.session.connection.peers.status()
        selected = self.control("peers").getSelectedItemPos()
        chosen = self.peer_ids[selected] if 0 <= selected < len(self.peer_ids) else None
        self.peer_ids = [item["id"] for item in peers]
        self.control("peers").Model.StringItemList = tuple(item["label"] + " · " + item["status"] + " · " + str(item["toolCount"]) + " tools" for item in peers)
        self.control("peers").Model.SelectedItems = (self.peer_ids.index(chosen) if chosen in self.peer_ids else 0,) if self.peer_ids else ()
        if self.future and self.future.done():
            try:
                self.future.result()
                self.status("Program paired. Refresh your AI connector's tool list to see its review tools.")
            except ValueError as error: self.status(str(error))
            self.future = None
        self.control("connect").setEnable(self.future is None)

    def action(self, name):
        if name == "connect":
            self.future = self.session.connection.peers.link(self.control("url").Model.Text.strip(), "Paired editor")
            self.status("Connecting to the other program…")
        elif name == "remove":
            selected = self.control("peers").getSelectedItemPos()
            if not 0 <= selected < len(self.peer_ids): raise ValueError("Select a paired program.")
            self.session.connection.peers.unlink(self.peer_ids[selected])
        elif name == "close": self.dispose()
        if not self.disposed: self.refresh()

    def dispose(self):
        self.pulse.close()
        super().dispose()


class Connections(Dialog):
    def __init__(self, panel):
        super().__init__(panel.session, LABELS["connections"], 270, 192, panel.dialog.getPeer())
        self.panel = panel
        self.paired = self.details = None
        self.github_setup = None
        self.active_page = "review"
        self.pulse = RefreshPulse(self)
        self.add("intro", "FixedText", 8, 8, 105, 16, Label="wrAIter connections", FontWeight=150)
        self.add("reconnect", "CheckBox", 145, 8, 117, 16, right=True, Label="Reconnect at startup", HelpText="Reconnect when Writer opens; document sharing is never restored.")
        self.add("reviewPage", "Button", 8, 31, 120, 20, group=1, Label="Document review", Toggle=True, State=1)
        self.add("projectPage", "Button", 138, 31, 124, 20, group=1, right=True, Label="Project & GitHub", Toggle=True)
        self.add("bridge", "FixedText", 8, 62, 254, 14, group=2, page="review", stretch=True, Label="GPT access", FontWeight=150)
        self.add("start", "Button", 8, 79, 120, 20, group=2, page="review", Label=LABELS["startAccess"])
        self.add("stop", "Button", 138, 79, 124, 20, group=2, page="review", right=True, Label=LABELS["stopAccess"])
        self.add("addressLabel", "FixedText", 8, 109, 254, 13, group=3, page="review", stretch=True, Label="MCP Address", FontWeight=150)
        self.add("url", "Edit", 8, 126, 200, 20, group=3, page="review", stretch=True, ReadOnly=True)
        self.add("copy", "Button", 216, 126, 46, 20, group=3, page="review", right=True, Label="Copy", HelpText=LABELS["copyAddress"])
        self.add("scopeLabel", "FixedText", 8, 157, 254, 13, group=4, page="review", stretch=True, Label="Selected document", FontWeight=150)
        self.add("scope", "Edit", 8, 174, 254, 20, group=4, page="review", stretch=True, ReadOnly=True, Text=self.session.document.Title)
        self.add("share", "CheckBox", 8, 201, 254, 18, group=4, page="review", stretch=True, Label="Share document context", HelpText=LABELS["shareContext"])
        self.add("readHelp", "FixedText", 8, 224, 254, 14, group=4, page="review", stretch=True, Label="Edits stay inside your highlights.")
        self.add("folderLabel", "FixedText", 8, 62, 254, 14, group=2, page="project", stretch=True, Label="Selected project folder", FontWeight=150)
        self.add("folder", "Edit", 8, 82, 190, 20, group=2, page="project", stretch=True, ReadOnly=True)
        self.add("browseFolder", "Button", 206, 82, 56, 20, group=2, page="project", right=True, Label="Choose…")
        self.add("folder_read", "RadioButton", 8, 112, 100, 17, group=3, page="project", Label="Read", GroupName="folderAccess", State=1)
        self.add("folder_read_write", "RadioButton", 138, 112, 124, 17, group=3, page="project", Label="Read + write", GroupName="folderAccess")
        self.add("grantFolder", "Button", 8, 137, 120, 20, group=3, page="project", Label="Allow folder access")
        self.add("revokeFolder", "Button", 138, 137, 124, 20, group=3, page="project", right=True, Label="Revoke folder access")
        self.add("folderHelp", "FixedText", 8, 164, 254, 28, group=3, page="project", stretch=True, Label="Choosing a folder grants nothing. Allow access only after checking its full path and mode. Reopening Writer restores the choice, never access.")
        self.add("githubLabel", "FixedText", 8, 203, 254, 14, group=4, page="project", stretch=True, Label="GitHub", FontWeight=150)
        self.add("githubState", "FixedText", 8, 223, 254, 20, group=4, page="project", stretch=True, Label="Not connected")
        self.add("githubEnable", "CheckBox", 8, 250, 170, 18, group=4, page="project", Label="Enable GitHub writes")
        self.add("github", "Button", 196, 250, 66, 20, group=4, page="project", right=True, Label="GitHub…")
        self.add("status", "FixedText", 8, 289, 254, 30, group=7, stretch=True, MultiLine=True, Label="")
        self.add("setup", "Button", 8, 330, 75, 20, group=8, Label="Setup…")
        self.add("pair", "Button", 91, 330, 76, 20, group=8, Label="Pair program…")
        self.add("help", "Button", 175, 330, 40, 20, group=8, Label="Details…")
        self.add("close", "Button", 223, 330, 39, 20, group=8, right=True, Label="Close")
        self.refresh()

    def show(self):
        result = super().show()
        self.pulse.start()
        return result

    def refresh(self):
        self.updating = True
        try:
            self.control("reviewPage").Model.State = int(self.active_page == "review")
            self.control("projectPage").Model.State = int(self.active_page == "project")
            self.control("share").Model.State = int(self.session.shared)
            self.control("scope").Model.Text = self.session.document.Title
            tunnel = self.session.connection.tunnel.status() if self.session.connection else {}
            self.control("url").Model.Text = tunnel.get("endpoint") or (self.session.endpoint.url if self.session.endpoint else "")
            self.control("reconnect").setEnable(self.session.connection is not None)
            state = self.session.connection.status() if self.session.connection else {}
            self.control("reconnect").Model.State = int(state.get("autoReconnect", False))
            self.control("setup").setEnable(self.session.connection is not None)
            self.control("pair").setEnable(self.session.connection is not None)
            project = getattr(self.session.connection, "project", None)
            folder = project.state() if project else {}
            self.control("folder").Model.Text = folder.get("path") or "No folder selected"
            self.control("folder_read").Model.State = int(folder.get("mode", "read") == "read")
            self.control("folder_read_write").Model.State = int(folder.get("mode") == "read_write")
            for name in ("browseFolder", "folder_read", "folder_read_write"):
                self.control(name).setEnable(project is not None)
            self.control("grantFolder").setEnable(bool(project and folder.get("path")))
            self.control("revokeFolder").setEnable(bool(folder.get("active")))
            github = getattr(self.session.connection, "github", None)
            git = github.state() if github else {}
            self.control("github").setEnable(github is not None)
            self.control("githubEnable").setEnable(bool(git.get("configured") and folder.get("active") and folder.get("mode") == "read_write"))
            self.control("githubEnable").Model.State = int(git.get("enabled", False))
            self.control("githubState").Model.Label = (git.get("repository") or "No repository selected") + " · " + git.get("branch", "main") if git.get("configured") else "Not connected"
            message = "Access: " + tunnel.get("phase", "local only") + ". "
            message += "Document shared." if self.session.shared else "Document not shared."
            if self.active_page == "project":
                message = "Folder access " + (("read + write" if folder.get("mode") == "read_write" else "read only") if folder.get("active") else "is off") + ". GitHub writes " + ("enabled." if git.get("enabled") else "are off.")
                if git.get("busy"): message += " GitHub operation running…"
            self.status(tunnel.get("error") or (git.get("error") if not git.get("busy") else "") or message)
        finally:
            self.updating = False

    def changed(self, name):
        if name == "githubEnable":
            try: self.session.connection.github.set_enabled(self.control(name).Model.State == 1)
            finally: self.refresh()
            return
        if name in ("folder_read", "folder_read_write"):
            project = self.session.connection.project
            folder = project.state()
            if folder.get("path"):
                project.configure(folder["path"], "read_write" if self.control("folder_read_write").Model.State else "read")
                if getattr(self.session.connection, "github", None): self.session.connection.github.set_enabled(False)
            self.refresh()
            return
        if name == "reconnect":
            self.session.connection.set_auto_reconnect(self.control("reconnect").Model.State == 1)
            if self.session.connection.tunnel.status()["configured"]:
                self.session.connection.tunnel.set_auto_reconnect(self.control("reconnect").Model.State == 1)
            self.refresh()
            return
        if name != "share": return
        if self.control("share").Model.State == 1:
            self.updating = True
            self.control("share").Model.State = 0
            self.updating = False
            ContextConsent(self, self.session.snapshot()).show()
        else:
            self.session.set_shared(False)
        self.refresh()

    def action(self, name):
        if name in ("reviewPage", "projectPage"):
            self.set_page("project" if name == "projectPage" else "review")
        elif name == "browseFolder":
            picker = self.create("com.sun.star.ui.dialogs.FolderPicker")
            picker.setTitle("Choose the project folder to share")
            selected = self.session.connection.project.state().get("path")
            if selected: picker.setDisplayDirectory(uno.systemPathToFileUrl(selected))
            try:
                if picker.execute():
                    self.session.connection.project.configure(uno.fileUrlToSystemPath(picker.getDirectory()), "read_write" if self.control("folder_read_write").Model.State else "read")
                    if getattr(self.session.connection, "github", None): self.session.connection.github.set_enabled(False)
            finally: picker.dispose()
        elif name == "grantFolder":
            folder = self.session.connection.project.state()
            self.session.connection.project.grant(folder.get("path", ""), "read_write" if self.control("folder_read_write").Model.State else "read")
        elif name == "revokeFolder":
            self.session.connection.project.revoke()
            if getattr(self.session.connection, "github", None): self.session.connection.github.set_enabled(False)
        elif name == "github":
            if self.github_setup is None or self.github_setup.disposed:
                self.github_setup = GitHubSetup(self)
                self.github_setup.show()
            else: self.github_setup.dialog.toFront()
        elif name == "start":
            if self.session.connection and not self.session.connection.tunnel.status()["configured"]:
                TunnelSetup(self).show()
            self.session.start()
        elif name == "stop": self.session.stop()
        elif name == "setup": TunnelSetup(self).show()
        elif name == "help":
            if self.details is None or self.details.disposed:
                self.details = ConnectionDetails(self)
                self.details.show()
            else: self.details.dialog.toFront()
        elif name == "pair":
            if self.paired is None or self.paired.disposed:
                self.paired = PairedPrograms(self)
                self.paired.show()
            else: self.paired.dialog.toFront()
        elif name == "copy":
            if not self.session.endpoint: raise ValueError("Start access first.")
            tunnel = self.session.connection.tunnel.status() if self.session.connection else {}
            copy_address(self, tunnel.get("endpoint") or self.session.endpoint.url)
        elif name == "close":
            self.close()
            return
        self.refresh()

    def close(self):
        self.pulse.close()
        if self.paired: self.paired.dispose()
        if self.details: self.details.dispose()
        if self.github_setup: self.github_setup.dispose()
        self.panel.connections = None
        if self.session.panel and self.session.panel.connections is self:
            self.session.panel.connections = None
        self.session.connections = None
        self.dispose()


class GitHubSetup(Dialog):
    def __init__(self, connections):
        super().__init__(connections.session, "GitHub connection", 270, 250, connections.dialog.getPeer())
        self.connections = connections
        state = self.session.connection.github.state()
        self.add("intro", "FixedText", 8, 8, 254, 16, stretch=True, Label="GitHub for the selected project", FontWeight=150)
        self.add("tokenLabel", "FixedText", 8, 32, 166, 14, group=1, Label="Personal access token")
        self.add("createToken", "Button", 184, 29, 78, 20, group=1, right=True, Label="Create token…")
        self.add("token", "Edit", 8, 51, 254, 20, group=1, stretch=True, sensitive=True, EchoChar=ord("•"), MaxTextLen=4096,
                 HelpText="The saved token is never displayed. Enter it again to change the repository or branch.")
        self.add("repositoryLabel", "FixedText", 8, 82, 254, 14, group=2, stretch=True, Label="Repository (owner/name; blank for a new repository)")
        self.add("repository", "Edit", 8, 101, 254, 20, group=2, stretch=True, Text=state.get("repository", ""), MaxTextLen=260)
        self.add("branchLabel", "FixedText", 8, 132, 80, 14, group=3, Label="Branch")
        self.add("branch", "Edit", 94, 128, 168, 20, group=3, stretch=True, Text=state.get("branch", "main"), MaxTextLen=260)
        self.add("enabled", "CheckBox", 8, 159, 254, 18, group=4, stretch=True, Label="Enable GitHub writes", State=int(state.get("enabled", False)))
        self.add("help", "FixedText", 8, 184, 254, 55, group=4, stretch=True,
                 Label="Enable only for a folder with Read + write access. AI may commit/push it and create a private or public repository. Use a token with Contents read/write; repository creation also needs administration/creation rights. Saving credentials grants nothing; access is off after restart.")
        self.add("attach", "Button", 8, 248, 254, 20, group=5, stretch=True, Label="Attach saved repository",
                 HelpText="Use only the saved owner/name and branch. Initialize this folder if needed and attach its GitHub origin locally. No network call or file commit; GitHub writes stay off.")
        self.control("attach").setEnable(bool(state.get("configured") and state.get("repository")))
        self.add("status", "FixedText", 8, 277, 254, 24, group=6, stretch=True, Label="Connection saved; token hidden." if state.get("configured") else "No GitHub connection saved.")
        self.add("clear", "Button", 8, 310, 90, 20, group=7, Label="Remove connection")
        self.add("save", "Button", 106, 310, 100, 20, group=7, right=True, Label="Save connection")
        self.add("close", "Button", 214, 310, 48, 20, group=7, right=True, Label="Close")

    def action(self, name):
        if name == "close": self.close()
        elif name == "createToken":
            self.create("com.sun.star.system.SystemShellExecute").execute("https://github.com/settings/personal-access-tokens/new", "", uno.getConstantByName("com.sun.star.system.SystemShellExecuteFlags.URIS_ONLY"))
        elif name == "attach":
            try:
                self.session.connection.github.attach_repository()
                self.status("Saved repository attached locally. No network call or commit. GitHub writes are off.")
            finally:
                self.control("enabled").Model.State = 0
                self.connections.refresh()
        elif name == "clear":
            self.session.connection.github.clear()
            self.connections.refresh()
            self.close()
        elif name == "save":
            token = self.control("token").Model.Text
            self.control("token").Model.Text = ""
            backend = self.session.connection.github
            state = backend.state()
            repository = self.control("repository").Model.Text.strip()
            branch = self.control("branch").Model.Text.strip()
            if token:
                backend.configure(token, repository, branch)
            elif not state.get("configured"):
                raise ValueError("Enter a GitHub personal access token first.")
            elif (repository, branch) != (state.get("repository", ""), state.get("branch", "main")):
                raise ValueError("Enter the token again to change the saved repository or branch.")
            backend.set_enabled(self.control("enabled").Model.State == 1)
            self.connections.refresh()
            self.close()

    def dispose(self):
        if not self.disposed: self.control("token").Model.Text = ""
        super().dispose()


class ConnectionDetails(Dialog):
    def __init__(self, connections):
        super().__init__(connections.session, "Connection details", 270, 180, connections.dialog.getPeer())
        self.add("intro", "FixedText", 8, 8, 254, 16, stretch=True, Label="How Writer access works", FontWeight=150)
        text = "\n\n".join((LABELS["currentContextHelp"], LABELS["shareContext"], LABELS["contextReadHelp"],
            "Reconnect at startup reconnects Writer's own bridge when Writer opens. It never restores document sharing. Each document needs fresh sharing consent.",
            "Setup configures Writer's independent MCP/zrok bridge. UnderTree can be closed. Pair program links another program's separately permitted review tools; it does not share documents or change permissions.",
            "Project & GitHub grants separate access to one chosen folder, in Read or Read + write mode. Choosing or remembering a folder grants nothing. GitHub writes require an explicit local enable and active Read + write access; they can commit/push and create a private or public repository. Neither permission is restored after restart.",
            "Stop / revoke ends access and prevents automatic reconnection until you start it again. Closing this window leaves access running."))
        self.add("details", "Edit", 8, 32, 254, 132, group=1, stretch=True, ReadOnly=True, MultiLine=True, VScroll=True, Text=text)
        self.add("close", "Button", 212, 174, 50, 20, group=2, right=True, Label="Close")

    def action(self, _): self.close()


class SuggestionDialog(Dialog):
    def __init__(self, panel, proposal):
        super().__init__(panel.session, LABELS["viewSuggestion"], 440, 286, panel.dialog.getPeer(), True)
        from undertree_policy import reconstruct
        replacement = reconstruct(panel.session.snapshot(), proposal)[0] if "replacementParts" in proposal else proposal["replacement"]
        for name, label, y, text in (("original", "Original", 8, proposal["quote"]), ("replacement", "Suggested replacement", 125, replacement)):
            self.add(name + "Label", "FixedText", 8, y, 424, 12, group=int(y > 8), stretch=True, Label=label)
            self.add(name, "Edit", 8, y + 16, 424, 90, group=int(y > 8), stretch=True, Text=text, ReadOnly=True, MultiLine=True, VScroll=True)
        self.add("close", "Button", 332, 259, 100, 20, group=2, right=True, Label="Close")

    def action(self, _): self.close()


def copy_address(owner, value):
    class Transferable(unohelper.Base, XTransferable):
        def getTransferDataFlavors(self):
            flavor = uno.createUnoStruct("com.sun.star.datatransfer.DataFlavor")
            flavor.MimeType, flavor.HumanPresentableName, flavor.DataType = "text/plain;charset=utf-16", "Text", uno.getTypeByName("string")
            return (flavor,)
        def isDataFlavorSupported(self, flavor): return flavor.MimeType == "text/plain;charset=utf-16"
        def getTransferData(self, _): return value
    owner.create("com.sun.star.datatransfer.clipboard.SystemClipboard").setContents(Transferable(), None)


class PanelSlotEvents(unohelper.Base, XMouseListener):
    def __init__(self, panel, index):
        self.panel, self.index = panel, index
        self.left_pressed = False

    def mouseReleased(self, event):
        activate = self.left_pressed and event.ClickCount >= 2 and not event.PopupTrigger and not self.panel.no_fit
        self.left_pressed = False
        if activate:
            command = uno.createUnoStruct("com.sun.star.awt.ActionEvent")
            command.ActionCommand = "configure" + str(self.index)
            self.panel.events.actionPerformed(command)

    def mousePressed(self, event): self.left_pressed = event.Buttons == 1 and not event.PopupTrigger
    def mouseEntered(self, _): pass
    def mouseExited(self, _): pass
    def disposing(self, _): pass


class Panel(Dialog):
    def __init__(self, session):
        super().__init__(session, "wrAIter — " + session.document.Title, 470, 307)
        self.connections, self.slot_page = None, 0
        self.rule_ids, self.mark_ids, self.request_ids = [], [], []
        self.selected_rule = next(iter(session.data["rules"]))
        self.slot_events = []
        self.add("intro", "FixedText", 8, 7, 454, 22, stretch=True, MultiLine=True, Label="Choose a color, configure its rule, then highlight a passage in Writer.")
        for index in range(4):
            self.add("slot" + str(index), "Button", 8 + index * 114, 35, 88, 38, group=1, Label="", MultiLine=True)
            self.add("configure" + str(index), "Button", 98 + index * 114, 35, 22, 38, group=1, Label="⋮")
            listener = PanelSlotEvents(self, index)
            self.slot_events.append(listener)
            self.control("slot" + str(index)).addMouseListener(listener)
        self.add("new", "Button", 8, 81, 160, 21, group=2, Label=LABELS["newSlot"])
        self.add("next", "Button", 176, 81, 110, 21, group=2, Label=LABELS["nextColors"])
        self.add("allLabel", "FixedText", 294, 85, 65, 12, group=2, Label=LABELS["allRules"])
        self.add("rules", "ListBox", 362, 81, 100, 21, group=2, stretch=True, Dropdown=True)
        self.add("selected", "FixedText", 8, 110, 454, 25, group=3, stretch=True, MultiLine=True, Label="")
        self.add("mark", "Button", 8, 140, 180, 22, group=3, Label=LABELS["highlight"])
        self.add("remove", "Button", 196, 140, 130, 22, group=3, Label=LABELS["removeMarker"])
        self.add("connections", "Button", 334, 140, 128, 22, group=3, right=True, Label=LABELS["connections"])
        self.add("marks", "ListBox", 8, 169, 454, 20, group=4, stretch=True, Dropdown=True)
        self.add("pendingLabel", "FixedText", 8, 197, 454, 13, group=5, stretch=True, Label=LABELS["pending"])
        self.add("pending", "ListBox", 8, 215, 454, 20, group=5, stretch=True, Dropdown=True)
        self.add("inspect", "Button", 8, 242, 174, 21, group=6, Label=LABELS["viewSuggestion"])
        self.add("accept", "Button", 190, 242, 132, 21, group=6, Label=LABELS["accept"])
        self.add("reject", "Button", 330, 242, 132, 21, group=6, right=True, Label=LABELS["reject"])
        self.add("status", "FixedText", 8, 269, 318, 30, group=7, stretch=True, MultiLine=True, Label="Save normally to retain highlights and color rules.")
        self.add("close", "Button", 334, 282, 128, 20, group=7, right=True, Label="Close")
        self.show()
        self.refresh()

    def refresh(self):
        self.updating = True
        try:
            mark_position = self.control("marks").getSelectedItemPos()
            pending_position = self.control("pending").getSelectedItemPos()
            selected_mark = self.mark_ids[mark_position] if 0 <= mark_position < len(self.mark_ids) else None
            selected_pending = self.request_ids[pending_position] if 0 <= pending_position < len(self.request_ids) else None
            self.session.load()
            self.rule_ids = list(self.session.data["rules"])
            if self.selected_rule not in self.rule_ids and self.rule_ids: self.selected_rule = self.rule_ids[0]
            self.slot_page = min(self.slot_page, max(0, (len(self.rule_ids) - 1) // 4))
            self.control("rules").Model.StringItemList = tuple(self.session.data["rules"][key]["name"] for key in self.rule_ids)
            if self.rule_ids: self.control("rules").Model.SelectedItems = (self.rule_ids.index(self.selected_rule),)
            for index in range(4):
                position = self.slot_page * 4 + index
                active = position < len(self.rule_ids)
                self.control("slot" + str(index)).setEnable(active)
                self.control("configure" + str(index)).setEnable(active)
                if active:
                    rule = self.session.data["rules"][self.rule_ids[position]]
                    self.control("slot" + str(index)).Model.Label = rule["name"]
                    color = int(rule["color"][1:], 16)
                    self.control("slot" + str(index)).Model.BackgroundColor = color
                    self.control("slot" + str(index)).Model.TextColor = contrasting_text(color)
                    self.control("slot" + str(index)).Model.HelpText = "Highlight with " + rule["name"]
                    self.control("configure" + str(index)).Model.HelpText = LABELS["configureRule"].format(name=rule["name"])
            if self.rule_ids:
                rule = self.session.data["rules"][self.selected_rule]
                self.control("selected").Model.Label = rule["name"] + " · " + ("Direct edits" if rule["mode"] == "direct" else "Suggestions")
            self.mark_ids = list(self.session.data["marks"])
            stale = {item["id"] for item in self.session.snapshot(complete=False)["markers"] if item["stale"]}
            self.control("marks").Model.StringItemList = tuple(("STALE — " if key in stale else "") + self.session.data["rules"][self.session.data["marks"][key]["rule"]]["name"] + ": " + self.session.data["marks"][key]["quote"][:70].replace("\n", " ") for key in self.mark_ids)
            self.control("marks").Model.SelectedItems = (self.mark_ids.index(selected_mark) if selected_mark in self.mark_ids else 0,) if self.mark_ids else ()
            self.request_ids = list(self.session.pending)
            self.control("pending").Model.StringItemList = tuple(key + ": " + self.session.pending[key]["replacement"][:70].replace("\n", " ") for key in self.request_ids)
            self.control("pending").Model.SelectedItems = (self.request_ids.index(selected_pending) if selected_pending in self.request_ids else 0,) if self.request_ids else ()
            self.control("pendingLabel").Model.Label = LABELS["pending"] + ": " + str(len(self.request_ids))
            if self.connections: self.connections.refresh()
        finally:
            self.updating = False
        self.resize()

    def selected(self, name, values):
        position = self.control(name).getSelectedItemPos()
        if not 0 <= position < len(values): raise ValueError("Select an item first.")
        return values[position]

    def changed(self, name):
        if name == "rules":
            self.selected_rule = self.selected("rules", self.rule_ids)
            self.slot_page = self.rule_ids.index(self.selected_rule) // 4
            self.refresh()
        elif name == "marks":
            marker = self.selected("marks", self.mark_ids)
            if self.session.document.Bookmarks.hasByName(marker):
                self.session.document.CurrentController.select(self.session.document.Bookmarks.getByName(marker).Anchor)

    def action(self, name):
        if name.startswith("slot"):
            self.selected_rule = self.rule_ids[self.slot_page * 4 + int(name[4:])]
        elif name.startswith("configure"):
            key = self.rule_ids[self.slot_page * 4 + int(name[9:])]
            result = RuleDialog(self, key).show()
            if result: self.selected_rule = result
        elif name == "new":
            if len(self.rule_ids) >= CONTRACT["slots"]["ruleLimit"]: raise ValueError("At most 24 color rules are available.")
            result = RuleDialog(self).show()
            if result: self.selected_rule = result
        elif name == "next": self.slot_page = (self.slot_page + 1) % max(1, (len(self.rule_ids) + 3) // 4)
        elif name == "mark": HighlightDialog(self).show()
        elif name == "remove": self.session.remove_marker(self.selected("marks", self.mark_ids))
        elif name == "connections":
            self.session.show_connections()
            self.connections = self.session.connections
        elif name == "inspect": SuggestionDialog(self, self.session.pending[self.selected("pending", self.request_ids)]).show()
        elif name == "accept": self.session.accept(self.selected("pending", self.request_ids))
        elif name == "reject": self.session.reject(self.selected("pending", self.request_ids))
        elif name == "close":
            self.close()
            return
        self.refresh()

    def close(self):
        # Settings are a view; the toolbar and explicitly started connection live on.
        self.dialog.setVisible(False)

    def dispose(self):
        if self.connections: self.connections.close()
        super().dispose()
