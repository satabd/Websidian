'use strict';
// Vault index: knows every file in an Obsidian vault, resolves wikilinks the
// way Obsidian does (by basename, shortest path wins), and watches the folder
// so the index refreshes when files are added, removed or renamed.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');

const NOTE_EXT = '.md';
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.avif']);

function toPosix(p) { return p.split(path.sep).join('/'); }

function parseFrontmatter(src) {
  if (!src.startsWith('---')) return { data: {}, body: src };
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { data: {}, body: src };
  let data = {};
  try { data = yaml.load(m[1]) || {}; } catch { data = {}; }
  if (typeof data !== 'object' || Array.isArray(data)) data = {};
  return { data, body: src.slice(m[0].length) };
}

function folderTitle(name, overrides) {
  if (overrides && overrides[name]) return overrides[name];
  return name.replace(/^\d+[-_. ]*/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || name;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// Targets of [[wikilinks]] and ![[embeds]] in a note body, without heading/alias parts.
function extractLinkTargets(body) {
  const out = [];
  const clean = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const m of clean.matchAll(/\[\[([^\]|#]+)/g)) { const t = m[1].trim(); if (t && !/\.(png|jpe?g|gif|svg|webp|pdf|mp4|mp3)$/i.test(t)) out.push(t); }
  return out;
}

// Tags of a note, Obsidian style: frontmatter `tags`/`tag` (list or comma/space
// separated, with or without #) plus inline #tags outside code. A tag needs at
// least one non-digit character; nested tags keep their slashes (#a/b).
const TAG_RE = /(^|[\s(,;])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;
function extractTags(body, data) {
  const out = new Set();
  for (const key of ['tags', 'tag']) {
    const v = data && data[key];
    const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : [];
    for (const t of list) { const s = String(t == null ? '' : t).trim().replace(/^#/, ''); if (s) out.add(s); }
  }
  const clean = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '').replace(/%%[\s\S]*?%%/g, '').replace(/\[[^\]\n]*\]\([^)\n]*\)/g, ' ');
  for (const m of clean.matchAll(TAG_RE)) out.add(m[2].replace(/\/+$/, ''));
  return [...out].filter(Boolean);
}

class Vault {
  constructor(site) {
    this.slug = site.slug;
    this.title = site.title || site.slug;
    this.root = path.resolve(site.root);
    this.home = site.home || null;
    this.exclude = site.exclude || [];
    this.excludeStatus = new Set(site.excludeStatus || []);
    this.onlyPublished = !!site.onlyPublished;
    this.folderNames = site.folderNames || {};
    this.codeLinks = site.codeLinks || null;
    this.basePath = (site.basePath || '').replace(/\/$/, '');
    this.brand = site.brand || {};
    this.auth = site.auth && (site.auth.users || site.auth.token) ? site.auth : null;
    this.webhook = site.webhook || null;
    this.edit = site.edit;          // editor settings; resolved in editor.js against the global `edit`
    this.untrusted = !!site.untrusted;
    this.snippetsCfg = site.snippets === undefined ? !site.untrusted : site.snippets; // untrusted: an agent could write CSS, so off unless asked // true = Obsidian's enabled ones, "all", [names], or false
    this.snippets = [];          // [{ name, abs, mtimeMs }] CSS snippets to include on every page
    this.backlinks = new Map();  // rel -> [rel of notes linking here]
    this.linkHash = '';
    this.notes = new Map();      // rel -> { rel, abs, base, title, folder, mtimeMs, size, data, hidden }
    this.files = new Map();      // rel -> { rel, abs, name, ext, mtimeMs, size } (non-note files)
    this.byBase = new Map();     // lower basename (no ext) -> [rel]
    this.fileByBase = new Map(); // lower filename (with ext) -> [rel]
    this.listHash = '';
    this.metaCache = new Map();  // rel -> { stamp, title, data }
    this.tree = null;
    this._rescanTimer = null;
    this._scanning = null;
    this.onChange = null;
  }

  isExcluded(rel, isDir) {
    const parts = rel.split('/');
    if (parts.some(p => p.startsWith('.'))) return true; // .obsidian, .trash, dotfiles
    for (const pat of this.exclude) {
      if (pat.startsWith('*.')) { if (!isDir && rel.toLowerCase().endsWith(pat.slice(1).toLowerCase())) return true; }
      else if (rel === pat || rel.startsWith(pat.replace(/\/$/, '') + '/')) return true;
    }
    return false;
  }

  async scan() {
    if (this._scanning) return this._scanning;
    this._scanning = this._scan().finally(() => { this._scanning = null; });
    return this._scanning;
  }

  async _scan() {
    const notes = new Map(), files = new Map();
    const walk = async (dir) => {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        const rel = toPosix(path.relative(this.root, abs));
        if (this.isExcluded(rel, e.isDirectory())) continue;
        if (e.isDirectory()) { await walk(abs); continue; }
        if (!e.isFile()) continue;
        let st; try { st = await fsp.stat(abs); } catch { continue; }
        const ext = path.extname(e.name).toLowerCase();
        const dir2 = toPosix(path.dirname(rel));
        const entry = { rel, abs, base: path.basename(e.name, ext), name: e.name, ext, mtimeMs: st.mtimeMs, size: st.size, folder: dir2 === '.' ? '' : dir2 };
        if (ext === NOTE_EXT) notes.set(rel, entry); else files.set(rel, entry);
      }
    };
    await walk(this.root);

    // Frontmatter titles for navigation; cached per file by mtime+size so a
    // rescan only re-reads notes that changed.
    for (const n of notes.values()) {
      const stamp = `${n.mtimeMs}-${n.size}`;
      let meta = this.metaCache.get(n.rel);
      if (!meta || meta.stamp !== stamp) {
        let data = {}, links = [], tags = [];
        try {
          const src = await fsp.readFile(n.abs, 'utf8');
          const parsed = parseFrontmatter(src); data = parsed.data;
          links = extractLinkTargets(parsed.body);
          tags = extractTags(parsed.body, data);
        } catch { /* unreadable: keep defaults */ }
        meta = { stamp, data, links, tags, title: (data.title != null ? String(data.title) : n.base) };
        this.metaCache.set(n.rel, meta);
      }
      n.title = meta.title; n.data = meta.data; n.tags = meta.tags;
      n.hidden = (this.excludeStatus.size > 0 && this.excludeStatus.has(String(meta.data.status)))
        || (this.onlyPublished && meta.data.publish !== true)
        || meta.data.publish === false
        || /\.excalidraw$/i.test(n.base) || meta.data['excalidraw-plugin'] !== undefined; // drawings are embedded, never pages
    }
    for (const rel of this.metaCache.keys()) if (!notes.has(rel)) this.metaCache.delete(rel);
    await this._scanSnippets();

    const byBase = new Map(), fileByBase = new Map();
    for (const n of notes.values()) { const k = n.base.toLowerCase(); if (!byBase.has(k)) byBase.set(k, []); byBase.get(k).push(n.rel); }
    for (const f of files.values()) { const k = f.name.toLowerCase(); if (!fileByBase.has(k)) fileByBase.set(k, []); fileByBase.get(k).push(f.rel); }

    const listHash = crypto.createHash('sha1').update([...notes.keys(), ...files.keys()].sort().join('\n')).digest('hex').slice(0, 12);
    const changed = listHash !== this.listHash;
    this.notes = notes; this.files = files; this.byBase = byBase; this.fileByBase = fileByBase;
    this.listHash = listHash; this.tree = null;

    // Backlinks: resolve every note's outgoing wikilinks now that the index is in place.
    const backlinks = new Map(); const pairs = [];
    for (const n of notes.values()) {
      const seen = new Set();
      for (const t of this.metaCache.get(n.rel).links) {
        const target = this.resolveNote(t, n.rel);
        if (!target || target === n.rel || seen.has(target)) continue;
        seen.add(target);
        if (!backlinks.has(target)) backlinks.set(target, []);
        backlinks.get(target).push(n.rel); pairs.push(n.rel + '>' + target);
      }
    }
    for (const list of backlinks.values()) list.sort((a, b) => collator.compare(a, b));
    this.backlinks = backlinks;
    this.linkHash = crypto.createHash('sha1').update(pairs.sort().join('\n')).digest('hex').slice(0, 12);
    if (changed && this.onChange) this.onChange();
    return this;
  }

  // Vault CSS snippets (.obsidian/snippets/*.css). By default the ones enabled
  // in Obsidian (appearance.json) are included on every page of this site.
  async _scanSnippets() {
    this.snippets = [];
    if (this.snippetsCfg === false) return;
    const dir = path.join(this.root, '.obsidian', 'snippets');
    let names = [];
    try { names = (await fsp.readdir(dir)).filter(f => f.toLowerCase().endsWith('.css')).map(f => f.slice(0, -4)); } catch { return; }
    let wanted;
    if (Array.isArray(this.snippetsCfg)) wanted = new Set(this.snippetsCfg);
    else if (this.snippetsCfg === 'all') wanted = new Set(names);
    else {
      try { const app = JSON.parse(await fsp.readFile(path.join(this.root, '.obsidian', 'appearance.json'), 'utf8')); wanted = new Set(app.enabledCssSnippets || []); } catch { wanted = new Set(); }
    }
    for (const name of names.sort()) {
      if (!wanted.has(name)) continue;
      const abs = path.join(dir, name + '.css');
      try { const st = await fsp.stat(abs); this.snippets.push({ name, abs, mtimeMs: st.mtimeMs }); } catch { /* skip */ }
    }
  }
  snippet(name) { return this.snippets.find(s => s.name === name) || null; }

  // Other-language editions of a note: explicit frontmatter (`translation:`,
  // `translations:` as a name, a list, or {lang: name}) plus a heuristic —
  // two notes with different `lang` that link to each other.
  translationsOf(rel) {
    const n = this.notes.get(rel); if (!n) return [];
    const out = new Map();
    const add = (target, langHint) => {
      const t = this.notes.get(target); if (!t || t.hidden || t.rel === rel) return;
      const lang = String(t.data.lang || langHint || '').trim(); if (!lang) return;
      if (!out.has(t.rel)) out.set(t.rel, { lang, rel: t.rel, title: t.title, url: this.noteUrl(t.rel) });
    };
    for (const key of ['translation', 'translations']) {
      const v = n.data[key]; if (v == null) continue;
      const each = (x, langHint) => { const s = String(x).replace(/^\[\[|\]\]$/g, '').split('|')[0]; const r = this.resolveNote(s, rel); if (r) add(r, langHint); };
      if (Array.isArray(v)) v.forEach(x => each(x));
      else if (typeof v === 'object') for (const [lang, name] of Object.entries(v)) each(name, lang);
      else each(v);
    }
    // Heuristic only for real language codes (en, ar, pt-BR…), so "bilingual" notes are not paired.
    const isLangCode = l => /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(l);
    const myLang = String(n.data.lang || '');
    if (isLangCode(myLang)) for (const t of this.metaCache.get(rel)?.links || []) {
      const target = this.resolveNote(t, rel); if (!target || target === rel) continue;
      const tn = this.notes.get(target); if (!tn || !tn.data.lang || !isLangCode(String(tn.data.lang)) || String(tn.data.lang) === myLang) continue;
      const back = (this.metaCache.get(target)?.links || []).some(x => this.resolveNote(x, target) === rel);
      if (back) add(target);
    }
    return [...out.values()].sort((a, b) => collator.compare(a.lang, b.lang));
  }

  // ---- lookup -------------------------------------------------------------

  note(rel) { return this.notes.get(rel) || null; }
  bases() { return [...this.files.values()].filter(f => f.ext === '.base').sort((a, b) => collator.compare(a.rel, b.rel)); }
  file(rel) { return this.files.get(rel) || null; }

  homeRel() {
    if (this.home) {
      const r = this.resolveNote(this.home, '');
      if (r) return r;
    }
    for (const cand of ['index', 'home', 'readme', 'start here']) {
      const hit = this.byBase.get(cand);
      if (hit) return hit[0];
    }
    const first = this.visibleNotesSorted()[0];
    return first ? first.rel : null;
  }

  visibleNotesSorted() {
    return [...this.notes.values()].filter(n => !n.hidden).sort((a, b) => collator.compare(a.rel, b.rel));
  }

  // Pick the best match among candidate relative paths: prefer the same folder
  // as the linking note, then the shortest path (Obsidian's rule).
  _best(cands, fromRel) {
    if (!cands || !cands.length) return null;
    if (cands.length === 1) return cands[0];
    const fromDir = fromRel ? fromRel.slice(0, fromRel.lastIndexOf('/') + 1) : '';
    const same = cands.filter(c => c.startsWith(fromDir) && !c.slice(fromDir.length).includes('/'));
    if (same.length) return same[0];
    return [...cands].sort((a, b) => a.length - b.length || collator.compare(a, b))[0];
  }

  resolveNote(target, fromRel) {
    let t = target.trim().replace(/\\/g, '/').replace(/^\.?\//, '');
    if (!t) return null;
    if (t.toLowerCase().endsWith(NOTE_EXT)) t = t.slice(0, -NOTE_EXT.length);
    if (this.notes.has(t + NOTE_EXT)) return t + NOTE_EXT;
    // relative to the linking note's folder
    if (fromRel) {
      const fromDir = fromRel.slice(0, fromRel.lastIndexOf('/') + 1);
      const rel = path.posix.normalize(fromDir + t) + NOTE_EXT;
      if (this.notes.has(rel)) return rel;
    }
    // by basename, case-insensitive
    const base = t.includes('/') ? t.slice(t.lastIndexOf('/') + 1) : t;
    const cands = this.byBase.get(base.toLowerCase());
    if (!cands) return null;
    if (t.includes('/')) {
      const suffix = cands.filter(c => c.toLowerCase().endsWith(t.toLowerCase() + NOTE_EXT));
      if (suffix.length) return this._best(suffix, fromRel);
    }
    return this._best(cands, fromRel);
  }

  resolveFile(target, fromRel) {
    const t = target.trim().replace(/\\/g, '/').replace(/^\.?\//, '');
    if (!t) return null;
    if (this.files.has(t)) return t;
    if (fromRel) {
      const fromDir = fromRel.slice(0, fromRel.lastIndexOf('/') + 1);
      const rel = path.posix.normalize(fromDir + t);
      if (this.files.has(rel)) return rel;
    }
    const name = t.includes('/') ? t.slice(t.lastIndexOf('/') + 1) : t;
    return this._best(this.fileByBase.get(name.toLowerCase()), fromRel);
  }

  // Resolve a wikilink target to { kind: 'note'|'file', rel } or null.
  resolve(target, fromRel) {
    const ext = path.posix.extname(target).toLowerCase();
    if (ext && ext !== NOTE_EXT) {
      const f = this.resolveFile(target, fromRel);
      if (f) return { kind: 'file', rel: f, isImage: IMAGE_EXT.has(ext) };
    }
    const n = this.resolveNote(target, fromRel);
    if (n) return { kind: 'note', rel: n };
    const f = this.resolveFile(target, fromRel);
    if (f) return { kind: 'file', rel: f, isImage: IMAGE_EXT.has(path.posix.extname(f).toLowerCase()) };
    return null;
  }

  // URL helpers ---------------------------------------------------------------
  siteUrl() { return this.basePath + '/' + this.slug + '/'; }
  noteUrl(rel) { return this.siteUrl() + rel.replace(/\.md$/i, '').split('/').map(encodeURIComponent).join('/'); }
  fileUrl(rel) { return this.siteUrl() + rel.split('/').map(encodeURIComponent).join('/'); }

  // Backlinks and folder neighbours, for the page footer.
  backlinksOf(rel) { return (this.backlinks.get(rel) || []).map(r => this.notes.get(r)).filter(n => n && !n.hidden); }
  neighbours(rel) {
    const n = this.notes.get(rel); if (!n) return { prev: null, next: null };
    const siblings = this.visibleNotesSorted().filter(x => x.folder === n.folder);
    const i = siblings.findIndex(x => x.rel === rel);
    return { prev: i > 0 ? siblings[i - 1] : null, next: i >= 0 && i < siblings.length - 1 ? siblings[i + 1] : null };
  }

  // Navigation tree: folders first, natural sort, hidden notes omitted.
  getTree() {
    if (this.tree) return this.tree;
    const root = { name: '', title: this.title, folders: new Map(), notes: [] };
    for (const n of this.visibleNotesSorted()) {
      let node = root;
      if (n.folder) for (const part of n.folder.split('/')) {
        if (!node.folders.has(part)) node.folders.set(part, { name: part, title: folderTitle(part, this.folderNames), folders: new Map(), notes: [] });
        node = node.folders.get(part);
      }
      node.notes.push({ rel: n.rel, title: n.title, url: this.noteUrl(n.rel), lang: n.data.lang });
    }
    for (const b of this.bases()) {
      let node = root;
      if (b.folder) for (const part of b.folder.split('/')) {
        if (!node.folders.has(part)) node.folders.set(part, { name: part, title: folderTitle(part, this.folderNames), folders: new Map(), notes: [] });
        node = node.folders.get(part);
      }
      node.notes.push({ rel: b.rel, title: b.base, url: this.fileUrl(b.rel), isBase: true });
    }
    const finish = node => {
      node.folders = [...node.folders.values()].sort((a, b) => collator.compare(a.name, b.name)).map(finish);
      node.notes.sort((a, b) => collator.compare(a.rel, b.rel));
      return node;
    };
    this.tree = finish(root);
    return this.tree;
  }

  // ---- watching -------------------------------------------------------------
  watch() {
    const schedule = () => { clearTimeout(this._rescanTimer); this._rescanTimer = setTimeout(() => this.scan().catch(() => {}), 400); };
    try {
      this._watcher = fs.watch(this.root, { recursive: true }, schedule);
      this._watcher.on('error', () => {});
    } catch (e) {
      console.warn(`[${this.slug}] fs.watch unavailable (${e.message}); falling back to periodic rescans`);
    }
    // Safety net for synced folders (Dropbox, network shares) where events can be missed.
    this._interval = setInterval(schedule, 60_000);
    if (this._interval.unref) this._interval.unref();
  }
}

module.exports = { Vault, parseFrontmatter, folderTitle, extractLinkTargets, extractTags, IMAGE_EXT, collator };
