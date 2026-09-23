"""The model behind the Websidian dashboard tab: what is in each vault, read from disk on every call.

Standard library only (no FastAPI, no Hermes imports), so it unit-tests anywhere; ``plugin_api.py`` serves it as
``GET /api/plugins/websidian/overview``.

- Nothing is copied, cached or indexed: every call reads the folders again, with bounded walks and bounded reads,
  so a large skills folder cannot hold the dashboard.
- Only vault-relative paths and same-origin URLs leave this module. The browser never sees a filesystem path
  except the vault roots the status route already shows.
- Everything here is plain text for the tab to set as text. Nothing an agent wrote is ever meant to be markup.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional
from urllib.parse import quote

# Hermes keeps its memory in two files under <home>/memories, entries separated by a line holding "§"
# (tools/memory_tool.py ENTRY_DELIMITER), and each file has a character budget (memory.memory_char_limit /
# memory.user_char_limit, default 2200 / 1375).
MEMORY_FILES = (
    {"id": "memory", "file": "MEMORY.md", "label": "Agent notes", "note": "What Hermes keeps about its work and your setup.",
     "limit_key": "memory_char_limit", "limit": 2200},
    {"id": "user", "file": "USER.md", "label": "About you", "note": "What Hermes learned about you.",
     "limit_key": "user_char_limit", "limit": 1375},
)
ENTRY_DELIMITER = re.compile(r"\r?\n\s*§\s*\r?\n")

MAX_WALK_ENTRIES = 6000
MAX_SKILLS = 2000
PREVIEW_BYTES = 16 * 1024
SKILL_HEAD_BYTES = 6 * 1024
EXCERPT_CHARS = 220
RECENT_PER_SITE = 12
RECENT_TOTAL = 24
SKIP_DIRS = frozenset({"node_modules", "__pycache__", "venv", ".venv", "dist", "build"})


# --------------------------------------------------------------------------------------------------
# Reading
# --------------------------------------------------------------------------------------------------

def read_head(path: Path, limit: int = PREVIEW_BYTES) -> str:
    try:
        with open(path, "rb") as fh:
            return fh.read(limit).decode("utf-8", errors="replace")
    except OSError:
        return ""


def read_text(path: Path, limit: int = 256 * 1024) -> Optional[str]:
    try:
        with open(path, "rb") as fh:
            return fh.read(limit).decode("utf-8", errors="replace")
    except OSError:
        return None


def split_frontmatter(text: str) -> tuple:
    """``(frontmatter text, body)``; the frontmatter is "" when there is none."""
    text = str(text or "").lstrip("\ufeff")
    m = re.match(r"---\r?\n([\s\S]*?)\r?\n---\r?\n?", text)
    return (m.group(1), text[m.end():]) if m else ("", text)


def frontmatter_value(fm: str, key: str) -> str:
    """A top-level scalar from YAML frontmatter, without a YAML parser: ``key: value`` / ``key: "value"``, and
    a folded or literal block (``key: >`` / ``key: |``) joined into one line."""
    lines = fm.splitlines()
    for i, line in enumerate(lines):
        m = re.match(r"^" + re.escape(key) + r"\s*:\s*(.*)$", line)
        if not m:
            continue
        value = m.group(1).strip()
        if value in (">", "|", ">-", "|-", ">+", "|+", ""):
            block = []
            for nxt in lines[i + 1:]:
                if nxt and not nxt[0].isspace():
                    break
                block.append(nxt.strip())
            value = " ".join(b for b in block if b)
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        return re.sub(r"\s+", " ", value).strip()
    return ""


def _inline(t: str) -> str:
    """Obsidian inline syntax to the words a reader sees."""
    t = re.sub(r"!\[\[[^\]]*\]\]", "", t)
    t = re.sub(r"\[\[[^\]|]*\|([^\]]*)\]\]", r"\1", t)
    t = re.sub(r"\[\[([^\]#]*)(#([^\]]*))?\]\]", lambda m: m.group(1) or m.group(3) or "", t)
    t = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", t)
    t = re.sub(r"<[^>]+>", "", t)
    t = re.sub(r"(\*\*|__|\*|~~|==|`)", "", t)
    return re.sub(r"\s+", " ", t).strip()


def preview_of(text: str) -> Dict[str, Any]:
    """``{heading, excerpt, words}`` from the top of a note, as plain text."""
    _, body = split_frontmatter(text)
    body = re.sub(r"```[\s\S]*?(```|$)", " ", body)
    body = re.sub(r"<!--[\s\S]*?-->|%%[\s\S]*?%%", " ", body)
    body = re.sub(r"<(script|style)\b[\s\S]*?</\1>", " ", body, flags=re.I)
    heading = ""
    lines: List[str] = []
    for raw in body.splitlines():
        line = raw.strip()
        if not line:
            continue
        h = re.match(r"^#{1,6}\s+(.*)$", line)
        if h:
            if not heading and line.startswith("# "):
                heading = _inline(h.group(1))
            continue
        if re.match(r"^(\||-{3,}|\*{3,}|>\s*\[!)", line) or line == "§":
            continue
        line = re.sub(r"^([-*+]|\d+[.)])\s+(\[.\]\s+)?", "", line)
        lines.append(_inline(re.sub(r"^>\s?", "", line)))
    flat = re.sub(r"\s+", " ", " ".join(x for x in lines if x)).strip()
    excerpt = flat
    if len(flat) > EXCERPT_CHARS:
        excerpt = re.sub(r"\s+\S*$", "", flat[:EXCERPT_CHARS]) + "…"
    return {"heading": heading, "excerpt": excerpt, "words": len(flat.split()) if flat else 0}


def note_title(rel: str) -> str:
    """What a list calls a note: its file name, or for a skill (``…/<name>/SKILL.md``) the skill's folder."""
    p = Path(rel)
    return p.parent.name if p.name == "SKILL.md" and p.parent.name else p.stem


