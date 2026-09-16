---
title: Configuration
tags: [websidian, guide, reference]
updated: 2026-09-16
order: 9
description: Every key, with examples
---
# Configuration

The server reads `websidian.config.json` if it exists, else `md2html.config.json`, or the file named by the `WEBSIDIAN_CONFIG` / `MD2HTML_CONFIG` environment variable. Paths in it are relative to the config file.

`websidian.config.example.json` in the repo is a working starting point — it serves
this vault (`docs/`). Copy it to `websidian.config.json` and edit. Both config
names are in `.gitignore`: the real one holds passwords, tokens and webhook secrets.

## Minimal example
```json
{
  "port": 8080,
  "sites": [
    { "slug": "notes", "title": "My notes", "root": "/path/to/your/vault", "home": "guide/Start Here" }
  ],
  "edit": { "users": { "you": "a-long-password" }, "allowFrom": ["127.0.0.1", "::1"], "secret": "a-random-string" }
}
```

## Per site (`sites[]`)

| Key | Meaning |
|---|---|
| `slug` | URL prefix: `/notes/…` |
| `root` | Vault folder |
| `home` | Note shown at `/slug/`; falls back to `index`, `home`, `readme`, `start here`, then the first note |
| `exclude` | Folders (by path) or extensions (`*.xlsx`). Dot-folders (`.obsidian`, `.git`, `.trash`) are always ignored |
| `excludeStatus` | e.g. `["draft"]`: notes with that frontmatter `status` are not served — see [[Publishing and visibility]] |
| `onlyPublished` | `true`: only notes with `publish: true` are served |
| `folderNames` | Sidebar names for folders, e.g. `{ "ar": "العربية" }`. Beats a folder note's own title |
| `sectionIndex` | `false` turns generated folder pages and the "In this section" list off — [[Navigation and sections]] |
| `codeLinks` | Rewrites links that leave the vault to your repository |
| `auth` | Protect viewing: `{ "users": {…} }` (browser login) and/or `{ "token": "…" }` (share links) |
| `snippets` | `.obsidian/snippets` CSS to include: `true` (the enabled ones; default), `"all"`, a list, or `false`. Default `false` on `untrusted` sites |
| `untrusted` | `true` for folders you did not write yourself (AI agents): no raw HTML, only images/PDF/audio/video attachments, strict Content-Security-Policy and mermaid, snippets off — [[Agent memory and second brain]] |
| `webhook` | `{ "secret", "command" }` enables the git webhook — see [[Deploying]] |
| `edit` | Editor settings for this site (overrides the top-level one); `false` turns editing off |
| `brand` | `name`, `logo`, `color`, `font`, `favicon`, `homeUrl`, `backLink`, `footer`, `headHtml`, `css` |

## Top level

| Key | Meaning |
|---|---|
| `port`, `host` | Also `PORT` / `HOST` env vars |
| `edit` | `{ users, allowFrom, token, sessionHours, secret, protect, memoryLimits }` — see [[Editing in the browser]] |
| `assist` | `{ apiKeyEnv, model, effort, maxChars, languages, actions }` — optional writing help in the editor, off unless the key is set ([[Writing help]]) |
| `edit.protect` | Glob patterns of agent instruction files whose save or delete needs confirmation, e.g. `["SKILL.md", "memories/*.md"]`. Default on `untrusted` sites: `SKILL.md`, `SOUL.md`, `AGENTS.md`, `MEMORY.md`, `USER.md`, `TOOLS.md`, `IDENTITY.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`. A name without `/` matches in any folder; `**` crosses folders |
| `edit.memoryLimits` | Character limits that trigger a warning on save, default `{ "MEMORY.md": 2200, "USER.md": 1375 }` (Hermes), for files in a `memories/` folder of an `untrusted` site |
| `basePath` | Mount under a prefix, e.g. `/docs` |
| `publicUrl` | Absolute URLs for sitemap / OpenGraph |
| `adminToken` | Enables `POST /_purge` |
| `cacheDir`, `diskCache`, `cache.maxEntries` | Render cache — see [[Architecture]] |
| `warm` | Pre-render every note at start |
| `rateLimit.search`, `rateLimit.login`, `rateLimit.assist` | Per minute per IP: searches; failed sign-ins (editor login and site `auth.users`); [[Writing help]] requests, default 20 |
| `trustProxy` | `true` behind nginx/Caddy |
| `proxyAuth` | Sign-in through a trusted reverse proxy — see [[#Behind a trusted proxy]] |
| `log` | `"text"`, `"json"` or `false` |

> [!tip] Always set `edit.secret`
> Without it, sessions are signed with a random key and everyone is logged out on every restart.

## Behind a trusted proxy
For running Websidian behind something that already has its own login, such as the Hermes dashboard ([[Hermes plugin#Dashboard tab]]).

```json
"proxyAuth": {
  "secret": "<random, 32 characters or more>",
  "secretHeader": "x-websidian-proxy-secret",
  "userHeader": "x-websidian-user",
  "allowFrom": ["127.0.0.1", "::1"]
}
```

- A request from an `allowFrom` address **and** with the right secret header counts as signed in, for the site `auth` gate and for the editor, as the user named in `userHeader` (letters, digits, space and `._@-`, up to 64 characters; default `proxy`).
- `edit` works without `users` or `token` when `proxyAuth` is valid. `edit.allowFrom`, the `X-Requested-With` header on writes and the confirmation for protected files still apply.
- On a proxy-only site, `/_edit/_login` shows a page saying sign-in happens through the proxy.
- Wrong secret or address: logged as `proxy-auth-denied` (without the secret), then normal auth applies.
- Missing or short secret: a warning at start and the feature stays off. A warning also appears if `host` is not loopback.

> [!warning] With `trustProxy: true` the address comes from `X-Forwarded-For`
> Then `proxyAuth.allowFrom` can be spoofed and the secret is the only real protection. Keep the secret long and the proxy stripping client-supplied `x-websidian-*` headers.

Works under a `basePath`: checked over HTTP with `/api/plugins/websidian/w` (pages, assets, editor, graph, search, embed, sitemap, redirects).

## Read from a note's own frontmatter

| Key | Does |
|---|---|
| `order` | Position in the sidebar and the Previous / Next pager — [[Navigation and sections]] |
| `description` | Shown beside the title in generated section lists, and as the page's meta description |
| `title`, `aliases` | Name and alternative names for wikilink resolution |
| `status`, `publish` | Visibility — [[Publishing and visibility]] |
| `tags`, `updated`, `lang`, `cssclasses` | Chips, dates, direction and per-note CSS |

A note named after its folder (`Guide/Guide.md`, or `Guide/index.md`) becomes that folder's page.

## Read from the vault itself (no config needed)
- `.obsidian/app.json` — editor behaviour: tabs vs spaces, tab size, auto-pairing, Live Preview default, line numbers, readable line length, spellcheck, link format, new note location, properties display.
- `.obsidian/types.json` — property types for the [[Editing in the browser#Properties panel|Properties panel]].
- `.obsidian/appearance.json` — which CSS snippets are enabled.
