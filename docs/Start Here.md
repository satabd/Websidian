---
title: Start Here
tags: [websidian, moc]
aliases: [Home, Websidian docs]
updated: 2026-09-16
order: 1
views:
  - id: run-it
    label: I want to run it
    note: The four notes that take you from nothing to a deployed site, in order.
    focus: [Quick start, Your first site, Configuration, Deploying]
  - id: graph
    label: Graph and reach
    note: How the vault is drawn, and the data behind it.
    focus: [Tour, Graph and Explore, URLs and endpoints]
---
# Websidian

> [!abstract] In one sentence
> Your Obsidian vault as a website you can edit from anywhere: pages render from the `.md` files on request, and a browser editor built on CodeMirror 6 writes back to the same files.

![[site-reading-view.png]]

There is no build step and no publish step. You change a note — in Obsidian, in the browser editor, by `git pull`, by Dropbox sync — and the next visitor sees the new version. The files are the database; git is the history.

**New here? [[Tour]]** walks through every screen with screenshots.

## Pick your path

> [!tip]- I want to run it
> 1. [[Quick start]] — two commands, then a browser
> 2. [[Your first site]] — point it at your own vault
> 3. [[Configuration]] — every key, with examples
> 4. [[Deploying]] — a real host, HTTPS, git webhook

> [!tip]- I want to write in it
> 1. [[Editing in the browser]] — Live Preview, tables, properties, links
> 2. [[Editor hotkeys and commands]] — the cheat sheet
> 3. [[Writing help]] — Claude in the editor, if you want it
> 3. [[Publishing and visibility]] — drafts, hidden notes, who sees what
> 4. [[Obsidian syntax support]] — what renders, and what does not
> 5. [[Navigation and sections]] — decide the reading order
> 6. [[Graph and Explore]] — see how the vault connects

> [!tip]- I want to connect an agent
> 1. [[Hermes plugin]] — the plugin, the dashboard tab, the guard
> 2. [[Agent memory and second brain]] — the thinking behind it
> 3. [[Configuration]] → `untrusted` sites, for anything an agent writes

> [!tip]- I want to work on the code
> 1. [[Architecture]] — request flow, caching, which file does what
> 2. [[Editor internals]] — how the CodeMirror editor is put together
> 3. [[Editor API]] — the JSON API under `/_api`
> 4. [[Testing]] — how to run and extend the suite
> 5. [[Decisions]] — the choices we made, and why

## The honest state of things

This vault is written while the project is built, not afterwards. Three notes exist to keep it honest:

| Note | Answers |
|---|---|
| [[Feature status]] | What is done ✅, partial 🟡, in progress 🚧, missing ⬜ |
| [[Known issues]] | What will bite you, stated plainly |
| [[Work log]] | What changed in each session, newest first |

"Done" means tested in a browser on real content — not "the code exists".

## Where it goes

- [[Improvements backlog]] — suggestions ranked by value for effort
- [[Roadmap]] — the phases, and what "full Obsidian" can honestly mean
- [[Agent memory and second brain]] — vault as an agent's second brain

## Every note

| Guide | Reference | Internals | Planning |
|---|---|---|---|
| [[Quick start]] | [[Feature status]] | [[Architecture]] | [[Roadmap]] |
| [[Your first site]] | [[Obsidian syntax support]] | [[Editor internals]] | [[Improvements backlog]] |
| [[Editing in the browser]] | [[Known issues]] | [[Editor API]] | [[Agent memory and second brain]] |
| [[Editor hotkeys and commands]] | | [[Testing]] | [[Work log]] |
| [[Navigation and sections]] | | | [[Scope and positioning]] |
| [[Writing help]] | | | |
| [[Graph and Explore]] | | | |
| [[Publishing and visibility]] | | [[Decisions]] | |
| [[Configuration]] | | | |
| [[URLs and endpoints]] | | | |
| [[Embedding in your website]] | | | |
| [[Deploying]] | | | |
| [[Hermes plugin]] | | | |
