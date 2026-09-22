---
title: Testing
tags: [websidian, internals]
updated: 2026-09-23
order: 4
description: Running and extending the suite
---
# Testing

```bash
npm test
```
Node's built-in test runner: 348 tests on 2026-09-23 with the agent panel (330 before it the same day, 323 on 2026-09-21, 221 on 2026-09-16, 156 on 2026-09-13, 123 on 2026-09-11).

Hermes plugin: `cd integrations/hermes/websidian` then `python -m unittest discover` — 98 tests on 2026-09-16 (71 before the version stamps and the second skill) ([[Hermes plugin]]).

OpenClaw plugin: part of `npm test` (`integrations/openclaw/websidian/test/*.test.js`, 98 tests on 2026-09-23): the guard, links/sites/tracker, runtime config + secrets + proxy rules, the sign-in route over a real HTTP server (`handler.test.js`), the Memory model and its Gateway-authenticated route (`memory.test.js`), the browser Control UI plugin and the manifest rules the Gateway applies to its files (`control-ui.test.js`), and `register()` against a fake plugin API ([[OpenClaw plugin]]).

> [!tip] A real Gateway finds what a fake API cannot
> The first version of the Memory route was `/plugins/websidian/memory`, nested under the stand-alone prefix. Every unit test passed; OpenClaw refused it outright — *"http route overlap rejected"* — and registered one route instead of two. The fake plugin API in `plugin.test.js` has no opinion about route overlap, so nothing short of `openclaw plugins inspect websidian --runtime` against a real 2026.9.5 could have caught it. Install the release from npm into a scratch directory, point `plugins.load.paths` at the checkout, and run the Gateway in the foreground (`openclaw gateway --allow-unconfigured`; `gateway start` refuses a non-default state dir). OpenClaw 2026.9.5 needs Node 24.16+ or 26.1+ — it exits on Node 25 because `node:sqlite` truncates text at an embedded NUL there.

> [!warning] Three paths have no test at all
> The supervisor's spawn/restart cycle (only its two early-return failures are covered), an end-to-end request through the proxy (the header helpers are unit-tested, the streaming path is not), and the sign-in lockout after ten failures. Named by the 2026-09-20 audit — [[Improvements backlog|A14]].

> [!tip] Guard the adapters, not only the detector
> The 2026-09-17 differential run compared `find_active_content` with `findActiveContent` and nothing else, and both bypasses found on 2026-09-20 sat in the code *around* it: the multi-edit simulation and path resolution for a file that does not exist yet. Any new tool adapter needs its own bypass test — write one that fails before the fix. To compare the guard with the Python reference again, feed both `find_active_content` and `findActiveContent` the same inputs — the 2026-09-17 run over 140 inputs is described in the [[Work log]]. Live checks need a container: `docker run` `alpine/openclaw` with a state dir bind-mounted, the plugin under `plugins.load.paths`, then `openclaw plugins inspect websidian --runtime` and the HTTP probes listed in [[OpenClaw plugin#Is it really installed?]].

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
| `test/agents.test.js` | The agent panel: each backend's argv and parser against what the real CLIs print, per-agent config, skills, the context sent once, diffs, and the HTTP flow (session reuse, edit + revert, a write in Review, failures, safe rendering) against `test/fake-agent.js` — [[Agents in the editor]] |
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
