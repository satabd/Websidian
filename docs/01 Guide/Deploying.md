---
title: Deploying
tags: [websidian, guide, ops]
updated: 2026-09-16
order: 11
description: A real host, HTTPS, and the git webhook
---
# Deploying

## Plain Node
```bash
npm ci --omit=dev
WEBSIDIAN_CONFIG=/etc/websidian/websidian.config.json PORT=8080 node src/server.js
```
Put nginx or Caddy in front for HTTPS (`reverse_proxy localhost:8080`) and set `trustProxy: true`.

## Docker

Two services, in `docker-compose.yml`:

```bash
docker compose up docs        # this project's own documentation, on :8081
docker compose up websidian   # your vault, using ./config/websidian.config.json, on :8080
```

The `docs` service needs nothing configured. It mounts `./docs` read-only and runs it with `deploy/docs-site.config.json` — a public, read-only site with no `edit` block, so the editor does not exist at all. It is worth running once: **Websidian's own site is Websidian**, and it is the shortest honest demo of the whole idea.

For your own vault, mount it **read-write** if you use the editor; read-only is right for a view-only site. Either way the cache lives in a named volume, and the image has a `HEALTHCHECK` on `/_health`.

## A public, read-only site

`deploy/docs-site.config.json` is the pattern for any site that should be readable and not editable:

- **No `edit` block at all.** `/<site>/_edit/` and `/<site>/_api/` return `404` — not "forbidden", they are simply not routed.
- **`publicUrl`** so the sitemap, canonical links and OpenGraph tags carry absolute URLs. Set it to the real hostname before going live; the shipped value is an example.
- **`trustProxy: true`** because something terminates TLS in front.
- **`warm: true`** to render every note at start, so the first visitor is not the one who pays for it.
- **`log: "json"`** for a log shipper.

> [!tip] Link previews come for free
> `og:image` is taken from the first image in the note, so a page that opens with a screenshot gets a large preview card when the link is shared. Every page also carries an icon generated from `brand.color`, so nothing 404s on `/favicon.ico`.

## Keeping the server's vault current
- **Git webhook**: set `webhook: { "secret": "…", "command": "git pull --ff-only" }` on the site. On GitHub: Settings → Webhooks → payload URL `https://docs.example.com/_hooks/git/notes`, content type JSON, same secret, push events. Other systems: `POST …/_hooks/git/notes?token=<secret>`.
- Or a cron `git pull`, Dropbox, Obsidian Sync or `rsync` — the folder is watched and re-indexed within half a second.

## Checklist
- [ ] `edit.secret` set (sessions survive restarts)
- [ ] strong editor passwords, `allowFrom` if the team is on one network
- [ ] HTTPS in front (the session cookie becomes `Secure`)
- [ ] config file outside the vault and out of git
- [ ] vault writable by the server user if editing
- [ ] `publicUrl` set to the real hostname (sitemap, canonical, OpenGraph)
- [ ] `warm: true` so the first visitor does not pay for the first render

> [!warning] Edits on the server are not committed yet
> Browser edits are plain file writes. If the vault is a git checkout, commit them yourself until *git commit per save* ships ([[Improvements backlog]]).
