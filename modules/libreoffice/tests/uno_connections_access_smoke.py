"""Native local consent wiring with real private folder/GitHub authorities; no network calls."""
import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace

import uno

extension = Path(os.environ.get("UNDERTREE_WRITER_EXTENSION_SOURCE", Path(__file__).resolve().parents[1] / "extension"))
sys.path.insert(0, str(extension))
from undertree_writer import Session, property_value
from undertree_project import ProjectAccess
from undertree_github import GitHubAccess
from undertree_connection import ConnectionManager
from undertree_policy import CONTRACT
from undertree_ui import Connections, GitHubSetup, Panel, RuleDialog, ColorPicker
from uno_dialog_layout_smoke import check_bounds


def verify(context):
    desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
    provider = context.ServiceManager.createInstanceWithContext("com.sun.star.configuration.ConfigurationProvider", context)
    settings = provider.createInstanceWithArguments("com.sun.star.configuration.ConfigurationUpdateAccess", (property_value("nodepath", "/org.openoffice.Office.Common/Misc"),))
    settings.FirstRun, settings.ShowTipOfTheDay = False, False
    settings.commitChanges()
    document = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
    session, connections, setup, rule, manager, picker = None, None, None, None, None, None
    with tempfile.TemporaryDirectory(prefix="wraiter-native-access-") as temporary:
        folder = Path(temporary).resolve()
        assert folder.parent == Path(tempfile.gettempdir()).resolve()
        root = folder / "chosen-project"
        root.mkdir()
        project = ProjectAccess(folder / "project-private")
        (folder / "github-private").mkdir()
        github = GitHubAccess(folder / "github-private", project)
        try:
            document.Text.String = "Private native UI fixture. Never shared or edited."
            document.storeAsURL(uno.systemPathToFileUrl(str(root / "live.txt")), (property_value("FilterName", "Text"),))
            manager = ConnectionManager(folder / "connection-private")
            manager.set_project_access(project, github)
            manager.tunnel = SimpleNamespace(status=lambda: {"phase": "stopped"})
            session = Session(context, document, manager)
            assert session.panel is None
            session.show_connections()
            standalone = session.connections
            assert standalone.dialog.isVisible() and session.panel is None
            session.show_connections()
            assert session.connections is standalone and session.panel is None
            standalone.close()
            assert session.connections is None and session.panel is None
            session.panel = panel = Panel(session)
            connections = Connections(panel)
            connections.show()
            connections.action("projectPage")
            check_bounds(connections)
            assert not connections.control("share").isVisible() and connections.control("folder").isVisible()
            original_github_state = github.state
            github.state = lambda: {**original_github_state(), "busy": True, "error": "stale prior error"}
            try:
                connections.refresh()
                assert "GitHub operation running…" in connections.control("status").Model.Label
                assert "stale prior error" not in connections.control("status").Model.Label
            finally: github.state = original_github_state

            class Picker:
                def setTitle(self, _): pass
                def setDisplayDirectory(self, _): pass
                def execute(self): return 1
                def getDirectory(self): return uno.systemPathToFileUrl(str(root))
                def dispose(self): pass
            original_create = connections.create
            connections.create = lambda name: Picker() if name == "com.sun.star.ui.dialogs.FolderPicker" else original_create(name)
            try: connections.action("browseFolder")
            finally: connections.create = original_create
            assert project.state() == {"path": str(root), "mode": "read", "active": False}
            connections.action("grantFolder")
            assert project.state()["active"] and project.state()["mode"] == "read"

            setup = GitHubSetup(connections)
            setup.show()
            opened_urls = []
            original_setup_create = setup.create
            setup.create = lambda name: SimpleNamespace(execute=lambda *arguments: opened_urls.append(arguments)) if name == "com.sun.star.system.SystemShellExecute" else original_setup_create(name)
            try: setup.action("createToken")
            finally: setup.create = original_setup_create
            assert opened_urls == [("https://github.com/settings/personal-access-tokens/new", "", uno.getConstantByName("com.sun.star.system.SystemShellExecuteFlags.URIS_ONLY"))]
            token_cleared = []
            original_configure = github.configure
            def configure(token, repository, branch):
                token_cleared.append(setup.control("token").Model.Text == "")
                return original_configure(token, repository, branch)
            github.configure = configure
            setup.control("token").Model.Text = "NATIVE_ONLY_FAKE_TOKEN_1234567890"
            setup.control("repository").Model.Text = "fixture/native-ui"
            setup.action("save")
            github.configure = original_configure
            assert token_cleared == [True] and setup.disposed
            assert github.state()["configured"] and not github.state()["enabled"]
            connections.updating = True
            connections.control("githubEnable").Model.State = 1
            connections.updating = False
            try: connections.changed("githubEnable")
            except ValueError: pass
            else: raise AssertionError("Read-only folder must refuse GitHub writes")
            assert connections.control("githubEnable").Model.State == 0 and not github.state()["enabled"]

            connections.control("folder_read_write").Model.State = 1
            connections.changed("folder_read_write")
            assert project.state()["mode"] == "read_write" and not project.state()["active"]
            connections.action("grantFolder")
            project.call("project_write_file", {"path": "ordinary-note.txt", "content": "Ordinary project text.", "expectedSha256": None})
            assert project.call("project_read_file", {"path": "ordinary-note.txt"})["content"] == "Ordinary project text."
            for filename in ("live.txt", "renamed.txt"):
                if filename == "renamed.txt":
                    document.storeAsURL(uno.systemPathToFileUrl(str(root / filename)), (property_value("FilterName", "Text"),))
                before = (root / filename).read_bytes()
                current = project.call("project_read_file", {"path": filename})
                try: project.call("project_write_file", {"path": filename, "content": "Forbidden bypass", "expectedSha256": current["sha256"]})
                except ValueError as error:
                    assert "native highlighted-document permissions" in str(error)
                else: raise AssertionError("Project write bypassed the live Writer path guard: " + filename)
                assert (root / filename).read_bytes() == before
                assert document.Text.String == "Private native UI fixture. Never shared or edited."
            setup = GitHubSetup(connections)
            setup.show()
            setup.control("repository").Model.Text = "unsaved/ignored"
            setup.action("attach")
            assert github.state()["repository"] == "fixture/native-ui" and not github.state()["enabled"]
            assert (root / ".git" / "config").is_file()
            config = (root / ".git" / "config").read_text()
            assert "https://github.com/fixture/native-ui.git" in config and "unsaved/ignored" not in config
            assert "No network call or commit" in setup.control("status").Model.Label
            setup.control("repository").Model.Text = "fixture/native-ui"
            setup.control("enabled").Model.State = 1
            setup.action("save")
            assert github.state()["enabled"]
            def failed_tunnel_stop():
                raise ValueError("Injected owned-fixture tunnel stop failure")
            manager.tunnel.stop = failed_tunnel_stop
            try: session.stop()
            except ValueError: pass
            else: raise AssertionError("Injected stop failure was not reported")
            assert not project.state()["active"] and not github.state()["enabled"]
            assert not manager.status()["autoReconnect"]
            connections.action("grantFolder")
            connections.control("githubEnable").Model.State = 1
            connections.changed("githubEnable")
            assert github.state()["enabled"]
            connections.action("revokeFolder")
            assert not project.state()["active"] and not github.state()["enabled"]
            restored = ProjectAccess(folder / "project-private")
            assert restored.state()["path"] == str(root) and not restored.state()["active"]
            restored_github = GitHubAccess(folder / "github-private", restored)
            assert restored_github.state()["configured"] and not restored_github.state()["enabled"]
            assert "token" not in restored_github.state()

            commands = []
            original_action = panel.action
            panel.action = commands.append
            try:
                listener = panel.slot_events[0]
                for count in (1, 2):
                    event = SimpleNamespace(Buttons=1, ClickCount=count, PopupTrigger=False)
                    listener.mousePressed(event)
                    listener.mouseReleased(event)
                assert commands == ["configure0"]
            finally: panel.action = original_action
            rule = RuleDialog(panel, "protect")
            rule.modal = False
            rule.show()
            rule.action("wordingPage")
            assert rule.control("prompt").isVisible() and rule.control("save").isVisible()
            assert not rule.control("prompt").isEnabled()
            assert all(not rule.control("preset_" + preset["id"]).isEnabled() for preset in CONTRACT["presets"])
            rule.action("colorPage")
            rule.control("action_prompt").Model.State = 1
            rule.changed("action_prompt")
            rule.action("wordingPage")
            assert rule.control("prompt").isEnabled()
            assert all(rule.control("preset_" + preset["id"]).isEnabled() for preset in CONTRACT["presets"])
            before_color = rule.control("color").Model.Text
            picker = ColorPicker(rule, before_color)
            picker.modal = False
            picker.show()
            check_bounds(picker)
            picker.action("swatch2")
            assert picker.control("hex").Model.Text == "#90caf9"
            picker.action("cancel")
            assert picker.result is None and rule.control("color").Model.Text == before_color
            picker.dispose()
            picker = ColorPicker(rule, before_color)
            picker.modal = False
            picker.show()
            picker.control("hex").Model.Text = "#invalid"
            try: picker.action("save")
            except ValueError: pass
            else: raise AssertionError("Malformed color accepted")
            assert not picker.disposed and picker.result is None
            picker.control("hex").Model.Text = "#123ABC"
            picker.action("save")
            assert picker.result == "#123abc"
            assert document.Text.String == "Private native UI fixture. Never shared or edited."
            assert not session.shared and not session.endpoint
            return {"status": "passed", "nativePages": True, "folderPickerResponseGrantsNothing": True,
                "explicitReadAndWriteConsent": True, "githubCredentialsSaveDisabled": True,
                "patClearedBeforeConfigure": True, "readOnlyGithubDenied": True,
                "createTokenFixedUrlOnly": True,
                "attachUsesSavedRepositoryLocallyOnly": True, "nativeSwatchPickerCancelAndExactHex": True,
                "githubProgressVisible": True,
                "liveTxtAndSaveAsWriteBypassDenied": True,
                "restartRestoresNoGrants": True, "paletteDoubleClickOnlyOpensSettings": True,
                "standaloneConnectionsCreatesNoPanel": True, "failedStopRevokesProjectAndGithub": True,
                "protectDisablesPrompts": True, "networkCalls": 0, "normalProfileChanged": False}
        finally:
            if picker: picker.dispose()
            if rule: rule.dispose()
            if setup: setup.dispose()
            if connections: connections.close()
            if session:
                session.close()
            if manager: manager.close()
            document.setModified(False)
            document.close(True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=2096)
    parser.add_argument("--output", default="artifacts/libreoffice/native-connections-access-result.json")
    args = parser.parse_args()
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    context = resolver.resolve("uno:socket,host=127.0.0.1,port=%d;urp;StarOffice.ComponentContext" % args.port)
    result = verify(context)
    Path(args.output).write_text(json.dumps(result, indent=2), encoding="utf-8")
    print("PASS: native project/GitHub consent, no restored grants, PAT clearing, double-click and protected prompt controls")
