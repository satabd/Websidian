// Client-side view of the vault for the editor: note and attachment lists
// (fetched once from the editor API), wikilink resolution with Obsidian's rules
// (same folder first, then the shortest path), link text generation that
// follows the vault's "new link format" setting, and fuzzy matching for
// suggestions. No CodeMirror imports here, so it is testable in Node.

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac', 'webm', '3gp']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'mkv', 'ogv']);

export function extOf(name) { const m = /\.([A-Za-z0-9]+)$/.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
export function fileKind(name) {
  const e = extOf(name);
  return IMAGE_EXT.has(e) ? 'image' : AUDIO_EXT.has(e) ? 'audio' : VIDEO_EXT.has(e) ? 'video' : e === 'pdf' ? 'pdf' : e === 'md' || !e ? 'note' : 'file';
}
const baseName = rel => rel.slice(rel.lastIndexOf('/') + 1);
const stripMd = s => s.replace(/\.md$/i, '');
const folderOf = rel => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '');

function normalise(p) {
  const out = [];
  for (const part of p.split('/')) { if (part === '..') out.pop(); else if (part && part !== '.') out.push(part); }
  return out.join('/');
}

// Parse "Note#Heading|Alias" (or "Note#^block") into its parts.
export function parseLinkTarget(raw) {
  let s = String(raw || ''); let alias = null;
  const bar = s.search(/\\?\|/);
  if (bar >= 0) { alias = s.slice(bar).replace(/^\\?\|/, ''); s = s.slice(0, bar); }
  const hash = s.indexOf('#');
  const path = (hash >= 0 ? s.slice(0, hash) : s).trim();
  const sub = hash >= 0 ? s.slice(hash + 1).trim() : '';
  return { path, heading: sub && !sub.startsWith('^') ? sub : null, block: sub.startsWith('^') ? sub.slice(1) : null, alias };
}

export class VaultIndex {
  constructor({ rel = '', base = '/', settings = {} } = {}) {
    this.rel = rel; this.base = base; this.settings = settings;
    this.notes = []; this.files = []; this.tags = []; this.properties = [];
    this.noteSet = new Set(); this.byBase = new Map(); this.fileSet = new Set(); this.fileByName = new Map();
    this.loaded = false;
  }

  setNotes(list) {
    this.notes = list || []; this.noteSet = new Set(this.notes.map(n => n.rel)); this.byBase = new Map();
    for (const n of this.notes) { const k = stripMd(baseName(n.rel)).toLowerCase(); if (!this.byBase.has(k)) this.byBase.set(k, []); this.byBase.get(k).push(n.rel); }
  }
  setFiles(list) {
    this.files = list || []; this.fileSet = new Set(this.files.map(f => f.rel)); this.fileByName = new Map();
    for (const f of this.files) { const k = baseName(f.rel).toLowerCase(); if (!this.fileByName.has(k)) this.fileByName.set(k, []); this.fileByName.get(k).push(f.rel); }
  }
  note(rel) { return this.notes.find(n => n.rel === rel) || null; }

  _best(cands) {
    if (!cands || !cands.length) return null;
    if (cands.length === 1) return cands[0];
    const dir = folderOf(this.rel);
    const same = cands.filter(c => c.startsWith(dir) && !c.slice(dir.length).includes('/'));
    if (same.length) return same[0];
    return [...cands].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  }

