'use strict';
// HTML shell around a rendered note: header, sidebar navigation, breadcrumbs,
// frontmatter metadata, table of contents, footer with backlinks and
// previous/next. The note body is dropped in as-is.
//
// Two modes:
//   full  — the standalone documentation site (default)
//   embed — article only, for an <iframe> or server-side include in another
//           website (?embed=1). Same body, no chrome, links keep embed mode.

const { escapeHtml } = require('./render');
const { folderTitle } = require('./vault');
const { pageTags } = require('./seo');
const { nonceAttr, withNonce } = require('./untrusted');

const LAYOUT_VERSION = 13;   // 13: folder notes, section index pages, order: in the sidebar

// JSON inside <script>: a note path containing "</script>" must not close the tag.
const scriptJson = v => JSON.stringify(v).replace(/</g, '\\u003c');
// Flag for public/app.js and public/editor.js: mermaid in strict mode on untrusted sites.
const untrustedAttr = vault => vault.untrusted ? ' data-untrusted="1"' : '';

const LANG_NAMES = { en: 'English', ar: 'العربية', fr: 'Français', de: 'Deutsch', es: 'Español', tr: 'Türkçe', fa: 'فارسی', ur: 'اردو', he: 'עברית', ku: 'Kurdî', zh: '中文', hi: 'हिन्दी', ru: 'Русский', it: 'Italiano', pt: 'Português', nl: 'Nederlands', bilingual: 'EN + AR' };
const langName = l => LANG_NAMES[String(l).toLowerCase()] || String(l).toUpperCase();

function navTree(node, currentRel, depth = 0) {
  let out = '';
  for (const f of node.folders) {
    const contains = folderContains(f, currentRel);
    // A folder with a folder note is a page of its own, so its label is a link.
    const current = f.rel && f.rel === currentRel;
    const label = f.url
      ? `<a class="nav-folder-note${current ? ' is-current' : ''}" href="${f.url}"${current ? ' aria-current="page"' : ''}>${escapeHtml(f.title)}</a>`
      : escapeHtml(f.title);
    out += `<details class="nav-folder"${contains || depth === 0 ? ' open' : ''}><summary>${label}</summary><div class="nav-children">${navTree(f, currentRel, depth + 1)}</div></details>`;
  }
  for (const n of node.notes) {
    out += `<a class="nav-note${n.rel === currentRel ? ' is-current' : ''}${n.isBase ? ' nav-base' : ''}" href="${n.url}"${n.lang ? ` lang="${escapeHtml(n.lang)}"` : ''}${n.rel === currentRel ? ' aria-current="page"' : ''}>${n.isBase ? '▦ ' : ''}${escapeHtml(n.title)}</a>`;
  }
  return out;
}
function folderContains(node, rel) {
  return node.rel === rel || node.notes.some(n => n.rel === rel) || node.folders.some(f => folderContains(f, rel));
}

function breadcrumbs(vault, rel) {
  const parts = rel.replace(/\.(md|base)$/i, '').split('/');
  let out = `<a href="${vault.siteUrl()}">${escapeHtml(vault.title)}</a>`;
  for (let i = 0; i < parts.length - 1; i++) out += ` <span class="sep">/</span> <span>${escapeHtml(folderTitle(parts[i], vault.folderNames))}</span>`;
  return out;
}

function toc(headings) {
  const items = headings.filter(h => h.level >= 2 && h.level <= 3);
  if (items.length < 2) return '';
  return `<nav class="toc" aria-label="On this page"><div class="toc-title">On this page</div>${items.map(h => `<a class="toc-h${h.level}" href="#${h.id}">${escapeHtml(h.text)}</a>`).join('')}</nav>`;
}

