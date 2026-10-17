"""Real isolated Git repositories/remotes; GitHub HTTP is injected, never contacted."""
import json
import io
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extension"))
from undertree_github import GitHubAccess, TOOLS, MAX_OUTPUT
from undertree_project import ProjectAccess

TOKEN = "github_pat_" + "PrivateFixture" * 5


class LocalGitHub(GitHubAccess):
    """Only this fixture substitutes a local bare remote for fixed github.com HTTPS."""
    remote = None

    def _origin(self):
        return str(self.remote) if self.remote else super()._origin()

    def _run(self, root, arguments, authenticated=False, **kwargs):
        if authenticated and self.remote:
            arguments = ["-c", "protocol.file.allow=always", *arguments]
        return super()._run(root, arguments, authenticated=authenticated, **kwargs)


@unittest.skipUnless(GitHubAccess._find_git(), "Git is required for native GitHub fixture tests")
class GitHubTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.root = self.base / "project"
        self.root.mkdir()
        self.profile = self.base / "writer"
        self.project = ProjectAccess(self.profile)
        self.project.grant(str(self.root), "read_write")
        self.access = LocalGitHub(self.profile, self.project)
        self.access.configure(TOKEN, "fixture/research", "main")
        self.access.set_enabled(True)
        self.git("init", "--template=", "--initial-branch=main")
        (self.root / "notes.txt").write_bytes(b"Initial note.\n")
        (self.root / "other.txt").write_bytes(b"Other source.\n")
        self.git("add", "--", "notes.txt", "other.txt")
        self.git("commit", "-m", "Initial fixture")

    def tearDown(self):
        self.temporary.cleanup()

    def git(self, *arguments, root=None, accepted=(0,)):
        environment = {key: value for key, value in os.environ.items() if not key.upper().startswith("GIT_")}
        environment.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull, "GIT_TERMINAL_PROMPT": "0"})
        result = subprocess.run([self.access._git, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", *arguments], cwd=str(root or self.root), env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.assertIn(result.returncode, accepted, result.stderr.decode("utf-8", "replace"))
        return result.stdout.decode("utf-8").strip()

    def head(self):
        return self.git("rev-parse", "HEAD")

    def commit(self, paths=None, message="Explicit fixture update"):
        return self.access.call("github_commit", {"paths": paths or ["notes.txt"], "message": message})

    def remote(self):
        remote = self.base / "remote.git"
        self.git("init", "--bare", "--template=", "--initial-branch=main", str(remote))
        self.access.remote = remote
        self.git("remote", "add", "origin", str(remote))
        self.git("push", "origin", "HEAD:refs/heads/main")
        clone = self.base / "peer"
        self.git("clone", "--no-hardlinks", str(remote), str(clone))
        return remote, clone

    def test_local_enable_scoped_revocable_and_never_restored(self):
        self.assertEqual([tool["name"] for tool in self.access.tools()], [tool["name"] for tool in TOOLS])
        self.access.configure(TOKEN, "fixture/research")
        self.assertFalse(self.access.state()["enabled"])
        self.assertEqual(self.access.tools(), [])
        self.access.set_enabled(True)
        self.project.revoke()
        self.assertEqual(self.access.tools(), [])
        with self.assertRaises(ValueError):
            self.access.call("github_status", {})
        self.project.grant(str(self.root), "read")
        with self.assertRaises(ValueError):
            self.access.set_enabled(True)
        self.project.grant(str(self.root), "read_write")
        self.assertEqual(self.access.tools(), [], "same-root project regrant must not restore the older GitHub grant")
        with self.assertRaisesRegex(ValueError, "explicit local grant"):
            self.access.call("github_status", {})
        self.access.set_enabled(True)
        self.assertTrue(self.access.state()["enabled"])
        restored = GitHubAccess(self.profile, self.project)
        self.assertTrue(restored.state()["configured"])
        self.assertFalse(restored.state()["enabled"])
        self.assertNotIn(TOKEN, json.dumps(restored.state()))
        self.assertNotIn("enabled", json.loads((restored.directory / "github.json").read_text()))

    def test_local_attach_adds_missing_origin_without_network_or_enabling_grant(self):
        head, content = self.head(), (self.root / "notes.txt").read_bytes()
        with patch.object(self.access, "_api", side_effect=AssertionError("No network is permitted during local attachment")):
            result = self.access.attach_repository()
        self.assertFalse(result["enabled"])
        self.assertEqual(self.git("remote", "get-url", "origin"), "https://github.com/fixture/research.git")
        self.assertEqual(self.head(), head)
        self.assertEqual((self.root / "notes.txt").read_bytes(), content)
        self.assertFalse(self.access.attach_repository()["enabled"], "matching origin attachment is idempotent")
        with self.assertRaises(ValueError):
            self.access.call("attach_repository", {})

    def test_local_attach_initializes_new_folder_without_changing_saved_files(self):
        fresh = self.base / "fresh-project"
        fresh.mkdir()
        (fresh / "source.txt").write_bytes(b"Saved source remains intact.\n")
        self.project.grant(str(fresh), "read_write")
        self.assertFalse(self.access.attach_repository()["enabled"])
        self.assertEqual(self.git("symbolic-ref", "--short", "HEAD", root=fresh), "main")
        self.assertEqual(self.git("remote", "get-url", "origin", root=fresh), "https://github.com/fixture/research.git")
        self.assertEqual((fresh / "source.txt").read_bytes(), b"Saved source remains intact.\n")
        self.assertEqual(self.git("ls-files", root=fresh), "")

    def test_local_attach_refuses_conflicting_origin_and_keeps_grant_disabled(self):
        self.git("remote", "add", "origin", "https://github.com/other/untouched.git")
        before = (self.root / ".git/config").read_bytes()
        with self.assertRaises(ValueError):
            self.access.attach_repository()
        self.assertEqual((self.root / ".git/config").read_bytes(), before)
        self.assertEqual(self.git("remote", "get-url", "origin"), "https://github.com/other/untouched.git")
        self.assertFalse(self.access.state()["enabled"])

    def test_commit_only_explicit_paths_preserves_other_changes_and_index(self):
        (self.root / "notes.txt").write_bytes(b"Revised note.\n")
        (self.root / "other.txt").write_bytes(b"Unrelated unsaved source.\n")
        result = self.commit()
        self.assertEqual(result["paths"], ["notes.txt"])
        self.assertEqual(self.git("show", "HEAD:notes.txt"), "Revised note.")
        self.assertEqual(self.git("show", "HEAD:other.txt"), "Other source.")
        self.assertEqual((self.root / "other.txt").read_bytes(), b"Unrelated unsaved source.\n")
        self.assertEqual(self.git("diff", "--cached", "--name-only"), "")
        self.assertFalse((self.root / ".git/index.lock").exists())
        self.assertEqual(self.git("status", "--porcelain"), "M other.txt")

    def test_preexisting_stage_and_index_lock_are_preserved(self):
        (self.root / "other.txt").write_bytes(b"Staged unrelated change.\n")
        self.git("add", "--", "other.txt")
        before_head, before_index = self.head(), (self.root / ".git/index").read_bytes()
        (self.root / "notes.txt").write_bytes(b"Requested update.\n")
        with self.assertRaisesRegex(ValueError, "staged"):
            self.commit()
        self.assertEqual(self.head(), before_head)
        self.assertEqual((self.root / ".git/index").read_bytes(), before_index)
        self.assertFalse((self.root / ".git/index.lock").exists())
        (self.root / ".git/index.lock").write_bytes(b"Other Git operation")
        with self.assertRaises(ValueError):
            self.commit()
        self.assertEqual((self.root / ".git/index.lock").read_bytes(), b"Other Git operation")

    def test_publication_protects_links_control_paths_and_secret(self):
        head = self.head()
        for path in ["../outside.txt", "/outside.txt", "C:/outside.txt", ".git/config", "x/../notes.txt", ".gitattributes", "folder/.gitmodules"]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.commit([path])
        (self.root / "secret.txt").write_text(TOKEN)
        with self.assertRaisesRegex(ValueError, "credential"):
            self.commit(["secret.txt"])
        with self.assertRaises(ValueError):
            self.commit(message=TOKEN)
        (self.root / "linked.txt").hardlink_to(self.root / "notes.txt")
        with self.assertRaisesRegex(ValueError, "Hard-linked"):
            self.commit(["linked.txt"])
        self.assertEqual(self.head(), head)

    def test_explicit_saved_office_and_source_folders_commit_without_native_document_writes(self):
        office = self.root / "paper.ODT"
        office.write_bytes(b"Saved native document bytes")
        (self.root / "For-AI").mkdir()
        (self.root / "For-AI/README.md").write_text("Project instructions")
        self.project.protect_documents([str(office)])
        before = office.read_bytes()
        self.commit(["paper.ODT", "For-AI/README.md"])
        self.assertEqual(office.read_bytes(), before)
        self.assertEqual(self.git("show", "HEAD:paper.ODT"), "Saved native document bytes")
        (self.root / "notes.txt").write_bytes(b"Normal new source revision.\n")
        self.commit()

    def test_repository_indirection_and_custom_configuration_rejected_without_commands(self):
        for key, value in [("core.fsmonitor", "evil-command"), ("core.hooksPath", "hooks"), ("diff.external", "evil-command"), ("filter.evil.clean", "evil-command"), ("credential.helper", "!evil-command"), ("include.path", "outside.config"), ("http.proxy", "http://evil.invalid"), ("url.file:///outside.insteadOf", "https://github.com/")]:
            with self.subTest(key=key):
                self.git("config", key, value)
                with self.assertRaisesRegex(ValueError, "Unsupported Git configuration"):
                    self.access.call("github_status", {})
                self.git("config", "--unset", key)
        target = self.base / "external.git"
        (self.root / ".git").rename(target)
        (self.root / ".git").write_text("gitdir: " + str(target))
        with self.assertRaisesRegex(ValueError, "Linked or special"):
            self.access.call("github_status", {})

    def test_hooks_are_not_run_during_commit_or_fast_forward(self):
        remote, peer = self.remote()
        marker = self.base / "hook-ran"
        for name in ("pre-commit", "post-commit", "post-merge", "pre-push"):
            hook = self.root / ".git/hooks" / name
            hook.parent.mkdir(exist_ok=True)
            hook.write_text('#!/bin/sh\nprintf invoked > "' + marker.as_posix() + '"\n')
            hook.chmod(0o700)
        (self.root / "notes.txt").write_bytes(b"Local commit.\n")
        self.commit()
        self.access.call("github_sync", {})
        self.git("pull", "--ff-only", root=peer)
        (peer / "notes.txt").write_bytes(b"Peer update.\n")
        self.git("add", "--", "notes.txt", root=peer)
        self.git("commit", "-m", "Peer update", root=peer)
        self.git("push", "origin", "main", root=peer)
        result = self.access.call("github_sync", {})
        self.assertTrue(result["synchronized"])
        self.assertEqual((self.root / "notes.txt").read_bytes(), b"Peer update.\n")
        self.assertFalse(marker.exists())
        self.assertEqual(self.git("rev-parse", "refs/heads/main", root=remote), self.head())

    def test_divergence_dirty_and_remote_office_history_preserve_local_files(self):
        remote, peer = self.remote()
        (peer / "notes.txt").write_bytes(b"Peer branch.\n")
        self.git("add", "--", "notes.txt", root=peer)
        self.git("commit", "-m", "Peer branch", root=peer)
        self.git("push", "origin", "main", root=peer)
        (self.root / "notes.txt").write_bytes(b"Local branch.\n")
        self.commit()
        head = self.head()
        with self.assertRaises(ValueError):
            self.access.call("github_sync", {})
        self.assertEqual(self.head(), head)
        self.assertEqual((self.root / "notes.txt").read_bytes(), b"Local branch.\n")
        (self.root / "other.txt").write_bytes(b"Dirty source.\n")
        with self.assertRaisesRegex(ValueError, "local changes"):
            self.access.call("github_sync", {})
        self.assertEqual(self.head(), head)

    def test_fetched_office_history_denied_before_checkout(self):
        _, peer = self.remote()
        (peer / "manuscript.odt").write_bytes(b"Office native document")
        self.git("add", "--", "manuscript.odt", root=peer)
        self.git("commit", "-m", "Office file", root=peer)
        self.git("push", "origin", "main", root=peer)
        head = self.head()
        with self.assertRaisesRegex(ValueError, "Office"):
            self.access.call("github_sync", {})
        self.assertEqual(self.head(), head)
        self.assertFalse((self.root / "manuscript.odt").exists())

    def test_fetched_open_writer_plaintext_denied_before_checkout(self):
        _, peer = self.remote()
        self.project.protect_documents([str(self.root / "notes.txt")])
        (peer / "notes.txt").write_bytes(b"Remote attempted Writer mutation.\n")
        self.git("add", "--", "notes.txt", root=peer)
        self.git("commit", "-m", "Remote plaintext change", root=peer)
        self.git("push", "origin", "main", root=peer)
        head = self.head()
        with self.assertRaisesRegex(ValueError, "open Writer"):
            self.access.call("github_sync", {})
        self.assertEqual(self.head(), head)
        self.assertEqual((self.root / "notes.txt").read_bytes(), b"Initial note.\n")

    def test_private_local_configuration_and_auth_never_in_argv(self):
        config = self.access.directory / "github.json"
        self.assertEqual(json.loads(config.read_text())["token"], TOKEN)
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o600)
        environment = self.access._environment(authenticated=True)
        self.assertNotIn(TOKEN, json.dumps({key: value for key, value in environment.items() if key != "GIT_CONFIG_VALUE_0"}))
        with patch("undertree_github.subprocess.Popen", wraps=subprocess.Popen) as command:
            self.access._run(self.root, ["status", "--short"], authenticated=True)
            self.assertNotIn(TOKEN, json.dumps(command.call_args.args))
            self.assertFalse(command.call_args.kwargs["shell"])
            self.assertIn("AUTHORIZATION: basic ", command.call_args.kwargs["env"]["GIT_CONFIG_VALUE_0"])
        self.access.clear()
        self.assertFalse(config.exists())
        self.assertEqual(self.access.tools(), [])

    def test_child_output_cap_kills_owned_child_and_preserves_commit_state(self):
        before_head, before_index = self.head(), (self.root / ".git/index").read_bytes()
        (self.root / "notes.txt").write_bytes(b"Pending update survives output failure.\n")
        launch = subprocess.Popen
        children = []
        def spawn(arguments, **kwargs):
            if "write-tree" in arguments:
                python = Path(sys.executable)
                if not python.is_file():
                    python = python.parent / "python.exe"
                arguments = [str(python), "-c", "import sys,time; sys.stdout.buffer.write(b'x'*" + str(MAX_OUTPUT + 1024) + ");sys.stdout.flush();time.sleep(60)"]
                child = launch(arguments, **kwargs)
                children.append(child)
                return child
            return launch(arguments, **kwargs)
        with patch("undertree_github.subprocess.Popen", side_effect=spawn), self.assertRaisesRegex(ValueError, "output exceeds"):
            self.commit()
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].poll())
        self.assertEqual(self.head(), before_head)
        self.assertEqual((self.root / ".git/index").read_bytes(), before_index)
        self.assertEqual((self.root / "notes.txt").read_bytes(), b"Pending update survives output failure.\n")
        self.assertFalse((self.root / ".git/index.lock").exists())

    def cancel_running_commit(self, cancel):
        head, index = self.head(), (self.root / ".git/index").read_bytes()
        (self.root / "notes.txt").write_bytes(b"Pending source must survive cancellation.\n")
        entered = threading.Event()
        launch, children, errors = subprocess.Popen, [], []
        def spawn(arguments, **kwargs):
            if "write-tree" in arguments:
                python = Path(sys.executable)
                if not python.is_file():
                    python = python.parent / "python.exe"
                child = launch([str(python), "-c", "import time; time.sleep(60)"], **kwargs)
                children.append(child)
                entered.set()
                return child
            return launch(arguments, **kwargs)
        def commit():
            try:
                self.commit()
            except ValueError as error:
                errors.append(str(error))
        with patch("undertree_github.subprocess.Popen", side_effect=spawn):
            worker = threading.Thread(target=commit)
            worker.start()
            try:
                self.assertTrue(entered.wait(5), "owned blocking child must start")
                started = time.monotonic()
                state = self.access.state()
                self.assertLess(time.monotonic() - started, .2, "refresh state must not wait for the Git operation mutex")
                self.assertTrue(state["busy"])
                started = time.monotonic()
                cancel()
                self.assertLess(time.monotonic() - started, 3, "local cancellation must not wait for the 60-second child")
                worker.join(3)
                self.assertFalse(worker.is_alive())
            finally:
                self.access._cancel.set()
                worker.join(5)
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].poll())
        self.assertTrue(errors and "cancelled locally" in errors[0], errors)
        self.assertEqual(self.head(), head)
        self.assertEqual((self.root / ".git/index").read_bytes(), index)
        self.assertEqual((self.root / "notes.txt").read_bytes(), b"Pending source must survive cancellation.\n")
        self.assertFalse((self.root / ".git/index.lock").exists())
        self.assertFalse(self.access.state()["enabled"])

    def test_refresh_is_nonblocking_and_local_github_disable_cancels_owned_git_tree(self):
        self.cancel_running_commit(lambda: self.access.set_enabled(False))

    def test_project_revoke_signals_git_cancellation_before_waiting_context(self):
        self.cancel_running_commit(self.project.revoke)

    def test_cancelled_api_creation_has_no_subsequent_local_origin_or_grant_mutation(self):
        from unittest.mock import Mock
        self.access.configure(TOKEN, "")
        self.access.set_enabled(True)
        (self.root / "notes.txt").write_bytes(b"Local commit before uncertain remote creation.\n")
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        errors = []
        class Response(io.BytesIO):
            def close(self):
                super().close()
                finished.set()
        def open_request(request, timeout):
            self.assertEqual(timeout, 30)
            if request.get_method() == "GET":
                return io.BytesIO(b'{"login":"fixture"}')
            entered.set()
            release.wait(5)
            return Response(b'{"full_name":"fixture/uncertain","private":true}')
        opener = Mock()
        opener.open.side_effect = open_request
        def create():
            try:
                self.access.call("github_create_repository", {"name": "uncertain", "private": True, "description": "", "paths": ["notes.txt"], "message": "Preserve local source"})
            except ValueError as error:
                errors.append(str(error))
        with patch("undertree_github.urllib.request.build_opener", return_value=opener):
            worker = threading.Thread(target=create)
            worker.start()
            try:
                self.assertTrue(entered.wait(8))
                started = time.monotonic()
                self.assertTrue(self.access.state()["busy"])
                self.access.set_enabled(False)
                self.assertLess(time.monotonic() - started, .5, "native disable must not wait for the blocked HTTP worker")
                worker.join(2)
                self.assertFalse(worker.is_alive())
                self.assertTrue(errors and "in-flight remote creation" in errors[0], errors)
                self.assertEqual(self.git("remote"), "")
            finally:
                release.set()
                worker.join(5)
                self.assertTrue(finished.wait(2))
        self.assertEqual(self.git("remote"), "")
        self.assertEqual(self.access.state()["repository"], "")
        self.assertFalse(self.access.state()["enabled"])
        self.assertEqual((self.root / "notes.txt").read_bytes(), b"Local commit before uncertain remote creation.\n")

    def test_create_uses_explicit_visibility_files_and_injected_personal_account(self):
        self.access.configure(TOKEN, "")
        self.access.set_enabled(True)
        remote = self.base / "new.git"
        self.git("init", "--bare", "--template=", "--initial-branch=main", str(remote))
        self.access.remote = remote
        calls = []
        def api(method, route, payload=None):
            calls.append((method, route, payload))
            return {"login": "fixture"} if method == "GET" else {"full_name": "fixture/new-research", "private": True}
        (self.root / "notes.txt").write_bytes(b"Explicit new repository update.\n")
        with patch.object(self.access, "_api", side_effect=api):
            result = self.access.call("github_create_repository", {"name": "new-research", "private": True, "description": "Scientific notes", "paths": ["notes.txt"], "message": "Publish explicit source"})
        self.assertTrue(result["created"] and result["pushed"])
        self.assertEqual(calls[0], ("GET", "/user", None))
        self.assertEqual(calls[1][2], {"name": "new-research", "private": True, "description": "Scientific notes", "auto_init": False})
        self.assertEqual(self.access.state()["repository"], "fixture/new-research")
        self.assertEqual(self.git("rev-parse", "refs/heads/main", root=remote), self.head())
        with self.assertRaisesRegex(ValueError, "configured repository"):
            self.access.call("github_create_repository", {"name": "another", "private": True, "description": "", "paths": ["notes.txt"], "message": "No retarget"})

    def test_api_failure_keeps_local_commit_and_no_origin_or_token_exposure(self):
        self.access.configure(TOKEN, "")
        self.access.set_enabled(True)
        (self.root / "notes.txt").write_bytes(b"Survives API failure.\n")
        previous = self.head()
        def api(method, *_args):
            if method == "GET":
                return {"login": "fixture"}
            raise ValueError("Injected API failure")
        with patch.object(self.access, "_api", side_effect=api), self.assertRaisesRegex(ValueError, "API failure"):
            self.access.call("github_create_repository", {"name": "new-research", "private": False, "description": "", "paths": ["notes.txt"], "message": "Preserved local commit"})
        self.assertNotEqual(self.head(), previous)
        self.assertEqual((self.root / "notes.txt").read_bytes(), b"Survives API failure.\n")
        self.assertEqual(self.git("remote"), "")
        self.assertNotIn(TOKEN, json.dumps(self.access.state()))

    def test_api_uses_fixed_https_header_auth_no_proxy_or_redirect_and_bounded_json(self):
        from unittest.mock import Mock
        opener = Mock()
        response = io.BytesIO(b'{"login":"fixture"}')
        opener.open.return_value = response
        with patch("undertree_github.urllib.request.build_opener", return_value=opener) as build:
            self.assertEqual(self.access._api("GET", "/user"), {"login": "fixture"})
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "https://api.github.com/user")
        self.assertEqual(request.get_header("Authorization"), "Bearer " + TOKEN)
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 30)
        self.assertEqual(build.call_args.args[0].proxies, {})
        self.assertIsNone(build.call_args.args[1].redirect_request(None, None, 302, "", {}, "https://example.invalid"))
        with self.assertRaises(ValueError):
            self.access._api("POST", "https://example.invalid", {})
        opener.open.return_value = io.BytesIO(b"x" * (1024 * 1024 + 1))
        with patch("undertree_github.urllib.request.build_opener", return_value=opener), self.assertRaisesRegex(ValueError, "response exceeds"):
            self.access._api("GET", "/user")

    def test_create_can_publish_an_already_committed_folder_without_an_empty_commit(self):
        self.access.configure(TOKEN, "")
        self.access.set_enabled(True)
        remote = self.base / "existing-history.git"
        self.git("init", "--bare", "--template=", "--initial-branch=main", str(remote))
        self.access.remote = remote
        original_head = self.head()
        with patch.object(self.access, "_api", side_effect=[{"login": "fixture"}, {"full_name": "fixture/committed-source", "private": False}]):
            result = self.access.call("github_create_repository", {"name": "committed-source", "private": False, "description": "", "paths": ["notes.txt"], "message": "Publish saved history"})
        self.assertTrue(result["unchanged"])
        self.assertEqual(self.head(), original_head)
        self.assertEqual(self.git("rev-parse", "refs/heads/main", root=remote), original_head)

    def test_unknown_remote_methods_arguments_and_missing_git_fail_closed(self):
        for name, arguments in [("configure", {}), ("github_status", {"root": "C:/other"}), ("github_sync", {"force": True}), ("github_commit", {"paths": ["notes.txt"], "message": "Okay", "token": TOKEN})]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.access.call(name, arguments)
        self.access.configure(TOKEN, "")
        self.access.set_enabled(True)
        with patch.object(self.access, "_api", side_effect=AssertionError("Credential-like repository names must fail before HTTP")), self.assertRaisesRegex(ValueError, "Private credentials"):
            self.access.call("github_create_repository", {"name": TOKEN, "private": True, "description": "", "paths": ["notes.txt"], "message": "Do not leak"})
        self.access._git = None
        self.access.set_enabled(False)
        with self.assertRaisesRegex(ValueError, "Git is unavailable"):
            self.access.set_enabled(True)

    def test_private_writer_profile_cannot_be_selected_through_its_parent_root(self):
        self.project.grant(str(self.base), "read_write")
        with self.assertRaisesRegex(ValueError, "private Writer"):
            self.access.set_enabled(True)
        self.assertEqual(self.access.tools(), [])

    @unittest.skipUnless(os.name == "nt", "Windows DOS short-name alias admission")
    def test_short_name_cannot_publish_git_metadata(self):
        import ctypes
        git_path = self.root / ".git/config"
        buffer = ctypes.create_unicode_buffer(32768)
        count = ctypes.windll.kernel32.GetShortPathNameW(str(git_path), buffer, len(buffer))
        if not count:
            self.skipTest("The test filesystem did not supply a DOS short name")
        relative = os.path.relpath(buffer.value, self.root).replace("\\", "/")
        with self.assertRaises(ValueError):
            self.commit([relative])


if __name__ == "__main__":
    unittest.main()
