---
title: Decisions
tags: [websidian, internals, decisions]
updated: 2026-09-23
order: 5
description: The choices we made, and why
---
# Decisions

| Date | Decision | Why |
|---|---|---|
| early | **Dynamic server, not a static generator** | Changes are live on save; no rebuilds; drafts and auth are trivial |
| early | **Public site and editor are separate surfaces** | The same server is a public website and a private team editor; editor URLs do not exist unless configured |
| 2026-09-11 | **Emit Obsidian's DOM and class names** | Obsidian themes and CSS snippets work unchanged; decide before more custom CSS accumulates |
| 2026-09-11 | ~~**Git is the history engine** — one commit per save, authored by the editor~~ | Reversed 2026-09-23, see below |
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
| 2026-09-20 | **A guard that cannot simulate a write refuses on the strict reading** | When a multi-edit call cannot be replayed exactly (an `oldText` missing or already consumed), the edits are scanned joined *and* glued together rather than one by one. It can refuse a harmless edit; the alternative let a `<script>` through in two halves — [[OpenClaw plugin]] |
| 2026-09-20 | **Derived indexes are memoised per vault scan (`indexGen`), never per request** | The graph ETag has to notice a frontmatter-only edit, which moves neither the file-list nor the link hash. Keying on a counter that every `scan()` bumps keeps that property and costs one rebuild per change instead of one per request — [[Graph and Explore]] |
| 2026-09-21 | **The Memory surface is a sibling route (`/plugins/websidian-memory`), not a child of the stand-alone one** | OpenClaw refuses two plugin routes whose prefixes overlap ("http route overlap rejected"), and the stand-alone prefix route claims everything below it. Moving the stand-alone pages instead would have broken a URL people already use — [[OpenClaw plugin#The Memory page]] |
| 2026-09-21 | **A Gateway-authenticated request mints the plugin's existing session cookie, rather than adding a second credential** | OpenClaw has already said who the operator is; minting the same signed cookie a successful sign-in mints lets the notes open through the existing, tested proxy with no second sign-in and no new code path. It is the one-login decision of 2026-09-16 applied to OpenClaw's login |
| 2026-09-21 | **Shell mode is a third layout mode, not a second product** | An application embedding Websidian wants the reading experience minus the chrome it already draws. Making that a mode of the same page keeps one renderer, one set of links and one set of tests; `?embed=1` stays what it was — [[Embedding in your website]] |
| 2026-09-23 | **The Memory page draws its own chrome and frames only the reading** | The first version framed Websidian with its own toolbar, search and tree inside OpenClaw's page — three layers of navigation, the "browser inside a browser" the user did not want. Search, previews and the timeline are native now; the frame is a reading pane (`chrome=none`) or the tree (`chrome=tree`) — [[OpenClaw plugin#The Memory page]] |
| 2026-09-23 | **"Today" is the reader's today** | Day labels are worked out in the browser, not on the Gateway, which is often another machine in UTC; at 01:24 local the Gateway's "today" was yesterday |
| 2026-09-23 | **The open view lives in the tab, not in the URL** | OpenClaw highlights a sidebar entry only when the page parameters match exactly; losing the highlight on reload cost more than a shareable URL gained |
| 2026-09-21 | **A date in `title:` or `updated:` prints as a day** | YAML turns an unquoted `2026-09-21` into a Date, and `String(Date)` is "Sun Sep 21 2026 03:00:00 GMT+0300 (…)" — which is what an agent's daily memory note showed in the sidebar and the graph until it was seen in the Memory page |
| 2026-09-17 | **No archify-style authored diagrams for the vault graph**; Explore takes its viewer ideas (reach, guided views) instead | archify places every node by hand and refuses auto-layout; a vault has no author placing hundreds of notes — [[Graph and Explore]] |
| 2026-09-17 | **Named views live in note frontmatter (`views:`), not in the config**, and the active view or reach lives in the URL, not localStorage | Authors own them and they travel with the vault; hidden notes drop out by themselves; a `?view=` link can be shared |
| 2026-09-23 | **Websidian does not run git on saves: no commit per save, no automatic push or pull back to a remote** (confirmed by the user; reverses 2026-09-11) | Two-way sync brings conflicts, deploy keys and a failing `git pull --ff-only` whenever the server has uncommitted edits — more complexity than the team wants to carry. Saves stay plain file writes; the team commits, pushes and pulls itself. The existing pull webhook stays as an optional tool — [[Deploying]] |
| 2026-09-16 | **Screenshots are captured from the running app, never mocked** | `test/docs-links.test.js` fails if a note embeds a screenshot that does not exist, so they cannot quietly rot |
| 2026-09-16 | **Section lists are generated, never written by hand** | A hand-kept list of what is in a folder is wrong the day after it is written |
| 2026-09-16 | **A folder note lives at the folder's URL**, and its own path redirects there | One canonical URL per page; `/site/Guide/` reads better than `/site/Guide/Guide` |
| 2026-09-16 | **Hermes vaults are read-only in the browser by default** (`vaults[].edit` defaults to `false`) | A vault the agent writes to is a vault every dashboard user could rewrite; editing is opt-in per vault, like `untrusted` is opt-out |
| 2026-09-16 | **Dashboard authentication is never bypassed to make the Websidian tab work** | The plugin's routes live under `/api/plugins/`, behind the dashboard's auth gate. An ungated local dashboard renders `/websidian` but answers `401` on those routes — the fix is to gate the dashboard (basic auth on a LAN/VPN, OAuth on the internet), never to weaken the gate |
| 2026-09-16 | **Excalidraw drawings are shown by the real Excalidraw, pinned to 0.17.6 and served from `node_modules`** | 0.18 ships only ES modules with bare imports of React and a dozen packages, which needs a bundler; 0.17.6 is the last UMD build, so "no build step" holds. Drawings are parsed on the server into a small safe JSON (links resolved, iframes stripped on `untrusted` sites); the 1.2 MB viewer loads only on pages with a drawing |
| 2026-09-16 | **Drawings have pages but stay out of navigation, search and graph** | A drawing is a picture, not a note: `[[Sketch.excalidraw]]` and the embed's *Open* button need a URL, the sidebar does not need forty "Drawing 2026-…" entries |
| 2026-09-16 | **Writing help runs through a CLI the operator is signed in to, not an API key** (`claude-cli` default, `hermes-cli`, `api` kept as the alternative) | A subscription is already paid for; API tokens are not. The prompt still never comes from the browser |
| 2026-09-16 | **`--bare` is off by default for the Claude CLI** | Under `--bare` Claude Code reads only an API key and never the OAuth sign-in — the one thing the backend exists to use |
| 2026-09-16 | **Dashboard deep links carry `note64=` (base64url) when the name needs escaping**; plain `note=` stays for plain names and old links | The dashboard decodes `next` once after login, so any `%xx` in a note name is lost; base64url is immune to an extra decode |
| 2026-09-16 | **One dashboard login for every plugin — Websidian never asks for a second** (confirmed by the user) | A per-plugin login is a credential nobody wants to manage, and on a shared origin the weakest login wins anyway. Websidian takes the dashboard's identity through `proxyAuth`; its generated tokens are machine-only. Gate the dashboard (basic password over Tailscale/LAN, OAuth if internet-facing) and everything inherits it |
| 2026-09-16 | **Installers never restart the dashboard or the gateway** | A restart interrupts live chats and agents; the installer says which service needs one and why, and leaves the timing to the operator |
