"""Writer-owned zrok2 child and exact-share cleanup; no UnderTree desktop dependency."""
import json
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time
from urllib.parse import urlsplit
import urllib.request
import xml.etree.ElementTree as ET

from undertree_connection import _regular, _unique_fields
from undertree_mcp import TOOLS

MAX_OUTPUT = 256 * 1024
COMMAND_TIMEOUT = 10
START_TIMEOUT = 20
RETRY_DELAYS = (1, 2, 4, 8, 16)
CONFIG = "tunnel.json"
IDENTIFIER = re.compile(r"[A-Za-z0-9_.-]{1,128}\Z", re.ASCII)
BUNDLED_ZROK_SHA256 = "0702de65616f78cfe4ef72e06e6be463335b4f67b4e67f1f33f394a82fd23713"


class TunnelError(ValueError):
    pass


def _setup(value):
    keys = {"version", "reservation", "publicUrl", "zrokExecutable", "enrollmentHome", "autoReconnect"}
    if not isinstance(value, dict) or set(value) != keys or type(value["version"]) is not int or value["version"] != 1 or type(value["autoReconnect"]) is not bool:
        raise TunnelError("Writer tunnel configuration is invalid; existing data was preserved.")
    if any(not isinstance(value[key], str) or len(value[key]) > 4096 or any(ord(c) < 32 for c in value[key]) for key in keys - {"version", "autoReconnect"}):
        raise TunnelError("Writer tunnel configuration is invalid; existing data was preserved.")
    name = value["reservation"]
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", name, re.ASCII):
        raise TunnelError("Choose an existing Writer public reservation name.")
    try:
        parsed = urlsplit(value["publicUrl"])
        valid = parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment and parsed.path in ("", "/") and parsed.port in (None, 443)
    except ValueError:
        valid = False
    if not valid or not re.fullmatch(r"[A-Za-z0-9.-]+(?::443)?", parsed.netloc) or "\\" in value["publicUrl"] or any(c.isspace() for c in value["publicUrl"]):
        raise TunnelError("Use the exact HTTPS origin of the Writer reservation.")
    executable = Path(value["zrokExecutable"])
    if not executable.is_absolute() or (os.name == "nt" and executable.suffix.lower() != ".exe"):
        raise TunnelError("Choose the installed zrok2 executable by its absolute path.")
    if value["enrollmentHome"] and not Path(value["enrollmentHome"]).is_absolute():
        raise TunnelError("Choose an absolute Writer enrollment home, or use the current user's enabled zrok account.")
    return dict(value, publicUrl=value["publicUrl"].rstrip("/"))


def _kill(child):
    if child is None:
        return
    if child.poll() is None:
        try:
            child.terminate()
        except OSError:
            pass
    try:
        child.wait(timeout=2)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=3)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_):
        return None


