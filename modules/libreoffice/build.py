"""Build a deterministic OXT using only Python's standard library."""
import argparse
import struct
import hashlib
import zlib
from pathlib import Path
import zipfile
import xml.etree.ElementTree as ET
import math


def tunnel_icon(size):
    pixels = bytearray()
    for y in range(size):
        pixels.append(0)
        for x in range(size):
            dx, dy = x + .5 - size / 2, y + .5 - size * .43
            stroke = size * .065
            arch = any((dy <= 0 and abs(math.hypot(dx, dy) - size * radius) <= stroke)
                       or (0 <= dy <= size * .36 and abs(abs(dx) - size * radius) <= stroke)
                       for radius in (.32, .15))
            pixels.extend((116, 185, 164, 255) if arch else (0, 0, 0, 0))
    def chunk(kind, value):
        return struct.pack(">I", len(value)) + kind + value + struct.pack(">I", zlib.crc32(kind + value))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")


def build(destination, zrok_executable=None, git_archive=None):
    root = Path(__file__).resolve().parent
    source = root / "extension"
    branding = root.parent.parent / "assets" / "wraiter"
    allowed = ("Addons.xcu", "ProtocolHandler.xcu", "WriterWindowState.xcu", "ToolbarControllers.xcu", "Jobs.xcu", "description.xml", "description.txt", "META-INF/manifest.xml",
               "undertree_writer.py", "undertree_policy.py", "undertree_mcp.py", "undertree_context.py", "undertree_ui.py", "undertree_toolbar.py", "undertree_connection.py", "undertree_tunnel.py", "undertree_peers.py",
               "undertree_project.py", "undertree_github.py", "undertree_fragments.py", "undertree_highlights.py", "undertree_branding.py")
    files = sorted(source / name for name in allowed)
    for path in files:
        if path.suffix in (".xml", ".xcu"):
            ET.parse(path)
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            info = zipfile.ZipInfo(path.relative_to(source).as_posix(), (2026, 10, 17, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, path.read_bytes())
        for size, name in ((16, "icon.png"), (24, "icon24.png"), (32, "icon32.png"), (64, "icon64.png")):
            info = zipfile.ZipInfo(name, (2026, 10, 17, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, (branding / f"icon{size}.png").read_bytes())
        info = zipfile.ZipInfo("icon.ico", (2026, 10, 17, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, (branding / "icon.ico").read_bytes())
        for size, name in ((16, "tunnel16.png"), (24, "tunnel24.png")):
            info = zipfile.ZipInfo(name, (2026, 10, 17, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, tunnel_icon(size))
        if zrok_executable is not None:
            binary = Path(zrok_executable).read_bytes()
            if hashlib.sha256(binary).hexdigest() != "0702de65616f78cfe4ef72e06e6be463335b4f67b4e67f1f33f394a82fd23713":
                raise ValueError("The Windows bridge must be the qualified zrok2 v2.0.4 binary.")
            for name, value in (("zrok2.exe", binary), ("zrok-LICENSE.txt", (root / "notices" / "zrok-LICENSE.txt").read_bytes())):
                info = zipfile.ZipInfo(name, (2026, 10, 17, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, value)
        if git_archive is not None:
            path = Path(git_archive)
            if hashlib.sha256(path.read_bytes()).hexdigest() != "da35e72aa21c005a5a0d298cfbae110bc1609a815730ea0dde84b01a1b3cd3be":
                raise ValueError("Git must be the qualified MinGit 2.56.0.2 x64 archive.")
            with zipfile.ZipFile(path) as runtime:
                for entry in sorted(runtime.namelist()):
                    if entry.endswith("/"):
                        continue
                    if entry.startswith("/") or "\\" in entry or any(part in ("", ".", "..") for part in entry.split("/")):
                        raise ValueError("Invalid MinGit archive path.")
                    info = zipfile.ZipInfo("git-runtime/" + entry, (2026, 10, 17, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    archive.writestr(info, runtime.read(entry))
        info = zipfile.ZipInfo("selective-editor-contract.json", (2026, 10, 17, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, (root.parent / "review" / "selective-editor-contract.json").read_bytes())
        info = zipfile.ZipInfo("README.md", (2026, 10, 17, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        readme = (root / "README.md").read_text(encoding="utf-8")
        readme = readme.replace("../../assets/wraiter/icon.svg", "icon64.png").replace("../../docs/downloads.md", "https://github.com/GeorgeFejer91/undertree/releases")
        archive.writestr(info, readme.encode("utf-8"))
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="artifacts/libreoffice/wrAIter.oxt")
    parser.add_argument("--zrok-executable", help="Bundle the qualified standalone Windows zrok2 bridge.")
    parser.add_argument("--git-archive", help="Bundle the qualified standalone Windows MinGit runtime.")
    args = parser.parse_args()
    print(build(args.output, args.zrok_executable, args.git_archive))
