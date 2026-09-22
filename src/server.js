'use strict';
// Websidian server: serves one or more Obsidian vaults as websites.
//
// Request flow for a note:
//   1. stat the .md file (cheap)                       -> stamp = mtime + size
//   2. ETag check: browser already has this version?  -> 304, no body
//   3. cache lookup (memory, then disk) by stamp       -> hit: wrap & send
//   4. miss: render markdown, store, wrap & send
// Nothing is ever re-rendered until the .md (or a note it embeds) changes.

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const express = require('express');
const { Vault } = require('./vault');
const { Renderer, RENDER_VERSION, escapeHtml } = require('./render');
const { page, sitesIndex, graphDocument, exploreDocument, LAYOUT_VERSION } = require('./layout');
const { buildGraph, viewsHash } = require('./graph');
const { RenderCache } = require('./cache');
const { enforce } = require('./auth');
const { RateLimiter } = require('./ratelimit');
const { SearchIndex } = require('./search');
const { renderBase } = require('./bases');
const { sectionPage, sectionAppendix } = require('./sections');
const seo = require('./seo');
const hooks = require('./hooks');
const editor = require('./editor');
const { createEsm } = require('./esm');
const { resolveProxyAuth, middleware: proxyAuthMiddleware } = require('./proxyauth');
const { isServableAttachment, SVG_CSP, makeNonce, pageCsp } = require('./untrusted');
const { resolveAssist } = require('./assist');
const { resolveAgents } = require('./agents');
const { loadDrawing, viewerHtml } = require('./excalidraw');

// ---- configuration --------------------------------------------------------
// Websidian (formerly md2html): both env var and config file names are accepted.
const configPath = path.resolve(process.env.WEBSIDIAN_CONFIG || process.env.MD2HTML_CONFIG || (fs.existsSync('websidian.config.json') ? 'websidian.config.json' : 'md2html.config.json'));
let config;
try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
catch (e) { console.error(`Cannot read config ${configPath}: ${e.message}`); process.exit(1); }
if (!Array.isArray(config.sites) || !config.sites.length) { console.error('config.sites must list at least one vault'); process.exit(1); }

// Written by the Hermes installers next to src/ and public/, so /_health says which revision this copy is.
// Absent in a git checkout, and that is not an error.
const INSTALLED = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'websidian.version'), 'utf8')); }
  catch { return null; }
})();

const PORT = Number(process.env.PORT || config.port || 8080);
const HOST = process.env.HOST || config.host || '0.0.0.0';
const cacheDir = config.cacheDir === false ? null : path.resolve(path.dirname(configPath), config.cacheDir || '.cache');
const BASE = String(config.basePath || '').replace(/\/$/, '');   // e.g. "/docs" to live under yoursite.com/docs/
const LOG = config.log === undefined ? 'text' : config.log;      // "text" | "json" | false
const STARTED = Date.now();

