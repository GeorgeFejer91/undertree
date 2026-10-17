"""Local, explicit pairing with another editor's fixed native Review tools."""
from concurrent.futures import Future
import copy
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import ssl
import tempfile
import threading
import time
from urllib.parse import urlsplit, urlunsplit
import uuid

from undertree_connection import _private_directory, _regular, _unique_fields
from undertree_mcp import TOOLS

MAX_RESPONSE = 1536 * 1024
MAX_TOTAL = 2 * 1024 * 1024
MAX_CONFIG = 16384
TIMEOUT = 15
NAMES = tuple(tool["name"] for tool in TOOLS)
PROTOCOL = "2025-06-18"


def _error(message="The paired editor is unavailable. Review its connection locally."):
    return ValueError(message)


def _json(raw):
    return json.loads(raw, object_pairs_hook=_unique_fields,
                      parse_constant=lambda _: (_ for _ in ()).throw(_error()))


def _url(value):
    if not isinstance(value, str) or not value or len(value) > 4096 or any(ord(c) < 33 or ord(c) > 126 for c in value) or any(c in value for c in "\\?#"):
        raise _error("Use an exact HTTPS MCP address or literal 127.0.0.1 HTTP address without credentials, query or fragment.")
    try:
        parsed = urlsplit(value)
        host, port = parsed.hostname, parsed.port
        if parsed.username is not None or parsed.password is not None or not host or "%" in host or parsed.scheme not in ("http", "https") or (parsed.scheme == "http" and host != "127.0.0.1") or port == 0:
            raise _error()
        authority = ("[" + host + "]") if ":" in host else host
        if port is not None and port != (443 if parsed.scheme == "https" else 80):
            authority += ":" + str(port)
        return urlunsplit((parsed.scheme, authority, parsed.path or "/", "", ""))
    except ValueError:
        raise _error("The paired MCP address is invalid.") from None


def _shape(value):
    if isinstance(value, dict):
        result = {key: _shape(item) for key, item in value.items() if key != "description"}
        if result.get("type") == "object" and "required" not in result:
            result["required"] = []
        return result
    if isinstance(value, list):
        return sorted(value) if all(isinstance(item, str) for item in value) else [_shape(item) for item in value]
    return value


