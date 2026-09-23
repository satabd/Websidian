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
| Posts its height to the parent | ✅ | with `&flow=1` (otherwise it fills the frame) |
| Posts `websidian:navigate` when the reader opens a note | — | ✅ |
| Accepts `websidian:theme` and `websidian:palette` from the parent | — | ✅ |

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

This is what OpenClaw's [[OpenClaw plugin|Memory page]] and the [[Hermes plugin#Dashboard tab|Hermes tab]] use.

> [!tip] A parent can change the theme without a reload
> `frame.contentWindow.postMessage({ type: 'websidian:theme', theme: 'dark' }, '*')`.

**Your colours, not Websidian's.** A parent can hand down its palette so the note sits in the same colours as
the page around it:

```js
frame.contentWindow.postMessage({ type: 'websidian:palette', palette: {
  bg: '#041c1c', bg2: '#112625', fg: '#ffe6cb', muted: '#afa593', line: '#2c3c38',
  accent: '#ffcf7a', accentBg: '#273529', codeBg: '#162a28', mark: '#545025' } }, location.origin);
```

Only `#rrggbb` values are taken and only from the frame's own parent; a key left out falls back to the theme.
Send it again after every load of the frame (notes, the graph and Explore all accept it).

**Scroll with the host page: `&flow=1`.** By default a shell page fills its frame and scrolls inside it. With
`&flow=1` the page is as tall as its content and posts `{ type: 'websidian:height', height }` whenever that
changes, so the parent sets the frame's height and its own page does the scrolling — no box inside a box. The
note tree then scrolls on its own, as tall as the parent says a reader sees at once:
`postMessage({ type: 'websidian:viewport', height: 700 })`. `flow` rides along on links like the other options.
The [[Hermes plugin#Dashboard tab|Hermes tab]] uses it for notes and *Browse*; the graph and the editor keep a
fixed-height frame.

In shell mode the site switch is hidden on every page: the host chooses the vault.
