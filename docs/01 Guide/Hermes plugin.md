---
title: Hermes plugin
tags: [websidian, guide, agents, hermes]
updated: 2026-09-13
---
# Hermes plugin

Connects Hermes Agent to Websidian: keeps agent-written vault notes plain Markdown, asks a human before the agent changes its own instruction files, and replies with view/edit links for the notes it wrote.

> [!success] Status: deployed in `hermes01` with the dashboard tab, 2026-09-13
> Your second brain, Hermes memories and skills open in a **Websidian** tab of the Hermes dashboard (`http://localhost:9119/websidian`). The gateway still needs a restart before WhatsApp / Open WebUI replies carry dashboard links. See [[#Dashboard tab]].

Code: `integrations/hermes/websidian/` (`plugin.yaml`, `__init__.py`, `guard.py`, `links.py`, `skills/websidian/SKILL.md`, `README.md`, `NOTES-api.md`, `tests/`).

## Install
1. Copy the folder to `~/.hermes/plugins/websidian` (inside the `hermes01` container).
2. `hermes plugins enable websidian`
3. Configure (below) and restart the Hermes gateway.

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
| `vaults` | — | `[{path, url}]`: folders Websidian serves and their site URL |
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
