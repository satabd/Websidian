---
title: Excalidraw drawings
tags: [websidian, guide, excalidraw]
updated: 2026-09-16
order: 7
description: Drawings from the Excalidraw plugin, shown live on the site
---
# Excalidraw drawings

A drawing made with the [Excalidraw plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin) is shown on the site by the real Excalidraw viewer: hand-drawn strokes, fonts, images and links, in light and dark, with pan and zoom. Nothing has to be exported first.

## Embed a drawing
Write what you write in Obsidian:

```
![[Websidian architecture.excalidraw]]
![[Websidian architecture.excalidraw|500]]
![[Websidian architecture.excalidraw|500x300]]
```

The box takes the width of the text column (or the width you give) and the height of the drawing. Click it to pan and zoom; press `Esc` or click elsewhere to give the wheel back to the page. The ⤢ button fits the drawing to the box again; **Open ↗** opens it on its own page.

Plain `.excalidraw` files (saved from [excalidraw.com](https://excalidraw.com)) embed the same way.

## A drawing as a page
`[[Websidian architecture.excalidraw]]` links to `/site/Drawings/Websidian architecture.excalidraw`, a page with the drawing filling the column. Drawings never appear in the navigation, search or graph — they are pictures, not notes — but every drawing in the vault has this page unless something hides it ([[Publishing and visibility]]). `?raw` on that URL gives the Markdown file as always.

## What carries over from Obsidian
| In the drawing | On the site |
|---|---|
| Shapes, arrows, freehand, text, frames | As drawn |
| Images added to the drawing | Loaded from the vault (the plugin's `## Embedded Files` list) |
| A drawing embedded in a drawing | Its exported `.svg`/`.png`, if the plugin made one |
| `[[Wikilinks]]` on elements and in text | Links to the note; text shows the alias |
| Dark mode | Follows the site's theme button |
| The grid | Shown when it was on in Obsidian |
| Fonts | Virgil, Helvetica, Cascadia, Assistant as they are. Newer ones (Excalifont, Nunito, Lilita One, Comic Shanns) are drawn with the closest of those; the layout stays, because every text element carries its measured size |
| Elbow arrows (2024+) | Drawn as straight segments between the same points |
| Web embeds (YouTube, iframes) | Trusted sites only; never on `untrusted` sites |
| LaTeX blocks | Not shown |

The viewer is Excalidraw 0.17.6, the last release with a browser build that needs no bundler ([[Decisions]]). It is served from `node_modules` like mermaid and KaTeX: no CDN, and it works on `untrusted` sites under their Content-Security-Policy.

## Exported images still count
If the plugin's auto-export to SVG/PNG is on, the exported picture is used three ways: as the `og:image` of the page, as what you see with JavaScript off, and as what prints. A vault that only syncs the exports (not the `.excalidraw.md` notes) gets the picture, as before.

## Turn the viewer off
```json
{ "slug": "docs", "root": "vault", "excalidraw": "image" }
```
`"image"` (or `false`) goes back to the exported picture only: no viewer, no drawing pages, no JavaScript. Useful for a very light site.

> [!info] Page weight
> The viewer and its fonts are about 1.6 MB, fetched once per browser and only on pages that have a drawing. A page without drawings loads nothing extra.
