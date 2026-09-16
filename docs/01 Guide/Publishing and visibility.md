---
title: Publishing and visibility
tags: [websidian, guide]
updated: 2026-09-16
order: 6
description: Drafts, hidden notes, who sees what
---
# Publishing and visibility

A note is a public page unless something hides it. Hidden notes return 404 even by direct URL, are left out of navigation, search, graph and sitemap — but editors still see and edit them.

| Hides a note | How |
|---|---|
| `publish: false` in frontmatter | Always |
| `onlyPublished: true` on the site | Every note without `publish: true` |
| `excludeStatus: ["draft"]` on the site | Notes whose `status` matches |
| `exclude` on the site | Folders or extensions |
| A dot-folder (`.obsidian`, `.trash`, `.git`) | Always |
| Excalidraw drawing notes | Not in navigation, search or graph; each has a viewer page and can be embedded — [[Excalidraw drawings]]. The rules above still hide them (`publish: false` on the drawing hides its page and its embeds) |

## Who can see what
| Surface | Who |
|---|---|
| Public site | Everyone, unless the site has `auth` (browser login or share token) |
| Editor `/_edit`, API `/_api` | Only when `edit` is configured; signed-in editors; optionally only from `allowFrom` networks |
| Scripts | `edit.token` with `Authorization: Bearer …` |
| A trusted proxy | `proxyAuth`: signed in as the user the proxy names — [[Configuration#Behind a trusted proxy]] |

> [!warning] Every save publishes
> There is no draft copy of a published note yet: saving changes the live page. Use `status: draft` with `excludeStatus` for work in progress, or keep autosave off. A review workflow is on the [[Improvements backlog]].
