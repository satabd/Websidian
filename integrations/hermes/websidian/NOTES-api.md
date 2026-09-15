# Hermes plugin API: verified facts

Source read: `github.com/NousResearch/hermes-agent`, shallow clone of `main` at commit
`b6b53c69a6ed49cb099cf1bfe76b5e6edd718e5a` (2026-09-12). Hermes itself was not installed or run.
Line numbers refer to that commit.

The docs page `/docs/guides/build-a-hermes-plugin` no longer exists: `website/docusaurus.config.ts:58`
redirects it to `/developer-guide/plugins` (`website/docs/developer-guide/plugins/index.md`).

## Discovery, enabling, manifest

- User plugins live in `~/.hermes/plugins/<name>/` with `plugin.yaml` and `__init__.py` exposing
  `register(ctx)` (`website/docs/user-guide/features/plugins.md`, "Quick overview").
- General plugins are opt-in: they load only when listed in `plugins.enabled` in `~/.hermes/config.yaml`,
  set by `hermes plugins enable <name>` (plugins.md:149-173).
- Manifest parsing: `hermes_cli/plugins_manifest.py:458` `parse_manifest_file`. Known fields
  (`_KNOWN_MANIFEST_FIELDS`, :33) include `name, version, description, author, requires_env,
  provides_tools, provides_hooks, hooks, config_schema, license, homepage, tags, capabilities`. Unknown
  fields only warn. `config_schema` is a mapping of `key -> {type, default, description, required}` with
  types `str/int/float/bool/list/dict` (:45, :139).
- The registry id of a top-level user plugin is its manifest `name` (`key = f"{prefix}/{dir}" if prefix
  else name`, :468; `manifest_key`, :316). So this plugin's id is `websidian`.
- The plugin is imported as a package: bundled plugins use relative imports (`plugins/security-guidance/
  __init__.py`: `from . import patterns`).

## Plugin config

- `PluginContext.get_config(key, default)` (`hermes_cli/plugins.py:257`) reads
  `plugins.entries.<plugin_id>.settings.<key>` from config.yaml (dotted keys allowed; falls back to the
  legacy `plugins.entries.<id>.config` subtree). Documented in developer-guide/plugins/index.md:552
  ("Store settings and runtime state"). The plugin calls it on every hook, so config edits apply without
  re-registering; it falls back to `WEBSIDIAN_*` env vars for unset keys.

## Registration surface (`hermes_cli/plugins.py`)

- `register_hook(hook_name, callback)` :904. Unknown names warn but are stored.
- `VALID_HOOKS` :108 includes `pre_tool_call`, `post_tool_call`, `transform_tool_result`,
  `transform_terminal_output`, `transform_llm_output`, `pre_llm_call`, `post_llm_call`, session hooks...
- `register_tool(name, toolset, schema, handler, check_fn=None, requires_env=None, is_async=False,
  description="", emoji="", override=False)` :460. Shadowing an existing tool name without `override=True`
  is refused (returns `None`).
- Tool handlers are called `handler(args: dict, **kwargs)` (`tools/registry.py:821` `dispatch`), with
  kwargs `task_id`, `session_id` and `user_task` (`model_tools.py:811`). Handlers return a JSON string
  (docs example `handle_hello`; built-ins return `tool_error(...)`/JSON). Exceptions become
  `{"error": ...}`.
- `register_command(name, handler, description="", args_hint="", argument_mode=None)` :663. Handler is
  `fn(raw_args: str) -> str | None` (sync or async); a name that collides with a built-in command is
  skipped with a warning. `brain` is not a built-in command (no match in `hermes_cli/commands*.py`).
