"""Bounded native Writer rich-text fragments; no system clipboard or external files."""
import io
import re
import zipfile
import xml.etree.ElementTree as ET

import uno
import unohelper
from com.sun.star.datatransfer import XTransferable

MAX_FRAGMENT = 2097152
TEXT = "urn:oasis:names:tc:opendocument:xmlns:text:1.0"
STYLE = "urn:oasis:names:tc:opendocument:xmlns:style:1.0"
OFFICE = "urn:oasis:names:tc:opendocument:xmlns:office:1.0"
BOOKMARK = re.compile(rb'<text:bookmark(?:-start|-end)?\b[^>]*text:name="(UnderTree_[^"]*)"[^>]*/>')


def package(raw):
    if len(raw) > MAX_FRAGMENT:
        raise ValueError("Protected native fragment exceeds 2 MiB.")
    result = {}
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        if len(archive.infolist()) > 32 or sum(item.file_size for item in archive.infolist()) > MAX_FRAGMENT:
            raise ValueError("Protected fragment structure exceeds its bound.")
        for item in archive.infolist():
            if item.filename in result or item.filename.startswith("/") or ".." in item.filename.split("/"):
                raise ValueError("Invalid native protected fragment.")
            result[item.filename] = archive.read(item)
    if set(result) - {"mimetype", "content.xml", "styles.xml", "settings.xml", "manifest.rdf", "META-INF/manifest.xml"}:
        raise ValueError("Embedded protected fragment objects are unsupported; text stays protected in place.")
    if "content.xml" not in result:
        raise ValueError("Writer did not provide a complete native fragment.")
    return result


def canonical_fragment(files):
    root = ET.fromstring(files["content.xml"])
    styles, defaults = {}, {}
    for source in (ET.fromstring(files["styles.xml"]), root):
        for style in source.iter("{" + STYLE + "}style"):
            styles[style.get("{" + STYLE + "}name")] = style
        for style in source.iter("{" + STYLE + "}default-style"):
            defaults[style.get("{" + STYLE + "}family")] = style

    def declarations(style):
        result = {}
        for child in style:
            if child.tag.endswith("-properties"):
                for key, value in child.attrib.items():
                    # Writer's paste adds this explicit default to unchanged shading.
                    if key == "{urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0}char-shading-value" and value == "0":
                        continue
                    result[(child.tag, key)] = value
        return result

    def resolve(name, family, stack=()):
        result = declarations(defaults[family]) if family in defaults else {}
        if name not in styles:
            return result
        if name in stack:
            raise ValueError("Cyclic native style reference cannot be preserved.")
        style = styles[name]
        parent = style.get("{" + STYLE + "}parent-style-name")
        if parent:
            result.update(resolve(parent, family, stack + (name,)))
        result.update(declarations(style))
        return result

    def content(element, inherited):
        style = element.get("{" + TEXT + "}style-name")
        properties = dict(inherited)
        properties.update(resolve(style, "paragraph" if element.tag in ("{" + TEXT + "}p", "{" + TEXT + "}h") else "text"))
        text_properties = tuple(sorted((key, value) for key, value in properties.items() if key[0] == "{" + STYLE + "}text-properties"))
        parts = []
        def append_text(value):
            if not value:
                return
            if parts and parts[-1][0] == "text" and parts[-1][2] == text_properties:
                parts[-1] = ("text", parts[-1][1] + value, text_properties)
            else:
                parts.append(("text", value, text_properties))
        append_text(element.text)
        for child in element:
            value = content(child, properties)
            if child.tag == "{" + TEXT + "}span":
                for part in value:
                    if parts and part[0] == "text" and parts[-1][0] == "text" and parts[-1][2] == part[2]:
                        parts[-1] = ("text", parts[-1][1] + part[1], part[2])
                    else:
                        parts.append(part)
            else:
                attributes = tuple(sorted((key, value) for key, value in child.attrib.items() if not key.endswith("}style-name")))
                parts.append((child.tag, attributes, value))
            append_text(child.tail)
        return tuple(parts)

    body = root.find("{" + OFFICE + "}body/{" + OFFICE + "}text")
    if body is None:
        raise ValueError("Protected fragment has no native text body.")
    paragraphs = [element for element in body if element.tag in ("{" + TEXT + "}p", "{" + TEXT + "}h")]
    if not paragraphs:
        raise ValueError("Protected fragment has no supported prose paragraphs.")
    return tuple((element.tag,
        tuple(sorted((key, value) for key, value in element.attrib.items() if not key.endswith("}style-name"))),
        content(element, {})) for element in paragraphs)


