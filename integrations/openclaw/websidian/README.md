# websidian - OpenClaw plugin

Connects [OpenClaw](https://openclaw.ai) to Websidian (an Obsidian vault served as a website):

- **Write guard** (`before_tool_call`): agent instruction files (`SKILL.md`, `SOUL.md`, `AGENTS.md`, `MEMORY.md`,
  `USER.md`, `TOOLS.md`, `IDENTITY.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`) under the OpenClaw state dir, an agent
  workspace or a vault pause for a human's approval (OpenClaw plugin approvals: chat buttons or `/approve`), or are
  blocked in `protectMode: "block"`. Vault writes must be plain Markdown: `<script>`, `<iframe>`, event-handler
  attributes, `javascript:` / `data:text/html` URLs and `.html`/`.svg`/`.js` files are refused. Covers `write`,
  `edit`, `apply_patch` and, best-effort, `exec`.
- **Links** (`after_tool_call` + `message_sending`): notes the agent wrote get a "Notes updated:" footer with view (and
  edit) links; the `websidian_links` tool returns them on demand; `/brain [query]` lists recent notes.
- **Pages behind the Gateway** (`ui`): the plugin runs a Websidian server on loopback for the configured vaults and
  proxies it at `http://<gateway>/plugins/websidian/w/<slug>/`, behind a sign-in with the Gateway token. Vaults are
  served `untrusted` (inert HTML, CSP) and read-only unless `edit: true`.
- **A native Memory page** in the Control UI (`ui.memory`): a **🧠 Memory** destination in OpenClaw's own sidebar,
  beside Chat and Sessions, that opens *inside* OpenClaw. Overview cards for `MEMORY.md`, `USER.md` and `DREAMS.md`,
  a timeline of the dated notes under `memory/`, and the vault's graph and search — read-only, from the OpenClaw
  workspace, with no second sign-in and no second copy of anything.
- **Skill** `websidian`: how to write notes as Obsidian Markdown and share links.

Plain ESM JavaScript, no build step, no dependencies — the Gateway serves `dist/control-ui/` as it is, so
`openclaw plugins build` is not needed. Tested against OpenClaw 2026.9.5 (and, without the Memory page, 2026.6.9).

## Layout

```
openclaw.plugin.json   manifest (id, contracts.tools, skills, strict configSchema)
package.json           openclaw.extensions -> ./index.js
index.js               entry: the same shape as definePluginEntry(), without importing the SDK
lib/plugin.js          register(api): hooks, tool, command, service, HTTP route
lib/guard.js           the write guard (pure)
lib/links.js           view/edit URLs, recent notes (pure)
lib/sites.js           vault -> site slugs, settings, workspace/state dir resolution (pure)
lib/tracker.js         notes written per session
lib/supervisor.js      Websidian config generation, secrets, the child-process supervisor
lib/proxy.js           sign-in, status page, reverse proxy (auth: "plugin" route)
lib/native.js          the Memory route (auth: "gateway"): model JSON + a framed fallback page
lib/memory.js          which workspace files are memory, and how they group (pure)
dist/control-ui/       the browser Control UI plugin the Gateway serves as-is
  websidian.js           entry: { id, activate(host) }, registers the Memory page and navigation
  memory-page.js         the native page: Overview / Timeline / Graph / Search
  memory.css             styles, all under .websidian-memory
skills/websidian/      SKILL.md
deploy/                installers (native profile, Docker container)
test/                  node --test
```

## Install

Two copies make up the integration: the **plugin** (this folder) and the **Websidian runtime** (a copy of the
repository root: `src/`, `public/`, `package.json`, `package-lock.json`, with `node_modules` installed inside it).
The runtime lives at `<state dir>/plugin-data/websidian/app` (`ui.appDir`), the plugin wherever OpenClaw loads it from.

**Native install** (macOS, Linux, Git Bash), from the repository root:

```bash
bash integrations/openclaw/websidian/deploy/install-local.sh
```

**Windows PowerShell:**

```powershell
powershell -ExecutionPolicy Bypass -File integrations\openclaw\websidian\deploy\install-local.ps1
```

**Docker container** (e.g. `alpine/openclaw`):

```bash
bash integrations/openclaw/websidian/deploy/install-into-container.sh <container>
```

Each installer copies the runtime, runs `npm ci --omit=dev` inside it, copies the plugin to
`<state dir>/plugin-data/websidian/plugin`, stamps both with the git revision, boots the runtime once on a throw-away
vault to check `/_health`, and prints the two commands it does **not** run for you:

```bash
openclaw plugins install --link <state dir>/plugin-data/websidian/plugin
openclaw gateway restart      # or restart the container
```

`--link` registers the folder as an installed plugin (`plugins.entries.websidian`). The alternative is
`plugins.load.paths: ["<that folder>"]` in `openclaw.json`. A restart of the Gateway is what makes the hooks, the
tool, the command and the pages exist.

## Configure

`openclaw.json`, under `plugins.entries.websidian.config` (the manifest schema is strict; unknown keys fail
validation):

```json5
{
  plugins: {
    entries: {
      websidian: {
        enabled: true,
        config: {
          vaults: [
            { path: "/home/node/.openclaw/workspace", slug: "workspace", title: "Agent workspace" },
            { path: "/srv/brain", slug: "brain", edit: true },
            { path: "/srv/team", url: "https://notes.example.com/team/" }   // an external Websidian; links go there
          ],
          protectMode: "approve",          // or "block"
          // protect: ["SKILL.md", "SOUL.md", ...],   // defaults to the nine instruction files
          // blockActiveContent: true, appendLinks: true,
          ui: {
            enabled: true,
            port: 8095,
            publicBase: "http://127.0.0.1:18789",   // how browsers reach the Gateway (used in links)
            auth: "gateway"                         // sign in with the Gateway token; or "password" + password
          }
        }
      }
    }
  }
}
```

- `path` is the vault folder as the Gateway process sees it (inside the container for Docker).
- Vaults default to `untrusted: true` and `edit: false`; browser editing is opt-in per vault.
- Point `path` at content folders (a vault, `workspace/`), never at the whole state dir: it holds credentials.
- `tools.allow` is not needed: `websidian_links` is a required tool of the plugin.

## Pages

`http://127.0.0.1:18789/plugins/websidian/` (through the published port for Docker): sign in with the Gateway token,
see every site, open a vault. Notes are at `/plugins/websidian/w/<slug>/<Note>`, the editor (when `edit: true`) at
`/plugins/websidian/w/<slug>/_edit/<Note>`. The sign-in sets an `HttpOnly` cookie scoped to `/plugins/websidian`
for `ui.sessionHours` (12); the proxy signs requests in to Websidian with a shared secret (`proxyAuth`), so
Websidian itself needs no login and only listens on loopback.

## The Memory page

A **🧠 Memory** entry in OpenClaw's own sidebar, opening inside the Control UI. Two halves, either of which works
without the other:

- **Backend.** A second HTTP route, `/plugins/websidian-memory`, with `auth: "gateway"` — OpenClaw authenticates
  the operator before the plugin sees the request. It serves the model as JSON and, for a host with no native view,
  the same dashboard as plain HTML. A `surface: "tab"` Control UI descriptor points at it, which is what puts the
  entry in the sidebar *and* what makes the Gateway mint the browser's grant for that route.
- **Browser.** `dist/control-ui/websidian.js` is loaded by the Control UI (`defineControlUiPlugin`'s shape) and
  registers a native page with the same id, `memory`, plus a navigation item. It draws Overview, Timeline, Graph
  and Search itself and renders notes with Websidian in shell mode inside the content area.

Turn it on with *Settings → Labs → Custom plugin UI*, or in `openclaw.json`:

```json5
{ gateway: { controlUi: { experimental: { customPlugins: true } } } }
```

then restart the Gateway and reload the page. Set `ui.memory.enabled: false` to leave the sidebar alone; everything
else in the plugin is unaffected either way.

> **One sign-in, not two.** The Memory route answers only requests OpenClaw has already authenticated, so it mints
> the plugin's own session cookie for that browser — the very cookie a successful sign-in on the form mints, same
> secret, same scope. The notes it links to then open through the existing proxy with no second sign-in and no new
> kind of credential. The stand-alone pages at `/plugins/websidian/` keep their own sign-in, untouched.

> **Why a sibling path and not `/plugins/websidian/memory`.** OpenClaw refuses two plugin routes whose prefixes
> overlap ("http route overlap rejected"), and the stand-alone prefix route already claims everything below it.

Memory is **read-only**: the page never offers the editor, whatever `edit` a vault is given elsewhere, and the
model it hands the browser carries vault-relative paths only — never a filesystem path, never anything outside the
configured vault.

### Agents

One vault today, chosen by `ui.memory.vault` (default: the first vault the plugin serves itself). The page already
reads `host.agents.selectedId` and shows it; per-agent workspaces plug in at `memoryVault()` in `lib/memory.js`
and the `vault` setting, without touching anything else.

## Is it really installed?

| # | Check |
|---|---|
| 1 | `openclaw plugins inspect websidian --runtime` lists the hooks, tool `websidian_links`, command `brain`, service `websidian-runtime` and 2 HTTP routes, with no diagnostics |
| 2 | `<appDir>/src/server.js` and `<appDir>/node_modules/` exist |
| 3 | `GET /plugins/websidian/` answers 302 to `/plugins/websidian/login` (without a session) |
| 4 | After signing in, `/plugins/websidian/status.json` says `running: true` and lists the sites |
| 5 | An untrusted note carries a CSP and `X-Content-Type-Options: nosniff` |
| 6 | The agent's reply to "write a note in the vault" ends with "Notes updated:" and a working link |
| 7 | Asking the agent to change `SOUL.md` produces an approval prompt |

## Updating

Re-run the installer, then restart the Gateway. It replaces the runtime (`src`, `public`, dependencies) and the
plugin folder; nothing already running picks up new code until the restart.

## Tests

```bash
npm test                                   # repository root: Websidian + this plugin
node --test "integrations/openclaw/websidian/test/*.test.js"
```

`test/plugin.test.js` drives `register()` with a fake plugin API; the hook and tool contracts it mirrors were read
from OpenClaw 2026.6.9 (`before_tool_call` result shape, `after_tool_call` and `message_sending` events,
`registerTool`/`registerCommand`/`registerHttpRoute`/`registerService` signatures).
