# websidian: Hermes Agent plugin

Connects [Hermes Agent](https://github.com/NousResearch/hermes-agent) to a Websidian site, the server in
this repository that publishes an Obsidian vault as a website (`<baseUrl>/<slug>/<note>`) with a browser
editor (`<baseUrl>/<slug>/_edit/<note>`).

When the agent writes notes into the vault, the plugin:

1. **Stops bad writes before they happen** (`pre_tool_call` on `write_file`, `patch`, `terminal`, `memory`
   and `skill_manage`):
   - Writes to agent instruction files (`SKILL.md`, `SOUL.md`, `AGENTS.md`, `MEMORY.md`, `USER.md`,
     `TOOLS.md`, `IDENTITY.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`; case-insensitive basename match) anywhere
     under the Hermes home or inside a configured vault need a human's approval, through Hermes's own
     approval prompt. Paths are resolved first (`~`, relative paths, `..`, symlinks).
   - The agent's own writers of those files go through the same rule: a `memory` write (`add`, `replace`,
     `remove`, alone or in an `operations` batch) counts as a write to `<hermes home>/memories/MEMORY.md`
     (or `USER.md` for `target: user`), and a `skill_manage` `create`/`edit`/`patch`/`write_file`/`delete`/
     `remove_file` as a write to `<hermes home>/skills/[<category>/]<name>/SKILL.md` and the files of that
     folder. Their text is checked for active content as well, and a refusal there wins over the approval
     prompt. Read-only actions (memory read/search, and the separate `skills_list`/`skill_view` tools) and
     argument shapes the guard does not recognise pass through untouched.
   - Writes into a vault must be plain Markdown. Content with `<script>`, `<iframe>`, `<object>`,
     `<embed>`, `<form>`, `<meta>`, `<base>`, event-handler attributes (`onerror=`...), or `javascript:`,
     `vbscript:`, `data:text/html` URLs is blocked, including entity and whitespace obfuscation
     (`java&#x09;script:`, `<ScRiPt`). Code inside fenced code blocks and inline code spans is ignored,
     but only where Websidian's renderer certainly shows it as code; anything ambiguous is scanned.
   - Creating `.html`, `.htm`, `.xhtml`, `.svg`, `.xml` or `.js` files inside a vault is blocked.
   - For `patch`, the text being inserted is checked (and, for replace-mode patches of existing files,
     the resulting file, so a tag cannot be assembled from two halves).
   - `terminal` commands are checked best-effort (see Limitations).
2. **Shares links** to the notes it wrote: a "Notes updated:" list with view and edit URLs is appended to
   the agent's reply (`transform_llm_output`), unless the reply already contains them.
