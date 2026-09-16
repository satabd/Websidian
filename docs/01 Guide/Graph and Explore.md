---
title: Graph and Explore
tags: [websidian, guide, graph]
aliases: [Graph view, Explore view]
updated: 2026-09-16
---
# Graph and Explore

Two full-screen views of how the vault links together. Both are built from the vault index — no rendering, no database — and both remember their settings per browser.

| View | URL | Built for |
|---|---|---|
| **Graph** | `/<site>/_graph` | Obsidian's graph, on the web: look at the shape of the vault |
| **Explore** | `/<site>/_explore` | Reading the vault: clusters, rings, and the path between two notes |

Add `?focus=<rel>` to either to open centred on one note. Every page also carries a small local graph in its right rail, and the **⤢** on it opens the full view focused on that note.

## Graph

![[site-graph.png]]

A floating panel, like Obsidian's, with four sections:

| Section | Controls |
|---|---|
| **Filters** | Search with `path:`, `tag:` and `-exclude`; tags on or off; orphans on or off; local graph with a depth |
| **Groups** | Colour rules by query. With no rules, colour falls back to the top-level folder |
| **Display** | Arrows, text fade, node size, link thickness, animate |
| **Forces** | Center, repel, link, link distance |

| Gesture | Does |
|---|---|
| Drag a node | Pins it where you drop it |
| Double-click a node | Releases the pin |
| Right-click a node | Highlights its neighbourhood |
| Click | Opens the note |
| `Ctrl`+click | Opens it in a new tab |

## Explore

![[site-explore.png]]

The view Obsidian does not have. A force graph shows you that the vault is connected; Explore is meant to tell you *how*.

**Layouts**
- **Cluster** — each folder gets its own region of the canvas.
- **Radial** — rings by link distance from one note. `Alt`+click any node to re-centre on it; depth 1–4.
- **Force** — the familiar physics layout.

**Section bubbles.** Zoom out, or press *Collapse all*, and each folder becomes a single bubble sized by how many notes it holds. The bands between bubbles are sized by how many links cross between those folders — so you can see at a glance which parts of the vault actually talk to each other. Click a bubble to expand it.

**Colour and size.** Colour by folder, language, `status` or how recently a note changed. Size by total links, inbound only, outbound only, or all equal.

**Path finder.** Pick two notes and the shortest chain of links between them lights up, with a clickable list of the notes along the way. This is the one to reach for when you are asking "how does this idea connect to that one".

Plus the usual filter, orphans, tags, zoom and pin controls.

## The data behind them

```
GET /<site>/_graph.json?rel=<rel>&depth=1&tags=1
```

ETagged, built straight from the index. Each node carries `links`, `in`, `out`, `status`, `updated` and `dist`; the result also carries per-section `clusters` and cross-section `clusterLinks`. Use it if you want to draw your own view — [[Editor API]] for the rest of the JSON surface.

> [!note] Hidden notes stay hidden
> Drafts and unpublished notes are absent from the graph for anonymous visitors, exactly as they are absent from pages and search — [[Publishing and visibility]].

See also: [[URLs and endpoints]], [[Tour]].