class NativeFragment(unohelper.Base, XTransferable):
    def __init__(self, transfer, marker_ids=()):
        flavor = next((flavor for flavor in transfer.getTransferDataFlavors()
                       if flavor.MimeType.startswith("application/x-openoffice-embed-source-xml;")), None)
        if flavor is None:
            raise ValueError("Writer cannot provide a native protected rich-text fragment.")
        files = package(bytes(transfer.getTransferData(flavor)))
        for element in ET.fromstring(files["content.xml"]).iter():
            if element.tag in {"{" + TEXT + "}" + name for name in ("dde-connection", "database-display", "database-name", "section-source", "file-name")} or element.tag.endswith("}event-listeners") or (element.tag == "{" + OFFICE + "}scripts" and len(element)):
                raise ValueError("External-data protected fields stay protected in place.")
        files["content.xml"] = BOOKMARK.sub(lambda match: b"" if match.group(1).decode("utf-8") in marker_ids else match.group(0), files["content.xml"])
        root = ET.fromstring(files["content.xml"])
        if any(element.tag in ("{" + TEXT + "}bookmark", "{" + TEXT + "}bookmark-start", "{" + TEXT + "}bookmark-end") for element in root.iter()):
            raise ValueError("Protected fragments with external bookmark identities stay protected in place.")
        self.fingerprint = canonical_fragment(files)
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, value in files.items():
                archive.writestr(name, value)
        self.raw = output.getvalue()
        self.flavor = flavor
        self.descriptor = next((item for item in transfer.getTransferDataFlavors() if item.MimeType.startswith("application/x-openoffice-objectdescriptor-xml;")), None)
        self.descriptor_raw = bytes(transfer.getTransferData(self.descriptor)) if self.descriptor else b""
        if len(self.descriptor_raw) > 16384:
            raise ValueError("Native protected descriptor exceeds its bound.")

    def getTransferDataFlavors(self): return (self.flavor, self.descriptor) if self.descriptor else (self.flavor,)
    def isDataFlavorSupported(self, flavor): return any(flavor.MimeType == item.MimeType for item in self.getTransferDataFlavors())
    def getTransferData(self, flavor):
        if not self.isDataFlavorSupported(flavor):
            raise ValueError("Unsupported protected fragment representation.")
        value = self.raw if flavor.MimeType == self.flavor.MimeType else self.descriptor_raw
        return uno.Any("[]byte", uno.ByteSequence(value))


def paragraph_properties(cursor):
    result = []
    paragraphs = cursor.createEnumeration()
    while paragraphs.hasMoreElements():
        paragraph = paragraphs.nextElement()
        if len(result) >= 128 or not paragraph.supportsService("com.sun.star.text.Paragraph"):
            raise ValueError("Protected paragraph reconstruction exceeds its supported structure bound.")
        properties = []
        for prop in paragraph.PropertySetInfo.Properties:
            if prop.Attributes & 16 or not prop.Name.startswith("Para"):
                continue
            value = paragraph.getPropertyValue(prop.Name)
            if value is not None:
                properties.append((prop.Name, value, prop.Type.typeName))
        result.append(properties)
    return result


def same_property(left, right):
    if left == right:
        return True
    if hasattr(left, "Type") and hasattr(left, "ThemeColorType") and hasattr(right, "Type"):
        return left.Type == right.Type == 0 and left.ThemeColorType == right.ThemeColorType
    if hasattr(left, "getElementNames") and hasattr(right, "getElementNames"):
        names = left.getElementNames()
        if len(names) > 128 or sorted(names) != sorted(right.getElementNames()):
            return False
        return all(same_property(left.getByName(name), right.getByName(name)) for name in names)
    return False


def restore_paragraphs(cursor, fragment):
    paragraphs = cursor.createEnumeration()
    index = 0
    while paragraphs.hasMoreElements():
        paragraph = paragraphs.nextElement()
        if index >= len(fragment.paragraphs):
            raise ValueError("Protected paragraph structure changed during reconstruction.")
        properties = sorted(fragment.paragraphs[index], key=lambda prop: (prop[0] != "ParaStyleName", prop[0]))
        for name, value, type_name in properties:
            if name == "ParaAutoStyleName" or same_property(paragraph.getPropertyValue(name), value):
                continue
            try:
                paragraph.setPropertyValue(name, uno.Any(type_name, value))
            except Exception as error:
                raise ValueError("Unsupported protected paragraph property: " + name) from error
        index += 1
    if index != len(fragment.paragraphs):
        raise ValueError("Protected paragraph structure was split or lost.")


def verify_paragraphs(cursor, fragment):
    current = paragraph_properties(cursor)
    if len(current) != len(fragment.paragraphs):
        raise ValueError("Protected paragraph structure changed.")
    for expected, actual in zip(fragment.paragraphs, current):
        actual = {name: value for name, value, type_name in actual}
        if any(name != "ParaAutoStyleName" and not same_property(actual.get(name), value) for name, value, type_name in expected):
            raise ValueError("Protected native paragraph properties changed.")


def capture(document, cursor, marker_ids=()):
    controller = document.CurrentController
    previous = controller.getSelection()
    try:
        controller.select(cursor)
        fragment = NativeFragment(controller.getTransferable(), marker_ids)
        fragment.paragraphs = paragraph_properties(cursor)
        return fragment
    finally:
        controller.select(previous)
