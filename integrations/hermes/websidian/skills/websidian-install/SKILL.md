---
name: websidian-install
description: Install, update or verify the Websidian Hermes plugin and its Node runtime on this machine, including which services need a restart and which checks prove the dashboard tab actually works.
version: 0.1.0
author: Websidian
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Websidian, Installation, Upgrade, Operations, Dashboard]
    related_skills: [websidian]
---

# Installing and updating Websidian

Two separate copies make up this integration, and they must come from the same revision:

| Copy | Where | Loaded by |
|---|---|---|
| The plugin (Python) | `<profile>/plugins/websidian/` | the gateway and the dashboard, at start-up |
| The runtime (Node) | `<profile>/plugin-data/websidian/app/` | the dashboard's supervisor: `node <app_dir>/src/server.js` |

`<profile>` is `$HERMES_HOME`, else `~/.hermes` (Windows: `%LOCALAPPDATA%\hermes`). Both copies are made from
a checkout of the Websidian repository; the installers stamp each with the git revision in
`websidian.version`.

> [!warning] `hermes plugins install <repo>` cannot install this
> The repository root is the Websidian application and the manifest is nested at
> `integrations/hermes/websidian/plugin.yaml`. Use the installer script below.

## Install

From the repository root:

```bash
bash integrations/hermes/websidian/deploy/install-local.sh
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File integrations\hermes\websidian\deploy\install-local.ps1
```

Into a running container: `bash integrations/hermes/websidian/deploy/install-into-container.sh [container]`.

The script copies both halves, runs `npm --prefix <app_dir> ci --omit=dev --ignore-scripts` **inside
app_dir**, checks the layout, stamps both copies and boots the installed server once against a throw-away
vault to confirm `/_health`. Useful flags: `--hermes-home`, `--app-dir`, `--dry-run`, `--no-smoke`,
`--restart-runtime`.

Then the human runs `hermes plugins enable websidian` and the `hermes config set …` lines the script
prints. **Decline the "replace built-in tools" prompt** (`--allow-tool-override`): this plugin works
through its three hooks and its own `websidian_links` tool.

## Update

```bash
git pull && bash integrations/hermes/websidian/deploy/install-local.sh --restart-runtime
```

Re-running the installer *is* the update: it removes `app_dir/src` and `app_dir/public` before re-copying,
re-runs `npm ci` (picking up lockfile changes) and replaces the plugin folder.

**Copying files updates nothing that is already running.** Match the restart to what changed:

| Changed upstream | Restart |
|---|---|
| `src/`, `public/`, dependencies | the supervised Websidian process — `--restart-runtime`, or `kill $(cat <profile>/plugin-data/websidian/server.pid)`; the supervisor starts it again within ~15 s |
| `dashboard/*.py`, `dashboard/dist/` | the dashboard (its plugin routes mount only at start-up) |
| `__init__.py`, `guard.py`, `links.py`, `sites.py`, `skills/` | the gateway (write guard, links, `/brain`, skills) |

The supervisor only restarts Websidian by itself when the generated config changes or `/_health` stops
answering — never because the code on disk changed.

## Verify

An install or update is finished when all of these hold:

1. `<profile>/plugins/websidian/plugin.yaml` and `dashboard/manifest.json` exist.
2. `<app_dir>/src/server.js` and `<app_dir>/node_modules/` exist.
3. `hermes plugins list --plain` shows `websidian` as enabled.
4. Every configured `vaults[].path` exists and is readable.
5. `/_health` answers `200` (the installer's smoke test does this).
6. A page from an untrusted vault carries a CSP and `X-Content-Type-Options: nosniff`.
7. The dashboard has been restarted by the human and the **Websidian** tab appears.
8. The dashboard session is authenticated, and through it both `/api/plugins/websidian/status` and
   `/api/plugins/websidian/w/<slug>/` load.
9. `websidian.version` matches on both copies (the tab warns when they do not).

Report which of these you checked and which you could not. Checks 7 and 8 need a human in a signed-in
browser; do not claim them from a terminal.

## Never do these

- **Do not restart the dashboard or the gateway on your own.** Say which one needs a restart and why, and
  let the human choose when. `--restart-runtime` is the exception: it only stops the supervised Websidian
  process, which the supervisor starts again on its own.
- **Do not weaken, bypass or remove dashboard authentication** to make the tab load. A `401` on
  `/api/plugins/websidian/*` means the dashboard is not in its gated mode; the fix is basic auth on a
  trusted LAN or VPN, or OAuth for anything internet-facing.
- **Do not set `untrusted: false`** on a vault that an agent, a sync, a clipper or another person writes
  to. The dashboard iframe is same-origin, so a script in a note would run as the signed-in user.
- **Do not set `edit: true`** unless the human asked for that vault by name: every signed-in dashboard
  user can then rewrite it, including the agent's own instruction files.
- **Do not edit `config.yaml` by hand** when `hermes config set` can do it; it writes only the key you name.

## When something is wrong

| Symptom | Cause | Fix |
|---|---|---|
| Tab shows 502 with a log tail | `app_dir` has no `node_modules`, or `dashboard.app_dir` points elsewhere | re-run the installer; check `dashboard.app_dir` matches where it installed |
| `/websidian` loads but its API returns 401 | the dashboard is not gated | gate the dashboard; never work around it |
| "Half an upgrade" warning in the tab | plugin and runtime are different revisions | re-run the installer, then restart the dashboard |
| New code does not take effect | the old process is still running | restart per the table above |
| `npm ci` says "added N packages" but the tab still 502s | `npm ci` ran in the wrong directory | `npm --prefix <app_dir> ci --omit=dev` |
| Plugin enabled but nothing happens in chat | the gateway has not restarted since enabling | ask the human to restart it |