function metaRow(data) {
  const chips = [];
  const list = v => Array.isArray(v) ? v : (v == null ? [] : [v]);
  if (data.status) chips.push(`<span class="chip chip-status" data-status="${escapeHtml(data.status)}">${escapeHtml(data.status)}</span>`);
  for (const t of list(data.tags)) chips.push(`<span class="chip chip-tag">#${escapeHtml(t)}</span>`);
  for (const a of list(data.audience)) chips.push(`<span class="chip">${escapeHtml(a)}</span>`);
  if (data.persona) chips.push(`<span class="chip">${escapeHtml(data.persona)}</span>`);
  if (data.duration) chips.push(`<span class="chip">${escapeHtml(data.duration)}</span>`);
  const upd = data.updated || data.date;
  if (upd) chips.push(`<span class="chip chip-date">updated ${escapeHtml(upd instanceof Date ? upd.toISOString().slice(0, 10) : upd)}</span>`);
  return chips.length ? `<div class="note-meta">${chips.join('')}</div>` : '';
}

// Language switch: other editions of this note.
function langSwitch(vault, rel, data, embed) {
  if (!rel || !vault.notes.has(rel)) return '';
  const others = vault.translationsOf(rel);
  if (!others.length) return '';
  const q = embed ? '?embed=1' : '';
  const mine = data.lang ? `<span class="lang-current" lang="${escapeHtml(data.lang)}">${escapeHtml(langName(data.lang))}</span>` : '';
  return `<nav class="lang-switch" aria-label="Other languages">${mine}${others.map(t => `<a href="${t.url}${q}" lang="${escapeHtml(t.lang)}" hreflang="${escapeHtml(t.lang)}" title="${escapeHtml(t.title)}">${escapeHtml(langName(t.lang))}</a>`).join('')}</nav>`;
}

// Footer: previous/next within the folder, then "linked from" notes.
function footer(vault, rel, embed) {
  if (!rel || !vault.notes.has(rel)) return '';
  const { prev, next } = vault.neighbours(rel);
  const q = embed ? '?embed=1' : '';
  let out = '';
  if (prev || next) {
    out += `<nav class="pager" aria-label="Previous and next">`;
    out += prev ? `<a class="pager-prev" href="${vault.noteUrl(prev.rel)}${q}"><span class="pager-label">Previous</span><span class="pager-title">${escapeHtml(prev.title)}</span></a>` : '<span></span>';
    out += next ? `<a class="pager-next" href="${vault.noteUrl(next.rel)}${q}"><span class="pager-label">Next</span><span class="pager-title">${escapeHtml(next.title)}</span></a>` : '<span></span>';
    out += `</nav>`;
  }
  const back = vault.backlinksOf(rel);
  if (back.length) {
    out += `<section class="backlinks"><h2 class="backlinks-title">Linked from</h2><ul>${back.map(n => `<li><a href="${vault.noteUrl(n.rel)}${q}"${n.data.lang ? ` lang="${escapeHtml(n.data.lang)}"` : ''}>${escapeHtml(n.title)}</a><span class="muted"> · ${escapeHtml(n.folder ? n.folder.split('/').map(p => folderTitle(p, vault.folderNames)).join(' / ') : vault.title)}</span></li>`).join('')}</ul></section>`;
  }
  return out ? `<footer class="note-footer">${out}</footer>` : '';
}

// Per-site branding from config: { name, logo, color, font, favicon, homeUrl, backLink: {label, url}, footer, headHtml, css }
function brandVars(brand) {
  const vars = [];
  if (brand.color) vars.push(`--accent:${brand.color}`);
  if (brand.font) vars.push(`--font:${brand.font}`);
  return vars.length ? `<style>:root{${vars.join(';')}}</style>` : '';
}

