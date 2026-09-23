"""Websidian dashboard extension: config generation, secrets, proxy header rules and the Node supervisor.

Standard library only (no FastAPI, no Hermes imports) so it can be unit-tested anywhere; ``plugin_api.py`` wires
it into the dashboard. It imports ``sites.py`` from the plugin root by file path (the dashboard loads
``plugin_api.py`` with ``importlib.util.spec_from_file_location``, so package-relative imports do not work).
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import secrets as _secrets
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path
from typing import Any, Callable, Deque, Dict, Iterable, List, Mapping, Optional, Tuple

HERE = Path(__file__).resolve().parent
PLUGIN_DIR = HERE.parent


def _load_sites():
    name = "hermes_websidian_sites"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, PLUGIN_DIR / "sites.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


sites = _load_sites()

PROXY_SECRET_HEADER = "x-websidian-proxy-secret"
PROXY_USER_HEADER = "x-websidian-user"
LOOPBACK = ["127.0.0.1", "::1"]
MAX_BODY_BYTES = 20 * 1024 * 1024

# Request headers forwarded to Websidian. Everything else is dropped: cookie and authorization (the dashboard's
# session), x-forwarded-*, and any client-supplied x-websidian-* header.
REQUEST_HEADER_ALLOWLIST = frozenset({
    "content-type", "accept", "accept-language", "if-none-match", "if-modified-since", "range",
    "x-requested-with", "user-agent",
})
# Response headers passed back to the browser. Set-Cookie is never forwarded.
RESPONSE_HEADER_ALLOWLIST = frozenset({
    "content-type", "content-length", "etag", "last-modified", "cache-control", "content-security-policy",
    "x-content-type-options", "location", "retry-after", "content-disposition", "accept-ranges",
    "content-range", "x-render",
})


# --------------------------------------------------------------------------------------------------
# Paths and settings
# --------------------------------------------------------------------------------------------------

def hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home  # type: ignore
        return Path(get_hermes_home())
    except Exception:
        val = (os.environ.get("HERMES_HOME") or "").strip()
        return Path(val) if val else Path.home() / ".hermes"


def data_dir(home: Optional[Path] = None) -> Path:
    return (home or hermes_home()) / "plugin-data" / "websidian"


def read_plugin_settings() -> Dict[str, Any]:
    """``plugins.entries.websidian.settings`` through Hermes's own config loader (read-only, mtime-cached)."""
    try:
        from hermes_cli.config import load_config_readonly as _load  # type: ignore
    except Exception:
        from hermes_cli.config import load_config as _load  # type: ignore
    cfg = _load() or {}
    entry = ((cfg.get("plugins") or {}).get("entries") or {}).get("websidian") or {}
    settings = entry.get("settings")
    if not isinstance(settings, Mapping):
        settings = entry.get("config") if isinstance(entry.get("config"), Mapping) else {}
    return json.loads(json.dumps(settings, default=str))  # detach from the loader's cache


def read_memory_limits() -> Dict[str, Any]:
    """Hermes's ``memory`` section (``memory_char_limit``, ``user_char_limit``), or ``{}``."""
    try:
        try:
            from hermes_cli.config import load_config_readonly as _load  # type: ignore
        except Exception:
            from hermes_cli.config import load_config as _load  # type: ignore
        mem = (_load() or {}).get("memory") or {}
    except Exception:
        return {}
    return {k: mem[k] for k in ("memory_char_limit", "user_char_limit") if isinstance(mem.get(k), int)}


# The agent panel beside a note in the dashboard tab. ``agents: true`` offers these, Hermes first (the one whose
# memory and skills the tab shows); an agent whose CLI is not installed or does not answer is left out at start.
DEFAULT_AGENTS = [
    {"id": "hermes", "backend": "hermes-cli"},
    {"id": "claude", "backend": "claude-cli"},
    {"id": "codex", "backend": "codex-cli"},
]
AGENT_BACKENDS = ("hermes-cli", "claude-cli", "codex-cli", "openclaw-cli")
# Claude Code and Codex answer on their own OAuth sign-ins (claude.ai, ChatGPT), never on an API key the
# dashboard inherited from Hermes's .env: these are taken out of their environment (confirmed by the user).
OAUTH_ONLY_UNSET = {
    "claude-cli": ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_TOKEN", "ANTHROPIC_BASE_URL"],
    "codex-cli": ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"],
}


