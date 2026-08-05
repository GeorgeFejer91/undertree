#!/usr/bin/python3
"""Native GTK shell for the LocalTeX Studio offline workspace."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings
from pathlib import Path

import gi

gi.require_version("Gdk", "3.0")
gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")

from gi.repository import Gdk, Gio, GLib, Gtk, WebKit2  # noqa: E402


APP_ID = "io.github.george.LocalTeXStudio"
APP_NAME = "LocalTeX Studio"
APP_ORIGIN = "http://127.0.0.1:37371"
PROJECT_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")
APP_ROOT = Path(__file__).resolve().parent.parent
CONFIG_ROOT = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "localtex-studio"
STATE_ROOT = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "localtex-studio"
TOKEN_FILE = CONFIG_ROOT / "token"
WINDOW_STATE_FILE = CONFIG_ROOT / "window-state.json"


def health_available() -> bool:
    try:
        with urllib.request.urlopen(f"{APP_ORIGIN}/api/health", timeout=0.4) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False


def ensure_service() -> None:
    """Start the installed local API without exposing its token in argv."""
    if health_available():
        return

    systemctl = subprocess.run(
        ["systemctl", "--user", "start", "localtex-studio.service"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
        timeout=10,
    )

    if systemctl.returncode != 0 and not health_available():
        STATE_ROOT.mkdir(parents=True, exist_ok=True)
        server_log = (STATE_ROOT / "server.log").open("ab")
        environment = os.environ.copy()
        environment.update(
            {
                "LOCALTEX_PORT": "37371",
                "LOCALTEX_TOKEN_FILE": str(TOKEN_FILE),
                "LOCALTEX_LIBRARY_ROOT": str(Path.home() / "Documents/Overleaf-projects"),
            }
        )
        subprocess.Popen(
            ["/usr/bin/node", str(APP_ROOT / "server.mjs")],
            cwd=APP_ROOT,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=server_log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    for _ in range(80):
        if health_available():
            return
        time.sleep(0.1)
    raise RuntimeError("The local editor service did not become ready.")


def read_token() -> str:
    token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    if not token:
        raise RuntimeError("The LocalTeX Studio authentication token is missing.")
    return token


def build_app_url(project: str | None = None) -> str:
    query = {"token": read_token()}
    if project and PROJECT_PATTERN.fullmatch(project):
        query["project"] = project
    return f"{APP_ORIGIN}/?{urllib.parse.urlencode(query)}"


class LocalTeXWindow(Gtk.ApplicationWindow):
    def __init__(self, application: "LocalTeXApplication") -> None:
        super().__init__(application=application)
        self.application = application
        self.set_title(APP_NAME)
        self.set_icon_name("localtex-studio")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            self.set_wmclass("LocalTeXStudio", "LocalTeXStudio")
        self.set_default_size(1480, 900)
        self.set_size_request(980, 640)
        self.connect("delete-event", self._save_window_state)
        self.connect("key-press-event", self._on_key_press)

        state = self._read_window_state()
        if state.get("width") and state.get("height"):
            self.resize(int(state["width"]), int(state["height"]))
        if state.get("maximized"):
            self.maximize()

        overlay = Gtk.Overlay()
        self.add(overlay)

        context = WebKit2.WebContext.new_ephemeral()
        context.set_cache_model(WebKit2.CacheModel.DOCUMENT_BROWSER)
        self.webview = WebKit2.WebView.new_with_context(context)
        self.webview.set_hexpand(True)
        self.webview.set_vexpand(True)
        self.webview.set_background_color(Gdk.RGBA(0.105, 0.133, 0.173, 1.0))

        settings = self.webview.get_settings()
        settings.set_enable_javascript(True)
        settings.set_enable_developer_extras(False)
        settings.set_enable_page_cache(True)
        settings.set_enable_smooth_scrolling(True)
        settings.set_media_playback_requires_user_gesture(True)

        self.webview.connect("load-changed", self._on_load_changed)
        self.webview.connect("load-failed", self._on_load_failed)
        self.webview.connect("notify::title", self._on_title_changed)
        self.webview.connect("decide-policy", self._on_decide_policy)
        self.webview.connect("resource-load-started", self._on_resource_load_started)
        self.webview.connect("permission-request", self._on_permission_request)
        self.webview.connect("web-process-terminated", self._on_web_process_terminated)
        context.connect("download-started", self._on_download_started)
        overlay.add(self.webview)

        self.loading = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14)
        self.loading.set_halign(Gtk.Align.CENTER)
        self.loading.set_valign(Gtk.Align.CENTER)
        self.loading.get_style_context().add_class("localtex-loading")
        spinner = Gtk.Spinner()
        spinner.set_size_request(42, 42)
        spinner.start()
        label = Gtk.Label(label="Opening your local TeX workspace…")
        self.loading.pack_start(spinner, False, False, 0)
        self.loading.pack_start(label, False, False, 0)
        overlay.add_overlay(self.loading)

        css = Gtk.CssProvider()
        css.load_from_data(
            b".localtex-loading { color: #f4f5f6; background: #1b222c; "
            b"padding: 28px; border-radius: 8px; }"
        )
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        )

    def load_project(self, project: str | None = None) -> None:
        self.loading.show_all()
        self.webview.load_uri(build_app_url(project))

    def _read_window_state(self) -> dict:
        try:
            return json.loads(WINDOW_STATE_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return {}

    def _save_window_state(self, *_args) -> bool:
        CONFIG_ROOT.mkdir(parents=True, exist_ok=True)
        width, height = self.get_size()
        state = {
            "width": width,
            "height": height,
            "maximized": bool(self.is_maximized()),
        }
        temporary = WINDOW_STATE_FILE.with_suffix(".tmp")
        temporary.write_text(json.dumps(state) + "\n", encoding="utf-8")
        temporary.replace(WINDOW_STATE_FILE)
        return False

    def _on_key_press(self, _window, event) -> bool:
        control = bool(event.state & Gdk.ModifierType.CONTROL_MASK)
        shift = bool(event.state & Gdk.ModifierType.SHIFT_MASK)
        if event.keyval == Gdk.KEY_F11:
            window_state = self.get_window().get_state() if self.get_window() else 0
            if window_state & Gdk.WindowState.FULLSCREEN:
                self.unfullscreen()
            else:
                self.fullscreen()
            return True
        if event.keyval == Gdk.KEY_F5 or (control and event.keyval in (Gdk.KEY_Return, Gdk.KEY_KP_Enter)):
            self.webview.evaluate_javascript(
                "document.querySelector('#compile')?.click()", -1, None, None, None, None, None
            )
            return True
        if control and shift and event.keyval in (Gdk.KEY_R, Gdk.KEY_r):
            self.webview.reload_bypass_cache()
            return True
        if control and event.keyval in (Gdk.KEY_Q, Gdk.KEY_q):
            self.close()
            return True
        return False

    def _on_load_changed(self, _webview, event) -> None:
        if event == WebKit2.LoadEvent.FINISHED:
            self.loading.hide()
            if self.application.smoke_test:
                self.application.begin_smoke_check(self)

    def _on_load_failed(self, _webview, _event, _uri, error) -> bool:
        self.loading.hide()
        self._show_error("The editor interface could not be loaded.", error.message)
        return True

    def _on_title_changed(self, webview, _parameter) -> None:
        title = webview.get_title()
        if title:
            self.set_title(title)

    def _on_decide_policy(self, _webview, decision, decision_type) -> bool:
        if decision_type != WebKit2.PolicyDecisionType.NAVIGATION_ACTION:
            return False
        uri = decision.get_navigation_action().get_request().get_uri()
        allowed = uri.startswith(APP_ORIGIN) or uri.startswith(("about:", "blob:", "data:"))
        if allowed:
            decision.use()
        else:
            decision.ignore()
            try:
                Gio.AppInfo.launch_default_for_uri(uri, None)
            except GLib.Error:
                pass
        return True

    def _on_permission_request(self, _webview, request) -> bool:
        request.deny()
        return True

    def _on_resource_load_started(self, _webview, _resource, request) -> None:
        uri = request.get_uri() or ""
        if not uri.startswith((APP_ORIGIN, "about:", "blob:", "data:")):
            self.application.external_requests.append(uri)

    def _on_web_process_terminated(self, _webview, _reason) -> None:
        self._show_error(
            "The interface process stopped unexpectedly.",
            "Reload the workspace to continue; your files are saved by the local service.",
        )

    def _on_download_started(self, _context, download) -> None:
        download.connect("decide-destination", self._on_download_destination)

    def _on_download_destination(self, download, suggested_filename) -> bool:
        safe_name = Path(suggested_filename or "document.pdf").name
        downloads = Path(os.environ.get("XDG_DOWNLOAD_DIR", Path.home() / "Downloads"))
        downloads.mkdir(parents=True, exist_ok=True)
        candidate = downloads / safe_name
        counter = 2
        while candidate.exists():
            candidate = downloads / f"{Path(safe_name).stem}-{counter}{Path(safe_name).suffix}"
            counter += 1
        download.set_destination(candidate.as_uri())
        return True

    def _show_error(self, title: str, detail: str) -> None:
        dialog = Gtk.MessageDialog(
            transient_for=self,
            modal=True,
            message_type=Gtk.MessageType.ERROR,
            buttons=Gtk.ButtonsType.CLOSE,
            text=title,
        )
        dialog.format_secondary_text(detail)
        dialog.run()
        dialog.destroy()


class LocalTeXApplication(Gtk.Application):
    def __init__(self, smoke_test: bool = False) -> None:
        flags = Gio.ApplicationFlags.HANDLES_COMMAND_LINE
        app_id = APP_ID
        if smoke_test:
            flags |= Gio.ApplicationFlags.NON_UNIQUE
            app_id = f"{APP_ID}.Smoke"
        super().__init__(application_id=app_id, flags=flags)
        self.smoke_test = smoke_test
        self.window: LocalTeXWindow | None = None
        self.pending_project: str | None = None
        self.smoke_attempts = 0
        self.smoke_phase = "workspace"
        self.smoke_marker = f"localtex-smoke-{os.getpid()}-{time.time_ns()}"
        self.external_requests: list[str] = []
        self.set_resource_base_path("/io/github/george/LocalTeXStudio")

    def do_startup(self) -> None:
        Gtk.Application.do_startup(self)
        self.set_application_id(self.get_application_id())

    def do_command_line(self, command_line) -> int:
        arguments = [arg for arg in command_line.get_arguments()[1:] if arg != "--smoke-test"]
        self.pending_project = arguments[0] if arguments and PROJECT_PATTERN.fullmatch(arguments[0]) else None
        self.activate()
        return 0

    def do_activate(self) -> None:
        try:
            ensure_service()
            read_token()
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            self._show_startup_error(str(error))
            if self.smoke_test:
                print(f"NATIVE_SMOKE_FAIL: {error}", flush=True)
                self.quit()
            return

        if self.window is None:
            self.window = LocalTeXWindow(self)
            self.window.show_all()
        self.window.present()
        self.window.load_project(self.pending_project)

    def begin_smoke_check(self, _window: LocalTeXWindow) -> None:
        GLib.timeout_add(250, self._poll_smoke_ready)

    def _poll_smoke_ready(self) -> bool:
        if self.window is None:
            return False
        self.smoke_attempts += 1
        if self.smoke_phase == "compile":
            self._poll_compile_ready()
            return False
        script = """
          JSON.stringify({
            ready: Boolean(document.querySelector('.cm-editor')),
            rail: Boolean(document.querySelector('.rail')),
            left: Boolean(document.querySelector('.left-panel')),
            editor: Boolean(document.querySelector('.editor-pane')),
            preview: Boolean(document.querySelector('.preview-pane')),
            recompile: Boolean(document.querySelector('#compile')),
            compileActions: document.querySelectorAll('[data-compile-action]').length,
            githubSync: Boolean(document.querySelector('#github-sync')),
            overleafSync: Boolean(document.querySelector('#overleaf-sync')),
            pdf: (document.querySelector('#pdf-canvas')?.width || 0) > 0,
            treeRows: document.querySelectorAll('.tree-row').length,
            editorTabs: document.querySelectorAll('.editor-tab').length
          })
        """
        self.window.webview.evaluate_javascript(
            script, -1, None, None, None, self._finish_smoke_javascript, None
        )
        return False

    def _finish_smoke_javascript(self, webview, result, _data) -> None:
        try:
            javascript = webview.evaluate_javascript_finish(result)
            payload = json.loads(javascript.to_string())
        except (GLib.Error, ValueError, TypeError) as error:
            self._smoke_retry_or_fail(str(error))
            return

        passed = (
            payload.get("ready")
            and payload.get("rail")
            and payload.get("left")
            and payload.get("editor")
            and payload.get("preview")
            and payload.get("recompile")
            and payload.get("compileActions") == 3
            and payload.get("githubSync")
            and payload.get("overleafSync")
            and payload.get("pdf")
            and payload.get("treeRows", 0) > 0
            and payload.get("editorTabs", 0) > 0
            and not self.external_requests
        )
        if not passed:
            self._smoke_retry_or_fail(f"workspace not ready: {payload}")
            return

        self._start_compile_smoke()

    def _start_compile_smoke(self) -> None:
        if self.window is None:
            return
        self.smoke_phase = "compile"
        self.smoke_attempts = 0
        marker = json.dumps(self.smoke_marker)
        script = f"""
          (() => {{
            window.__localtexCompileSmoke = {{
              marker: {marker},
              project: document.querySelector('#project-picker')?.value || '',
              tab: document.querySelector('.editor-tab.active .editor-tab-label')?.textContent || '',
              started: false
            }};
            const button = document.querySelector('#compile');
            button?.click();
            window.__localtexCompileSmoke.started = true;
            return true;
          }})()
        """
        self.window.webview.evaluate_javascript(
            script, -1, None, None, None, self._compile_started, None
        )

    def _compile_started(self, webview, result, _data) -> None:
        try:
            webview.evaluate_javascript_finish(result)
        except GLib.Error as error:
            self._smoke_retry_or_fail(f"could not click Recompile: {error}")
            return
        GLib.timeout_add(250, self._poll_smoke_ready)

    def _poll_compile_ready(self) -> None:
        if self.window is None:
            return
        script = """
          JSON.stringify({
            marker: window.__localtexCompileSmoke?.marker || '',
            initialProject: window.__localtexCompileSmoke?.project || '',
            initialTab: window.__localtexCompileSmoke?.tab || '',
            project: document.querySelector('#project-picker')?.value || '',
            tab: document.querySelector('.editor-tab.active .editor-tab-label')?.textContent || '',
            started: Boolean(window.__localtexCompileSmoke?.started),
            busy: Boolean(document.querySelector('#compile')?.disabled),
            button: document.querySelector('#compile')?.textContent || '',
            status: document.querySelector('#status-message')?.textContent || '',
            pdf: (document.querySelector('#pdf-canvas')?.width || 0) > 0
          })
        """
        self.window.webview.evaluate_javascript(
            script, -1, None, None, None, self._finish_compile_poll, None
        )

    def _finish_compile_poll(self, webview, result, _data) -> None:
        try:
            javascript = webview.evaluate_javascript_finish(result)
            payload = json.loads(javascript.to_string())
        except (GLib.Error, ValueError, TypeError) as error:
            self._smoke_retry_or_fail(f"compile poll failed: {error}")
            return
        if payload.get("marker") != self.smoke_marker:
            self._fail_smoke("Recompile navigated or reloaded the editor document")
            return
        if payload.get("status") == "Compilation failed":
            self._fail_smoke("the real project did not compile")
            return
        done = (
            payload.get("started")
            and not payload.get("busy")
            and payload.get("button") == "Recompile"
            and str(payload.get("status", "")).startswith("Compiled at ")
            and payload.get("pdf")
            and payload.get("project")
            and payload.get("tab")
            and payload.get("project") == payload.get("initialProject")
            and payload.get("tab") == payload.get("initialTab")
        )
        if done:
            GLib.timeout_add(800, self._complete_smoke)
            return
        self._smoke_retry_or_fail(f"compile still pending: {payload}")

    def _complete_smoke(self) -> bool:
        screenshot = os.environ.get("LOCALTEX_NATIVE_SCREENSHOT")
        if screenshot and self.window:
            while Gtk.events_pending():
                Gtk.main_iteration_do(False)
            native_window = self.window.get_window()
            width, height = self.window.get_size()
            pixbuf = Gdk.pixbuf_get_from_window(native_window, 0, 0, width, height)
            if pixbuf:
                pixbuf.savev(screenshot, "png", [], [])
        print("LocalTeX Studio native shell smoke test passed.", flush=True)
        self.quit()
        return False

    def _smoke_retry_or_fail(self, reason: str) -> None:
        if self.smoke_attempts < 960:
            GLib.timeout_add(250, self._poll_smoke_ready)
            return
        self._fail_smoke(reason)

    def _fail_smoke(self, reason: str) -> None:
        print(f"NATIVE_SMOKE_FAIL: {reason}", flush=True)
        self.quit()

    def _show_startup_error(self, detail: str) -> None:
        dialog = Gtk.MessageDialog(
            transient_for=None,
            modal=True,
            message_type=Gtk.MessageType.ERROR,
            buttons=Gtk.ButtonsType.CLOSE,
            text="LocalTeX Studio could not start",
        )
        dialog.format_secondary_text(detail)
        dialog.run()
        dialog.destroy()


def main() -> int:
    smoke_test = "--smoke-test" in sys.argv[1:]
    application = LocalTeXApplication(smoke_test=smoke_test)
    return application.run(sys.argv)


if __name__ == "__main__":
    raise SystemExit(main())
