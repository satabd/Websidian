"""Websidian URL building and vault listing for the websidian Hermes plugin. Pure, standard library only.

A note ``<vault>/Folder/My Note.md`` served at ``https://brain.example.com/hermes/`` has
view URL ``https://brain.example.com/hermes/Folder/My%20Note`` and
edit URL ``https://brain.example.com/hermes/_edit/Folder/My%20Note`` (Websidian's ``vault.noteUrl``:
``rel.replace(/\\.md$/i, '').split('/').map(encodeURIComponent).join('/')``).

With the ``dashboard`` link style the links open the note in the Hermes dashboard's Websidian tab instead:
``<public_base>/websidian?site=<slug>&note=Folder/My%20Note`` (``&edit=1`` for the editor); see sites.py.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple
from urllib.parse import quote

try:  # imported as part of the plugin package
    from . import sites
except ImportError:  # loaded as a top-level module (tests / ad-hoc use)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import sites  # type: ignore  # noqa: E402

# encodeURIComponent leaves A-Z a-z 0-9 - _ . ! ~ * ' ( ) unescaped; quote() always keeps letters,
# digits and "_.-~", so adding "!*'()" reproduces it exactly (UTF-8 percent-encoding for the rest).
_URI_COMPONENT_SAFE = "!*'()"


def encode_uri_component(value: str) -> str:
    """Python equivalent of JavaScript's ``encodeURIComponent``."""
    return quote(str(value), safe=_URI_COMPONENT_SAFE, encoding="utf-8", errors="surrogatepass")


def _norm(path: str) -> str:
    return os.path.normcase(os.path.realpath(os.path.normpath(os.path.expanduser(str(path))))).replace("\\", "/").rstrip("/")


def relative_note_path(path: str, vault_path: str, base: Optional[str] = None) -> Optional[str]:
    """Vault-relative path with forward slashes, or ``None`` when ``path`` is outside the vault.
    Accepts Windows backslash paths, ``~`` and paths relative to ``base``."""
    p = os.path.expanduser(str(path))
    if not os.path.isabs(p) and not _looks_windows_abs(p):
        p = os.path.join(base or os.getcwd(), p)
    root_norm, full_norm = _norm(vault_path), _norm(p)
    if not (full_norm + "/").startswith(root_norm + "/") or full_norm == root_norm:
        return None
    # Keep the caller's spelling (case) of the part below the root.
    full = os.path.realpath(os.path.normpath(p)).replace("\\", "/")
    rel = full[len(full) - (len(full_norm) - len(root_norm)):].lstrip("/")
    return rel or None


def _looks_windows_abs(p: str) -> bool:
    return len(p) > 2 and p[1] == ":" and p[2] in "\\/"


def note_rel_to_url_path(rel: str) -> str:
    rel = str(rel).replace("\\", "/").strip("/")
    if rel.lower().endswith(".md"):
        rel = rel[:-3]
    return "/".join(encode_uri_component(seg) for seg in rel.split("/"))


def view_url(base_url: str, rel: str) -> str:
    base = base_url if base_url.endswith("/") else base_url + "/"
    return base + note_rel_to_url_path(rel)


def edit_url(base_url: str, rel: str) -> str:
    base = base_url if base_url.endswith("/") else base_url + "/"
    return base + "_edit/" + note_rel_to_url_path(rel)


def note_links(vault: Mapping[str, Any], rel: str) -> Tuple[str, str]:
    """``(view, edit)`` for ``rel`` in ``vault`` following its link ``style`` (see ``sites.resolve_links``):
    ``dashboard`` -> ``<public_base>/websidian?site=<slug>&note=<rel>[&edit=1]``; otherwise the direct Websidian
    ``url`` (``<url><note>`` and ``<url>_edit/<note>``); ``("", "")`` without either."""
    if vault.get("style") == "dashboard" and vault.get("slug"):
        base = vault.get("public_base") or sites.DEFAULT_PUBLIC_BASE
        # The dashboard serves this site itself, so a vault with ``edit: false`` (the default) gets no edit
        # link: it would open an editor the site refuses. An external ``url`` is somebody else's Websidian,
        # whose own config decides, so direct links below keep both.
        edit = sites.dashboard_note_url(base, vault["slug"], rel, edit=True) if vault.get("edit") else ""
        return sites.dashboard_note_url(base, vault["slug"], rel), edit
    url = vault.get("url")
    if url:
        return view_url(url, rel), edit_url(url, rel)
    return "", ""


def is_note_rel(rel: str) -> bool:
    """A ``.md`` note Websidian serves: not inside a dot-folder (``.obsidian``, ``.trash``, ``.git``)."""
    parts = str(rel).replace("\\", "/").split("/")
    return parts[-1].lower().endswith(".md") and not any(part.startswith(".") for part in parts)


def links_for_path(path: str, vaults: Iterable[Mapping[str, Any]], base: Optional[str] = None) -> Optional[Dict[str, str]]:
    """``{path, rel, title, view, edit}`` for a note inside one of ``vaults`` (``{path, url}``), else ``None``."""
    for vault in vaults:
        vpath = vault.get("path")
        if not vpath:
            continue
        rel = relative_note_path(path, vpath, base)
        if rel is None:
            continue
        if not is_note_rel(rel):
            return None
        entry = {"path": str(path), "rel": rel, "title": os.path.splitext(rel.rsplit("/", 1)[-1])[0],
                 "vault": str(vpath), "view": "", "edit": ""}
        entry["view"], entry["edit"] = note_links(vault, rel)
        return entry
    return None


def format_links_block(entries: List[Mapping[str, str]], heading: str = "Notes updated:") -> str:
    lines = [heading]
    for e in entries:
        if e.get("view"):
            name = e['rel'][:-3] if e['rel'].lower().endswith('.md') else e['rel']
            lines.append(f"- {name}: {e['view']}" + (f" (edit: {e['edit']})" if e.get("edit") else ""))
        else:
            lines.append(f"- {e['rel']} (no url configured for this vault)")
    return "\n".join(lines)


def recent_notes(vaults: Iterable[Mapping[str, Any]], query: str = "", limit: int = 10) -> List[Dict[str, Any]]:
    """Most recently modified ``.md`` notes across ``vaults`` (dot-folders skipped), optionally filtered by a
    case-insensitive filename substring."""
    q = (query or "").strip().lower()
    found: List[Dict[str, Any]] = []
    for vault in vaults:
        root = vault.get("path")
        if not root:
            continue
        root = os.path.expanduser(str(root))
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for name in filenames:
                if name.startswith(".") or not name.lower().endswith(".md"):
                    continue
                if q and q not in name.lower():
                    continue
                full = os.path.join(dirpath, name)
                try:
                    mtime = os.path.getmtime(full)
                except OSError:
                    continue
                rel = os.path.relpath(full, root).replace("\\", "/")
                view, edit = note_links(vault, rel)
                found.append({"path": full, "rel": rel, "mtime": mtime, "view": view, "edit": edit})
    found.sort(key=lambda e: e["mtime"], reverse=True)
    return found[: max(0, int(limit))]
