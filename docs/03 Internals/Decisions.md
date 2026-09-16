---
title: Decisions
tags: [websidian, internals, decisions]
updated: 2026-09-16
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
