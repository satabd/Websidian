---
title: Editor API
tags: [websidian, internals, reference, api]
updated: 2026-09-13
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

Rules: only `.md` files inside the vault; no dot-folders or `exclude`d paths; 2 MB limit; writes are atomic (temp file + rename).

## Example
```bash
curl -X PUT http://127.0.0.1:8080/odoohms/_api/note \
  -H "Authorization: Bearer $TOKEN" -H "X-Requested-With: cli" -H "Content-Type: application/json" \
  -d '{"rel":"inbox/Idea.md","text":"# Idea\n","stamp":null}'
```
