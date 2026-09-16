---
title: Improvements backlog
tags: [websidian, planning]
aliases: [Suggestions, Backlog]
updated: 2026-09-16
order: 3
description: Suggestions ranked by value for effort
---
# Improvements backlog

Suggestions ranked by value for effort. **P1** = next, **P2** = soon, **P3** = later. Move an item to [[Work log]] and update [[Feature status]] when it ships.

## P1 — do next
| # | Improvement | Why | Effort |
|---|---|---|---|
| 1 | **A git worktree per Claude session** | The repo exists now, but parallel sessions still share one folder and overwrite each other ([[Known issues]]) | S |
| 2 | **Git commit per save**, authored by the signed-in editor; history panel with diff and restore | Decided ([[Decisions]]); makes every other change safe; audit trail | M |
| 3 | **Paste and drop images** into the editor → upload to the vault's attachment folder (`app.json` `attachmentFolderPath`) → insert `![[name.png]]` | Nobody writes real documentation without screenshots | M |
| 4 | **Live reload of the open note** when the file changes on disk (server-sent events), with a merge prompt if you have unsaved edits | Obsidian desktop, git pulls and agents write the same files; today you only find out at save time | M |
| 5 | **Rename / move with link rewriting** across the vault, plus `redirect_from` so old URLs keep working | Otherwise people avoid renaming and links rot | M |

## P2 — soon
| # | Improvement | Why |
|---|---|---|
| 6 | `![[note]]` rendered as content in Live Preview (transclusion) | Matches the site and Obsidian |
| 7 | Hover page preview on links (`Ctrl`+hover like Obsidian) | Fast reading without leaving the note |
| 8 | Right panel: **outline**, **backlinks with context**, outgoing links, local graph | Obsidian's core sidebars |
| 9 | **Draft / review workflow**: edit a copy, publish when approved; "unpublished changes" badge | Every save publishes today |
| 10 | **Roles**: viewer / editor / admin, later per folder | Team use |
| 11 | Templates (`Templates/`, `{{date}}`, `{{title}}`) and daily notes from `.obsidian` settings | Common Obsidian workflows |
| 12 | Tables inside callouts and lists as grids; richer cell rendering; column resize; row drag | Complete the table editor |
| 13 | Search operators (`tag:`, `path:`, `file:`, `[prop:value]`) in site search and quick switcher | Obsidian users expect them |
| 14 | Mobile toolbar (bold, link, list, checkbox, undo) above the keyboard | Editing from a phone |
| 14c | **Package the Hermes plugin for `hermes plugins install`** — a standalone plugin repository, or a root manifest that points at the nested one | Today the only routes are `deploy/install-local.sh` / `.ps1`, the container script, or copying a subfolder by hand ([[Hermes plugin]]) |

## P3 — later
| # | Improvement |
|---|---|
| 15 | Obsidian themes on the public site (`.obsidian/themes`, `appearance.json`) — needs the reading view to emit Obsidian's DOM |
| 16 | Tag pages and a tag pane |
| 17 | Canvas (`.canvas`) as pan/zoom pages |
| 18 | Dataview subset (`TABLE`, `LIST`, `TASK`, `FROM`, `WHERE`, `SORT`) |
| 19 | Split view of two notes (English / Arabic side by side) |
| 20 | **MCP server** so agents read, search and edit the vault with editor permissions |
| 21 | Plugin API (server markdown-it hooks + editor extensions) |
| 22 | Comments and review annotations for non-editors |
| 23 | Static export for CDN-only hosting |

## For agent memory
See [[Agent memory and second brain]].

| # | Improvement |
|---|---|
| A1 | Mount Hermes `memories/`, `skills/` and its Obsidian vault to Windows folders; named volume for the rest of `~/.hermes` |
| A2 | Memory view: `§` entries as a list, character meter against the agent's limit |
| A3 | Git history of memory files, including the agent's own writes ("what did it learn this week") |
| A4 | One-click "revert this memory entry" |
| A5 | [[Hermes plugin]] in `hermes01` with the dashboard tab and real vaults ✅ — remaining: gateway restart for chat links |
| A7 | Fix the dashboard link sign-in redirect for note names with `& # + %` |
| A8 | Browser-test saving a protected file with confirmation through the dashboard (on a copy) |
| A6 | Extend the plugin guard to the `memory` and `skill_manage` tools |

## Rejected or parked
- **Community plugin compatibility** — plugins are arbitrary Electron JavaScript; replaced by our own plugin API (#21).
- **Static generation instead of the server** — rejected early; see [[Decisions]].
