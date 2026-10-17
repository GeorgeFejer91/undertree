"""Explicit, session-only project access; Writer document edits retain UNO authority."""
from contextlib import contextmanager
import copy
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import re
import stat
import tempfile
import threading
import uuid

from undertree_connection import _private_directory, _regular, _unique_fields

MAX_TEXT = 256 * 1024
MAX_ENTRIES = 20000
CONFIG = "project.json"
PROTECTED_EXTENSIONS = frozenset((
    ".odt", ".ott", ".fodt", ".odm", ".oth", ".sxw", ".stw", ".doc", ".docx", ".docm",
    ".dot", ".dotx", ".dotm", ".rtf", ".wps", ".wpt", ".ods", ".ots", ".fods", ".sxc",
    ".stc", ".xls", ".xlsx", ".xlsm", ".xlsb", ".xlt", ".xltx", ".xltm", ".odp", ".otp",
    ".fodp", ".sxi", ".sti", ".ppt", ".pptx", ".pptm", ".pot", ".potx", ".potm", ".pps",
    ".ppsx", ".ppsm", ".odg", ".otg", ".fodg", ".sxd", ".std", ".odb", ".odf", ".sxm", ".pdf",
))


def is_office_document(path):
    return Path(path).suffix.lower() in PROTECTED_EXTENSIONS


def _path_key(path):
    value = os.path.abspath(os.fspath(path))
    if os.name == "nt":
        if value.startswith("\\\\?\\UNC\\"):
            value = "\\\\" + value[8:]
        elif value.startswith("\\\\?\\"):
            value = value[4:]
    return os.path.normcase(value)


def _long_path(path):
    """Expand existing Windows DOS aliases without resolving links in saved grants."""
    if os.name != "nt":
        return Path(path)
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetLongPathNameW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
    kernel.GetLongPathNameW.restype = wintypes.DWORD
    buffer = ctypes.create_unicode_buffer(32768)
    original, candidate, missing = Path(path), Path(path), []
    while True:
        length = kernel.GetLongPathNameW(str(candidate), buffer, len(buffer))
        if 0 < length < len(buffer):
            return Path(buffer.value).joinpath(*reversed(missing))
        if candidate == candidate.parent:
            return original
        missing.append(candidate.name)
        candidate = candidate.parent


def _schema(properties, required=()):
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}


_PATH = {"type": "string", "maxLength": 4096}
TOOLS = [
    {"name": "project_list_directory", "description": "List one approved project directory with bounded pages.",
     "inputSchema": _schema({"path": _PATH, "offset": {"type": "integer", "minimum": 0}, "limit": {"type": "integer", "minimum": 1, "maximum": 200}})},
    {"name": "project_read_file", "description": "Read one complete UTF-8 project file, at most 256 KiB, with its SHA-256.",
     "inputSchema": _schema({"path": _PATH}, ("path",))},
    {"name": "project_write_file", "description": "Atomically write UTF-8 project text; existing files require their current SHA-256. Office documents are excluded.",
     "inputSchema": _schema({"path": _PATH, "content": {"type": "string", "maxLength": MAX_TEXT}, "expectedSha256": {"type": ["string", "null"], "pattern": "^[a-fA-F0-9]{64}$"}}, ("path", "content", "expectedSha256"))},
]


def _identity(metadata):
    return metadata.st_dev, metadata.st_ino


def _signature(metadata):
    # Windows path stat and descriptor stat can report different meanings for ctime.
    return _identity(metadata) + (metadata.st_size, metadata.st_mtime_ns)


def _normal(metadata, directory=False):
    if stat.S_ISLNK(metadata.st_mode) or getattr(metadata, "st_file_attributes", 0) & 0x400:
        raise ValueError("Project links, junctions and reparse points are not permitted.")
    if not (stat.S_ISDIR(metadata.st_mode) if directory else stat.S_ISREG(metadata.st_mode)):
        raise ValueError("Choose a regular project file or directory.")
    if not directory and metadata.st_nlink != 1:
        raise ValueError("Hard-linked project files are not permitted.")
    return metadata