function head({ vault, config, rel, title, data, body, assets, nonce }) {
  const brand = vault.brand;
  const seo = rel && vault.notes.has(rel) ? pageTags({ vault, config, rel, title, data, bodyHtml: body }) : `<meta name="description" content="${escapeHtml(String(data.description || title))}">`;
  const snippets = vault.snippets.map(s => `<link rel="stylesheet" href="${vault.siteUrl()}_snippets/${encodeURIComponent(s.name)}.css?v=${Math.floor(s.mtimeMs)}">`).join('\n');
  const math = /class="math /.test(body) ? `<link rel="stylesheet" href="${assets}/_vendor/katex/katex.min.css">` : '';
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(brand.name || vault.title)}</title>
${seo}
<link rel="stylesheet" href="${assets}/_static/app.css?v=${LAYOUT_VERSION}">
<link rel="stylesheet" href="${assets}/_vendor/hljs/styles/github.min.css" media="(prefers-color-scheme: light)">
<link rel="stylesheet" href="${assets}/_vendor/hljs/styles/github-dark.min.css" media="(prefers-color-scheme: dark)">
${math}${snippets}
${brandVars(brand)}${brand.css ? `<style>${brand.css}</style>` : ''}${withNonce(brand.headHtml || '', nonce)}
${brand.favicon ? `<link rel="icon" href="${escapeHtml(brand.favicon)}">` : ''}`;
}

// Local graph (this note and its neighbours) in the right column. Only for
// notes that have at least one link; the client fetches _graph.json?rel=…
function localGraph(vault, rel) {
  if (!rel || !vault.notes.has(rel)) return '';
  const links = (vault.backlinks.get(rel) || []).length + (vault.metaCache.get(rel)?.links || []).length;
  if (!links) return '';
  return `<section class="local-graph"><div class="toc-title">Graph <a class="local-graph-open" href="${vault.siteUrl()}_graph?focus=${encodeURIComponent(rel)}" title="Open graph view">⤢</a></div><canvas class="local-graph-canvas" data-graph="${vault.siteUrl()}_graph.json?rel=${encodeURIComponent(rel)}&depth=1" data-center="${escapeHtml(rel)}" aria-label="Local graph of linked notes"></canvas></section>`;
}

// Full-screen graph page: its own document (no article column). A floating
// panel holds Filters / Groups / Display / Forces like Obsidian's graph view.
function graphDocument({ vault, vaults, config = {}, focus = '', siteLang = 'en', nonce = '' }) {
  const assets = vault.basePath; const brand = vault.brand;
  const lang = String(siteLang || 'en'); const rtl = /^(ar|he|fa|ur)\b/i.test(lang);
  const focusNote = focus ? vault.notes.get(focus) : null;
  const title = focusNote ? `Graph · ${focusNote.title}` : 'Graph view';
  const slider = (id, label, min, max, step, val) => `<label class="gp-row"><span>${label}</span><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"><output for="${id}">${val}</output></label>`;
  const toggle = (id, label, on) => `<label class="gp-row gp-toggle"><span>${label}</span><input type="checkbox" id="${id}"${on ? ' checked' : ''}><i></i></label>`;
  return `<!doctype html>
<html lang="${escapeHtml(lang)}" dir="${rtl ? 'rtl' : 'ltr'}" class="graph-doc"${untrustedAttr(vault)}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(brand.name || vault.title)}</title>
<meta name="robots" content="noindex">
<link rel="stylesheet" href="${assets}/_static/app.css?v=${LAYOUT_VERSION}">
${brandVars(brand)}${brand.css ? `<style>${brand.css}</style>` : ''}
${brand.favicon ? `<link rel="icon" href="${escapeHtml(brand.favicon)}">` : ''}
</head>
<body class="graph-body">
<header class="topbar graph-topbar">
  <a class="back-link" href="${focusNote ? vault.noteUrl(focus) : vault.siteUrl()}" title="Back">← ${escapeHtml(focusNote ? focusNote.title : (brand.name || vault.title))}</a>
  <span class="graph-title">${focusNote ? 'Local graph' : 'Graph view'}</span>
  <span class="graph-stats muted" id="graphStats"></span>
  <span class="topbar-spacer"></span>
  ${vaults.length > 1 ? `<select class="site-switch" data-suffix="_graph" aria-label="Site">${vaults.map(v => `<option value="${v.siteUrl()}"${v.slug === vault.slug ? ' selected' : ''}>${escapeHtml(v.title)}</option>`).join('')}</select>` : ''}
  <a class="theme-btn graph-nav-link" href="${vault.siteUrl()}_explore${focus ? `?focus=${encodeURIComponent(focus)}` : ''}" title="Explore view">Explore ◈</a>
  <button class="theme-btn" id="themeBtn" aria-label="Toggle theme">◐</button>
  <button class="theme-btn" id="gpToggle" aria-label="Show or hide settings" title="Settings">⚙</button>
</header>
<canvas id="graphCanvas" class="graph-canvas-full" data-graph="${vault.siteUrl()}_graph.json${focusNote ? `?rel=${encodeURIComponent(focus)}&depth=1` : ''}" data-focus="${escapeHtml(focus)}" data-site="${escapeHtml(vault.slug)}" aria-label="Graph of notes"></canvas>
<div class="graph-zoom"><button type="button" id="gzIn" title="Zoom in">+</button><button type="button" id="gzOut" title="Zoom out">−</button><button type="button" id="gzFit" title="Fit to view">⤢</button><button type="button" id="gzRelease" title="Release pinned nodes">⟲</button></div>
<div class="graph-hover muted" id="graphHover"></div>
<aside class="graph-panel" id="graphPanel" aria-label="Graph settings">
  <details class="gp-section" open><summary>Filters</summary>
    <input id="gpQuery" class="gp-input" type="search" placeholder="Search files… (path: tag: -exclude)" aria-label="Filter">
    ${toggle('gpTags', 'Tags', false)}
    ${toggle('gpOrphans', 'Orphans', true)}
    ${focusNote ? `${toggle('gpLocal', 'Local graph', true)}${slider('gpDepth', 'Depth', 1, 5, 1, 1)}` : ''}
  </details>
  <details class="gp-section" open><summary>Groups</summary>
    <div id="gpGroups" class="gp-groups"></div>
    <div class="gp-add"><input id="gpGroupQuery" class="gp-input" type="text" placeholder="path:folder or tag:#x"><input id="gpGroupColor" type="color" value="#ff7a45"><button type="button" id="gpGroupAdd">Add</button></div>
    <div class="gp-legend" id="gpLegend"></div>
  </details>
  <details class="gp-section"><summary>Display</summary>
    ${toggle('gpArrows', 'Arrows', false)}
    ${slider('gpTextFade', 'Text fade threshold', 0.3, 3, 0.1, 1)}
    ${slider('gpNodeSize', 'Node size', 0.4, 2.5, 0.1, 1)}
    ${slider('gpLineWidth', 'Link thickness', 0.3, 3, 0.1, 1)}
    ${toggle('gpAnimate', 'Animate', true)}
  </details>
  <details class="gp-section"><summary>Forces</summary>
    ${slider('gpCenter', 'Center force', 0, 3, 0.05, 1)}
    ${slider('gpRepel', 'Repel force', 0.1, 4, 0.05, 1)}
    ${slider('gpLink', 'Link force', 0.1, 3, 0.05, 1)}
    ${slider('gpLinkDistance', 'Link distance', 0.3, 3, 0.05, 1)}
  </details>
  <div class="gp-foot"><button type="button" id="gpReset">Reset to defaults</button><span class="muted">Drag a node to pin it · double-click to release · right-click to highlight · Ctrl+click opens in a new tab</span></div>
</aside>
<script${nonceAttr(nonce)}>window.MD2HTML={site:${scriptJson(vault.slug)},rel:${scriptJson(focus)},base:${scriptJson(vault.siteUrl())},embed:false,graphPage:true};</script>${vaults.length > 1 ? `
<script src="${assets}/_static/site-switch.js?v=${LAYOUT_VERSION}" defer></script>` : ''}
<script src="${assets}/_static/graph.js?v=${LAYOUT_VERSION}" defer></script>
<script src="${assets}/_static/graph-page.js?v=${LAYOUT_VERSION}" defer></script>
</body>
</html>`;
}

