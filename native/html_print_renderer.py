#!/usr/bin/python3
"""Render one validated UnderTree HTML print-profile document with WebKitGTK."""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import re
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, GObject, Gtk, WebKit2  # noqa: E402


APP_ROOT = Path(__file__).resolve().parent.parent
SAFETY_CSS = """
<style id="undertree-print-safety">
  @page { size: A4 portrait; margin: 0; }
  html, body { margin: 0 !important; padding: 0 !important; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  [data-ut-page] { width: 210mm !important; height: 296.7mm !important; min-height: 296.7mm !important; max-height: 296.7mm !important; overflow: hidden !important; break-after: page; page-break-after: always; }
  [data-ut-page]:last-of-type { break-after: auto; page-break-after: auto; }
</style>
"""
BOOTSTRAP = '<script type="module" src="/__undertree/runtime/html-render-bootstrap.js"></script>'
CSP = "default-src 'none'; img-src 'self' data:; font-src 'self' data:; style-src 'unsafe-inline'; script-src 'self'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"


def confined(root: Path, relative: str) -> Path:
    candidate = (root / unquote(relative).lstrip("/")).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise PermissionError("path leaves project") from error
    return candidate


def inject_runtime(source: str) -> str:
    payload = f"{SAFETY_CSS}\n{BOOTSTRAP}"
    if re.search(r"</head\s*>", source, re.IGNORECASE):
        return re.sub(r"</head\s*>", payload + "\n</head>", source, count=1, flags=re.IGNORECASE)
    return payload + source


def handler_factory(project_root: Path, source_path: Path):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            path = urlparse(self.path).path
            try:
                if path.startswith("/__undertree/runtime/"):
                    target = confined(APP_ROOT / "src", path.removeprefix("/__undertree/runtime/"))
                    data = target.read_bytes()
                    content_type = "text/javascript; charset=utf-8"
                elif path.startswith("/__undertree/pretext/"):
                    target = confined(APP_ROOT / "node_modules/@chenglou/pretext/dist", path.removeprefix("/__undertree/pretext/"))
                    data = target.read_bytes()
                    content_type = "text/javascript; charset=utf-8"
                elif path.startswith("/assets/"):
                    target = confined(project_root, path.removeprefix("/assets/"))
                    if target == source_path:
                        data = inject_runtime(target.read_text(encoding="utf-8")).encode("utf-8")
                        content_type = "text/html; charset=utf-8"
                    else:
                        data = target.read_bytes()
                        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
                else:
                    self.send_error(404)
                    return
            except (OSError, PermissionError):
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Security-Policy", CSP)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, _format, *_args):
            return

    return Handler


