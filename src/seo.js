'use strict';
// Sitemap, robots.txt and the per-page tags (canonical, OpenGraph, Twitter).
// `publicUrl` in the config (e.g. https://docs.example.com) makes the URLs absolute.

const { escapeHtml } = require('./render');

function absolute(config, p) { return (config.publicUrl ? String(config.publicUrl).replace(/\/$/, '') : '') + p; }

function sitemap(vault, config) {
  const rows = vault.visibleNotesSorted().map(n => {
    const lastmod = new Date(n.mtimeMs).toISOString().slice(0, 10);
    return `  <url><loc>${escapeHtml(absolute(config, vault.noteUrl(n.rel)))}</loc><lastmod>${lastmod}</lastmod></url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>\n`;
}

function robots(vaults, config, basePath) {
  const lines = ['User-agent: *'];
  for (const v of vaults) { if (v.auth) lines.push(`Disallow: ${v.siteUrl()}`); }
  lines.push(`Disallow: ${basePath}/_stats`, `Disallow: ${basePath}/_health`);
  for (const v of vaults) if (!v.auth) lines.push(`Sitemap: ${absolute(config, v.siteUrl() + 'sitemap.xml')}`);
  return lines.join('\n') + '\n';
}

// First image in the rendered body, for og:image.
function firstImage(html) { const m = html.match(/<img[^>]+src="([^"]+)"/i); return m ? m[1] : null; }

function pageTags({ vault, config, rel, title, data, bodyHtml }) {
  const url = absolute(config, vault.noteUrl(rel));
  const desc = String(data.description || data.summary || firstParagraph(bodyHtml) || title).slice(0, 300);
  const img = data.image ? String(data.image) : firstImage(bodyHtml);
  const tags = [
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    `<meta name="description" content="${escapeHtml(desc)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(desc)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    `<meta property="og:site_name" content="${escapeHtml(vault.brand.name || vault.title)}">`,
    `<meta name="twitter:card" content="${img ? 'summary_large_image' : 'summary'}">`,
  ];
  if (img) tags.push(`<meta property="og:image" content="${escapeHtml(/^https?:/i.test(img) ? img : absolute(config, img))}">`);
  if (data.lang) tags.push(`<meta property="og:locale" content="${escapeHtml(String(data.lang))}">`);
  if (vault.auth || data.noindex) tags.push(`<meta name="robots" content="noindex">`);
  return tags.join('\n');
}

function firstParagraph(html) {
  const m = String(html || '').match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  return m ? m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
}

module.exports = { sitemap, robots, pageTags, firstImage, absolute };