@contextmanager
def _directories(path):
    """Anchor POSIX traversal; Windows handles prevent ancestor renames while held."""
    if os.name != "nt":
        descriptors = [os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY)]
        try:
            for part in path.parts[1:]:
                descriptor = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptors[-1])
                descriptors.append(descriptor)
                _normal(os.fstat(descriptor), True)
            yield descriptors[-1]
        finally:
            for descriptor in reversed(descriptors):
                os.close(descriptor)
        return
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.GetFileInformationByHandleEx.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.GetFileInformationByHandleEx.restype = wintypes.BOOL

    class Attributes(ctypes.Structure):
        _fields_ = [("attributes", wintypes.DWORD), ("tag", wintypes.DWORD)]

    handles = []
    try:
        for component in (*reversed(path.parents), path):
            _normal(component.lstat(), True)
            handle = kernel.CreateFileW(str(component), 0x80, 3, None, 3, 0x02200000, None)
            if handle == ctypes.c_void_p(-1).value:
                raise ValueError("The project directory cannot be safely opened.")
            handles.append(handle)
            attributes = Attributes()
            if not kernel.GetFileInformationByHandleEx(handle, 9, ctypes.byref(attributes), ctypes.sizeof(attributes)) or attributes.attributes & 0x400:
                raise ValueError("Project reparse points are not permitted.")
        yield None
    finally:
        for handle in reversed(handles):
            kernel.CloseHandle(handle)


def _parts(value, allow_root=False):
    if not isinstance(value, str) or len(value) > 4096 or any(ord(character) < 32 for character in value) or "\\" in value or ":" in value or PureWindowsPath(value).drive or value.startswith("/"):
        raise ValueError("Use a project-relative path with forward slashes.")
    if value == "" and allow_root:
        return ()
    parts = tuple(value.split("/"))
    for part in parts:
        if part in ("", ".", "..") or part.rstrip(" .") != part or part.lower() == ".git" or re.fullmatch(r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part):
            raise ValueError("The project path is invalid or names protected Git metadata.")
    try:
        value.encode("utf-8")
    except UnicodeError:
        raise ValueError("The project path is not valid Unicode.") from None
    return parts


def _text(raw):
    try:
        text = raw.decode("utf-8")
    except UnicodeError:
        raise ValueError("Only complete UTF-8 text files are supported.") from None
    if any(ord(character) < 32 and character not in "\t\r\n" for character in text) or "\x7f" in text:
        raise ValueError("Binary project files are not supported.")
    return text


