---
title: Quick start
tags: [websidian, guide]
updated: 2026-09-16
---
# Quick start

## 1. Install once
```bash
npm install
cp websidian.config.example.json websidian.config.json
```
Needs Node 20 or newer. Your own `websidian.config.json` is never committed
(`.gitignore`); the example it comes from serves this vault.

Prefer to look before you read? [[Tour]] is every screen with screenshots.

## 2. Pick what to run

| Command | Serves | Open | Sign in |
|---|---|---|---|
| `npm start` | the sites in your `websidian.config.json` (from the example: **these docs**) | `http://127.0.0.1:8080/websidian/` — editor at `/websidian/_edit/` | whatever you put in `edit.users` |
| `npm run demo` | the small practice vault in `demo/vault` and **these docs** | `http://127.0.0.1:8093/demo/` — docs at `/websidian/` | `demo` / `demo` |
| `npm test` | runs the test suite | — | — |

Keep the terminal open: closing it stops the server.

> [!warning] Use `127.0.0.1`, not `localhost`
> Browsers share cookies between ports on `localhost`. If two Websidian servers run on different ports, their login cookies clash and you get sent back to the login page. `127.0.0.1` keeps them apart.

## 3. After changing code
- Browser-side changes (`public/…`): reload with `Ctrl+Shift+R`.
- Server-side changes (`src/…`, config): stop the server (`Ctrl+C`) and start it again.

![[site-reading-view.png]]

## 4. First things to try
1. Open any page, click **✎ Edit** (only visible when signed in).
2. Click into a table cell and type; press `Tab` to move.
3. Change a tag in the **Properties** panel at the top.
4. `Ctrl+O` to jump to another note, `Ctrl+P` for every command.
5. `Ctrl+S` to save — the public page updates immediately.

Next: [[Your first site]] to point it at your own vault, or [[Editing in the browser]] for the editor in full.
