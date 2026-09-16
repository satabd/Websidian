"""Write-time guard for the websidian Hermes plugin.

Pure logic, standard library only, no Hermes imports: the plugin's ``pre_tool_call`` hook calls
:func:`evaluate`, and the same file runs as a Hermes *shell hook* (``python guard.py --stdin``).

Two rules:

1. Protected files. Writes to agent instruction files (``SKILL.md``, ``SOUL.md``, ``AGENTS.md`` ...,
   matched by basename, case-insensitively) anywhere under the Hermes home or inside a configured
   vault need a human: an ``approve`` directive (or ``block`` when ``protect_mode`` is "block").
   Hermes's own writers of such files go through the same rule: the ``memory`` tool (``MEMORY.md`` /
   ``USER.md``) and ``skill_manage`` (``SKILL.md`` and the files of a skill folder).
2. Active content. Writes into a configured vault must be plain Markdown: raw ``<script>``,
   ``<iframe>``, event-handler attributes, ``javascript:`` URLs and friends are blocked, and so are
   ``.html``/``.svg``/``.js``... files. Code inside fenced code blocks and inline code spans is
   ignored, but only where Markdown really renders it as code. Memory entries and skill content are
   checked the same way wherever they are stored: they go into the agent's own prompt, and the folders
   that hold them are often served as a vault.

Shell (``terminal``) commands are checked best-effort only. This is a guard rail against mistakes and
prompt-injected content, not a security boundary.
"""

from __future__ import annotations

import bisect
import fnmatch
import html
import json
import os
import re
import sys
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

try:  # imported as part of the plugin package
    from . import sites
except ImportError:  # guard.py run as a shell hook / top-level module
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import sites  # type: ignore  # noqa: E402

PLUGIN_ID = "websidian"

DEFAULT_PROTECT: Tuple[str, ...] = (
    "SKILL.md", "SOUL.md", "AGENTS.md", "MEMORY.md", "USER.md", "TOOLS.md",
    "IDENTITY.md", "HEARTBEAT.md", "BOOTSTRAP.md",
)

# Files a vault must never gain: the browser would run them (Websidian serves attachments from the vault).
BLOCKED_EXTENSIONS: Tuple[str, ...] = (
    ".html", ".htm", ".shtml", ".xhtml", ".xht", ".svg", ".xml", ".js", ".mjs",
)

FILE_TOOLS = ("write_file", "patch")
SHELL_TOOLS = ("terminal",)
# Hermes's own writers of agent instruction files. Tool names and argument keys read from the native
# install: ``memory`` (tools/memory_tool.py:1263 MEMORY_SCHEMA, registered :1376) writes
# ``<hermes home>/memories/MEMORY.md`` or ``USER.md``; ``skill_manage``
# (tools/skill_manager_tool.py:1711 SKILL_MANAGE_SCHEMA, registered :1833) writes
# ``<hermes home>/skills/[<category>/]<name>/SKILL.md`` and the files under that folder.
MEMORY_TOOLS = ("memory",)
SKILL_TOOLS = ("skill_manage",)
GUARDED_TOOLS = FILE_TOOLS + SHELL_TOOLS + MEMORY_TOOLS + SKILL_TOOLS
# Tools whose successful calls write files the plugin can turn into links (``post_tool_call``).
TRACKED_TOOLS = FILE_TOOLS + MEMORY_TOOLS + SKILL_TOOLS

# memory: ``action`` on its own, or the same actions inside an atomic ``operations`` batch
# (memory_tool.py:1129). A read/search surface (another Hermes may have one) is not in this list, so it
# passes through, and so does any shape this guard does not recognize.
MEMORY_WRITE_ACTIONS = ("add", "replace", "remove", "batch")
MEMORY_DIR = "memories"                                        # memory_tool.py:64 get_memory_dir()
MEMORY_FILES = {"memory": "MEMORY.md", "user": "USER.md"}      # memory_tool.py:341 _path_for(target)

# skill_manage actions (skill_manager_tool.py:1755): the first four carry content, the last two only
# remove files. ``skills_list`` / ``skill_view`` are separate, unguarded tools.
SKILL_CONTENT_ACTIONS = ("create", "edit", "patch", "write_file")
SKILL_DELETE_ACTIONS = ("delete", "remove_file")
SKILLS_DIR = "skills"                                          # skill_manager_tool.py:160 _skills_dir()
SKILL_FILE = "SKILL.md"

_MAX_SCAN_CHARS = 2_000_000


# --------------------------------------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------------------------------------

class Settings:
    """Normalized plugin settings."""

    def __init__(self, vaults: Iterable[Mapping[str, Any]] = (), protect: Optional[Iterable[str]] = None,
                 protect_mode: str = "approve", block_active_content: bool = True,
                 hermes_homes: Optional[Iterable[str]] = None, append_links: bool = True,
                 link_style: Any = None, dashboard: Any = None):
        # {path, url, root, slug, title, edit, untrusted, style, public_base}; see sites.py for slugs and link styles.
        self.dashboard = sites.dashboard_settings(dashboard)
        self.link_style = link_style
        self.vaults: List[Dict[str, Any]] = []
        for v in sites.resolve_links(sites.normalize_vaults(vaults), link_style, self.dashboard):
            if v["style"] == "dashboard":
                v["url"] = f"{v['public_base']}{sites.DASHBOARD_TAB_PATH}?site={sites.note_param(v['slug'])}"
            v["root"] = real(v["path"])
            self.vaults.append(v)
        self.protect: List[str] = [str(p) for p in (DEFAULT_PROTECT if protect is None else protect) if str(p).strip()]
        mode = str(protect_mode or "approve").strip().lower()
        self.protect_mode = mode if mode in ("approve", "block") else "approve"
        self.block_active_content = bool(block_active_content)
        self.append_links = bool(append_links)
        homes = list(hermes_homes) if hermes_homes is not None else default_hermes_homes()
        self.hermes_homes: List[str] = sorted({real(h) for h in homes if h})


