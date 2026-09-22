---
title: Editor API
tags: [websidian, internals, reference, api]
updated: 2026-09-23
order: 3
description: The JSON API under /_api
---
# Editor API

Under `/<site>/_api/`. JSON. Needs an editor session cookie or `Authorization: Bearer <edit.token>`. Writes need an `X-Requested-With` header (CSRF guard).

| Method and path | Body / query | Returns |
|---|---|---|
| `GET note?rel=a/b.md` | | `{ rel, exists, text, stamp, title, hidden, url }` (404 when new) |
| `PUT note` | `{ rel, text, stamp }` — `stamp: null` creates | `{ ok, stamp, created, url, editUrl, title }`; `409` when the file changed since `stamp` |
| `DELETE note?rel=` | | Moves to `.trash`; `{ ok, trashed }` |
| `POST preview` | `{ rel, text }` | `{ html, headings, data, title }` — renders unsaved text |
| `GET notes` | | `[{ rel, title, folder, hidden, url, editUrl, aliases, mtime }]` |
| `GET files` | | Attachments `[{ rel, name, ext, folder, url, size }]` |
| `GET tags` | | `[{ tag, count }]` |
| `GET properties` | | `[{ name, count, type, values }]` |
| `GET anchors?rel=` | | `{ headings: [{level, text, line}], blocks: [{id, text, line}] }` |
| `GET agents` | | `{ scope, skills, agents: [{ id, label, backend, model, modes, enforcesReview }] }` — only when `agents` is configured ([[Agents in the editor]]) |
| `POST agents/<id>/turn` | `{ rel, message, mode, selection?, dirty? }` | `202 { turn, agent, mode }`; `409` while that conversation (or another Edit turn in the vault) is running |
| `GET agent-turns/<turn>` | | `{ state: running\|done\|failed, elapsedMs }`, then `{ text, changes: [{ rel, status, diff, protected, unexpected, revertible }], sessionId, resumed, usage, ms }` or `{ error }` |
| `POST agent-turns/<turn>/cancel` | | Kills the agent |
| `POST agent-turns/<turn>/revert` | `{ rel }` | `{ ok, rel, status: restored\|trashed }`; `409` when the file changed again since the turn |
| `GET` / `DELETE agents/<id>/session?rel=` | | The conversation (`{ sessionId, turns, history }`) / forget it |
| `POST agents/render` | `{ rel, texts: [] }` | `{ html: [] }` — agent replies rendered with the vault's links and **no raw HTML** |

Rules: only `.md` files inside the vault; no dot-folders or `exclude`d paths; 2 MB limit; writes are atomic (temp file + rename).

## Example
```bash
curl -X PUT http://127.0.0.1:8080/notes/_api/note \
  -H "Authorization: Bearer $TOKEN" -H "X-Requested-With: cli" -H "Content-Type: application/json" \
  -d '{"rel":"inbox/Idea.md","text":"# Idea\n","stamp":null}'
```