def _catalogue_fingerprint(tools):
    native = [{"name": name, "inputSchema": _shape(next(tool["inputSchema"] for tool in tools if tool["name"].endswith("_" + name)))} for name in NAMES]
    return hashlib.sha256(json.dumps(native, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _schemas():
    writer = {tool["name"]: _shape(tool["inputSchema"]) for tool in TOOLS}
    native = copy.deepcopy(writer)
    proposal = native["suggest_text"]["properties"]["proposal"]["properties"]
    for key, limit in (("requestId", 100), ("quote", 32000), ("replacement", 32000), ("rationale", 4000)):
        proposal[key]["maxLength"] = limit
    parts = proposal["replacementParts"]["items"]["oneOf"]
    parts[0]["properties"]["text"]["maxLength"] = 32000
    parts[1]["properties"]["protectedId"]["maxLength"] = 100
    marking = native["highlight_text"]["properties"]["marking"]["properties"]
    marking["requestId"]["maxLength"] = 100
    marking["colorId"]["maxLength"] = 64
    marking["ranges"]["items"]["properties"]["quote"]["maxLength"] = 32000
    return writer, native


SCHEMAS = _schemas()


def _arguments(value, schema):
    if "oneOf" in schema:
        matches = 0
        for choice in schema["oneOf"]:
            try:
                _arguments(value, choice)
                matches += 1
            except ValueError:
                pass
        if matches != 1:
            raise _error("Invalid paired Review replacement part.")
        return
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict) or set(value) - set(schema["properties"]) or set(schema.get("required", [])) - set(value):
            raise _error("Invalid paired Review arguments.")
        for key, item in value.items():
            _arguments(item, schema["properties"][key])
    elif kind == "array":
        if not isinstance(value, list) or not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", 128):
            raise _error("Invalid paired Review batch.")
        for item in value:
            _arguments(item, schema["items"])
    elif kind == "string":
        if not isinstance(value, str) or len(value) > schema.get("maxLength", MAX_RESPONSE):
            raise _error("Invalid paired Review text argument.")
    elif kind == "integer":
        if type(value) is not int or value < schema.get("minimum", 0):
            raise _error("Invalid paired Review offset.")
    else:
        raise _error("Unsupported paired Review schema.")


class _Wire:
    def __init__(self, url):
        self.url = url
        self.session = None
        self.protocol = PROTOCOL
        self.counter = 0

    def request(self, method, params, notification=False):
        self.counter += 1
        request_id = self.counter
        message = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notification:
            message["id"] = request_id
        raw = json.dumps(message, ensure_ascii=False, allow_nan=False).encode("utf-8")
        if len(raw) > MAX_RESPONSE:
            raise _error("The paired request exceeds its size limit.")
        parsed = urlsplit(self.url)
        connection = (http.client.HTTPSConnection(parsed.hostname, parsed.port, timeout=TIMEOUT, context=ssl.create_default_context())
                      if parsed.scheme == "https" else http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=TIMEOUT))
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": self.protocol, "Connection": "close"}
        if self.session is not None:
            headers["Mcp-Session-Id"] = self.session
        deadline = time.monotonic() + TIMEOUT
        try:
            connection.request("POST", parsed.path or "/", raw, headers)
            stream_socket = connection.sock
            response = connection.getresponse()
            if response.status not in (200, 202, 204):
                raise _error()
            session = response.getheader("Mcp-Session-Id")
            if session is not None:
                if not 1 <= len(session) <= 256 or any(ord(c) < 33 or ord(c) > 126 for c in session) or (self.session is not None and session != self.session):
                    raise _error()
                if method != "initialize" and self.session is None:
                    raise _error()
                self.session = session
            if notification and response.status in (202, 204):
                return None
            content_type = response.getheader("Content-Type", "").split(";")[0].strip().lower()
            if content_type not in ("application/json", "text/event-stream"):
                raise _error()
            declared = response.getheader("Content-Length")
            if declared is not None and (not declared.isdecimal() or int(declared) > MAX_RESPONSE):
                raise _error()
            payload, event = bytearray(), bytearray()
            total = 0
            while True:
                if response.isclosed():
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise _error()
                if stream_socket is not None:
                    stream_socket.settimeout(remaining)
                chunk = response.read1(16384)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_RESPONSE:
                    raise _error()
                payload.extend(chunk)
                if content_type == "text/event-stream":
                    while b"\n" in payload:
                        line, _, tail = payload.partition(b"\n")
                        payload = bytearray(tail)
                        line = line.rstrip(b"\r")
                        if line.startswith(b"data:"):
                            event.extend(line[5:].lstrip(b" ") + b"\n")
                        elif not line and event:
                            reply = _json(event.decode("utf-8"))
                            event.clear()
                            if isinstance(reply, dict) and reply.get("id") == request_id:
                                return self._result(reply, request_id)
            if notification and not payload:
                return None
            if content_type != "application/json" or (declared is not None and total != int(declared)):
                raise _error()
            return self._result(_json(payload.decode("utf-8")), request_id)
        except Exception:
            raise _error() from None
        finally:
            connection.close()

    @staticmethod
    def _result(reply, request_id):
        if not isinstance(reply, dict) or reply.get("jsonrpc") != "2.0" or type(reply.get("id")) is not int or reply["id"] != request_id or "error" in reply or not isinstance(reply.get("result"), dict):
            raise _error()
        return reply["result"]

    def connect(self, peer_id):
        initialized = self.request("initialize", {"protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": {"name": "wrAIter pairing", "version": "1"}})
        name = initialized.get("serverInfo", {}).get("name")
        if name not in ("UnderTree manuscript review", "UnderTree connected apps gateway", "UnderTree LibreOffice", "Selective AI Writer", "Selective AI for Writer", "wrAIter") or initialized.get("protocolVersion") not in ("2025-03-26", PROTOCOL):
            raise _error("This endpoint is not a supported selective editor.")
        self.protocol = initialized["protocolVersion"]
        self.request("notifications/initialized", {}, notification=True)
        catalogue = self.request("tools/list", {})
        if catalogue.get("nextCursor") is not None or not isinstance(catalogue.get("tools"), list) or len(catalogue["tools"]) > 192:
            raise _error("The paired tool catalogue is invalid.")
        native = {}
        for tool in catalogue["tools"]:
            if not isinstance(tool, dict):
                raise _error()
            upstream = tool.get("name")
            if upstream not in NAMES:
                continue  # Gateway aliases are never imported, including another peer's aliases.
            if upstream in native or not any(_shape(tool.get("inputSchema")) == schema[upstream] for schema in SCHEMAS):
                raise _error("The paired editor's native Review schema is unsupported.")
            native[upstream] = {"name": "peer_" + peer_id + "_" + upstream,
                                "description": "Paired editor: " + upstream + ". Read complete context before proposing; the target enforces all current highlights and permissions.",
                                "inputSchema": copy.deepcopy(tool["inputSchema"]),
                                "annotations": {"readOnlyHint": upstream in ("list_manuscripts", "read_manuscript"), "destructiveHint": upstream == "suggest_text", "idempotentHint": upstream in ("suggest_text", "highlight_text")}}
        if set(native) != set(NAMES):
            raise _error("The paired editor must provide all four native Review tools.")
        return name, [native[key] for key in NAMES]


