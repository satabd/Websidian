---
title: Tour
tags: [websidian, moc, tour]
aliases: [Screenshots, What it looks like]
updated: 2026-09-16
order: 2
description: Every screen, with screenshots
---
# A tour of Websidian

Every screenshot here is the real thing, taken from `npm run demo` — the practice vault in `demo/vault` and this documentation vault, served by the same process. Nothing is mocked up. Run [[Quick start]] and you will see these screens yourself.

> [!abstract] The whole idea in one picture
> The left is a folder of `.md` files. The right is a website. There is no build step in between — the page is rendered when someone asks for it and cached until the file changes.

## Reading: the public site

A note becomes a page. The sidebar is the vault's folder tree, the right rail is the note's own headings and a live graph of what links to what.

![[site-reading-view.png]]

Wikilinks, embeds, callouts, math, mermaid, footnotes, tags and properties all render the way Obsidian renders them — using Obsidian's own class names, so Obsidian themes apply ([[Decisions]]). [[Obsidian syntax support]] is the full list.

![[site-syntax.png]]

Arabic and English live in one vault. Direction is decided per line, so a right-to-left paragraph sits next to a left-to-right one without either being wrong.

![[site-rtl-arabic.png]]

## Finding things

Search is fuzzy and runs over the whole vault, with the matching line as the snippet.

![[site-search.png]]

The **graph** is Obsidian's, on the web: filters, groups by colour rule, forces you can drag, a local graph around one note.

![[site-graph.png]]

**Explore** is the one Obsidian does not have — a graph built for reading rather than looking. Notes cluster by folder, collapse into bubbles sized by note count, and a path finder lights up the shortest chain of links between any two notes.

![[site-explore.png]]

Both views in full: [[Graph and Explore]].

## Writing: the browser editor

Editing is a **separate, opt-in surface** ([[Editing in the browser]]). It only exists when `edit` is configured, it lives on its own URLs behind its own login, and an anonymous visitor never sees a trace of it.

![[editor-live-preview.png]]

That is Split view: CodeMirror 6 on the left in Live Preview, the public page on the right, the Properties panel on top of both. Frontmatter is edited as properties, not as YAML.

![[editor-properties.png]]

Tables are edited as a grid — `Tab` between cells, a hover toolbar for rows and columns — and only the cell you touched changes in the file.

![[editor-table.png]]

`Ctrl+P` opens the command palette, `Ctrl+O` the quick switcher, `[[` suggests notes, headings and blocks, and `/` at the start of a line inserts callouts, tables and code blocks.

![[editor-command-palette.png]]

## What happens on save

`Ctrl+S` writes the `.md` file. That is the entire publish step: the public page, the search index and the navigation are correct on the next request. If the file changed underneath you — Obsidian on the desktop, a `git pull`, an agent — the save stops and asks instead of overwriting.

## Where to go next

- [[Quick start]] — running in two commands
- [[Your first site]] — point it at your own vault
- [[Editing in the browser]] — the editor in full
- [[Hermes plugin]] — let an agent write into the vault
- [[Feature status]] — what is done, partial and missing, stated honestly
