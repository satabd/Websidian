---
title: Deploying
tags: [websidian, guide, ops]
updated: 2026-09-13
---
# Deploying

## Plain Node
```bash
npm ci --omit=dev
WEBSIDIAN_CONFIG=/etc/websidian/websidian.config.json PORT=8080 node src/server.js
```
Put nginx or Caddy in front for HTTPS (`reverse_proxy localhost:8080`) and set `trustProxy: true`.

## Docker
`docker compose up -d`. Mount the vault **read-write** if you use the editor (read-only is fine for a view-only site). The cache lives in a named volume.

## Keeping the server's vault current
- **Git webhook**: set `webhook: { "secret": "…", "command": "git pull --ff-only" }` on the site. On GitHub: Settings → Webhooks → payload URL `https://docs.example.com/_hooks/git/odoohms`, content type JSON, same secret, push events. Other systems: `POST …/_hooks/git/odoohms?token=<secret>`.
- Or a cron `git pull`, Dropbox, Obsidian Sync or `rsync` — the folder is watched and re-indexed within half a second.

## Checklist
- [ ] `edit.secret` set (sessions survive restarts)
- [ ] strong editor passwords, `allowFrom` if the team is on one network
- [ ] HTTPS in front (the session cookie becomes `Secure`)
- [ ] config file outside the vault and out of git
- [ ] vault writable by the server user if editing

> [!warning] Edits on the server are not committed yet
> Browser edits are plain file writes. If the vault is a git checkout, commit them yourself until *git commit per save* ships ([[Improvements backlog]]).
