---
title: OpenClaw plugin
tags: [websidian, guide, agents, openclaw]
updated: 2026-09-23
order: 14
description: Let OpenClaw read and write the vault safely, serve it behind the Gateway, and give OpenClaw a native Memory page
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
| Memory page | route `/plugins/websidian-memory` (`auth: "gateway"`) + a `surface: "tab"` descriptor + `dist/control-ui/` | A **🧠 Memory** destination in OpenClaw's own sidebar, opening inside the Control UI — [[#The Memory page]]. |

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

## The Memory page

![[openclaw-memory.png]]

A **🧠 Memory** entry in OpenClaw's own sidebar — beside Home, Agents and Plugins — that opens *inside* the Control UI. The operator never leaves OpenClaw and never signs in twice.

| Tab | Shows |
|---|---|
| **Overview** | A card each for `MEMORY.md` (long-term), `USER.md` (what it learned about you) and `DREAMS.md` (consolidation): its first lines, when it changed ("2 hours ago") and how long it is. A file the workspace does not have yet is shown dashed and named, not hidden. Below, the eight most recent dated notes with their first heading and a two-line preview. |
| **Timeline** | Every dated note under `memory/` — including OpenClaw's own dreaming output under `memory/dreaming/` — grouped by day. *Today* and *Yesterday* are the reader's, worked out in the browser, not the Gateway's (which is usually another machine, in UTC). |
| **Browse** | The vault's note tree beside the note, for wandering. |
| **Graph** | Websidian's graph of the workspace; clicking a node opens that note in the reading pane. |

**Search** sits in the header on every tab (`/` focuses it, arrows and Enter pick a result, Esc clears). It queries Websidian's own index and shows the hits natively, with the matched words marked.

**Reading a note** — a card, a row or a search hit — turns the content area into a reading pane: a native bar with *Back*, the note's title and path, *Graph* (this note in the graph) and *Open* (the full page in a new tab), over Websidian in [[Embedding in your website#Inside another application shell mode|shell mode]] with `chrome=none`: the note, its table of contents, backlinks and local graph, and no second toolbar, search box or note tree. Links followed inside it update the bar.

The page reads OpenClaw's theme off the surface it is painted on and hands it down, so light and dark follow the host, live. It refreshes itself when you come back to the tab and once a minute on Overview and Timeline, and remembers the view and the open note for the browser tab, so a reload lands where you were.

> [!note] Why the view is not in the URL
> OpenClaw highlights a sidebar entry only when the page's parameters match it exactly, so writing `?p.view=…` into the address bar turned **Memory** grey in the sidebar after a reload. The view is kept in `sessionStorage` instead; a link that does carry `p.view` / `p.note` is still honoured.

> [!tip] Nothing an agent wrote is ever markup in the Control UI
> The page runs with the operator's authority, so titles, previews and search snippets are built as text — a snippet's `<mark>` is rebuilt as an element and everything else in it is dropped — and a frame only ever points at a same-origin path from the plugin's own model.


**Turn it on.** *Settings → Labs → Custom plugin UI*, or `gateway.controlUi.experimental.customPlugins: true` in `openclaw.json`; then restart the Gateway and reload the page. Without it the backend still registers the route and the descriptor, and everything else in the plugin works unchanged. `ui.memory.enabled: false` removes the sidebar entry entirely.

**Two halves, either of which stands alone.** The backend registers `/plugins/websidian-memory` (`auth: "gateway"`) and a `surface: "tab"` Control UI descriptor pointing at it. A host that renders the tab but has no native view frames that route, which serves the same dashboard as plain HTML. The browser half — `dist/control-ui/websidian.js`, loaded by the Control UI — registers a native page under the same id, `memory`, and draws the dashboard itself.

> [!note] One sign-in, not two
> The Memory route only ever answers a request OpenClaw has already authenticated, so it mints the plugin's own session cookie for that browser: the same signed, `HttpOnly`, path-scoped cookie a successful sign-in on the form mints. The notes it links to then open through the existing proxy — no second sign-in, no new kind of credential, and the stand-alone pages keep their own sign-in untouched. This is [[Decisions|the 2026-09-16 decision]] about one dashboard login, applied to OpenClaw's login.

> [!warning] Why `/plugins/websidian-memory` and not `/plugins/websidian/memory`
> OpenClaw refuses two plugin routes whose prefixes overlap — *"http route overlap rejected"*, which is exactly what the first version got — and the stand-alone prefix route already claims everything below it. The two surfaces are siblings. The session cookie stays scoped to `/plugins/websidian`, so it reaches the proxy and never travels to the Memory route.

**Read-only, and no wider than the vault.** The Memory page never offers the editor, whatever `edit` a vault is given elsewhere. What it hands the browser is vault-relative paths only — never a filesystem path, never anything outside the configured vault, never the state directory.

**Agents.** One vault today, named by `ui.memory.vault` (default: the first vault the plugin serves itself). The page already reads `host.agents.selectedId` and shows it in the subtitle; per-agent workspaces plug in at `memoryVault()` and that one setting — [[Improvements backlog|A16]].

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