class Renderer:
    def __init__(self, url: str, output_pdf: Path, manifest_path: Path, expected_pages: int, timeout: float):
        self.url = url
        parsed_url = urlparse(url)
        self.allowed_origin = f"{parsed_url.scheme}://{parsed_url.netloc}"
        self.output_pdf = output_pdf
        self.manifest_path = manifest_path
        self.expected_pages = expected_pages
        self.deadline = time.monotonic() + timeout
        self.result_code = 1
        self.error = "WebKit rendering did not finish."
        self.print_operation = None

        context = WebKit2.WebContext.new_ephemeral()
        context.set_cache_model(WebKit2.CacheModel.DOCUMENT_VIEWER)
        self.view = WebKit2.WebView.new_with_context(context)
        settings = self.view.get_settings()
        settings.set_enable_javascript(True)
        settings.set_enable_page_cache(False)
        settings.set_enable_developer_extras(False)
        self.view.set_size_request(794, 1122)
        self.view.connect("load-changed", self.on_load_changed)
        self.view.connect("load-failed", self.on_load_failed)
        self.view.connect("resource-load-started", self.on_resource_started)
        self.window = Gtk.OffscreenWindow()
        self.window.add(self.view)
        self.window.show_all()

    def on_resource_started(self, _view, resource, request):
        # WebKitGTK 2.52 removed WebResource::send-request. Keep redirect
        # filtering where the signal still exists and remain compatible with
        # newer versions, whose initial request is still checked below.
        if GObject.signal_lookup("send-request", resource.__gtype__):
            resource.connect("send-request", self.on_send_request)
        self.on_send_request(resource, request, None)

    def on_send_request(self, _resource, request, _redirected_response):
        uri = request.get_uri() or ""
        return not uri.startswith((self.allowed_origin, "data:", "blob:", "about:"))

    def on_load_failed(self, _view, _event, _uri, error):
        self.fail(f"WebKit failed to load the document: {error.message}")
        return True

    def on_load_changed(self, _view, event):
        if event == WebKit2.LoadEvent.FINISHED:
            GLib.timeout_add(40, self.poll_result)

    def poll_result(self):
        if time.monotonic() > self.deadline:
            self.fail("Fonts, images, or Pretext fitting exceeded the render timeout.")
            return False
        self.view.evaluate_javascript(
            "JSON.stringify(window.__UT_PRINT_RESULT__ || null)",
            -1, None, None, None, self.on_result, None,
        )
        return False

    def on_result(self, view, result, _data):
        try:
            value = view.evaluate_javascript_finish(result)
            payload = json.loads(value.to_string())
        except (GLib.Error, ValueError, TypeError) as error:
            self.fail(f"Could not read the browser-layout manifest: {error}")
            return
        if payload is None:
            GLib.timeout_add(40, self.poll_result)
            return
        if not payload.get("ok"):
            detail = payload.get("error") or json.dumps(payload.get("diagnostics") or [])
            self.fail(f"HTML print validation failed after layout: {detail}")
            return
        manifest = payload["manifest"]
        manifest["sourceSha256"] = hashlib.sha256(Path(self.source_path).read_bytes()).hexdigest() if hasattr(self, "source_path") else ""
        manifest["webkitVersion"] = f"{WebKit2.get_major_version()}.{WebKit2.get_minor_version()}.{WebKit2.get_micro_version()}"
        self.manifest_path.parent.mkdir(parents=True, exist_ok=True)
        self.manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        self.start_print()

    def start_print(self):
        self.output_pdf.parent.mkdir(parents=True, exist_ok=True)
        self.output_pdf.unlink(missing_ok=True)
        operation = WebKit2.PrintOperation.new(self.view)
        self.print_operation = operation
        settings = Gtk.PrintSettings()
        settings.set_printer("Print to File")
        settings.set("output-file-format", "pdf")
        settings.set("output-uri", self.output_pdf.resolve().as_uri())
        operation.set_print_settings(settings)
        setup = Gtk.PageSetup()
        setup.set_paper_size(Gtk.PaperSize.new(Gtk.PAPER_NAME_A4))
        setup.set_orientation(Gtk.PageOrientation.PORTRAIT)
        for setter in (setup.set_top_margin, setup.set_right_margin, setup.set_bottom_margin, setup.set_left_margin):
            setter(0, Gtk.Unit.MM)
        operation.set_page_setup(setup)
        operation.connect("finished", self.on_print_finished)
        operation.connect("failed", self.on_print_failed)
        operation.print_()

    def on_print_failed(self, _operation, error):
        self.fail(f"WebKit PDF printing failed: {error.message}")

    def on_print_finished(self, _operation):
        GLib.timeout_add(150, self.verify_output)

    def verify_output(self):
        if not self.output_pdf.exists() or self.output_pdf.stat().st_size < 1000:
            if time.monotonic() < self.deadline:
                GLib.timeout_add(100, self.verify_output)
                return False
            self.fail("WebKit reported success but no PDF was written.")
            return False
        result = subprocess.run(["pdfinfo", str(self.output_pdf)], capture_output=True, text=True, check=False)
        match = re.search(r"^Pages:\s+(\d+)", result.stdout, re.MULTILINE)
        page_count = int(match.group(1)) if match else 0
        if page_count != self.expected_pages:
            self.fail(f"Declared {self.expected_pages} page(s), but WebKit produced {page_count}.")
            return False
        self.result_code = 0
        self.error = ""
        Gtk.main_quit()
        return False

    def fail(self, message: str):
        self.error = message
        self.result_code = 1
        if Gtk.main_level():
            Gtk.main_quit()

    def run(self):
        self.view.load_uri(self.url)
        Gtk.main()
        return self.result_code


def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--pages", type=int, required=True)
    parser.add_argument("--timeout", type=float, default=90)
    return parser.parse_args()


def main() -> int:
    args = arguments()
    project_root = Path(args.project_root).resolve()
    source = Path(args.source).resolve()
    source.relative_to(project_root)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_factory(project_root, source))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_port
    relative_source = source.relative_to(project_root).as_posix()
    url = f"http://127.0.0.1:{port}/assets/{relative_source}"
    renderer = Renderer(url, Path(args.pdf), Path(args.manifest), args.pages, args.timeout)
    renderer.source_path = str(source)
    try:
        code = renderer.run()
        if code:
            print(renderer.error, file=sys.stderr)
        return code
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
