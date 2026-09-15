# Websidian — roadmap and thinking

> Obsidian on the desktop, Websidian on the web, **one vault**.
> Websidian serves the vault as a website (public, fast, cached) and edits it in the
> browser (private, gated), reading the same `.obsidian/` settings so the two never disagree.
> The files are the database. Git is the history. There is no build step.

This document is the thinking behind where md2html goes next, now that it has a
viewer and a first editor. It is opinionated; every recommendation says why.

---

## 1. What "full Obsidian functionality" can honestly mean

Obsidian is three things. They are worth separating because they cost differently.

| Layer | What it is | Reachable on the web? | Where we are |
|---|---|---|---|
| **Reading view** | Everything Obsidian renders: wikilinks, embeds, callouts, math, mermaid, footnotes, block refs, properties, bases, canvas, excalidraw | Yes, essentially 100 % | ~85 % (canvas, tag pages, embedded search, slides missing) |
| **Vault features** | Search with operators, graph, backlinks, outgoing links, tags, properties, templates, daily notes, bookmarks, file explorer, command palette, quick switcher | Yes for the core set | ~50 % (search, graph, backlinks, bases done) |
| **Editor** | Live-preview editing, properties panel, autocomplete, slash commands, paste images, drag/drop, split panes, hotkeys | "Good enough" is reachable; pixel-parity is not the goal | ~55 % (CodeMirror 6 with Live Preview/Source, Obsidian syntax, hotkeys, suggestions, slash commands, quick switcher, command palette, app.json settings; missing: properties panel, tables, note transclusion, paste/drop upload, panes) |
| **Community plugins** | Arbitrary JavaScript running inside Electron | **No.** Never promise this | — |

So "full Obsidian" for Websidian means: **100 % reading view, the core vault features,
an editor an Obsidian user feels at home in, and built-in equivalents of what the
top plugins *output*** (Dataview tables, Excalidraw drawings, Kanban boards,
Templater basics, Admonitions = callouts). Plugin *compatibility* is replaced by a small
Websidian plugin API of our own.

## 2. The CMS half

A CMS needs five things a notes app does not: **workflow, history, media, structure,
and people.** Obsidian's frontmatter already gives us the data model for all of them,
which is the whole trick: the CMS database is YAML inside the notes, so Obsidian on the
desktop can read and write it too.

| Need | How Websidian does it | Frontmatter it reads |
|---|---|---|
| Workflow | draft → review → published; scheduled publish/unpublish; "unpublished changes" badge; preview drafts via signed share link | `status`, `publish`, `publishAt`, `unpublishAt` |
| History | every save is a git commit authored by the editor; history panel with diff and restore; the existing git webhook keeps servers in sync | — |
| Media | paste/drop images and files into the note; upload goes to the vault's attachment folder from `.obsidian/app.json`; media browser | — |
| Structure | navigation order, folder notes as section index pages, redirects when a note is renamed, custom slugs | `order`, `slug`, `redirect_from`, `aliases` |
| People | named accounts with roles (viewer / editor / admin), per-folder rights later; audit log = git log | — |

Everything above is a file write plus a rescan. Nothing needs a database.

## 3. Strategic decisions

> **Confirmed 2026-09-11:** A (Obsidian DOM and class names), C (git as the history engine)
> and E (one Node process, no database, no build step). The CodeMirror editor already follows
> A and E: it emits Obsidian's editor classes and loads CodeMirror from `node_modules` through
> an import map instead of a bundle.

**A. Emit Obsidian's DOM and class names.** `.markdown-preview-view`, `.callout[data-callout]`,
`.internal-link`, `.tag`, `.math`, `.mod-*`… If our HTML matches Obsidian's reading view,
**Obsidian themes and CSS snippets work unchanged**. That is the single biggest lever for
"it looks like Obsidian", and it lets a vault owner pick any of the ~300 community themes
for the public site. Do it *early*, before more CSS accumulates on our own class names.
Keep our current branded look as one theme among others. → Phase 3, but decide now.

**B. CodeMirror 6 for the editor.** It is what Obsidian itself uses. Start with Markdown
syntax highlighting behind the existing live preview, then grow into live-preview
decorations (hidden syntax markers, rendered links) the way Obsidian does. The textarea
stays as the fallback. → Phase 2.

