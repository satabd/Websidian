---
title: URLs and endpoints
tags: [websidian, reference]
updated: 2026-09-13
---
# URLs and endpoints

Examples use the site slug `odoohms`.

## Pages
| URL | Serves |
|---|---|
| `/odoohms/` | Home note |
| `/odoohms/00-overview/Glossary` | A note |
| `/odoohms/Glossary` | Redirects to the canonical path (bare names work like wikilinks) |
| `/odoohms/screenshots/x.png` | An attachment |
| `/odoohms/00-overview/Glossary?raw` | Markdown source |
| `/odoohms/00-overview/Glossary?embed=1` | Article only, for iframes — [[Embedding in your website]] |
| `/odoohms/Catalogue.base` | Obsidian Base as tables |
| `/odoohms/_graph?focus=<rel>` | Graph view |
| `/odoohms/_explore?focus=<rel>` | Explore view (clusters, radial, path finder) |
| `/odoohms/_edit/<note>` | Editor — [[Editing in the browser]] |
| `/odoohms/_edit/_login` | Editor sign-in |

## JSON and operations
| URL | Serves |
|---|---|
| `/odoohms/_search?q=…` | Search results |
| `/odoohms/_graph.json?rel=&depth=&tags=1` | Graph data |
| `/odoohms/_api/…` | Editor API — [[Editor API]] |
| `/odoohms/sitemap.xml`, `/robots.txt` | For search engines |
| `/_health` | Liveness |
| `/_stats` | Cache, search and site counters |
| `POST /_purge?site=x` | Clear caches (needs `adminToken`) |
| `POST /_hooks/git/odoohms` | Git webhook — [[Deploying]] |
| `/_vendor/esm/<pkg>@<version>.js` | CodeMirror modules for the editor |
