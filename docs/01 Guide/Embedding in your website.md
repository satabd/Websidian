---
title: Embedding in your website
tags: [websidian, guide]
updated: 2026-09-23
order: 11
description: Put a note inside another site, or a whole vault inside another application
---
# Embedding in your website

Add `?embed=1` to any note URL to get the article without header or sidebar. Links inside stay in embed mode.

```html
<iframe id="doc" src="https://docs.example.com/notes/guide/What%20It%20Does?embed=1"
        style="width:100%;border:0" title="What the System Does"></iframe>
<script>
  addEventListener('message', e => {
    if (e.data && e.data.type === 'websidian:height') document.getElementById('doc').style.height = e.data.height + 'px';
  });
</script>
```

The embedded page posts its height so the iframe grows with the content. Match your site's look with `brand.color`, `brand.font` or `brand.css` ([[Configuration]]). Or fetch the URL server-side and insert the `<article>`.

> [!note] Both message names are sent
> The page posts its height as `websidian:height` **and** `md2html:height`. The
> second is the name this project used before the rename, and pages already
> embedded in the wild listen for it — so it keeps being sent. New code should
> use `websidian:height`.

## Inside another application: shell mode

`?embed=1` gives you an article for a page of your own. **`?shell=1`** gives you the whole reading
experience — sidebar, search, breadcrumbs, table of contents, backlinks, local graph — with Websidian's own
header, branding, print and theme controls removed, for an application that draws its own chrome around it.

```
https://docs.example.com/notes/guide/What%20It%20Does?shell=1&theme=dark
```

| | `?embed=1` | `?shell=1` |
|---|---|---|
| Article | ✅ | ✅ |
| Sidebar, search, table of contents, backlinks, local graph | — | ✅ |
| Brand, site switch, print, theme toggle | — | — |
| Posts its height to the parent | ✅ | — (it fills the frame) |
| Posts `websidian:navigate` when the reader opens a note | — | ✅ |
| Accepts `websidian:theme` from the parent | — | ✅ |

**How much of Websidian's own navigation** is the host's choice, with `&chrome=`:

| `chrome` | Topbar (breadcrumbs, search, graph button) | Note tree | For |
|---|---|---|---|
| *(absent)* | ✅ | ✅ | A host that has nothing of its own |
| `tree` | — | ✅ | A host with its own search and title bar (OpenClaw's *Browse* tab) |
| `none` | — | — | A reading pane: the note, its table of contents, backlinks and local graph (OpenClaw's reader) |

`&theme=dark` or `&theme=light` hands your theme down; without it the reader's browser decides. The mode, the
theme and the chrome ride along on every internal link — the ones the server renders, the ones inside the note body, the
search results built in the browser, and a click on a node in the graph — so the reader cannot fall out of the
frame into the full site.

This is what OpenClaw's [[OpenClaw plugin|Memory page]] uses.

> [!tip] A parent can change the theme without a reload
> `frame.contentWindow.postMessage({ type: 'websidian:theme', theme: 'dark' }, '*')`.