- `register_skill(name, path: Path, description="", frontmatter=None)` :985. The skill is resolvable as
  `<plugin name>:<name>` via `skill_view()` but is NOT listed in `<available_skills>` ("explicit loads
  only"). `path` must exist; name must match `[a-zA-Z0-9_-]+`.
- `register_system_prompt_section(id, content: str | callable(mapping) -> str, *, position="after_memory",
  max_chars=4000)` :928; ids are lowercase `[a-z0-9._-]`, positions only `after_memory`, max 4000 chars
  (`hermes_cli/plugins_dispatch.py:56-58`). Used here to tell the agent where the vaults are and to load
  `websidian:websidian`, since plugin skills are not advertised automatically.

## pre_tool_call

- Fired once per tool call before dispatch: `model_tools.py:764` -> `_dispatch_pre_tool_call_hooks` ->
  `_get_pre_tool_call_directive_details` (`hermes_cli/plugins.py:1787`), called with kwargs
  `tool_name, args (dict), task_id, session_id, tool_call_id, turn_id, api_request_id, middleware_trace`.
- Directives (first valid one wins, :1810-1831; docs hooks.md:531):
  - `{"action": "block", "message": str}` - message required, becomes the tool's error result.
  - `{"action": "approve", "message"?: str, "rule_key"?: str}` - escalates to the human approval gate
    (`_resolve_block_from_details` :1858 -> `tools/approval.py:1001 request_tool_approval`). Denial,
    timeout, gate error, or no interactive user/gateway (outside cron) all fail closed (block).
    `rule_key` sets the grain of the "[a]lways" allowlist.
  - `{"action": "modify", "args": {...}}` - shallow-merged into the args (not used here).
- A raising callback is logged and skipped (`hermes_cli/plugins_dispatch.py:202`), i.e. fails OPEN, so
  the plugin catches its own errors and returns a block for guarded tools. A callback exceeding
  `plugins.hook_callback_timeout` (default 30 s) fails closed for `pre_tool_call`
  (`_HOOK_TIMEOUT_FAIL_CLOSED_HOOKS`, plugins_dispatch.py:48).

## post_tool_call

- `model_tools.py:664 _emit_post_tool_call_hook`: kwargs `tool_name, args, result (JSON string),
  task_id, session_id, tool_call_id, turn_id, api_request_id, duration_ms, status ("ok"|"error"),
  error_type, error_message, middleware_trace`. Return value ignored. `status` is derived from a JSON
  `error` key or `agent.display._detect_tool_failure`.

## transform_llm_output (appending links to the reply)

- `agent/turn_finalizer.py:401 _apply_output_hooks`: once per turn after the tool loop, kwargs
  `response_text, session_id, model, platform`. The first non-empty string returned replaces the final
  response (docs hooks.md:1560; applies to CLI, gateway and programmatic callers; not fired on
  interrupted or empty turns). The plugin uses it to append "Notes updated:" links, and ALSO registers the
  `websidian_links` tool so the agent can put links in its own words.

## Built-in file tools (names and args)

- `write_file` (`tools/file_tools.py:1038`, registered :1251): `path`, `content`.
- `patch` (:1056, registered :1274): replace mode `path`, `old_string`, `new_string`, `replace_all`;
  V4A mode (`mode: "patch"`, `patch: str`, :1114) accepted from any model. V4A ops
  (`tools/patch_parser.py`): `*** Add File: p` / `*** Update File: p` / `*** Delete File: p` /
  `*** Move File: a -> b`, added lines start with `+`.
- `terminal` (`tools/terminal_tool.py:1270`): `command`, `background`, `timeout`, `workdir`, `pty`, `notify`.
- Relative file-tool paths resolve against the session cwd (`tools/file_tools_paths.py:161-177`:
  `get_session_cwd(task_id)`, then `$TERMINAL_CWD`, then process cwd). The plugin mirrors this.
- Other writers the plugin does not inspect: `skill_manage` (writes skills), `memory` (MEMORY.md/USER.md
  through its own store), `execute_code` (arbitrary Python).
- Hermes already has its own always-ask gate for `AGENTS.md`, `CLAUDE.md`, `SOUL.md`, `.cursorrules` in
  project directories (`tools/file_tools_write_guards.py:139`), but it explicitly skips files inside the
  Hermes home (:186). This plugin covers the Hermes home and vaults, with a longer list.

## Hermes home

- `hermes_constants.get_hermes_home()`; platform default is `%LOCALAPPDATA%\hermes` on Windows and
  `~/.hermes` elsewhere (`hermes_constants.py:45`), overridable by `HERMES_HOME`. The plugin protects all
  of `~/.hermes`, `$HERMES_HOME`, the Windows default and `get_hermes_home()` when importable.

## Shell hooks (the no-Python alternative)

- `agent/shell_hooks.py`; docs hooks.md:1681-1760. Config: top-level `hooks: { pre_tool_call: [ {matcher,
  command, timeout, fail_closed} ] }`; `matcher` is a regex full-matched against the tool name. First use
  needs consent (TTY prompt, `--accept-hooks`, `HERMES_ACCEPT_HOOKS=1` or `hooks_auto_accept: true`).
- stdin JSON (`_serialize_payload` :392, `_payload_fields` :80): `hook_event_name, tool_name, tool_input,
  session_id, cwd, profile, extra`.
- To block: exit code 2 (`BLOCK_EXIT_CODE`, :43) and/or stdout `{"action": "block", "message": ...}`
  (`_parse_pre_tool_call` :408; Claude-Code `{"decision": "block", "reason"}` also accepted).
  `_evaluate_result` :351: exit 2 uses the stdout block JSON message, else stderr, else a default.
- Shell hooks have NO approve channel (only block / modify), so `guard.py --stdin` reports approve
  decisions as blocks.
- Spawn errors and timeouts fail open unless `fail_closed: true`.

## Skill format

- `skills/note-taking/obsidian/SKILL.md`: YAML frontmatter `name, description, version, author, license,
  platforms, metadata.hermes.tags, metadata.hermes.related_skills`, then Markdown.

## Not verified / assumptions

- Nothing was executed against a live Hermes; the fake context in `tests/test_plugin.py` mirrors the
  signatures above.
- Whether `transform_llm_output` output is shown on every gateway platform exactly as returned (the docs
  say it applies to "CLI, gateway, or programmatic caller").
- `session_id` equality between `post_tool_call` and `transform_llm_output` for the same turn (both come
  from the agent's session id in the source; the plugin falls back to `task_id`, then `"default"`).

## Dashboard extension (verified 2026-09-13)

Source read inside the `hermes01` container: Hermes Agent v0.20.6, `/root/.hermes/hermes-agent` at commit
`2a598aad1c398e95b3325a0f100f5c28efa63d12`. Line numbers refer to that tree. Items marked "tested" were
exercised by the in-container integration test: the real `hermes_cli.web_server` app on a throwaway port with
`HERMES_HOME=/tmp/wsd-test/home`, the bundled basic password provider, and headless Chromium through
`playwright-core`. The live dashboard was not touched.

### Discovery and mounting

- `hermes_cli/web_server.py:18335 _discover_dashboard_plugins` scans `<hermes home>/plugins/*/dashboard/manifest.json`
  (plus the default root when profile-scoped), then bundled `plugins/memory/*` and `plugins/*`; the user source
  wins on name conflicts. Tab info: `path` (default `/<name>`), `position` (default `end`), optional `override`,
  `hidden`. `api` must be a relative file inside `dashboard/` (`_safe_plugin_api_relpath`). Tested.
- `:18972 _mount_plugin_api_routes` runs at module import (`:19087`, before `mount_spa(app)` at `:19096`). User
  plugins are imported only when listed in `plugins.enabled` and not in `plugins.disabled`. The file is loaded
  with `importlib.util.spec_from_file_location("hermes_dashboard_plugin_<name>", ...)` (`:19060`), so
  `plugin_api.py` cannot use package-relative imports: this plugin loads `wsd_core.py` and `../sites.py` by
  path. The module-level `router` is included with prefix `/api/plugins/<name>` (`:19080`). Routes are mounted
  once; `/api/dashboard/plugins/rescan` does not mount new ones (docs, Troubleshooting). Tested.
- `hermes_cli.web_server` is imported for `hermes dashboard` (`hermes_cli/main.py:12246` `start_server`,
  `:11714` a start-up helper), so the supervisor thread started at import runs in the dashboard process, not in
  the gateway.
- `:904 _plugin_api_runtime_gate` re-checks enabled/disabled on every request (404 for a disabled user plugin),
  but only after auth, so it is not a plugin-name oracle.
- Plugin data dir convention: `hermes_cli/plugins.py:1392 PluginState.data_dir` is
  `get_hermes_home()/plugin-data/<namespace>` (namespace hashed for some ids); the bundled hermes-achievements
  plugin uses `plugin-data/hermes-achievements`. This plugin uses `plugin-data/websidian`.
- Config from a backend: `hermes_cli.config.load_config_readonly()` (`hermes_cli/config.py:3587`, mtime-cached,
  must not be mutated) or `load_config()` (`:3570`, deep copy); both honour `HERMES_HOME`. Tested.

### Frontend routing and deep links

- `web/src/App.tsx:256 buildNavItems` inserts plugin tabs at `after:<seg>` / `before:<seg>` / end; plugin tabs
  render in a separate "Plugins" sidebar section (`:667`). Icons come from `ICON_MAP` (documented list;
  `FileText` is used here).
- `App.tsx:351`: a plugin route is `<Route path={m.tab.path} element={<PluginPage/>}>` inside `<Routes>`
  (react-router, `<BrowserRouter basename={HERMES_BASE_PATH}>` in `web/src/main.tsx:16`). The match is exact:
  `/websidian/sub` falls through to the `*` unknown-route fallback, so deep-link state goes in the query string.
- `window.__HERMES_BASE_PATH__` (`web/src/lib/api.ts:12`) is the dashboard URL prefix; plugin assets load from
  `${HERMES_BASE_PATH}/dashboard-plugins/<name>/<file>` (`web/src/plugins/usePlugins.ts:105,117`).
- SDK (`web/src/plugins/registry.ts:112 exposePluginSDK`, contract `1.1.0`): `React`, `hooks` (useState,
  useEffect, useCallback, useMemo, useRef, useContext, createContext, useToast, useConfirmDelete), `api`,
  `fetchJSON`, `authedFetch`, `buildWsUrl`, `components` (Card*, Badge, Button, Checkbox, ConfirmDialog,
  Dialog*, Input, Label, Select, SelectOption, Separator, Tabs*, Toast, PluginSlot), `utils`, `useI18n`.
- `fetchJSON` (`api.ts:106`) prefixes the base path, sends `credentials: "include"` and the loopback session
  token header; on a 401 whose `error` is `unauthenticated`/`session_expired` it saves
  `sessionStorage["hermes.lastLocation"]` and navigates to `login_url` (`:139-157`).
- The login redirect keeps the query: the gate's `_safe_next_target` (`hermes_cli/dashboard_auth/middleware.py:244`)
  URL-encodes `path?query` into `/login?next=`; `/auth/password-login` (`dashboard_auth/routes.py:698`) answers
  `next = _validate_post_login_target(body.next)` (`routes.py:608`, `:861`), which unquotes once and rejects
  `//`, `/login`, `/auth/`, `/api/`. Tested: `/websidian?site=test&note=Plain%20Note&edit=1` ->
  `302 /login?next=%2Fwebsidian%3Fsite%3Dtest%26note%3DPlain%2520Note%26edit%3D1`, and the login answer's
  `next` is `/websidian?site=scratch&note=Plain Note` (decoded once, so `%26`, `%23`, `%2B`, `%25` inside a note
  name do not survive a login redirect).

### Auth for plugin routes and iframe navigations

Middleware order (Starlette runs the last registered first): health -> `_token_auth_seam` (`web_server.py:1010`)
-> `auth_middleware` (`:986`) -> `_dashboard_auth_gate` (`:980`) -> `_plugin_api_runtime_gate` (`:904`) ->
`host_header_middleware` (`:869`) -> CORS -> routes.

- Gated mode: `app.state.auth_required` is set in `start_server` (`:19507`) from
  `should_require_dashboard_auth`: true for any non-loopback bind or non-loopback `dashboard.public_url`
  (`--insecure` no longer disables it). `gated_auth_middleware` (`middleware.py:323`) lets public prefixes
  (`_GATE_PUBLIC_PREFIXES`, `:49`: `/login`, `/auth/...`, `/assets/`, fonts) and the exact `PUBLIC_API_PATHS`
  (`public_paths.py:33`) through; `/api/plugins/*` is never public. An `Authorization: Bearer` header is
  verified first (an unknown one -> 401 `session_expired`; tested); otherwise the `hermes_session_at` /
  `hermes_session_rt` cookies are verified (with transparent refresh) and the `Session` (`user_id`, `email`,
  `display_name`, `provider`...; `dashboard_auth/base.py:10`) is set on `request.state.session`. Without a
  session, `/api/*` answers `401 {"error": "unauthenticated", "detail": "Unauthorized", "reason": "no_cookie",
  "login_url": "/login"}` and never redirects (`_unauth_response`, `:112`); other paths get 302
  `/login?next=...` (or auto-SSO with a single OAuth provider). Tested for `/api/plugins/websidian/w/...` and
  `/api/plugins/websidian/status`.
- Session cookies are `HttpOnly; SameSite=Lax` with `Path` = the prefix (`dashboard_auth/cookies.py:250-275`),
  so same-origin iframe loads and `fetch` calls from Websidian pages carry them. Tested in Chromium: the iframe
  page, the editor page and its API calls work with only the dashboard session.
- The basic password provider's session has `user_id = display_name = <username>`
  (`plugins/dashboard_auth/basic/__init__.py:303`); the proxy sends `display_name` as `x-websidian-user`. Tested.
- Loopback mode (`auth_required` false): `auth_middleware` requires the `X-Hermes-Session-Token` header (or the
  legacy Bearer token) on every non-public `/api/` path (`:986-1006`); `?token=` is accepted only for
  `/api/files/download` (`_QUERY_TOKEN_API_PATHS`, `:680`). An iframe navigation cannot send the header, so the
  tab's iframe gets 401 in loopback mode (not supported).
- The dashboard sets no `X-Frame-Options` or `frame-ancestors` (grep of `hermes_cli/`), so framing its own
  routes works; Websidian's untrusted CSP does not restrict `frame-ancestors` either.

### Dashboard extension: not verified

- Behind a reverse proxy with `X-Forwarded-Prefix` (the plugin prefixes Websidian's basePath with the path of
  `dashboard.public_base`; untested).
- OAuth providers (only the basic password provider was exercised).
- The live dashboard's restart with the plugin installed (the owner deploys); the throwaway app ran with
  `lifespan="off"`.
- `hermes config set` with JSON literals under `plugins.entries.websidian.settings` was read in
  `hermes_cli/config.py:5570 set_config_value` (structured literals are parsed), not executed.
