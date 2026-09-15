"""websidian - connect Hermes Agent to a Websidian site (an Obsidian vault served as a website).

What ``register(ctx)`` wires up (every call is feature-probed, so an older Hermes degrades gracefully):

- ``pre_tool_call``: :mod:`guard` - agent instruction files need human approval; vault writes must be
  plain Markdown (no scripts, frames, event handlers, javascript: URLs, .html/.svg/.js files).
- ``post_tool_call``: remember notes written inside a vault, per session.
- ``transform_llm_output``: append "Notes updated:" with view and edit links to the final reply.
- tool ``websidian_links``: links for given paths, or for the notes changed this session.
- slash command ``/brain [query]``: the 10 most recently modified notes, with links.
- skill ``websidian:websidian`` and a short system-prompt section pointing the agent at the vaults.

Settings live under ``plugins.entries.websidian.settings`` in config.yaml (``ctx.get_config``), with
``WEBSIDIAN_*`` environment variables as fallback.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Optional

try:  # imported as a package by Hermes
    from . import guard, links
except ImportError:  # pragma: no cover - loaded as a top-level module (tests / ad-hoc use)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import guard  # type: ignore  # noqa: E402
    import links  # type: ignore  # noqa: E402

logger = logging.getLogger(__name__)

PLUGIN_DIR = Path(__file__).resolve().parent
SKILL_PATH = PLUGIN_DIR / "skills" / "websidian" / "SKILL.md"
TOOL_NAME = "websidian_links"
MAX_TRACKED_PER_SESSION = 200
MAX_SESSIONS = 256


class ChangeTracker:
    """Notes written per session: ``all`` for the websidian_links tool, ``pending`` for the next reply footer."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: "OrderedDict[str, Dict[str, OrderedDict]]" = OrderedDict()

    def _session(self, sid: str) -> Dict[str, OrderedDict]:
        s = self._sessions.get(sid)
        if s is None:
            s = {"all": OrderedDict(), "pending": OrderedDict()}
            self._sessions[sid] = s
            while len(self._sessions) > MAX_SESSIONS:
                self._sessions.popitem(last=False)
        else:
            self._sessions.move_to_end(sid)
        return s

    def record(self, sid: str, entry: Dict[str, str]) -> None:
        with self._lock:
            s = self._session(sid or "default")
            for bucket in ("all", "pending"):
                s[bucket].pop(entry["rel"] + "\0" + entry["vault"], None)
                s[bucket][entry["rel"] + "\0" + entry["vault"]] = entry
                while len(s[bucket]) > MAX_TRACKED_PER_SESSION:
                    s[bucket].popitem(last=False)

    def all(self, sid: str) -> List[Dict[str, str]]:
        with self._lock:
            s = self._sessions.get(sid or "default")
            return list(s["all"].values()) if s else []

    def take_pending(self, sid: str) -> List[Dict[str, str]]:
        with self._lock:
            s = self._sessions.get(sid or "default")
            if not s:
                return []
            items = list(s["pending"].values())
            s["pending"].clear()
            return items


def _session_key(kwargs: Dict[str, Any]) -> str:
    return str(kwargs.get("session_id") or kwargs.get("task_id") or "default")


def _hermes_homes() -> List[str]:
    homes = guard.default_hermes_homes()
    try:
        from hermes_constants import get_hermes_home  # type: ignore
        homes.append(str(get_hermes_home()))
    except Exception:
        pass
    return homes


def _workdir(task_id: str) -> Optional[str]:
    """Base directory Hermes uses for relative file-tool paths (session cwd, then $TERMINAL_CWD, then cwd)."""
    try:
        from tools.terminal_tool import get_session_cwd  # type: ignore
        cwd = get_session_cwd(task_id or "default")
        if cwd:
            return str(cwd)
    except Exception:
        pass
    cwd = os.environ.get("TERMINAL_CWD", "")
    return cwd if cwd and os.path.isabs(cwd) else None


def _result_ok(result: Any, status: Optional[str]) -> bool:
    if status and status != "ok":
        return False
    if isinstance(result, str):
        try:
            parsed = json.loads(result)
        except ValueError:
            return True
        if isinstance(parsed, dict) and (parsed.get("error") or parsed.get("success") is False):
            return False
    return True