def _as_bool(value: Any, default: bool) -> bool:
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


def parse_vaults_env(raw: str) -> List[Dict[str, str]]:
    """``WEBSIDIAN_VAULTS``: a JSON list of ``{path, url}``, or ``path|url`` entries separated by ``;`` or newlines."""
    raw = (raw or "").strip()
    if not raw:
        return []
    if raw.startswith("["):
        try:
            data = json.loads(raw)
            return [v for v in data if isinstance(v, dict)]
        except ValueError:
            return []
    out = []
    for entry in re.split(r"[;\n]", raw):
        entry = entry.strip()
        if not entry:
            continue
        path, _, url = entry.partition("|")
        out.append({"path": path.strip(), "url": url.strip()})
    return out


def settings_from_sources(get: Optional[Callable[[str, Any], Any]] = None,
                          env: Optional[Mapping[str, str]] = None,
                          hermes_homes: Optional[Iterable[str]] = None) -> Settings:
    """Build :class:`Settings` from a ``get(key, default)`` config reader (``ctx.get_config``), falling
    back to ``WEBSIDIAN_*`` environment variables for any key the config does not set."""
    env = os.environ if env is None else env
    missing = object()

    def cfg(key: str) -> Any:
        if get is None:
            return missing
        try:
            return get(key, missing)
        except Exception:
            return missing

    vaults = cfg("vaults")
    if vaults is missing or not isinstance(vaults, list):
        vaults = parse_vaults_env(env.get("WEBSIDIAN_VAULTS", ""))
    protect = cfg("protect")
    if protect is missing or not isinstance(protect, list):
        raw = env.get("WEBSIDIAN_PROTECT")
        protect = [p.strip() for p in raw.split(",") if p.strip()] if raw else None
    mode = cfg("protect_mode")
    if mode is missing:
        mode = env.get("WEBSIDIAN_PROTECT_MODE", "approve")
    bac = cfg("block_active_content")
    if bac is missing:
        bac = env.get("WEBSIDIAN_BLOCK_ACTIVE_CONTENT")
    links = cfg("append_links")
    if links is missing:
        links = env.get("WEBSIDIAN_APPEND_LINKS")
    link_style = cfg("link_style")
    if link_style is missing:
        link_style = env.get("WEBSIDIAN_LINK_STYLE")
    dashboard = cfg("dashboard")
    if dashboard is missing or not isinstance(dashboard, dict):
        raw = env.get("WEBSIDIAN_PUBLIC_BASE")
        dashboard = {"public_base": raw} if raw else None
    return Settings(vaults=vaults, protect=protect, protect_mode=mode,
                    block_active_content=_as_bool(bac, True), append_links=_as_bool(links, True),
                    hermes_homes=hermes_homes, link_style=link_style, dashboard=dashboard)


def default_hermes_homes() -> List[str]:
    """``$HERMES_HOME``, ``~/.hermes`` and the Windows default ``%LOCALAPPDATA%\\hermes``."""
    homes = [os.path.join(os.path.expanduser("~"), ".hermes")]
    if os.environ.get("HERMES_HOME"):
        homes.append(os.environ["HERMES_HOME"])
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
        homes.append(os.path.join(base, "hermes"))
    return homes


# --------------------------------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------------------------------

def real(path: str, base: Optional[str] = None) -> str:
    """Absolute, ``~``-expanded, symlink-resolved path (relative paths resolve against ``base`` or cwd)."""
    p = os.path.expanduser(str(path))
    if not os.path.isabs(p):
        p = os.path.join(base or os.getcwd(), p)
    return os.path.realpath(os.path.normpath(p))


def _key(path: str) -> str:
    return os.path.normcase(path).replace("\\", "/").rstrip("/")


def is_within(path: str, root: str) -> bool:
    """True when ``path`` is ``root`` or inside it (both already absolute)."""
    p, r = _key(path), _key(root)
    return p == r or p.startswith(r + "/")


def candidates(path: str, base: Optional[str] = None) -> List[str]:
    """The normalized path and its realpath (a symlink must not escape either way)."""
    p = os.path.expanduser(str(path))
    if not os.path.isabs(p):
        p = os.path.join(base or os.getcwd(), p)
    normalized = os.path.normpath(p)
    resolved = os.path.realpath(normalized)
    return [normalized] if _key(normalized) == _key(resolved) else [normalized, resolved]


def vault_for(path: str, settings: Settings, base: Optional[str] = None) -> Optional[Dict[str, str]]:
    for cand in candidates(path, base):
        for v in settings.vaults:
            if is_within(cand, v["root"]) or is_within(cand, os.path.normpath(os.path.expanduser(v["path"]))):
                return v
    return None


def in_hermes_home(path: str, settings: Settings, base: Optional[str] = None) -> bool:
    return any(is_within(c, h) for c in candidates(path, base) for h in settings.hermes_homes)


def protected_name(path: str, settings: Settings, base: Optional[str] = None) -> Optional[str]:
    """The protect pattern ``path`` matches (by basename, case-insensitive) when it lies under a Hermes
    home or a vault, else ``None``."""
    if not (in_hermes_home(path, settings, base) or vault_for(path, settings, base)):
        return None
    for cand in candidates(path, base):
        name = os.path.basename(cand).lower()
        for pattern in settings.protect:
            if fnmatch.fnmatchcase(name, pattern.lower()):
                return os.path.basename(cand)
    return None


def blocked_extension(path: str) -> Optional[str]:
    ext = os.path.splitext(str(path).rstrip("/\\ ."))[1].lower()
    return ext if ext in BLOCKED_EXTENSIONS else None