// Explore view: a second, separate full-screen graph page (own canvas,
// own panel, own client script public/explore.js) that experiments with
// section bubbles, alternate layouts, colour/size modes and a path finder,
// without touching the existing graphDocument/graph-page.js pair above.
function exploreDocument({ vault, vaults, config = {}, focus = '', siteLang = 'en', nonce = '' }) {
  const assets = vault.basePath; const brand = vault.brand;
  const lang = String(siteLang || 'en'); const rtl = /^(ar|he|fa|ur)\b/i.test(lang);
  const focusNote = focus ? vault.notes.get(focus) : null;
  const title = focusNote ? `Explore · ${focusNote.title}` : 'Explore view';
  const slider = (id, label, min, max, step, val) => `<label class="gp-row"><span>${label}</span><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"><output for="${id}">${val}</output></label>`;
  const toggle = (id, label, on) => `<label class="gp-row gp-toggle"><span>${label}</span><input type="checkbox" id="${id}"${on ? ' checked' : ''}><i></i></label>`;
  const select = (id, label, options, val) => `<label class="gp-row gp-select-row"><span>${label}</span><select id="${id}" class="gp-select">${options.map(o => `<option value="${o[0]}"${o[0] === val ? ' selected' : ''}>${o[1]}</option>`).join('')}</select></label>`;
  return `<!doctype html>
<html lang="${escapeHtml(lang)}" dir="${rtl ? 'rtl' : 'ltr'}" class="graph-doc"${untrustedAttr(vault)}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(brand.name || vault.title)}</title>
<meta name="robots" content="noindex">
<link rel="stylesheet" href="${assets}/_static/app.css?v=${LAYOUT_VERSION}">
${brandVars(brand)}${brand.css ? `<style>${brand.css}</style>` : ''}
${brand.favicon ? `<link rel="icon" href="${escapeHtml(brand.favicon)}">` : ''}
</head>
<body class="graph-body">
<header class="topbar graph-topbar">
  <a class="back-link" href="${focusNote ? vault.noteUrl(focus) : vault.siteUrl()}" title="Back">← ${escapeHtml(focusNote ? focusNote.title : (brand.name || vault.title))}</a>
  <span class="graph-title">${focusNote ? 'Explore · local' : 'Explore view'}</span>
  <span class="graph-stats muted" id="exploreStats"></span>
  <span class="topbar-spacer"></span>
  ${vaults.length > 1 ? `<select class="site-switch" data-suffix="_explore" aria-label="Site">${vaults.map(v => `<option value="${v.siteUrl()}"${v.slug === vault.slug ? ' selected' : ''}>${escapeHtml(v.title)}</option>`).join('')}</select>` : ''}
  <a class="theme-btn graph-nav-link" href="${vault.siteUrl()}_graph${focus ? `?focus=${encodeURIComponent(focus)}` : ''}" title="Classic graph view">Graph ◉</a>
  <button class="theme-btn" id="themeBtn" aria-label="Toggle theme">◐</button>
  <button class="theme-btn" id="exToggle" aria-label="Show or hide settings" title="Settings">⚙</button>
</header>
<canvas id="exploreCanvas" class="graph-canvas-full" data-focus="${escapeHtml(focus)}" data-site="${escapeHtml(vault.slug)}" aria-label="Explore graph of notes"></canvas>
<div class="graph-zoom"><button type="button" id="exzIn" title="Zoom in">+</button><button type="button" id="exzOut" title="Zoom out">−</button><button type="button" id="exzFit" title="Fit to view">⤢</button><button type="button" id="exzRelease" title="Release pinned nodes">⟲</button></div>
<div class="graph-hover muted" id="exploreHover"></div>
<aside class="graph-panel" id="explorePanel" aria-label="Explore settings">
  <details class="gp-section" open><summary>Filters</summary>
    <input id="exQuery" class="gp-input" type="search" placeholder="Search files… (path: tag: -exclude)" aria-label="Filter">
    ${toggle('exTags', 'Tags', false)}
    ${toggle('exOrphans', 'Orphans', true)}
    ${slider('exDepth', 'Radial depth', 1, 4, 1, 1)}
  </details>
  <details class="gp-section" open><summary>Colour &amp; size</summary>
    ${select('exColorBy', 'Colour by', [['folder', 'Folder'], ['lang', 'Language'], ['status', 'Status'], ['updated', 'Recency']], 'folder')}
    ${select('exSizeBy', 'Size by', [['links', 'Links'], ['in', 'Incoming'], ['out', 'Outgoing'], ['equal', 'Equal']], 'links')}
    <div class="gp-legend" id="exLegend"></div>
  </details>
  <details class="gp-section" open><summary>Layout &amp; sections</summary>
    ${select('exLayout', 'Layout', [['cluster', 'Cluster'], ['radial', 'Radial'], ['force', 'Force']], 'cluster')}
    ${toggle('exBubbles', 'Section bubbles', true)}
    <div class="gp-btnrow"><button type="button" id="exCollapseAll">Collapse all</button><button type="button" id="exExpandAll">Expand all</button></div>
  </details>
  <details class="gp-section"><summary>Display</summary>
    ${slider('exTextFade', 'Text fade threshold', 0.3, 3, 0.1, 1)}
    ${slider('exNodeSize', 'Node size', 0.4, 2.5, 0.1, 1)}
    ${slider('exLineWidth', 'Link thickness', 0.3, 3, 0.1, 1)}
    ${toggle('exAnimate', 'Animate', true)}
  </details>
  <details class="gp-section"><summary>Path finder</summary>
    <input id="exPathFrom" class="gp-input" type="text" list="exNoteList" placeholder="From note…">
    <input id="exPathTo" class="gp-input" type="text" list="exNoteList" placeholder="To note…">
    <datalist id="exNoteList"></datalist>
    <div class="gp-btnrow"><button type="button" id="exPathGo">Find path</button><button type="button" id="exPathClear">Clear</button></div>
    <div class="gp-path" id="exPathResult"></div>
  </details>
  <div class="gp-foot"><button type="button" id="exReset">Reset to defaults</button><span class="muted">Drag to pin · double-click to release · right-click to highlight · Alt+click a node to set the radial centre · click a bubble to expand it</span></div>
</aside>
<script${nonceAttr(nonce)}>window.MD2HTML={site:${scriptJson(vault.slug)},rel:${scriptJson(focus)},base:${scriptJson(vault.siteUrl())},embed:false,graphPage:true};</script>${vaults.length > 1 ? `
<script src="${assets}/_static/site-switch.js?v=${LAYOUT_VERSION}" defer></script>` : ''}
<script src="${assets}/_static/graph.js?v=${LAYOUT_VERSION}" defer></script>
<script src="${assets}/_static/explore.js?v=${LAYOUT_VERSION}" defer></script>
</body>
</html>`;
}

