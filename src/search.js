'use strict';
// Full-text search per vault with MiniSearch: prefix + fuzzy matching, title
// boosted, snippets with the matched terms highlighted. The index is rebuilt
// lazily whenever the set of (note, stamp) pairs changes, i.e. after an edit.

const MiniSearch = require('minisearch');
const { escapeHtml } = require('./render');

class SearchIndex {
  constructor() { this.byVault = new Map(); }

  // docs: [{ rel, title, folder, text, stamp, lang }]
  _build(vault, docs) {
    const ms = new MiniSearch({
      fields: ['title', 'text', 'aliases'],
      storeFields: ['rel', 'title', 'folder', 'text', 'lang'],
      idField: 'rel',
      tokenize: s => s.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(t => t.length > 1),
      searchOptions: { boost: { title: 4, aliases: 3 }, prefix: true, fuzzy: term => (term.length > 4 ? 0.2 : false), combineWith: 'AND' },
    });
    ms.addAll(docs);
    return ms;
  }

  async ensure(vault, getEntry) {
    const notes = vault.visibleNotesSorted();
    const version = vault.listHash + '|' + notes.map(n => `${n.rel}@${n.mtimeMs}-${n.size}`).join(';');
    const cur = this.byVault.get(vault.slug);
    if (cur && cur.version === version) return cur.ms;
    const docs = [];
    for (const n of notes) {
      let e; try { e = await getEntry(vault, n.rel); } catch { continue; }
      const aliases = Array.isArray(n.data.aliases) ? n.data.aliases.join(' ') : String(n.data.aliases || '');
      docs.push({ rel: n.rel, title: n.title, folder: n.folder, text: e.text, aliases, lang: n.data.lang || '' });
    }
    const ms = this._build(vault, docs);
    this.byVault.set(vault.slug, { version, ms, builtAt: Date.now(), docs: docs.length });
    return ms;
  }

  query(ms, q, { limit = 25 } = {}) {
    const results = ms.search(q).slice(0, limit);
    return results.map(r => ({ rel: r.rel, title: r.title, folder: r.folder, lang: r.lang, score: Math.round(r.score * 100) / 100, terms: r.terms, snippet: snippet(r.text, r.terms) }));
  }
}

// ~160 chars around the first matched term, terms wrapped in <mark>. HTML-escaped.
function snippet(text, terms) {
  const t = String(text || ''); if (!t) return '';
  const lower = t.toLowerCase();
  let at = -1;
  for (const term of terms) { const i = lower.indexOf(term.toLowerCase()); if (i >= 0 && (at < 0 || i < at)) at = i; }
  const start = Math.max(0, (at < 0 ? 0 : at) - 60);
  let piece = t.slice(start, start + 170);
  if (start > 0) piece = '…' + piece;
  if (start + 170 < t.length) piece += '…';
  let html = escapeHtml(piece);
  if (terms.length) {
    const re = new RegExp('(' + terms.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'giu');
    html = html.replace(re, '<mark>$1</mark>');
  }
  return html;
}

module.exports = { SearchIndex, snippet };
