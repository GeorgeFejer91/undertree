"""Locally granted GitHub access for the selected ordinary-file project."""
import base64
import copy
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

from undertree_connection import _private_directory, _regular, _unique_fields
from undertree_project import is_office_document
from undertree_tunnel import _kill

MAX_OUTPUT = 2 * 1024 * 1024
MAX_FILES = 256
MAX_FILE_BYTES = 16 * 1024 * 1024
CONFIG = "github.json"


def _schema(properties, required=()):
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}


PATHS = {"type": "array", "items": {"type": "string", "maxLength": 1024}, "minItems": 1, "maxItems": MAX_FILES}
MESSAGE = {"type": "string", "minLength": 1, "maxLength": 2000}
TOOLS = [
    {"name": "github_status", "description": "Read Git status for the locally approved project and configured GitHub repository.", "inputSchema": _schema({})},
    {"name": "github_commit", "description": "Commit only explicit saved project-file paths, preserving unrelated work. This reads saved files without saving or editing Writer documents.", "inputSchema": _schema({"paths": PATHS, "message": MESSAGE}, ("paths", "message"))},
    {"name": "github_sync", "description": "Fetch the configured GitHub branch, fast-forward only, and push without force. Dirty or diverged work is preserved and requires local resolution.", "inputSchema": _schema({})},
    {"name": "github_create_repository", "description": "Create a new personal GitHub repository with explicit visibility, commit explicit ordinary files, and push. Requires no existing origin or configured repository.", "inputSchema": _schema({"name": {"type": "string", "maxLength": 100}, "private": {"type": "boolean"}, "description": {"type": "string", "maxLength": 500}, "paths": PATHS, "message": MESSAGE}, ("name", "private", "description", "paths", "message"))},
]


def _repository(value, empty=False):
    if empty and value == "":
        return value
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}", value) or value.split("/")[1] in (".", "..", ".git"):
        raise ValueError("Use a GitHub repository in owner/name form.")
    return value


def _branch(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_/-]{0,99}", value) or "//" in value or value.endswith("/"):
        raise ValueError("Use a branch name containing letters, digits, underscores, hyphens or single slashes.")
    return value


def _relative(value):
    if not isinstance(value, str) or not value or len(value) > 1024 or any(character in value for character in '\\:<>"|?*') or any(ord(character) < 32 for character in value):
        raise ValueError("Use explicit project-relative ordinary-file paths.")
    parts = value.split("/")
    if any(not part or part in (".", "..") or part.rstrip(" .") != part or part.split(".", 1)[0].upper() in {"CON", "PRN", "AUX", "NUL", *["COM" + str(index) for index in range(1, 10)], *["LPT" + str(index) for index in range(1, 10)]} for part in parts):
        raise ValueError("Use explicit project-relative ordinary-file paths.")
    if any(part.lower() in {".git", ".gitmodules", ".gitattributes"} for part in parts):
        raise ValueError("Git control files cannot be changed through GitHub project tools.")
    return value