// Structured-ish logging: one line per event, JSON when asked (for Docker/pm2 log shippers).
function log(event, fields = {}) {
  if (!LOG) return;
  if (LOG === 'json') return console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
  console.log(`[${new Date().toISOString()}] ${event} ${Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'string' && v.includes(' ') ? JSON.stringify(v) : v}`).join(' ')}`);
}

const renderer = new Renderer();
const cache = new RenderCache({ dir: cacheDir, enabled: config.diskCache !== false, maxEntries: (config.cache && config.cache.maxEntries) || 2000 });
const vaults = config.sites.map(s => new Vault({ basePath: BASE, ...s, root: path.resolve(path.dirname(configPath), String(s.root || '.')) }));
const bySlug = new Map(vaults.map(v => [v.slug, v]));
const searchIndex = new SearchIndex();
const searchLimiter = new RateLimiter({ limit: (config.rateLimit && config.rateLimit.search) || 60, windowMs: 60_000 });
const proxyAuth = resolveProxyAuth(config.proxyAuth, msg => console.warn('warning: ' + msg));
const assist = resolveAssist(config, msg => console.warn('warning: ' + msg));
const agents = resolveAgents(config, msg => console.warn('warning: ' + msg));
if (proxyAuth && !/^(127\.|::1$|localhost$)/.test(HOST)) console.warn(`warning: proxyAuth is enabled but the server listens on ${HOST}; bind it to 127.0.0.1 so only the proxy can reach it`);

// ---- helpers --------------------------------------------------------------
async function stampOf(vault, rel) {
  try { const st = await fsp.stat(path.join(vault.root, rel)); return `${st.mtimeMs}-${st.size}`; } catch { return 'missing'; }
}
// Untrusted sites render with a different Markdown parser (no raw HTML): never share cache entries.
function fullStamp(vault, stamp) { return `${stamp}|${vault.listHash}|r${RENDER_VERSION}${vault.untrusted ? 'u' : ''}${vault.excalidraw === 'image' ? 'i' : ''}`; }

async function getRendered(vault, rel) {
  const stamp = fullStamp(vault, await stampOf(vault, rel));
  const validateDeps = async deps => { for (const d of deps) if (await stampOf(vault, d.rel) !== d.stamp) return false; return true; };
  let entry = await cache.get(vault.slug, rel, stamp, validateDeps);
  let fromCache = true;
  if (!entry) {
    fromCache = false;
    const t0 = process.hrtime.bigint();
    const r = await renderer.render(vault, rel);
    entry = { stamp: fullStamp(vault, r.stamp), html: r.html, data: r.data, headings: r.headings, deps: r.deps, text: r.text, dir: r.dir, lang: r.lang, renderedAt: Date.now(), renderMs: Number(process.hrtime.bigint() - t0) / 1e6 };
    await cache.set(vault.slug, rel, entry);
  }
  return { ...entry, fromCache };
}

function notFound(res, vault, msg, extraHtml = '') {
  const body = `<div class="callout callout-danger"><div class="callout-title"><span class="callout-icon"></span><span class="callout-title-inner">Not found</span></div><div class="callout-content"><p>${escapeHtml(msg)}</p>${extraHtml}</div></div>`;
  res.status(404).type('html').send(vault
    ? page({ vault, vaults, config, rel: '', title: 'Not found', body, headings: [], status: 404, nonce: res.locals.cspNonce })
    : `<!doctype html><title>Not found</title><p>${escapeHtml(msg)}</p>`);
}

function etagFor(parts) { return `W/"${Buffer.from(parts.join('|')).toString('base64url')}"`; }
function sendConditional(req, res, etag) {
  res.set('ETag', etag); res.set('Cache-Control', 'no-cache'); // always revalidate; the server answers 304 in microseconds
  // A 304 must not carry a new CSP nonce: browsers merge 304 headers into the cached response, whose body has the old nonce.
  if (req.headers['if-none-match'] === etag) { res.removeHeader('Content-Security-Policy'); res.status(304).end(); return true; }
  return false;
}

// ---- app --------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('etag', false);
app.set('trust proxy', config.trustProxy || false);
// Never let a browser guess a content type (an attachment sniffed as HTML would run on our origin).
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
if (LOG) app.use((req, res, next) => {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => { if (req.method !== 'HEAD' && !/^\/_(static|vendor)\//.test(req.path.replace(BASE, ''))) log('http', { method: req.method, path: req.originalUrl, status: res.statusCode, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10, render: res.get('X-Render') || undefined }); });
  next();
});

// Trusted reverse proxy sign-in (top-level proxyAuth): sets req.proxyUser for the site auth gate and the editor.
app.use(proxyAuthMiddleware(proxyAuth, { trustProxy: !!config.trustProxy, log }));

const r = express.Router();          // everything below is mounted at BASE
app.use(BASE || '/', r);
if (BASE) app.get('/', (req, res) => res.redirect(BASE + '/'));
r.use('/_static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '7d', immutable: true }));
// Browser libraries served from node_modules, so the site has no external dependencies.
r.use('/_vendor/mermaid', express.static(path.join(__dirname, '..', 'node_modules', 'mermaid', 'dist'), { maxAge: '30d', immutable: true }));
r.use('/_vendor/hljs', express.static(path.join(__dirname, '..', 'node_modules', '@highlightjs', 'cdn-assets'), { maxAge: '30d', immutable: true }));
r.use('/_vendor/katex', express.static(path.join(__dirname, '..', 'node_modules', 'katex', 'dist'), { maxAge: '30d', immutable: true }));
// Excalidraw viewer (0.17.6: the last release with a browser build that needs no bundler) and the React it needs.
r.use('/_vendor/excalidraw', express.static(path.join(__dirname, '..', 'node_modules', '@excalidraw', 'excalidraw', 'dist'), { maxAge: '30d', immutable: true }));
r.use('/_vendor/react', express.static(path.join(__dirname, '..', 'node_modules', 'react', 'umd'), { maxAge: '30d', immutable: true }));
r.use('/_vendor/react-dom', express.static(path.join(__dirname, '..', 'node_modules', 'react-dom', 'umd'), { maxAge: '30d', immutable: true }));
// CodeMirror 6 and friends as plain ES modules, resolved by an import map (no bundler).
const esm = createEsm({ root: path.join(__dirname, '..') });
r.use('/_vendor/esm', esm.handler);

r.get('/', (req, res) => {
  if (vaults.length === 1) return res.redirect(vaults[0].siteUrl());
  res.type('html').send(sitesIndex(vaults, BASE));
});

r.get('/_health', (req, res) => {
  res.json({ ok: true, uptimeSec: Math.round((Date.now() - STARTED) / 1000), version: INSTALLED, sites: vaults.map(v => ({ slug: v.slug, notes: v.notes.size, ok: fs.existsSync(v.root) })), cacheEntries: cache.size() });
});

r.get('/_stats', (req, res) => {
  res.json({ cache: { ...cache.stats, entries: cache.size(), maxEntries: cache.maxEntries, disk: !!cacheDir }, renderVersion: RENDER_VERSION, layoutVersion: LAYOUT_VERSION, uptimeSec: Math.round((Date.now() - STARTED) / 1000),
    search: Object.fromEntries([...searchIndex.byVault].map(([k, v]) => [k, { docs: v.docs, builtAt: v.builtAt }])),
    sites: vaults.map(v => ({ slug: v.slug, notes: v.notes.size, files: v.files.size, listHash: v.listHash, linkHash: v.linkHash, snippets: v.snippets.map(s => s.name), auth: !!v.auth, edit: !!v.editor })) });
});

r.get('/robots.txt', (req, res) => res.type('text/plain').send(seo.robots(vaults, config, BASE)));

hooks.install(r, { config, vaults, bySlug, cache, searchIndex, log });

// Untrusted sites (`untrusted: true`): a Content-Security-Policy with a fresh nonce on every
// response under /:site/. Pages put res.locals.cspNonce on their inline <script> tags;
// attachments replace or drop the header (see the attachment branch below).
r.use('/:site/', (req, res, next) => {
  const v = bySlug.get(req.params.site);
  if (v && v.untrusted) { res.locals.cspNonce = makeNonce(); res.set('Content-Security-Policy', pageCsp(res.locals.cspNonce)); }
  next();
});

// Per-site access control applies to everything under /:site/.
const siteLoginLimiter = new RateLimiter({ limit: (config.rateLimit && config.rateLimit.login) || 10, windowMs: 60_000 }); // failed Basic-auth attempts per IP
r.use('/:site/', (req, res, next) => { const v = bySlug.get(req.params.site); if (!v) return next(); if (enforce(v, req, res, siteLoginLimiter)) return; next(); });

r.get('/:site/sitemap.xml', (req, res, next) => {
  const vault = bySlug.get(req.params.site); if (!vault) return next();
  res.type('application/xml').send(seo.sitemap(vault, config));
});

// Vault CSS snippets (from .obsidian/snippets), only the enabled ones.
r.get('/:site/_snippets/:name.css', (req, res, next) => {
  const vault = bySlug.get(req.params.site); if (!vault) return next();
  const s = vault.snippet(req.params.name); if (!s) return res.status(404).type('text').send('no such snippet');
  res.sendFile(s.abs, { maxAge: '1d', lastModified: true });
});

// Graph view: JSON built from the index (cheap), and the page around the canvas.
r.get('/:site/_graph.json', (req, res, next) => {
  const vault = bySlug.get(req.params.site); if (!vault) return next();
  const rel = req.query.rel ? String(req.query.rel) : null;
  const depth = Math.min(6, Math.max(1, Number(req.query.depth) || 1));
  const tags = req.query.tags !== undefined && req.query.tags !== '0';
  const etag = etagFor(['g', vault.listHash, vault.linkHash, viewsHash(vault), rel || '', String(depth), tags ? 't' : '']);
  if (sendConditional(req, res, etag)) return;
  res.json(buildGraph(vault, { rel, depth, tags }));
});
const graphShell = req => req.query.shell !== undefined && req.query.shell !== '0';
const graphTheme = req => (graphShell(req) && (req.query.theme === 'dark' || req.query.theme === 'light') ? req.query.theme : '');
r.get('/:site/_graph', (req, res, next) => {
  const vault = bySlug.get(req.params.site); if (!vault) return next();
  const focus = req.query.focus ? String(req.query.focus) : '';
  res.type('html').send(graphDocument({ vault, vaults, config, focus: vault.notes.has(focus) ? focus : '', siteLang: config.lang, nonce: res.locals.cspNonce, shell: graphShell(req), theme: graphTheme(req) }));
});
// Explore: the second graph view (section bubbles, cluster/radial layouts, colour by property, path finder).
r.get('/:site/_explore', (req, res, next) => {
  const vault = bySlug.get(req.params.site); if (!vault) return next();
  const focus = req.query.focus ? String(req.query.focus) : '';
  res.type('html').send(exploreDocument({ vault, vaults, config, focus: vault.notes.has(focus) ? focus : '', siteLang: config.lang, nonce: res.locals.cspNonce, shell: graphShell(req), theme: graphTheme(req) }));
});

// Search: MiniSearch index over the cached plain text, rebuilt when notes change.
r.get('/:site/_search', searchLimiter.middleware(), async (req, res, next) => {
  const vault = bySlug.get(req.params.site); if (!vault) return next();
  const q = String(req.query.q || '').trim().slice(0, 120);
  if (q.length < 2) return res.json([]);
  try {
    const ms = await searchIndex.ensure(vault, getRendered);
    const hits = searchIndex.query(ms, q, { limit: Math.min(50, Number(req.query.limit) || 25) });
    res.json(hits.map(h => ({ ...h, url: vault.noteUrl(h.rel), folder: h.folder })));
  } catch (e) { console.error('search failed:', e); res.status(500).json({ error: 'search failed' }); }
});

// Excalidraw: a drawing's scene as safe JSON for the browser viewer (src/excalidraw.js).
r.get('/:site/_drawing/*', async (req, res, next) => {
  const vault = bySlug.get(req.params.site); if (!vault) return next();
  let rel;
  try { rel = decodeURIComponent(req.params[0] || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); } catch { return res.status(404).json({ error: 'bad path' }); }
  if (rel.split('/').includes('..') || !vault.isDrawing(rel)) return res.status(404).json({ error: 'no such drawing' });
  const stamp = await stampOf(vault, rel);
  if (stamp === 'missing') return res.status(404).json({ error: 'no such drawing' });
  const etag = etagFor(['x1', stamp, vault.listHash, vault.untrusted ? 'u' : '']);
  if (sendConditional(req, res, etag)) return;
  let scene;
  try { scene = await loadDrawing(vault, rel); }
  catch (e) { log('error', { path: req.originalUrl, message: e.message }); return res.status(500).json({ error: 'could not read the drawing' }); }
  if (!scene) return res.status(404).json({ error: 'no drawing data in this file' });
  res.json(scene);
});

// Browser editor (own login, own URLs); must come before the note route so /_edit and /_api are never treated as notes.
const editing = editor.install(r, { config, vaults, bySlug, renderer, log, layoutVersion: LAYOUT_VERSION, esm, proxyAuth, assist, agents });

r.get('/:site/*', async (req, res, next) => {
  const vault = bySlug.get(req.params.site); if (!vault) return next();
  const editUser = editing.currentUser(vault, req);   // null for the public; adds the Edit button when set
  let rel;
  try { rel = decodeURIComponent(req.params[0] || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); } catch { return notFound(res, vault, 'Bad path'); }
  if (rel.split('/').includes('..')) return notFound(res, vault, 'Bad path');
  if (req.query.raw !== undefined && !/\.(md|base)$/i.test(rel) && !vault.file(rel)) rel += '.md';
  const embed = req.query.embed !== undefined && req.query.embed !== '0';
  // shell: the host application (OpenClaw's Memory page) draws its own chrome around this one.
  const shell = !embed && req.query.shell !== undefined && req.query.shell !== '0';
  const theme = shell && (req.query.theme === 'dark' || req.query.theme === 'light') ? req.query.theme : '';
  // chrome: how much of Websidian's own navigation the host wants — '' (topbar and note tree), 'tree'
  // (the note tree only; the host has its own search) or 'none' (the note alone, for a reading pane).
  const chrome = shell && (req.query.chrome === 'tree' || req.query.chrome === 'none') ? req.query.chrome : '';
  const modeKey = embed ? 'e' : shell ? 's' + (theme || '') + (chrome || '') : '';
  const modeQuery = embed ? '?embed=1' : shell ? '?shell=1' + (theme ? '&theme=' + theme : '') + (chrome ? '&chrome=' + chrome : '') : '';

  // A drawing (the plugin's `.excalidraw.md` note, or a plain `.excalidraw` file) is a page with the viewer.
  const drawingPage = async (drawingRel, title) => {
    const stamp = await stampOf(vault, drawingRel);
    const etag = etagFor(['d1', stamp, vault.listHash, 'l' + LAYOUT_VERSION, modeKey, vault.snippets.map(s => s.mtimeMs).join(',')]);
    if (sendConditional(req, res, etag)) return;
    const stem = drawingRel.replace(/\.md$/i, '');
    const exp = vault.resolveFile(stem + '.svg', drawingRel) || vault.resolveFile(stem + '.png', drawingRel);
    const body = viewerHtml({ vault, drawing: drawingRel, exportRel: exp, title, page: true });
    res.type('html').send(page({ vault, vaults, config, rel: drawingRel, title: title.replace(/\.excalidraw$/i, ''), body, data: {}, headings: [], siteLang: config.lang, embed, shell, theme, chrome, nonce: res.locals.cspNonce }));
  };

  // 1. Attachments (images, PDFs...): served straight from the vault with caching. Bases are rendered.
  const file = vault.file(rel);
  if (file && file.ext === '.excalidraw' && req.query.raw === undefined && vault.isDrawing(rel)) return drawingPage(rel, file.base);
  if (file && file.ext === '.base' && req.query.raw === undefined) {
    const stamp = await stampOf(vault, rel);
    const notesStamp = vault.visibleNotesSorted().map(n => `${n.mtimeMs}-${n.size}`).join(',');
    const etag = etagFor([stamp, vault.listHash, require('crypto').createHash('sha1').update(notesStamp).digest('hex').slice(0, 12), 'l' + LAYOUT_VERSION, modeKey, vault.untrusted ? 'u' : '']);
    if (sendConditional(req, res, etag)) return;
    let text; try { text = await fsp.readFile(file.abs, 'utf8'); } catch { return notFound(res, vault, 'Base not readable'); }
    const body = `<h1>${escapeHtml(file.base)}</h1>` + renderBase(vault, text, { baseName: file.base });
    return res.type('html').send(page({ vault, vaults, config, rel, title: file.base, body, data: { lang: config.lang }, headings: [], embed, shell, theme, chrome, nonce: res.locals.cspNonce }));
  }
  if (file) {
    if (vault.untrusted) {
      if (file.ext === '.base') return res.type('text/plain; charset=utf-8').sendFile(file.rel, { root: vault.root, dotfiles: 'deny' }, err => { if (err) next(err); });
      // Only media and PDFs; anything else in an agent's folder may be a secret or active content.
      if (!isServableAttachment(file.ext)) return notFound(res, vault, `No page at “${rel}”.`);
      if (file.ext === '.svg') res.set('Content-Security-Policy', SVG_CSP); else res.removeHeader('Content-Security-Policy');
    }
    // `root`: the dotfile check applies to the vault-relative path only, so a vault under e.g. ~/.hermes works.
    return res.sendFile(file.rel, { root: vault.root, maxAge: '1h', lastModified: true, etag: true, dotfiles: 'deny' }, err => { if (err) next(err); });
  }

  // 2. Sections. A folder's URL serves its folder note (`Guide/Guide.md`), or a
  //    generated index of what is in it — never a 404 for a folder that exists.
  const folderNode = rel === '' ? null : vault.folderNode(rel);
  if (folderNode && !vault.note(rel + '.md')) {
    if (folderNode.rel) {
      // There is a folder note: fall through and render it at this URL.
      rel = folderNode.rel;
    } else if (vault.sectionIndex !== false) {
      const etag = etagFor([vault.listHash, vault.linkHash, 'l' + LAYOUT_VERSION, 's1', modeKey]);
      if (sendConditional(req, res, etag)) return;
      const body = sectionPage(vault, folderNode);
      return res.type('html').send(page({ vault, vaults, config, rel: folderNode.path, title: folderNode.title, body, data: {}, headings: [], siteLang: config.lang, embed, shell, theme, chrome, nonce: res.locals.cspNonce }));
    }
  }

  // 3. Notes. Empty path = home; a bare name is resolved like a wikilink and redirected to its canonical URL.
  let noteRel = rel === '' ? vault.homeRel() : (vault.note(rel) ? rel : vault.note(rel + '.md') ? rel + '.md' : vault.resolveNote(rel, ''));
  if (!noteRel) return notFound(res, vault, `No page at “${rel}”. Check the sidebar, or the note may have been renamed.`, editUser && /^[^.]/.test(rel) ? `<p><a href="${escapeHtml(vault.editUrl(rel + '.md'))}">Create “${escapeHtml(rel)}” in the editor</a></p>` : '');
  const note = vault.note(noteRel);
  if (note.hidden && !vault.isDrawing(noteRel)) return notFound(res, vault, 'This page is not published.');
  const canonical = vault.noteUrl(noteRel);
  if (rel !== '' && req.query.raw === undefined && BASE + req.path !== canonical) return res.redirect(301, canonical + modeQuery);

  if (req.query.raw !== undefined) return res.type('text/markdown; charset=utf-8').sendFile(note.abs);
  if (note.drawing) return drawingPage(noteRel, note.title);

  // 4. HTTP cache: ETag from the note's stamp + everything that shapes the page.
  const stamp = await stampOf(vault, noteRel);
  if (stamp === 'missing') { await vault.scan(); return notFound(res, vault, 'This note was just removed.'); }
  const etag = etagFor([fullStamp(vault, stamp), vault.linkHash, 'l' + LAYOUT_VERSION, modeKey, editUser ? 'ed' : '', vault.snippets.map(s => s.mtimeMs).join(',')]);
  if (sendConditional(req, res, etag)) return;

  // 5. Render (or take from cache) and wrap in the layout.
  let entry;
  try { entry = await getRendered(vault, noteRel); }
  catch (e) { console.error(`render failed for ${noteRel}:`, e); return res.status(500).type('text').send('Render error: ' + e.message); }
  res.set('X-Render', entry.fromCache ? 'cache' : `rendered ${entry.renderMs.toFixed(1)}ms`);

  // A folder note gets the generated list of its section appended, so the
  // section page never disagrees with the folder it describes. It is generated
  // per request from the index (cheap) and is not part of the render cache.
  let body = entry.html, headings = entry.headings;
  const ownFolder = vault.folderOfNote(noteRel);
  if (ownFolder !== null && vault.sectionIndex !== false && !embed) {
    const appendix = sectionAppendix(vault, vault.folderNode(ownFolder));
    if (appendix) {
      body += appendix;
      headings = [...headings, { level: 2, text: 'In this section', id: 'in-this-section' }];
    }
  }
  res.type('html').send(page({ vault, vaults, config, rel: noteRel, title: note.title, body, data: entry.data, headings, siteLang: config.lang, detected: { dir: entry.dir, lang: entry.lang }, embed, shell, theme, chrome, editUrl: editUser && !embed && !shell ? vault.editUrl(noteRel) : '', nonce: res.locals.cspNonce }));
});

app.use((req, res) => notFound(res, null, 'Not found'));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  log('error', { path: req.originalUrl, message: err.message });
  if (res.headersSent) return;
  res.status(err.status || 500).type('text').send(err.status ? err.message : 'Internal error');
});

// ---- start --------------------------------------------------------------------
(async () => {
  for (const v of vaults) {
    if (!fs.existsSync(v.root)) { console.error(`[${v.slug}] vault folder not found: ${v.root}`); process.exit(1); }
    await v.scan();
    v.watch();
    log('vault', { site: v.slug, notes: v.notes.size, files: v.files.size, snippets: v.snippets.length, auth: !!v.auth, root: v.root });
  }
  app.listen(PORT, HOST, () => {
    console.log(`websidian listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${BASE}/  (cache: ${cacheDir || 'memory only'})`);
    if (config.warm !== false) warmUp();
  });
})();

// Pre-render everything in the background so first visits are instant too.
async function warmUp() {
  const t0 = Date.now(); let n = 0;
  for (const v of vaults) for (const note of v.visibleNotesSorted()) { try { await getRendered(v, note.rel); n++; } catch (e) { console.warn(`warm-up: ${note.rel}: ${e.message}`); } }
  for (const v of vaults) { try { await searchIndex.ensure(v, getRendered); } catch (e) { console.warn(`search index: ${e.message}`); } }
  log('warm-up', { notes: n, ms: Date.now() - t0, rendered: cache.stats.renders, fromCache: cache.stats.hits + cache.stats.diskHits });
}
