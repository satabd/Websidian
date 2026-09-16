'use strict';
// Browser editor for the notes of a site. Deliberately a separate surface from
// the public viewer:
//   - its own URLs        /<site>/_edit/...  (page)   /<site>/_api/...  (JSON)
//   - its own login       edit.users { name: password } -> signed session cookie
//   - its own gate        edit.allowFrom [ip, prefix, cidr]  (optional)
//   - its own API token   edit.token  (optional, Authorization: Bearer, for scripts)
// Nothing here exists unless `edit` is configured (top-level for all sites, or
// per site; `edit: false` on a site turns it off). Public pages are unchanged;
// a visitor with a valid editor session just gets an "Edit" button.
//
// Writes are atomic (temp file + rename), refuse to touch anything but .md
// notes inside the vault, and check the file's stamp so two editors (or the
// editor and Obsidian on the desktop) cannot silently overwrite each other.

const path = require('path');
const fsp = require('fs/promises');
const crypto = require('crypto');
const express = require('express');
const { safeEqual, parseCookies } = require('./auth');
const { RateLimiter } = require('./ratelimit');
const assistLib = require('./assist');
const { escapeHtml } = require('./render');
const { isServableAttachment } = require('./untrusted');
const { folderTitle, collator } = require('./vault');

const MAX_NOTE_BYTES = 2 * 1024 * 1024;

// ---- configuration ----------------------------------------------------------

// Resolve the effective editor settings of a site: site.edit wins over config.edit.
// `proxy` (a valid top-level proxyAuth) is a sign-in method of its own: `edit` without
// users or token is then enabled, and only a trusted proxy can sign anyone in.
function resolveConfig(siteEdit, globalEdit, { proxy = false } = {}) {
  if (siteEdit === false) return null;
  const src = siteEdit && typeof siteEdit === 'object' ? siteEdit : (globalEdit && typeof globalEdit === 'object' ? globalEdit : null);
  if (!src) return null;
  const users = src.users && typeof src.users === 'object' ? src.users : null;
  const token = src.token ? String(src.token) : null;
  if (!users && !token && !proxy) return null;
  // protect / memoryLimits: the site's own value, else the top-level one (null = not configured).
  const pick = key => (src[key] !== undefined ? src[key] : globalEdit && typeof globalEdit === 'object' ? globalEdit[key] : undefined);
  const protect = pick('protect'), memoryLimits = pick('memoryLimits');
  return {
    users, token, proxy: !!proxy,
    allowFrom: Array.isArray(src.allowFrom) && src.allowFrom.length ? src.allowFrom.map(String) : null,
    sessionHours: Number(src.sessionHours) > 0 ? Number(src.sessionHours) : 12,
    protect: Array.isArray(protect) ? protect.map(String).filter(Boolean) : null,
    memoryLimits: memoryLimits && typeof memoryLimits === 'object' ? memoryLimits : null,
  };
}

// ---- agent instruction files --------------------------------------------------------

// Files an AI agent (Hermes Agent, OpenClaw…) reads as instructions. Editing them is
// equivalent to instructing an agent that has shell access, so saves need confirmation.
const DEFAULT_PROTECT = ['SKILL.md', 'SOUL.md', 'AGENTS.md', 'MEMORY.md', 'USER.md', 'TOOLS.md', 'IDENTITY.md', 'HEARTBEAT.md', 'BOOTSTRAP.md'];
const DEFAULT_MEMORY_LIMITS = { 'MEMORY.md': 2200, 'USER.md': 1375 };
const PROTECT_REASON = 'This file is read by the agent as instructions: whatever it says, the agent will follow in its next session, including running commands. Only change it deliberately, after reading what it will say.';

// Patterns without "/" match the file name in any folder; with "/" the whole vault path.
// "*" and "?" stay inside one path segment, "**" crosses folders. Always case-insensitive.
function globRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') { re += '.*'; i++; if (pattern[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}
function isProtected(patterns, rel) {
  if (!patterns || !patterns.length) return false;
  const base = rel.replace(/.*\//, '');
  return patterns.some(p => { p = p.replace(/\\/g, '/').replace(/^\/+/, ''); return globRegex(p).test(p.includes('/') ? rel : base); });
}
// The protect list of a site: edit.protect when configured, else the defaults on untrusted sites.
function protectPatterns(vault) {
  const cfg = vault.editor;
  if (cfg && cfg.protect) return cfg.protect;
  return vault.untrusted ? DEFAULT_PROTECT : [];
}

// Hermes Agent keeps memories/MEMORY.md and memories/USER.md under a character budget,
// entries separated by "§". Only the length is checked; the structure is Hermes's business.
function memoryWarnings(vault, rel, text) {
  if (!vault.untrusted) return [];
  const parts = rel.split('/');
  if (parts.length < 2 || parts[parts.length - 2].toLowerCase() !== 'memories') return [];
  const limits = { ...DEFAULT_MEMORY_LIMITS, ...((vault.editor && vault.editor.memoryLimits) || {}) };
  const name = Object.keys(limits).find(k => k.toLowerCase() === parts[parts.length - 1].toLowerCase());
  const limit = name && Number(limits[name]);
  if (!(limit > 0)) return [];
  const length = [...text].length;
  if (length <= limit) return [];
  const entries = text.split('§').filter(e => e.trim()).length;
  return [`${name} is ${length.toLocaleString('en')} characters (${entries} ${entries === 1 ? 'entry' : 'entries'}), over the agent's limit of ${limit.toLocaleString('en')}. The agent may truncate or reject it.`];
}

// ---- client IP allowlist --------------------------------------------------------

function normaliseIp(ip) {
  ip = String(ip || '').trim();
  const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1] : ip;
}
function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}
// Rules: exact IP ("10.1.2.3", "::1"), prefix ending in "." or ":" ("10.0.", "fd00:"), or IPv4 CIDR ("10.0.0.0/8").
function ipAllowed(ip, rules) {
  if (!rules) return true;
  ip = normaliseIp(ip);
  for (const rule of rules) {
    if (rule === ip) return true;
    if (/[.:]$/.test(rule) && ip.startsWith(rule)) return true;
    const cidr = rule.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
    if (cidr) {
      const a = ipv4ToInt(ip), b = ipv4ToInt(cidr[1]), bits = Number(cidr[2]);
      if (a === null || b === null || bits < 0 || bits > 32) continue;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((a & mask) === (b & mask)) return true;
    }
  }
  return false;
}

