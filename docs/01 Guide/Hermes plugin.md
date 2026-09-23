---
title: Hermes plugin
tags: [websidian, guide, agents, hermes]
updated: 2026-09-23
order: 13
description: Let an agent read and write the vault, safely
---
# Hermes plugin

Connects Hermes Agent to Websidian: keeps agent-written vault notes plain Markdown, asks a human before the agent changes its own instruction files, and replies with view/edit links for the notes it wrote.

> [!success] Status: deployed in `hermes01` with the dashboard tab, 2026-09-13
> Your second brain, Hermes memories and skills open in a **Websidian** tab of the Hermes dashboard (`http://localhost:9119/websidian`). The gateway still needs a restart before WhatsApp / Open WebUI replies carry dashboard links. See [[#Dashboard tab]].

Code: `integrations/hermes/websidian/` (`plugin.yaml`, `__init__.py`, `guard.py`, `links.py`, `skills/websidian/SKILL.md`, `README.md`, `NOTES-api.md`, `tests/`).

## Install

> [!warning] `hermes plugins install <repo>` cannot take this repository
> Its root is the Websidian application; the plugin manifest is nested at `integrations/hermes/websidian/plugin.yaml`. Use a script below, or copy the folder by hand. Packaging it for the normal installer is [[Improvements backlog|backlog]] work.

**Native profile** (macOS, Linux, Git Bash), from the repository root:

```bash
bash integrations/hermes/websidian/deploy/install-local.sh
```

**Windows PowerShell:**

```powershell
powershell -ExecutionPolicy Bypass -File integrations\hermes\websidian\deploy\install-local.ps1
```

Either one finds the profile (`$HERMES_HOME`, else `~/.hermes`, else `%LOCALAPPDATA%\hermes`), copies the plugin to `<profile>/plugins/websidian` and the Websidian runtime to `<profile>/plugin-data/websidian/app`, installs the runtime's dependencies **inside `app_dir`**, then boots the installed server once on a throw-away vault and asks it for `/_health`. Flags: `--hermes-home` / `-HermesHome`, `--app-dir`, `--plugin-dir`, `--no-smoke`, `--dry-run`. For a container, use `deploy/install-into-container.sh` instead.

> [!tip] The one thing to get right by hand
> The dashboard tab supervises `node <app_dir>/src/server.js`. If you copy the runtime yourself, run `npm --prefix <app_dir> ci --omit=dev`, not a plain `npm ci` in your checkout: otherwise `node_modules` lands next to your source, the plugin still reports as installed, and the tab answers 502.

### Enable it, then activate it
```bash
hermes plugins enable websidian     # decline "replace built-in tools" — this plugin does not need it
hermes plugins list --plain         # websidian ... enabled
```
Enabling is a config change that applies to the *next* session of each process. Restart the **dashboard** before the Websidian tab and its supervised server exist; restart the **gateway** before the write guard and the reply links act in chat. The installers restart neither — you choose when to take the interruption.

### Is it really installed?
| # | Check |
|---|---|
| 1 | `<profile>/plugins/websidian/plugin.yaml` and `dashboard/manifest.json` exist |
| 2 | `<app_dir>/src/server.js` and `<app_dir>/node_modules/` exist |
| 3 | `hermes plugins list --plain` shows it enabled |
| 4 | Every configured vault path exists and is readable |
| 5 | `/_health` answers `200` (the installers' smoke test) |
| 6 | An untrusted page carries a CSP and `X-Content-Type-Options: nosniff` |
| 7 | The **Websidian** tab is there after *you* restart the dashboard |
| 8 | The dashboard runs gated and you have a signed-in session |
| 9 | Through that session, `/api/plugins/websidian/status` **and** `/api/plugins/websidian/w/<slug>/` both load |
| 10 | Chat replies carry links after *you* restart the gateway |

Checks 2, 5 and 6 run in CI as `test/hermes-install.test.js` — [[Testing]]. Checks 8 and 9 need a human in a signed-in browser; note the result when you close out an install.

> [!danger] A healthy Node runtime is not a working tab — and never fix a 401 by opening the gate
> Everything the tab needs is under `/api/plugins/`, which the dashboard's auth gate never makes public. A default local dashboard on `127.0.0.1:9119` renders `/websidian` without a login and then answers **401** on those routes: in that mode a plugin route wants an `X-Hermes-Session-Token` header, which an iframe cannot send.
>
> Four states are independent: plugin **enabled**, Websidian **healthy**, dashboard session **authenticated**, protected routes **reachable through that session**. The fix for a 401 is to put the dashboard in its gated mode — basic auth on a trusted LAN or VPN, OAuth for anything internet-facing — never to weaken or remove the gate. The iframe is same-origin with the dashboard, so anything the gate lets through runs with the signed-in user's privileges; keep agent-facing vaults `untrusted: true`.

## Updating

```bash
git pull && bash integrations/hermes/websidian/deploy/install-local.sh --restart-runtime
```

Re-running the installer *is* the update: it clears `app_dir/src` and `app_dir/public` before re-copying, re-runs `npm ci` and replaces the plugin folder.

> [!important] Copying files updates nothing that is already running
> The supervisor restarts Websidian only when the generated config changes or `/_health` stops answering — never because the code on disk changed.

| Changed | What has to restart |
|---|---|
| `src/`, `public/`, dependencies | the supervised Websidian process — `--restart-runtime` / `-RestartRuntime`, or `kill $(cat ~/.hermes/plugin-data/websidian/server.pid)`; the supervisor brings it back within ~15 s |
| `dashboard/*.py`, `dashboard/dist/` | the dashboard (plugin routes mount at start-up only) |
| `__init__.py`, `guard.py`, `links.py`, `sites.py`, `skills/` | the gateway (guard, links, `/brain`, skills) |

`--restart-runtime` touches that one process and nothing else, and refuses to signal a PID it cannot identify as Websidian.

### Which revision is installed
The installers stamp both copies in `websidian.version` (`{revision, installed_at, source, component}`):

- `/_health` returns it as `version` — `null` for a git checkout or a hand copy, which is not an error;
- the dashboard status reports `app_version`, `plugin_version` and `version_skew`, and the tab shows both plus a warning banner when they differ.

The plugin (Python) and the runtime (Node) are separate copies, so half an upgrade would otherwise have no symptom but odd behaviour.

### Arabic notes
The agent does not need to write `lang: ar`: a note whose letters are mostly Arabic (or Hebrew) is served as a right-to-left page — sidebar, headings, lists, callouts and tables — and each top-level block still follows its own text, so an English line or a code block inside it stays left to right. Add `lang:` to a note only to override the guess.

### Making the tab reachable (the 401)
Confirmed on the macOS profile, 2026-09-16: the dashboard loaded, the runtime was healthy, and the tab still failed because `/api/plugins/websidian/*` answered **401**.

| Dashboard mode | Websidian tab |
|---|---|
| Loopback, ungated (`127.0.0.1`, no gate) | **Not supported.** Non-public `/api/` paths need an `X-Hermes-Session-Token` header, and an iframe navigation cannot send one |
| Gated, basic password | ✅ the exercised path — the session cookie is `SameSite=Lax`, so the iframe, the editor and its API calls all carry it |
| Gated, OAuth | Should work, not yet verified with this tab |

Gated mode turns on for any **non-loopback bind or non-loopback `dashboard.public_url`** — binding to the Tailscale interface is what enables it, and the password provider is what makes it passable. Recommended: basic username/password over Tailscale or a trusted LAN, with a long unique password (that login is the only door to the vault, the memories, the skills and — for `edit: true` vaults — the agent's instruction files). Never disable the gate to make the tab load.

Afterwards, set `dashboard.public_base` to the URL the browser really uses, restart the dashboard (auth) and the gateway (links), then check `/api/plugins/websidian/status`, `/api/plugins/websidian/w/<slug>/` and `/websidian` in that order.

### The agent can do this itself
The plugin registers a second skill, `websidian:websidian-install`: the same runbook written for an agent — install, update, the restart matrix, the acceptance checks, and the things never to do (no restarting the dashboard or gateway on its own, no weakening the dashboard gate, no `untrusted: false`, no `edit: true` unless asked).

## Installation in hermes01
Done 2026-09-13 by session `md2html-fd`:

| Item | State |
|---|---|
| Hermes | v0.20.6 (upstream `2a598aad`) |
| Backup | `/root/.hermes/config.yaml.bak-websidian-20260913-120223` in the container |
| Installed | `/root/.hermes/plugins/websidian`, `hermes plugins enable websidian` (tool override declined — not needed) |
| Config | `vaults: [{path: /root/websidian-plugin-test, url: http://localhost:8080/hermes-test/}]`, `protect_mode: approve` |
| Plugin tests in the container | 54 run, OK (1 skipped) |
| Integration via Hermes plugin manager and hooks (no model calls) | 18/18: loads, 3 hooks registered, block / approve / pass-through correct, link footer, `/brain`, `websidian_links`, system prompt section |
| Real agent session (`hermes chat --oneshot -t file`) | Clean note written and reply ended with *Notes updated:* view · edit links; note with `<img onerror>` refused, not written; `SKILL.md` write refused (no human to approve), not written |

**Later the same day** the test vault was replaced by the real vaults and the dashboard tab — see [[#Dashboard tab]].

**Not done yet:**
- [ ] Restart the Hermes gateway so chat replies (WhatsApp, Open WebUI) use `link_style: dashboard` and the new vaults (needs approval)
- [x] Point `vaults` at the real Obsidian vault, memories and skills
- [x] Serve them with Websidian (untrusted) — through the dashboard tab

## Dashboard tab
✅ Deployed and browser-tested 2026-09-13 (session `md2html-fd`, in the real Chrome, signed in through the dashboard).

**Open it:** Hermes dashboard → **Websidian** in the sidebar (`http://localhost:9119/websidian`). No second login: the dashboard backend signs you in as `hermes` through Websidian's `proxyAuth` ([[Configuration#Behind a trusted proxy]]). Websidian runs under the basePath `/api/plugins/websidian/w`.

### What is in the tab
Redesigned 2026-09-23: the tab draws its own views in the dashboard's style and colours, and Websidian only does the reading.

| View | Shows |
|---|---|
| **Overview** | Hermes's memory (two cards: entries and how full each file is), every vault (notes, last change, *Editable* / *Read-only*), and the notes changed most recently across all vaults |
| **Memory** | `MEMORY.md` (*Agent notes*) and `USER.md` (*About you*) entry by entry — the `§`-separated entries Hermes keeps — with a meter against `memory.memory_char_limit` / `memory.user_char_limit` from the Hermes config. *Open* reads the file; *Edit* appears only when that vault has `edit: true` |
| **Skills** | Every `SKILL.md`, by category (a category folder's `DESCRIPTION.md` describes it), with a filter; a skill opens in the reading pane with its links and backlinks |
| **Browse** | A vault's note tree next to the note; a picker when there is more than one vault |
| **Graph** | The vault's graph; clicking a node opens the note in the reading pane |

- **Reading theme** (the palette button next to search): *Match Hermes* (the default), *Light*, *Dark*, *Paper*, *Nord* or *Night*, for notes, the tree and the graph; the tab itself stays in the dashboard's theme. Remembered per browser (`localStorage`), applied without reloading the note.
- **Ask** (in the reading pane's bar) opens the agent panel beside the note — [[#Asking an agent]].
- **Search** (top right, or press `/`) searches every vault at once; `↑` `↓` and `Enter` open a hit, `Esc` clears.
- **The reading pane**: a bar with *Back*, the title and path, *Edit* (editable vaults), *Graph* and *Open* (the full page in a new tab), over the note. The note has no box of its own: it is as tall as its content and scrolls with the dashboard page ([[Embedding in your website#Inside another application shell mode|shell mode]] with `&flow=1`), in the dashboard theme's colours. The graph and the editor keep a frame the height of the window.
- The address bar follows the reader, so a note or a view can be bookmarked; *Back* from a deep-linked note goes to the view its vault belongs to.
- Which vault is the memory and which the skills is found from the path (`<hermes home>/memories`, `<hermes home>/skills`); set `kind: memory | skills | vault` on a vault to say it outright.
- The model behind the views is `GET /api/plugins/websidian/overview` (`dashboard/wsd_model.py`): read from disk on every call, bounded walks, vault-relative paths only. Nothing a vault holds becomes markup in the dashboard: titles, entries and snippets are set as text.

**Deep links:** `?site=memories&note=MEMORY&edit=1` opens that note in the editor. A note whose name needs percent-escaping (a space, `&`, `#`, `+`, `%`, non-Latin letters) travels as `?site=…&note64=<base64url>` instead, because the login redirect decodes the target one time too many and would corrupt a `note=` value; plain names stay readable, and old `note=`/`q=` links still work. The same applies to `q=` / `q64=` (the iframe's own query string).

| Site | Folder | Notes | Mode |
|---|---|---|---|
| `brain` — Second Brain | `/root/Documents/Obsidian Vault` | 206 | untrusted, editable |
| `memories` | `/root/.hermes/memories` | 2 | untrusted, editable, protected files |
| `skills` | `/root/.hermes/skills` | 1,023 | untrusted, editable, protected files |

> [!warning] That config predates the `edit: false` default
> All three were editable because `edit` used to default to `true`. After upgrading the plugin in `hermes01` they become read-only unless the settings name `edit: true` for each vault you still want editable — decide that per vault rather than restoring it wholesale ([[Decisions]]).

**In the container:** plugin with the dashboard extension (`dashboard/manifest.json`, `plugin_api.py`, `wsd_core.py`, `dist/`, `sites.py`) in `/root/.hermes/plugins/websidian`; the Websidian app in `/root/.hermes/plugin-data/websidian/app`, on port 8095.

**Settings** (`plugins.entries.websidian.settings`, set by the user):

```yaml
vaults:
  - { path: /root/Documents/Obsidian Vault, slug: brain, title: Second Brain }
  - { path: /root/.hermes/memories, slug: memories, title: Memories }
  - { path: /root/.hermes/skills, slug: skills, title: Skills }
protect_mode: approve
link_style: dashboard          # links in replies open the dashboard tab
dashboard:
  port: 8095
  app_dir: /root/.hermes/plugin-data/websidian/app
  node: node
  public_base: http://localhost:9119
```

**Checked in the browser:** sidebar entry; vault renders in the frame with the untrusted flag and CSP nonce; the memory deep link opens Live Preview signed in as `hermes` with the protected-file banner; skills search and graph (1,023 nodes); no console errors.

**Not checked in the browser:** saving a protected file with confirmation through the dashboard (deliberately, so the real memory was not changed; covered by tests).

### Asking an agent
Opt in with `agents: true` in the plugin settings, then restart the dashboard. Every note in the tab gets **Ask** in its bar: a panel beside the note (above it on a narrow window) where you talk to **Hermes Agent** (first, the default), **Claude Code** or **Codex** about the note you are reading.

```yaml
plugins:
  entries:
    websidian:
      settings:
        agents: true               # Hermes, Claude Code, Codex — each left out if its CLI does not answer
        # agents:
        #   list: [hermes, claude]   # or Websidian agent entries: {id, backend, model, env, ...}
        #   sessionScope: note       # default here: vault — one conversation per vault, told which note is open
        vaults:
          - { path: /root/.hermes/memories, slug: memories, agents: false }   # no panel on this vault
```

- **Review only.** The panel is for reading: agents may read the whole vault but are told not to change it — enforced for Claude Code and Codex, by instruction for Hermes. It works on read-only vaults too; nothing in the tab can put an agent in Edit mode. A file changed anyway is listed under the reply, flagged, with **Diff** and **Revert**; if it was the open note, the note reloads.
- **One conversation per vault** by default (the agent keeps its own CLI session and is told when you open another note), so Hermes keeps the context as you move around. **⟲** starts a new one; the picker remembers your agent per browser.
- The agents run **where the dashboard runs** (in `hermes01`: inside the container), as its user, signed in the way each CLI already is there — `hermes setup`, `claude login`, `codex login`. **Claude Code and Codex use only their OAuth sign-ins** (claude.ai, ChatGPT): the plugin takes `ANTHROPIC_API_KEY`, `ANTHROPIC_TOKEN`, `OPENAI_API_KEY` and their kin out of their environment, so a key in Hermes's `.env` is never used instead. An agent that is not signed in, or whose provider is out of quota, says so in the panel.
- The CLIs are found on the dashboard's `PATH` or in `~/.local/bin` (where Hermes installs itself, `claude` and `codex`; the dashboard in `hermes01` runs without it on its `PATH`), and the installer ships the Obsidian skills when the checkout has them (`npm run skills`).

> [!note] Sign the CLIs in inside the container
> ```bash
> docker exec -it hermes01 /root/.local/bin/claude          # then /login, with the claude.ai account
> docker exec -it hermes01 /root/.local/bin/codex login --device-auth
> ```
> Found 2026-09-23 on the first live run: both were "logged in" by their status commands, but the OAuth tokens could no longer be refreshed, so every turn was refused — [[Known issues]].
- Replies are Markdown turned into plain elements in the dashboard: `[[wikilinks]]` are highlighted, `http(s)` links open in a new tab, and nothing an agent writes becomes HTML.
- Under the hood: the generated config sets `"agents": "readers"` on each vault, and the panel talks to `<vault>/_ask/` — [[Agents in the editor#For readers, beside the note]].

## Configure
In `~/.hermes/config.yaml` under `plugins.entries.websidian.settings` (or `WEBSIDIAN_*` environment variables):

```yaml
plugins:
  entries:
    websidian:
      settings:
        vaults:
          - path: /root/Documents/Obsidian Vault
            url: http://127.0.0.1:8080/hermes/     # Websidian site base with slug, trailing slash
        protect_mode: approve        # approve = Hermes asks you; block = refuse
        block_active_content: true
        append_links: true
        # protect: [SKILL.md, SOUL.md, AGENTS.md, MEMORY.md, USER.md, TOOLS.md, IDENTITY.md, HEARTBEAT.md, BOOTSTRAP.md]
```

| Setting | Default | Meaning |
|---|---|---|
| `vaults` | — | `[{path, url, slug, title, edit, untrusted}]`: folders Websidian serves and their site URL |
| `vaults[].edit` | `false` | Browser editing, **opt-in per vault**. The dashboard has one role, so `true` means every signed-in dashboard user can rewrite that vault. A read-only vault also gets no edit link in replies |
| `vaults[].untrusted` | `true` | Keep it. Vault text can come from the agent, a web page or tool output |
| `agents` | off | `true` or `{list, sessionScope, timeoutMs}`: the agent panel beside notes, Review only ([[#Asking an agent]]) |
| `vaults[].agents` | `true` | `false` hides the agent panel on that vault |
| `vaults[].kind` | from the path | `memory`, `skills` or `vault`: which view of the dashboard tab the vault belongs to ([[#What is in the tab]]) |
| `protect` | the 9 instruction files | Basenames that need approval |
| `protect_mode` | `approve` | `approve` (Hermes human-approval prompt) or `block` |
| `block_active_content` | `true` | Refuse raw active HTML in vault notes |
| `append_links` | `true` | Add "Notes updated:" links to replies |

## What it does
- **Guard before writes** (`pre_tool_call` on `write_file`, `patch` — including multi-file patches — `terminal`, `memory` and `skill_manage`):
  - instruction files → approval (or block);
  - notes with active HTML (`<script>`, `on…=` handlers, `javascript:`, `<iframe>`, `<meta>`, `<base>`, `<form>`…) → blocked; code fences and inline code are ignored. Fuzz-tested on ~100k documents against Websidian's renderer;
  - `.html`, `.svg`, `.js`, `.xml` files inside a vault → blocked.
  - `terminal` commands: best effort only.
- **The agent's own instruction writers go through the same gate.** `memory` (add / replace / remove, single or in an `operations` batch) is treated as a write to `<hermes home>/memories/MEMORY.md` or `USER.md`, and `skill_manage` (`create`, `edit`, `patch`, `write_file`, `delete`, `remove_file`) as a write to `<hermes home>/skills/[<category>/]<name>/SKILL.md` and the files of that folder: same `protect_mode` (`approve` asks you, `block` refuses). The text they write is checked for active HTML too, and that check **blocks** even in `approve` mode — approving an entry would not make a script in it safe. Read-only actions (memory read/search, `skills_list`, `skill_view`) and argument shapes the guard does not recognise pass straight through.
- **Links after writes**: records notes written in the turn and appends *Notes updated:* with **view** · **edit** links.
- Tool `websidian_links`; command **`/brain [query]`** lists the 10 most recent notes; skill `websidian:websidian` plus a system-prompt section.

## Without the Python plugin
Use the shell hook `python guard.py --stdin`. Shell hooks cannot ask for approval, so `approve` becomes `block`.

## Limits
- Not inspected: `execute_code`, MCP tools and anything else that writes files without going through the tools above.
- A skill kept outside the Hermes home (`skills.external_dirs`) is judged at its default location: the decision (a human approves changes to that skill) is right, but the path in the message is not where the file lives.
- Memory entries and skill content are held to the same "plain Markdown" rule as vault notes, so text *about* HTML (`<script>` outside a code fence) is refused there too.
- Session id consistency between hooks is unverified (falls back to task id).
- Runs in-process in Hermes, no sandbox.

Pairs with an `untrusted` Websidian site — [[Agent memory and second brain]], [[Configuration]].
