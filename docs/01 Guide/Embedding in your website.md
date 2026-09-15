---
title: Embedding in your website
tags: [websidian, guide]
updated: 2026-09-13
---
# Embedding in your website

Add `?embed=1` to any note URL to get the article without header or sidebar. Links inside stay in embed mode.

```html
<iframe id="doc" src="https://docs.example.com/odoohms/00-overview/What%20the%20System%20Does?embed=1"
        style="width:100%;border:0" title="What the System Does"></iframe>
<script>
  addEventListener('message', e => {
    if (e.data && e.data.type === 'md2html:height') document.getElementById('doc').style.height = e.data.height + 'px';
  });
</script>
```

The embedded page posts its height so the iframe grows with the content. Match your site's look with `brand.color`, `brand.font` or `brand.css` ([[Configuration]]). Or fetch the URL server-side and insert the `<article>`.
