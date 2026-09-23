---
title: Scope and positioning
tags: [websidian, planning]
aliases: [Positioning, What full Obsidian means]
updated: 2026-09-23
order: 2
description: What full Obsidian can honestly mean
---
# Scope and positioning

What Websidian can honestly become, and why someone would choose it. The phases that get there are in [[Roadmap]]; the ranked next steps are in [[Improvements backlog]].

> Obsidian on the desktop, Websidian on the web, **one vault**.

## What "full Obsidian functionality" can honestly mean

Obsidian is three things. They are worth separating because they cost very differently.

| Layer | What it is | Reachable on the web? | Where we are |
|---|---|---|---|
| **Reading view** | Wikilinks, embeds, callouts, math, mermaid, footnotes, block refs, properties, bases, canvas, excalidraw | Yes, essentially 100 % | ~85 % — canvas, tag pages, embedded search and slides missing |
| **Vault features** | Search with operators, graph, backlinks, outgoing links, tags, properties, templates, daily notes, bookmarks, file explorer, command palette, quick switcher | Yes for the core set | ~50 % — search, graph, backlinks and bases done |
| **Editor** | Live-preview editing, properties panel, autocomplete, slash commands, paste images, drag/drop, split panes, hotkeys | "Good enough" is reachable; pixel parity is not the goal | ~55 % — see [[Feature status]] |
| **Community plugins** | Arbitrary JavaScript running inside Electron | **No. Never promise this** | — |

So "full Obsidian" for Websidian means **100 % of the reading view, the core vault features, an editor an Obsidian user feels at home in, and built-in equivalents of what the top plugins *output*** — Dataview tables, Excalidraw drawings, Kanban boards, Templater basics, Admonitions (which are callouts). Plugin *compatibility* is replaced by a small plugin API of our own ([[Improvements backlog]] #21).

> [!warning] The line not to cross
> Community plugins are arbitrary Electron JavaScript. Running them would mean running untrusted code with vault write access inside a web server. This is parked permanently, not "later".

## The CMS half

A CMS needs five things a notes app does not: **workflow, history, media, structure and people.** Obsidian's frontmatter already gives the data model for all five — which is the whole trick. The CMS database is YAML inside the notes, so Obsidian on the desktop can read and write it too.

| Need | How Websidian does it | Frontmatter it reads |
|---|---|---|
| Workflow | draft → review → published; scheduled publish/unpublish; "unpublished changes" badge; preview drafts through a signed share link | `status`, `publish`, `publishAt`, `unpublishAt` |
| History | out of Websidian: the team keeps the vault in git and commits, pushes and pulls itself; the optional pull webhook refreshes the server ([[Decisions]]) | — |
| Media | paste and drop images into a note; upload goes to the attachment folder from `.obsidian/app.json`; media browser | — |
| Structure | navigation order, folder notes as section index pages, redirects when a note is renamed, custom slugs | `order`, `slug`, `redirect_from`, `aliases` |
| People | named accounts with roles (viewer / editor / admin), per-folder rights later; the audit log is `git log` | — |

Everything in that table is a file write plus a rescan. **Nothing needs a database** ([[Decisions]]).

## Against the alternatives

| Against | Websidian's answer |
|---|---|
| **Obsidian Publish** | Self-hosted, editable in the browser, drafts and scheduling, private folders, your branding, embeddable in your own site, no per-vault fee |
| **Docusaurus / MkDocs / Hugo** | No build, no front-end toolchain, wikilinks and embeds native, edit from the browser, changes live in milliseconds |
| **Notion / a headless CMS** | Files you own, Obsidian on the desktop, git history, works offline, nothing to migrate out of |

One line: **your Obsidian vault as a website you can edit from anywhere.**

## Open questions

These shape the phases and are worth answering before the work they block.

1. **Look of the public site** — branded documentation site (what it does today) or "looks like Obsidian" with the reader's theme? Emitting Obsidian's DOM gives both; the default decides the first impression.
2. ~~**Is the server's vault a git checkout?**~~ Answered 2026-09-23: Websidian does not run git on saves; the team handles it ([[Decisions]]).
3. **Who edits** — one person or a team? Roles and per-folder rights only matter for a team.
4. **The Arabic mirror** — should translation status be first class? English changes, the Arabic note is marked stale, the two edit side by side.
5. **Hosting** — one server for many vaults (multi-tenant, needs isolation and quotas) or one deployment per vault (simple, and what happens today)?
