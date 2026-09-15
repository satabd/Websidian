---
title: Work log
tags: [websidian, log]
aliases: [Changelog]
updated: 2026-09-16
---
# Work log

Newest first. One entry per working session: what changed, what was learned, what is next.

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