# --------------------------------------------------------------------------------------------------
# Active content detection
# --------------------------------------------------------------------------------------------------

_SEP = r"[\s\x00-\x1f\\]*"  # whitespace / control chars / backslash escapes tolerated inside a scheme


def _spaced(word: str) -> str:
    return _SEP.join(re.escape(ch) for ch in word)


_SCHEME = r"(?:" + "|".join(_spaced(w) for w in ("javascript", "vbscript", "livescript")) + r")" + _SEP + r":"
_DATA_HTML = _spaced("data") + _SEP + r":" + r"[\s\x00-\x1f]*" + r"(?:text/html|application/xhtml|image/svg|text/xml|application/xml)"
# A URL-ish context: attribute value (=), Markdown link / image destination (](), reference definition
# ([x]: ), autolink (<), CSS url(, or any quote/paren.
_URL_CONTEXT = r"(?:[=(<\"'`]|\]\s*:)" + r"[\s\x00-\x20]*"

_RULES: Tuple[Tuple[str, "re.Pattern[str]", bool], ...] = (
    # (reason, pattern, scan entity-decoded text too)
    ("<script> tag", re.compile(r"<\s*/?\s*script\b", re.I), False),
    ("<iframe> tag", re.compile(r"<\s*i?frame(?:set)?\b", re.I), False),
    ("<object> tag", re.compile(r"<\s*object\b", re.I), False),
    ("<embed> tag", re.compile(r"<\s*embed\b", re.I), False),
    ("<applet> tag", re.compile(r"<\s*applet\b", re.I), False),
    ("<portal> tag", re.compile(r"<\s*portal\b", re.I), False),
    ("<base> tag", re.compile(r"<\s*base\b", re.I), False),
    ("<form> tag", re.compile(r"<\s*form\b", re.I), False),
    ("<meta> tag", re.compile(r"<\s*meta\b", re.I), False),
    ("javascript:/vbscript: URL", re.compile(_URL_CONTEXT + _SCHEME, re.I), True),
    ("data:text/html URL", re.compile(_URL_CONTEXT + _DATA_HTML, re.I), True),
)


# --- HTML start-tag attributes, tokenized like a browser (WHATWG tokenizer, simplified) -------------------

_HTML_WS = "\t\n\f\r "
_EVENT_ATTR = re.compile(r"on[a-z]+")
_TAG_SCAN_CAP = 4096          # chars one start tag may span before we give up (and flag it)
_TAG_SCAN_BUDGET = 4_000_000  # total chars scanned per document before we give up (and flag it)


def _scan_start_tag(text: str, i: int) -> Tuple[str, List[str], int, bool]:
    """Tokenize the start tag at ``text[i] == "<"``: ``(tag name, attribute names, chars scanned, overlong)``.
    Attribute names are lowercased; a tag cut off by EOF still reports what it saw (patches can complete it)."""
    n = len(text)
    limit = min(n, i + _TAG_SCAN_CAP)
    j = i + 1
    while j < limit and text[j] not in _HTML_WS and text[j] not in "/>":
        j += 1
    name = text[i + 1:j].lower()
    attrs: List[str] = []
    while j < limit:
        c = text[j]
        if c in _HTML_WS or c == "/":
            j += 1
            continue
        if c == ">":
            return name, attrs, j - i, False
        start = j  # attribute name (a leading "=" belongs to the name)
        j += 1
        while j < limit and text[j] not in _HTML_WS and text[j] not in "/>=":
            j += 1
        attrs.append(text[start:j].lower())
        while j < limit and text[j] in _HTML_WS:
            j += 1
        if j < limit and text[j] == "=":
            j += 1
            while j < limit and text[j] in _HTML_WS:
                j += 1
            if j < limit and text[j] in "\"'":
                end = text.find(text[j], j + 1, limit)
                j = end + 1 if end >= 0 else limit
            else:
                while j < limit and text[j] not in _HTML_WS and text[j] != ">":
                    j += 1
    return name, attrs, j - i, limit < n and j >= limit


_LOOSE_EVENT_ATTR = re.compile(r"[\s/\"'\x00]on[a-z]+[\s\x00]*=", re.I)
_EVENT_REASON = "event-handler attribute (on...=)"


def _tag_findings(text: str) -> Dict[str, int]:
    """Count event-handler attributes in start tags. Every ``<letter`` is tokenized, including ones inside
    another tag's attribute value, because Markdown may not treat the outer ``<`` as a tag. Past the per-tag
    cap or the per-document budget, fall back to a quote-blind search of the rest of the text (stricter)."""
    loose = [m.start() for m in _LOOSE_EVENT_ATTR.finditer(text)]

    def loose_after(pos: int) -> bool:
        return bisect.bisect_left(loose, pos) < len(loose)

    count = 0
    budget = _TAG_SCAN_BUDGET
    for m in re.finditer(r"<[A-Za-z]", text):
        if budget < 0:
            count += 1 if loose_after(m.start()) else 0
            break
        _, attrs, used, overlong = _scan_start_tag(text, m.start())
        budget -= used
        count += sum(1 for a in attrs if _EVENT_ATTR.fullmatch(a))
        if overlong and loose_after(m.start() + used):
            count += 1
    return {_EVENT_REASON: count}

