"""Complete bounded native Writer text; never updates fields or follows external files."""
import hashlib
import re

MAX_CONTEXT_BYTES = 524288
MAX_PARTS = 1024
MAX_NODES = 20000


def collect_context(document):
    parts = []
    node_count = 0
    byte_count = 0

    section_names = document.TextSections.ElementNames
    if len(section_names) > MAX_PARTS:
        raise ValueError("Writer text sections exceed the complete-context inspection limit.")
    for name in section_names:
        section = document.TextSections.getByName(name)
        if section.PropertySetInfo.hasPropertyByName("FileLink") and section.FileLink.FileURL:
            raise ValueError("Linked external chapters cannot be verified without reading other files. Embed their text in the current Writer document before sharing complete context.")

    def append(kind, identifier, text):
        nonlocal byte_count
        if not isinstance(text, str):
            raise ValueError("Writer returned an unsupported text container; complete context is unavailable.")
        if not text:
            return
        byte_count += len(text.encode("utf-8")) + len(identifier.encode("utf-8")) + 40
        if byte_count > MAX_CONTEXT_BYTES or len(parts) >= MAX_PARTS:
            raise ValueError("Complete Writer context exceeds the 512 KiB / 1024-part limit. Nothing was shared partially.")
        parts.append({"kind": kind, "id": identifier, "content": text})

    def walk_text(text, kind, identifier, depth=0):
        nonlocal node_count
        if depth > 16:
            raise ValueError("Writer text nesting exceeds the complete-context limit.")
        enumeration = text.createEnumeration()
        paragraphs = []
        pending_bytes = 0
        while enumeration.hasMoreElements():
            node_count += 1
            if node_count > MAX_NODES:
                raise ValueError("Writer text structure exceeds the complete-context inspection limit.")
            element = enumeration.nextElement()
            if element.supportsService("com.sun.star.text.TextTable"):
                if paragraphs:
                    append(kind, identifier + "/paragraphs-" + str(len(parts)), "\n".join(paragraphs))
                    paragraphs = []
                    pending_bytes = 0
                names = element.getCellNames()
                if len(names) > MAX_NODES:
                    raise ValueError("A Writer table exceeds the complete-context inspection limit.")
                # Preserve native cell identities, including split/merged cells; omit none.
                def natural(name):
                    return tuple((1, int(item)) if item.isdigit() else (0, item) for item in re.split(r"(\d+)", name))
                for name in sorted(names, key=natural):
                    walk_text(element.getCellByName(name).Text, "table-cell", identifier + "/table:" + element.Name + "/" + name, depth + 1)
            elif element.supportsService("com.sun.star.text.Paragraph"):
                value = element.String
                pending_bytes += len(value.encode("utf-8")) + 1
                if byte_count + pending_bytes > MAX_CONTEXT_BYTES:
                    raise ValueError("Complete Writer context exceeds 512 KiB. Nothing was shared partially.")
                paragraphs.append(value)
            else:
                raise ValueError("Unsupported Writer body text container; complete context cannot be guaranteed.")
        if paragraphs:
            append(kind, identifier + "/paragraphs-" + str(len(parts)), "\n".join(paragraphs))

    walk_text(document.Text, "body", "writer:body")
    frame_names = document.TextFrames.ElementNames
    if len(frame_names) > MAX_PARTS:
        raise ValueError("Writer text frames exceed the complete-context inspection limit.")
    for name in frame_names:
        walk_text(document.TextFrames.getByName(name).Text, "text-frame", "writer:frame:" + name)
    for kind, collection in (("footnote", document.Footnotes), ("endnote", document.Endnotes)):
        if collection.getCount() > MAX_PARTS:
            raise ValueError("Writer notes exceed the complete-context inspection limit.")
        for index in range(collection.getCount()):
            walk_text(collection.getByIndex(index), kind, "writer:" + kind + ":" + str(index + 1))
    styles = document.StyleFamilies.getByName("PageStyles")
    if len(styles.ElementNames) > MAX_PARTS:
        raise ValueError("Writer page styles exceed the complete-context inspection limit.")
    for name in styles.ElementNames:
        style = styles.getByName(name)
        info = style.PropertySetInfo
        for kind in ("Header", "Footer"):
            enabled = kind + "IsOn"
            if not info.hasPropertyByName(enabled) or not style.getPropertyValue(enabled):
                continue
            for variant in ("Text", "TextLeft", "TextRight", "TextFirst"):
                field = kind + variant
                if info.hasPropertyByName(field):
                    value = style.getPropertyValue(field)
                    if value is not None:
                        walk_text(value, kind.lower(), "writer:page-style:" + name + ":" + field)
    fields = document.TextFields.createEnumeration()
    for index in range(MAX_PARTS):
        if not fields.hasMoreElements():
            break
        field = fields.nextElement()
        if field.supportsService("com.sun.star.text.textfield.Annotation"):
            append("annotation", "writer:annotation:" + str(index + 1), field.Content)
        else:
            append("cached-field", "writer:cached-field:" + str(index + 1), field.getPresentation(False))
    else:
        if fields.hasMoreElements():
            raise ValueError("Writer fields exceed the complete-context inspection limit.")

    shape_count = 0
    def walk_shape(shape, identifier, depth=0):
        nonlocal shape_count
        shape_count += 1
        if shape_count > MAX_PARTS or depth > 16:
            raise ValueError("Writer drawing objects exceed the complete-context inspection limit.")
        if shape.supportsService("com.sun.star.text.TextFrame"):
            return  # Collected through the document's native TextFrames collection.
        if shape.supportsService("com.sun.star.drawing.GroupShape"):
            for index in range(shape.getCount()):
                walk_shape(shape.getByIndex(index), identifier + "/" + str(index + 1), depth + 1)
        elif hasattr(shape, "String"):
            append("drawing-text", identifier, shape.String)
        elif not (shape.supportsService("com.sun.star.text.TextGraphicObject") or shape.supportsService("com.sun.star.drawing.GraphicObjectShape")):
            raise ValueError("An embedded or unsupported drawing may contain text; complete context is unavailable.")
    for index in range(document.DrawPage.getCount()):
        walk_shape(document.DrawPage.getByIndex(index), "writer:drawing:" + str(index + 1))
    if document.GraphicObjects.getCount() > MAX_PARTS:
        raise ValueError("Writer graphic objects exceed the complete-context inspection limit.")
    for index in range(document.GraphicObjects.getCount()):
        graphic = document.GraphicObjects.getByIndex(index)
        for property_name in ("Title", "Description"):
            if graphic.PropertySetInfo.hasPropertyByName(property_name):
                append("graphic-alternative-text", "writer:graphic:" + str(index + 1) + ":" + property_name, graphic.getPropertyValue(property_name))
    if document.EmbeddedObjects.getCount():
        raise ValueError("Embedded documents may contain additional text. Complete context is unavailable without converting them to native Writer text.")
    content = "\n\n".join("[" + part["id"] + "]\n" + part["content"] for part in parts)
    if len(content.encode("utf-8")) > MAX_CONTEXT_BYTES:
        raise ValueError("Complete Writer context exceeds 512 KiB. Nothing was shared partially.")
    descriptors = [{"id": part["id"], "kind": part["kind"], "characters": len(part["content"]),
                    "revision": hashlib.sha256(part["content"].encode("utf-8")).hexdigest()} for part in parts]
    return {"content": content, "context": {"complete": True, "main": "writer:document", "parts": descriptors,
            "files": [{"path": part["id"], "content": part["content"]} for part in parts],
            "fieldState": "Cached native field presentations; no updates or external file reads.",
            "nonTextObjects": {"graphics": document.GraphicObjects.getCount(), "ocrPerformed": False}}}