class PeerConnections:
    """Only local UI may link/unlink/restore. call returns a complete MCP tool result."""
    def __init__(self, config_dir):
        self.directory = Path(config_dir).absolute() / "peers"
        _private_directory(self.directory)
        self._mutex = threading.RLock()
        self._slots = threading.BoundedSemaphore(2)
        self._closed = False
        self._raw = None
        self._peers = {}
        self._lock = None
        try:
            self._acquire()
            self._load()
        except Exception:
            self.close()
            raise _error("The private pairing configuration is invalid or already owned; existing data was preserved.") from None

    def _acquire(self):
        path = self.directory / "peers.lock"
        if path.exists() or path.is_symlink():
            _regular(path)
        self._lock = os.fdopen(os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600), "r+b", buffering=0)
        _regular(path)
        if self._lock.seek(0, 2) == 0:
            self._lock.write(b"0")
        self._lock.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(self._lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(self._lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    def _read(self):
        path = self.directory / "peers.json"
        before = _regular(path)
        if before.st_size > MAX_CONFIG:
            raise _error()
        with path.open("rb") as source:
            opened = os.fstat(source.fileno())
            raw = source.read(MAX_CONFIG + 1)
        after = _regular(path)
        if len(raw) > MAX_CONFIG or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino) or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
            raise _error()
        return raw

    def _load(self):
        path = self.directory / "peers.json"
        if not path.exists() and not path.is_symlink():
            return
        raw = self._read()
        value = _json(raw.decode("utf-8"))
        if not isinstance(value, dict) or set(value) != {"version", "peers"} or type(value["version"]) is not int or value["version"] not in (1, 2) or not isinstance(value["peers"], list) or len(value["peers"]) > 2:
            raise _error()
        urls = set()
        for entry in value["peers"]:
            fields = {"id", "url", "label"} | ({"catalogueHash"} if value["version"] == 2 else set())
            if not isinstance(entry, dict) or set(entry) != fields or not isinstance(entry["id"], str) or not re.fullmatch("[0-9a-f]{32}", entry["id"]) or entry["id"] in self._peers or _url(entry["url"]) != entry["url"] or entry["url"] in urls:
                raise _error()
            fingerprint = entry.get("catalogueHash")
            if fingerprint is not None and (not isinstance(fingerprint, str) or not re.fullmatch("[0-9a-f]{64}", fingerprint)):
                raise _error()
            self._label(entry["label"])
            urls.add(entry["url"])
            self._peers[entry["id"]] = self._entry(entry)
            self._peers[entry["id"]]["enrolled"] = True
            if fingerprint is None:
                self._peers[entry["id"]]["error"] = "Reconnect locally to approve this editor's four-tool Review catalogue."
        self._raw = raw

    @staticmethod
    def _entry(saved):
        return dict(saved, catalogueHash=saved.get("catalogueHash"), enrolled=False, name="", status="disconnected", error="", tools=[], wire=None, busy=threading.Lock(), calls={}, bytes=0)

    @staticmethod
    def _label(label):
        if not isinstance(label, str) or not 1 <= len(label) <= 100 or any(ord(c) < 32 for c in label):
            raise _error("Use a short local pairing label.")

    def _save(self):
        path = self.directory / "peers.json"
        if path.exists() or path.is_symlink():
            if self._read() != self._raw:
                raise _error("Pairing configuration changed externally; existing data was preserved.")
        elif self._raw is not None:
            raise _error("Pairing configuration disappeared; existing data was preserved.")
        raw = json.dumps({"version": 2, "peers": [{key: peer[key] for key in ("id", "url", "label", "catalogueHash")} for peer in self._peers.values() if peer["enrolled"]]}, sort_keys=True).encode("utf-8")
        if len(raw) > MAX_CONFIG:
            raise _error()
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
            self._raw = raw
            if os.name != "nt":
                descriptor = os.open(self.directory, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def _open(self):
        if self._closed:
            raise _error("Pairing is closed.")

    def link(self, url, label="UnderTree", *, _restoring=False):
        url = _url(url)
        self._label(label)
        with self._mutex:
            self._open()
            peer = next((peer for peer in self._peers.values() if peer["url"] == url), None)
            if peer is None:
                if len(self._peers) >= 2:
                    raise _error("At most two editors may be paired.")
                peer = self._entry({"id": uuid.uuid4().hex, "url": url, "label": label})
            if peer["status"] == "connecting" or not self._slots.acquire(False):
                raise _error("A pairing connection is already pending. Wait for its result.")
            existing = peer["id"] in self._peers
            self._peers[peer["id"]] = peer
            peer["status"], peer["tools"] = "connecting", []
            try:
                future = Future()
                future.set_running_or_notify_cancel()
                threading.Thread(target=self._complete, args=(future, peer, existing, not _restoring), name="Writer peer", daemon=True).start()
                return future
            except Exception:
                self._slots.release()
                if not existing:
                    self._peers.pop(peer["id"], None)
                raise _error() from None

    def _complete(self, future, peer, existing, approve_catalogue):
        try:
            future.set_result(self._connect(peer, existing, approve_catalogue))
        except Exception as error:
            future.set_exception(error)

    def _connect(self, peer, existing, approve_catalogue):
        failure = "The paired editor is unavailable; reconnect locally."
        try:
            with peer["busy"]:
                wire = _Wire(peer["url"])
                name, tools = wire.connect(peer["id"])
                fingerprint = _catalogue_fingerprint(tools)
                if not approve_catalogue and fingerprint != peer["catalogueHash"]:
                    failure = "The paired Review catalogue changed. Reconnect locally to approve its current tools."
                    raise _error(failure)
                with self._mutex:
                    if self._closed or self._peers.get(peer["id"]) is not peer:
                        raise _error("Pairing was revoked before it completed.")
                    peer.update(name=name, wire=wire, tools=tools, status="connected", error="", enrolled=True, catalogueHash=fingerprint)
                    self._save()
                    return {"id": peer["id"], "name": name, "toolCount": len(tools), "status": "connected"}
        except Exception:
            with self._mutex:
                peer.update(wire=None, tools=[], status="disconnected", error=failure)
                if not existing and self._peers.get(peer["id"]) is peer:
                    del self._peers[peer["id"]]
            raise _error(failure) from None
        finally:
            self._slots.release()

    def restore(self):
        with self._mutex:
            self._open()
            saved = [(peer["url"], peer["label"]) for peer in self._peers.values() if peer["status"] != "connected" and peer["catalogueHash"] is not None]
        return [self.link(url, label, _restoring=True) for url, label in saved]

    def unlink(self, peer_id):
        with self._mutex:
            self._open()
            peer = self._peers.pop(peer_id, None)
            if peer is None:
                raise _error("Unknown paired editor.")
            try:
                self._save()
            except Exception:
                self._peers[peer_id] = peer
                peer.update(wire=None, tools=[], status="disconnected")
                raise
            peer.update(wire=None, tools=[], status="disconnected")

    def tools(self):
        with self._mutex:
            return copy.deepcopy([tool for peer in self._peers.values() if peer["status"] == "connected" for tool in peer["tools"]])

    def status(self):
        with self._mutex:
            return [{key: peer[key] for key in ("id", "label", "name", "url", "status", "error")} | {"toolCount": len(peer["tools"])} for peer in self._peers.values()]

    def call(self, name, arguments):
        with self._mutex:
            self._open()
            found = [(peer, tool) for peer in self._peers.values() if peer["status"] == "connected" for tool in peer["tools"] if tool["name"] == name]
            if len(found) != 1 or not isinstance(arguments, dict):
                raise _error("Unknown paired Review tool or invalid arguments.")
            peer, tool = found[0]
            _arguments(arguments, tool["inputSchema"])
            arguments = copy.deepcopy(arguments)
            if not peer["busy"].acquire(False):
                raise _error("The paired editor already has an operation in progress.")
            wire = peer["wire"]
        try:
            upstream = next(key for key in NAMES if name == "peer_" + peer["id"] + "_" + key)
            operation = arguments.get("marking" if upstream == "highlight_text" else "proposal")
            request_id = operation.get("requestId") if isinstance(operation, dict) else None
            mutation = upstream in ("suggest_text", "highlight_text")
            fingerprint = hashlib.sha256(json.dumps(arguments, sort_keys=True, allow_nan=False).encode("utf-8")).hexdigest()
            if mutation:
                if not isinstance(request_id, str) or not 1 <= len(request_id) <= 100:
                    raise _error("A stable mutation requestId is required.")
                previous = peer["calls"].get(request_id)
                if previous:
                    if previous[0] != fingerprint:
                        raise _error("This mutation requestId was already used with different arguments.")
                    return copy.deepcopy(previous[1])
                if len(peer["calls"]) >= 64 or sum(entry["bytes"] for entry in self._peers.values()) + MAX_RESPONSE > MAX_TOTAL:
                    raise _error("The paired mutation replay ledger is full; review locally.")
                peer["calls"][request_id] = (fingerprint, {"content": [{"type": "text", "text": "The mutation outcome is unknown. Inspect the paired editor locally; this request will not be sent again."}], "isError": True})
            try:
                result = wire.request("tools/call", {"name": upstream, "arguments": arguments})
                if not isinstance(result.get("content"), list) or type(result.get("isError", False)) is not bool or any(not isinstance(item, dict) or item.get("type") != "text" or not isinstance(item.get("text"), str) for item in result["content"]):
                    raise _error()
                if result.get("isError"):
                    result = {"content": [{"type": "text", "text": "The paired editor refused this operation. Review its current context and permissions locally."}], "isError": True}
                else:
                    result = {key: copy.deepcopy(result[key]) for key in ("content", "structuredContent", "isError") if key in result}
            except Exception:
                if mutation:
                    return copy.deepcopy(peer["calls"][request_id][1])
                raise _error() from None
            with self._mutex:
                if self._closed or self._peers.get(peer["id"]) is not peer or peer["status"] != "connected":
                    raise _error("Pairing was revoked while the request was in flight; its outcome may be unknown.")
                if mutation:
                    size = len(json.dumps(result).encode("utf-8"))
                    if sum(entry["bytes"] for entry in self._peers.values()) + size <= MAX_TOTAL:
                        peer["calls"][request_id] = (fingerprint, copy.deepcopy(result))
                        peer["bytes"] += size
            return result
        finally:
            peer["busy"].release()

    def close(self):
        with self._mutex:
            self._closed = True
            for peer in self._peers.values():
                peer.update(wire=None, tools=[], status="disconnected")
            if self._lock is not None:
                self._lock.close()
                self._lock = None