_FENCE_OPEN = re.compile(r"^(`{3,}|~{3,})(.*)$")  # column 0 only: an indented fence may belong to a list item
_FRONTMATTER = re.compile(r"^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)")  # Websidian's parseFrontmatter
_CONTAINER_PREFIX = re.compile(r"^(?:\s*(?:>|[-+*]\s|\d{1,9}[.)]\s))*\s*")
_HTML_RAW_TYPES = (  # CommonMark HTML block types 1-5: they end at a closer, not at a blank line
    (re.compile(r"^<(?:script|pre|style|textarea)(?:\s|>|$)", re.I), re.compile(r"</(?:script|pre|style|textarea)>", re.I)),
    (re.compile(r"^<!--"), re.compile(r"-->")),
    (re.compile(r"^<\?"), re.compile(r"\?>")),
    (re.compile(r"^<![A-Za-z]"), re.compile(r">")),
    (re.compile(r"^<!\[CDATA\["), re.compile(r"\]\]>")),
)
_HTML_BLOCK_START = re.compile(r"^<[A-Za-z/]")
# Characters that start an inline construct able to swallow a backtick before the code-span rule sees it
# (HTML tags/autolinks, $math$, %%comments%%, ==highlight==, [[wikilinks]]/[links], escapes, table cells).
# "> [!note]" callout and "- [ ]" task markers: brackets that can never swallow a backtick.
_CALLOUT_MARKER = re.compile(r"^\s*(?:(?:>\s*)+\[![A-Za-z0-9_-]*\][+-]?|(?:>\s*)*(?:[-+*]|\d{1,9}[.)])\s+\[[^\[\]`\\]\])")
_INLINE_COMPETITORS = re.compile(r"[<$%=\[\]\|]")


_BLOCK_SEARCH_BUDGET = 200_000  # line visits spent looking for fence / math closers before giving up


def _code_ranges(text: str) -> List[Tuple[int, int]]:
    """Character ranges Websidian's Markdown renderer certainly shows as code: closed column-0 fenced blocks
    outside HTML and math blocks, and inline code spans nothing else can claim first. Anything uncertain is
    left out, and therefore scanned. Runs in linear time; on pathological input it masks nothing."""
    ranges: List[Tuple[int, int]] = []
    lines = text.splitlines(keepends=True)
    offsets, pos = [], 0
    for line in lines:
        offsets.append(pos)
        pos += len(line)
    stripped = [line.rstrip("\r\n") for line in lines]
    math_ends = [k for k, line in enumerate(stripped) if line.rstrip().endswith("$$")]

    i = 0
    fm = _FRONTMATTER.match(text)
    if fm:  # frontmatter is YAML, never Markdown: skip it (scanned, never masked)
        while i < len(lines) and offsets[i] < fm.end():
            i += 1

    budget = _BLOCK_SEARCH_BUDGET
    html_end: Optional["re.Pattern[str]"] = None  # closer of the HTML block we are in
    in_html_blank = False  # in an HTML block that ends at a blank line
    para_competitor = False  # the paragraph so far has a character that could swallow a backtick
    poisoned = False         # the paragraph has an unmatched/escaped backtick run: later spans are not trusted
    while i < len(lines):
        line = stripped[i]
        if html_end is not None:
            if html_end.search(line):
                html_end = None
            i += 1
            continue
        if in_html_blank:
            if not line.strip():
                in_html_blank = False
            i += 1
            continue
        if not line.strip():
            para_competitor = poisoned = False
            i += 1
            continue
        content = line[_CONTAINER_PREFIX.match(line).end():]
        raw = next((closer for opener, closer in _HTML_RAW_TYPES if opener.match(content)), None)
        if raw is not None:
            html_end = None if raw.search(content, 1) else raw
            para_competitor = poisoned = False
            i += 1
            continue
        if _HTML_BLOCK_START.match(content):
            in_html_blank = True
            para_competitor = poisoned = False
            i += 1
            continue
        if line.lstrip().startswith("$$"):  # Websidian math block (a block rule that runs before fences)
            rest = line.lstrip()[2:]
            if rest.rstrip().endswith("$$") and len(rest.strip()) > 2:
                j: Optional[int] = i
            else:
                k = bisect.bisect_right(math_ends, i)
                j = math_ends[k] if k < len(math_ends) else None
            if j is not None:
                para_competitor = poisoned = False
                i = j + 1
                continue
        m = _FENCE_OPEN.match(line)
        if m and not (m.group(1)[0] == "`" and "`" in m.group(2)):
            fence = m.group(1)
            close = re.compile(r"^ {0,3}" + re.escape(fence[0]) + "{" + str(len(fence)) + r",}[ \t]*$")
            j = i + 1
            while j < len(lines) and not close.match(stripped[j]):
                j += 1
            budget -= j - i
            if budget < 0:
                return []  # too expensive to reason about: trust nothing, scan everything
            para_competitor = poisoned = False
            if j < len(lines):  # closed fence: its body is code
                if j > i + 1:
                    ranges.append((offsets[i + 1], offsets[j]))
                i = j + 1
                continue
            i += 1  # unclosed fence: not trusted, scan it
            continue
        scan = _CALLOUT_MARKER.sub(lambda mm: " " * len(mm.group(0)), line)  # "> [!note]" swallows nothing
        para_competitor, poisoned = _inline_code_ranges(scan, offsets[i], ranges, para_competitor, poisoned)
        i += 1
    return ranges