class TunnelSupervisor:
    """One supervisor per ConnectionManager. Lifecycle work never runs on UNO's UI thread.

    configure/start/restore/stop return immediately after private intent writes.
    status reports progress; close is bounded process teardown, preserving startup intent.
    Documents remain governed by fresh native consent and context receipts.
    """
    def __init__(self, connection):
        self.connection = connection
        self.directory = connection.directory
        self._mutex = threading.RLock()
        self._cancel = threading.Event()
        self._thread = None
        self._child = None
        self._owned = None
        self._prepared = None
        self._closed = False
        self._phase = "stopped"
        self._error = ""
        self._attempt = 0
        self._saved = None
        self._config = None
        path = self.directory / CONFIG
        if path.exists() or path.is_symlink():
            _regular(path)
            with path.open("rb") as source:
                raw = source.read(8193)
            if len(raw) > 8192:
                raise TunnelError("Writer tunnel configuration exceeds its limit; existing data was preserved.")
            try:
                self._config = _setup(json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_fields))
            except (UnicodeError, json.JSONDecodeError, RecursionError):
                raise TunnelError("Writer tunnel configuration is invalid; existing data was preserved.") from None
            self._saved = raw

    def _save(self, config):
        raw = json.dumps(_setup(config), sort_keys=True).encode("utf-8")
        if len(raw) > 8192:
            raise TunnelError("Writer tunnel configuration exceeds its limit.")
        target = self.directory / CONFIG
        if target.exists() or target.is_symlink():
            _regular(target)
            with target.open("rb") as source:
                if source.read(8193) != self._saved:
                    raise TunnelError("Writer tunnel setup changed externally; existing data was preserved.")
        elif self._saved is not None:
            raise TunnelError("Writer tunnel setup disappeared; existing data was preserved.")
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
            self._saved = raw
            self._config = _setup(config)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def configure(self, settings):
        with self._mutex:
            if self._closed or (self._thread and self._thread.is_alive()) or self._prepared:
                raise TunnelError("Stop the Writer tunnel and verify cleanup before changing its setup.")
            if not isinstance(settings, dict) or set(settings) != {"reservation", "publicUrl", "zrokExecutable", "enrollmentHome"}:
                raise TunnelError("Supply only the Writer reservation, HTTPS origin, executable and optional enrollment home.")
            self._save(dict(settings, version=1, autoReconnect=False))
            self._error = ""

    def settings(self):
        """Local setup fields only; activation credentials never enter this projection."""
        with self._mutex:
            return {key: self._config[key] if self._config else "" for key in ("reservation", "publicUrl", "zrokExecutable", "enrollmentHome")}

    def set_auto_reconnect(self, enabled):
        if type(enabled) is not bool:
            raise TunnelError("Reconnect preference must be a checkbox value.")
        with self._mutex:
            if self._config is None or self._closed:
                raise TunnelError("Configure the Writer tunnel first.")
            self._save(dict(self._config, autoReconnect=enabled))

    def start(self):
        self.set_auto_reconnect(True)
        return self.restore()

    def restore(self):
        with self._mutex:
            if self._closed:
                raise TunnelError("Writer tunnel supervisor is closed.")
            if self._config is None or not self._config["autoReconnect"]:
                return self.status()
            if self._thread and self._thread.is_alive():
                return self.status()
            if self._prepared:
                raise TunnelError("Previous Writer share cleanup is unverified. Retry Stop; no existing share will be adopted.")
            self._cancel.clear()
            self._error = ""
            self._attempt = 0
            self._phase = "starting"
            self._thread = threading.Thread(target=self._work, name="wrAIter zrok", daemon=True)
            self._thread.start()
            return self.status()

    def stop(self):
        with self._mutex:
            try:
                if self._config is not None:
                    self._save(dict(self._config, autoReconnect=False))
            finally:
                self._cancel.set()
                self.connection.set_public_host(None)
                if self._child is not None and self._child.poll() is None:
                    try:
                        self._child.terminate()  # The exact Popen handle only; never an executable/name search.
                    except OSError:
                        pass
                if self._thread and self._thread.is_alive():
                    self._phase = "stopping"
                elif self._prepared:
                    self._phase = "stopping"
                    self._thread = threading.Thread(target=self._cleanup_only, name="wrAIter cleanup", daemon=True)
                    self._thread.start()
                else:
                    self._phase = "stopped"
            return self.status()

    def status(self):
        with self._mutex:
            broker = self.connection.status()
            return {"configured": self._config is not None, "running": not self._cancel.is_set() and self._phase == "running" and self._child is not None and self._child.poll() is None,
                    "phase": self._phase, "autoReconnect": bool(self._config and self._config["autoReconnect"]), "retryAttempt": self._attempt,
                    "endpoint": self._config["publicUrl"] + urlsplit(broker["url"]).path if self._config else "", "error": self._error,
                    "externallyVerified": False, "cleanupPending": self._prepared is not None and self._phase != "running"}

    def close(self, timeout=35):
        with self._mutex:
            self._closed = True
            self._cancel.set()
            self.connection.set_public_host(None)
            child, thread = self._child, self._thread
        _kill(child)
        if thread and thread is not threading.current_thread():
            thread.join(timeout)
        if thread and thread.is_alive():
            raise TunnelError("Writer tunnel shutdown is still pending; cleanup could not be verified.")
        if self._prepared is not None:
            raise TunnelError("Writer share cleanup remains unverified. No existing share was adopted or removed.")

    def _argv(self, arguments):
        return [self._config["zrokExecutable"], *arguments]

    def _refresh_bundled_executable(self):
        cache = Path(os.path.abspath(self.directory.parent / "uno_packages/cache/uno_packages"))
        with self._mutex:
            if self._closed or self._cancel.is_set():
                return False
            saved = self._config["zrokExecutable"]
        old = Path(os.path.abspath(saved))
        current = Path(os.path.abspath(Path(__file__).with_name("zrok2.exe")))
        def owned(path):
            try:
                parts = path.relative_to(cache).parts
            except ValueError:
                return False
            return len(parts) == 3 and re.fullmatch(r"lu[A-Za-z0-9]+\.tmp_", parts[0]) and parts[1:] == ("wrAIter.oxt", "zrok2.exe")
        if not owned(old) or old == current:
            return True
        try:
            if not owned(current):
                raise ValueError()
            for directory in (self.directory.parent, cache.parent.parent, cache.parent, cache, current.parent.parent, current.parent):
                _regular(directory, directory=True)
            for directory in (old.parent.parent, old.parent):
                try:
                    _regular(directory, directory=True)
                except FileNotFoundError:
                    pass
            description = current.with_name("description.xml")
            _regular(description)
            with description.open("rb") as source:
                metadata = source.read(65537)
            if len(metadata) > 65536:
                raise ValueError()
            identifier = ET.fromstring(metadata).find("{http://openoffice.org/extensions/description/2006}identifier")
            if identifier is None or identifier.get("value") != "org.undertree.WriterReview":
                raise ValueError()
            _regular(current)
            digest, size = hashlib.sha256(), 0
            with current.open("rb") as source:
                while chunk := source.read(1024 * 1024):
                    if self._cancel.is_set():
                        return False
                    size += len(chunk)
                    if size > 128 * 1024 * 1024:
                        raise ValueError()
                    digest.update(chunk)
            if digest.hexdigest() != BUNDLED_ZROK_SHA256:
                raise ValueError()
        except (ValueError, OSError, ET.ParseError):
            raise TunnelError("The updated bundled Writer bridge is unavailable or unverified; the saved setup was preserved.") from None
        with self._mutex:
            if self._closed or self._cancel.is_set():
                return False
            if self._prepared is not None or self._config["zrokExecutable"] != saved:
                raise TunnelError("Writer tunnel setup changed before its bundled bridge could be updated.")
            self._save(dict(self._config, zrokExecutable=str(current)))
        return True

    def _environment(self):
        environment = os.environ.copy()
        home = self._config["enrollmentHome"] or environment.get("USERPROFILE" if os.name == "nt" else "HOME", "")
        if not home:
            raise TunnelError("Enable the Writer zrok account before connecting.")
        environment["USERPROFILE" if os.name == "nt" else "HOME"] = home
        return environment

    def _spawn(self, arguments, *, capture=False):
        return subprocess.Popen(self._argv(arguments), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, env=self._environment(), shell=False,
                                creationflags=0x08000000 if os.name == "nt" else 0)

    def _run(self, arguments):
        child = None
        output = []
        try:
            child = self._spawn(arguments, capture=True)
            def read():
                try:
                    raw = child.stdout.read(MAX_OUTPUT + 1)
                    output.append(raw)
                    if len(raw) > MAX_OUTPUT and child.poll() is None:
                        child.kill()
                except OSError:
                    pass
                finally:
                    child.stdout.close()  # Only the reader owns this pipe; closing from another thread can block.
            reader = threading.Thread(target=read, daemon=True)
            reader.start()
            child.wait(timeout=COMMAND_TIMEOUT)
            reader.join(2)
            if reader.is_alive() or child.returncode != 0 or not output or len(output[0]) > MAX_OUTPUT:
                raise TunnelError("Writer zrok management response could not be verified.")
            return output[0]
        except (OSError, subprocess.TimeoutExpired):
            raise TunnelError("Writer zrok management did not complete. No unrelated share was changed.") from None
        finally:
            _kill(child)

    def _records(self, flag, value):
        try:
            listing = json.loads(self._run(["list", "shares", "--json", flag, value]).decode("utf-8"))
        except (UnicodeError, ValueError, RecursionError):
            raise TunnelError("Writer zrok controller listing is unavailable or invalid.") from None
        if not isinstance(listing, dict) or not isinstance(listing.get("shares"), list) or len(listing["shares"]) > 1000 or any(not isinstance(row, dict) for row in listing["shares"]):
            raise TunnelError("Writer zrok controller listing is invalid.")
        return listing["shares"]

    def _target_records(self):
        target = self._prepared["target"]
        return [row for row in self._records("--target", target) if row.get("target") in (target, target.removeprefix("http://"))]

    def _identity(self, row):
        keys = ("shareToken", "envZId", "target", "frontendEndpoints", "shareMode", "backendMode")
        if any(key not in row for key in keys):
            raise TunnelError("Writer zrok share ownership is unverified.")
        identity = {key: row[key] for key in keys}
        if not isinstance(identity["shareToken"], str) or not IDENTIFIER.fullmatch(identity["shareToken"]) or identity["envZId"] != self._prepared["environment"] or identity["shareMode"] != "public" or identity["backendMode"] != "proxy" or identity["target"] not in (self._prepared["target"], self._prepared["target"].removeprefix("http://")) or identity["frontendEndpoints"] not in ([self._prepared["host"]], ["https://" + self._prepared["host"]], ["https://" + self._prepared["host"] + "/"]):
            raise TunnelError("Writer zrok share ownership changed. No existing share will be removed.")
        return identity

    def _discover(self):
        rows = self._target_records()
        if not rows:
            return False
        if len(rows) != 1:
            raise TunnelError("Writer zrok target has ambiguous ownership. No existing share will be removed.")
        identity = self._identity(rows[0])
        if self._owned is not None and identity != self._owned:
            raise TunnelError("Writer zrok share ownership changed. No existing share will be removed.")
        self._owned = identity
        return True

    def _retire(self):
        if self._prepared is None:
            return
        if self._owned is None and not self._discover():
            self._prepared = None
            return
        identity = self._owned
        rows = [row for row in self._records("--share-token", identity["shareToken"]) if row.get("shareToken") == identity["shareToken"]]
        if not rows:
            self._owned, self._prepared = None, None
            return
        if len(rows) != 1 or self._identity(rows[0]) != identity:
            raise TunnelError("Writer share cleanup is unverified. No replacement share was removed.")
        try:
            self._run(["delete", "share", identity["shareToken"], "--envzid", identity["envZId"]])
        except TunnelError:
            pass  # Resolve lost management replies through an independent exact-token observation.
        if any(row.get("shareToken") == identity["shareToken"] for row in self._records("--share-token", identity["shareToken"])):
            raise TunnelError("Writer share cleanup is unverified. Retry Stop before reconnecting.")
        self._owned, self._prepared = None, None

    def _broker(self):
        broker = self.connection.status()
        parsed = urlsplit(broker["url"])
        if not broker["running"] or parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port or parsed.username or parsed.password or parsed.query or parsed.fragment or not re.fullmatch(r"/mcp/[A-Za-z0-9_-]{32,128}", parsed.path):
            raise TunnelError("Start the private Writer MCP listener before connecting its tunnel.")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        def request(method):
            body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "Writer tunnel", "version": "1"}} if method == "initialize" else {}}).encode()
            with opener.open(urllib.request.Request(broker["url"], body, {"Content-Type": "application/json"}), timeout=5) as response:
                raw = response.read(65537)
            if len(raw) > 65536:
                raise TunnelError("Writer MCP identity exceeds the verification limit.")
            return json.loads(raw.decode("utf-8"))["result"]
        try:
            initialized = request("initialize")
            if initialized.get("serverInfo", {}).get("name") != "wrAIter" or initialized.get("_meta", {}).get("undertree/writerOwnerId") != broker["writerOwnerId"]:
                raise TunnelError("Writer MCP owner identity changed.")
            tools = request("tools/list")["tools"]
            expected = TOOLS + self.connection.extra_catalogue()
            if len(tools) != len(expected) or {tool["name"]: tool["inputSchema"] for tool in tools} != {tool["name"]: tool["inputSchema"] for tool in expected}:
                raise TunnelError("Writer MCP tool catalogue changed. No tunnel was started.")
        except (OSError, ValueError, KeyError, TypeError, RecursionError):
            raise TunnelError("The private Writer MCP owner and fixed three-tool catalogue could not be verified.") from None
        return parsed

    def _launch(self):
        if not self._refresh_bundled_executable():
            return
        parsed = self._broker()
        environment = self._environment()
        home = Path(environment["USERPROFILE" if os.name == "nt" else "HOME"])
        enrollment = home / ".zrok2" / "environment.json"
        _regular(enrollment)
        with enrollment.open("rb") as source:
            raw = source.read(1024 * 1024 + 1)
        try:
            identity = json.loads(raw.decode("utf-8"))["ziti_identity"]
            if len(raw) > 1024 * 1024 or not isinstance(identity, str) or not IDENTIFIER.fullmatch(identity):
                raise ValueError()
        except (ValueError, KeyError, UnicodeError, RecursionError):
            raise TunnelError("Enable the selected Writer zrok enrollment before connecting.") from None
        self._prepared = {"target": "http://" + parsed.netloc, "host": urlsplit(self._config["publicUrl"]).netloc, "environment": identity}
        try:
            occupied = bool(self._target_records())
        except Exception:
            self._prepared = None  # No child was created; preflight cannot authorize later cleanup.
            raise
        if occupied:
            self._prepared = None
            raise TunnelError("This Writer target already has a zrok share. No existing share was adopted or changed.")
        if self._cancel.is_set():
            self._prepared = None
            return
        try:
            self._child = self._spawn(["share", "public", self._prepared["target"], "-n", "public:" + self._config["reservation"], "--headless", "--force-local"])
        except OSError:
            self._prepared = None
            raise
        deadline = time.monotonic() + START_TIMEOUT
        while not self._cancel.is_set():
            if self._child.poll() is not None:
                raise TunnelError("Writer zrok exited. Verify its enrollment and reservation; existing owners are preserved.")
            if self._discover():
                if self._child.poll() is not None:
                    raise TunnelError("Writer zrok exited during startup.")
                with self._mutex:
                    if self._cancel.is_set():
                        return
                    self.connection.set_public_host(self._prepared["host"])
                    self._phase, self._error = "running", ""
                return
            if time.monotonic() >= deadline:
                raise TunnelError("Writer zrok did not confirm this session's share before the startup deadline.")
            self._cancel.wait(0.2)

    def _cleanup(self):
        self.connection.set_public_host(None)
        _kill(self._child)
        self._child = None
        self._retire()

    def _cleanup_only(self):
        try:
            self._cleanup()
            self._phase, self._error = "stopped", ""
        except (ValueError, OSError):
            self._phase, self._error = "cleanup_required", "Writer share cleanup could not be verified. Retry Stop; no unrelated share will be removed."

    def _work(self):
        for attempt, delay in enumerate((0, *RETRY_DELAYS), 1):
            self._attempt = attempt
            if self._cancel.wait(delay):
                break
            self._phase = "starting"
            try:
                self._launch()
                while self._child is not None and self._child.poll() is None and not self._cancel.wait(0.25):
                    pass
                if not self._cancel.is_set():
                    raise TunnelError("Writer zrok stopped unexpectedly.")
            except (ValueError, OSError):
                self._error = "Writer connection failed. Check the saved zrok setup, enrollment and reservation. Existing connections were preserved."
            try:
                self._cleanup()
            except (ValueError, OSError):
                self._phase, self._error = "cleanup_required", "Writer share cleanup could not be verified. Retry Stop before reconnecting; no unrelated share will be removed."
                return
            if self._cancel.is_set() or not self._config["autoReconnect"]:
                break
            self._phase = "retrying"
        self._phase = "stopped" if self._cancel.is_set() else "failed"