class ProjectAccess:
    def __init__(self, directory):
        self.directory = Path(directory).absolute()
        _private_directory(self.directory)
        self._private_directory = Path(_path_key(_long_path(self.directory)))
        self._lock = threading.RLock()
        self._cancel_lock = threading.Lock()
        self.cancel_event = threading.Event()
        self.cancel_event.set()
        self._cancel_request = 0
        self._path, self._mode, self._active, self._root_identity = "", "read", False, None
        self._grant_generation = 0
        self._documents = frozenset()
        self._saved = None
        config = self.directory / CONFIG
        if config.exists() or config.is_symlink():
            self._saved = self._read_config()
            value = json.loads(self._saved.decode("utf-8"), object_pairs_hook=_unique_fields)
            if not isinstance(value, dict) or set(value) != {"version", "path", "mode"} or type(value["version"]) is not int or value["version"] != 1 or not isinstance(value["path"], str) or len(value["path"]) > 4096 or value["mode"] not in ("read", "read_write"):
                raise ValueError("The saved project selection is invalid; existing data was preserved.")
            self._path, self._mode = value["path"], value["mode"]
        self._publish()

    def _read_config(self):
        config = self.directory / CONFIG
        before = _regular(config)
        if before.st_size > 8192:
            raise ValueError("The saved project selection exceeds its limit.")
        with config.open("rb") as source:
            opened = os.fstat(source.fileno())
            if _signature(opened) != _signature(before):
                raise ValueError("The saved project selection changed while reading.")
            raw = source.read(8193)
        if len(raw) > 8192 or _signature(_regular(config)) != _signature(before):
            raise ValueError("The saved project selection changed while reading.")
        return raw

    def _save(self, path, mode):
        config = self.directory / CONFIG
        if (config.exists() or config.is_symlink()) and self._saved is None or self._saved is not None and self._read_config() != self._saved:
            raise ValueError("The saved project selection changed externally; existing data was preserved.")
        raw = json.dumps({"version": 1, "path": str(path), "mode": mode}, ensure_ascii=False).encode("utf-8")
        descriptor, temporary = tempfile.mkstemp(prefix=".project-", dir=self.directory)
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(raw)
                output.flush()
                os.fsync(output.fileno())
            if self._saved is not None and self._read_config() != self._saved:
                raise ValueError("The saved project selection changed externally; existing data was preserved.")
            os.replace(temporary, config)
            self._saved = raw
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _selection(self, path, mode):
        if mode not in ("read", "read_write") or not isinstance(path, str) or not path or len(path) > 4096 or "\x00" in path or not Path(path).is_absolute():
            raise ValueError("Choose an absolute project folder and Read or Read + write.")
        root = Path(os.path.abspath(path))
        if any(part.lower() == ".git" for part in root.parts) or self._private_path(root):
            raise ValueError("Writer private state and Git metadata cannot be project roots.")
        with _directories(root):
            return root, _identity(_normal(root.lstat(), True))

    def state(self):
        path, mode, active, _ = self._public_state
        return {"path": path, "mode": mode, "active": active and not self.cancel_event.is_set()}

    def _publish(self):
        self._public_state = (self._path, self._mode, self._active, self._grant_generation)

    def _cancel(self):
        with self._cancel_lock:
            self._cancel_request += 1
            self.cancel_event.set()
            return self._cancel_request

    def _resume(self, request):
        with self._cancel_lock:
            if request == self._cancel_request and self._active:
                self.cancel_event.clear()
                return True
            return False

    def _check_cancelled(self):
        if self.cancel_event.is_set():
            raise ValueError("Project access changed or was cancelled locally.")

    @property
    def grant_generation(self):
        return self._public_state[3]

    def protect_documents(self, paths):
        documents = frozenset(_path_key(path) for path in paths if path)
        if documents == self._documents:
            return
        request = self._cancel()
        with self._lock:
            self._documents = documents
            self._resume(request)

    def is_protected(self, path):
        with self._lock:
            expanded = _long_path(path)
            return is_office_document(expanded) or _path_key(path) in self._documents or _path_key(expanded) in {_path_key(_long_path(document)) for document in self._documents}

    def _private_path(self, path):
        expanded = Path(_path_key(_long_path(path)))
        return expanded == self._private_directory or self._private_directory in expanded.parents

    def configure(self, path, mode):
        self._cancel()
        with self._lock:
            self._active, self._root_identity = False, None
            self._grant_generation += 1
            self._publish()
            root, _ = self._selection(path, mode)
            self._save(root, mode)
            self._path, self._mode, self._active, self._root_identity = str(root), mode, False, None
            self._publish()
            return self.state()

    def grant(self, path, mode):
        request = self._cancel()
        with self._lock:
            self._active, self._root_identity = False, None
            self._grant_generation += 1
            self._publish()
            root, identity = self._selection(path, mode)
            self._save(root, mode)
            self._path, self._mode, self._active, self._root_identity = str(root), mode, True, identity
            self._publish()
            if not self._resume(request):
                self._active, self._root_identity = False, None
                self._publish()
                raise ValueError("A newer local project access change superseded this grant.")
            return self.state()

    def revoke(self):
        self._cancel()
        with self._lock:
            self._active, self._root_identity = False, None
            self._grant_generation += 1
            self._publish()
            return self.state()

    @contextmanager
    def context(self, write=False):
        self._check_cancelled()
        with self._lock:
            self._check_cancelled()
            if not self._active:
                raise ValueError("Grant project access locally for this Writer session first.")
            if write and self._mode != "read_write":
                raise ValueError("This project has Read access only.")
            root = Path(self._path)
            with _directories(root) as descriptor:
                metadata = os.fstat(descriptor) if descriptor is not None else root.lstat()
                if _identity(metadata) != self._root_identity:
                    self._active = False
                    self._grant_generation += 1
                    self.cancel_event.set()
                    self._publish()
                    raise ValueError("The project folder changed; grant access locally again.")
                yield root

    def tools(self):
        state = self.state()
        return copy.deepcopy(TOOLS[:3 if state["mode"] == "read_write" else 2]) if state["active"] else []

    @contextmanager
    def _parent(self, root, parts):
        target = root.joinpath(*parts)
        if self._private_path(target):
            raise ValueError("Writer private state is excluded from project access.")
        with _directories(target.parent) as descriptor:
            if _identity(root.lstat()) != self._root_identity:
                raise ValueError("The project folder changed during the operation.")
            yield target.parent, descriptor, target.name

    @staticmethod
    def _entry(parent, descriptor, name):
        return os.stat(name, dir_fd=descriptor, follow_symlinks=False) if descriptor is not None else (parent / name).lstat()

    def _read_at(self, parent, descriptor, name):
        before = _normal(self._entry(parent, descriptor, name))
        if before.st_size > MAX_TEXT:
            raise ValueError("Project text exceeds the 256 KiB complete-read limit.")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        opened = os.open(name, flags, dir_fd=descriptor) if descriptor is not None else os.open(str(parent / name), flags)
        with os.fdopen(opened, "rb") as source:
            if _signature(os.fstat(source.fileno())) != _signature(before):
                raise ValueError("The project file changed before reading.")
            raw = source.read(MAX_TEXT + 1)
            if len(raw) > MAX_TEXT or _signature(os.fstat(source.fileno())) != _signature(before):
                raise ValueError("The project file changed while reading.")
        if _signature(self._entry(parent, descriptor, name)) != _signature(before):
            raise ValueError("The project file changed while reading.")
        _text(raw)
        return raw, before

    def _list(self, root, arguments):
        parts = _parts(arguments.get("path", ""), True)
        offset, limit = arguments.get("offset", 0), arguments.get("limit", 100)
        if type(offset) is not int or not 0 <= offset <= MAX_ENTRIES or type(limit) is not int or not 1 <= limit <= 200:
            raise ValueError("Use a nonnegative offset and a page limit from 1 to 200.")
        target = root.joinpath(*parts)
        if self._private_path(target):
            raise ValueError("Writer private state is excluded from project access.")
        entries, omitted = [], 0
        with _directories(target) as descriptor:
            with os.scandir(descriptor if descriptor is not None else target) as listing:
                for index, entry in enumerate(listing):
                    self._check_cancelled()
                    if index >= MAX_ENTRIES:
                        raise ValueError("This directory exceeds the 20000-entry inventory limit.")
                    try:
                        _parts(entry.name)
                        path = target / entry.name
                        if self._private_path(path):
                            raise ValueError()
                        metadata = self._entry(target, descriptor, entry.name)
                        directory = stat.S_ISDIR(metadata.st_mode)
                        _normal(metadata, directory)
                    except (ValueError, FileNotFoundError):
                        omitted += 1
                        continue
                    entries.append({"name": entry.name, "path": "/".join((*parts, entry.name)), "type": "directory" if directory else "file", "size": 0 if directory else metadata.st_size})
        entries.sort(key=lambda entry: (entry["name"].casefold(), entry["name"]))
        return {"path": "/".join(parts), "entries": entries[offset:offset + limit], "nextOffset": offset + limit if offset + limit < len(entries) else None, "total": len(entries), "omitted": omitted}

    def _write(self, root, arguments):
        parts = _parts(arguments["path"])
        if self.is_protected(root.joinpath(*parts)):
            raise ValueError("Office documents must be edited through native highlighted-document permissions.")
        content, expected = arguments["content"], arguments["expectedSha256"]
        if not isinstance(content, str) or expected is not None and (not isinstance(expected, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", expected)):
            raise ValueError("Supply UTF-8 content and the current SHA-256, or explicit null for a new file.")
        raw = content.encode("utf-8")
        if len(raw) > MAX_TEXT:
            raise ValueError("Project text exceeds the 256 KiB write limit.")
        _text(raw)
        with self._parent(root, parts) as (parent, descriptor, name):
            try:
                original, before = self._read_at(parent, descriptor, name)
            except FileNotFoundError:
                original, before = None, None
            if before is None and expected is not None or before is not None and (expected is None or hashlib.sha256(original).hexdigest() != expected.lower()):
                raise ValueError("The project file changed or the create-only destination already exists.")
            temporary = ".writer-project-" + uuid.uuid4().hex + ".tmp"
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
            output_fd = os.open(temporary, flags, 0o600, dir_fd=descriptor) if descriptor is not None else os.open(str(parent / temporary), flags, 0o600)
            try:
                with os.fdopen(output_fd, "wb") as output:
                    staged_identity = _identity(os.fstat(output.fileno()))
                    output.write(raw)
                    if before is not None and os.name != "nt":
                        os.fchmod(output.fileno(), stat.S_IMODE(before.st_mode) & 0o777)
                    output.flush()
                    os.fsync(output.fileno())
                staged, staged_metadata = self._read_at(parent, descriptor, temporary)
                if _identity(staged_metadata) != staged_identity or staged != raw:
                    raise ValueError("The staged project file changed before publication.")
                if before is not None:
                    current, metadata = self._read_at(parent, descriptor, name)
                    if _signature(metadata) != _signature(before) or current != original:
                        raise ValueError("The project file changed before atomic replacement.")
                    self._check_cancelled()
                    if descriptor is None:
                        os.replace(parent / temporary, parent / name)
                    else:
                        os.replace(temporary, name, src_dir_fd=descriptor, dst_dir_fd=descriptor)
                elif descriptor is None:
                    self._check_cancelled()
                    os.rename(parent / temporary, parent / name)
                else:
                    self._check_cancelled()
                    os.link(temporary, name, src_dir_fd=descriptor, dst_dir_fd=descriptor, follow_symlinks=False)
            finally:
                try:
                    os.unlink(temporary, dir_fd=descriptor) if descriptor is not None else (parent / temporary).unlink()
                except FileNotFoundError:
                    pass
        return {"path": "/".join(parts), "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw), "written": True}

    def call(self, name, arguments):
        schemas = {tool["name"]: tool["inputSchema"] for tool in TOOLS}
        if name not in schemas or not isinstance(arguments, dict):
            raise ValueError("Unknown project tool or invalid arguments.")
        schema = schemas[name]
        if set(arguments) - set(schema["properties"]) or set(schema["required"]) - set(arguments):
            raise ValueError("Project tool arguments do not match the fixed schema.")
        try:
            with self.context(write=name == "project_write_file") as root:
                if name == "project_list_directory":
                    return self._list(root, arguments)
                if name == "project_write_file":
                    return self._write(root, arguments)
                parts = _parts(arguments["path"])
                with self._parent(root, parts) as (parent, descriptor, filename):
                    raw, _ = self._read_at(parent, descriptor, filename)
                return {"path": "/".join(parts), "content": _text(raw), "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw), "complete": True}
        except OSError:
            raise ValueError("The project path is unavailable, linked, changed or not writable.") from None