// ---- sessions ------------------------------------------------------------------

// Renamed from md2html_edit_ in the Websidian sweep: editors sign in again once.
function cookieName(slug) { return 'websidian_edit_' + slug.replace(/[^a-z0-9]/gi, '_'); }

function sign(secret, slug, user, exp) {
  return crypto.createHmac('sha256', secret).update(`${slug}|${user}|${exp}`).digest('base64url');
}
function makeSession(secret, slug, user, hours) {
  const exp = Date.now() + hours * 3600 * 1000;
  return { value: `${encodeURIComponent(user)}.${exp}.${sign(secret, slug, user, exp)}`, exp };
}
function readSession(secret, slug, value) {
  if (!value) return null;
  const parts = String(value).split('.');
  if (parts.length !== 3) return null;
  let user; try { user = decodeURIComponent(parts[0]); } catch { return null; }
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  return safeEqual(parts[2], sign(secret, slug, user, exp)) ? user : null;
}

// ---- paths -----------------------------------------------------------------------

// Turn user input into a safe vault-relative note path, or return { error }.
// Only .md notes, no dot-segments, nothing the site excludes, never outside the root.
// The editor URL may omit .md (like the viewer); the JSON API must be explicit.
function safeNoteRel(vault, input, { strict = false } = {}) {
  let rel = String(input == null ? '' : input).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '').trim();
  if (!rel) return { error: 'Path is empty' };
  if (rel.length > 400 || /[\0-\x1f<>:"|?*]/.test(rel)) return { error: 'Path contains characters that are not allowed' };
  if (!/\.md$/i.test(rel)) { if (strict) return { error: 'Only .md notes can be edited' }; rel += '.md'; }
  const parts = rel.split('/');
  if (parts.some(p => p === '' || p === '.' || p === '..' || p.startsWith('.') || p.endsWith('.') || p !== p.trim())) return { error: 'Path has an invalid folder or file name' };
  if (vault.isExcluded(rel, false) || parts.slice(0, -1).some((p, i) => vault.isExcluded(parts.slice(0, i + 1).join('/'), true))) return { error: 'Path is excluded by the site configuration' };
  const abs = path.resolve(vault.root, rel);
  if (!abs.startsWith(path.resolve(vault.root) + path.sep)) return { error: 'Path is outside the vault' };
  return { rel, abs };
}

// path.resolve() does not follow links, so "linked/x.md" where "linked" is a symlink or a
// Windows junction to another folder would pass safeNoteRel and write outside the vault.
// Before any write/move: the nearest existing ancestor must really be inside the vault's real
// root, and an existing target must not be a link itself. Returns null when safe, else an error.
const realRoots = new Map();
async function realRootOf(vault) {
  let r = realRoots.get(vault.root);
  if (!r) { r = await fsp.realpath(vault.root); realRoots.set(vault.root, r); }
  return r;
}
function insideRoot(root, p) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
async function linkEscape(vault, abs) {
  let root;
  try { root = await realRootOf(vault); } catch { return 'The vault folder is not accessible'; }
  try {
    const st = await fsp.lstat(abs);
    if (st.isSymbolicLink()) return 'The note is a link (symlink or junction); edit its target instead';
  } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return 'Cannot check the path: ' + e.code; }
  let dir = abs;
  for (;;) {
    try { const real = await fsp.realpath(dir); return insideRoot(root, real) ? null : 'Path goes through a link that leaves the vault'; }
    catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return 'Cannot check the path: ' + e.code;
      if (dir !== abs && await fsp.lstat(dir).then(() => true, () => false)) return 'Path goes through a broken link';
      const up = path.dirname(dir);
      if (up === dir) return 'Path is outside the vault';
      dir = up;
    }
  }
}

async function stampOf(abs) {
  try { const st = await fsp.stat(abs); return `${st.mtimeMs}-${st.size}`; } catch { return null; }
}