**C. Git as the history engine.** Every save: `git commit --author "<editor>"`. It gives
audit, diff, rollback, and blame for free, and the webhook that already exists pulls
changes to other servers. If the vault is not a git repo, Websidian initialises one
inside the vault folder, or keeps a lightweight versions folder as a fallback. → Phase 1.

**D. Frontmatter is the CMS schema.** No hidden state in a database. Websidian *reads*
Obsidian's property types from `.obsidian/types.json` so the properties panel shows
dates as date pickers, lists as chips, checkboxes as toggles. → Phase 1.

**E. One Node process, no dependencies to operate.** Index in memory, render cache on disk,
optional git. This is why deploying is `node src/server.js`. Keep it that way; add
Redis or Postgres only if a multi-server deployment ever needs shared sessions.

**F. Public and private stay separate surfaces.** Already true: `/_edit` and `/_api` are
opt-in and invisible to anonymous visitors. Every new feature keeps that line.

## 4. Phases

### Phase 0 — Rename to Websidian (now)
- `package.json`, README title, log line, `WEBSIDIAN_CONFIG` env var (old name kept as alias) — done.
- Still to do: `websidian.config.json` default filename (fallback to `md2html.config.json`), cookie prefix `websidian_`, `window.WEBSIDIAN` client global (alias kept), Docker image name, repository name, domain. None of these are urgent; do them in one sweep with a compatibility note.

