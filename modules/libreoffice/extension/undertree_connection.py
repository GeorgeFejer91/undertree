"""Private Writer-profile connection identity; native session callbacks own documents."""
import json
import os
from pathlib import Path
import secrets
import socket
import stat
import tempfile
import threading
import uuid

from undertree_mcp import Endpoint

MAX_CONFIG = 4096
MAX_SESSIONS = 20
CONFIG = "connection.json"


def _regular(path, directory=False):
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or getattr(metadata, "st_file_attributes", 0) & 0x400:
        raise ValueError("Linked Writer connection state is not permitted.")
    if not (stat.S_ISDIR(metadata.st_mode) if directory else stat.S_ISREG(metadata.st_mode)):
        raise ValueError("Writer connection state has an invalid file type.")
    if not directory and metadata.st_nlink != 1:
        raise ValueError("Linked Writer connection state is not permitted.")
    if os.name != "nt" and (metadata.st_uid != os.getuid() or metadata.st_mode & 0o077):
        raise ValueError("Writer connection state must be private to its owner.")
    return metadata


def _private_directory(path):
    if not path.exists():
        path.mkdir(mode=0o700, parents=False)
    _regular(path, directory=True)
    if os.name == "nt":
        # A protected owner/SYSTEM DACL prevents a profile capability inheriting broad grants.
        import ctypes
        from ctypes import wintypes
        api = ctypes.WinDLL("advapi32", use_last_error=True)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        descriptor = ctypes.c_void_p()
        api.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
        api.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = wintypes.BOOL
        api.GetSecurityDescriptorDacl.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.BOOL), ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.BOOL)]
        api.GetSecurityDescriptorDacl.restype = wintypes.BOOL
        api.SetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
        api.SetNamedSecurityInfoW.restype = wintypes.DWORD
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        kernel.LocalFree.restype = ctypes.c_void_p
        if not api.ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)", 1, ctypes.byref(descriptor), None):
            raise ValueError("Writer connection state permissions could not be secured.")
        try:
            present, defaulted, acl = wintypes.BOOL(), wintypes.BOOL(), ctypes.c_void_p()
            if not api.GetSecurityDescriptorDacl(descriptor, ctypes.byref(present), ctypes.byref(acl), ctypes.byref(defaulted)) or not present.value:
                raise ValueError("Writer connection state permissions could not be secured.")
            if api.SetNamedSecurityInfoW(str(path), 1, 4 | 0x80000000, None, None, acl, None):
                raise ValueError("Writer connection state permissions could not be secured.")
        finally:
            kernel.LocalFree(descriptor)


def _validate(value):
    if not isinstance(value, dict) or set(value) != {"version", "port", "token", "autoReconnect", "writerOwnerId"}:
        raise ValueError("Writer connection configuration is invalid; existing data was preserved.")
    token, port = value["token"], value["port"]
    if type(value["version"]) is not int or value["version"] != 1 or type(value["autoReconnect"]) is not bool or type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("Writer connection configuration is invalid; existing data was preserved.")
    if not isinstance(token, str) or not 32 <= len(token) <= 128 or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in token):
        raise ValueError("Writer connection configuration is invalid; existing data was preserved.")
    owner = value["writerOwnerId"]
    try:
        if not isinstance(owner, str) or str(uuid.UUID(owner)) != owner or uuid.UUID(owner).int == 0:
            raise ValueError()
    except (ValueError, AttributeError):
        raise ValueError("Writer connection owner identity is invalid; existing data was preserved.") from None
    return value


