"""Vault -> Websidian site mapping shared by the agent plugin and the dashboard extension. Standard library only.

Both processes (the Hermes agent/gateway loading ``__init__.py`` and the dashboard importing
``dashboard/plugin_api.py``) derive site slugs from the same ``vaults`` setting with :func:`normalize_vaults`,
so the links the agent shares point at the sites the dashboard serves.
"""

from __future__ import annotations

import os
import re
from typing import Any, Dict, Iterable, List, Mapping, Optional
from urllib.parse import quote, urlsplit

# Websidian is mounted at this basePath (after any dashboard URL prefix) inside the dashboard.
DASHBOARD_TAB_PATH = "/websidian"
WEBSIDIAN_MOUNT = "/api/plugins/websidian/w"

DEFAULT_PORT = 8095
DEFAULT_PUBLIC_BASE = "http://localhost:9119"
LINK_STYLES = ("dashboard", "direct")

_URI_COMPONENT_SAFE = "!*'()"


def _enc(value: str) -> str:
    return quote(str(value), safe=_URI_COMPONENT_SAFE, encoding="utf-8", errors="surrogatepass")


def as_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    s = str(value).strip().lower()
    if s in ("1", "true", "yes", "on"):
        return True
    if s in ("0", "false", "no", "off"):
        return False
    return default


def slugify(value: str) -> str:
    """Lowercase ``[a-z0-9_-]``; never starts with ``_`` (Websidian's own routes: ``/_health``, ``/_static``)."""
    s = re.sub(r"[^a-z0-9_-]+", "-", str(value or "").strip().lower())
    s = re.sub(r"-{2,}", "-", s).strip("-_")
    return s[:64].strip("-_")


def _url_slug(url: str) -> str:
    try:
        path = urlsplit(str(url)).path
    except ValueError:
        return ""
    segs = [s for s in path.split("/") if s]
    return slugify(segs[-1]) if segs else ""


def _folder_slug(path: str) -> str:
    p = str(path or "").replace("\\", "/").rstrip("/")
    return slugify(p.rsplit("/", 1)[-1]) if p else ""


def normalize_vaults(vaults: Optional[Iterable[Any]]) -> List[Dict[str, Any]]:
    """``[{path, url, slug, title, edit, untrusted}]`` with unique slugs, in the configured order.

    slug: explicit ``slug`` -> last path segment of ``url`` -> folder name -> ``vault``; duplicates get ``-2``, ``-3``...
    ``untrusted`` defaults to True and ``edit`` to True.
    """
    out: List[Dict[str, Any]] = []
    used: set = set()
    for v in vaults or ():
        if not isinstance(v, Mapping):
            continue
        path = str(v.get("path") or "").strip()
        if not path:
            continue
        url = str(v.get("url") or "").strip()
        if url and not url.endswith("/"):
            url += "/"
        base = slugify(str(v.get("slug") or "")) or _url_slug(url) or _folder_slug(path) or "vault"
        slug, n = base, 2
        while slug in used:
            slug = f"{base}-{n}"
            n += 1
        used.add(slug)
        title = str(v.get("title") or "").strip() or os.path.basename(path.replace("\\", "/").rstrip("/")) or slug
        out.append({
            "path": path, "url": url, "slug": slug, "title": title,
            "edit": as_bool(v.get("edit"), True),
            # Never let the default be False: vault text may come from the agent, web pages, tool output.
            "untrusted": as_bool(v.get("untrusted"), True),
        })
    return out


def public_prefix(public_base: str) -> str:
    """URL path prefix of the dashboard (``https://x.example/hermes`` -> ``/hermes``), no trailing slash."""
    try:
        path = urlsplit(str(public_base or "")).path
    except ValueError:
        return ""
    path = "/" + "/".join(s for s in path.split("/") if s)
    return "" if path == "/" else path


def dashboard_settings(raw: Any) -> Dict[str, Any]:
    """Normalized ``dashboard`` setting: ``{configured, port, app_dir, node, public_base}`` (``app_dir`` may be '')."""
    d = raw if isinstance(raw, Mapping) else {}
    try:
        port = int(d.get("port") or DEFAULT_PORT)
    except (TypeError, ValueError):
        port = DEFAULT_PORT
    if not 1 <= port <= 65535:
        port = DEFAULT_PORT
    public_base = str(d.get("public_base") or "").strip().rstrip("/") or DEFAULT_PUBLIC_BASE
    return {
        "configured": isinstance(raw, Mapping),
        "port": port,
        "app_dir": str(d.get("app_dir") or "").strip(),
        "node": str(d.get("node") or "node").strip() or "node",
        "public_base": public_base,
    }


def websidian_base_path(public_base: str) -> str:
    return public_prefix(public_base) + WEBSIDIAN_MOUNT


def direct_site_url(public_base: str, slug: str) -> str:
    """Websidian site base behind the dashboard: ``<public_base>/api/plugins/websidian/w/<slug>/``."""
    return str(public_base).rstrip("/") + WEBSIDIAN_MOUNT + "/" + slug + "/"


def note_param(rel: str) -> str:
    """``Folder/My Note.md`` -> ``Folder/My%20Note`` (each segment encodeURIComponent-ed, ``.md`` dropped)."""
    rel = str(rel).replace("\\", "/").strip("/")
    if rel.lower().endswith(".md"):
        rel = rel[:-3]
    return "/".join(_enc(seg) for seg in rel.split("/"))


def dashboard_note_url(public_base: str, slug: str, rel: str, edit: bool = False) -> str:
    """``<public_base>/websidian?site=<slug>&note=<rel without .md>[&edit=1]`` (the dashboard tab deep link)."""
    url = f"{str(public_base).rstrip('/')}{DASHBOARD_TAB_PATH}?site={_enc(slug)}&note={note_param(rel)}"
    return url + "&edit=1" if edit else url


def resolve_links(vaults: List[Dict[str, Any]], link_style: Any, dashboard: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """Add ``style`` (``dashboard`` | ``direct`` | ``""``), ``public_base`` and the direct ``url`` to each vault.

    - ``link_style: dashboard`` -> dashboard tab links on ``dashboard.public_base``.
    - ``link_style: direct`` -> the vault's ``url``, else ``<public_base>/api/plugins/websidian/w/<slug>/``.
    - unset: a vault with an explicit ``url`` keeps direct links to it (the original behaviour); without ``url``,
      dashboard links when the ``dashboard`` setting exists, else no links.
    """
    style_setting = str(link_style or "").strip().lower()
    style_setting = style_setting if style_setting in LINK_STYLES else ""
    public_base = dashboard.get("public_base") or DEFAULT_PUBLIC_BASE
    out = []
    for v in vaults:
        v = dict(v)
        if style_setting == "dashboard":
            v["style"] = "dashboard"
        elif style_setting == "direct":
            v["style"] = "direct"
            v["url"] = v.get("url") or direct_site_url(public_base, v["slug"])
        elif v.get("url"):
            v["style"] = "direct"
        elif dashboard.get("configured"):
            v["style"] = "dashboard"
        else:
            v["style"] = ""
        v["public_base"] = public_base
        out.append(v)
    return out
