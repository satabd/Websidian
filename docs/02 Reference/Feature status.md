---
title: Feature status
tags: [websidian, reference, status]
updated: 2026-09-13
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
| Excalidraw | 🟡 | Needs the plugin's auto-exported image |
| Search (fuzzy, snippets) | 🟡 | No Obsidian operators (`tag:`, `path:`…) |
| Graph view, Explore view, local graph | ✅ | |
| Backlinks, previous/next, table of contents | ✅ | |
| Arabic / English language switch, RTL pages | ✅ | |
| Embed mode for iframes | ✅ | [[Embedding in your website]] |
| Drafts and visibility rules | ✅ | [[Publishing and visibility]] |
| Site auth (basic / share token) | ✅ | |
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
| MCP server for agents | ⬜ |
