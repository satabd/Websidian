---
title: Feature status
tags: [websidian, reference, status]
updated: 2026-09-23
order: 1
description: Done, partial, in progress, missing
---
# Feature status

✅ done and tested · 🟡 partial · 🚧 in progress · ⬜ not started. Details and priorities for the gaps: [[Improvements backlog]].

## Public site (reading view)
| Feature | Status | Notes |
|---|---|---|
| Wikilinks, embeds, transclusion, block refs | ✅ | [[Obsidian syntax support]] |
| Callouts, math, mermaid, footnotes, highlights, comments | ✅ | |
| Frontmatter chips, `cssclasses`, CSS snippets | ✅ | |
| Obsidian Bases (table views) | 🟡 | Cards and other view types skipped |
| Excalidraw: live viewer for `![[x.excalidraw]]` and drawing pages, images, links, dark mode | ✅ | Browser-tested on two real drawings 2026-09-16 — [[Excalidraw drawings]]. Fonts newer than Excalidraw 0.17 are approximated |
| Search (fuzzy, snippets) | 🟡 | No Obsidian operators (`tag:`, `path:`…) |
| Graph view, Explore view, local graph | ✅ | Explore also has **reach** (upstream / downstream of a note) and **named views** from frontmatter `views:` — browser-tested on this vault and the demo, light and dark, 2026-09-17 — [[Graph and Explore#Reach]]. `_graph.json` builds the views once per scan since 2026-09-20 (5.58 ms → under 0.001 ms per request on a 3,000-note vault) |
| Backlinks, previous/next, table of contents | ✅ | |
| Navigation order (`order:`), folder notes, generated section pages | ✅ | [[Navigation and sections]] |
| Arabic / English language switch, RTL pages | ✅ | Notes without `lang:` get their page direction from their letters (browser-checked on an untrusted site under the dashboard mount, 2026-09-16) |
| Embed mode for iframes | ✅ | [[Embedding in your website]] |
| Shell mode (`?shell=1`, `&theme=`, `&chrome=tree|none`) for a host application's own chrome | ✅ | Sidebar, search, backlinks and local graph kept; brand, print and theme dropped; the mode and the theme ride on every link. Browser-tested inside OpenClaw's Control UI, light and dark, 2026-09-21 — [[Embedding in your website#Inside another application shell mode]] |
| Drafts and visibility rules | ✅ | [[Publishing and visibility]] |
| Site auth (basic / share token) | ✅ | Cookies are `websidian_<site>` since 2026-09-16 |
| Generated favicon from `brand.color`, OpenGraph and Twitter cards | ✅ | [[Deploying#A public, read-only site]] |
| `untrusted` site mode: no raw HTML, CSP with nonces, attachment allowlist, strict mermaid, CSS snippets off | ✅ | For agent-written folders — [[Agent memory and second brain]] |
| Rate limit on failed basic-auth sign-ins (429) | ✅ | |
| `proxyAuth`: sign-in through a trusted reverse proxy | ✅ | Browser-tested through the Hermes dashboard, 2026-09-13 — [[Configuration#Behind a trusted proxy]] |
| Obsidian themes on the public site | ⬜ | |
| Canvas, Dataview, tag pages, slides | ⬜ | |

## Editor
| Feature | Status | Notes |
|---|---|---|
| Separate login, IP gate, API token | ✅ | [[Editing in the browser]] |
| CodeMirror 6 with Obsidian Markdown parsing | ✅ | [[Editor internals]] |
| Live Preview / Source mode | ✅ | |
| Link click = edit, Ctrl+click = follow | ✅ | Fixed 2026-09-11 after feedback |
| Tables as editable grid | ✅ | Top-level tables only |
| Properties panel | ✅ | |
| Suggestions: notes, aliases, files, headings, blocks, tags, properties | ✅ | |
| Slash commands, command palette, quick switcher | ✅ | |
| Obsidian hotkeys | ✅ | [[Editor hotkeys and commands]] |
| Reads `.obsidian/app.json` and `types.json` | ✅ | |
| Per-line right-to-left | ✅ | |
| Save conflicts detection, trash on delete, CRLF kept | ✅ | |
| Split view with site rendering, reading view | ✅ | |
| Autosave | 🟡 | Opt-in per browser |
| `![[note]]` shown as content in Live Preview | 🟡 | Shows a chip with the title |
| Protection for agent instruction files (`edit.protect`): notice + confirm before save or delete | ✅ | 2026-09-13 |
| Agent memory size warnings (`edit.memoryLimits`) | ✅ | 2026-09-13 |
| Refuses writes through symlinks / junctions that leave the vault | ✅ | 2026-09-13 |
| Git commit per save, history panel | ⬜ | Top of the backlog |
| Writing help in the editor: improve, shorten, expand, summarise, translate, suggest — a top-bar menu, right-click menu, `Alt+W` and the palette; via the `claude` CLI (default), the `hermes` CLI, or the API | ✅ | Menu, right-click, `Ctrl+P` capture and a hermes-cli *Translate → French* with one-step undo verified in the browser on the demo vault, 2026-09-16 (evening). Both CLIs verified live on real subscriptions earlier that day: `hermes-cli` kept a wikilink through a rewrite and translated to Arabic; `claude-cli` (after `claude auth login`) fixed a paragraph through the route in 7 s and shortened a note from the palette, applied as one undoable change — [[Writing help]] |
| **Agents in the editor**: a side panel (`Alt+A`) to review or edit notes with Claude Code, Codex or Hermes Agent, one continuing CLI session per note, the Obsidian skills, every changed file as a diff with Revert | ✅ | Browser-tested 2026-09-23 on a copy of this vault with the real CLIs: Claude Code (review, a follow-up answered from memory, an edit reloaded in place and reverted), Codex (review, follow-up, an edit over the API; needs `windowsSandbox: "unelevated"` on this Windows machine) and Hermes (review, follow-up); phone width and dark mode — [[Agents in the editor]] |
| Agents in the editor: OpenClaw (`openclaw-cli`, `openclaw agent --session-id`) | 🟡 | argv and reply parsing unit-tested against the documented CLI; no Gateway was running to try it live |
| Paste / drop images | ⬜ | |
| Rename or move with link updates | ⬜ | |
| Hover page preview | ⬜ | |
| Live reload when the file changes on disk | ⬜ | Conflicts are caught at save time only |
| Outline, backlinks, outgoing links panels | ⬜ | Backlink count only |
| Templates, daily notes | ⬜ | |
| Roles (viewer / editor / admin) | ⬜ | Everyone signed in can edit everything |
| Mobile-friendly toolbar | 🟡 | Works, not tuned |

## Integrations
| Feature | Status |
|---|---|
| Git webhook pull | ✅ |
| Hermes plugin (`integrations/hermes/websidian`) — [[Hermes plugin]] | ✅ tested in the real Hermes; real vaults configured; gateway restart pending for chat links |
| Hermes dashboard tab (Websidian inside the Hermes dashboard, via `proxyAuth`) — [[Hermes plugin#Dashboard tab]] | ✅ deployed in `hermes01`, browser-tested |
| Hermes plugin: write guard covers `memory` and `skill_manage` (approve/block, active-content check); deep links survive the login redirect (`note64=`) | ✅ 2026-09-16, 98 plugin tests incl. a round-trip through Hermes's real redirect functions; protected save browser-checked through the dashboard |
| Hermes plugin: native profile installers (`deploy/install-local.sh`, `install-local.ps1`) — [[Hermes plugin#Install]] | ✅ both run end to end 2026-09-16 (Git Bash, PowerShell), each ending in a real `/_health` smoke test; layout covered by `test/hermes-install.test.js` |
| Hermes plugin: update path — version stamps, `--restart-runtime`, restart matrix — [[Hermes plugin#Updating]] | ✅ stamps written and read back through `/_health`; the restart path exercised against a live process |
| Hermes plugin: agent skills (`websidian:websidian`, `websidian:websidian-install`) | ✅ both registered and checked in the plugin suite |
| Hermes plugin packaged for `hermes plugins install` | ⬜ the manifest is nested, so the normal installer cannot take this repository ([[Improvements backlog]] 14c) |
| OpenClaw plugin (`integrations/openclaw/websidian`): write guard on `write`/`edit`/`apply_patch`/`exec`, links footer, `websidian_links`, `/brain`, skill — [[OpenClaw plugin]] | 🟡 deployed in `clawat02` 2026-09-17 (loaded, supervisor running, pages probed through port 18794); `clawat02` is on OpenClaw 2026.9.5 since, still with that plugin (no Memory page, capability consent pending — [[OpenClaw plugin#On OpenClaw 2026.9.5]]); guard ported with zero differences from the Python one on 140 inputs, and two bypasses in the adapters around it (new-file path resolution, split multi-edit) found and closed by review on 2026-09-20; hooks exercised with a fake API only — the live chat turn waits for the OpenAI backend (`400` with or without the plugin; weekly quota at 0 %, ~2026-09-19) |
| OpenClaw plugin: pages behind the Gateway (`/plugins/websidian/`, supervised Websidian, sign-in with the Gateway token) — [[OpenClaw plugin#Pages]] | ✅ 2026-09-17, probed over HTTP in the container: sign-in, status, proxied notes with CSP, editor gating, path validation |
| OpenClaw plugin: installers (`deploy/install-into-container.sh`, `install-local.sh`, `.ps1`) | 🟡 the container one ran end to end twice (throw-away container, then `clawat02` with `--register`); the native ones are untested copies of the Hermes ones |
| OpenClaw plugin: native **Memory** page in the Control UI (`defineControlUiPlugin` + `host.ui.registerPage`/`registerNavigation`, a `surface: "tab"` descriptor and the `auth: "gateway"` route) — [[OpenClaw plugin#The Memory page]] | ✅ 2026-09-21, redesigned 2026-09-23 (previews, native search, a reading pane, Browse, relative times, days in the reader's timezone). Browser-tested both times against a real OpenClaw 2026.9.5 Gateway: the sidebar entry, every tab, search, the reading pane, a graph click, reload, Arabic RTL, light and dark live, one sign-in |
| MCP server for agents | ⬜ |