def _inline_code_ranges(line: str, base: int, out: List[Tuple[int, int]], competitor: bool,
                        poisoned: bool) -> Tuple[bool, bool]:
    """Append the trusted inline code spans of ``line``. A span is trusted when its opener is not escaped, it
    closes on the same line, and nothing before it in the paragraph (outside trusted spans) could have
    claimed the backticks first. Returns the updated ``(competitor, poisoned)`` paragraph flags."""
    runs = [(m.start(), m.end() - m.start()) for m in re.finditer(r"`+", line)]
    by_len: Dict[int, List[int]] = {}
    for idx, (_, length) in enumerate(runs):
        by_len.setdefault(length, []).append(idx)
    checked = 0  # line[:checked] has been searched for competitors (trusted span contents excluded)
    idx = 0
    while idx < len(runs):
        start, length = runs[idx]
        if not competitor and _INLINE_COMPETITORS.search(line, checked, start):
            competitor = True
        checked = max(checked, start)
        b = start
        while b > 0 and line[b - 1] == "\\":
            b -= 1
        same = by_len[length]
        k = bisect.bisect_right(same, idx)
        if (start - b) % 2 or k >= len(same):
            poisoned = True  # escaped or unmatched on this line: Markdown may pair it differently
            idx += 1
            continue
        close_idx = same[k]
        close_start = runs[close_idx][0]
        if not competitor and not poisoned:
            out.append((base + start + length, base + close_start))
            checked = close_start + length
        idx = close_idx + 1
    if not competitor and _INLINE_COMPETITORS.search(line, checked):
        competitor = True
    return competitor, poisoned


def _mask(text: str, ranges: Sequence[Tuple[int, int]]) -> str:
    if not ranges:
        return text
    chars = list(text)
    for start, end in ranges:
        for idx in range(start, end):
            if chars[idx] not in "\r\n":
                chars[idx] = " "
    return "".join(chars)


def _decode_entities(text: str) -> str:
    prev = text
    for _ in range(3):  # nested encodings like &amp;#106;
        cur = html.unescape(prev)
        if cur == prev:
            break
        prev = cur
    return prev


def _count_findings(text: str) -> Dict[str, int]:
    visible = _mask(text, _code_ranges(text))
    decoded = _decode_entities(visible)
    counts = {reason: max(len(rx.findall(visible)), len(rx.findall(decoded)) if check else 0)
              for reason, rx, check in _RULES}
    counts.update(_tag_findings(visible))
    return counts


def find_active_content(text: str) -> List[str]:
    """Reasons ``text`` contains active HTML (empty list = plain Markdown). Code blocks/spans are ignored."""
    if not isinstance(text, str) or not text:
        return []
    if len(text) > _MAX_SCAN_CHARS:
        return ["content too large to scan"]
    return [reason for reason, count in _count_findings(text).items() if count]


def new_active_content(before: str, after: str) -> List[str]:
    """Findings present in ``after`` more often than in ``before`` (a patch must not introduce any)."""
    if len(after) > _MAX_SCAN_CHARS:
        return ["content too large to scan"]
    b, a = _count_findings(before), _count_findings(after)
    return [reason for reason, count in a.items() if count > b.get(reason, 0)]


# --------------------------------------------------------------------------------------------------
# V4A patches (patch tool, mode="patch")
# --------------------------------------------------------------------------------------------------

_V4A_OPS = (
    ("update", re.compile(r"\*\*\*\s*Update\s+File:\s*(.+)")),
    ("add", re.compile(r"\*\*\*\s*Add\s+File:\s*(.+)")),
    ("delete", re.compile(r"\*\*\*\s*Delete\s+File:\s*(.+)")),
    ("move", re.compile(r"\*\*\*\s*Move\s+File:\s*(.+?)\s*->\s*(.+)")),
)


def parse_v4a(patch_text: str) -> List[Dict[str, Any]]:
    """``[{op, path, new_path, added}]`` - the files a V4A patch touches and the text its ``+`` lines add."""
    ops: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None
    for raw in (patch_text or "").split("\n"):
        line = raw[:-1] if raw.endswith("\r") else raw
        matched = None
        for kind, rx in _V4A_OPS:
            m = rx.match(line)
            if m:
                matched = (kind, m)
                break
        if matched:
            kind, m = matched
            current = {"op": kind, "path": m.group(1).strip(),
                       "new_path": m.group(2).strip() if kind == "move" else None, "added": []}
            ops.append(current)
            continue
        if current is not None and line.startswith("+"):
            current["added"].append(line[1:])
    for op in ops:
        op["added"] = "\n".join(op["added"])
    return ops


# --------------------------------------------------------------------------------------------------
# Tool-call evaluation
# --------------------------------------------------------------------------------------------------

def _protect_directive(path: str, name: str, settings: Settings, tool_name: str,
                        base: Optional[str] = None, detail: str = "") -> Dict[str, str]:
    what = f"{name} is an agent instruction file ({path})" + (f"; {detail}" if detail else "")
    if settings.protect_mode == "block":
        return {"action": "block",
                "message": f"websidian: {what}; writes to it are blocked. A human must make this change - "
                           f"ask the user to edit it themselves."}
    return {"action": "approve",
            "message": f"websidian: {what}; a human must approve this write.",
            "rule_key": f"websidian:protect:{_key(real(path, base))}"}


def _block(message: str) -> Dict[str, str]:
    return {"action": "block", "message": "websidian: " + message}


_PLAIN_MD_HINT = ("Write plain Obsidian Markdown instead (headings, lists, [[wikilinks]], callouts, "
                  "fenced code blocks for code samples); raw HTML with scripts, frames, forms, event "
                  "handlers or javascript: URLs is not allowed in the vault.")


def check_file_write(path: str, new_text: Optional[str], settings: Settings, *, base: Optional[str] = None,
                     tool_name: str = "write_file", before_text: Optional[str] = None,
                     creates_file: bool = True) -> Optional[Dict[str, str]]:
    """Directive for writing ``new_text`` to ``path`` (``None`` = allow). With ``before_text`` only content
    the write newly introduces counts (patches of files that already hold HTML)."""
    if not isinstance(path, str) or not path.strip():
        return None
    name = protected_name(path, settings, base)
    if name:
        return _protect_directive(path, name, settings, tool_name, base)
    vault = vault_for(path, settings, base)
    if not vault or not settings.block_active_content:
        return None
    ext = blocked_extension(path)
    if ext and creates_file:
        return _block(f"refusing to write a {ext} file into the vault ({path}); a browser would run it. "
                      f"Notes must be .md files. " + _PLAIN_MD_HINT)
    if new_text:
        reasons = new_active_content(before_text, new_text) if before_text is not None else find_active_content(new_text)
        if reasons:
            return _block(f"the content for {path} contains active HTML ({', '.join(reasons)}). " + _PLAIN_MD_HINT)
    return None