// Write via a dot-prefixed temp file in the same folder (ignored by the vault
// scanner), then rename over the target: readers never see a half-written note.
async function atomicWrite(abs, text) {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(tmp, text, 'utf8');
  try { await fsp.rename(tmp, abs); } catch (e) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw e; }
}

// ---- Obsidian settings -------------------------------------------------------------

// The editor reads the vault's own .obsidian/app.json, so it behaves the way the
// vault owner configured Obsidian (tabs vs spaces, auto-pairing, live preview,
// link format…). Unknown or missing keys fall back to Obsidian's defaults.
const OBSIDIAN_DEFAULTS = {
  livePreview: true, defaultViewMode: 'source', readableLineLength: true, showLineNumber: false,
  spellcheck: true, useTab: true, tabSize: 4, autoPairBrackets: true, autoPairMarkdown: true,
  smartIndentList: true, foldHeading: true, foldIndent: true, strictLineBreaks: false,
  newLinkFormat: 'shortest', useMarkdownLinks: false, attachmentFolderPath: '/', rightToLeft: false,
  propertiesInDocument: 'visible', showIndentGuide: true, newFileLocation: 'root', newFileFolderPath: '/',
};
async function obsidianSettings(vault) {
  let app = {};
  try { app = JSON.parse(await fsp.readFile(path.join(vault.root, '.obsidian', 'app.json'), 'utf8')) || {}; } catch { /* no settings: defaults */ }
  const out = {};
  for (const [k, def] of Object.entries(OBSIDIAN_DEFAULTS)) {
    const v = app[k];
    out[k] = typeof v === typeof def ? v : def;
  }
  if (!(out.tabSize >= 1 && out.tabSize <= 16)) out.tabSize = 4;
  if (!['shortest', 'relative', 'absolute'].includes(out.newLinkFormat)) out.newLinkFormat = 'shortest';
  if (!['root', 'current', 'folder'].includes(out.newFileLocation)) out.newFileLocation = 'root';
  if (!['visible', 'hidden', 'source'].includes(out.propertiesInDocument)) out.propertiesInDocument = 'visible';
  // Property types the vault owner chose in Obsidian (.obsidian/types.json: { "types": { "due": "date" } }).
  out.propertyTypes = {};
  try {
    const t = JSON.parse(await fsp.readFile(path.join(vault.root, '.obsidian', 'types.json'), 'utf8'));
    const OK = new Set(['text', 'multitext', 'number', 'checkbox', 'date', 'datetime', 'aliases', 'tags']);
    for (const [k, v] of Object.entries((t && t.types) || {}).slice(0, 1000)) if (typeof v === 'string' && OK.has(v)) out.propertyTypes[k] = v;
  } catch { /* no types.json */ }
  return out;
}

// Headings and block ids of a note, for [[note#heading]] and [[note#^block]] completion.
function anchorsOf(text) {
  const headings = [], blocks = [];
  let fence = null, inFront = text.startsWith('---\n') || text.startsWith('---\r\n');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inFront) { if (i > 0 && /^(---|\.\.\.)\s*$/.test(line)) inFront = false; continue; }
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) { if (!fence) fence = f[1]; else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; continue; }
    if (fence) continue;
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) headings.push({ level: h[1].length, text: h[2], line: i });
    const b = line.match(/\s\^([A-Za-z0-9-]+)\s*$/);
    if (b) blocks.push({ id: b[1], text: line.replace(/\s\^[A-Za-z0-9-]+\s*$/, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?/, '').trim().slice(0, 120), line: i });
  }
  return { headings, blocks };
}

// ---- editor page -------------------------------------------------------------------

// Navigation over every note (drafts and hidden ones included: editors need them).
function editTree(vault) {
  const root = { title: vault.title, folders: new Map(), notes: [] };
  const all = [...vault.notes.values()].sort((a, b) => collator.compare(a.rel, b.rel));
  for (const n of all) {
    let node = root;
    if (n.folder) for (const part of n.folder.split('/')) {
      if (!node.folders.has(part)) node.folders.set(part, { title: folderTitle(part, vault.folderNames), folders: new Map(), notes: [] });
      node = node.folders.get(part);
    }
    node.notes.push(n);
  }
  const render = (node, current, depth) => {
    let out = '';
    for (const [name, f] of [...node.folders].sort((a, b) => collator.compare(a[0], b[0]))) {
      const inner = render(f, current, depth + 1);
      out += `<details class="nav-folder"${depth === 0 || inner.includes('is-current') ? ' open' : ''}><summary>${escapeHtml(f.title)}</summary><div class="nav-children">${inner}</div></details>`;
    }
    for (const n of node.notes) out += `<a class="nav-note${n.rel === current ? ' is-current' : ''}${n.hidden ? ' is-hidden' : ''}" href="${vault.editUrl(n.rel)}" data-rel="${escapeHtml(n.rel)}" title="${escapeHtml(n.rel)}${n.hidden ? ' (not published)' : ''}">${escapeHtml(n.title)}</a>`;
    return out;
  };
  return (current) => render(root, current, 0);
}

// JSON inside <script>: never let the text close the tag.
const scriptJson = v => JSON.stringify(v).replace(/</g, '\\u003c');

