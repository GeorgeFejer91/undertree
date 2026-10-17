"""Exercise the real Python supervisor/HTTP broker with a disposable zrok CLI fixture."""
import json
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.request

EXTENSION = Path(__file__).resolve().parents[1] / "extension"
sys.path.insert(0, str(EXTENSION))
import undertree_tunnel
import undertree_mcp
from undertree_tunnel import TunnelSupervisor, TunnelError, CONFIG
from undertree_connection import ConnectionManager

FIXTURE = r'''
import json,os,sys,time,uuid
from pathlib import Path
root=Path(__file__).parent
args=sys.argv[1:]
mode=(root/'mode').read_text() if (root/'mode').exists() else ''
state=root/'shares.json'
rows=json.loads(state.read_text()) if state.exists() else []
def save(value):
    temporary=root/(str(os.getpid())+'.tmp')
    temporary.write_text(json.dumps(value));temporary.replace(state)
if args[0]=='list':
    if mode=='list-fails-once':
        failed=root/'list-failed'
        if not failed.exists():failed.write_text('failed');sys.exit(7)
    if mode=='list-fails':sys.exit(7)
    if mode=='list-malformed':print('invalid');sys.exit()
    if mode=='list-oversized':print('x'*300000);sys.exit()
    if mode=='list-hangs':time.sleep(60)
    print(json.dumps({'shares':rows}))
elif args[0]=='share':
    (root/'args.json').write_text(json.dumps(args))
    (root/'child-home').write_text(os.environ.get('USERPROFILE' if os.name=='nt' else 'HOME',''))
    host=(root/'host').read_text()
    if mode=='startup-fails' or any(host in row['frontendEndpoints'] for row in rows):sys.exit(8)
    row={'shareToken':'writer'+uuid.uuid4().hex,'envZId':'writer-env','target':args[2],
         'frontendEndpoints':[host],'shareMode':'public','backendMode':'proxy'}
    save(rows+[row]);(root/'pid').write_text(str(os.getpid()))
    if mode=='share-exits':sys.exit(6)
    time.sleep(600)
elif args[0]=='delete':
    with (root/'deletes.jsonl').open('a') as output:output.write(json.dumps(args)+'\n')
    if mode=='delete-no-effect':sys.exit()
    if mode=='delete-fails':sys.exit(9)
    save([row for row in rows if not(row['shareToken']==args[2] and row['envZId']==args[4])])
    if mode=='delete-lost-reply':sys.exit(9)
else:sys.exit(10)
'''


class NativeSession:
    document_id = "unshared-document"
    shared = False

    def dispatch(self, name, arguments):
        if name == "list_manuscripts":
            return {"manuscripts": []}
        raise ValueError("Explicitly share this document locally first.")


class TunnelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.connection = ConnectionManager(self.root / "profile")
        self.session = NativeSession()
        self.connection.ensure(self.session, self.session.dispatch)
        self.home = self.root / "writer-home"
        (self.home / ".zrok2").mkdir(parents=True)
        enrollment = self.home / ".zrok2" / "environment.json"
        enrollment.write_text(json.dumps({"ziti_identity": "writer-env", "zrok_token": "TEST-ONLY-NEVER-EXPORTED"}))
        os.chmod(enrollment, 0o600)
        self.fixture = self.root / "fixture.py"
        self.fixture.write_text(FIXTURE)
        (self.root / "host").write_text("writer.example.test")
        executable = Path(sys.executable)
        if not executable.is_file():
            direct = executable / "bin" / ("python.exe" if os.name == "nt" else "python")
            executable = direct if direct.is_file() else executable.parent / ("python.exe" if os.name == "nt" else "python")
        self.executable = str(executable)
        self.tunnel = self.create()
        self.settings = {"reservation": "writer-only", "publicUrl": "https://writer.example.test", "zrokExecutable": self.executable, "enrollmentHome": str(self.home)}
        self.tunnel.configure(self.settings)
        self.limits = patch.multiple(undertree_tunnel, RETRY_DELAYS=(), COMMAND_TIMEOUT=2, START_TIMEOUT=5)
        self.limits.start()

    def create(self):
        tunnel = TunnelSupervisor(self.connection)
        tunnel._argv = lambda args: [self.executable, str(self.fixture), *args]
        return tunnel

    def tearDown(self):
        try:
            # Retained failed cleanup cases are resolved only for our disposable fake controller.
            (self.root / "mode").write_text("")
            self.tunnel.stop()
            self.tunnel.close(timeout=15)
        finally:
            self.connection.close()
            self.limits.stop()
            self.temp.cleanup()

    def wait(self, *phases, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status = self.tunnel.status()
            if status["phase"] in phases and (status["phase"] == "running" or not self.tunnel._thread or not self.tunnel._thread.is_alive()):
                return status
            time.sleep(0.02)
        self.fail("Writer tunnel did not reach expected lifecycle phase: " + self.tunnel.status()["phase"])

    def rows(self):
        path = self.root / "shares.json"
        return json.loads(path.read_text()) if path.exists() else []

    def foreign(self, target="http://127.0.0.1:1", host="foreign.example.test", environment="foreign-env"):
        return {"shareToken": "foreign-token", "envZId": environment, "target": target, "frontendEndpoints": [host], "shareMode": "public", "backendMode": "proxy"}

    def test_own_child_only_exact_cleanup_preserves_foreign_share_and_document_consent(self):
        foreign = self.foreign()
        (self.root / "shares.json").write_text(json.dumps([foreign]))
        parent_home = os.environ.get("USERPROFILE" if os.name == "nt" else "HOME")
        self.tunnel.start()
        running = self.wait("running")
        self.assertTrue(running["running"])
        self.assertEqual(running["endpoint"], self.settings["publicUrl"] + "/mcp/" + self.connection.status()["url"].split("/mcp/")[1])
        self.assertFalse(running["externallyVerified"])
        self.assertEqual(self.connection._endpoint.public_host, "writer.example.test")
        self.assertFalse(self.session.shared)
        self.assertEqual((self.root / "child-home").read_text(), str(self.home))
        self.assertEqual(os.environ.get("USERPROFILE" if os.name == "nt" else "HOME"), parent_home)
        arguments = json.loads((self.root / "args.json").read_text())
        self.assertEqual(arguments[0:2], ["share", "public"])
        self.assertEqual(arguments[2], self.connection.status()["url"].split("/mcp/")[0])
        self.assertEqual(arguments[-2:], ["--headless", "--force-local"])
        child = self.tunnel._child
        owned = self.tunnel._owned.copy()
        self.tunnel.stop()
        self.wait("stopped")
        self.assertIsNotNone(child.poll())
        self.assertEqual(self.rows(), [foreign])
        self.assertIsNone(self.connection._endpoint.public_host)
        deleted = [json.loads(line) for line in (self.root / "deletes.jsonl").read_text().splitlines()]
        self.assertEqual(deleted, [["delete", "share", owned["shareToken"], "--envzid", "writer-env"]])
        self.assertNotIn("TEST-ONLY-NEVER-EXPORTED", json.dumps(running))

    def test_stop_is_sticky_but_clean_process_close_restores_desired_connection(self):
        self.tunnel.start()
        original = self.wait("running")["endpoint"]
        self.tunnel.close()
        self.tunnel = self.create()
        self.tunnel.restore()
        self.assertEqual(self.wait("running")["endpoint"], original)
        self.tunnel.stop()
        self.wait("stopped")
        self.tunnel.close()
        self.tunnel = self.create()
        self.assertFalse(self.tunnel.restore()["autoReconnect"])
        self.assertIsNone(self.tunnel._thread)
        self.assertFalse(self.session.shared)

    def test_preexisting_target_or_name_never_adopted_deleted_or_stolen(self):
        target = self.connection.status()["url"].split("/mcp/")[0]
        for existing in [self.foreign(target=target), self.foreign(host="writer.example.test")]:
            with self.subTest(existing=existing):
                (self.root / "shares.json").write_text(json.dumps([existing]))
                self.tunnel.start()
                self.wait("failed", "cleanup_required")
                self.assertEqual(self.rows(), [existing])
                self.assertFalse((self.root / "deletes.jsonl").exists())
                self.assertFalse(self.tunnel.status()["running"])

    def test_replacement_share_cannot_be_deleted_even_after_target_or_owner_changes(self):
        self.tunnel.start()
        self.wait("running")
        original = self.tunnel._owned.copy()
        replacement = dict(original, envZId="other-enrollment", target="http://127.0.0.1:7")
        (self.root / "shares.json").write_text(json.dumps([replacement]))
        self.tunnel.stop()
        self.wait("cleanup_required")
        self.assertEqual(self.rows(), [replacement])
        self.assertFalse((self.root / "deletes.jsonl").exists())
        with self.assertRaises(TunnelError):
            self.tunnel.start()
        # Simulate independent disappearance, then explicit Stop can resolve uncertainty.
        (self.root / "shares.json").write_text("[]")
        self.tunnel.stop()
        self.wait("stopped")

    def test_ineffective_delete_blocks_reconnect_until_verified_absence(self):
        self.tunnel.start()
        self.wait("running")
        (self.root / "mode").write_text("delete-no-effect")
        self.tunnel.stop()
        self.wait("cleanup_required")
        with self.assertRaises(TunnelError):
            self.tunnel.start()
        self.assertTrue(self.rows())
        (self.root / "mode").write_text("delete-lost-reply")
        self.tunnel.stop()
        self.wait("stopped")
        self.assertEqual(self.rows(), [])

    def test_invalid_or_oversized_preflight_listing_never_authorizes_cleanup(self):
        for mode in ("list-malformed", "list-oversized", "list-hangs"):
            with self.subTest(mode=mode):
                (self.root / "mode").write_text(mode)
                self.tunnel.start()
                self.wait("failed")
                self.assertIsNone(self.tunnel._prepared)
                self.assertFalse((self.root / "args.json").exists())
                self.assertFalse((self.root / "deletes.jsonl").exists())

    def test_failed_child_start_cleans_only_new_exact_record(self):
        (self.root / "mode").write_text("share-exits")
        self.tunnel.start()
        self.wait("failed")
        self.assertEqual(self.rows(), [])
        self.assertIsNone(self.tunnel._child)

    def test_bounded_retries_stop_and_no_broker_fail_closed(self):
        self.connection.stop()
        with patch.object(undertree_tunnel, "RETRY_DELAYS", (0.01, 0.01)):
            self.tunnel.start()
            self.assertEqual(self.wait("failed")["retryAttempt"], 3)
        self.assertFalse((self.root / "args.json").exists())
        self.tunnel.stop()
        self.assertFalse(self.tunnel.status()["autoReconnect"])

    def test_transient_failure_error_clears_when_owned_share_recovers(self):
        foreign = self.foreign()
        (self.root / "shares.json").write_text(json.dumps([foreign]))
        (self.root / "mode").write_text("list-fails-once")
        with patch.object(undertree_tunnel, "RETRY_DELAYS", (0.01,)):
            self.tunnel.start()
            recovered = self.wait("running")
        self.assertEqual((self.root / "list-failed").read_text(), "failed")
        self.assertTrue(recovered["running"])
        self.assertEqual(recovered["retryAttempt"], 2)
        self.assertEqual(recovered["error"], "")
        self.assertEqual(self.connection._endpoint.public_host, "writer.example.test")
        self.assertIn(foreign, self.rows())
        self.assertFalse(self.session.shared)

    def bundle_paths(self):
        cache = self.connection.directory.parent / "uno_packages/cache/uno_packages"
        old = cache / "lu123old.tmp_/wrAIter.oxt/zrok2.exe"
        current = cache / "lu456new.tmp_/wrAIter.oxt/zrok2.exe"
        current.parent.mkdir(parents=True)
        current.write_bytes(b"qualified test bridge")
        current.chmod(0o600)
        (current.parent / "description.xml").write_text('<description xmlns="http://openoffice.org/extensions/description/2006"><identifier value="org.undertree.WriterReview"/></description>')
        (current.parent / "description.xml").chmod(0o600)
        for directory in (cache.parent.parent, cache.parent, cache, current.parent.parent, current.parent):
            directory.chmod(0o700)
        self.tunnel.configure(dict(self.settings, zrokExecutable=str(old)))
        self.tunnel.set_auto_reconnect(True)
        return old, current

    def test_removed_own_cached_bridge_retargets_only_executable_to_current_qualified_bundle(self):
        old, current = self.bundle_paths()
        saved = dict(self.tunnel._config)
        identity = (self.connection.directory / "connection.json").read_bytes()
        with patch.object(undertree_tunnel, "__file__", str(current.with_name("undertree_tunnel.py"))), patch.object(undertree_tunnel, "BUNDLED_ZROK_SHA256", hashlib.sha256(current.read_bytes()).hexdigest()):
            self.tunnel.start()
            self.assertTrue(self.wait("running")["running"])
        self.assertFalse(old.exists())
        expected = dict(saved, zrokExecutable=str(current))
        self.assertEqual(json.loads((self.connection.directory / CONFIG).read_bytes()), expected)
        self.assertEqual(self.tunnel._config, expected)
        self.assertEqual(TunnelSupervisor._argv(self.tunnel, ["list", "shares"]), [str(current), "list", "shares"])
        self.assertEqual((self.connection.directory / "connection.json").read_bytes(), identity)

    def test_bundle_retarget_preserves_external_choices_even_when_missing(self):
        old, current = self.bundle_paths()
        for external in (self.root / "custom/zrok2.exe", self.root / "other-profile/uno_packages/cache/uno_packages/lu123old.tmp_/wrAIter.oxt/zrok2.exe"):
            self.tunnel.configure(dict(self.settings, zrokExecutable=str(external)))
            before = (self.connection.directory / CONFIG).read_bytes()
            with patch.object(undertree_tunnel, "__file__", str(current.with_name("undertree_tunnel.py"))):
                self.assertTrue(self.tunnel._refresh_bundled_executable())
            self.assertEqual((self.connection.directory / CONFIG).read_bytes(), before)
            self.assertEqual(TunnelSupervisor._argv(self.tunnel, ["list"]), [str(external), "list"])

    def test_bundle_retarget_missing_or_unqualified_current_bundle_preserves_saved_setup(self):
        old, current = self.bundle_paths()
        before = (self.connection.directory / CONFIG).read_bytes()
        with patch.object(undertree_tunnel, "__file__", str(current.with_name("undertree_tunnel.py"))):
            with self.assertRaises(TunnelError):
                self.tunnel._refresh_bundled_executable()
            current.unlink()
            with self.assertRaises(TunnelError):
                self.tunnel._refresh_bundled_executable()
            current.write_bytes(b"qualified test bridge")
            current.chmod(0o600)
            (current.parent / "description.xml").write_text('<description xmlns="http://openoffice.org/extensions/description/2006"><identifier value="org.another.Extension"/></description>')
            with patch.object(undertree_tunnel, "BUNDLED_ZROK_SHA256", hashlib.sha256(current.read_bytes()).hexdigest()), self.assertRaises(TunnelError):
                self.tunnel._refresh_bundled_executable()
        outside = self.root / "other-profile/uno_packages/cache/uno_packages/lu789other.tmp_/wrAIter.oxt/undertree_tunnel.py"
        with patch.object(undertree_tunnel, "__file__", str(outside)), self.assertRaises(TunnelError):
            self.tunnel._refresh_bundled_executable()
        self.assertEqual((self.connection.directory / CONFIG).read_bytes(), before)
        self.assertEqual(self.tunnel.settings()["zrokExecutable"], str(old))

    def test_bundle_retarget_keeps_cancellation_and_external_config_guards(self):
        old, current = self.bundle_paths()
        before = (self.connection.directory / CONFIG).read_bytes()
        with patch.object(undertree_tunnel, "__file__", str(current.with_name("undertree_tunnel.py"))), patch.object(undertree_tunnel, "BUNDLED_ZROK_SHA256", hashlib.sha256(current.read_bytes()).hexdigest()):
            self.tunnel._cancel.set()
            self.assertFalse(self.tunnel._refresh_bundled_executable())
            self.assertEqual((self.connection.directory / CONFIG).read_bytes(), before)
            self.tunnel._cancel.clear()
            changed = before + b" "
            (self.connection.directory / CONFIG).write_bytes(changed)
            with self.assertRaises(TunnelError):
                self.tunnel._refresh_bundled_executable()
            self.assertEqual((self.connection.directory / CONFIG).read_bytes(), changed)
            (self.connection.directory / CONFIG).write_bytes(before)

    def test_broker_fixed_catalogue_and_owner_required_without_restoring_document_grants(self):
        real = self.connection.status
        with patch.object(self.connection, "status", side_effect=lambda: dict(real(), writerOwnerId="different-owner")):
            self.tunnel.start()
            self.wait("failed")
        self.assertFalse((self.root / "args.json").exists())
        self.assertFalse(self.session.shared)

    def test_broker_extra_tool_or_changed_input_schema_cannot_be_published(self):
        extra = [*undertree_mcp.TOOLS, {"name": "save", "inputSchema": {"type": "object"}}]
        changed = json.loads(json.dumps(undertree_mcp.TOOLS))
        changed[1]["inputSchema"]["additionalProperties"] = True
        for tools in (extra, changed):
            with self.subTest(tools=len(tools)), patch.object(undertree_mcp, "TOOLS", tools):
                self.tunnel.start()
                self.wait("failed")
            self.assertFalse((self.root / "args.json").exists())
        self.assertFalse(self.session.shared)

    def test_only_locally_paired_extra_aliases_are_allowed_beside_native_three(self):
        class Peers:
            def tools(self): return [{"name": "peer_fixture_read_manuscript", "inputSchema": {"type": "object"}}]
            def call(self, *_): return {"content": [], "isError": False}
        self.connection.set_peers(Peers())
        self.tunnel.start()
        self.assertTrue(self.wait("running")["running"])
        self.assertFalse(self.session.shared)

    def test_private_setup_rejects_foreign_input_and_preserves_corrupt_external_config(self):
        self.assertEqual(self.tunnel.settings(), self.settings)
        edited = self.tunnel.settings()
        edited["reservation"] = "another"
        self.assertEqual(self.tunnel.settings(), self.settings)
        before = (self.connection.directory / CONFIG).read_bytes()
        for change in ({"publicUrl": "http://wrong.example"}, {"publicUrl": "https://writer.example/x"}, {"publicUrl": "https://user:pass@writer.example"}, {"reservation": "../foreign"}, {"zrokExecutable": "zrok2.exe"}, {"enrollmentHome": "../relative"}, {"grant": True}):
            with self.subTest(change=change), self.assertRaises(TunnelError):
                self.tunnel.configure(dict(self.settings, **change))
            self.assertEqual((self.connection.directory / CONFIG).read_bytes(), before)
        (self.connection.directory / CONFIG).write_bytes(b"externally corrupt")
        with self.assertRaises(TunnelError):
            self.tunnel.start()
        self.assertEqual((self.connection.directory / CONFIG).read_bytes(), b"externally corrupt")
        with self.assertRaises(TunnelError):
            TunnelSupervisor(self.connection)
        (self.connection.directory / CONFIG).write_bytes(before)


if __name__ == "__main__":
    unittest.main()