function scripts(vault, rel, embed, assets, body, nonce, siteSwitch) {
  const math = /class="math /.test(body) ? `<script src="${assets}/_vendor/katex/katex.min.js" defer></script>\n` : '';
  const graph = /data-graph=/.test(body) || (!embed && rel && vault.notes.has(rel)) ? `<script src="${assets}/_static/graph.js?v=${LAYOUT_VERSION}" defer></script>\n` : '';
  return `<script${nonceAttr(nonce)}>window.MD2HTML={site:${scriptJson(vault.slug)},rel:${scriptJson(rel)},base:${scriptJson(vault.siteUrl())},embed:${embed}};</script>
${graph}
<script src="${assets}/_vendor/mermaid/mermaid.min.js" defer></script>
<script src="${assets}/_vendor/hljs/highlight.min.js" defer></script>
${math}<script src="${assets}/_static/app.js?v=${LAYOUT_VERSION}" defer></script>${siteSwitch ? `
<script src="${assets}/_static/site-switch.js?v=${LAYOUT_VERSION}" defer></script>` : ''}`;
}

const cssClasses = data => (Array.isArray(data.cssclasses) ? data.cssclasses : String(data.cssclasses || data.cssclass || '').split(/\s+/)).filter(Boolean).map(c => escapeHtml(String(c))).join(' ');