def _plain(path, directory=False):
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or getattr(metadata, "st_file_attributes", 0) & 0x400 or not (stat.S_ISDIR(metadata.st_mode) if directory else stat.S_ISREG(metadata.st_mode)):
        raise ValueError("Linked or special Git/project paths are not permitted.")
    if not directory and metadata.st_nlink != 1:
        raise ValueError("Hard-linked Git/project files are not permitted.")
    return metadata


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def _stop_git(child):
    if child is not None and child.poll() is None and os.name == "nt":
        # LibreOffice Python and MinGit launchers can leave pipe-owning children behind.
        taskkill = Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32/taskkill.exe"
        try:
            subprocess.run([str(taskkill), "/PID", str(child.pid), "/T", "/F"], stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, shell=False, timeout=5,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        finally:
            _kill(child)
    else:
        _kill(child)


class GitHubAccess:
    """configure/clear/set_enabled are local UI operations, never remote tools."""
    def __init__(self, directory, project):
        self.directory = Path(directory).absolute() / "github"
        _private_directory(self.directory)
        self.project = project
        self._mutex = threading.RLock()
        self._cancel = threading.Event()
        self._cancel.set()
        self._busy = threading.Event()
        self._http_slots = threading.BoundedSemaphore(2)
        self._enabled_root = None
        self._enabled_generation = None
        self._raw = None
        self._config = None
        self._error = ""
        self._git = self._find_git()
        self._hooks = self.directory / "disabled-hooks"
        _private_directory(self._hooks)
        self._load()

    @staticmethod
    def _find_git():
        candidates = [Path(__file__).with_name("git-runtime") / "cmd" / "git.exe"]
        if os.environ.get("UNDERTREE_WRITER_GIT"):
            candidates.append(Path(os.environ["UNDERTREE_WRITER_GIT"]))
        if os.name == "nt":
            candidates.extend(Path(os.environ.get(name, "C:/Program Files")) / "Git" / "cmd" / "git.exe" for name in ("ProgramFiles", "ProgramFiles(x86)"))
            if os.environ.get("LOCALAPPDATA"):
                candidates.append(Path(os.environ["LOCALAPPDATA"]) / "Programs" / "Git" / "cmd" / "git.exe")
        found = shutil.which("git")
        if found:
            candidates.append(Path(found))
        return next((str(path.absolute()) for path in candidates if path.is_file()), None)

    @staticmethod
    def _validate_config(value):
        if not isinstance(value, dict) or set(value) != {"version", "token", "repository", "branch"} or type(value["version"]) is not int or value["version"] != 1:
            raise ValueError("Private GitHub configuration is invalid; existing data was preserved.")
        if not isinstance(value["token"], str) or not re.fullmatch(r"[A-Za-z0-9_]{20,255}", value["token"]):
            raise ValueError("Enter a GitHub personal access token locally.")
        _repository(value["repository"], empty=True)
        _branch(value["branch"])
        if value["token"] in value["repository"] or value["token"] in value["branch"]:
            raise ValueError("Private credentials cannot appear in repository or branch names.")
        return value

    def _read(self):
        path = self.directory / CONFIG
        before = _regular(path)
        if before.st_size > 4096:
            raise ValueError("Private GitHub configuration exceeds its limit.")
        with path.open("rb") as source:
            raw = source.read(4097)
            opened = os.fstat(source.fileno())
        after = _regular(path)
        if len(raw) > 4096 or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino) or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
            raise ValueError("Private GitHub configuration changed while reading.")
        return raw

    def _load(self):
        path = self.directory / CONFIG
        if not path.exists() and not path.is_symlink():
            return
        raw = self._read()
        try:
            value = self._validate_config(json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_fields))
        except (UnicodeError, json.JSONDecodeError, RecursionError):
            raise ValueError("Private GitHub configuration is invalid; existing data was preserved.") from None
        self._config, self._raw = value, raw

    def _save(self, value):
        path = self.directory / CONFIG
        if path.exists() or path.is_symlink():
            if self._read() != self._raw:
                raise ValueError("Private GitHub configuration changed externally; existing data was preserved.")
        elif self._raw is not None:
            raise ValueError("Private GitHub configuration disappeared; existing data was preserved.")
        raw = json.dumps(self._validate_config(value), sort_keys=True).encode("utf-8")
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.directory, delete=False) as output:
                temporary = Path(output.name)
                os.chmod(temporary, 0o600)
                output.write(raw)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
            temporary = None
            self._config, self._raw = dict(value), raw
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def configure(self, token, repository, branch="main"):
        self._cancel.set()
        with self._mutex:
            self._enabled_root = None
            self._enabled_generation = None
            self._save({"version": 1, "token": token, "repository": _repository(repository, empty=True), "branch": _branch(branch)})
            self._error = ""
            return self.state()

    def clear(self):
        self._cancel.set()
        with self._mutex:
            self._enabled_root = None
            self._enabled_generation = None
            path = self.directory / CONFIG
            if path.exists() or path.is_symlink():
                if self._read() != self._raw:
                    raise ValueError("Private GitHub configuration changed externally; existing data was preserved.")
                path.unlink()
            self._config = self._raw = None
            self._error = ""
            return self.state()

    def set_enabled(self, enabled):
        if type(enabled) is not bool:
            raise ValueError("GitHub access must be enabled locally.")
        self._cancel.set()
        with self._mutex:
            self._enabled_root = None
            self._enabled_generation = None
            if enabled:
                if not self._config:
                    raise ValueError("Configure GitHub locally before enabling access.")
                if not self._git:
                    raise ValueError("Git is unavailable. Install Git or use an add-on package containing Git.")
                with self.project.context(write=True) as root:
                    self._safe_root(root)
                    self._enabled_root = Path(root)
                    self._enabled_generation = self.project.grant_generation
                    self._cancel.clear()
            return self.state()

    def attach_repository(self):
        self._cancel.set()
        with self._mutex:
            self._enabled_root = self._enabled_generation = None
            if not self._config or not self._config["repository"]:
                raise ValueError("Save a GitHub owner/name locally before attaching the repository.")
            with self.project.context(write=True) as selected:
                self._cancel.clear()
                self._busy.set()
                try:
                    root = self._safe_root(selected)
                    if not self._repository_check(root, allow_missing=True):
                        self._run(root, ["init", "--template=", "--initial-branch=" + self._config["branch"]])
                    self._repository_check(root)
                    self._current_branch(root)
                    _, remotes = self._run(root, ["remote"])
                    if "origin" not in remotes.decode("utf-8").splitlines():
                        self._run(root, ["remote", "add", "origin", self._origin()])
                    self._repository_check(root)
                    self._error = ""
                finally:
                    self._cancel.set()
                    self._busy.clear()
            return self.state()

    def state(self):
        config = self._config
        project = self.project.state()
        enabled = bool(config and self._git and not self._cancel.is_set() and project["active"]
                       and project["mode"] == "read_write" and Path(project["path"]) == self._enabled_root
                       and self.project.grant_generation == self._enabled_generation)
        return {"configured": config is not None, "enabled": enabled,
                "repository": config["repository"] if config else "", "branch": config["branch"] if config else "main",
                "gitAvailable": bool(self._git), "error": self._error, "busy": self._busy.is_set()}

    status = state

    def tools(self):
        return copy.deepcopy(TOOLS) if self.state()["enabled"] else []

    def _safe_root(self, root):
        root = Path(root)
        _plain(root, directory=True)
        actual_root, private = root.resolve(), self.directory.parent.resolve()
        if actual_root == private or private.is_relative_to(actual_root) or actual_root.is_relative_to(private):
            raise ValueError("The Git project must exclude private Writer connection state.")
        return root

    def _environment(self, authenticated=False):
        environment = {key: value for key, value in os.environ.items() if not key.upper().startswith(("GIT_", "SSH_")) and not key.upper().endswith("_PROXY")}
        environment.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_SYSTEM": os.devnull,
                            "GIT_CONFIG_GLOBAL": os.devnull, "GIT_ATTR_NOSYSTEM": "1",
                            "GIT_TERMINAL_PROMPT": "0", "GIT_NO_REPLACE_OBJECTS": "1", "GIT_LITERAL_PATHSPECS": "1"})
        if authenticated:
            encoded = base64.b64encode(("x-access-token:" + self._config["token"]).encode("ascii")).decode("ascii")
            environment.update({"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader", "GIT_CONFIG_VALUE_0": "AUTHORIZATION: basic " + encoded})
        return environment

    def _check_cancel(self):
        if self._cancel.is_set() or self.project.cancel_event.is_set():
            raise ValueError("GitHub operation cancelled locally. Inspect local Git state and any in-flight remote creation before retrying.")

    def _run(self, root, arguments, authenticated=False, accepted=(0,), environment=None):
        self._check_cancel()
        if not self._git:
            raise ValueError("Git is unavailable. Install Git or use an add-on package containing Git.")
        config = ["core.hooksPath=" + str(self._hooks), "core.fsmonitor=false", "core.attributesFile=" + os.devnull,
                  "credential.helper=", "credential.interactive=false", "core.askPass=", "protocol.allow=never",
                  "protocol.https.allow=always", "http.followRedirects=false", "http.sslVerify=true", "http.proxy=",
                  "submodule.recurse=false", "fetch.recurseSubmodules=false", "push.recurseSubmodules=no",
                  "commit.gpgSign=false", "tag.gpgSign=false", "gc.auto=0", "maintenance.auto=false"]
        command = [self._git, "--no-pager"] + [part for setting in config for part in ("-c", setting)] + list(arguments)
        actual_environment = self._environment(authenticated)
        actual_environment.update(environment or {})
        child = None
        output = {}
        readers = []
        overflow = threading.Event()
        stopped = threading.Event()
        try:
            child = subprocess.Popen(command, cwd=str(root), env=actual_environment, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False,
                                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            def read(name, stream):
                try:
                    raw = stream.read(MAX_OUTPUT + 1)
                    output[name] = raw
                    if len(raw) > MAX_OUTPUT:
                        overflow.set()
                        stopped.wait(10)
                except OSError:
                    pass
                finally:
                    stream.close()
            for name, stream in (("stdout", child.stdout), ("stderr", child.stderr)):
                reader = threading.Thread(target=read, args=(name, stream), daemon=True)
                readers.append(reader)
                reader.start()
            timeout = 90 if authenticated else 30
            deadline = time.monotonic() + timeout
            while child.poll() is None:
                self._check_cancel()
                if overflow.wait(.02):
                    _stop_git(child)
                    stopped.set()
                    raise ValueError("Git output exceeds the supported project limit; inspect this repository locally.")
                if time.monotonic() >= deadline:
                    raise subprocess.TimeoutExpired(command, timeout)
            stopped.set()
            for reader in readers:
                reader.join(2)
            if any(reader.is_alive() for reader in readers) or set(output) != {"stdout", "stderr"}:
                raise ValueError("Git output could not be verified; inspect this repository locally.")
            if any(len(raw) > MAX_OUTPUT for raw in output.values()):
                raise ValueError("Git output exceeds the supported project limit; inspect this repository locally.")
            if child.returncode not in accepted:
                raise ValueError("Git refused the operation. Existing work was preserved; check authentication, branch state and local conflicts before retrying.")
            return child.returncode, output["stdout"]
        except (OSError, subprocess.TimeoutExpired):
            raise ValueError("Git could not finish. Existing local work was preserved; inspect the repository locally before retrying.") from None
        finally:
            try:
                _stop_git(child)
            finally:
                stopped.set()
                for reader in readers:
                    reader.join(2)

    def _repository_check(self, root, allow_missing=False):
        git_directory = root / ".git"
        if not git_directory.exists() and not git_directory.is_symlink():
            if allow_missing:
                return False
            raise ValueError("The chosen folder is not a Git repository. Create a repository explicitly first.")
        _plain(git_directory, directory=True)
        for path in (git_directory / "commondir", git_directory / "gitdir", git_directory / "worktrees", git_directory / "modules", git_directory / "objects/info/alternates", git_directory / "objects/info/http-alternates", git_directory / "info/attributes", git_directory / "info/grafts", git_directory / "refs/replace"):
            if path.exists() or path.is_symlink():
                raise ValueError("Git worktree indirections, alternate objects, attributes, replacements and submodules are not supported.")
        count = 0
        for directory, names, files in os.walk(git_directory, followlinks=False):
            self._check_cancel()
            for name in names:
                _plain(Path(directory) / name, directory=True)
            for name in files:
                _plain(Path(directory) / name)
                count += 1
                if count > 20000:
                    raise ValueError("Git metadata exceeds the supported project limit.")
        config_path = git_directory / "config"
        if _plain(config_path).st_size > 65536:
            raise ValueError("Git configuration exceeds the supported limit.")
        _, output = self._run(root, ["config", "--file", str(config_path), "--no-includes", "--null", "--list"])
        seen = set()
        for entry in output.split(b"\0"):
            if not entry:
                continue
            key, separator, value = entry.partition(b"\n")
            try:
                key, value = key.decode("ascii").lower(), value.decode("utf-8")
            except UnicodeError:
                raise ValueError("Git configuration contains unsupported text.") from None
            if not separator or key in seen:
                raise ValueError("Duplicate or valueless Git settings are not supported.")
            seen.add(key)
            allowed = key in {"core.filemode", "core.logallrefupdates", "core.ignorecase", "core.symlinks", "core.precomposeunicode"} and value.lower() in {"true", "false"}
            allowed |= key == "core.repositoryformatversion" and value == "0"
            allowed |= key == "core.bare" and value.lower() == "false"
            allowed |= key in {"user.name", "user.email"} and bool(value.strip()) and len(value) <= 200 and not any(ord(character) < 32 for character in value)
            allowed |= key == "remote.origin.url" and bool(self._config["repository"]) and value == self._origin()
            allowed |= key == "remote.origin.fetch" and value == "+refs/heads/*:refs/remotes/origin/*"
            allowed |= bool(re.fullmatch(r"branch\.[a-z0-9_/-]+\.remote", key)) and value == "origin"
            allowed |= bool(re.fullmatch(r"branch\.[a-z0-9_/-]+\.merge", key)) and value.startswith("refs/heads/") and bool(_branch(value[11:]))
            if not allowed:
                raise ValueError("Unsupported Git configuration was preserved. Remove custom helpers, includes, hooks, filters and transport settings locally before granting GitHub access.")
        _, actual = self._run(root, ["rev-parse", "--show-toplevel"])
        if Path(os.fsdecode(actual.rstrip(b"\r\n"))).resolve() != root.resolve():
            raise ValueError("Git repository root does not match the chosen folder.")
        for marker in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG", "index.lock", "shallow"):
            if (git_directory / marker).exists():
                raise ValueError("Finish the existing Git operation locally before using GitHub tools.")
        return True

    def _origin(self):
        return "https://github.com/" + self._config["repository"] + ".git"

    def _current_branch(self, root):
        _, output = self._run(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])
        if output.decode("utf-8").strip() != self._config["branch"]:
            raise ValueError("The checked-out branch must match the branch configured locally.")

    def _head(self, root):
        code, output = self._run(root, ["rev-parse", "--verify", "HEAD"], accepted=(0, 128))
        return output.decode("ascii").strip() if code == 0 else None

    def _check_checkout(self, root):
        _, output = self._run(root, ["diff", "--raw", "--no-abbrev", "--no-renames", "-z", "HEAD", "FETCH_HEAD"])
        entries = output.split(b"\0")
        index = 0
        while index < len(entries):
            header = entries[index].strip(b"\n")
            index += 1
            if not header:
                continue
            parts = header.split()
            if len(parts) != 5 or not parts[0].startswith(b":") or index >= len(entries):
                raise ValueError("Incoming Git paths could not be inspected safely.")
            if parts[1] in (b"120000", b"160000"):
                raise ValueError("Incoming Git links or submodules cannot be checked out through Writer.")
            try:
                path = _relative(entries[index].decode("utf-8"))
            except UnicodeError:
                raise ValueError("Incoming Git paths contain unsupported text.") from None
            if is_office_document(root / path) or self.project.is_protected(root / path):
                raise ValueError("Incoming Git changes would alter an Office or open Writer document. Resolve this update locally through its native document controls.")
            index += 1

    def _paths(self, root, paths):
        if not isinstance(paths, list) or not 1 <= len(paths) <= MAX_FILES or any(not isinstance(value, str) for value in paths) or len(set(paths)) != len(paths):
            raise ValueError("Choose between 1 and 256 distinct ordinary-file paths explicitly.")
        for value in paths:
            _relative(value)
            if self._config["token"] in value:
                raise ValueError("Private credentials cannot appear in published paths.")
            path = root
            for component in value.split("/")[:-1]:
                path /= component
                _plain(path, directory=True)
                if (path / ".git").exists() or (path / ".git").is_symlink():
                    raise ValueError("Nested Git repositories cannot be committed through this project.")
                if (path / ".gitattributes").exists():
                    raise ValueError("Git attribute files are not supported for publication.")
            path = root / value
            if path.exists() or path.is_symlink():
                if _plain(path).st_size > MAX_FILE_BYTES:
                    raise ValueError("Selected file exceeds the 16 MiB publication limit.")
                canonical = path.resolve().relative_to(root.resolve()).as_posix()
                _relative(canonical)
                if canonical.casefold() != value.casefold():
                    raise ValueError("Use the complete selected file name instead of a filesystem short-name alias.")
                with path.open("rb") as source:
                    if self._config["token"].encode("ascii") in source.read(MAX_FILE_BYTES + 1):
                        raise ValueError("A selected file contains the private GitHub credential and cannot be published.")
            else:
                self._run(root, ["ls-files", "--error-unmatch", "--", value])
        if (root / ".gitattributes").exists() or (root / ".gitattributes").is_symlink():
            raise ValueError("Git attribute files are not supported for publication.")
        return paths

    def _commit(self, root, paths, message, allow_unchanged=False):
        if not isinstance(message, str) or not message.strip() or len(message) > 2000 or "\0" in message or self._config["token"] in message:
            raise ValueError("Use a nonempty commit message of at most 2,000 characters.")
        self._current_branch(root)
        self._paths(root, paths)
        lock = root / ".git/index.lock"
        descriptor = os.open(str(lock), os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        os.close(descriptor)
        try:
            return self._commit_index(root, paths, message, lock, allow_unchanged)
        finally:
            lock.unlink(missing_ok=True)

    def _commit_index(self, root, paths, message, lock, allow_unchanged):
        code, _ = self._run(root, ["diff", "--cached", "--quiet", "--exit-code"], accepted=(0, 1))
        if code:
            raise ValueError("Existing staged changes were preserved. Commit or unstage them locally before this action.")
        head = self._head(root)
        with tempfile.TemporaryDirectory(dir=self.directory, prefix="index-") as temporary:
            index = str(Path(temporary) / "index")
            environment = {"GIT_INDEX_FILE": index}
            if head:
                self._run(root, ["read-tree", "HEAD"], environment=environment)
            else:
                self._run(root, ["read-tree", "--empty"], environment=environment)
            self._run(root, ["add", "--", *paths], environment=environment)
            code, _ = self._run(root, ["diff", "--cached", "--quiet", "--exit-code"], accepted=(0, 1), environment=environment)
            if code == 0:
                if allow_unchanged and head:
                    return {"commit": head, "paths": list(paths), "unchanged": True}
                raise ValueError("The selected paths contain no changes to commit.")
            _, tree = self._run(root, ["write-tree"], environment=environment)
            arguments = ["-c", "user.name=Writer project", "-c", "user.email=writer-project@localhost", "commit-tree", tree.decode("ascii").strip(), "-m", message]
            if head:
                arguments.extend(["-p", head])
            _, commit = self._run(root, arguments)
            commit = commit.decode("ascii").strip()
            with open(index, "rb") as prepared:
                index_bytes = prepared.read(MAX_OUTPUT + 1)
            if len(index_bytes) > MAX_OUTPUT:
                raise ValueError("The Git index exceeds the supported publication limit.")
            with os.fdopen(os.open(str(lock), os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)), "wb") as destination:
                destination.write(index_bytes)
                destination.flush()
                os.fsync(destination.fileno())
            if self._head(root) != head:
                raise ValueError("The branch changed while preparing the commit. No branch update was applied.")
            self._run(root, ["update-ref", "refs/heads/" + self._config["branch"], commit, head or "0" * 40])
            os.replace(lock, root / ".git/index")
        return {"commit": commit, "paths": list(paths)}

    def _sync(self, root):
        self._current_branch(root)
        if not self._config["repository"]:
            raise ValueError("Configure an existing GitHub repository locally first.")
        _, origin = self._run(root, ["remote", "get-url", "origin"])
        if origin.decode("utf-8").strip() != self._origin():
            raise ValueError("The origin must match the repository configured locally.")
        _, status = self._run(root, ["status", "--porcelain=v1", "--untracked-files=normal", "-z"])
        if status:
            raise ValueError("Save and commit or resolve all local changes before synchronizing. No local changes were discarded.")
        if not self._head(root):
            raise ValueError("Create a local commit before synchronizing this branch.")
        branch = self._config["branch"]
        self._run(root, ["fetch", "--no-tags", "--no-recurse-submodules", "origin", "refs/heads/" + branch], authenticated=True)
        remote_is_ancestor, _ = self._run(root, ["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"], accepted=(0, 1))
        if remote_is_ancestor:
            local_is_ancestor, _ = self._run(root, ["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"], accepted=(0, 1))
            if local_is_ancestor:
                raise ValueError("Local and GitHub branches diverged. Existing work was preserved; resolve the branches locally.")
            self._check_checkout(root)
        self._run(root, ["merge", "--ff-only", "--no-edit", "FETCH_HEAD"])
        self._run(root, ["push", "--no-follow-tags", "--recurse-submodules=no", "origin", "HEAD:refs/heads/" + branch], authenticated=True)
        return {"repository": self._config["repository"], "branch": branch, "commit": self._head(root), "synchronized": True}

    def _api(self, method, route, payload=None):
        self._check_cancel()
        if route not in ("/user", "/user/repos") or method not in ("GET", "POST"):
            raise ValueError("Unsupported GitHub API operation.")
        headers = {"Authorization": "Bearer " + self._config["token"], "Accept": "application/vnd.github+json", "User-Agent": "wrAIter-project", "X-GitHub-Api-Version": "2022-11-28"}
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request("https://api.github.com" + route, data=data, headers=headers, method=method)
        if not self._http_slots.acquire(blocking=False):
            raise ValueError("A cancelled GitHub connection is still finishing. Inspect the account before starting another request.")
        finished = threading.Event()
        request_cancelled = threading.Event()
        result = {}
        def request_json():
            try:
                self._check_cancel()
                if request_cancelled.is_set():
                    raise ValueError("Cancelled GitHub request")
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
                if request_cancelled.is_set():
                    raise ValueError("Cancelled GitHub request")
                with opener.open(request, timeout=30) as response:
                    result["response"] = response
                    if request_cancelled.is_set():
                        raise ValueError("Cancelled GitHub request")
                    raw = response.read(1024 * 1024 + 1)
                if len(raw) > 1024 * 1024:
                    result["error"] = "GitHub response exceeds the supported limit."
                else:
                    result["value"] = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_fields)
            except urllib.error.HTTPError as error:
                result["error"] = "GitHub API refused the request (HTTP " + str(error.code) + "). Check token permissions and repository ownership locally."
                error.close()
            except Exception:
                result["error"] = "GitHub API could not finish. A creation request may already have succeeded; inspect the account before retrying."
            finally:
                finished.set()
                self._http_slots.release()
        threading.Thread(target=request_json, name="wrAIter GitHub request", daemon=True).start()
        deadline = time.monotonic() + 35
        try:
            while not finished.wait(.02):
                self._check_cancel()
                if time.monotonic() >= deadline:
                    raise ValueError("GitHub API timed out. Creation may already have succeeded; inspect the account before retrying.")
            self._check_cancel()
            if "error" in result:
                raise ValueError(result["error"])
            return result["value"]
        finally:
            if not finished.is_set():
                request_cancelled.set()
                try:
                    result["response"].fp.raw._sock.shutdown(socket.SHUT_RDWR)
                except (KeyError, AttributeError, OSError):
                    pass

    def _create(self, root, arguments):
        name, private, description = arguments["name"], arguments["private"], arguments["description"]
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", name) or name in (".", "..", ".git") or type(private) is not bool or not isinstance(description, str) or len(description) > 500 or any(ord(character) < 32 for character in description):
            raise ValueError("Choose a repository name, explicit private/public visibility and a short description.")
        if self._config["token"] in name or self._config["token"] in description:
            raise ValueError("Private credentials cannot appear in repository names or descriptions.")
        if self._config["repository"]:
            raise ValueError("Clear the configured repository locally before explicitly creating a new one.")
        exists = self._repository_check(root, allow_missing=True)
        if exists:
            self._current_branch(root)
            _, remotes = self._run(root, ["remote"])
            if remotes.strip():
                raise ValueError("Existing remotes were preserved. Repository creation requires a project without remotes.")
        self._paths(root, arguments["paths"])
        if not isinstance(arguments["message"], str) or not arguments["message"].strip() or len(arguments["message"]) > 2000 or "\0" in arguments["message"]:
            raise ValueError("Use a nonempty commit message of at most 2,000 characters.")
        user = self._api("GET", "/user")
        login = user.get("login") if isinstance(user, dict) else None
        if not isinstance(login, str):
            raise ValueError("GitHub did not return an authenticated personal account.")
        repository = _repository(login + "/" + name)
        if not exists:
            self._run(root, ["init", "--template=", "--initial-branch=" + self._config["branch"]])
        commit = self._commit(root, arguments["paths"], arguments["message"], allow_unchanged=True)
        result = self._api("POST", "/user/repos", {"name": name, "private": private, "description": description, "auto_init": False})
        if not isinstance(result, dict) or result.get("full_name") != repository or result.get("private") is not private:
            raise ValueError("GitHub creation response was unexpected. The local commit was preserved; inspect the account before retrying.")
        updated = dict(self._config, repository=repository)
        self._save(updated)
        self._run(root, ["remote", "add", "origin", self._origin()])
        self._repository_check(root)
        self._run(root, ["push", "--no-follow-tags", "--recurse-submodules=no", "origin", "HEAD:refs/heads/" + self._config["branch"]], authenticated=True)
        return dict(commit, repository=repository, private=private, created=True, pushed=True)

    def call(self, name, arguments):
        with self._mutex:
            schema = next((tool["inputSchema"] for tool in TOOLS if tool["name"] == name), None)
            if schema is None or not isinstance(arguments, dict) or set(arguments) - set(schema["properties"]) or set(schema["required"]) - set(arguments):
                raise ValueError("Unsupported GitHub tool or arguments.")
            with self.project.context(write=True) as selected:
                root = self._safe_root(selected)
                if not self._config or root != self._enabled_root or self._enabled_generation != self.project.grant_generation:
                    raise ValueError("GitHub writes require an explicit local grant for this exact chosen folder.")
                self._busy.set()
                try:
                    if name == "github_create_repository":
                        result = self._create(root, arguments)
                    elif not self._repository_check(root, allow_missing=name == "github_status"):
                        result = {"initialized": False, "repository": self._config["repository"], "branch": self._config["branch"]}
                    elif name == "github_status":
                        _, output = self._run(root, ["status", "--porcelain=v1", "--untracked-files=normal", "-z"])
                        result = {"initialized": True, "repository": self._config["repository"], "branch": self._config["branch"], "status": output.decode("utf-8", "replace").replace("\0", "\n")}
                    elif name == "github_commit":
                        result = self._commit(root, arguments["paths"], arguments["message"])
                    else:
                        result = self._sync(root)
                    self._error = ""
                    return json.loads(json.dumps(result).replace(self._config["token"], "[private credential]"))
                except ValueError as error:
                    self._error = str(error).replace(self._config["token"], "[private credential]")
                    raise ValueError(self._error) from None
                except OSError:
                    self._error = "Local Git state could not be updated. Existing files and commits were preserved; inspect the repository locally before retrying."
                    raise ValueError(self._error) from None
                finally:
                    self._busy.clear()
