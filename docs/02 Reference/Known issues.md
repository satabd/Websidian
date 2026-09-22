---
title: Known issues
tags: [websidian, reference, issues]
updated: 2026-09-23
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

- **Page direction is a guess when a note has no `lang:`**: more Arabic or Hebrew letters than other letters makes the page right-to-left. A short Arabic note full of English terms can land left-to-right, and Persian or Urdu is labelled `lang="ar"` (the direction is right, the language tag is not). Set `lang:` in the frontmatter when it matters.

## Server and setup
- **Writing help through the `claude` CLI needs a signed-in CLI** on the server (`claude login`). A signed-out or expired CLI answers *Not logged in* / *OAuth session expired*; Websidian logs it and shows the generic failure line — it never pastes that into the note ([[Writing help]]).
- **`Ctrl+P` still prints when the editor is embedded and the outer page has focus** — inside the Hermes dashboard, for instance. The editor page cancels the browser shortcut only for its own document. Use `Ctrl+Shift+P` for the palette, or the **✦ Writing help ▾** button / `Alt+W` for the actions ([[Editor hotkeys and commands]]).
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
- **The OpenClaw plugin has not seen a real model turn.** Its hooks, tool and command were driven with a fake plugin API whose contracts were read from OpenClaw 2026.6.9; the reply footer (`message_sending`) and the approval prompt (`before_tool_call` → `requireApproval`) still need one live chat to confirm. The attempt on 2026-09-17 in `clawat02` got *LLM request failed* (ChatGPT responses API `400`, no body) with the plugin enabled **and** disabled; the OpenAI subscription's weekly quota was at 0 % at the time — [[OpenClaw plugin]].
- **The stand-alone OpenClaw pages are a URL, not a tab.** `/plugins/websidian/` is opened by hand (`/brain` prints it) and has its own sign-in. The **Memory** page is the tab, and it needs *Settings → Labs → Custom plugin UI* — without that lab the sidebar entry does not appear, though the route and the descriptor are registered either way — [[OpenClaw plugin#The Memory page]].
- **`before_prompt_build` is refused on OpenClaw 2026.9.5** unless `plugins.entries.websidian.hooks.allowConversationAccess: true` is set: *"typed hook blocked because non-bundled plugins must set…"*. The *Websidian vaults* section then silently never reaches the system prompt. The other three hooks, the tool and `/brain` are unaffected. Seen in `plugins inspect --runtime` on 2026-09-21.
- **OpenClaw has a built-in page called "Memory" too** (`/settings/memory`). Ours is the sidebar destination with the brain icon; a text search for "Memory" in the Control UI can land on the other one. Rename it with `ui.memory.label` if that is confusing.
- **The Memory page's frame needs a secure context when the Gateway has auth.** OpenClaw mints its plugin-tab grant cookie only when `window.isSecureContext` is true, which `127.0.0.1` and HTTPS satisfy but a plain-HTTP LAN address does not. On such a host the Memory page cannot fetch its model.
- **The Memory page cannot be shared as a link to a note.** The view is kept per browser tab, not in the URL, because OpenClaw stops highlighting the sidebar entry when page parameters are present. A link that carries `p.view`/`p.note` still works; it just opens with **Memory** un-highlighted.
- **The framed fallback page names days in the Gateway's timezone** (UTC). The native page works them out in the browser; the fallback is only seen on a host with no native view.
- **The Memory model re-reads the workspace on every request.** No cache, by design — the workspace is the source of truth — but the walk is bounded at 5,000 entries, so a `memory/` folder larger than that is listed only in part.
- **`message_sending` may not cover every OpenClaw surface**: it fires on channel delivery (WhatsApp, Telegram, …). Whether the Control UI chat passes through it was not checked; `websidian_links` and `/brain` work regardless.
- **The OpenClaw guard resolves relative tool paths against the agent's workspace** (`agents.list[].workspace`, else `agents.defaults.workspace`), because the hook does not receive the tool's cwd. Sandboxed sessions (`agents.defaults.sandbox`) write under `~/.openclaw/sandboxes`, which the guard does not know about.
- **`exec` guarding is best-effort** on OpenClaw as on Hermes: a shell write it cannot recognise passes. `code_execution` and MCP tools are not inspected.
- **The OpenClaw supervisor cannot identify its process off Linux.** `pidIsWebsidian` reads `/proc/<pid>/cmdline`; without `/proc` (Windows, macOS) it degrades to "some process is alive at that PID", so after PID reuse the supervisor could adopt — or signal — an unrelated process. Found by two reviews on 2026-09-20; a platform-specific check is [[Improvements backlog|backlog]] work.
- **Double-encoded dot segments reach the Websidian upstream** (`%252e%252e`): the proxy's filter looks for the single-encoded forms. Inert unless Websidian itself percent-decodes twice, which was not established either way — [[OpenClaw plugin]].
- **The `Secure` cookie flag trusts `X-Forwarded-Proto`.** Behind a TLS terminator that does not normalise that header, and with the port also reachable in plaintext, a session cookie could be issued without `Secure`.
- **The OpenClaw guard's multi-edit simulation is approximate.** When an `oldText` is missing or consumed twice the whole-file simulation is abandoned, and the edits are scanned joined and glued instead — stricter than the real result, so it can refuse an edit that would have been harmless. The two bypasses this replaced (a decoy edit, a repeated `oldText`) are fixed and tested since 2026-09-20.