# --------------------------------------------------------------------------------------------------
# memory and skill_manage: Hermes's own writers of agent instruction files
# --------------------------------------------------------------------------------------------------

_INSTRUCTION_MD_HINT = ("Write plain Markdown instead; raw HTML with scripts, frames, forms, event handlers "
                        "or javascript: URLs does not belong in an agent instruction file - it is injected "
                        "into the agent's own prompt, and these folders are often served as a vault.")


def _active_content_directive(text: Any, what: str, settings: Settings) -> Optional[Dict[str, str]]:
    """Block directive when ``text`` is not plain Markdown (``None`` when it is, or when the check is off)."""
    if not settings.block_active_content or not isinstance(text, str) or not text:
        return None
    reasons = find_active_content(text)
    if not reasons:
        return None
    return _block(f"{what} contains active HTML ({', '.join(reasons)}). " + _INSTRUCTION_MD_HINT)


def _first_existing(paths: List[str]) -> str:
    """The first path that exists, else the first path (``""`` for an empty list)."""
    return next((p for p in paths if os.path.exists(p)), paths[0] if paths else "")


def _homes(hermes_homes: Optional[Iterable[str]]) -> List[str]:
    return sorted({real(h) for h in (default_hermes_homes() if hermes_homes is None else hermes_homes) if h})


def memory_texts(args: Mapping[str, Any]) -> Optional[List[str]]:
    """The entry text a ``memory`` call writes, or ``None`` when the call writes nothing we recognize
    (a read-only action, or an argument shape this guard does not understand: those fail open, as
    malformed ``write_file``/``patch`` args do)."""
    ops = args.get("operations")
    if isinstance(ops, list) and ops:
        if not all(isinstance(op, Mapping) for op in ops):
            return None
        if not any(str(op.get("action") or "").strip().lower() in MEMORY_WRITE_ACTIONS for op in ops):
            return None
        return [t for op in ops for t in (op.get("content"), op.get("new_text")) if isinstance(t, str)]
    if str(args.get("action") or "").strip().lower() not in MEMORY_WRITE_ACTIONS:
        return None
    return [t for t in (args.get("content"), args.get("new_text")) if isinstance(t, str)]


def memory_file(args: Mapping[str, Any], hermes_homes: Optional[Iterable[str]] = None) -> str:
    """``<hermes home>/memories/MEMORY.md`` (``USER.md`` for ``target: user``), an existing one first."""
    name = MEMORY_FILES.get(str(args.get("target") or "memory").strip().lower(), MEMORY_FILES["memory"])
    return _first_existing([os.path.join(h, MEMORY_DIR, name) for h in _homes(hermes_homes)])


def check_memory_write(args: Mapping[str, Any], settings: Settings,
                       base: Optional[str] = None) -> Optional[Dict[str, str]]:
    """Directive for a ``memory`` call: the entry lands in ``MEMORY.md`` / ``USER.md``, so it needs the same
    human approval as writing that file directly, and the text itself must be plain Markdown. A refusal
    wins over an approval prompt - approving an entry does not make a script in it safe."""
    texts = memory_texts(args)
    if texts is None:
        return None
    for text in texts:
        directive = _active_content_directive(text, "the memory entry", settings)
        if directive:
            return directive
    path = memory_file(args, settings.hermes_homes)
    name = protected_name(path, settings, base) if path else None
    return _protect_directive(path, name, settings, "memory", base) if name else None


def skill_dir(args: Mapping[str, Any], hermes_homes: Optional[Iterable[str]] = None) -> str:
    """The folder a ``skill_manage`` call touches: ``<hermes home>/skills/[<category>/]<name>``, an existing
    one first. A skill kept in ``skills.external_dirs`` cannot be located without Hermes, so the guard sees
    the default location for it (its SKILL.md is protected there, which is the decision that matters)."""
    name = str(args.get("name") or "").strip()
    if not name:
        return ""
    category = str(args.get("category") or "").strip()
    parts = [SKILLS_DIR] + ([category] if category else []) + [name]
    return _first_existing([os.path.join(h, *parts) for h in _homes(hermes_homes)])


def skill_written_files(args: Mapping[str, Any], hermes_homes: Optional[Iterable[str]] = None) -> List[str]:
    """The files a ``skill_manage`` call writes: the supporting file for the file actions (and for a
    ``patch`` that names one), else the skill's ``SKILL.md`` (the tool's own default)."""
    folder = skill_dir(args, hermes_homes)
    if not folder:
        return []
    action = str(args.get("action") or "").strip().lower()
    rel = args.get("file_path")
    rel = rel.strip().replace("\\", "/").strip("/") if isinstance(rel, str) else ""
    if action in ("write_file", "remove_file") or (action == "patch" and rel):
        return [os.path.join(folder, *rel.split("/"))] if rel else []
    return [os.path.join(folder, SKILL_FILE)]


