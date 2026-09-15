"""Websidian dashboard extension backend, mounted by the Hermes dashboard at ``/api/plugins/websidian/``.

- ``GET  /status``      JSON for the tab UI (server state, sites, log tail when down).
- ``*    /w/{path}``    reverse proxy to the dashboard-managed Websidian server on 127.0.0.1, which is itself mounted
                        at ``<dashboard prefix>/api/plugins/websidian/w`` so all of its URLs are already correct.

Every route here sits behind the dashboard's auth gate (``/api/plugins/*`` is never public), so the dashboard
login is the only login: the proxy signs requests in to Websidian with a shared secret header (``proxyAuth``).
Pure logic lives in ``wsd_core.py``.
"""

from __future__ import annotations

import asyncio
import importlib.util
import logging
import os
import sys
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse

_log = logging.getLogger(__name__)


def _load_core():
    name = "hermes_websidian_dashboard_core"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parent / "wsd_core.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


core = _load_core()

router = APIRouter()
supervisor = core.Supervisor(core.read_plugin_settings)

_client = None
_ensure_task: Optional[asyncio.Future] = None
PROXY_METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"]


def _http_client():
    global _client
    if _client is None:
        import httpx
        _client = httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=3.0), follow_redirects=False,
                                    limits=httpx.Limits(max_connections=64, max_keepalive_connections=16))
    return _client


def _kick_ensure() -> None:
    """Run ``supervisor.ensure()`` in a worker thread unless one is already running."""
    global _ensure_task
    if _ensure_task is not None and not _ensure_task.done():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    _ensure_task = loop.run_in_executor(None, supervisor.ensure)


def _dashboard_user(request: Request) -> str:
    session = getattr(request.state, "session", None)
    for attr in ("display_name", "user_id", "email"):
        value = getattr(session, attr, "") if session is not None else ""
        if value:
            return str(value)
    principal = getattr(request.state, "token_principal", None)
    if principal is not None and getattr(principal, "principal", ""):
        return str(principal.principal)
    return "hermes"


@router.get("/status")
async def status() -> Any:
    st = await asyncio.to_thread(supervisor.status)
    if not st["running"]:
        _kick_ensure()
    return st


@router.api_route("/w", methods=PROXY_METHODS)
async def proxy_root(request: Request) -> Any:
    rt = supervisor.runtime or await asyncio.to_thread(supervisor._runtime)
    return RedirectResponse(url=rt["base_path"] + "/", status_code=302)


@router.api_route("/w/{path:path}", methods=PROXY_METHODS)
async def proxy(request: Request, path: str = "") -> Any:
    import httpx

    rt = supervisor.runtime or await asyncio.to_thread(supervisor._runtime)
    raw_path = request.scope.get("raw_path")
    raw_path = raw_path.decode("latin-1") if isinstance(raw_path, (bytes, bytearray)) else request.url.path
    # Under a reverse proxy that strips a prefix (X-Forwarded-Prefix), the dashboard sees the path without it;
    # Websidian is mounted with the prefix (from dashboard.public_base), so put it back.
    mount = core.sites.WEBSIDIAN_MOUNT
    idx = raw_path.find(mount)
    if idx < 0:
        return JSONResponse({"detail": "Bad path"}, status_code=400)
    target = core.upstream_target(rt["base_path"][: -len(mount)] + raw_path[idx:], request.url.query, rt["base_path"])
    if target is None:
        return JSONResponse({"detail": "Bad path"}, status_code=400)

    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > core.MAX_BODY_BYTES:
        return JSONResponse({"detail": "Request body too large"}, status_code=413)
    body = b""
    if request.method not in ("GET", "HEAD"):
        chunks, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > core.MAX_BODY_BYTES:
                return JSONResponse({"detail": "Request body too large"}, status_code=413)
            chunks.append(chunk)
        body = b"".join(chunks)

    secrets = await asyncio.to_thread(supervisor.secrets, rt)
    headers = core.filter_request_headers(request.headers.items(), secrets["proxy_secret"], _dashboard_user(request))
    client = _http_client()
    upstream = client.build_request(request.method, f"http://127.0.0.1:{rt['port']}{target}", headers=headers,
                                    content=body if body else None)
    try:
        resp = await client.send(upstream, stream=True)
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.RemoteProtocolError, httpx.ReadError) as exc:
        _kick_ensure()
        tail = await asyncio.to_thread(core.tail_lines, rt["log_path"], 20)
        page = core.error_page(502, "Websidian is not running",
                               f"The dashboard could not reach Websidian on 127.0.0.1:{rt['port']} ({type(exc).__name__}). "
                               "A restart has been requested; this page retries in 5 seconds. "
                               f"{supervisor.last_error or ''}".strip(), tail, refresh=5 if request.method == "GET" else 0)
        return HTMLResponse(page, status_code=502, headers={"cache-control": "no-store"})
    except httpx.TimeoutException:
        return HTMLResponse(core.error_page(504, "Websidian timed out", "Websidian did not answer in time."),
                            status_code=504, headers={"cache-control": "no-store"})

    out_headers = dict(core.filter_response_headers(resp.headers.items()))
    if request.method == "HEAD" or resp.status_code in (204, 304):
        await resp.aclose()
        return Response(status_code=resp.status_code, headers=out_headers)

    async def body_iter():
        try:
            async for chunk in resp.aiter_raw():
                yield chunk
        finally:
            await resp.aclose()

    return StreamingResponse(body_iter(), status_code=resp.status_code, headers=out_headers)


def _autostart() -> None:
    if os.environ.get("WEBSIDIAN_DASHBOARD_AUTOSTART", "1").strip().lower() in ("0", "false", "no", "off"):
        return
    try:
        supervisor.start_background()
    except Exception as exc:  # never break the dashboard's startup
        _log.warning("websidian: could not start the supervisor: %s", exc)


_autostart()