def note_url(base: str, rel: str) -> str:
    """Websidian's URL for a note: the path without ``.md``, each segment percent-encoded."""
    stem = re.sub(r"\.md$", "", rel, flags=re.I)
    return base + "/".join(quote(seg, safe="!*'()") for seg in stem.split("/") if seg)


# --------------------------------------------------------------------------------------------------
# Walking
# --------------------------------------------------------------------------------------------------

def walk_notes(root: Path, budget: int = MAX_WALK_ENTRIES) -> Dict[str, Any]:
    """``{notes: [(rel, mtime_ms, bytes)], count, partial}`` for the ``.md`` files under ``root``.

    Dot-folders and dependency folders are skipped; symlinked folders are not followed (a vault must not lead
    the walk outside itself). ``partial`` is True when the walk ran out of budget.
    """
    notes: List[tuple] = []
    left = budget
    partial = False
    stack = [""]
    while stack:
        rel_dir = stack.pop()
        try:
            it = os.scandir(root / rel_dir if rel_dir else root)
        except OSError:
            continue
        with it:
            for e in it:
                left -= 1
                if left < 0:
                    partial = True
                    break
                if e.name.startswith(".") or e.name in SKIP_DIRS:
                    continue
                rel = f"{rel_dir}/{e.name}" if rel_dir else e.name
                try:
                    if e.is_dir(follow_symlinks=False):
                        stack.append(rel)
                    elif e.is_file(follow_symlinks=False) and e.name.lower().endswith(".md"):
                        st = e.stat(follow_symlinks=False)
                        notes.append((rel, int(st.st_mtime * 1000), st.st_size))
                except OSError:
                    continue
        if partial:
            break
    return {"notes": notes, "count": len(notes), "partial": partial}


def site_kind(root: Path, home: Optional[Path], explicit: str = "") -> str:
    """``memory`` / ``skills`` for Hermes's own folders, ``vault`` for everything else."""
    if explicit in ("memory", "skills", "vault"):
        return explicit
    if home is not None:
        try:
            r = root.resolve()
            if r == (home / "memories").resolve():
                return "memory"
            if r == (home / "skills").resolve():
                return "skills"
        except OSError:
            pass
    if (root / "MEMORY.md").is_file() and (root / "USER.md").is_file():
        return "memory"
    return "vault"


# --------------------------------------------------------------------------------------------------
# Memory
# --------------------------------------------------------------------------------------------------

def memory_entries(text: str) -> List[str]:
    """The entries of a Hermes memory file, in order, without the ``§`` separators."""
    text = str(text or "").replace("\r\n", "\n")  # a file saved on Windows
    return [e.strip() for e in ENTRY_DELIMITER.split(text.strip()) if e.strip()]


def memory_model(root: Path, base: str, limits: Optional[Mapping[str, Any]] = None) -> List[Dict[str, Any]]:
    out = []
    for spec in MEMORY_FILES:
        path = root / spec["file"]
        text = read_text(path)
        limit = spec["limit"]
        raw = (limits or {}).get(spec["limit_key"])
        if isinstance(raw, int) and raw > 0:
            limit = raw
        item: Dict[str, Any] = {"id": spec["id"], "file": spec["file"], "label": spec["label"], "note": spec["note"],
                                "limit": limit, "present": text is not None}
        if text is not None:
            entries = memory_entries(text)
            try:
                mtime = int(path.stat().st_mtime * 1000)
            except OSError:
                mtime = 0
            # Hermes counts the entries joined with the delimiter, in characters.
            item.update({"entries": entries, "chars": len("\n§\n".join(entries)), "mtime": mtime,
                         "rel": spec["file"], "url": note_url(base, spec["file"])})
        out.append(item)
    return out