// editUrl: set only for requests carrying a valid editor session (see editor.js); adds the Edit button.
function page({ vault, vaults, config = {}, rel, title, body, data = {}, headings = [], siteLang = 'en', status = 200, embed = false, editUrl = '', nonce = '' }) {
  const lang = String(data.lang || siteLang || 'en');
  const rtl = /^(ar|he|fa|ur)\b/i.test(lang);
  const assets = vault.basePath;
  const brand = vault.brand;
  const bodyHasH1 = /<h1\b/i.test(body);
  const extra = cssClasses(data);
  const article = `<article class="note markdown-body${extra ? ' ' + extra : ''}" data-status="${status}">
      ${bodyHasH1 ? '' : `<h1>${escapeHtml(title)}</h1>`}
      ${metaRow(data)}
      ${body}
    </article>
    ${footer(vault, rel, embed)}`;

  if (embed) {
    return `<!doctype html>
<html lang="${escapeHtml(lang)}" dir="${rtl ? 'rtl' : 'ltr'}" class="is-embed${extra ? ' ' + extra : ''}"${untrustedAttr(vault)}>
<head>
${head({ vault, config, rel, title, data, body, assets, nonce })}
</head>
<body class="embed">
<main class="main embed-main">
${langSwitch(vault, rel, data, true)}
${article}
</main>
${scripts(vault, rel, true, assets, body, nonce, false)}
</body>
</html>`;
  }

  const siteSwitch = vaults.length > 1
    ? `<select class="site-switch" aria-label="Site">${vaults.map(v => `<option value="${v.siteUrl()}"${v.slug === vault.slug ? ' selected' : ''}>${escapeHtml(v.title)}</option>`).join('')}</select>`
    : '';
  const logo = brand.logo ? `<img class="brand-logo" src="${escapeHtml(brand.logo)}" alt="">` : '';
  const backLink = brand.backLink && brand.backLink.url ? `<a class="back-link" href="${escapeHtml(brand.backLink.url)}">${escapeHtml(brand.backLink.label || '← Back')}</a>` : '';
  return `<!doctype html>
<html lang="${escapeHtml(lang)}" dir="${rtl ? 'rtl' : 'ltr'}"${extra ? ` class="${extra}"` : ''}${untrustedAttr(vault)}>
<head>
${head({ vault, config, rel, title, data, body, assets, nonce })}
</head>
<body>
<header class="topbar">
  <button class="menu-btn" id="menuBtn" aria-label="Menu">☰</button>
  <a class="brand" href="${brand.homeUrl ? escapeHtml(brand.homeUrl) : vault.siteUrl()}">${logo}${escapeHtml(brand.name || vault.title)}</a>
  ${backLink}
  ${siteSwitch}
  <div class="search" id="search"><input id="searchInput" type="search" placeholder="Search…" autocomplete="off" aria-label="Search"><div class="search-results" id="searchResults" hidden></div></div>
  ${langSwitch(vault, rel, data, false)}
  ${editUrl ? `<a class="edit-btn" href="${escapeHtml(editUrl)}" title="Edit this note">✎ Edit</a>` : ''}
  <a class="graph-btn" href="${vault.siteUrl()}_graph${rel && vault.notes.has(rel) ? '?focus=' + encodeURIComponent(rel) : ''}" aria-label="Graph view" title="Graph view">◉</a>
  <button class="print-btn" id="printBtn" aria-label="Print or save as PDF" title="Print / PDF">⎙</button>
  <button class="theme-btn" id="themeBtn" aria-label="Toggle theme">◐</button>
</header>
<div class="shell">
  <aside class="sidebar" id="sidebar"><nav class="nav" aria-label="Documents">${navTree(vault.getTree(), rel)}</nav></aside>
  <main class="main">
    <div class="crumbs">${breadcrumbs(vault, rel)}</div>
    ${article}
    ${brand.footer ? `<div class="site-footer">${brand.footer}</div>` : ''}
  </main>
  <aside class="tocbar">${toc(headings)}${localGraph(vault, rel)}</aside>
</div>
${scripts(vault, rel, false, assets, body, nonce, vaults.length > 1)}
</body>
</html>`;
}

function sitesIndex(vaults, basePath = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Documentation</title><link rel="stylesheet" href="${basePath}/_static/app.css?v=${LAYOUT_VERSION}"></head>
<body><main class="main sites"><h1>Documentation</h1><ul class="site-list">${vaults.map(v => `<li><a href="${v.siteUrl()}">${escapeHtml(v.title)}</a><span class="muted">${v.visibleNotesSorted().length} pages${v.auth ? ' · restricted' : ''}</span></li>`).join('')}</ul></main></body></html>`;
}

module.exports = { page, sitesIndex, graphDocument, exploreDocument, LAYOUT_VERSION, langName };