def find_cli(name: str) -> str:
    """The full path of an agent CLI, or "" (Websidian then tries the bare name on its own PATH).

    The dashboard often runs with a bare PATH that lacks ``~/.local/bin``, where Hermes installs itself and
    where it puts ``claude`` and ``codex`` (found so in ``hermes01``), so that folder is looked in as well.
    """
    import shutil
    found = shutil.which(name)
    if found:
        return found
    for folder in (Path.home() / ".local" / "bin", Path("/usr/local/bin")):
        p = folder / name
        if p.is_file() and os.access(p, os.X_OK):
            return str(p)
    return ""


def agents_settings(raw: Any, data: Path) -> Optional[Dict[str, Any]]:
    """Websidian's ``agents`` config from the plugin's ``agents`` setting, or ``None`` (the default: off).

    ``true`` means Hermes, Claude Code and Codex. A mapping may give ``list`` (Websidian's agent entries),
    ``sessionScope`` (``vault``, the default here: one conversation per vault that is told which note is open,
    or ``note``) and ``timeoutMs``. Only Review mode is ever reachable from the tab.
    """
    if raw is True:
        raw = {}
    if not isinstance(raw, Mapping) or raw.get("enabled") is False:
        return None
    items = raw.get("list") if isinstance(raw.get("list"), list) else DEFAULT_AGENTS
    agent_list = []
    for a in items:
        if isinstance(a, str):
            a = {"id": a, "backend": a if a.endswith("-cli") else a + "-cli"}
        if not isinstance(a, Mapping) or str(a.get("backend") or "") not in AGENT_BACKENDS:
            continue
        entry = {**json.loads(json.dumps(dict(a), default=str)), "modes": ["review"]}  # review only from the dashboard
        unset = OAUTH_ONLY_UNSET.get(str(entry["backend"]))
        if unset and "envUnset" not in entry:
            entry["envUnset"] = list(unset)
        if not entry.get("command"):
            found = find_cli(str(entry["backend"]).replace("-cli", ""))
            if found:
                entry["command"] = found
                # Found off the PATH: give the agent that folder too, for the tools it starts itself.
                folder = str(Path(found).parent)
                path = os.environ.get("PATH", "")
                if folder not in path.split(os.pathsep):
                    entry["env"] = {**(entry.get("env") or {}), "PATH": path + os.pathsep + folder if path else folder}
        agent_list.append(entry)
    if not agent_list:
        return None
    out: Dict[str, Any] = {
        "list": agent_list,
        "sessionScope": "note" if raw.get("sessionScope") == "note" else "vault",
        "stateFile": str(data / "agent-sessions.json"),
    }
    if isinstance(raw.get("timeoutMs"), int) and raw["timeoutMs"] > 0:
        out["timeoutMs"] = raw["timeoutMs"]
    return out


def resolve_runtime(settings: Mapping[str, Any], home: Optional[Path] = None) -> Dict[str, Any]:
    """Everything the supervisor needs, derived from plugin settings."""
    dash = sites.dashboard_settings(settings.get("dashboard"))
    ddir = data_dir(home)
    app_dir = Path(os.path.expanduser(dash["app_dir"])) if dash["app_dir"] else ddir / "app"
    return {
        "data_dir": ddir, "app_dir": app_dir, "node": dash["node"], "port": dash["port"],
        "public_base": dash["public_base"], "base_path": sites.websidian_base_path(dash["public_base"]),
        "config_path": ddir / "websidian.config.json", "log_path": ddir / "server.log",
        "pid_path": ddir / "server.pid", "secrets_path": ddir / "secrets.json",
        "sites": sites.normalize_vaults(settings.get("vaults") if isinstance(settings.get("vaults"), list) else []),
        "agents": agents_settings(settings.get("agents"), ddir),
    }


# --------------------------------------------------------------------------------------------------
# Secrets and the generated Websidian config
# --------------------------------------------------------------------------------------------------

