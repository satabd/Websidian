---
title: URLs and endpoints
tags: [websidian, reference]
updated: 2026-09-16
order: 9
description: Every page and JSON route
---
# URLs and endpoints

Examples use the site slug `notes`.

## Pages
| URL | Serves |
|---|---|
| `/notes/` | Home note |
| `/notes/reference/Glossary` | A note |
| `/notes/Glossary` | Redirects to the canonical path (bare names work like wikilinks) |
| `/notes/screenshots/x.png` | An attachment |
| `/notes/reference/Glossary?raw` | Markdown source |
| `/notes/reference/Glossary?embed=1` | Article only, for iframes — [[Embedding in your website]] |
| `/notes/Catalogue.base` | Obsidian Base as tables |
| `/notes/_graph?focus=<rel>` | Graph view — [[Graph and Explore]] |
| `/notes/_explore?focus=<rel>` | Explore view — [[Graph and Explore]] |
| `/notes/_edit/<note>` | Editor — [[Editing in the browser]] |
| `/notes/_edit/_login` | Editor sign-in |

## JSON and operations
| URL | Serves |
|---|---|
| `/notes/_search?q=…` | Search results |
| `/notes/_graph.json?rel=&depth=&tags=1` | Graph data — [[Graph and Explore#The data behind them]] |
| `/notes/_api/…` | Editor API — [[Editor API]] |
| `/notes/sitemap.xml`, `/robots.txt` | For search engines |
| `/_health` | Liveness |
| `/_stats` | Cache, search and site counters |
| `POST /_purge?site=x` | Clear caches (needs `adminToken`) |
| `POST /_hooks/git/notes` | Git webhook — [[Deploying]] |
| `/_vendor/esm/<pkg>@<version>.js` | CodeMirror modules for the editor |