# --------------------------------------------------------------------------------------------------
# Skills
# --------------------------------------------------------------------------------------------------

def skills_model(root: Path, base: str, walked: Mapping[str, Any]) -> Dict[str, Any]:
    """Skills (every ``SKILL.md``) grouped by category, with the name and description from their frontmatter.

    A skill at ``<category>/<name>/SKILL.md`` is in ``category``; one at ``<name>/SKILL.md`` has none. A category
    folder's ``DESCRIPTION.md`` gives its description.
    """
    skills = []
    for rel, mtime, _size in walked["notes"]:
        parts = rel.split("/")
        if parts[-1] != "SKILL.md" or len(parts) < 2:
            continue
        fm, body = split_frontmatter(read_head(root / rel, SKILL_HEAD_BYTES))
        folder = parts[-2]
        category = parts[0] if len(parts) >= 3 else ""
        description = frontmatter_value(fm, "description") or preview_of(body)["excerpt"]
        skills.append({
            "name": frontmatter_value(fm, "name") or folder,
            "description": description[:400],
            "category": category,
            "rel": rel,
            "url": note_url(base, rel),
            "mtime": mtime,
        })
        if len(skills) >= MAX_SKILLS:
            break
    skills.sort(key=lambda s: (s["category"].lower(), s["name"].lower()))
    categories: Dict[str, Dict[str, Any]] = {}
    for s in skills:
        c = categories.setdefault(s["category"], {"id": s["category"], "count": 0, "description": ""})
        c["count"] += 1
    for cid, c in categories.items():
        if cid:
            fm, body = split_frontmatter(read_head(root / cid / "DESCRIPTION.md", 4096))
            c["description"] = (frontmatter_value(fm, "description") or preview_of(body)["excerpt"])[:300]
    return {"skills": skills, "categories": sorted(categories.values(), key=lambda c: (c["id"] == "", c["id"].lower()))}


# --------------------------------------------------------------------------------------------------
# The whole model
# --------------------------------------------------------------------------------------------------

def overview(sites: Iterable[Mapping[str, Any]], base_path: str, home: Optional[Path] = None,
             memory_limits: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    """The tab's model: ``{sites, recent, memory, skills}``.

    ``sites`` are normalized vaults (``sites.normalize_vaults``); ``base_path`` is Websidian's mount
    (``/api/plugins/websidian/w`` plus any dashboard prefix).
    """
    out_sites: List[Dict[str, Any]] = []
    recent: List[Dict[str, Any]] = []
    memory = None
    skills = None
    for s in sites:
        root = Path(os.path.expanduser(str(s["path"])))
        base = f"{base_path}/{quote(s['slug'], safe='')}/"
        kind = site_kind(root, home, str(s.get("kind") or ""))
        present = root.is_dir()
        walked = walk_notes(root) if present else {"notes": [], "count": 0, "partial": False}
        notes = sorted(walked["notes"], key=lambda n: -n[1])
        out_sites.append({
            "slug": s["slug"], "title": s["title"], "kind": kind, "edit": bool(s.get("edit")),
            "untrusted": bool(s.get("untrusted", True)), "present": present, "base": base,
            "graph": base + "_graph", "notes": walked["count"], "partial": walked["partial"],
            "updated": notes[0][1] if notes else 0,
        })
        labels = {m["file"]: m["label"] for m in MEMORY_FILES} if kind == "memory" else {}
        for rel, mtime, size in notes[:RECENT_PER_SITE]:
            recent.append({"site": s["slug"], "rel": rel, "title": labels.get(rel) or note_title(rel),
                           "mtime": mtime, "bytes": size, "url": note_url(base, rel), "_root": root})
        if kind == "memory" and memory is None and present:
            memory = {"site": s["slug"], "files": memory_model(root, base, memory_limits)}
        if kind == "skills" and skills is None and present:
            skills = dict(skills_model(root, base, walked), site=s["slug"])
    recent.sort(key=lambda n: -n["mtime"])
    recent = recent[:RECENT_TOTAL]
    for n in recent:  # only the notes the tab shows are opened
        root = n.pop("_root")
        n.update(preview_of(read_head(root / n["rel"])))
    return {"sites": out_sites, "recent": recent, "memory": memory, "skills": skills}