### Phase 1 — CMS essentials (make the editor something you use every day)
1. **Git commit per save**, history panel (list, diff, restore). Author = signed-in editor.
2. **Attachments**: paste and drag-drop images into the editor → upload to the attachment folder from `.obsidian/app.json` → `![[name.png]]` inserted; media browser to reuse existing files.
3. **Rename / move** with wikilink rewriting across the vault (Obsidian's behaviour) and automatic 301 from the old URL (`redirect_from` written to frontmatter).
4. **Properties panel**: form above the editor for `title`, `status`, `tags`, `publish`, `date`, `aliases`, `lang`; types from `.obsidian/types.json`; raw YAML still editable.
5. **Publishing states and scheduling**: `status`/`publish` drive visibility (already), plus `publishAt`/`unpublishAt`, an "unpublished changes" badge on the public page for editors, and a signed preview link for drafts to show a reviewer.
6. **Navigation control**: `order:` in frontmatter, folder notes (`Folder/Folder.md` becomes the folder's page), collapsed/expanded defaults.
7. **Roles**: `viewer` (sees drafts, cannot save), `editor`, `admin` (config, purge, users). Per-folder rights later.
8. **Live reload for editors** via server-sent events when the vault changes on disk (Obsidian on the desktop just saved the note you are reading).
9. **Slash commands** in the textarea for callouts, tables, code fences, embeds, today's date.

### Phase 2 — An editor an Obsidian user feels at home in
1. ✅ CodeMirror 6: Obsidian Markdown parsed as syntax nodes, Obsidian class names, Obsidian hotkeys, bracket/Markdown auto-pairing and wrap-selection, list continuation, search/replace, folding, `.obsidian/app.json` settings, quick switcher (`Ctrl+O`), command palette (`Ctrl+P`), slash commands, status bar. Still to do: table editing helpers.
2. ✅ Autocomplete for `[[notes]]` (aliases, attachments, fuzzy), `#tags`, `[[note#heading]]`, `[[note#^block]]`, properties and their values.
3. ✅ Live-preview decorations (syntax hides away from the cursor, links, checkboxes, callouts, images/embeds, math, mermaid rendered). Tables edited as grids and the Properties panel are done (2026-09-11). Still to do: note transclusion (`![[note]]` renders the note, not a chip), page preview on hover, table cell formatting beyond bold/italic.
4. Templates: `Templates/` folder from `.obsidian/templates.json`, `{{title}}`, `{{date}}`, `{{time}}`; new-note location and default folder from `app.json`; daily notes from `daily-notes.json`.
5. Panels: outline, backlinks, outgoing links, local graph, properties — as collapsible side panels, not tabs, so it works on a laptop screen.
6. Split view of two notes (for the English/Arabic mirror), with "open translation" from the language switch.
7. Mobile: the editor already collapses to one pane; make the toolbar thumb-friendly.

### Phase 3 — Reading view completeness and themes
1. Obsidian DOM/class names (decision A) and a ported Obsidian default theme; load `.obsidian/themes/<name>/theme.css` when `appearance.json` selects one; `cssTheme` per site override.
2. Tag pages (`/tags/x`), tag pane, nested tags.
3. Search operators: `tag:`, `path:`, `file:`, `[property:value]`, `line:`, quoted phrases, regex; results grouped by note with context, like Obsidian.
4. `.canvas` files rendered as pan/zoom HTML (JSON Canvas spec is open).
5. Embedded search blocks (```` ```query ```` ), embedded PDF page ranges, `![[note#^block]]` is done, `![[image.png|left]]` alignment classes.
6. Dataview subset: `TABLE`, `LIST`, `TASK` over frontmatter and tasks, `FROM #tag / "folder"`, `WHERE`, `SORT`, `LIMIT`. No DataviewJS. Bases is the official successor and is already rendered; recommend Bases for new content.
7. Slides (`---` separated) as a presentation page. Kanban plugin boards rendered as columns.

### Phase 4 — Platform
1. **Plugin API**: server side (markdown-it plugin + routes + lifecycle hooks) and client side (editor extension). Ship the built-ins as plugins to prove the API.
2. **MCP server / REST for agents**: the JSON API is already there; expose it as an MCP server so Claude (or any agent) can read, search and edit the vault with the same permissions as a user.
3. Multi-vault workspaces with per-site themes and domains; i18n of the UI (Arabic first).
4. `websidian export`: crawl into a static folder for CDN-only hosting, with the same renderer.
5. Comments and review annotations for reviewers who should not edit.

## 5. Positioning

| Against | Websidian's answer |
|---|---|
| Obsidian Publish | Self-hosted, editable in the browser, drafts and scheduling, private folders, your branding, embeds in your own site, no per-vault fee |
| Docusaurus / MkDocs / Hugo | No build, no front-end toolchain, wikilinks and embeds native, edit from the browser, changes live in milliseconds |
| Notion / headless CMS | Files you own, Obsidian on the desktop, git history, works offline, nothing to migrate out of |

One-line pitch: **"Your Obsidian vault as a website you can edit from anywhere."**

## 6. Target architecture

```
                 ┌──────────────── one Node process ─────────────────┐
  Obsidian ──sync──▶ vault/ (files) ──watch──▶ Vault index ──▶ Renderer ──▶ Cache ──▶ Public site  /site/...
  git / Dropbox      .obsidian/ settings        (links,        (markdown-it   (mem +      Embeds      ?embed=1
                     .git/ history              backlinks,      + Obsidian     disk)      Search      /_search
                                                tags, props)    plugins)                  Graph       /_graph
                                                    ▲                                     Sitemap
                                                    │ write + commit
                                     Editor  /site/_edit  ◀── login, roles, IP gate
                                     API     /site/_api   ◀── sessions / bearer token ◀── agents (MCP)
```

## 7. What to do first (tomorrow)

1. **Git commit per save + history panel.** Cheapest, highest CMS value, and it makes every later feature safe to try because everything can be undone.
2. **Paste-to-upload images.** Without it, nobody writes real documentation in the browser.
3. **Rename with link rewriting + 301.** Without it, people avoid renaming and the vault rots.

Then the properties panel, and decide on the Obsidian DOM (decision A) before touching more CSS.

## 8. Open questions for you

1. **Look of the public site**: branded docs site (today) or "looks like Obsidian" with the user's theme? Decision A gives both; the default matters for the first impression.
2. **Is the server's vault a git checkout** (the OdooHMS `docs/` folder is)? Then commits per save are straightforward; pushing back to GitHub needs a deploy key, or the webhook stays pull-only.
3. **Who edits**: only you, or a team? Roles and per-folder rights only matter for a team.
4. **Arabic mirror**: should translation status be a first-class workflow (English changed → Arabic marked stale, side-by-side editing)?
5. **Hosting**: one server for many vaults (multi-tenant, needs isolation and quotas) or one deployment per vault (simple, current)?
