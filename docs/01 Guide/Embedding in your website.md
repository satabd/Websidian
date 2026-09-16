---
title: Embedding in your website
tags: [websidian, guide]
updated: 2026-09-16
order: 11
description: Put a note inside another site with an iframe
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
