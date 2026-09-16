---
title: Work log
tags: [websidian, log]
aliases: [Changelog]
updated: 2026-09-16
order: 5
description: What changed each session, newest first
---
# Work log

Newest first. One entry per working session: what changed, what was learned, what is next.

## 2026-09-16 — a real installer for the Hermes plugin (from a macOS install report)
- **Why**: a Hermes agent installed the plugin on a native macOS profile (Hermes `v0.21.0`, Node `v22.23.1`) and reported back what the documented path did not cover. Everything it verified — 71 plugin tests, the site tests, `/_health` with 69 notes, CSP + `nosniff` on untrusted pages — held; the gaps were all in *how you get there*.
- **`deploy/install-local.sh` and `deploy/install-local.ps1`** install into a native Hermes profile: plugin → `<profile>/plugins/websidian`, runtime → `<profile>/plugin-data/websidian/app`, `npm --prefix <app_dir> ci --omit=dev --ignore-scripts`, a layout check, then a real boot of the installed server against a throw-away vault and a `GET /_health`. Both were run end to end here (Git Bash and PowerShell); both refuse to restart the dashboard or the gateway and never touch `config.yaml`.
- **The bug the report caught**: `npm ci` run from your checkout instead of `app_dir` succeeds and puts `node_modules` in the wrong place. The plugin then reports as installed while the dashboard tab 502s, because the supervisor runs `node <app_dir>/src/server.js`. `--prefix` is the whole fix; it is now in the scripts, the manual recipe and the test.
- **`test/hermes-install.test.js`** builds the installed layout in a temp folder (copy `src`, `public`, `package.json`, `package-lock.json`; link `node_modules`), boots it, and asserts `/_health`, the untrusted CSP + `nosniff`, and that **every** `/_static` and `/_vendor` asset the page references answers 200 — a missing `public/` or `node_modules/` in a copy now fails CI instead of a user's dashboard. 177/177 tests pass.
- **`npm audit --omit=dev` is clean again**: `qs` moved to `~6.16.0` through `express`, closing [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) and [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g). Lockfile-only change; the whole suite was re-run after it.
- **Plugin README rewritten around four install routes** (native script, PowerShell, container, by hand) with an 8-row acceptance checklist, "enable ≠ activate" (dashboard restart for the tab, gateway restart for chat links), and an explicit *decline `--allow-tool-override`* — the plugin only needs its three hooks and `websidian_links`.
- **Learned**: PowerShell strips the quotes when it passes an argument to a native `.exe`, so `node -p 'process.versions.node.split(".")[0]'` becomes a syntax error inside node. Parse `node -v` in PowerShell instead.
- **Learned**: in Git Bash, a config written with `/tmp/...` paths is read by a *Windows* node as `C:\tmp\...`. The smoke test converts with `cygpath -m` first, like `install-into-container.sh` already did for `docker cp`.
- **Still open**: `hermes plugins install <repo>` cannot take this repository — the manifest is nested at `integrations/hermes/websidian/plugin.yaml` ([[Improvements backlog]], [[Known issues]]). And whether agent-facing vaults should default to `edit: false` instead of `true` is an open question for the user.
- **Next**: navigation order and folder notes ([[Improvements backlog]] #1) is still the top item.

## 2026-09-16 — navigation order, folder notes, generated section pages
Phase 1 #6 in [[Roadmap]], and the reason the docs did not read in order.

- **`order:` in frontmatter** decides the sidebar and the Previous / Next pager. Notes with it come first ascending; notes without keep the old natural sort; a non-numeric value is ignored rather than guessed at (`compareOrder` in `src/vault.js`).
- **Folder notes**: `Guide/Guide.md` (or `Guide/index.md`) becomes the folder's page. It is served at the *folder's* URL, names and orders the folder in the sidebar, is not listed inside itself, and its own longer path `301`s to the folder URL — `noteUrl()` returns the folder URL for it, so links, backlinks and the sitemap all follow without special cases.
- **Generated section pages** (`src/sections.js`): a folder note gets an "In this section" list appended; a folder *without* one gets the whole page generated instead of a 404. Both list notes and subfolders in navigation order with each note's `description:` and `updated:`. `sectionIndex: false` turns it off per site.
- **These docs are the first user**: every note has `order:` and `description:`, and each of the four sections has a folder note. [[Quick start]] is now first in the Guide instead of [[Configuration]].
- New note [[Navigation and sections]]; `test/sections.test.js` adds 16 tests (`npm test` 179/179).
- **Fixed while testing**: a folder note offered "Previous: Feature status" from the section page that *contains* it — a folder note now has no pager, and folder notes are skipped when finding siblings.
- **Fixed while testing**: `updated: 2026-09-16` is parsed by js-yaml into a `Date`, so a `typeof v !== 'object'` guard silently dropped every date from the generated lists.
- **Learned**: `/_static` is cache-busted by `LAYOUT_VERSION`, so CSS changes are invisible until it is bumped. Bumped to 13.
- **Next**: [[Hermes plugin]] — close the open guard items and document it with screenshots.

## 2026-09-16 — documentation overhaul and the first screenshots
- **The vault had no images at all.** 11 screenshots now live in `docs/attachments/`, every one captured from `npm run demo` with Playwright at 1440×900 — reading view, syntax, RTL, search, graph, explore, editor login, Live Preview, properties, table grid, command palette.
- **New notes**: [[Tour]] (screenshot-led showcase, the answer to "what does it look like"), [[Your first site]] (point it at your own vault, end to end), [[Graph and Explore]] (two features that existed only as 400-word README table cells), [[Scope and positioning]] (what "full Obsidian" can honestly mean, the CMS half, why this over Obsidian Publish / MkDocs / Notion).
- **[[Start Here]] rewritten** as four reader paths — run it, write in it, connect an agent, work on the code — instead of one flat link list.
- **`ROADMAP.md` was 13 KB of thinking the website could not serve.** Moved into the vault ([[Roadmap]] + [[Scope and positioning]]); the root file is now a pointer. The target-architecture diagram went to [[Architecture]].
- **`test/docs-links.test.js`** enforces the `CLAUDE.md` rule automatically: every `[[wikilink]]` resolves, every embedded screenshot exists, every note has `title`/`tags`/`updated`. It strips code spans first, because notes about wikilink syntax write `[[Note]]` as an example.
- README: hero screenshot, editor screenshot, both graph views; the two giant graph cells replaced by pointers to [[Graph and Explore]].
- **Learned**: a note cannot embed a screenshot of itself — the first hero shot came out containing a picture of itself. [[Architecture]] is the hero now, and its mermaid diagram shows more anyway.
- **Learned**: CodeMirror only renders visible lines, so screenshotting a table widget means scrolling `.cm-scroller` first, not the window.
- **Found**: no `/favicon.ico` unless a site sets `brand.favicon` — a 404 in every console ([[Known issues]]).
- **Next**: navigation order and folder notes ([[Improvements backlog]] #1) — the sidebar is alphabetical, which is why these docs do not read in order. The docs are the first real user of that feature.

## 2026-09-16 — published to GitHub
- **The project is a git repository** and is published at <https://github.com/satabd/Websidian> (private). First commit is the whole tree as it stood, `npm test` 156/156.
- **The real config is no longer part of the project.** `websidian.config.json` and `md2html.config.json` are both in `.gitignore` — they hold vault paths, passwords, tokens and webhook secrets, and the local one named a client vault outside this repo.
- **`websidian.config.example.json` ships instead**, and it serves `docs/`: `npm install` → `cp websidian.config.example.json websidian.config.json` → `npm start` and a fresh clone reads this documentation through Websidian itself. Checked by booting it: 22 notes, `/websidian/` returns 200 — [[Quick start]], [[Configuration]].
- `__pycache__/` and `*.pyc` ignored too (the Hermes plugin's Python tests leave them).
- README's Quick start and config example are generic now; no local paths or client names left in it.
- **Learned**: relative `root` in a config resolves against the *config file's* folder, not the working directory — a copy of the example elsewhere cannot find `docs/`.
- **Next**: a worktree per Claude session now that there is a repo ([[Improvements backlog]]); git commit per save is still the top feature gap ([[Decisions]]).

## 2026-09-13
- **Created this docs vault** (`docs/`) as the living reference; served by `npm run demo` at `/websidian/`. Rule for future sessions in `CLAUDE.md`: update the docs with every change.
- **Agent integration** (session `md2html-fd`, browser-checked, `npm test` 142/142) — [[Agent memory and second brain]]:
  - `untrusted` site mode: no raw HTML, CSP with nonces, attachment allowlist, strict mermaid, CSS snippets off by default (`src/untrusted.js`, `test/untrusted.test.js`).
  - `edit.protect` confirmation for agent instruction files, `edit.memoryLimits` warnings, `429` on failed basic-auth sign-ins, refusal to write through symlinks/junctions leaving the vault (`test/editor-guards.test.js`).
  - Hermes plugin `integrations/hermes/websidian/` built: write guard (instruction-file approval, active HTML block), view/edit links, `/brain`, skill; 54 Python tests; not yet run in a real Hermes — [[Hermes plugin]]. Node suite 143/143.
  - Found: mermaid may not render in Live Preview when scrolled to (unconfirmed); sign-in lock-out tradeoff — [[Known issues]].
- **Hermes plugin installed in `hermes01`** (Hermes v0.20.6, config backed up): 54 plugin tests OK in the container, 18/18 integration tests through Hermes hooks, one real agent session — clean note written with links, active HTML and `SKILL.md` writes refused. Test vault only; gateway not restarted — [[Hermes plugin#Installation in hermes01]].
- **`proxyAuth`**: sign-in through a trusted reverse proxy, for the Hermes dashboard tab (in progress). `src/proxyauth.js`, 11 tests, `npm test` 154/154; checked over HTTP under basePath `/api/plugins/websidian/w`, where a latent bug in the editor's `/_` link check was fixed. Not browser-tested yet — [[Configuration#Behind a trusted proxy]].
- **Hermes dashboard tab deployed** in `hermes01`: Websidian inside the Hermes dashboard, signed in through `proxyAuth`; real vaults Second Brain (206), memories (2), skills (1,023) as untrusted, editable sites (the user's choice; the user set the config). Dashboard restarted, gateway not. Browser-tested in the user's Chrome: rendering, CSP, memory deep link into the editor with the protected banner, skills search and graph — [[Hermes plugin#Dashboard tab]].
- **Fix**: under a dot-folder (`~/.hermes`) Express refused the editor modules and attachments (`dotfiles: deny` checks the whole path), so the editor fell back to the plain text box. Now only the relative path is checked; `test/dotpath.test.js`; `npm test` 156/156. Lesson added to [[Testing]].
- Coordination: that session builds, this one owns `docs/`.

## 2026-09-11 — editor, second pass (after feedback)
Feedback: *"tables, properties, clicking on some link opening the links instead of editing it, you didn't do good work."* Also: RTL editing shown left to right.
- **Tables** as an editable grid (Tab/Enter navigation, toolbar, minimal edits).
- **Properties panel** for frontmatter (types, pills, add/rename/remove, YAML toggle, `types.json`).
- **Links**: plain click edits, `Ctrl`+click follows.
- **RTL**: direction per line, cell and field.
- Fixed: clicks below block widgets landed on the wrong line (margins vs height map); words broke mid-word in table cells; callout icon touched the title; cursor now starts below the frontmatter.
- 7 new tests; 123 passing. Tested on a copy of the real OdooHMS vault with real mouse and keyboard.
- **Lesson**: test on real content, not only a demo note — [[Testing]].

## 2026-09-11 — editor, first pass
- CodeMirror 6 editor with Obsidian Markdown parsing, Live Preview, Obsidian class names, hotkeys, suggestions, slash commands, quick switcher, command palette, status bar, `app.json` settings.
- CodeMirror served from `node_modules` through an import map (no build).
- New API routes: files, tags, properties, anchors.
- `npm run demo` practice vault.
- Confirmed decisions: Obsidian DOM, git per save, one process — [[Decisions]].
- Investigated Hermes and OpenClaw storage — [[Agent memory and second brain]].

## Before 2026-09-11
Viewer, caching, search, graph and Explore views, Bases, embed mode, git webhook, first textarea editor with login, IP gate and conflicts.