// Version of a file in public/ by mtime, so editor assets refresh without a LAYOUT_VERSION bump.
function assetVersion(name, fallback) {
  try { return Math.floor(require('fs').statSync(path.join(__dirname, '..', 'public', name)).mtimeMs).toString(36); } catch { return fallback; }
}

function editorDocument({ vault, vaults, config, rel, exists, user, proxied = false, layoutVersion, settings, importMap, nonce = '' }) {
  const n = nonce ? ` nonce="${nonce}"` : '';   // CSP nonce on untrusted sites (see untrusted.js)
  const assets = vault.basePath; const brand = vault.brand;
  const title = exists ? (vault.note(rel)?.title || rel) : rel.replace(/\.md$/, '');
  const viewUrl = vault.noteUrl(rel);
  return `<!doctype html>
<html lang="${escapeHtml(String(config.lang || 'en'))}" class="editor-doc"${vault.untrusted ? ' data-untrusted="1"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Edit · ${escapeHtml(title)} · ${escapeHtml(brand.name || vault.title)}</title>
${importMap ? `<script type="importmap"${n}>${scriptJson(importMap)}</script>` : ''}
<link rel="stylesheet" href="${assets}/_static/app.css?v=${layoutVersion}">
<link rel="stylesheet" href="${assets}/_static/editor.css?v=${assetVersion('editor.css', layoutVersion)}">
<link rel="stylesheet" href="${assets}/_static/cm/obsidian.css?v=${assetVersion('cm/obsidian.css', layoutVersion)}">
<link rel="stylesheet" href="${assets}/_vendor/hljs/styles/github.min.css" media="(prefers-color-scheme: light)">
<link rel="stylesheet" href="${assets}/_vendor/hljs/styles/github-dark.min.css" media="(prefers-color-scheme: dark)">
<link rel="stylesheet" href="${assets}/_vendor/katex/katex.min.css">
${vault.snippets.map(s => `<link rel="stylesheet" href="${vault.siteUrl()}_snippets/${encodeURIComponent(s.name)}.css?v=${Math.floor(s.mtimeMs)}">`).join('\n')}
${brand.color || brand.font ? `<style>:root{${brand.color ? `--accent:${brand.color};` : ''}${brand.font ? `--font:${brand.font};` : ''}}</style>` : ''}
${brand.favicon ? `<link rel="icon" href="${escapeHtml(brand.favicon)}">` : ''}
</head>
<body class="editor-body mode-split">
<header class="topbar editor-topbar">
  <button class="menu-btn" id="menuBtn" aria-label="Menu">☰</button>
  <a class="brand" href="${vault.siteUrl()}" title="Back to the site">${brand.logo ? `<img class="brand-logo" src="${escapeHtml(brand.logo)}" alt="">` : ''}${escapeHtml(brand.name || vault.title)}</a>
  <span class="ed-badge">EDIT</span>
  ${vaults.length > 1 ? `<select class="site-switch" data-suffix="_edit/" aria-label="Site">${vaults.map(v => `<option value="${v.siteUrl()}"${v.slug === vault.slug ? ' selected' : ''}>${escapeHtml(v.title)}</option>`).join('')}</select>` : ''}
  <span class="ed-path" id="edPath" title="${escapeHtml(rel)}">${escapeHtml(rel)}${exists ? '' : ' <em class="muted">(new)</em>'}</span>
  <span class="ed-status muted" id="edStatus" aria-live="polite"></span>
  <span class="topbar-spacer"></span>
  <div class="ed-modes" role="group" aria-label="Layout">
    <button type="button" data-mode="edit">Edit</button><button type="button" data-mode="split" class="is-active">Split</button><button type="button" data-mode="preview">Preview</button>
  </div>
  <button type="button" class="ed-btn" id="edNew" title="Create a new note (Ctrl+Alt+N)">+ New</button>
  <button type="button" class="ed-btn ed-primary" id="edSave" title="Save (Ctrl+S)">Save</button>
  <button type="button" class="ed-btn" id="edDelete" title="Move this note to .trash"${exists ? '' : ' disabled'}>Delete</button>
  <a class="ed-btn" id="edView" href="${viewUrl}" title="Open the published page"${exists ? '' : ' hidden'}>View ↗</a>
  <button class="theme-btn" id="themeBtn" aria-label="Toggle theme">◐</button>
  ${proxied ? `<span class="ed-user muted" title="Signed in through the proxy">${escapeHtml(user)}</span>` : `<form method="post" action="${vault.siteUrl()}_edit/_logout" class="ed-logout"><button type="submit" class="ed-btn" title="Signed in as ${escapeHtml(user)}">Log out</button></form>`}
</header>
<div class="ed-conflict" id="edConflict" hidden>
  <span>This note changed on disk since you opened it (edited in Obsidian or by someone else).</span>
  <button type="button" id="edReload">Discard mine &amp; reload</button>
  <button type="button" id="edOverwrite">Overwrite with mine</button>
</div>
<div class="shell ed-shell">
  <aside class="sidebar" id="sidebar">
    <input class="ed-filter" id="edFilter" type="search" placeholder="Filter notes…" aria-label="Filter notes">
    <nav class="nav" aria-label="Notes">${vault.editTree(rel)}</nav>
  </aside>
  <section class="ed-pane ed-source">
    <div class="ed-complete" id="edComplete" hidden></div>
    <div id="edCm" class="ed-cm" hidden></div>
    <textarea id="edText" class="ed-textarea" dir="auto" spellcheck="${settings && settings.spellcheck === false ? 'false' : 'true'}" aria-label="Markdown source" placeholder="Loading…" disabled></textarea>
  </section>
  <section class="ed-pane ed-preview">
    <article class="note markdown-body" id="edPreview"><p class="muted">Preview</p></article>
  </section>
</div>
<footer class="status-bar" id="edStatusBar">
  <span class="status-bar-item" id="sbBacklinks" hidden></span>
  <span class="status-bar-item" id="sbWords"></span>
  <span class="status-bar-item" id="sbChars"></span>
  <span class="status-bar-item" id="sbCursor" hidden></span>
  <button type="button" class="status-bar-item mod-clickable" id="sbMode" title="Toggle Live Preview / Source mode" hidden></button>
  <span class="status-bar-item mod-muted" id="sbEngine" title="Editor engine"></span>
</footer>
<div class="modal-host" id="edModal" hidden></div>
<script${n}>window.WEBSIDIAN_EDIT=window.MD2HTML_EDIT=${scriptJson({ site: vault.slug, base: vault.siteUrl(), rel, exists, viewUrl, user, assets, settings, backlinks: (vault.backlinks.get(rel) || []).length })};</script>
<script src="${assets}/_vendor/mermaid/mermaid.min.js" defer></script>
<script src="${assets}/_vendor/hljs/highlight.min.js" defer></script>
<script src="${assets}/_vendor/katex/katex.min.js" defer></script>
<script src="${assets}/_static/excalidraw-view.js?v=${layoutVersion}" defer></script>
<script src="${assets}/_static/editor.js?v=${assetVersion('editor.js', layoutVersion)}" defer></script>${vaults.length > 1 ? `\n<script src="${assets}/_static/site-switch.js?v=${layoutVersion}" defer></script>` : ''}
</body>
</html>`;
}