def _unique_fields(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Writer connection configuration has duplicate fields; existing data was preserved.")
        value[key] = item
    return value


class ConnectionManager:
    """Create once per LibreOffice process, with a dedicated private profile directory.

    Call ensure/start/detach/stop/close on the native UI thread. dispatch callbacks must
    queue to native authority, rechecking session consent and epochs when executed.
    Session detach/Stop callers must revoke native session authority before returning.
    """
    def __init__(self, config_dir):
        self.directory = Path(config_dir).absolute()
        _private_directory(self.directory)
        self._mutex = threading.RLock()
        self._sessions = {}
        self._endpoint = None
        self._closed = False
        self._error = ""
        self._peers = None
        self.project = self.github = None
        self._document_paths = {}
        self._lock = None
        self._saved_raw = None
        try:
            self._acquire()
            path = self.directory / CONFIG
            if path.exists() or path.is_symlink():
                before = _regular(path)
                if before.st_size > MAX_CONFIG:
                    raise ValueError("Writer connection configuration exceeds its limit; existing data was preserved.")
                with path.open("rb") as source:
                    raw = source.read(MAX_CONFIG + 1)
                    opened = os.fstat(source.fileno())
                after = _regular(path)
                if len(raw) > MAX_CONFIG or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino) or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
                    raise ValueError("Writer connection configuration changed while reading; existing data was preserved.")
                try:
                    self._config = _validate(json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_fields))
                except (UnicodeError, json.JSONDecodeError, RecursionError):
                    raise ValueError("Writer connection configuration is invalid; existing data was preserved.") from None
                self._saved_raw = raw
            else:
                with socket.socket() as probe:
                    probe.bind(("127.0.0.1", 0))
                    port = probe.getsockname()[1]
                self._config = {"version": 1, "port": port, "token": secrets.token_urlsafe(32), "autoReconnect": True, "writerOwnerId": str(uuid.uuid4())}
                self._save(self._config)
        except Exception:
            self._release()
            raise

    def _acquire(self):
        path = self.directory / "connection.lock"
        if path.exists() or path.is_symlink():
            _regular(path)
        descriptor = os.open(str(path), os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        self._lock = os.fdopen(descriptor, "r+b", buffering=0)
        _regular(path)
        if self._lock.seek(0, 2) == 0:
            self._lock.write(b"0")
        self._lock.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self._lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self._lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise ValueError("Another LibreOffice process owns this Writer connection.") from None

    def _release(self):
        if self._lock is not None:
            self._lock.close()
            self._lock = None

    def _save(self, value):
        raw = json.dumps(_validate(value), sort_keys=True).encode("utf-8")
        if len(raw) > MAX_CONFIG:
            raise ValueError("Writer connection configuration exceeds its limit.")
        target = self.directory / CONFIG
        if target.exists() or target.is_symlink():
            _regular(target)
            with target.open("rb") as current:
                if current.read(MAX_CONFIG + 1) != self._saved_raw:
                    raise ValueError("Writer connection configuration changed externally; existing data was preserved.")
        elif self._saved_raw is not None:
            raise ValueError("Writer connection configuration disappeared; existing state was preserved.")
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.directory, delete=False) as output:
                temporary = Path(output.name)
                os.chmod(temporary, 0o600)
                output.write(raw)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, target)
            temporary = None
            self._saved_raw = raw
            if os.name != "nt":
                descriptor = os.open(str(self.directory), os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def _open(self):
        if self._closed:
            raise ValueError("Writer connection manager is closed.")

    def ensure(self, session, dispatch):
        """Attach a session without sharing it; honor the persisted desired state."""
        with self._mutex:
            self._open()
            document_id = session.document_id
            if not isinstance(document_id, str) or not document_id or len(document_id) > 128 or not callable(dispatch):
                raise ValueError("Invalid Writer connection session.")
            previous = self._sessions.get(document_id)
            if previous is not None and previous[0] is not session:
                raise ValueError("This Writer document identity is already attached.")
            if not self._config["autoReconnect"]:
                self._sessions.pop(document_id, None)
                return None
            if previous is None and len(self._sessions) >= MAX_SESSIONS:
                raise ValueError("At most 20 Writer documents may attach to this connection.")
            # Restarting the same native session captures a new endpoint epoch.
            self._sessions[document_id] = (session, dispatch)
            if self._endpoint is None:
                try:
                    self._endpoint = Endpoint(self._dispatch, token=self._config["token"], port=self._config["port"], owner_id=self._config["writerOwnerId"])
                    if self._peers is not None:
                        self._endpoint.set_extra_handlers(self._peers.tools, self._peers.call)
                    if self.project is not None:
                        self._endpoint.set_project_handlers(self._project_tools, self._project_call)
                    self._error = ""
                except OSError:
                    self._error = "The saved Writer MCP port is unavailable. Its address was preserved; close the conflicting listener and retry."
                    raise ValueError(self._error) from None
            return self._endpoint

    def start(self, session, dispatch):
        with self._mutex:
            self._open()
            desired = dict(self._config, autoReconnect=True)
            self._save(desired)
            self._config = desired
            return self.ensure(session, dispatch)

    def detach(self, session):
        """Native caller revokes this session first; document close preserves connection intent."""
        with self._mutex:
            entry = self._sessions.get(session.document_id)
            if entry is not None and entry[0] is session:
                del self._sessions[session.document_id]

    def _dispatch(self, name, arguments):
        with self._mutex:
            self._open()
            endpoint = self._endpoint
            if endpoint is None or not endpoint.active:
                raise ValueError("Writer MCP access was stopped.")
            if not isinstance(arguments, dict):
                raise ValueError("Tool arguments must be an object.")
            if name == "list_manuscripts":
                if arguments:
                    raise ValueError("This tool takes no arguments.")
                entries = list(self._sessions.items())
            elif name in ("read_manuscript", "suggest_text"):
                document_id = arguments.get("documentId")
                if not isinstance(document_id, str) or len(document_id) > 128 or document_id not in self._sessions:
                    raise ValueError("Only an attached, explicitly shared Writer document is available.")
                entries = [(document_id, self._sessions[document_id])]
            else:
                raise ValueError("Unknown tool.")
        manuscripts = []
        for document_id, entry in entries:
            result = entry[1](name, arguments)  # Queues to UNO; never inspect native document objects here.
            with self._mutex:
                if self._closed or self._endpoint is not endpoint or not endpoint.active or self._sessions.get(document_id) is not entry:
                    raise ValueError("Writer connection or document access changed during this request.")
            if name != "list_manuscripts":
                return result
            if not isinstance(result, dict) or not isinstance(result.get("manuscripts"), list) or len(result["manuscripts"]) > 1:
                raise ValueError("Writer returned an invalid document listing.")
            for row in result["manuscripts"]:
                if not isinstance(row, dict) or row.get("documentId") != document_id:
                    raise ValueError("Writer returned an invalid document identity.")
                manuscripts.append({"documentId": document_id, "name": "Shared Writer document", "scope": "complete current document context; highlighted main-body changes only"})
        return {"manuscripts": manuscripts}

    def _stop_endpoint(self):
        endpoint, self._endpoint = self._endpoint, None
        if endpoint is not None:
            endpoint.close()
            if not endpoint.wait_closed(2):
                self._error = "Writer MCP shutdown is still pending. Restart LibreOffice before reconnecting."
                raise ValueError(self._error)

    def stop(self):
        """UI Stop persists intent; native caller also revokes sharing and read receipts."""
        with self._mutex:
            self._open()
            if self.project is not None:
                self.project.revoke()
            if self.github is not None:
                self.github.set_enabled(False)
            desired = dict(self._config, autoReconnect=False)
            try:
                self._save(desired)
                self._config = desired
            finally:
                self._sessions.clear()
                self._stop_endpoint()

    def set_auto_reconnect(self, enabled):
        """Change startup intent only; current connection and consent remain untouched."""
        if type(enabled) is not bool:
            raise ValueError("Reconnect preference must be a checkbox value.")
        with self._mutex:
            self._open()
            desired = dict(self._config, autoReconnect=enabled)
            self._save(desired)
            self._config = desired

    def set_public_host(self, host):
        """Trusted tunnel supervisor only; cleared before terminating its own share."""
        with self._mutex:
            if self._endpoint is not None:
                self._endpoint.set_public_host(host)

    def set_peers(self, peers):
        """Locally configured frozen peer aliases; no remote registration operation."""
        with self._mutex:
            self._open()
            if peers is not None and (not callable(getattr(peers, "tools", None)) or not callable(getattr(peers, "call", None))):
                raise ValueError("Invalid locally paired Writer connections.")
            self._peers = peers
            if self._endpoint is not None:
                self._endpoint.set_extra_handlers(peers.tools if peers else None, peers.call if peers else None)

    def extra_catalogue(self):
        with self._mutex:
            return self._endpoint.extra_catalogue() + self._endpoint.project_catalogue() if self._endpoint else []

    def set_project_access(self, project, github):
        with self._mutex:
            self._open()
            self.project, self.github = project, github
            project.protect_documents(self._document_paths.values())
            if self._endpoint is not None:
                self._endpoint.set_project_handlers(self._project_tools, self._project_call)

    def protect_document(self, document_id, path):
        with self._mutex:
            if path:
                self._document_paths[document_id] = path
            else:
                self._document_paths.pop(document_id, None)
            if self.project is not None:
                self.project.protect_documents(self._document_paths.values())

    def _project_tools(self):
        return self.project.tools() + (self.github.tools() if self.github is not None else [])

    def _project_call(self, name, arguments):
        with self._mutex:
            self._open()
            endpoint = self._endpoint
            if endpoint is None or not endpoint.active:
                raise ValueError("Writer MCP access was stopped.")
            project, github = self.project, self.github
        if not isinstance(arguments, dict):
            raise ValueError("Tool arguments must be an object.")
        if name.startswith("project_"):
            result = project.call(name, arguments)
        elif name.startswith("github_") and github is not None:
            result = github.call(name, arguments)
        else:
            raise ValueError("Unknown project tool.")
        with self._mutex:
            if self._closed or self._endpoint is not endpoint or not endpoint.active:
                raise ValueError("Writer project access changed during this request.")
        return result

    def status(self):
        with self._mutex:
            return {"running": self._endpoint is not None and self._endpoint.active, "autoReconnect": self._config["autoReconnect"],
                    "url": "http://127.0.0.1:%d/mcp/%s" % (self._config["port"], self._config["token"]), "writerOwnerId": self._config["writerOwnerId"], "error": self._error}

    def close(self):
        """Process teardown closes transport and releases the lease without disabling startup."""
        with self._mutex:
            if self._closed:
                return
            self._closed = True
            try:
                if self.project is not None:
                    self.project.revoke()
                if self.github is not None:
                    self.github.set_enabled(False)
                self._stop_endpoint()
            finally:
                self._release()
