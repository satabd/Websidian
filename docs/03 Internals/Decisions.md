---
title: Decisions
tags: [websidian, internals, decisions]
updated: 2026-09-16
order: 5
description: The choices we made, and why
---
# Decisions

| Date | Decision | Why |
|---|---|---|
| early | **Dynamic server, not a static generator** | Changes are live on save; no rebuilds; drafts and auth are trivial |
| early | **Public site and editor are separate surfaces** | The same server is a public website and a private team editor; editor URLs do not exist unless configured |
| 2026-09-11 | **Emit Obsidian's DOM and class names** | Obsidian themes and CSS snippets work unchanged; decide before more custom CSS accumulates |
| 2026-09-11 | **Git is the history engine** — one commit per save, authored by the editor | Audit, diff, undo and sync for free (not built yet) |
| 2026-09-11 | **One Node process, no database, no build step** | Deploying stays `node src/server.js` |
| 2026-09-11 | **CodeMirror 6 for the editor**, loaded from `node_modules` via an import map | It is what Obsidian uses; the import map keeps "no build step" |
| 2026-09-11 | **Widgets edit the text, not a model** (tables, properties) | Undo, conflicts and diffs stay correct; the file stays Obsidian-compatible |
| 2026-09-11 | **Plain click edits a link, Ctrl+click follows** | Obsidian's behaviour; user feedback |
| 2026-09-11 | **Autosave off by default** | Every save publishes |
| 2026-09-13 | **Agent-written folders are `untrusted` sites** | Prompt-injected HTML in an agent note could act as the signed-in editor and rewrite the agent's instruction files |
| 2026-09-13 | **These docs live in an Obsidian vault in the repo** (`docs/`), updated while building | One reference that grows with the code |
| 2026-09-16 | **The real config is never committed**; `websidian.config.example.json` ships instead | It holds vault paths, passwords, tokens and webhook secrets |
| 2026-09-16 | **The shipped example config serves `docs/`** | A fresh clone runs `npm start` and reads the documentation through Websidian itself |
| 2026-09-16 | **Long-form planning lives in the vault, not in root Markdown files** | `ROADMAP.md` was 13 KB the website could not serve; it is now a pointer to [[Roadmap]] and [[Scope and positioning]] |
| 2026-09-16 | **Screenshots are captured from the running app, never mocked** | `test/docs-links.test.js` fails if a note embeds a screenshot that does not exist, so they cannot quietly rot |
| 2026-09-16 | **Section lists are generated, never written by hand** | A hand-kept list of what is in a folder is wrong the day after it is written |
| 2026-09-16 | **A folder note lives at the folder's URL**, and its own path redirects there | One canonical URL per page; `/site/Guide/` reads better than `/site/Guide/Guide` |
| 2026-09-16 | **Hermes vaults are read-only in the browser by default** (`vaults[].edit` defaults to `false`) | A vault the agent writes to is a vault every dashboard user could rewrite; editing is opt-in per vault, like `untrusted` is opt-out |
| 2026-09-16 | **Dashboard authentication is never bypassed to make the Websidian tab work** | The plugin's routes live under `/api/plugins/`, behind the dashboard's auth gate. An ungated local dashboard renders `/websidian` but answers `401` on those routes — the fix is to gate the dashboard (basic auth on a LAN/VPN, OAuth on the internet), never to weaken the gate |
| 2026-09-16 | **Installers never restart the dashboard or the gateway** | A restart interrupts live chats and agents; the installer says which service needs one and why, and leaves the timing to the operator |