function loginDocument({ vault, next, error, layoutVersion, proxyOnly = false }) {
  const brand = vault.brand;
  const form = proxyOnly
    ? `<div class="ed-login-card">
    <h1>${escapeHtml(brand.name || vault.title)}</h1>
    <p>Sign-in to the editor happens through the proxy this site is served from (for example the Hermes dashboard). Open the editor from there; this site has no editor accounts of its own.</p>
    <a class="muted" href="${vault.siteUrl()}">← Back to the site</a>
  </div>`
    : null;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>Editor login · ${escapeHtml(brand.name || vault.title)}</title>
<link rel="stylesheet" href="${vault.basePath}/_static/app.css?v=${layoutVersion}">
<link rel="stylesheet" href="${vault.basePath}/_static/editor.css?v=${layoutVersion}">
${brand.color ? `<style>:root{--accent:${brand.color}}</style>` : ''}
</head>
<body>
<main class="ed-login">
  ${form || `<form method="post" action="${vault.siteUrl()}_edit/_login" class="ed-login-card">
    <h1>${escapeHtml(brand.name || vault.title)}</h1>
    <p class="muted">Sign in to edit notes. Viewing does not need an account.</p>
    ${error ? `<p class="ed-login-error" role="alert">${escapeHtml(error)}</p>` : ''}
    <label>Name <input name="user" autocomplete="username" required autofocus></label>
    <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
    <input type="hidden" name="next" value="${escapeHtml(next || '')}">
    <button type="submit" class="ed-btn ed-primary">Sign in</button>
    <a class="muted" href="${vault.siteUrl()}">← Back to the site</a>
  </form>`}
</main>
</body>
</html>`;
}

// ---- routes ------------------------------------------------------------------------

function install(router, { config, vaults, bySlug, renderer, log, layoutVersion, esm, proxyAuth = null, assist = null }) {
  const secret = config.edit && config.edit.secret ? String(config.edit.secret) : crypto.randomBytes(32).toString('hex');
  const loginLimiter = new RateLimiter({ limit: (config.rateLimit && config.rateLimit.login) || 10, windowMs: 60_000 });
  // Every assist call costs money, so it has its own, tighter budget.
  const assistLimiter = new RateLimiter({ limit: (config.rateLimit && config.rateLimit.assist) || 20, windowMs: 60_000 });
  for (const v of vaults) {
    v.editor = resolveConfig(v.edit, config.edit, { proxy: !!proxyAuth });
    v.editUrl = rel => v.siteUrl() + '_edit/' + rel.replace(/\.md$/i, '').split('/').map(encodeURIComponent).join('/');
    v.editTree = current => editTree(v)(current);
  }

  // Who is editing, or null. Also null when editing is off or the client's network is not allowed,
  // so public pages never show the Edit button in those cases.
  function currentUser(vault, req) {
    const cfg = vault.editor;
    if (!cfg || !ipAllowed(req.ip, cfg.allowFrom)) return null;
    // Signed in by the trusted reverse proxy (req.proxyUser is set only when proxyAuth is valid).
    if (cfg.proxy && req.proxyUser) return req.proxyUser;
    if (cfg.token) {
      const h = req.headers.authorization || '';
      if (h.startsWith('Bearer ') && safeEqual(h.slice(7), cfg.token)) return 'api';
    }
    return readSession(secret, vault.slug, parseCookies(req.headers.cookie)[cookieName(vault.slug)]);
  }
  const cookieOpts = (vault, req, maxAge) => ({ httpOnly: true, sameSite: 'strict', secure: !!req.secure, path: vault.siteUrl(), maxAge });
  const safeNext = (vault, next) => (typeof next === 'string' && next.startsWith(vault.siteUrl()) && !/[\r\n]/.test(next) ? next : vault.editUrl(vault.homeRel() || 'Home.md'));

  // Gate for everything under _edit and _api: editing configured, network allowed.
  function gate(req, res, next) {
    const vault = bySlug.get(req.params.site);
    if (!vault || !vault.editor) return next('router');
    if (!ipAllowed(req.ip, vault.editor.allowFrom)) { log('edit-denied', { site: vault.slug, ip: req.ip }); return res.status(403).type('text').send('Editing is not available from this network.'); }
    req.vault = vault;
    next();
  }

  const ed = express.Router({ mergeParams: true });
  router.use('/:site/_edit', gate, ed);
  const api = express.Router({ mergeParams: true });
  router.use('/:site/_api', gate, api);

  // -- login / logout --------------------------------------------------------------
  ed.get('/_login', (req, res) => {
    if (currentUser(req.vault, req)) return res.redirect(safeNext(req.vault, req.query.next));
    if (!req.vault.editor.users && req.vault.editor.proxy) return res.status(403).type('html').send(loginDocument({ vault: req.vault, proxyOnly: true, layoutVersion }));
    if (!req.vault.editor.users) return res.status(403).type('text').send('This site has no editor accounts (only an API token).');
    res.type('html').send(loginDocument({ vault: req.vault, next: safeNext(req.vault, req.query.next), layoutVersion }));
  });
  ed.post('/_login', loginLimiter.middleware(), express.urlencoded({ extended: false, limit: '8kb' }), (req, res) => {
    const vault = req.vault; const users = vault.editor.users || {};
    const user = String(req.body.user || ''), pass = String(req.body.password || '');
    const expected = Object.prototype.hasOwnProperty.call(users, user) ? users[user] : undefined;
    if (expected === undefined || !safeEqual(pass, expected)) {
      log('edit-login', { site: vault.slug, user, ok: false, ip: req.ip });
      return res.status(401).type('html').send(loginDocument({ vault, next: safeNext(vault, req.body.next), error: 'Wrong name or password.', layoutVersion }));
    }
    const s = makeSession(secret, vault.slug, user, vault.editor.sessionHours);
    res.cookie(cookieName(vault.slug), s.value, cookieOpts(vault, req, s.exp - Date.now()));
    log('edit-login', { site: vault.slug, user, ok: true });
    res.redirect(303, safeNext(vault, req.body.next));
  });
  ed.post('/_logout', (req, res) => {
    res.clearCookie(cookieName(req.vault.slug), { path: req.vault.siteUrl() });
    res.redirect(303, req.vault.siteUrl());
  });

  // -- editor page --------------------------------------------------------------------
  ed.get('/*', async (req, res) => {
    const vault = req.vault;
    const user = currentUser(vault, req);
    if (!user) return res.redirect(302, `${vault.siteUrl()}_edit/_login?next=${encodeURIComponent(req.originalUrl)}`);
    let raw; try { raw = decodeURIComponent(req.params[0] || ''); } catch { return res.status(400).type('text').send('Bad path'); }
    raw = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!raw) { const home = vault.homeRel(); return home ? res.redirect(302, vault.editUrl(home)) : res.redirect(302, vault.editUrl('Home.md')); }
    // Existing note (with or without .md, or resolved like a wikilink), else a new note at that path.
    const existing = vault.note(raw) ? raw : vault.note(raw + '.md') ? raw + '.md' : (!/\.md$/i.test(raw) && vault.resolveNote(raw, '')) || null;
    if (existing && vault.editUrl(existing) !== req.baseUrl + req.path) return res.redirect(302, vault.editUrl(existing));
    const target = existing ? { rel: existing } : safeNoteRel(vault, raw);
    if (target.error) return res.status(400).type('text').send(target.error);
    res.set('Cache-Control', 'no-store');
    const settings = await obsidianSettings(vault);
    const importMap = esm && esm.packages.size ? esm.importMap(vault.basePath) : null;
    res.type('html').send(editorDocument({ vault, vaults, config, rel: target.rel, exists: !!existing, user, proxied: !!(vault.editor.proxy && req.proxyUser && user === req.proxyUser), layoutVersion, settings, importMap, nonce: res.locals.cspNonce }));
  });

  // -- JSON API -------------------------------------------------------------------------
  api.use((req, res, next) => {
    const user = currentUser(req.vault, req);
    if (!user) return res.status(401).json({ error: 'Sign in to edit', login: `${req.vault.siteUrl()}_edit/_login` });
    // CSRF: a cross-site form cannot set this header, and the session cookie is SameSite=Strict anyway.
    if (req.method !== 'GET' && !req.headers['x-requested-with']) return res.status(403).json({ error: 'Missing X-Requested-With header' });
    req.user = user;
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(express.json({ limit: MAX_NOTE_BYTES + 65536 }));

  api.get('/notes', (req, res) => {
    const vault = req.vault;
    const aliasesOf = n => { const a = n.data && (n.data.aliases || n.data.alias); return (Array.isArray(a) ? a : typeof a === 'string' ? [a] : []).map(String).filter(Boolean); };
    res.json([...vault.notes.values()].sort((a, b) => collator.compare(a.rel, b.rel)).map(n => ({ rel: n.rel, title: n.title, folder: n.folder, hidden: !!n.hidden, url: vault.noteUrl(n.rel), editUrl: vault.editUrl(n.rel), aliases: aliasesOf(n), mtime: Math.floor(n.mtimeMs) })));
  });

  // Attachments (every non-note file), for ![[embed]] completion and resolving images in the editor.
  api.get('/files', (req, res) => {
    const vault = req.vault;
    res.json([...vault.files.values()].filter(f => !vault.untrusted || isServableAttachment(f.ext)).sort((a, b) => collator.compare(a.rel, b.rel)).map(f => ({ rel: f.rel, name: f.name, ext: f.ext.replace(/^\./, ''), folder: f.folder, url: vault.fileUrl(f.rel), size: f.size })));
  });

  // Every tag in the vault with its note count, most used first (for #tag completion).
  api.get('/tags', (req, res) => {
    const counts = new Map();
    for (const n of req.vault.notes.values()) for (const t of n.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    res.json([...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || collator.compare(a.tag, b.tag)));
  });

  // Property names used in frontmatter across the vault, with their most common values.
  api.get('/properties', (req, res) => {
    const props = new Map();
    for (const n of req.vault.notes.values()) for (const [k, v] of Object.entries(n.data || {})) {
      if (!props.has(k)) props.set(k, { name: k, count: 0, type: Array.isArray(v) ? 'list' : v instanceof Date ? 'date' : typeof v, values: new Map() });
      const p = props.get(k); p.count++;
      for (const x of (Array.isArray(v) ? v : [v])) if (x != null && typeof x !== 'object' && String(x).length <= 80) p.values.set(String(x), (p.values.get(String(x)) || 0) + 1);
    }
    res.json([...props.values()].sort((a, b) => b.count - a.count || collator.compare(a.name, b.name)).map(p => ({ name: p.name, count: p.count, type: p.type, values: [...p.values].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([v]) => v) })));
  });

  // Headings and ^block ids of one note.
  api.get('/anchors', async (req, res) => {
    const t = safeNoteRel(req.vault, req.query.rel, { strict: true }); if (t.error) return res.status(400).json({ error: t.error });
    let text; try { text = await fsp.readFile(t.abs, 'utf8'); } catch { return res.status(404).json({ error: 'No such note' }); }
    res.json({ rel: t.rel, ...anchorsOf(text) });
  });

  api.get('/note', async (req, res) => {
    const vault = req.vault;
    const t = safeNoteRel(vault, req.query.rel, { strict: true }); if (t.error) return res.status(400).json({ error: t.error });
    const stamp = await stampOf(t.abs);
    const prot = isProtected(protectPatterns(vault), t.rel);
    const protInfo = prot ? { protected: true, reason: PROTECT_REASON } : { protected: false };
    if (!stamp) return res.status(404).json({ rel: t.rel, exists: false, text: '', stamp: null, ...protInfo });
    let text; try { text = await fsp.readFile(t.abs, 'utf8'); } catch (e) { return res.status(500).json({ error: e.message }); }
    const n = vault.note(t.rel);
    res.json({ rel: t.rel, exists: true, text: text.replace(/\r\n/g, '\n'), stamp, title: n ? n.title : t.rel, hidden: !!(n && n.hidden), url: vault.noteUrl(t.rel), ...protInfo });
  });

  // Saving or deleting an agent instruction file (or an over-long agent memory file) needs an
  // explicit { confirm: "instructions" }; without it: 428 with the reason, for the UI to ask.
  function needsConfirm(vault, rel, text, confirm) {
    if (confirm === 'instructions') return null;
    const prot = isProtected(protectPatterns(vault), rel);
    const warnings = text == null ? [] : memoryWarnings(vault, rel, text);
    if (!prot && !warnings.length) return null;
    return {
      error: prot ? 'Confirm changes to an agent instruction file' : 'Confirm saving a memory file over its limit',
      needsConfirm: 'instructions',
      protected: prot,
      reason: prot ? PROTECT_REASON : 'The agent reads this file as its memory.',
      warnings,
    };
  }

  api.put('/note', async (req, res) => {
    const vault = req.vault; const body = req.body || {};
    const t = safeNoteRel(vault, body.rel, { strict: true }); if (t.error) return res.status(400).json({ error: t.error });
    if (typeof body.text !== 'string') return res.status(400).json({ error: 'text must be a string' });
    if (Buffer.byteLength(body.text) > MAX_NOTE_BYTES) return res.status(413).json({ error: 'Note is too large' });
    const current = await stampOf(t.abs);
    // Optimistic concurrency: the client says which version it edited (null = "I am creating this").
    if (body.stamp !== undefined && (body.stamp || null) !== current) return res.status(409).json({ error: 'conflict', stamp: current, exists: !!current });
    if (current && vault.file(t.rel)) return res.status(400).json({ error: 'Not a note' });
    const escape = await linkEscape(vault, t.abs); if (escape) { log('edit-denied', { site: vault.slug, rel: t.rel, reason: 'link' }); return res.status(400).json({ error: escape }); }
    const confirmNeeded = needsConfirm(vault, t.rel, body.text, body.confirm);
    if (confirmNeeded) return res.status(428).json(confirmNeeded);
    let text = body.text;
    if (current) { try { if ((await fsp.readFile(t.abs, 'utf8')).includes('\r\n')) text = text.replace(/\r?\n/g, '\r\n'); } catch { /* keep LF */ } }
    try { await atomicWrite(t.abs, text); } catch (e) { log('edit-error', { site: vault.slug, rel: t.rel, message: e.message }); return res.status(500).json({ error: 'Could not write the note: ' + e.message }); }
    const stamp = await stampOf(t.abs);
    await vault.scan();
    log('edit', { site: vault.slug, user: req.user, rel: t.rel, action: current ? 'save' : 'create', bytes: Buffer.byteLength(text) });
    res.status(current ? 200 : 201).json({ ok: true, rel: t.rel, stamp, created: !current, url: vault.noteUrl(t.rel), editUrl: vault.editUrl(t.rel), title: vault.note(t.rel)?.title || t.rel });
  });

  // Delete = move to .trash/<same path>, like Obsidian. Nothing is destroyed.
  api.delete('/note', async (req, res) => {
    const vault = req.vault;
    const t = safeNoteRel(vault, req.query.rel, { strict: true }); if (t.error) return res.status(400).json({ error: t.error });
    if (!await stampOf(t.abs)) return res.status(404).json({ error: 'No such note' });
    let dest = path.join(vault.root, '.trash', t.rel);
    if (await stampOf(dest)) dest = dest.replace(/\.md$/i, `.${Date.now()}.md`);
    const escape = await linkEscape(vault, t.abs) || await linkEscape(vault, dest);
    if (escape) { log('edit-denied', { site: vault.slug, rel: t.rel, reason: 'link' }); return res.status(400).json({ error: escape }); }
    const confirmNeeded = needsConfirm(vault, t.rel, null, req.query.confirm);
    if (confirmNeeded) return res.status(428).json(confirmNeeded);
    try { await fsp.mkdir(path.dirname(dest), { recursive: true }); await fsp.rename(t.abs, dest); }
    catch (e) { log('edit-error', { site: vault.slug, rel: t.rel, message: e.message }); return res.status(500).json({ error: 'Could not move the note: ' + e.message }); }
    await vault.scan();
    log('edit', { site: vault.slug, user: req.user, rel: t.rel, action: 'trash' });
    res.json({ ok: true, rel: t.rel, trashed: path.relative(vault.root, dest).split(path.sep).join('/') });
  });

  // Live preview of unsaved text, rendered exactly like the page would be.
  api.post('/preview', async (req, res) => {
    const vault = req.vault; const body = req.body || {};
    const t = safeNoteRel(vault, body.rel, { strict: true }); if (t.error) return res.status(400).json({ error: t.error });
    if (typeof body.text !== 'string') return res.status(400).json({ error: 'text must be a string' });
    try {
      const r = await renderer.renderSource(vault, t.rel, body.text);
      res.json({ html: r.html, headings: r.headings, data: r.data, title: r.data && r.data.title != null ? String(r.data.title) : t.rel.replace(/.*\//, '').replace(/\.md$/i, '') });
    } catch (e) { res.status(500).json({ error: 'Render failed: ' + e.message }); }
  });

  // -- writing help (optional; only routed when `assist` is configured) ---------------
  if (assist) {
    // What the editor may ask for. No prompts and no key cross this line.
    api.get('/assist', (req, res) => res.json(assistLib.menu(assist)));

    api.post('/assist', assistLimiter.middleware(), async (req, res) => {
      const body = req.body || {};
      const t0 = Date.now();
      try {
        const out = await assistLib.run(assist, {
          action: String(body.action || ''),
          text: body.text,
          target: body.target,
          title: body.title,
        });
        log('assist', { site: req.vault.slug, user: req.user, action: String(body.action || ''), ms: Date.now() - t0, in: out.usage.input, out: out.usage.output });
        res.json(out);
      } catch (e) {
        // Only errors this project wrote are shown. A provider error is logged
        // in full and summarised to the browser: its text can carry request
        // detail, and its status codes mean something else on this API.
        const status = e.expose ? (e.status || 400) : 502;
        log('assist-failed', { site: req.vault.slug, user: req.user, action: String(body.action || ''), status, error: e.message });
        res.status(status).json({ error: e.expose ? e.message : 'The writing help is not available right now — the server log has the detail.' });
      }
    });
  }

  return { currentUser, assist };
}

module.exports = { install, resolveConfig, ipAllowed, safeNoteRel, linkEscape, isProtected, memoryWarnings, DEFAULT_PROTECT, makeSession, readSession, cookieName, obsidianSettings, anchorsOf, OBSIDIAN_DEFAULTS };
