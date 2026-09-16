---
title: Testing
tags: [websidian, internals]
updated: 2026-09-16
order: 4
description: Running and extending the suite
---
# Testing

```bash
npm test
```
Node's built-in test runner: 221 tests on 2026-09-16 (156 on 2026-09-13, 123 on 2026-09-11).

Hermes plugin: `cd integrations/hermes/websidian` then `python -m unittest discover` — 98 tests on 2026-09-16 (71 before the version stamps and the second skill) ([[Hermes plugin]]).

| File | Covers |
|---|---|
| `test/render.test.js`, `features.test.js` | Every Obsidian construct on the site |
| `test/excalidraw.test.js` | Excalidraw: the plugin's file format, the safe scene, embed markup, drawing pages, the JSON route, `untrusted` and `excalidraw: "image"` sites, the editor preview |
| `test/bases.test.js` | Bases expressions and tables |
| `test/graph.test.js`, `graph-ui.test.js` | Graph data and layout |
| `test/vault.test.js` | Index and link resolution |
| `test/cache.test.js` | Both cache layers |
| `test/hardening.test.js` | Auth, rate limits, SEO, webhook signatures, search |
| `test/untrusted.test.js` | `untrusted` sites: no raw HTML, CSP, attachment allowlist, snippets default |
| `test/editor-guards.test.js` | `edit.protect`, memory limits, sign-in 429, symlink/junction refusal |
| `test/proxy-auth.test.js` | `proxyAuth`: secret, address, user name cleaning, editor and site auth, denied fallback |
| `test/dotpath.test.js` | Install and vault under a dot-folder (`~/.hermes`): editor modules and attachments still served |
| `test/editor.test.js` | Editor login, gates, API, import map, module serving, settings |
| `test/cm-editor.test.js` | Editor modules in Node: syntax, link resolution, commands, suggestions, table and properties models |
| `test/server.test.js`, `server-ops.test.js` | The real server over HTTP |
| `test/hermes-install.test.js` | The *installed* layout (a copy, as `deploy/install-local.*` makes it): `/_health`, untrusted CSP + `nosniff`, every `/_static` and `/_vendor` asset resolving |
| `test/docs-links.test.js` | This vault: every `[[wikilink]]` and embed resolves, every note has `title`/`tags`/`updated` |

## Manual checks in a browser
Unit tests do not cover clicking and typing in widgets. Before calling an editor change done, check on a **copy of a real vault** (not only the demo), with real mouse and keyboard input:
- [ ] long table with bold first column: click, type, `Tab`, `Esc`
- [ ] Properties: change text, add and remove a tag
- [ ] plain click on a link edits it; `Ctrl`+click follows
- [ ] an Arabic note: lines run right to left
- [ ] an Arabic note **without** `lang:` (as an agent writes it): the whole page is right to left, an English line inside it is not
- [ ] `[[` suggestions, `Ctrl+O`, `Ctrl+P`
- [ ] click the line just below a table or the properties (lands on that line)
- [ ] if it will be installed under a dot-folder (`~/.hermes`), test from such a path too

> [!tip] Lesson from 2026-09-11
> The first editor version passed its tests on a toy note and failed on a real client vault (raw tables, raw YAML, clicks following links). Always test with real content.
