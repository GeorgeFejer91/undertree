"""Real bounded project files and session grants; no UNO, GitHub or tunnel services."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extension"))
from undertree_project import CONFIG, MAX_TEXT, PROTECTED_EXTENSIONS, ProjectAccess, is_office_document


class ProjectTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.root = self.base / "project"
        self.root.mkdir()
        self.profile = self.base / "writer"
        self.project = ProjectAccess(self.profile)
        self.file = self.root / "notes.txt"
        self.file.write_bytes(b"A scientific note.\n")

    def tearDown(self):
        self.temporary.cleanup()

    def grant(self, mode="read_write"):
        return self.project.grant(str(self.root), mode)

    def read(self, path="notes.txt"):
        return self.project.call("project_read_file", {"path": path})

    def write(self, path, content, expected):
        return self.project.call("project_write_file", {"path": path, "content": content, "expectedSha256": expected})

    def test_configure_remembers_selection_without_grant_and_reopen_never_restores_access(self):
        selected = self.project.configure(str(self.root), "read_write")
        self.assertEqual(selected, {"path": str(self.root), "mode": "read_write", "active": False})
        self.assertEqual(self.project.tools(), [])
        with self.assertRaises(ValueError):
            self.read()
        self.grant()
        raw = (self.profile / CONFIG).read_bytes()
        restored = ProjectAccess(self.profile)
        self.assertEqual(restored.state(), selected)
        self.assertEqual(restored.tools(), [])
        with self.assertRaises(ValueError):
            restored.call("project_read_file", {"path": "notes.txt"})
        self.assertNotIn("active", json.loads(raw))
        self.assertEqual((self.profile / CONFIG).read_bytes(), raw)

    def test_read_only_has_read_tools_and_refuses_guessed_write_without_mutation(self):
        self.grant("read")
        self.assertEqual([tool["name"] for tool in self.project.tools()], ["project_list_directory", "project_read_file"])
        result = self.read()
        self.assertEqual(result["content"], "A scientific note.\n")
        self.assertTrue(result["complete"])
        self.assertEqual(result["sha256"], hashlib.sha256(self.file.read_bytes()).hexdigest())
        before = self.file.read_bytes()
        with self.assertRaisesRegex(ValueError, "Read access only"):
            self.write("notes.txt", "Changed", result["sha256"])
        self.assertEqual(self.file.read_bytes(), before)
        with self.assertRaises(ValueError):
            with self.project.context(write=True):
                self.fail("Read-only contexts must not yield.")

    def test_hash_checked_atomic_replacement_and_explicit_null_create(self):
        self.grant()
        original = self.read()
        result = self.write("notes.txt", "Überarbeitung 🌳\n", original["sha256"])
        self.assertTrue(result["written"])
        self.assertEqual(self.file.read_text(encoding="utf-8"), "Überarbeitung 🌳\n")
        self.assertEqual(result["sha256"], self.read()["sha256"])
        for expected in (None, original["sha256"], "0" * 64):
            with self.assertRaises(ValueError):
                self.write("notes.txt", "Must not replace", expected)
        self.assertEqual(self.file.read_text(encoding="utf-8"), "Überarbeitung 🌳\n")
        created = self.write("new.txt", "New complete text", None)
        self.assertTrue(created["written"])
        self.assertEqual((self.root / "new.txt").read_text(), "New complete text")
        with self.assertRaises(ValueError):
            self.project.call("project_write_file", {"path": "absent.txt", "content": "No implicit create"})
        with self.assertRaises(ValueError):
            self.write("absent.txt", "No stale create", "0" * 64)
        self.assertFalse((self.root / "absent.txt").exists())
        self.assertFalse(list(self.root.glob(".writer-project-*")))

    def test_external_change_during_staging_is_preserved_and_temporary_removed(self):
        self.grant()
        expected = self.read()["sha256"]
        original_read = self.project._read_at
        calls = 0

        def interleaved(*arguments):
            nonlocal calls
            calls += 1
            if calls == 3:
                self.file.write_text("An external newer edit.", encoding="utf-8")
            return original_read(*arguments)

        with patch.object(self.project, "_read_at", side_effect=interleaved):
            with self.assertRaisesRegex(ValueError, "changed before atomic"):
                self.write("notes.txt", "Stale replacement", expected)
        self.assertEqual(self.file.read_text(), "An external newer edit.")
        self.assertFalse(list(self.root.glob(".writer-project-*")))

    def test_staged_content_changes_are_not_published(self):
        self.grant()
        expected, before = self.read()["sha256"], self.file.read_bytes()
        flush = os.fsync

        def modify_stage(descriptor):
            flush(descriptor)
            for stage in self.root.glob(".writer-project-*"):
                stage.write_bytes(b"Changed by another process")

        with patch("undertree_project.os.fsync", side_effect=modify_stage):
            with self.assertRaisesRegex(ValueError, "staged project file changed"):
                self.write("notes.txt", "Intended text", expected)
        self.assertEqual(self.file.read_bytes(), before)
        self.assertFalse(list(self.root.glob(".writer-project-*")))

    def test_new_file_collision_during_staging_never_overwrites_destination(self):
        self.grant()
        flush = os.fsync

        def create_destination(descriptor):
            flush(descriptor)
            (self.root / "collision.txt").write_bytes(b"New external file")

        with patch("undertree_project.os.fsync", side_effect=create_destination):
            with self.assertRaises(ValueError):
                self.write("collision.txt", "Must not overwrite", None)
        self.assertEqual((self.root / "collision.txt").read_bytes(), b"New external file")
        self.assertFalse(list(self.root.glob(".writer-project-*")))

    def test_revoke_blocks_all_tools_and_context_serializes_revocation(self):
        self.grant()
        entered, finished = threading.Event(), threading.Event()

        def revoke():
            entered.set()
            self.project.revoke()
            finished.set()

        with self.project.context(write=True) as root:
            self.assertEqual(root, self.root)
            worker = threading.Thread(target=revoke)
            worker.start()
            self.assertTrue(entered.wait(2))
            self.assertFalse(finished.is_set())
        worker.join(2)
        self.assertTrue(finished.is_set())
        self.assertEqual(self.project.tools(), [])
        for name, arguments in (("project_list_directory", {}), ("project_read_file", {"path": "notes.txt"}), ("project_write_file", {"path": "new.txt", "content": "Denied", "expectedSha256": None})):
            with self.assertRaises(ValueError):
                self.project.call(name, arguments)
        self.assertFalse((self.root / "new.txt").exists())

    def test_local_grant_generation_changes_even_when_regranting_same_root(self):
        generation = self.project.grant_generation
        self.project.configure(str(self.root), "read_write")
        self.assertGreater(self.project.grant_generation, generation)
        generation = self.project.grant_generation
        self.grant()
        self.assertGreater(self.project.grant_generation, generation)
        generation = self.project.grant_generation
        with self.project.context(write=True):
            self.assertEqual(self.project.grant_generation, generation)
        self.project.revoke()
        self.assertGreater(self.project.grant_generation, generation)
        generation = self.project.grant_generation
        self.grant()
        self.assertGreater(self.project.grant_generation, generation)
        self.assertEqual(set(self.project.state()), {"path", "mode", "active"})

    def test_status_and_catalogue_do_not_wait_for_an_active_operation(self):
        self.grant()
        self.project.protect_documents([self.file])
        entered, release, queried = threading.Event(), threading.Event(), threading.Event()
        observed = []

        def hold_operation():
            with self.project.context(write=True):
                entered.set()
                release.wait(3)

        def query():
            self.project.protect_documents([self.file])
            observed.append((self.project.state(), self.project.grant_generation, self.project.tools()))
            queried.set()

        holder = threading.Thread(target=hold_operation)
        reader = threading.Thread(target=query)
        holder.start()
        self.assertTrue(entered.wait(2))
        reader.start()
        try:
            self.assertTrue(queried.wait(0.5), "Status must not wait for the operation lock.")
            self.assertEqual(observed[0][0], {"path": str(self.root), "mode": "read_write", "active": True})
            self.assertEqual(len(observed[0][2]), 3)
            self.assertFalse(self.project.cancel_event.is_set())
            observed[0][0]["path"] = "Cannot mutate published status"
            self.assertEqual(self.project.state()["path"], str(self.root))
        finally:
            release.set()
            holder.join(3)
            reader.join(3)
        self.assertFalse(holder.is_alive())
        self.assertFalse(reader.is_alive())

    def test_failed_selection_cannot_be_resumed_by_native_path_updates(self):
        for change in (self.project.configure, self.project.grant):
            with self.subTest(change=change.__name__):
                self.grant()
                with self.assertRaises(ValueError):
                    change(str(self.root), "unsupported")
                self.project.protect_documents([self.root / (change.__name__ + ".txt")])
                self.assertFalse(self.project.state()["active"])
                self.assertTrue(self.project.cancel_event.is_set())
                self.assertEqual(self.project.tools(), [])

    def test_local_changes_signal_cancellation_before_waiting_for_operation(self):
        for change in ("revoke", "configure", "grant", "protect"):
            with self.subTest(change=change):
                self.grant()
                entered, observed = threading.Event(), threading.Event()
                errors = []

                def cancellable_operation():
                    try:
                        with self.project.context(write=True):
                            entered.set()
                            if self.project.cancel_event.wait(2):
                                observed.set()
                    except Exception as error:
                        errors.append(error)

                worker = threading.Thread(target=cancellable_operation)
                worker.start()
                self.assertTrue(entered.wait(2))
                if change == "revoke":
                    self.project.revoke()
                elif change == "configure":
                    self.project.configure(str(self.root), "read_write")
                elif change == "grant":
                    self.grant()
                else:
                    self.project.protect_documents([self.file])
                worker.join(3)
                self.assertTrue(observed.is_set(), "Cancellation must precede waiting for the operation lock.")
                self.assertFalse(worker.is_alive())
                self.assertEqual(errors, [])
                self.assertEqual(self.project.state()["active"], change in ("grant", "protect"))
                self.assertEqual(self.project.cancel_event.is_set(), change not in ("grant", "protect"))

    def test_cancelled_write_does_not_publish_staged_content(self):
        self.grant()
        expected, before = self.read()["sha256"], self.file.read_bytes()
        flush = os.fsync
        workers = []

        def cancel_stage(descriptor):
            flush(descriptor)
            worker = threading.Thread(target=self.project.revoke)
            workers.append(worker)
            worker.start()
            self.assertTrue(self.project.cancel_event.wait(2))

        with patch("undertree_project.os.fsync", side_effect=cancel_stage):
            with self.assertRaisesRegex(ValueError, "cancelled locally"):
                self.write("notes.txt", "Cancelled replacement", expected)
        for worker in workers:
            worker.join(3)
            self.assertFalse(worker.is_alive())
        self.assertEqual(self.file.read_bytes(), before)
        self.assertFalse(list(self.root.glob(".writer-project-*")))
        self.assertFalse(self.project.state()["active"])

    def test_traversal_windows_aliases_git_metadata_and_private_state_are_denied(self):
        self.grant()
        outside = self.base / "outside.txt"
        outside.write_text("Private outside data")
        for path in ("../outside.txt", "/outside.txt", str(outside), "C:/outside.txt", "C:outside.txt", "\\\\server\\share", "..\\outside.txt", "sub/../notes.txt", "./notes.txt", "sub//notes.txt", ".git/config", ".GIT/config", "notes.txt:stream", "NUL.txt", "notes.txt ", "notes.txt."):
            with self.subTest(path=path):
                with self.assertRaises(ValueError):
                    self.read(path)
                with self.assertRaises(ValueError):
                    self.write(path, "Denied", None)
        self.assertEqual(outside.read_text(), "Private outside data")
        self.project.grant(str(self.base), "read_write")
        with self.assertRaises(ValueError):
            self.read("writer/" + CONFIG)
        with self.assertRaises(ValueError):
            self.write("writer/replacement.txt", "Denied", None)

    def test_office_formats_cannot_bypass_native_document_authority(self):
        self.grant()
        for extension in PROTECTED_EXTENSIONS:
            name = "manuscript" + extension.upper()
            with self.subTest(extension=extension):
                self.assertTrue(is_office_document(name))
                with self.assertRaisesRegex(ValueError, "native highlighted"):
                    self.write(name, "Not native document editing", None)
                self.assertFalse((self.root / name).exists())
        document = self.root / "existing.odt"
        document.write_bytes(b"PK\x00binary office data")
        with self.assertRaises(ValueError):
            self.write(document.name, "Must not corrupt", hashlib.sha256(document.read_bytes()).hexdigest())
        self.assertEqual(document.read_bytes(), b"PK\x00binary office data")

    def test_live_native_documents_are_protected_in_otherwise_editable_text_formats(self):
        self.grant()
        self.project.protect_documents([str(self.file)])
        self.assertTrue(self.project.is_protected(self.file))
        with self.assertRaisesRegex(ValueError, "native highlighted"):
            self.write("notes.txt", "Must use Writer permissions", self.read()["sha256"])
        self.project.protect_documents([])
        self.assertFalse(self.project.is_protected(self.file))
        self.write("notes.txt", "Released native document", self.read()["sha256"])
        self.assertEqual(self.file.read_text(), "Released native document")
        if os.name == "nt":
            self.project.protect_documents([str(self.file).upper()])
            self.assertTrue(self.project.is_protected(self.file))

    def test_replaced_project_root_cannot_inherit_a_grant(self):
        self.grant()
        moved = self.base / "original-project"
        self.root.rename(moved)
        self.root.mkdir()
        self.file.write_text("Unapproved replacement")
        with self.assertRaisesRegex(ValueError, "folder changed"):
            self.read()
        self.assertFalse(self.project.state()["active"])
        self.assertEqual(self.file.read_text(), "Unapproved replacement")

    @unittest.skipUnless(os.name == "nt", "Windows DOS aliases")
    def test_dos_aliases_cannot_bypass_native_documents_or_private_state(self):
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetShortPathNameW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
        kernel.GetShortPathNameW.restype = wintypes.DWORD

        def alias(path):
            buffer = ctypes.create_unicode_buffer(32768)
            self.assertTrue(kernel.GetShortPathNameW(str(path), buffer, len(buffer)))
            return Path(buffer.value)

        document = self.root / "native manuscript document.txt"
        document.write_text("Native Writer document")
        short_document = alias(document)
        if short_document.name == document.name:
            self.skipTest("This filesystem does not generate DOS short names.")
        self.grant()
        self.project.protect_documents([document])
        self.assertTrue(self.project.is_protected(short_document))
        with self.assertRaisesRegex(ValueError, "native highlighted"):
            self.write(short_document.name, "Denied", hashlib.sha256(document.read_bytes()).hexdigest())
        self.project.protect_documents([short_document])
        self.assertTrue(self.project.is_protected(document))
        office = self.root / "flat office manuscript document.fodt"
        office.write_text("Office XML text")
        with self.assertRaisesRegex(ValueError, "native highlighted"):
            self.write(alias(office).name, "Denied", hashlib.sha256(office.read_bytes()).hexdigest())
        private = self.base / "private Writer settings folder"
        access = ProjectAccess(private)
        access.grant(str(self.base), "read_write")
        short_private = alias(private)
        with self.assertRaises(ValueError):
            access.grant(str(short_private), "read")
        with self.assertRaises(ValueError):
            access.call("project_read_file", {"path": short_private.name + "/" + CONFIG})
        with self.assertRaises(ValueError):
            access.call("project_write_file", {"path": short_private.name + "/new.txt", "content": "Denied", "expectedSha256": None})
        self.assertEqual(document.read_text(), "Native Writer document")
        self.assertEqual(office.read_text(), "Office XML text")
        self.assertFalse((private / "new.txt").exists())

    def test_read_write_limits_are_full_text_bytes_and_binary_is_explicitly_rejected(self):
        self.grant()
        boundary = self.write("maximum.txt", "x" * MAX_TEXT, None)
        self.assertEqual(self.read("maximum.txt")["bytes"], MAX_TEXT)
        self.assertEqual(boundary["bytes"], MAX_TEXT)
        for content in ("x" * (MAX_TEXT + 1), "é" * (MAX_TEXT // 2 + 1), "binary\x00value"):
            with self.assertRaises(ValueError):
                self.write("invalid.txt", content, None)
        self.assertFalse((self.root / "invalid.txt").exists())
        for name, raw in (("oversize.txt", b"x" * (MAX_TEXT + 1)), ("binary.bin", b"a\x00b"), ("invalid.bin", b"\xff\xfe")):
            (self.root / name).write_bytes(raw)
            with self.assertRaises(ValueError):
                self.read(name)

    def test_bounded_pages_include_each_regular_entry_once_and_omit_git(self):
        self.grant()
        for index in range(405):
            (self.root / f"entry-{index:03}.txt").write_text(str(index))
        (self.root / ".git").mkdir()
        (self.root / ".git" / "config").write_text("Private Git metadata")
        names, offset = [], 0
        while True:
            page = self.project.call("project_list_directory", {"limit": 200, "offset": offset})
            self.assertLessEqual(len(page["entries"]), 200)
            self.assertEqual(page["omitted"], 1)
            names.extend(entry["name"] for entry in page["entries"])
            if page["nextOffset"] is None:
                break
            offset = page["nextOffset"]
        self.assertEqual(len(names), 406)
        self.assertEqual(len(set(names)), len(names))
        self.assertEqual(names, sorted(names, key=lambda name: (name.casefold(), name)))
        for arguments in ({"limit": 201}, {"limit": True}, {"offset": -1}, {"offset": True}):
            with self.assertRaises(ValueError):
                self.project.call("project_list_directory", arguments)

    def test_links_and_junctions_never_escape_approved_root(self):
        self.grant()
        outside = self.base / "outside"
        outside.mkdir()
        (outside / "secret.txt").write_text("Outside remains unchanged")
        link = self.root / "linked"
        if os.name == "nt":
            creation = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(outside)], capture_output=True, check=False)
            self.assertEqual(creation.returncode, 0, creation.stderr.decode(errors="replace"))
        else:
            link.symlink_to(outside, target_is_directory=True)
        try:
            with self.assertRaises(ValueError):
                self.read("linked/secret.txt")
            with self.assertRaises(ValueError):
                self.write("linked/new.txt", "Denied", None)
            with self.assertRaises((ValueError, OSError)):
                self.project.grant(str(link), "read")
            self.assertFalse(self.project.state()["active"])
            self.grant()
            listing = self.project.call("project_list_directory", {})
            self.assertNotIn("linked", [entry["name"] for entry in listing["entries"]])
        finally:
            link.rmdir() if os.name == "nt" else link.unlink()
        self.assertEqual((outside / "secret.txt").read_text(), "Outside remains unchanged")
        self.assertFalse((outside / "new.txt").exists())

    def test_hardlinked_files_and_external_config_changes_are_preserved(self):
        self.grant()
        alias = self.root / "hardlink.txt"
        os.link(self.file, alias)
        with self.assertRaises(ValueError):
            self.read("hardlink.txt")
        with self.assertRaises(ValueError):
            self.write("hardlink.txt", "Denied", None)
        alias.unlink()
        config = self.profile / CONFIG
        external = b'{"external":"preserve me"}'
        config.write_bytes(external)
        with self.assertRaises(ValueError):
            self.project.configure(str(self.root), "read")
        self.assertEqual(config.read_bytes(), external)
        self.assertEqual(self.file.read_text(), "A scientific note.\n")


if __name__ == "__main__":
    unittest.main()
