---
title: Roadmap
tags: [websidian, planning]
updated: 2026-09-16
order: 1
description: The phases, and what is done in each
---
# Roadmap

Where Websidian goes, in phases. What it can honestly become is in [[Scope and positioning]]; the ranked next steps are in [[Improvements backlog]]; what shipped is in [[Work log]].

| Phase | Goal | State |
|---|---|---|
| 0 | Rename to Websidian | ✅ done 2026-09-16 |
| 1 | CMS essentials: git per save, attachments, rename, properties, publishing states, roles, live reload, slash commands | 🟡 properties, slash commands and publishing states done |
| 2 | An editor an Obsidian user feels at home in | 🟡 most of it — see [[Feature status]] |
| 3 | Reading view completeness and Obsidian themes | ⬜ |
| 4 | Platform: plugin API, MCP server, multi-vault, i18n, export | 🟡 agent integration started ([[Hermes plugin]]) |

## Phase 0 — Rename to Websidian ✅
Done in one sweep on 2026-09-16:

- `package.json`, README, the `WEBSIDIAN_CONFIG` env var and the `websidian.config.json` default filename — both old names still work.
- Cookies `websidian_<site>` and `websidian_edit_<site>`. **Everyone is signed out once** when this ships; there is no way to rename a cookie without that.
- `window.WEBSIDIAN`, `window.WEBSIDIAN_EDIT`, `window.WEBSIDIAN_GRAPH` — the `MD2HTML` names are assigned alongside them, so a script someone else wrote still works.
- The iframe height message is sent as **both** `websidian:height` and `md2html:height` ([[Embedding in your website]]), because pages in the wild listen for the old one.
- `localStorage` keys `websidian-theme` and `websidian-edit-mode`, falling back to the old keys so a reader keeps their theme.
- Example slugs and paths in the docs no longer name a real client vault.

`test/naming.test.js` holds the aliases in place. Left: the Docker image name and a domain.

## Phase 1 — CMS essentials
Make the editor something you use every day.

1. **Git commit per save**, history panel (list, diff, restore), author = the signed-in editor. Decided in [[Decisions]], not built.
2. **Attachments**: paste and drag-drop images into the editor → upload to the attachment folder from `.obsidian/app.json` → `![[name.png]]` inserted; a media browser to reuse existing files.
3. **Rename / move** with wikilink rewriting across the vault, and an automatic `301` from the old URL (`redirect_from` written to frontmatter).
4. ✅ **Properties panel** — form above the editor, types from `.obsidian/types.json`, raw YAML still editable.
5. **Publishing states and scheduling** — `status` and `publish` already drive visibility ([[Publishing and visibility]]); still to add `publishAt` / `unpublishAt`, an "unpublished changes" badge, and a signed preview link for showing a draft to a reviewer.
6. ✅ **Navigation control** — `order:` in frontmatter, folder notes (`Folder/Folder.md` becomes the folder's page), generated section pages ([[Navigation and sections]]). Left: collapsed and expanded defaults, custom slugs.
7. **Roles** — `viewer` (sees drafts, cannot save), `editor`, `admin` (config, purge, users). Per-folder rights later.
8. **Live reload for editors** through server-sent events when the vault changes on disk — Obsidian on the desktop just saved the note you are reading.
9. ✅ **Slash commands** for callouts, tables, code fences, embeds, today's date.

## Phase 2 — An editor an Obsidian user feels at home in
1. ✅ **CodeMirror 6**: Obsidian Markdown parsed as syntax nodes, Obsidian class names and hotkeys, auto-pairing and wrap-selection, list continuation, search and replace, folding, `.obsidian/app.json` settings, quick switcher, command palette, slash commands, status bar.
2. ✅ **Autocomplete** for `[[notes]]` (aliases, attachments, fuzzy), `#tags`, `[[note#heading]]`, `[[note#^block]]`, properties and their values.
3. ✅ **Live-preview decorations** — syntax hides away from the cursor; links, checkboxes, callouts, images, embeds, math and mermaid render. Tables as grids and the Properties panel landed 2026-09-11.
   Left: note transclusion (`![[note]]` renders the note, not a chip), page preview on hover, richer table-cell formatting.
4. **Templates** — `Templates/` from `.obsidian/templates.json`, `{{title}}`, `{{date}}`, `{{time}}`; new-note location from `app.json`; daily notes from `daily-notes.json`.
5. **Panels** — outline, backlinks, outgoing links, local graph, properties, as collapsible side panels rather than tabs, so a laptop screen still works.
6. **Split view of two notes**, for the English / Arabic mirror, with "open translation" from the language switch.
7. **Mobile** — the editor already collapses to one pane; make the toolbar thumb-friendly.

## Phase 3 — Reading view completeness and themes
1. Obsidian DOM and class names throughout, plus a ported Obsidian default theme; load `.obsidian/themes/<name>/theme.css` when `appearance.json` selects one; `cssTheme` per site.
2. Tag pages (`/tags/x`), a tag pane, nested tags.
3. Search operators — `tag:`, `path:`, `file:`, `[property:value]`, `line:`, quoted phrases, regex; results grouped by note with context.
4. `.canvas` files as pan/zoom HTML (the JSON Canvas spec is open).
5. Embedded search blocks, embedded PDF page ranges, `![[image.png|left]]` alignment classes.
6. A **Dataview subset** — `TABLE`, `LIST`, `TASK` over frontmatter and tasks, `FROM #tag / "folder"`, `WHERE`, `SORT`, `LIMIT`. No DataviewJS. Bases is the official successor and already renders ([[Feature status]]); recommend Bases for new content.
7. Slides (`---` separated) as a presentation page. Kanban boards as columns.

## Phase 4 — Platform
1. **Plugin API** — server side (markdown-it plugin, routes, lifecycle hooks) and client side (editor extension). Ship the built-ins as plugins to prove the API.
2. **MCP server** — the JSON API already exists ([[Editor API]]); expose it as MCP so an agent reads, searches and edits the vault with the same permissions as a person. [[Hermes plugin]] is the first step.
3. **Multi-vault workspaces** with per-site themes and domains; UI translation, Arabic first.
4. **`websidian export`** — crawl into a static folder for CDN-only hosting, using the same renderer.
5. **Comments and review annotations** for reviewers who should not edit.

## What to do first

1. **Git commit per save + history panel.** Cheapest, highest CMS value, and it makes every later feature safe to try because everything can be undone.
2. **Paste-to-upload images.** Nobody writes real documentation in a browser without it.
3. **Rename with link rewriting and a `301`.** Without it people avoid renaming, and the vault rots.

Then decide the public site's default look — the first open question in [[Scope and positioning#Open questions]] — before more CSS accumulates.
