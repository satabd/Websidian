---
title: Graph and Explore
tags: [websidian, guide, graph]
aliases: [Graph view, Explore view]
updated: 2026-09-17
order: 8
description: Two full-screen views of how the vault connects
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

### Reach

Pick a note and see everything that links *into* it, transitively — its **upstream**, the notes that depend on it — or everything it links *out* to — its **downstream**, what it builds on — or both. Upstream is blue, downstream green, and every lit link gets an arrow in the direction of the link. Everything else fades. The caption lists the notes by hop count; **Hops** limits how far to follow (on a dense vault, *Any* lights most of it — try 1 or 2 first).

| Gesture | Does |
|---|---|
| **Reach** section → pick a note → *Show reach* | From the panel |
| `R` with the pointer over a node | The same, without the panel; `R` again on the same node clears it |
| `Esc` | Clears the reach (or the view) |
| `F` or ⤢ | Fits the lit notes, not the whole graph, while something is lit |

The URL carries it, so it can be shared: `_explore?reach=<rel>&dir=up|down|both&hops=2` (`hops` omitted means any).

### Views

A view is a named set of notes an author wants read together, in order — a "start here" path, the notes behind one decision, the pages a new teammate should open first. Declare views in the frontmatter of any note (a hub note is the natural place):

```yaml
views:
  - id: run-it
    label: I want to run it
    note: The four notes that take you from nothing to a deployed site, in order.
    focus: [Quick start, Your first site, Configuration, Deploying]
```

- `focus` entries are wikilink targets, resolved from the declaring note (`[[Tour]]`, `Tour` and `01 Guide/Tour` all work), in reading order.
- `id` is optional when `label` is given; it is the word in the URL. `note` is the caption.
- A note can also **join** a view from its own frontmatter with `views: [run-it]`. Joined notes follow the focus list, by title. A view that only has joiners takes its id as its label.
- Hidden notes (drafts, unpublished) never appear in a view, and a view with no visible member is not shown.

Views appear as chips under **Views** in the panel. Pick one: its members light up with numbered reading-order badges, the links between them stay visible, everything else fades, the canvas frames them, and the caption shows the note with a clickable list. Pick it again, or press `Esc`, to clear. `_explore?view=run-it` opens straight into it — the link to put in a welcome message.

> [!example] This vault
> [[Start Here]] declares two views: *I want to run it* and *Graph and reach*. Open this site's `_explore?view=run-it` to see one.

## The data behind them

```
GET /<site>/_graph.json?rel=<rel>&depth=1&tags=1
```

ETagged, built straight from the index. Each node carries `links`, `in`, `out`, `status`, `updated` and `dist`; the result also carries per-section `clusters`, cross-section `clusterLinks`, and the declared `views` (`id`, `label`, `note`, `from`, ordered `members`). Edges are directed (source links to target), which is what reach walks. Use it if you want to draw your own view — [[Editor API]] for the rest of the JSON surface.

> [!note] Hidden notes stay hidden
> Drafts and unpublished notes are absent from the graph for anonymous visitors, exactly as they are absent from pages and search — [[Publishing and visibility]].

See also: [[URLs and endpoints]], [[Tour]].