def check_skill_write(args: Mapping[str, Any], settings: Settings,
                      base: Optional[str] = None) -> Optional[Dict[str, str]]:
    """Directive for a ``skill_manage`` call: creating, editing or deleting a skill writes ``SKILL.md`` and
    the files of its folder, which the agent loads as instructions, so a human decides; the content must be
    plain Markdown. Read-only actions (``skills_list``/``skill_view`` are separate tools) and unknown action
    shapes pass through."""
    action = str(args.get("action") or "").strip().lower()
    if action not in SKILL_CONTENT_ACTIONS + SKILL_DELETE_ACTIONS:
        return None
    if action in SKILL_CONTENT_ACTIONS:
        for text in (args.get("content"), args.get("file_content"), args.get("new_string")):
            directive = _active_content_directive(text, "the skill content", settings)
            if directive:
                return directive
    written = skill_written_files(args, settings.hermes_homes)
    for path in written:  # a supporting file whose own name is protected (references/AGENTS.md...)
        name = protected_name(path, settings, base)
        if name:
            return _protect_directive(path, name, settings, "skill_manage", base)
    folder = skill_dir(args, settings.hermes_homes)
    skill_md = os.path.join(folder, SKILL_FILE) if folder else ""
    name = protected_name(skill_md, settings, base) if skill_md else None
    if not name:
        return None
    verb = "removes" if action in SKILL_DELETE_ACTIONS else "writes"
    detail = (f"this call {verb} {written[0]} in that skill's folder"
              if written and _key(written[0]) != _key(skill_md) else "")
    return _protect_directive(skill_md, name, settings, "skill_manage", base, detail=detail)


def _read_text(path: str, base: Optional[str]) -> Optional[str]:
    try:
        with open(real(path, base), "r", encoding="utf-8", errors="replace") as fh:
            return fh.read(_MAX_SCAN_CHARS + 1)
    except OSError:
        return None


def _check_patch(args: Mapping[str, Any], settings: Settings, base: Optional[str]) -> Optional[Dict[str, str]]:
    mode = str(args.get("mode") or "replace").lower()
    patch_text = args.get("patch")
    if mode == "patch" or (isinstance(patch_text, str) and patch_text.strip() and not args.get("path")):
        for op in parse_v4a(patch_text or ""):
            targets = [op["path"]] + ([op["new_path"]] if op["new_path"] else [])
            for target in targets:
                name = protected_name(target, settings, base)
                if name:
                    return _protect_directive(target, name, settings, "patch", base)
            if op["op"] == "delete":
                continue
            dest = op["new_path"] or op["path"]
            directive = check_file_write(dest, op["added"], settings, base=base, tool_name="patch")
            if directive:
                return directive
        return None
    path = args.get("path")
    new_string = args.get("new_string")
    if not isinstance(path, str):
        return None
    name = protected_name(path, settings, base)
    if name:
        return _protect_directive(path, name, settings, "patch", base)
    if not vault_for(path, settings, base) or not settings.block_active_content:
        return None
    new_string = new_string if isinstance(new_string, str) else ""
    old_string = args.get("old_string") if isinstance(args.get("old_string"), str) else ""
    # Patching an existing file: the result, not just the fragment, must stay free of active content
    # (old "<scr" + new "ipt>"). Simulate an exact replacement when possible.
    current = _read_text(path, base)
    if current is not None and old_string and old_string in current:
        after = current.replace(old_string, new_string) if args.get("replace_all") else current.replace(old_string, new_string, 1)
        directive = check_file_write(path, after, settings, base=base, tool_name="patch", before_text=current,
                                     creates_file=False)
        if directive:
            return directive
    return check_file_write(path, new_string, settings, base=base, tool_name="patch",
                            creates_file=current is None)


_SHELL_WRITE = re.compile(
    r"(?:>{1,2}|\btee\b|\bsed\b[^|;&]*\s-[a-zA-Z]*i|\bperl\b[^|;&]*\s-[a-zA-Z]*i|\bcp\b|\bmv\b|\binstall\b|"
    r"\bln\b|\brsync\b|\bdd\b|\btruncate\b|\btouch\b|\bcurl\b[^|;&]*\s-o|\bwget\b|"
    r"\bSet-Content\b|\bAdd-Content\b|\bOut-File\b|\bCopy-Item\b|\bMove-Item\b|\bNew-Item\b|"
    r"\bcopy\b|\bmove\b|\bren(?:ame)?\b|\bxcopy\b|\brobocopy\b|open\([^)]*['\"][wa])",
    re.I,
)


def _glob_to_regex(pattern: str) -> str:
    out = []
    for ch in pattern:
        out.append(r"[^\s/\\'\"]*" if ch == "*" else r"[^\s/\\'\"]" if ch == "?" else re.escape(ch))
    return "".join(out)


def _path_spellings(path: str) -> List[str]:
    spellings = {path, os.path.normpath(os.path.expanduser(path)), real(path)}
    home = os.path.expanduser("~")
    out = set()
    for s in spellings:
        for variant in (s, s.replace("\\", "/"), s.replace("/", "\\")):
            out.add(variant.rstrip("/\\"))
            if variant.lower().startswith(home.lower()):
                out.add(("~" + variant[len(home):]).replace("\\", "/"))
    return [s for s in out if len(s) > 1]


def check_shell_command(command: str, settings: Settings, workdir: Optional[str] = None,
                        base: Optional[str] = None) -> Optional[Dict[str, str]]:
    """Best-effort: a command that both writes (redirect, tee, sed -i, cp, mv, ...) and names a protected
    file or a vault needs approval (or is blocked in block mode)."""
    if not isinstance(command, str) or not command.strip():
        return None
    if not _SHELL_WRITE.search(command):
        return None
    lowered = command.lower()
    for pattern in settings.protect:
        if re.search(r"(?<![\w.-])" + _glob_to_regex(pattern.lower()) + r"(?![\w.-])", lowered):
            return _shell_directive(f"the command writes near a protected agent instruction file ({pattern})", settings)
    wd = real(workdir, base) if workdir else (real(base) if base else None)
    for v in settings.vaults:
        if wd and is_within(wd, v["root"]):
            return _shell_directive(f"the command runs inside the vault {v['path']} and writes files", settings)
        for spelling in _path_spellings(v["path"]):
            if spelling.lower() in lowered.replace("\\\\", "\\"):
                return _shell_directive(f"the command writes into the vault {v['path']}", settings)
    return None


