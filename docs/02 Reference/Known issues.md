---
title: Known issues
tags: [websidian, reference, issues]
updated: 2026-09-16
order: 3
description: Limits and gotchas, stated plainly
---
# Known issues

Limits and gotchas as they stand. When one is fixed, move it to the [[Work log]].

## Editor
- **Every save publishes.** No draft copy of a live note — [[Publishing and visibility]].
- **No history.** A bad save can only be undone through the vault's own git — Websidian does not commit for you yet ([[Decisions]]).
- **Tables inside callouts or lists** stay as Markdown source; only top-level tables become a grid.
- **Table cells render a simplified subset** of Markdown when not being edited (bold, italic, code, links, highlights, tags, images). Other syntax shows as typed.
- **`![[note]]` in Live Preview** is a chip with the title, not the note's content (the Split view and the site show the content).
- **Changes on disk while a note is open** are not shown live; they are caught when you save (conflict banner).
- **Typing with an input method (IME)** in table cells is handled but has not been tested with an Arabic IME.
- **Mermaid in Live Preview may not render** when the diagram is scrolled into view (seen on trusted and untrusted sites, 2026-09-13; unconfirmed). The Split view and the site render it.
- **Arabic `[[` suggestions** match titles and aliases, but fuzzy ranking is tuned for Latin text.

## Server and setup
- **Writing help through the `claude` CLI needs a signed-in CLI** on the server (`claude login`). A signed-out or expired CLI answers *Not logged in* / *OAuth session expired*; Websidian logs it and shows the generic failure line — it never pastes that into the note ([[Writing help]]).
- **Hermes cannot run with no tools at all**, so the `hermes-cli` backend runs with whatever toolsets Hermes has enabled unless `assist.toolsets` narrows it; the prompt is a rewrite instruction and the cwd is the temp folder, but it is a wider surface than the Claude CLI's `--tools ""` ([[Writing help]]).
- **The rename signs everyone out once.** Cookies moved from `md2html_*` to `websidian_*` on 2026-09-16, so the first visit after upgrading needs a fresh sign-in. Share-token links still work — the token is in the link.
- **Server changes need a restart** of `npm start`; browser changes a `Ctrl+Shift+R` — [[Quick start]].
- **Sessions end on restart** unless `edit.secret` is set.
- **`localhost` cookie clash** between two servers on different ports: use `127.0.0.1`.
- **Single editor role**: any signed-in user can edit and delete any note.
- **Sign-in lock-out**: after too many failed sign-ins, an IP gets `429` for up to a minute **even with the right password**. Deliberate (credentials are not checked while over the limit), but it can lock out a colleague on the same network or proxy.
- **`proxyAuth` with `trustProxy: true`**: the allowed-address check uses `X-Forwarded-For`, so only the secret protects it.
- **CSS snippets are off on `untrusted` sites** by default; set `snippets` explicitly if the agent's folder should be styled.

## Drawings
- **The viewer is Excalidraw 0.17.6**, the last release with a browser build that needs no bundler ([[Decisions]]). Drawings made with newer versions open, with approximations: the Excalifont, Nunito, Lilita One and Comic Shanns fonts are drawn as Virgil, Helvetica and Cascadia (layout kept, letterforms differ); elbow arrows are drawn as straight segments; `magicframe` elements are dropped — [[Excalidraw drawings]].
- **LaTeX in a drawing** is not shown (the plugin renders it to an image at draw time; that image is not in the file).
- **A drawing inside a drawing** shows only when the plugin exported the inner one to SVG/PNG.
- **Web embeds in drawings** (YouTube and other iframes) open only on trusted sites; `untrusted` sites strip them.
- **No thumbnail in search or the graph** for drawings: they are not notes, so they are not indexed.
- **The editor's Live Preview shows a drawing as a chip**; the split view and reading view show the viewer.

## Development
- **Parallel Claude sessions share one working folder** and can overwrite each other's files. The project is in git now (<https://github.com/satabd/Websidian>), so there is an undo; a worktree per session is still recommended — [[Improvements backlog]].
- **`git add -A` sweeps up the other session's work.** It happened on 2026-09-16: commit `9fc6734` carries a parallel session's Hermes installer without mentioning it. Stage explicitly, or use a worktree.
- **Tests run outside a dot-folder can miss path bugs**: under `~/.hermes`, Express's `dotfiles` check looked at the whole absolute path and refused editor modules and attachments (fixed 2026-09-13, `test/dotpath.test.js`). The in-container tests ran from `/tmp` and did not catch it.
- **The browser preview pane is shared** between sessions: another session can navigate or resize it mid-test.

## Agent setups
- **Chat replies do not carry dashboard links yet**: the Hermes gateway has not restarted since `link_style: dashboard` and the real vaults were configured.
- **`--restart-runtime` cannot identify the process on Git Bash**: MSYS `ps` has no `-o`, so the script declines to signal the PID rather than guess. Use `install-local.ps1 -RestartRuntime` on Windows, or stop the process yourself. It works normally on macOS and Linux.
- **A vault with `edit: true` is editable by everyone signed in to the dashboard.** The dashboard has one role, so there is no "only this person may edit the agent's memory". Protected files (`SKILL.md`, `MEMORY.md`…) ask for confirmation, but the confirmation is the only thing standing between any dashboard user and what the agent follows. This is why `vaults[].edit` defaults to `false`.
- **The Hermes plugin does not inspect `execute_code` or MCP tools** — a memory or skill written through those is not guarded. `memory` and `skill_manage` are covered since 2026-09-16 — [[Hermes plugin]].
- **`hermes plugins install <repo>` cannot install this plugin**: the manifest is nested at `integrations/hermes/websidian/plugin.yaml` while the repository root is the Websidian app. Use `deploy/install-local.sh` / `.ps1` (or the container script) instead — [[Hermes plugin]], [[Improvements backlog]].
- **A hand-copied runtime with `node_modules` in the wrong place looks installed**: the plugin is listed as enabled while the dashboard tab answers 502, because the supervisor runs `node <app_dir>/src/server.js`. Always `npm --prefix <app_dir> ci --omit=dev`; the installers do.
- **The Websidian tab needs an authenticated dashboard session, not just a healthy server.** A default local dashboard on `127.0.0.1:9119` renders `/websidian` without a login but answers **401** on `/api/plugins/websidian/*` (that mode wants an `X-Hermes-Session-Token` header, which an iframe cannot send). Gate the dashboard — basic auth on a LAN/VPN, OAuth if it faces the internet — and never weaken the gate to make the tab load ([[Decisions]], [[Hermes plugin]]).
- **Vaults are read-only in the browser unless you opt in** (`vaults[].edit` defaults to `false` since 2026-09-16). A vault with `edit: true` is editable by *every* signed-in dashboard user; replies carry no edit link for read-only vaults.
- **Hermes memories and skills were editable in the old `hermes01` config** (set before the default changed). Re-check `vaults[].edit` there after upgrading the plugin.
- **Hermes (`hermes01`) has no volumes**: its memory, skills and Obsidian vault exist only inside the container — [[Agent memory and second brain]].
