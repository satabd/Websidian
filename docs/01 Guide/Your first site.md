---
title: Your first site
tags: [websidian, guide]
updated: 2026-09-16
order: 2
description: Point it at your own vault, end to end
---
# Your first site

[[Quick start]] runs the bundled demo. This note points Websidian at **your own vault** and takes it from a folder on your disk to a site you can edit from anywhere.

Nothing here modifies your vault. Websidian reads it; only the editor writes, and only when you turn the editor on.

## 1. Name the vault

Copy the example config and edit the one site in it:

```bash
cp websidian.config.example.json websidian.config.json
```

```json
{
  "port": 8080,
  "host": "127.0.0.1",
  "sites": [
    {
      "slug": "notes",
      "title": "My notes",
      "root": "/path/to/your/vault",
      "home": "Start Here"
    }
  ]
}
```

- `root` is the folder holding the `.md` files — the same folder you opened in Obsidian. A relative path is resolved **against the config file**, not the working directory.
- `slug` is the URL prefix: `/notes/…`.
- `home` is the note at `/notes/`. Leave it out and Websidian tries `index`, `home`, `readme`, `start here`, then the first note.

```bash
npm start
```

Open `http://127.0.0.1:8080/notes/`. Use `127.0.0.1`, not `localhost` — see the warning in [[Quick start]].

> [!question]- The sidebar shows folders I did not want to publish
> `exclude` takes folder paths and extensions: `"exclude": ["Private", "Journal", "*.xlsx"]`. Dot-folders (`.obsidian`, `.git`, `.trash`) are never served, whatever you set.

## 2. Decide what is public

By default every note is served. Two frontmatter-driven gates, both in [[Publishing and visibility]]:

```json
"excludeStatus": ["draft"],
"onlyPublished": true
```

`excludeStatus` hides notes with `status: draft`. `onlyPublished` flips the default: nothing is served unless it has `publish: true`. Hidden notes return `404` even by direct URL — they are not merely unlinked.

To put the whole site behind a login, or hand out a share link:

```json
"auth": { "users": { "reader": "a-long-password" } }
"auth": { "token": "a-long-random-string" }
```

A token turns `…/notes/?token=…` into a 30-day cookie. Protected sites are `noindex` and excluded from the sitemap and `robots.txt`.

## 3. Turn on the editor

The editor does not exist until you configure it ([[Editing in the browser]]). Add at the top level:

```json
"edit": {
  "users": { "you": "a-long-password" },
  "allowFrom": ["127.0.0.1", "::1"],
  "secret": "a-random-string-of-32-characters-or-more"
}
```

Restart, then open `http://127.0.0.1:8080/notes/_edit/`.

- `allowFrom` restricts editing to those addresses — drop it when you want to edit from outside, keep it when the team is on one network.
- `edit.secret` signs the session cookie. Without it everyone is logged out on every restart.
- `"edit": false` on a site turns editing off for that site while leaving it on elsewhere.

![[editor-login.png]]

Sign in and the **✎ Edit** button appears on public pages. Anonymous visitors never see it.

## 4. Make it yours

```json
"brand": {
  "name": "My notes",
  "color": "#7c3aed",
  "logo": "/notes/attachments/logo.png",
  "favicon": "/notes/attachments/favicon.png",
  "footer": "Written in Obsidian, served by Websidian.",
  "backLink": { "label": "← home", "url": "https://example.com" }
}
```

`folderNames` renames folders in the sidebar (`{ "ar": "العربية" }`), and `codeLinks` rewrites links that leave the vault so they land in your repository. Full list: [[Configuration]].

## 5. Put it somewhere

[[Deploying]] has the detail. The short version:

1. Run it behind nginx or Caddy with HTTPS and `"trustProxy": true`. The session cookie is marked `Secure` as soon as requests arrive over TLS.
2. Set `publicUrl` so the sitemap and OpenGraph tags carry absolute URLs.
3. Keep the vault in git and add the webhook, so a push updates the site:
   ```json
   "webhook": { "secret": "…", "command": "git pull --ff-only" }
   ```
4. Keep `websidian.config.json` out of version control — it holds your passwords, tokens and webhook secrets. It is already in `.gitignore` ([[Decisions]]).

## What you end up with

One folder of Markdown, three ways in: Obsidian on the desktop, the browser editor from anywhere, and `git pull` from anything else. They all write the same files, and the site is never more than one request behind.

> [!warning] The vault is trusted content
> Raw HTML in a note is passed through, exactly as Obsidian does. Only publish vaults you wrote. For folders an agent writes, set `"untrusted": true` — [[Agent memory and second brain]].

Next: [[Editing in the browser]], or [[Tour]] if you would rather look than read.