def _write_private(path: Path, text: str) -> None:
    """Atomic write with mode 0600 (where the OS supports it)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="." + path.name + ".", dir=str(path.parent))
    try:
        try:
            os.fchmod(fd, 0o600)
        except (AttributeError, OSError):
            pass
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def load_or_create_secrets(path: Path) -> Dict[str, str]:
    """``{proxy_secret, edit_secret, site_token}``, generated once (64 url-safe chars each) and kept in ``path``."""
    data: Dict[str, str] = {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            data = {k: v for k, v in raw.items() if isinstance(v, str)}
    except (OSError, ValueError):
        pass
    changed = False
    for key in ("proxy_secret", "edit_secret", "site_token"):
        if len(data.get(key, "")) < 48:
            data[key] = _secrets.token_urlsafe(48)
            changed = True
    if changed or not path.exists():
        _write_private(path, json.dumps(data, indent=2) + "\n")
    return data


def build_config(runtime: Mapping[str, Any], secrets: Mapping[str, str]) -> Dict[str, Any]:
    """The Websidian config for the dashboard-managed server (bound to loopback, proxy sign-in only)."""
    site_list = []
    for s in runtime["sites"]:
        site: Dict[str, Any] = {
            "slug": s["slug"], "title": s["title"],
            "root": os.path.abspath(os.path.expanduser(s["path"])),
            "untrusted": bool(s["untrusted"]),
            # Defence in depth for other local processes: only the proxy (which passes proxyAuth) gets in.
            "auth": {"token": secrets["site_token"]},
        }
        site["edit"] = {"allowFrom": list(LOOPBACK), "secret": secrets["edit_secret"]} if s["edit"] else False
        # "readers": the dashboard's signed-in user may ask an agent about a note, Review only, editable or not.
        if runtime.get("agents"):
            site["agents"] = "readers" if s.get("agents", True) else False
        site_list.append(site)
    cfg: Dict[str, Any] = {
        "host": "127.0.0.1",
        "port": int(runtime["port"]),
        "basePath": runtime["base_path"],
        "publicUrl": runtime["public_base"],
        "cacheDir": str(Path(runtime["data_dir"]) / "cache"),
        "warm": False,
        "proxyAuth": {
            "secret": secrets["proxy_secret"], "secretHeader": PROXY_SECRET_HEADER,
            "userHeader": PROXY_USER_HEADER, "allowFrom": list(LOOPBACK),
        },
        "sites": site_list,
    }
    if runtime.get("agents"):
        cfg["agents"] = runtime["agents"]
    return cfg


def config_text(cfg: Mapping[str, Any]) -> str:
    return json.dumps(cfg, indent=2, ensure_ascii=False, sort_keys=True) + "\n"


def write_config_if_changed(path: Path, cfg: Mapping[str, Any]) -> bool:
    """Write atomically (0600: it holds secrets). True when the content changed."""
    text = config_text(cfg)
    try:
        if path.read_text(encoding="utf-8") == text:
            return False
    except OSError:
        pass
    _write_private(path, text)
    return True


# --------------------------------------------------------------------------------------------------
# Proxy rules (pure)
# --------------------------------------------------------------------------------------------------

def filter_request_headers(headers: Iterable[Tuple[str, str]], secret: str, user: str) -> List[Tuple[str, str]]:
    out = [(k.lower(), v) for k, v in headers if k.lower() in REQUEST_HEADER_ALLOWLIST]
    out.append(("accept-encoding", "identity"))  # bodies are streamed through unchanged
    out.append((PROXY_SECRET_HEADER, secret))
    out.append((PROXY_USER_HEADER, clean_user(user)))
    return out


def filter_response_headers(headers: Iterable[Tuple[str, str]], head: bool = False) -> List[Tuple[str, str]]:
    return [(k.lower(), v) for k, v in headers if k.lower() in RESPONSE_HEADER_ALLOWLIST]


def clean_user(user: Any) -> str:
    u = re.sub(r"[^A-Za-z0-9 ._@-]", "", str(user or "")).strip()[:64].strip()
    return u or "hermes"


_DOT_SEGMENT = re.compile(r"(^|/)(\.|%2e){1,2}(/|$)", re.I)


def upstream_target(raw_path: str, query: str, base_path: str) -> Optional[str]:
    """Path + query to request from Websidian for a dashboard request whose raw (still percent-encoded) path is
    ``raw_path``. ``None`` when the request must be refused: not under ``base_path``, dot segments (which an HTTP
    client would normalise out of the mount), encoded slashes/backslashes/NULs, or control characters."""
    if not isinstance(raw_path, str) or any(ord(c) < 0x21 or c in "#\\" for c in raw_path + (query or "")):
        return None
    if raw_path != base_path and not raw_path.startswith(base_path + "/"):
        return None
    rest = raw_path[len(base_path):]
    if _DOT_SEGMENT.search(rest) or re.search(r"%(2f|5c|00)", rest, re.I):
        return None
    return raw_path + ("?" + query if query else "")


def error_page(status: int, title: str, message: str, log_tail: Iterable[str] = (), refresh: int = 0) -> str:
    import html
    tail = "".join(html.escape(line) for line in log_tail)
    meta = f'<meta http-equiv="refresh" content="{int(refresh)}">' if refresh else ""
    return (f"<!doctype html><html><head><meta charset=utf-8>{meta}<title>{html.escape(title)}</title>"
            "<style>body{font:14px/1.5 system-ui,sans-serif;margin:2rem;color:#ddd;background:#111}"
            "pre{white-space:pre-wrap;background:#000;padding:1rem;max-height:50vh;overflow:auto}</style></head>"
            f"<body><h1>{status} {html.escape(title)}</h1><p>{html.escape(message)}</p>"
            + (f"<pre>{tail}</pre>" if tail else "") + "</body></html>")


def tail_lines(path: Path, n: int = 20, max_bytes: int = 64_000) -> List[str]:
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - max_bytes))
            data = fh.read().decode("utf-8", errors="replace")
    except OSError:
        return []
    lines = data.splitlines(keepends=True)
    return lines[-n:]


# --------------------------------------------------------------------------------------------------
# Install stamps
# --------------------------------------------------------------------------------------------------

VERSION_FILE = "websidian.version"


def read_version_stamp(path: Any) -> Optional[Dict[str, Any]]:
    """``{revision, installed_at, source, component}`` written by the installers, or ``None``.

    A git checkout has no stamp, and a hand-copied install may not either, so ``None`` means "unknown" and
    is never an error.
    """
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def version_skew(app: Optional[Mapping[str, Any]], plugin: Optional[Mapping[str, Any]]) -> bool:
    """True only when both stamps name a revision and the two differ.

    The plugin (Python, loaded by the gateway and the dashboard) and the runtime (Node, under ``app_dir``)
    are installed as separate copies, so half an upgrade leaves them on different revisions with no other
    symptom. An unknown revision on either side never raises the alarm.
    """
    a = str((app or {}).get("revision") or "")
    p = str((plugin or {}).get("revision") or "")
    return bool(a and p and a != p)


# --------------------------------------------------------------------------------------------------
# Supervisor
# --------------------------------------------------------------------------------------------------

def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    try:  # a zombie (our exited child not reaped yet) is not alive
        with open(f"/proc/{pid}/stat", "rb") as fh:
            if fh.read().split(b")")[-1].split()[0] == b"Z":
                return False
    except (OSError, IndexError):
        pass
    return True


def _pid_is_websidian(pid: int, server_js: str) -> bool:
    """Guard against PID reuse before signalling a PID read from the PID file."""
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as fh:
            argv = fh.read().split(b"\0")
    except OSError:
        return os.name != "posix" and _pid_alive(pid)  # no /proc: trust the PID file
    return any(a.decode("utf-8", "replace") == server_js for a in argv)


class Supervisor:
    """Keeps one Websidian Node process running for the dashboard.

    - ``ensure()`` (blocking; call it from a thread): regenerate the config from settings, restart the process
      when the config changed, spawn it when ``/_health`` does not answer, with a restart budget
      (``max_starts`` per ``window`` seconds) and exponential backoff between consecutive failed starts.
    - The process runs in its own session with stdout/stderr appended to ``server.log``; its PID is kept in
      ``server.pid`` so a restarted dashboard can adopt (and later restart) it.
    """

    def __init__(self, settings_loader: Callable[[], Mapping[str, Any]], home: Optional[Path] = None,
                 max_starts: int = 5, window: float = 60.0, startup_timeout: float = 20.0):
        self.settings_loader = settings_loader
        self.home = home
        self.max_starts = max_starts
        self.window = window
        self.startup_timeout = startup_timeout
        self._lock = threading.RLock()
        self._secrets_lock = threading.Lock()
        self._secrets_cache: Optional[Tuple[str, Dict[str, str]]] = None
        self._starts: Deque[float] = deque()
        self._failures = 0
        self._next_allowed = 0.0
        self._proc: Optional[subprocess.Popen] = None
        self.runtime: Optional[Dict[str, Any]] = None
        self.last_error = ""
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # -- helpers ----------------------------------------------------------------------------------
    def _runtime(self) -> Dict[str, Any]:
        rt = resolve_runtime(self.settings_loader() or {}, self.home)
        self.runtime = rt
        return rt

    def health(self, rt: Optional[Mapping[str, Any]] = None, timeout: float = 1.5) -> Optional[Dict[str, Any]]:
        rt = rt or self.runtime or self._runtime()
        url = f"http://127.0.0.1:{rt['port']}{rt['base_path']}/_health"
        try:
            with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310 - loopback URL we built
                if resp.status != 200:
                    return None
                data = json.loads(resp.read(65536).decode("utf-8"))
                return data if isinstance(data, dict) and data.get("ok") else None
        except (OSError, ValueError, urllib.error.URLError):
            return None

    def pid(self, rt: Optional[Mapping[str, Any]] = None) -> Optional[int]:
        rt = rt or self.runtime or self._runtime()
        if self._proc is not None and self._proc.poll() is None:
            return self._proc.pid
        try:
            pid = int(Path(rt["pid_path"]).read_text().strip())
        except (OSError, ValueError):
            return None
        server_js = str(Path(rt["app_dir"]) / "src" / "server.js")
        return pid if _pid_alive(pid) and _pid_is_websidian(pid, server_js) else None

    def secrets(self, rt: Optional[Mapping[str, Any]] = None) -> Dict[str, str]:
        rt = rt or self.runtime or self._runtime()
        path = Path(rt["secrets_path"])
        with self._secrets_lock:
            cached = self._secrets_cache
            if cached and cached[0] == str(path):
                return cached[1]
            data = load_or_create_secrets(path)
            self._secrets_cache = (str(path), data)
            return data

    # -- lifecycle --------------------------------------------------------------------------------
    def ensure(self) -> Dict[str, Any]:
        with self._lock:
            rt = self._runtime()
            if not rt["sites"]:
                self.last_error = "no vaults configured (plugins.entries.websidian.settings.vaults)"
                return {"running": False, "error": self.last_error}
            server_js = Path(rt["app_dir"]) / "src" / "server.js"
            if not server_js.is_file():
                self.last_error = f"Websidian is not installed: {server_js} not found (run deploy/install-into-container.sh)"
                return {"running": False, "error": self.last_error}
            cfg = build_config(rt, self.secrets(rt))
            changed = write_config_if_changed(Path(rt["config_path"]), cfg)
            healthy = self.health(rt)
            if changed and self.pid(rt):
                self._terminate(rt)
                healthy = None
            if healthy:
                self._failures = 0
                self.last_error = ""
                return {"running": True, "pid": self.pid(rt)}
            if self.pid(rt):  # started but not answering yet (or wedged): give it time, then replace it
                if self._wait_healthy(rt, self.startup_timeout / 2):
                    return {"running": True, "pid": self.pid(rt)}
                self._terminate(rt)
            return self._spawn(rt)

    def _wait_healthy(self, rt: Mapping[str, Any], timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.health(rt, timeout=1.0):
                return True
            if self._proc is not None and self._proc.poll() is not None:
                return False
            time.sleep(0.25)
        return False

    def _spawn(self, rt: Mapping[str, Any]) -> Dict[str, Any]:
        now = time.monotonic()
        while self._starts and now - self._starts[0] > self.window:
            self._starts.popleft()
        if len(self._starts) >= self.max_starts or now < self._next_allowed:
            wait = max(self._next_allowed - now, (self._starts[0] + self.window - now) if len(self._starts) >= self.max_starts else 0)
            self.last_error = f"Websidian keeps failing to start; next attempt in {int(wait) + 1}s (see server.log)"
            return {"running": False, "error": self.last_error}
        self._starts.append(now)
        app_dir = Path(rt["app_dir"])
        Path(rt["data_dir"]).mkdir(parents=True, exist_ok=True)
        env = dict(os.environ)
        for k in ("MD2HTML_CONFIG", "NODE_OPTIONS"):
            env.pop(k, None)
        env.update({"WEBSIDIAN_CONFIG": str(rt["config_path"]), "HOST": "127.0.0.1", "PORT": str(rt["port"]),
                    "NODE_ENV": "production"})
        log = open(rt["log_path"], "ab")
        try:
            log.write(f"\n[{time.strftime('%Y-%m-%dT%H:%M:%S')}] websidian-dashboard: starting {rt['node']} "
                      f"{app_dir / 'src' / 'server.js'} on 127.0.0.1:{rt['port']}\n".encode())
            log.flush()
            kwargs: Dict[str, Any] = {}
            if os.name == "posix":
                kwargs["start_new_session"] = True
            self._proc = subprocess.Popen([rt["node"], str(app_dir / "src" / "server.js")], cwd=str(app_dir), env=env,
                                          stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, **kwargs)
        except OSError as exc:
            self._failed(f"cannot start {rt['node']}: {exc}")
            return {"running": False, "error": self.last_error}
        finally:
            log.close()
        try:
            _write_private(Path(rt["pid_path"]), f"{self._proc.pid}\n")
        except OSError:
            pass
        if self._wait_healthy(rt, self.startup_timeout):
            self._failures = 0
            self.last_error = ""
            return {"running": True, "pid": self._proc.pid, "started": True}
        code = self._proc.poll()
        self._failed(f"Websidian exited with code {code}" if code is not None else
                     f"Websidian did not answer {rt['base_path']}/_health within {int(self.startup_timeout)}s")
        if code is None:
            self._terminate(rt)
        return {"running": False, "error": self.last_error}

    def _failed(self, message: str) -> None:
        self._failures += 1
        self._next_allowed = time.monotonic() + min(60.0, 2.0 ** (self._failures - 1))
        self.last_error = message

    def _terminate(self, rt: Mapping[str, Any], timeout: float = 5.0) -> None:
        pid = self.pid(rt)
        if not pid:
            return
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            return
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._proc is not None and self._proc.pid == pid:
                if self._proc.poll() is not None:
                    break
            elif not _pid_alive(pid):
                break
            time.sleep(0.1)
        else:
            try:
                os.kill(pid, getattr(signal, "SIGKILL", signal.SIGTERM))
            except OSError:
                pass
        if self._proc is not None and self._proc.pid == pid:
            try:
                self._proc.wait(timeout=2)
            except Exception:
                pass
            self._proc = None
        try:
            Path(rt["pid_path"]).unlink()
        except OSError:
            pass

    def stop(self) -> None:
        with self._lock:
            self._terminate(self.runtime or self._runtime())

    def start_background(self, interval: float = 15.0) -> None:
        """Daemon thread: ``ensure()`` now, then every ``interval`` seconds (config changes, crashes)."""
        if self._thread and self._thread.is_alive():
            return

        def loop() -> None:
            while not self._stop.is_set():
                try:
                    self.ensure()
                except Exception as exc:  # never let the monitor die
                    self.last_error = f"supervisor error: {type(exc).__name__}: {exc}"
                self._stop.wait(interval)

        self._thread = threading.Thread(target=loop, name="websidian-supervisor", daemon=True)
        self._thread.start()

    def stop_background(self) -> None:
        self._stop.set()

    # -- status -----------------------------------------------------------------------------------
    def status(self) -> Dict[str, Any]:
        rt = self._runtime()
        health = self.health(rt)
        server_js = Path(rt["app_dir"]) / "src" / "server.js"
        app_version = read_version_stamp(Path(rt["app_dir"]) / VERSION_FILE)
        plugin_version = read_version_stamp(PLUGIN_DIR / VERSION_FILE)
        return {
            "running": bool(health),
            "pid": self.pid(rt),
            "port": rt["port"],
            "base_path": rt["base_path"],
            "public_base": rt["public_base"],
            "sites": [{"slug": s["slug"], "title": s["title"], "root": s["path"], "edit": s["edit"],
                       "untrusted": s["untrusted"], "url": f"{rt['base_path']}/{s['slug']}/"} for s in rt["sites"]],
            "app_dir": str(rt["app_dir"]),
            "app_dir_present": server_js.is_file(),
            "app_version": app_version,
            "plugin_version": plugin_version,
            "version_skew": version_skew(app_version, plugin_version),
            "node": rt["node"],
            "node_version": node_version(rt["node"]),
            "error": "" if health else self.last_error,
            "log_tail": [] if health else tail_lines(Path(rt["log_path"]), 20),
        }


_node_versions: Dict[str, str] = {}


def node_version(node: str) -> str:
    if node not in _node_versions:
        try:
            out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=5)
            _node_versions[node] = out.stdout.strip() or out.stderr.strip()
        except (OSError, subprocess.SubprocessError) as exc:
            return f"unavailable ({exc})"
    return _node_versions[node]
