---
title: Feature status
tags: [websidian, reference, status]
updated: 2026-09-16
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
| Graph view, Explore view, local graph | ✅ | |
| Backlinks, previous/next, table of contents | ✅ | |
| Navigation order (`order:`), folder notes, generated section pages | ✅ | [[Navigation and sections]] |
| Arabic / English language switch, RTL pages | ✅ | |
| Embed mode for iframes | ✅ | [[Embedding in your website]] |
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
| Writing help in the editor: improve, shorten, expand, summarise, translate, suggest — via the `claude` CLI (default), the `hermes` CLI, or the API | ✅ | Both CLIs verified live on real subscriptions, 2026-09-16: `hermes-cli` kept a wikilink through a rewrite and translated to Arabic; `claude-cli` (after `claude auth login`) fixed a paragraph through the route in 7 s and shortened a note from the palette, applied as one undoable change — [[Writing help]] |
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
| MCP server for agents | ⬜ |
