---
title: Hermes plugin
tags: [websidian, guide, agents, hermes]
updated: 2026-09-16
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

**Deep links:** `?site=memories&note=MEMORY&edit=1` opens that note in the editor.

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
| `protect` | the 9 instruction files | Basenames that need approval |
| `protect_mode` | `approve` | `approve` (Hermes human-approval prompt) or `block` |
| `block_active_content` | `true` | Refuse raw active HTML in vault notes |
| `append_links` | `true` | Add "Notes updated:" links to replies |

## What it does
- **Guard before writes** (`pre_tool_call` on `write_file` and `patch`, including multi-file patches):
  - instruction files → approval (or block);
  - notes with active HTML (`<script>`, `on…=` handlers, `javascript:`, `<iframe>`, `<meta>`, `<base>`, `<form>`…) → blocked; code fences and inline code are ignored. Fuzz-tested on ~100k documents against Websidian's renderer;
  - `.html`, `.svg`, `.js`, `.xml` files inside a vault → blocked.
  - `terminal` commands: best effort only.
- **Links after writes**: records notes written in the turn and appends *Notes updated:* with **view** · **edit** links.
- Tool `websidian_links`; command **`/brain [query]`** lists the 10 most recent notes; skill `websidian:websidian` plus a system-prompt section.

## Without the Python plugin
Use the shell hook `python guard.py --stdin`. Shell hooks cannot ask for approval, so `approve` becomes `block`.

## Limits
- Not inspected: `skill_manage`, `memory`, `execute_code`, MCP tools — the agent can still change memory through its memory tool.
- Session id consistency between hooks is unverified (falls back to task id).
- Runs in-process in Hermes, no sandbox.

Pairs with an `untrusted` Websidian site — [[Agent memory and second brain]], [[Configuration]].
