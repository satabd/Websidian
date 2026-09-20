---
title: OpenClaw plugin
tags: [websidian, guide, agents, openclaw]
updated: 2026-09-20
order: 14
description: Let OpenClaw read and write the vault, safely, and serve it behind the Gateway
---
# OpenClaw plugin

Connects [OpenClaw](https://openclaw.ai) to Websidian the way the [[Hermes plugin]] connects Hermes: keeps agent-written vault notes plain Markdown, asks a human before the agent changes its own instruction files, replies with view/edit links for the notes it wrote, and serves the vaults behind the Gateway's own port.

> [!success] Status: built and tested against OpenClaw 2026.6.9 in a throw-away container, 2026-09-17
> The Gateway loads the plugin (4 hooks, the `websidian_links` tool, `/brain`, the `websidian-runtime` service and one HTTP route), the container installer runs end to end with its `/_health` smoke test, and the pages at `/plugins/websidian/` sign in with the Gateway token and proxy real notes with the untrusted CSP. The hooks were exercised with a fake plugin API only: no model ran in the container, so "the agent's reply carries links" and "changing `SOUL.md` prompts for approval" are unit-tested contracts, not a live chat — [[#Is it really installed?]] rows 6 and 7. Deployed to `clawat02` the same day (workspace vault, read-only, pages at `http://127.0.0.1:18794/plugins/websidian/`); its first live chat turn waits for the OpenAI backend, which answered `400` with the plugin enabled and disabled alike (weekly quota at 0 %, ~2026-09-19).

Code: `integrations/openclaw/websidian/` (`openclaw.plugin.json`, `index.js`, `lib/`, `skills/websidian/SKILL.md`, `deploy/`, `test/`, `README.md`). Plain ESM JavaScript, no build step, no dependencies.

## What it does

| Surface | OpenClaw hook / API | Behaviour |
|---|---|---|
| Write guard | `before_tool_call` on `write`, `edit`, `apply_patch`, `exec` | Instruction files (`SKILL.md`, `SOUL.md`, `AGENTS.md`, `MEMORY.md`, `USER.md`, `TOOLS.md`, `IDENTITY.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`) under `~/.openclaw`, an agent workspace or a vault → `requireApproval` (OpenClaw's plugin approvals: chat buttons or `/approve`), or `block` in `protectMode: "block"`. Vault writes with `<script>`, frames, `on…=` handlers, `javascript:`/`data:text/html` URLs, or `.html`/`.svg`/`.js` files → blocked. `exec` commands that write near a protected name or into a vault → approval. |
| Links | `after_tool_call` + `message_sending` | Notes written this session get a *Notes updated:* footer with view (and, for `edit: true` vaults, edit) links, unless the reply already carries them. |
| Tool | `websidian_links` | Links for given paths, or every note changed this session. |
| Command | `/brain [query]` | Ten most recently modified notes with links, and the pages URL. |
| Prompt | `before_prompt_build` | A short *Websidian vaults* section pointing at the vaults and the `websidian` skill. |
| Skill | `skills/websidian/SKILL.md` | How to write notes as Obsidian Markdown, RTL guidance, share links. |
| Pages | service `websidian-runtime` + route `/plugins/websidian` (`auth: "plugin"`) | A supervised Websidian on `127.0.0.1:8095` (config generated from the vaults, `proxyAuth`, sites `untrusted`, read-only unless `edit: true`), proxied at `/plugins/websidian/w/<slug>/…` behind a sign-in with the Gateway token. |

The guard is a port of the Hermes one: the active-content detector was checked against the Python reference on 140 inputs (44 real notes from this vault and the demo, 96 crafted attacks) with zero differences.

> [!danger] Two bypasses lived in the adapters around that detector until 2026-09-20
> Both are fixed and tested; both are worth knowing if you port this guard anywhere else.
> - **A file that does not exist yet was judged by its literal spelling.** `fs.realpathSync` throws unless the whole path exists, so the old fallback left every parent symlink unresolved — and a created file never exists. A junction into a protected folder was allowed. Path resolution now walks up to the deepest existing ancestor, matching `os.path.realpath`.
> - **A payload split across two edits passed.** The whole-file simulation only ran when every `oldText` was present in the original, so one decoy edit dropped the check to each `newText` alone, where `<scr` and `ipt>…</script>` look clean. The simulation now follows the text as it evolves, and when it cannot run the edits are scanned joined as well as apart.

## Install

Two copies, from the same revision: the **plugin** and the **Websidian runtime** (`src/`, `public/`, `package.json`, lock file, with `node_modules` installed inside it) at `<state dir>/plugin-data/websidian/app`.

**Docker container** (e.g. `alpine/openclaw`), from the repository root:

```bash
bash integrations/openclaw/websidian/deploy/install-into-container.sh <container> [--register]
```

**Native profile** (macOS, Linux, Git Bash) / **Windows PowerShell**:

```bash
bash integrations/openclaw/websidian/deploy/install-local.sh
```

```powershell
powershell -ExecutionPolicy Bypass -File integrations\openclaw\websidian\deploy\install-local.ps1
```

Each installer copies both parts, runs `npm ci --omit=dev` **inside the runtime copy** (never in your checkout), stamps both with the git revision, boots the runtime once on a throw-away vault and asks it for `/_health`. None of them edits `openclaw.json` or restarts the Gateway; they print those commands:

```bash
openclaw plugins install --link <state dir>/plugin-data/websidian/plugin
openclaw gateway restart      # Docker: docker restart <container>
```

> [!tip] `plugins.load.paths` is the other way in
> Instead of `plugins install --link`, list the plugin folder under `plugins.load.paths` in `openclaw.json` and set `plugins.entries.websidian.enabled: true`. The live test used this route.

> [!warning] Learned the hard way, 2026-09-17
> - `docker cp` writes files as **root**; `npm ci` as `node` then fails with `EACCES`. The container installer chowns the data folder before and after copying.
> - Under **Git Bash**, `docker cp "dir/."` copies the directory itself (MSYS path rewriting), so `src/` landed in `app/app/`. The installer now streams both copies in with `tar`, receiving through `sh -c` so the container path is not rewritten either. The smoke test is what caught both.

## Configure

`openclaw.json` → `plugins.entries.websidian.config` (the manifest schema is strict: unknown keys fail config validation):

```json5
{
  plugins: { entries: { websidian: { enabled: true, config: {
    vaults: [
      { path: "/home/node/.openclaw/workspace", slug: "workspace" },
      { path: "/srv/brain", slug: "brain", title: "Second brain", edit: true },
      { path: "/srv/team", url: "https://notes.example.com/team/" }   // an external Websidian; links go there
    ],
    protectMode: "approve",        // or "block"
    // protect: [...], blockActiveContent: true, appendLinks: true,
    ui: { enabled: true, port: 8095, publicBase: "http://127.0.0.1:18789", auth: "gateway" }
  } } } }
}
```

| Key | Meaning |
|---|---|
| `vaults[].path` | Vault folder as the Gateway process sees it (inside the container for Docker). Never the whole state dir. |
| `vaults[].edit` / `untrusted` | Defaults `false` / `true`: browser editing is opt-in per vault; agent-written HTML stays inert. |
| `vaults[].url` | An external Websidian site base; the plugin then links there and does not serve that vault itself. |
| `protect`, `protectMode` | Basename globs of instruction files; `approve` (default) or `block`. |
| `ui.publicBase` | How browsers reach the Gateway; used in every link. Default `http://127.0.0.1:<gateway.port>`. |
| `ui.auth` | `gateway` (sign in with the Gateway token or password, default) or `password` + `ui.password`. |
| `ui.enabled: false` | Guard and links only; no Websidian process, no route. |

## Pages

`http://<gateway>/plugins/websidian/` → sign-in (Gateway token) → status page listing the sites → `/plugins/websidian/w/<slug>/<Note>`; the editor at `…/w/<slug>/_edit/<Note>` for `edit: true` vaults. The sign-in sets an `HttpOnly; SameSite=Lax` cookie scoped to `/plugins/websidian` for `ui.sessionHours` (12); failed sign-ins are rate-limited per address. The sign-in and sign-out forms carry a nonce matched against a `SameSite=Lax` cookie (`websidian_csrf`), because the Gateway's `Referrer-Policy: no-referrer` makes browsers send `Origin: null` on same-origin posts — an Origin check alone refuses every real browser (found on the first real sign-in, 2026-09-17). The proxy forwards an allowlist of headers, adds the `proxyAuth` secret, never passes Websidian's `Set-Cookie` through, and refuses dot segments and encoded slashes before they reach Websidian. When Websidian is down the pages answer `502` with the log tail and the supervisor is nudged.

> [!note] Why a route and not a tab
> OpenClaw 2026.6.9's Control UI registers plugin *descriptors* for the session, tool, run and settings surfaces only, and its bundle renders none of them; native plugin pages (`host.ui.registerPage`, the "Custom plugin UI" lab) arrived with the 2026.8.1 web UI. So the pages live on their own URL, which `/brain` prints — [[Improvements backlog]].

## Is it really installed?

| # | Check | Live test 2026-09-17 |
|---|---|---|
| 1 | `openclaw plugins inspect websidian --runtime`: 4 typed hooks, tool `websidian_links`, command `brain`, service `websidian-runtime`, 1 HTTP route | ✅ |
| 2 | `<appDir>/src/server.js` and `node_modules/` exist; the installer's smoke test passed | ✅ |
| 3 | `GET /plugins/websidian/` without a session → `302` to the sign-in; a wrong secret → `401`; a tampered cookie → `302` | ✅ |
| 4 | Signed in: `status.json` says `running: true` and lists the sites | ✅ `running: true, pid 210`, sites `brain`, `workspace` |
| 5 | A proxied note answers `200` with a CSP and `nosniff`, no `Set-Cookie` | ✅ also: editor `200` on the `edit: true` vault, `404` on the read-only one; dot segments `404`; the Control UI root still answers |
| 6 | A reply after writing a note ends with *Notes updated:* and a working link | unit-tested contract only |
| 7 | Changing `SOUL.md` produces an approval prompt | unit-tested contract only |

## Updating

Re-run the installer, then restart the Gateway (it owns the supervised Websidian process, so the restart replaces both). The status page flags a **version skew** when the runtime and plugin stamps differ.

## Tests

`npm test` at the repository root runs the plugin suite too (`integrations/openclaw/websidian/test/`, 63 tests): the guard, links and slugs, the runtime config and secrets, the proxy rules, the sign-in route over a real HTTP server, and `register()` against a fake plugin API whose contracts were read from OpenClaw 2026.6.9's bundled runtime — [[Testing]].