  resolveNote(target) {
    let t = String(target || '').trim().replace(/\\/g, '/').replace(/^\.?\//, '');
    if (!t) return null;
    t = stripMd(t);
    if (this.noteSet.has(t + '.md')) return t + '.md';
    const rel = normalise(folderOf(this.rel) + t) + '.md';
    if (this.noteSet.has(rel)) return rel;
    const b = baseName(t).toLowerCase();
    const cands = this.byBase.get(b);
    if (!cands) return null;
    if (t.includes('/')) { const suf = cands.filter(c => c.toLowerCase().endsWith(t.toLowerCase() + '.md')); if (suf.length) return this._best(suf); }
    return this._best(cands);
  }

  resolveFile(target) {
    const t = String(target || '').trim().replace(/\\/g, '/').replace(/^\.?\//, '');
    if (!t) return null;
    let dec = t; try { dec = decodeURIComponent(t); } catch { /* keep */ }
    for (const c of [t, dec]) {
      if (this.fileSet.has(c)) return c;
      const rel = normalise(folderOf(this.rel) + c); if (this.fileSet.has(rel)) return rel;
    }
    return this._best(this.fileByName.get(baseName(dec).toLowerCase()));
  }

  // { kind: 'note'|'file', rel } or null, like Vault#resolve on the server.
  resolve(target) {
    const { path } = parseLinkTarget(target);
    if (!path) return { kind: 'note', rel: this.rel, self: true };
    const e = extOf(path);
    if (e && e !== 'md') { const f = this.resolveFile(path); if (f) return { kind: 'file', rel: f }; }
    const n = this.resolveNote(path); if (n) return { kind: 'note', rel: n };
    const f = this.resolveFile(path); if (f) return { kind: 'file', rel: f };
    return null;
  }

  fileUrl(rel) { return this.base + rel.split('/').map(encodeURIComponent).join('/'); }
  editUrl(rel) { return this.base + '_edit/' + stripMd(rel).split('/').map(encodeURIComponent).join('/'); }

  // Text to put inside [[ ]] for a note or file, per Obsidian's "New link format".
  linkText(rel, { isFile = false } = {}) {
    const fmt = this.settings.newLinkFormat || 'shortest';
    const shown = isFile ? rel : stripMd(rel);
    if (fmt === 'absolute') return shown;
    if (fmt === 'relative') {
      const from = folderOf(this.rel).split('/').filter(Boolean), to = shown.split('/');
      let i = 0; while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
      return [...from.slice(i).map(() => '..'), ...to.slice(i)].join('/');
    }
    const b = baseName(shown);
    const dups = isFile ? (this.fileByName.get(baseName(rel).toLowerCase()) || []) : (this.byBase.get(b.toLowerCase()) || []);
    return dups.length > 1 ? shown : b;
  }
}

// Fuzzy score of `query` in `text` (higher is better), or -1 when not all
// characters appear in order. Rewards prefixes, word starts and runs.
export function fuzzyScore(query, text) {
  if (!query) return 0;
  const q = query.toLowerCase(), s = text.toLowerCase();
  const direct = s.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - (s.length - q.length) * 0.1 + (direct === 0 ? 200 : /[\s/_\-.(]/.test(s[direct - 1]) ? 100 : 0);
  let score = 0, si = 0, run = 0;
  for (const ch of q) {
    if (ch === ' ') { run = 0; continue; }
    const i = s.indexOf(ch, si);
    if (i < 0) return -1;
    run = i === si ? run + 1 : 0;
    score += 10 + run * 5 + (i === 0 || /[\s/_\-.(]/.test(s[i - 1]) ? 15 : 0) - Math.min(10, i - si);
    si = i + 1;
  }
  return score - s.length * 0.1;
}

// Best matches among items, by the best score over the given keys.
export function fuzzyFilter(query, items, keys, limit = 50) {
  const out = [];
  for (const it of items) {
    let best = -1;
    for (const [k, w] of keys) { const v = typeof k === 'function' ? k(it) : it[k]; if (!v) continue; const sc = fuzzyScore(query, String(v)); if (sc >= 0 && sc * w > best) best = sc * w; }
    if (best >= 0) out.push({ item: it, score: best });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit).map(x => x.item);
}

// Word and character counts the way Obsidian's status bar shows them (frontmatter excluded).
export function countText(text) {
  const body = String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '');
  const words = (body.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || []).length;
  return { words, chars: body.length };
}