class WebsidianPlugin:
    def __init__(self, ctx: Any = None, env: Optional[Dict[str, str]] = None):
        self.ctx = ctx
        self.env = env
        self.tracker = ChangeTracker()

    # -- settings ---------------------------------------------------------------------------------
    def settings(self) -> guard.Settings:
        getter = getattr(self.ctx, "get_config", None) if self.ctx is not None else None
        return guard.settings_from_sources(getter if callable(getter) else None, self.env, hermes_homes=_hermes_homes())

    # -- hooks ------------------------------------------------------------------------------------
    def on_pre_tool_call(self, tool_name: str = "", args: Any = None, task_id: str = "", **kwargs: Any) -> Optional[Dict[str, str]]:
        if tool_name not in guard.GUARDED_TOOLS:
            return None
        try:
            settings = self.settings()
            if not settings.vaults and not settings.protect:
                return None
            return guard.evaluate(tool_name, args, settings, base=_workdir(task_id))
        except Exception as exc:  # Hermes logs and skips a raising hook (fail open) - fail closed instead.
            logger.warning("websidian pre_tool_call failed for %s: %s", tool_name, exc, exc_info=True)
            return {"action": "block",
                    "message": f"websidian: the write guard failed ({type(exc).__name__}); refusing {tool_name} to be safe."}

    def on_post_tool_call(self, tool_name: str = "", args: Any = None, result: Any = None, task_id: str = "",
                          status: Optional[str] = None, **kwargs: Any) -> None:
        if tool_name not in guard.FILE_TOOLS or not _result_ok(result, status):
            return None
        try:
            settings = self.settings()
            if not settings.vaults:
                return None
            base = _workdir(task_id)
            sid = _session_key({"task_id": task_id, **kwargs})
            for path in guard.written_paths(tool_name, args):
                entry = links.links_for_path(path, settings.vaults, base)
                if entry:
                    self.tracker.record(sid, entry)
        except Exception as exc:
            logger.debug("websidian post_tool_call failed: %s", exc)
        return None

    def on_transform_llm_output(self, response_text: str = "", session_id: str = "", **kwargs: Any) -> Optional[str]:
        try:
            pending = self.tracker.take_pending(session_id or kwargs.get("task_id") or "default")
            if not pending or not self.settings().append_links:
                return None
            text = response_text or ""
            missing = [e for e in pending if not e.get("view") or e["view"] not in text]
            if not missing:
                return None  # the agent already shared every link
            return text.rstrip() + "\n\n" + links.format_links_block(missing)
        except Exception as exc:
            logger.debug("websidian transform_llm_output failed: %s", exc)
            return None

    # -- tool -------------------------------------------------------------------------------------
    TOOL_SCHEMA = {
        "name": TOOL_NAME,
        "description": ("Get Websidian web links (view URL and editor URL) for notes in the configured Obsidian "
                        "vault(s). Pass file paths, or omit them to get every note written in this session. "
                        "Include the view links in your reply after creating or updating notes."),
        "parameters": {
            "type": "object",
            "properties": {
                "paths": {"type": "array", "items": {"type": "string"},
                          "description": "Note file paths (absolute, ~ or relative). Omit for notes changed this session."},
            },
            "required": [],
        },
    }

    def handle_links_tool(self, args: Any = None, **kwargs: Any) -> str:
        try:
            settings = self.settings()
            if not settings.vaults:
                return json.dumps({"error": "websidian: no vaults configured (plugins.entries.websidian.settings.vaults)"})
            paths = (args or {}).get("paths") if isinstance(args, dict) else None
            if paths:
                base = _workdir(str(kwargs.get("task_id") or ""))
                notes, outside = [], []
                for p in paths if isinstance(paths, list) else [paths]:
                    entry = links.links_for_path(str(p), settings.vaults, base)
                    (notes.append(entry) if entry else outside.append(str(p)))
                return json.dumps({"notes": notes, "not_in_vault": outside}, ensure_ascii=False)
            notes = self.tracker.all(_session_key(kwargs))
            return json.dumps({"notes": notes, "vaults": [{"path": v["path"], "url": v["url"], "slug": v["slug"]}
                                                     for v in settings.vaults]},
                              ensure_ascii=False)
        except Exception as exc:
            return json.dumps({"error": f"websidian_links failed: {exc}"})

    # -- slash command ----------------------------------------------------------------------------
    def handle_brain_command(self, raw_args: str = "") -> str:
        settings = self.settings()
        if not settings.vaults:
            return "websidian: no vaults configured. Set plugins.entries.websidian.settings.vaults in config.yaml."
        query = (raw_args or "").strip()
        notes = links.recent_notes(settings.vaults, query=query, limit=10)
        if not notes:
            return f"No notes matching '{query}'." if query else "No notes found in the configured vaults."
        title = f"Notes matching '{query}' (most recent first):" if query else "Recently modified notes:"
        lines = [title]
        for n in notes:
            name = n["rel"][:-3]
            lines.append(f"- {name}: {n['view']}" if n["view"] else f"- {name} ({n['path']})")
        return "\n".join(lines)

    # -- system prompt ----------------------------------------------------------------------------
    def system_prompt(self, _session_info: Any = None) -> str:
        try:
            settings = self.settings()
        except Exception:
            return ""
        if not settings.vaults:
            return ""
        lines = ["Websidian vaults (Obsidian notes published as a website):"]
        for v in settings.vaults[:10]:
            lines.append(f"- {v['path']}" + (f" -> {v['url']}" if v["url"] else ""))
        lines.append("Before writing notes there, load the skill `websidian:websidian`. Notes are plain Obsidian "
                     "Markdown (no raw HTML); agent instruction files need human approval. After writing notes, "
                     f"share their view links (the `{TOOL_NAME}` tool returns them).")
        return "\n".join(lines)[:3900]


_plugin: Optional[WebsidianPlugin] = None


def register(ctx: Any) -> None:
    """Hermes entry point."""
    global _plugin
    plugin = WebsidianPlugin(ctx)
    _plugin = plugin

    ctx.register_hook("pre_tool_call", plugin.on_pre_tool_call)
    ctx.register_hook("post_tool_call", plugin.on_post_tool_call)
    ctx.register_hook("transform_llm_output", plugin.on_transform_llm_output)

    if hasattr(ctx, "register_tool"):
        ctx.register_tool(name=TOOL_NAME, toolset="websidian", schema=WebsidianPlugin.TOOL_SCHEMA,
                          handler=plugin.handle_links_tool)

    if hasattr(ctx, "register_command"):
        ctx.register_command("brain", plugin.handle_brain_command,
                             description="List recently modified Websidian notes with links (/brain <query> to filter)",
                             args_hint="[query]")

    if hasattr(ctx, "register_skill") and SKILL_PATH.exists():
        try:
            ctx.register_skill("websidian", SKILL_PATH,
                               description="Write notes into the Websidian vault as plain Obsidian Markdown and share their links.")
        except Exception as exc:
            logger.warning("websidian: could not register skill: %s", exc)

    if hasattr(ctx, "register_system_prompt_section"):
        try:
            ctx.register_system_prompt_section("websidian.vaults", plugin.system_prompt)
        except Exception as exc:
            logger.debug("websidian: could not register system prompt section: %s", exc)