def _shell_directive(reason: str, settings: Settings) -> Dict[str, str]:
    advice = ("Use write_file/patch for notes (they are checked for active content); shell writes into the "
              "vault or to instruction files cannot be inspected.")
    if settings.protect_mode == "block":
        return _block(f"{reason}; blocked. {advice}")
    return {"action": "approve", "message": f"websidian: {reason}; a human must approve it. {advice}"}


def evaluate(tool_name: str, args: Any, settings: Settings, *, base: Optional[str] = None) -> Optional[Dict[str, str]]:
    """``pre_tool_call`` decision for one tool call: ``None`` (allow), ``{"action": "approve", ...}`` or
    ``{"action": "block", "message": ...}``."""
    if tool_name not in GUARDED_TOOLS or not isinstance(args, Mapping):
        return None
    if tool_name == "write_file":
        content = args.get("content")
        return check_file_write(args.get("path"), content if isinstance(content, str) else "", settings, base=base)
    if tool_name == "patch":
        return _check_patch(args, settings, base)
    if tool_name in SHELL_TOOLS:
        return check_shell_command(args.get("command"), settings, workdir=args.get("workdir"), base=base)
    if tool_name in MEMORY_TOOLS:
        return check_memory_write(args, settings, base=base)
    if tool_name in SKILL_TOOLS:
        return check_skill_write(args, settings, base=base)
    return None


def written_paths(tool_name: str, args: Any, hermes_homes: Optional[Iterable[str]] = None) -> List[str]:
    """Paths a successful call wrote (used by ``post_tool_call`` to link the notes). ``hermes_homes`` locates
    the ``memory`` and ``skill_manage`` files; it defaults to :func:`default_hermes_homes`."""
    if not isinstance(args, Mapping):
        return []
    if tool_name == "write_file":
        return [args["path"]] if isinstance(args.get("path"), str) else []
    if tool_name == "patch":
        if str(args.get("mode") or "replace").lower() == "patch" or (args.get("patch") and not args.get("path")):
            return [op["new_path"] or op["path"] for op in parse_v4a(args.get("patch") or "") if op["op"] != "delete"]
        return [args["path"]] if isinstance(args.get("path"), str) else []
    if tool_name in MEMORY_TOOLS:
        path = memory_file(args, hermes_homes) if memory_texts(args) is not None else ""
        return [path] if path else []
    if tool_name in SKILL_TOOLS:
        action = str(args.get("action") or "").strip().lower()
        return skill_written_files(args, hermes_homes) if action in SKILL_CONTENT_ACTIONS else []
    return []


# --------------------------------------------------------------------------------------------------
# Shell-hook CLI:  python guard.py --stdin
# --------------------------------------------------------------------------------------------------

def _load_hermes_settings(env: Mapping[str, str]) -> Optional[Callable[[str, Any], Any]]:
    """Reader for ``plugins.entries.websidian.settings`` in ``$HERMES_HOME/config.yaml`` (needs PyYAML,
    which Hermes ships; without it only env vars / --config apply)."""
    try:
        import yaml  # type: ignore
    except ImportError:
        return None
    for home in ([env["HERMES_HOME"]] if env.get("HERMES_HOME") else []) + default_hermes_homes():
        path = os.path.join(os.path.expanduser(home), "config.yaml")
        if os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    data = yaml.safe_load(fh) or {}
            except Exception:
                return None
            entry = ((data.get("plugins") or {}).get("entries") or {}).get(PLUGIN_ID) or {}
            section = entry.get("settings") or entry.get("config") or {}
            return lambda key, default: section.get(key, default) if isinstance(section, dict) else default
    return None


def main(argv: Optional[Sequence[str]] = None, stdin=None, stdout=None, env: Optional[Mapping[str, str]] = None) -> int:
    """Hermes shell-hook wire protocol (agent/shell_hooks.py): JSON on stdin with ``tool_name``,
    ``tool_input``, ``cwd``; to block, print ``{"action": "block", "message": ...}`` and exit 2. Shell hooks
    have no approve channel, so an approve decision is reported as a block."""
    import argparse
    parser = argparse.ArgumentParser(description="websidian write guard (Hermes shell hook)")
    parser.add_argument("--stdin", action="store_true", help="read a Hermes hook payload from stdin")
    parser.add_argument("--config", help="JSON file with {vaults, protect, protect_mode, block_active_content}")
    opts = parser.parse_args(argv)
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    env = os.environ if env is None else env
    if not opts.stdin:
        parser.print_help(stdout)
        return 0
    try:
        payload = json.loads(stdin.read() or "{}")
    except ValueError:
        return 0
    if not isinstance(payload, dict) or payload.get("hook_event_name", "pre_tool_call") != "pre_tool_call":
        return 0
    tool_name = payload.get("tool_name") or ""
    if tool_name not in GUARDED_TOOLS:
        return 0
    try:
        getter = None
        if opts.config:
            with open(opts.config, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            getter = lambda key, default: data.get(key, default)
        else:
            getter = _load_hermes_settings(env)
        settings = settings_from_sources(getter, env)
        base = payload.get("cwd") or env.get("TERMINAL_CWD") or None
        directive = evaluate(tool_name, payload.get("tool_input") or {}, settings, base=base)
    except Exception as exc:  # fail closed for the tools we guard
        directive = _block(f"guard error ({type(exc).__name__}: {exc}); refusing the write to be safe.")
    if not directive:
        return 0
    stdout.write(json.dumps({"action": "block", "message": directive.get("message") or "websidian: blocked"}))
    stdout.flush()
    return 2


if __name__ == "__main__":
    sys.exit(main())