3. Adds a **Websidian tab to the Hermes dashboard** ([Dashboard tab](#dashboard-tab)): the dashboard runs
   Websidian on loopback and proxies it behind the dashboard login.
4. Adds a **`websidian_links` tool** (links for given paths, or for the notes changed this session), a
   **`/brain [query]` command** (10 most recently modified notes with links), **two skills**
   (`websidian:websidian` with the vault writing rules, `websidian:websidian-install` with the
   install/update runbook), and a short system-prompt section telling the agent where the vaults are.

## Install

`hermes plugins install <repo>` cannot take this repository: its root is the Websidian application and the
plugin manifest is nested at `integrations/hermes/websidian/plugin.yaml`. Install it with the script for your
platform instead, or copy the folder by hand.

### Native profile (macOS, Linux, Git Bash on Windows)

From the repository root:

```bash
bash integrations/hermes/websidian/deploy/install-local.sh
```

It finds the profile (`$HERMES_HOME`, else `~/.hermes`), copies the plugin to `<profile>/plugins/websidian`
and the Websidian runtime to `<profile>/plugin-data/websidian/app`, runs `npm --prefix <app_dir> ci
--omit=dev --ignore-scripts` **in app_dir**, checks the layout, then starts the installed server once on a
throw-away vault and asks it for `/_health`. Options: `--hermes-home`, `--app-dir`, `--plugin-dir`,
`--no-smoke`, `--dry-run`, `--restart-runtime` (see [Update](#update)).

### Native profile (Windows PowerShell)

```powershell
powershell -ExecutionPolicy Bypass -File integrations\hermes\websidian\deploy\install-local.ps1
```

Same steps and the same checks; options are `-HermesHome`, `-AppDir`, `-PluginDir`, `-NodeExe`, `-NoSmoke`,
`-DryRun`, `-RestartRuntime`. The profile is `$env:HERMES_HOME`, else `~\.hermes`, else `%LOCALAPPDATA%\hermes`.

### Docker container

See [Deploy into a container](#deploy-into-a-container).

### By hand

```bash
cp -r integrations/hermes/websidian ~/.hermes/plugins/websidian     # Windows: %LOCALAPPDATA%\hermes\plugins\websidian
```

The write guard, the links, the tool and the skill work with this alone — no extra Python packages are
needed. The **dashboard tab additionally needs the Websidian runtime**, and `npm ci` has to run with
`app_dir` as its prefix: a plain `npm ci` in your checkout puts `node_modules` there, the supervised
`node <app_dir>/src/server.js` finds none, and the tab shows a 502 while the plugin still reports as
installed.

```bash
mkdir -p ~/.hermes/plugin-data/websidian/app
cp -r src public package.json package-lock.json ~/.hermes/plugin-data/websidian/app/
npm --prefix ~/.hermes/plugin-data/websidian/app ci --omit=dev --ignore-scripts
```

### Enable it, then activate it

Enabling is recorded in `config.yaml`; it takes effect in the *next* session of each process.

```bash
hermes plugins enable websidian     # decline "replace built-in tools": see below
hermes plugins list --plain         # websidian ... enabled
hermes dashboard --status
```

- **Decline `--allow-tool-override`.** The plugin works through its three hooks and its own
  `websidian_links` tool; it never needs to replace a built-in tool. If a future version asks for it, that
  version should say why.
- **Restart the dashboard** before the Websidian tab exists: plugin API routes are mounted once, at
  dashboard start-up, and that is also what starts the supervised Websidian process.
- **Restart the gateway** before the write guard and the "Notes updated:" links act in chat.
- The installers restart neither: when you take that interruption is your call.

### Acceptance checklist

An install is complete when all of these hold:

| # | Check |
|---|---|
| 1 | `<profile>/plugins/websidian/plugin.yaml` and `dashboard/manifest.json` exist |
| 2 | `<app_dir>/src/server.js` and `<app_dir>/node_modules/` exist |
| 3 | `hermes plugins list --plain` shows `websidian` as enabled |
| 4 | Every configured `vaults[].path` exists and is readable |
| 5 | The installed server answers `200` on `/_health` (the installers' smoke test) |
| 6 | A page from an untrusted vault carries a CSP and `X-Content-Type-Options: nosniff` |
| 7 | The **Websidian** tab appears after *you* restart the dashboard |
| 8 | The dashboard runs in its gated mode and you have a signed-in session |
| 9 | Through that session, in a browser, both `/api/plugins/websidian/status` and `/api/plugins/websidian/w/<slug>/` load |
| 10 | Chat replies carry links after *you* restart the gateway |

Checks 2, 5 and 6 are also a test in this repository (`test/hermes-install.test.js`): it builds the
installed layout in a temp folder, boots it, and asserts the health, the CSP headers and that every asset
the page references resolves. Checks 8 and 9 have to be done by a human in a signed-in browser; record the
result when you close out an installation.

**A healthy Node runtime is not a working tab.** Everything the tab needs lives under `/api/plugins/`,
which the dashboard's auth gate never makes public. A default local dashboard on `127.0.0.1:9119` renders
`/websidian` without a login and then answers `401` on those routes, because a plugin route in that mode
wants an `X-Hermes-Session-Token` header an iframe cannot send. The four states are independent: **plugin
enabled**, **Websidian healthy**, **dashboard session authenticated**, **protected routes reachable through
that session**.

> **Never weaken, bypass or remove dashboard authentication to make the tab work.** Put the dashboard in its
> gated mode instead — basic auth for a trusted LAN or VPN, OAuth for anything reachable from the internet —
> and keep agent-facing vaults `untrusted: true`. The iframe is same-origin with the dashboard, so a page the
> gate lets through runs with the signed-in user's privileges.

## Update

```bash
git pull && bash integrations/hermes/websidian/deploy/install-local.sh --restart-runtime
```

Re-running the installer *is* the update: it removes `app_dir/src` and `app_dir/public` before re-copying,
re-runs `npm ci` (so a lockfile change is picked up) and replaces the plugin folder.

**Copying files updates nothing that is already running.** The supervisor restarts Websidian only when the
generated config changes or `/_health` stops answering — never because the code on disk changed. Match the
restart to what changed:

| Changed upstream | What has to restart |
|---|---|
| `src/`, `public/`, dependencies | the supervised Websidian process: `--restart-runtime` / `-RestartRuntime`, or `kill $(cat ~/.hermes/plugin-data/websidian/server.pid)`. The supervisor starts it again within ~15 s |
| `dashboard/*.py`, `dashboard/dist/` | the dashboard — plugin routes mount only at start-up |
| `__init__.py`, `guard.py`, `links.py`, `sites.py`, `skills/` | the gateway — write guard, links, `/brain`, skills |

`--restart-runtime` stops that one process and nothing else; the dashboard and the gateway are never
restarted for you. It refuses to signal a PID whose command line it cannot read or that is not Websidian,
so a stale `server.pid` is harmless. (`ps -o` does not exist on MSYS/Git Bash, so there it declines and
tells you; use the PowerShell installer or stop the process yourself.)

### Which revision is installed

Both copies are stamped with a `websidian.version` written by the installers:

```json
{ "revision": "a55bcf0", "installed_at": "2026-09-16T01:44:33Z", "source": "/home/me/websidian", "component": "runtime" }
```

- `GET /_health` returns it as `version` (`null` in a git checkout or a hand copy — not an error).
- The dashboard's `/status` reports `app_version`, `plugin_version` and `version_skew`, and the tab shows
  both under **Runtime** and **Plugin** plus a warning banner when the two revisions differ.

The plugin (Python) and the runtime (Node) are installed as separate copies, so half an upgrade otherwise
has no symptom other than odd behaviour. `version_skew` is only raised when both stamps name a revision and
the two differ; unknown is never treated as skew.

## Configure

In `~/.hermes/config.yaml`:

```yaml
plugins:
  enabled:
    - websidian
  entries:
    websidian:
      settings:
        vaults:
          - path: /home/me/agent-notes                 # the folder Websidian serves
            url: https://brain.example.com/hermes/     # site base including the slug, trailing slash
        # protect: [SKILL.md, SOUL.md, AGENTS.md, MEMORY.md, USER.md, TOOLS.md, IDENTITY.md, HEARTBEAT.md, BOOTSTRAP.md]
        protect_mode: approve        # approve (ask a human) | block
        block_active_content: true
        append_links: true           # append "Notes updated:" to replies
```

| Setting | Default | |
|---|---|---|
| `vaults` | none | List of `{path, url, slug, title, edit, untrusted}`. `url` is what an external Websidian serves the vault at, e.g. `https://brain.example.com/hermes/` for slug `hermes`. `slug`, `title`, `edit` (default `false`) and `untrusted` (default `true`) are used by the dashboard tab. Without a `url` or the dashboard tab, the guard still works but no links are built. |
| `link_style` | see [Link styles](#link-styles) | `dashboard` or `direct`. |
| `dashboard` | none | Dashboard tab: `{port, app_dir, node, public_base}`, see [Dashboard tab](#dashboard-tab). |
| `protect` | the nine files above | Basename patterns (`*`, `?` allowed), matched case-insensitively under the Hermes home and inside vaults. |
| `protect_mode` | `approve` | `approve` escalates to Hermes's approval prompt (denial, timeout, or no human available blocks). `block` refuses outright. |
| `block_active_content` | `true` | Active-HTML and file-type checks for vault writes. |
| `append_links` | `true` | Append links to the final reply. |

Environment variables are used for any key not set in config.yaml: `WEBSIDIAN_VAULTS` (JSON list, or
`path|url` entries separated by `;`), `WEBSIDIAN_PROTECT` (comma-separated), `WEBSIDIAN_PROTECT_MODE`,
`WEBSIDIAN_BLOCK_ACTIVE_CONTENT`, `WEBSIDIAN_APPEND_LINKS`, `WEBSIDIAN_LINK_STYLE`, and `WEBSIDIAN_PUBLIC_BASE`
(stands in for `dashboard.public_base`).

Two skills are registered: `websidian:websidian` (writing vault notes) and `websidian:websidian-install`
(installing, updating and verifying this integration). Plugin skills are loaded explicitly; the
system-prompt section tells the agent to load the first. On a Hermes without `register_skill`, copy
`skills/websidian/SKILL.md` to `~/.hermes/skills/websidian/SKILL.md`.

## Dashboard tab

The plugin also ships a Hermes dashboard extension in `dashboard/`: a **Websidian** tab in the dashboard's
sidebar that shows your vaults, with the reader, graph and editor, reachable only through the dashboard login.

### How it works

```
browser --(dashboard session cookie)--> hermes dashboard :9119
             /websidian                      tab page (dist/index.js): site picker + iframe
             /api/plugins/websidian/status   JSON for the tab
             /api/plugins/websidian/w/...    reverse proxy (plugin_api.py) --> node Websidian on 127.0.0.1:8095
                                             adds x-websidian-proxy-secret, x-websidian-user
```

- **Supervisor.** When the dashboard starts it imports `dashboard/plugin_api.py`, which writes
  `~/.hermes/plugin-data/websidian/websidian.config.json` from the plugin settings and starts
  `node <app_dir>/src/server.js` (`WEBSIDIAN_CONFIG` pointing at that file) on `127.0.0.1:<port>`, in its own
  process session, logging to `server.log`, with its PID in `server.pid`. A background thread checks every
  15 s: if `/_health` stops answering it starts Websidian again (at most 5 starts a minute, with backoff), and
  if the generated config changed (you edited the settings) it restarts Websidian with the new config. If
  something already answers `/_health` on the port, nothing is spawned. The status endpoint and the proxy also
  request a restart when Websidian is down. Websidian keeps running when the dashboard restarts; the new
  dashboard adopts it through the PID file.
- **Generated config.** Websidian listens on `127.0.0.1` only and is mounted at
  `<dashboard prefix>/api/plugins/websidian/w`, so every URL it generates is already correct behind the proxy.
  `publicUrl` is `public_base`, the cache lives in the data dir, `warm` is off. One site per vault:
  `untrusted` (on unless you turn it off), `edit: { allowFrom: [127.0.0.1, ::1] }` unless `edit: false`, and a
  random site `auth.token` so a local process that bypasses the proxy gets 403. Top-level `proxyAuth` holds a
  random secret: a request from loopback carrying it counts as signed in (site auth and editor) as the user
  named in `x-websidian-user`. Secrets are generated once into `secrets.json` (mode 0600; the config is 0600
  too).
- **Proxy.** `/api/plugins/websidian/w/<path>` forwards GET, HEAD, POST, PUT, DELETE and PATCH with the raw
  (still percent-encoded) path and query. Only `content-type`, `accept`, `accept-language`, `if-none-match`,
  `if-modified-since`, `range`, `x-requested-with` and `user-agent` are forwarded; the dashboard's `cookie` and
  `authorization`, and any client-supplied `x-websidian-*` header, are dropped. The proxy adds the secret and
  the dashboard user (session display name, else `hermes`). Request bodies are capped at 20 MB. Responses
  stream back with only `content-type`, `content-length`, `etag`, `last-modified`, `cache-control`,
  `content-security-policy`, `x-content-type-options`, `location`, `retry-after`, `content-disposition`,
  `accept-ranges`, `content-range` and `x-render`; Websidian's `Set-Cookie` is never forwarded. Paths with dot
  segments or encoded slashes, backslashes or NULs are refused (400). When Websidian is down the proxy answers
  a 502 page with the log tail, which reloads itself every 5 seconds.
- **Tab.** The page fetches `/api/plugins/websidian/status` and shows a site picker, Edit / Reading view,
  Graph and "Open full page" buttons, and an iframe with the site that fills the content area. When Websidian
  is not running it shows the error, the Node and app details and the last 20 log lines instead, and polls
  until it is back.
- **Deep links.** The dashboard router matches plugin tabs by exact path (`/websidian/anything` is "not
  found"), so the state lives in the query string: `/websidian?site=<slug>&note=<Folder/Note>` (no `.md`),
  `&edit=1` for the editor, `&q=` for the iframe's own query string. Navigating inside the iframe updates the
  dashboard URL (`history.replaceState`). Opening a deep link without a session goes through the login page and
  comes back to it — and on that trip Hermes decodes the target one time more than it encoded it (the gate
  percent-encodes `path?query` into `/login?next=`, the HTTP layer decodes that value, and
  `_validate_post_login_target` unquotes it again). So a value only survives if it carries no percent-escape:
  a name that needs none keeps the readable `note=Folder/Note`, and any other (a space, `&`, `#`, `+`, `%`,
  non-Latin letters) travels as `note64=<base64url>` — `[A-Za-z0-9_-]` only, which decoding cannot change.
  `q64=` is the same for the iframe query. Both forms are accepted, so links made by older versions keep
  working; `sites.note_query` / `note_from_query` and `dist/index.js` implement the same rule on each side.

### Settings

```yaml
plugins:
  enabled: [websidian]
  entries:
    websidian:
      settings:
        link_style: dashboard
        dashboard:
          port: 8095                                          # Websidian on 127.0.0.1:<port>
          app_dir: /root/.hermes/plugin-data/websidian/app    # Websidian: src/, public/, node_modules/
          node: node                                          # Node >= 20
          public_base: http://localhost:9119                  # the dashboard URL as the browser sees it
        vaults:
          - path: "/root/Documents/Obsidian Vault"
            slug: brain            # default: last segment of url, else the folder name
            title: Second Brain
            edit: true             # default
            untrusted: true        # default: keep it
          - path: /root/.hermes/memories
            slug: memories
            edit: false
```

| Setting | Default | |
|---|---|---|
| `dashboard.port` | `8095` | Loopback port for Websidian. Nothing is published. |
| `dashboard.app_dir` | `~/.hermes/plugin-data/websidian/app` | Where Websidian is installed. |
| `dashboard.node` | `node` | Node binary (Node 20 or later). |
| `dashboard.public_base` | `http://localhost:9119` | Browser-facing dashboard URL. Its path becomes the prefix of Websidian's basePath, so a dashboard behind a reverse proxy at `https://host/hermes` works when this says `https://host/hermes`. Also the base of the agent's links. |
| `vaults[].slug` | from `url`, else the folder name | Lowercase `[a-z0-9_-]`, never starting with `_`; duplicates get `-2`, `-3`. |
| `vaults[].title` | folder name | Site title. |
| `vaults[].edit` | `false` | Browser editor for every dashboard user. Off unless you turn it on for a vault you chose deliberately: the dashboard has one role, so editing a vault means every signed-in dashboard user can rewrite it — including the agent's instruction files, with a confirmation. A read-only vault gets no edit link in replies either. |
| `vaults[].untrusted` | `true` | Websidian's untrusted mode. See the security model before turning it off. |

Plugin API routes are mounted once, when the dashboard starts, so restart the dashboard after installing or
upgrading the plugin. Settings changes reach Websidian within 15 seconds (the supervisor restarts it). Files:
`~/.hermes/plugin-data/websidian/{websidian.config.json, secrets.json, server.log, server.pid, cache/}`. Set
`WEBSIDIAN_DASHBOARD_AUTOSTART=0` in the dashboard's environment to not start Websidian when the dashboard
starts (the tab still starts it on first use).

### Security model

- **The dashboard login is the only login.** Everything lives under `/api/plugins/`, which the dashboard's auth
  gate never makes public. Without a session the proxy and the status endpoint answer `401` JSON
  (`{"error": "unauthenticated", "login_url": "/login", ...}`, never a redirect) and the tab path redirects to
  `/login?next=...`. Iframe loads carry the `SameSite=Lax` session cookie, so they pass. Websidian's own `auth`
  and `edit.users` logins are not used. This needs the dashboard's gated mode (a non-loopback bind or a
  non-loopback `dashboard.public_url`, with the password or an OAuth provider). With a dashboard on 127.0.0.1
  without the gate, plugin routes want the `X-Hermes-Session-Token` header, which an iframe cannot send, so
  the tab gets 401s there.
- **Websidian is bound to 127.0.0.1** and has no published port. Requests without the proxy secret get 403 and
  cannot use the editor.
- **The proxy secret** (64 random characters) is known only to the dashboard process and Websidian's config
  (both files 0600). Websidian also requires the request to come from loopback. The proxy strips
  client-supplied `x-websidian-*` headers, but the secret is what gates.
- **Untrusted mode is what protects the dashboard.** The iframe is not sandboxed: Websidian's pages and editor
  call their JSON API with the dashboard cookie, which needs the same origin (the iframe sets
  `referrerpolicy="same-origin"`). So Websidian pages are same-origin with the dashboard, and **a script that
  got into a rendered note would run with the signed-in dashboard user's privileges** (config, API keys,
  sessions, the agent). Untrusted mode is the barrier: no raw HTML from notes, only media attachments served
  (no `.html`, `.svg` with script, `.json`...), and a strict Content-Security-Policy with a fresh nonce on every
  page. It is on for every vault unless you set `untrusted: false`; do that only for a vault that no agent,
  sync, web clipper or other person writes to. The write guard above is the first layer, untrusted mode the
  second; keep both.
- Every dashboard user can use the editor on `edit: true` vaults. On untrusted sites Websidian still asks for
  confirmation before saving agent instruction files (`SKILL.md`, `MEMORY.md`...).

### Deploy into a container

From the repository root on the host (Git Bash; the PowerShell equivalent is in the script's header):

```bash
npm ci
bash integrations/hermes/websidian/deploy/install-into-container.sh hermes01
```

It copies Websidian (`src`, `public`, `package.json`, `package-lock.json`, `node_modules`; not `.cache`,
`docs`, `test`, `demo`) to `/root/.hermes/plugin-data/websidian/app`, and the plugin (without `tests`,
`__pycache__` and `deploy`) to `/root/.hermes/plugins/websidian`. It does not restart anything and does not
edit `config.yaml`; it prints the `hermes config set` commands. Then restart the dashboard (and the gateway,
for the agent's links) and open `http://localhost:9119/websidian`.

## Link styles

The links the agent shares (reply footer, `websidian_links`, `/brain`) follow `link_style`:

| `link_style` | View link | Edit link |
|---|---|---|
| `dashboard` | `<public_base>/websidian?site=<slug>&note=Folder/Note`, or `&note64=<base64url>` when the name needs escaping | the same with `&edit=1` |
| `direct` | the vault's `url` + `Folder/My%20Note`; without `url`, `<public_base>/api/plugins/websidian/w/<slug>/Folder/My%20Note` | `<site>/_edit/Folder/My%20Note` |
| unset | a vault with an explicit `url` keeps direct links to it (the original behaviour); without `url`, `dashboard` when the `dashboard` setting exists, else no links | |

Dashboard links go through the login page when needed and come back, including notes whose name contains
`&`, `#`, `+`, `%`, a space or non-Latin letters (the `note64` encoding under [Dashboard tab](#dashboard-tab)). Direct
links to `/api/plugins/...` also need a dashboard session; without one they answer 401 JSON.

## Pair it with Websidian's untrusted mode (external Websidian)

Configure the Websidian site that serves the agent's folder as untrusted, behind a login, with the editor
restricted to your team:

```json
{
  "slug": "hermes",
  "root": "/home/me/agent-notes",
  "untrusted": true,
  "auth": { "users": { "me": "a-long-password" } },
  "edit": { "users": { "me": "another-long-password" }, "allowFrom": ["10.0.0.0/8", "::1"] }
}
```

The two layers do different jobs:

- **This plugin stops bad content at write time**, when the agent itself writes it: the write fails with a
  message telling the agent to use plain Markdown, so the vault never holds it.
- **Websidian's `untrusted: true` is the second layer** for content that reaches the vault by other
  routes: shell commands the plugin cannot inspect, other tools or agents, git pulls, sync, a human pasting
  text. It renders notes without raw HTML, serves only media attachments, and sends a strict
  Content-Security-Policy. `auth` keeps the site private; `edit` keeps the editor (which can change
  instruction files) behind its own login and IP allowlist, and asks for confirmation before saving
  protected files.

Use both. Neither replaces the other.

## Limitations

- **Shell enforcement is best-effort and not a security boundary.** For `terminal`, the plugin only looks
  for a command that both writes (`>`, `>>`, `tee`, `sed -i`, `cp`, `mv`, `Set-Content`...) and names a
  protected basename or a vault path, or runs with its working directory inside a vault. Variables,
  scripts, `cd` earlier in the session, encodings, and interpreters (`python -c`, `execute_code`) get
  around it. Other writers are still not inspected at all (`execute_code`, MCP tools, an editor, a sync):
  Websidian's untrusted mode is what protects readers from content that arrives this way.
- **`memory` and `skill_manage` are judged from their arguments**, not from what Hermes finally writes.
  The guard reconstructs the target path (`<hermes home>/memories/…`, `<hermes home>/skills/…`), so a skill
  kept in a `skills.external_dirs` folder is judged at its default location: the decision is the same, but
  the path in the message is not where the file lives. Memory's own character limits are enforced by the
  memory tool, not here.
- **Memory entries and skill content are held to the same "plain Markdown" rule as vault notes**, wherever
  they are stored - they end up in the agent's prompt, and those folders are often served as a vault. Text
  *about* HTML outside a code fence is refused there too.
- **Plugins run in-process with no sandbox.** This plugin is ordinary Python inside the Hermes process; it
  guards against mistakes and prompt-injected content reaching the vault, not against a compromised
  Hermes or a malicious plugin.
- The active-content check is conservative: it may block harmless text such as `(javascript: see above)`
  or HTML inside an indented or list-nested code block. Put code samples in top-level fenced code blocks.
- If the guard itself errors, the guarded tool call is blocked (Hermes would otherwise skip a failing hook).
- Links are tracked in memory per session and are lost when Hermes restarts.

## Alternative without the Python plugin: a shell hook

`guard.py` also runs as a Hermes shell hook (JSON payload on stdin; exit code 2 with
`{"action": "block", "message": ...}` on stdout blocks the call). It gives you the write guard only (no
links, tool, command or skill). Shell hooks cannot request approval, so protected-file writes are blocked
instead of escalated.

```yaml
# ~/.hermes/config.yaml
hooks:
  pre_tool_call:
    - matcher: "write_file|patch|terminal|memory|skill_manage"
      command: "python /home/me/.hermes/plugins/websidian/guard.py --stdin"
      timeout: 10
      fail_closed: true
```

Settings are read from `plugins.entries.websidian.settings` in `$HERMES_HOME/config.yaml` when PyYAML is
importable by that `python`, else from the `WEBSIDIAN_*` environment variables, or from a JSON file with
`--config /path/settings.json` (same keys). Hermes asks for consent the first time a shell hook runs
(or use `--accept-hooks` / `hooks_auto_accept: true`).

## Files

| File | |
|---|---|
| `plugin.yaml` | Manifest |
| `__init__.py` | `register(ctx)`: hooks, tool, command, skill, system-prompt section |
| `guard.py` | Pure write-guard logic and the shell-hook CLI (standard library only) |
| `links.py` | URL building (`encodeURIComponent`-exact, both link styles) and note listing (standard library only) |
| `sites.py` | Vault-to-site mapping (slugs, defaults, link styles) and the deep-link encoding (`note`/`note64`, `q`/`q64`), shared by the agent plugin and the dashboard |
| `dashboard/manifest.json` | Dashboard tab manifest |
| `dashboard/plugin_api.py` | Dashboard backend: `/status` and the `/w/` reverse proxy (FastAPI `router`) |
| `dashboard/wsd_core.py` | Config generation, secrets, proxy header rules, Node supervisor (standard library only) |
| `dashboard/dist/index.js`, `dashboard/dist/style.css` | The tab: plain IIFE on the dashboard plugin SDK, no build |
| `deploy/install-local.sh` | Installs or updates the plugin and the runtime in a native Hermes profile (macOS, Linux, Git Bash): npm in `app_dir`, version stamps, a `/_health` smoke test, optional runtime-only restart |
| `deploy/install-local.ps1` | The same for Windows PowerShell |
| `deploy/install-into-container.sh` | Copies Websidian and the plugin into a Docker container |
| `skills/websidian/SKILL.md` | Agent instructions for writing vault notes |
| `skills/websidian-install/SKILL.md` | Agent runbook for installing, updating and verifying this integration (restart matrix, acceptance checks, what never to do) |
| `NOTES-api.md` | The Hermes APIs this plugin relies on, with source references |
| `tests/` | `python -m unittest discover` from this folder |
