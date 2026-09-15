// Text models behind the table editor and the Properties panel: parse the
// Markdown/YAML source, and compute the smallest edit for a change so the rest
// of the file stays byte-for-byte as it was (clean git diffs, nothing
// reformatted behind your back). No DOM and no CodeMirror here: testable in Node.

// ---- tables ---------------------------------------------------------------------------------

// Cells of one table row: [{ from, to, text }] with offsets into the line.
// Pipes escaped as \| belong to the cell (wikilink aliases in tables).
export function splitRow(line) {
  const pipes = [];
  for (let i = 0; i < line.length; i++) { if (line[i] === '\\') { i++; continue; } if (line[i] === '|') pipes.push(i); }
  const first = line.search(/\S/), last = line.trimEnd().length - 1;
  const lead = pipes.length > 0 && pipes[0] === first;
  const trail = pipes.length > 0 && pipes[pipes.length - 1] === last && !(lead && pipes.length === 1);
  const inner = pipes.filter((p, k) => !(lead && k === 0) && !(trail && k === pipes.length - 1));
  const bounds = []; let start = lead ? pipes[0] + 1 : 0;
  for (const p of inner) { bounds.push([start, p]); start = p + 1; }
  bounds.push([start, trail ? pipes[pipes.length - 1] : line.length]);
  return bounds.map(([from, to]) => ({ from, to, text: line.slice(from, to).trim() }));
}

export const unescapeCell = t => t.replace(/\\\|/g, '|');
export const escapeCell = t => String(t).replace(/\r?\n/g, ' ').replace(/\\\|/g, '|').replace(/\|/g, '\\|');

// { lines, offsets, rows (cells per line), aligns, cols } or null when it is not a table.
export function parseTable(src) {
  const lines = src.split('\n');
  if (lines.length < 2) return null;
  const offsets = []; let off = 0;
  for (const l of lines) { offsets.push(off); off += l.length + 1; }
  const rows = lines.map(splitRow);
  const delim = rows[1];
  if (!delim.every(c => /^:?-+:?$/.test(c.text))) return null;
  const aligns = delim.map(c => (/^:-+:$/.test(c.text) ? 'center' : /^:/.test(c.text) ? 'left' : /:$/.test(c.text) ? 'right' : null));
  return { lines, offsets, rows, aligns, cols: rows[0].length };
}

// Header, alignment and body as plain (unescaped) text, padded to the column count.
export function tableMatrix(model) {
  const pad = row => Array.from({ length: model.cols }, (_, c) => (row[c] ? unescapeCell(row[c].text) : ''));
  return { header: pad(model.rows[0]), aligns: Array.from({ length: model.cols }, (_, c) => model.aligns[c] || null), body: model.rows.slice(2).map(pad) };
}

const delimCell = a => (a === 'center' ? ':---:' : a === 'left' ? ':---' : a === 'right' ? '---:' : '---');
export function formatTable({ header, aligns, body }) {
  const row = cells => '| ' + cells.map(c => escapeCell(c)).join(' | ') + ' |';
  return [row(header), '| ' + aligns.map(delimCell).join(' | ') + ' |', ...body.map(row)].join('\n');
}

// The edit for one cell (r = line index: 0 header, 2.. body), relative to the table source.
export function cellChange(model, r, c, text) {
  const cells = model.rows[r]; const lineStart = model.offsets[r];
  if (cells && c < cells.length) {
    const cell = cells[c];
    return { from: lineStart + cell.from, to: lineStart + cell.to, insert: ' ' + escapeCell(text) + ' ' };
  }
  // A short row (fewer cells than the header): rewrite that line in full.
  const m = tableMatrix(model); const values = r === 0 ? m.header : m.body[r - 2];
  values[c] = text;
  const line = '| ' + values.map(escapeCell).join(' | ') + ' |';
  return { from: lineStart, to: lineStart + model.lines[r].length, insert: line };
}

// Structural edits return the whole new table source.
export function tableOp(model, op, at) {
  const m = tableMatrix(model);
  const blank = () => Array.from({ length: m.header.length }, () => '');
  switch (op) {
    case 'addRow': m.body.splice(Math.max(0, Math.min(m.body.length, at)), 0, blank()); break;
    case 'deleteRow': if (m.body.length > 0) m.body.splice(Math.max(0, Math.min(m.body.length - 1, at)), 1); break;
    case 'addCol': { const i = Math.max(0, Math.min(m.header.length, at)); m.header.splice(i, 0, ''); m.aligns.splice(i, 0, null); m.body.forEach(r => r.splice(i, 0, '')); break; }
    case 'deleteCol': if (m.header.length > 1) { const i = Math.max(0, Math.min(m.header.length - 1, at)); m.header.splice(i, 1); m.aligns.splice(i, 1); m.body.forEach(r => r.splice(i, 1)); } break;
    default: if (op.startsWith('align:')) { const a = op.slice(6); m.aligns[at] = a === 'none' ? null : a; }
  }
  return formatTable(m);
}

// ---- frontmatter properties ---------------------------------------------------------------------

// Split a frontmatter block ("---\n…\n---") into its YAML body and positions.
export function frontmatterParts(src) {
  const first = src.indexOf('\n');
  if (first < 0 || !/^---\s*$/.test(src.slice(0, first))) return null;
  const closeMatch = /(^|\n)(---|\.\.\.)[ \t]*$/.exec(src.slice(first));
  const bodyStart = first + 1;
  const closeAt = closeMatch ? first + closeMatch.index + (closeMatch[1] ? 1 : 0) : src.length;
  const bodyEnd = Math.max(bodyStart, closeAt - 1);   // the newline before the closing line
  return { bodyStart, bodyEnd: closeAt === bodyStart ? bodyStart : bodyEnd, body: closeAt > bodyStart ? src.slice(bodyStart, closeAt - 1) : '' };
}

const KEY_LINE = /^("[^"]*"|'[^']*'|[^\s#\-"'][^:]*?):(?:[ \t]+(.*?))?[ \t]*$/;
function unquote(s) {
  s = String(s).trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
  return s;
}
function splitInlineList(s) {
  const out = []; let cur = '', q = null;
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() || out.length) out.push(cur);
  return out.map(unquote).filter(x => x !== '');
}

// Entries of the YAML body: { key, kind: 'scalar'|'list'|'empty'|'raw', value, style, startLine, endLine }.
// Keys it cannot represent faithfully (nested maps, block scalars, comments) are 'raw': shown, left alone.
export function parseProperties(body) {
  const lines = body === '' ? [] : body.split('\n'); const entries = []; let cur = null;
  lines.forEach((line, i) => {
    const m = KEY_LINE.exec(line);
    if (m && !/^\s/.test(line)) { cur = { key: unquote(m[1]), inline: m[2] === undefined ? '' : m[2], startLine: i, endLine: i }; entries.push(cur); }
    else if (cur && cur.key !== null && (/^\s/.test(line) || /^-(\s|$)/.test(line) || line === '')) cur.endLine = i;
    else { cur = { key: null, inline: '', startLine: i, endLine: i }; entries.push(cur); }
  });
  for (const e of entries) {
    while (e.endLine > e.startLine && lines[e.endLine].trim() === '') e.endLine--;   // blank lines stay where they are
    const cont = lines.slice(e.startLine + 1, e.endLine + 1);
    e.raw = lines.slice(e.startLine, e.endLine + 1).join('\n');
    if (e.key === null) { e.kind = 'raw'; continue; }
    const v = e.inline.trim();
    if (!cont.length) {
      if (v === '') { e.kind = 'empty'; e.value = ''; }
      else if (/^\[.*\]$/.test(v)) { e.kind = 'list'; e.style = 'inline'; e.value = splitInlineList(v.slice(1, -1)); }
      else if (/^[|>][+-]?\d*$/.test(v) || /^[{&*!]/.test(v)) e.kind = 'raw';
      else { e.kind = 'scalar'; e.value = unquote(v); e.quoted = /^["']/.test(v); }
    } else if (v === '' && cont.every(l => /^\s*-(\s|$)/.test(l) || l.trim() === '')) {
      e.kind = 'list'; e.style = 'block';
      e.value = cont.filter(l => l.trim()).map(l => unquote(l.replace(/^\s*-\s?/, ''))).filter(x => x !== '');
    } else e.kind = 'raw';
  }
  return { lines, entries };
}

const LIST_KEYS = new Set(['tags', 'tag', 'aliases', 'alias', 'cssclasses', 'cssclass']);
// Obsidian property type: from .obsidian/types.json when known, else inferred from the value.
export function propertyType(entry, types = {}) {
  const t = types && types[entry.key];
  if (t) return t;
  const k = String(entry.key).toLowerCase();
  if (k === 'tags' || k === 'tag') return 'tags';
  if (k === 'aliases' || k === 'alias') return 'aliases';
  if (entry.kind === 'list' || LIST_KEYS.has(k)) return 'multitext';
  if (entry.kind !== 'scalar') return entry.kind === 'raw' ? 'raw' : 'text';
  const v = String(entry.value);
  if (!entry.quoted && /^(true|false)$/i.test(v)) return 'checkbox';
  if (!entry.quoted && /^-?\d+(\.\d+)?$/.test(v)) return 'number';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'date';
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) return 'datetime';
  return 'text';
}
export const isListType = t => t === 'multitext' || t === 'tags' || t === 'aliases';

// YAML scalar, quoted only when YAML would otherwise read it differently.
export function yamlScalar(v, type = 'text') {
  const s = String(v == null ? '' : v);
  if (s === '') return '';
  if (type === 'number' || type === 'checkbox') return s;
  const risky = /^[\s\-?:,[\]{}#&*!|>'"%@`]|[\s]$|: | #|^\[\[/.test(s)
    || (type !== 'date' && type !== 'datetime' && /^(true|false|yes|no|on|off|null|~|-?\d+(\.\d+)?)$/i.test(s))
    || /[\n\t]/.test(s);
  return risky ? JSON.stringify(s) : s;
}
export function yamlKey(k) { return /^[^\s#\-"'][^:]*$/.test(k) && !/\s$/.test(k) ? k : JSON.stringify(k); }

export function serializeEntry(key, type, value, { style = 'block' } = {}) {
  if (isListType(type)) {
    const items = (Array.isArray(value) ? value : []).map(x => String(x).trim()).filter(Boolean)
      .map(x => (type === 'tags' ? x.replace(/^#/, '') : x));
    if (!items.length) return yamlKey(key) + ':';
    if (style === 'inline') return `${yamlKey(key)}: [${items.map(x => yamlScalar(x)).join(', ')}]`;
    return yamlKey(key) + ':\n' + items.map(x => '  - ' + yamlScalar(x)).join('\n');
  }
  if (type === 'checkbox') return `${yamlKey(key)}: ${value === true || value === 'true' ? 'true' : 'false'}`;
  const s = yamlScalar(value, type);
  return s === '' ? yamlKey(key) + ':' : `${yamlKey(key)}: ${s}`;
}

// Offsets of line i in the body.
function lineOffsets(lines) { const o = []; let off = 0; for (const l of lines) { o.push(off); off += l.length + 1; } return o; }

// Edit that replaces one entry (by index) with `text`, relative to the body; text === null deletes it.
export function entryChange(parsed, index, text) {
  const e = parsed.entries[index]; const o = lineOffsets(parsed.lines);
  const from = o[e.startLine], to = o[e.endLine] + parsed.lines[e.endLine].length;
  if (text !== null) return { from, to, insert: text };
  // delete the entry's lines including one newline
  const total = parsed.lines.join('\n').length;
  if (to < total) return { from, to: to + 1, insert: '' };
  return { from: Math.max(0, from - 1), to, insert: '' };
}

// Edit that appends a new entry at the end of the body.
export function appendEntry(parsed, text) {
  const total = parsed.lines.join('\n').length;
  return parsed.lines.length ? { from: total, to: total, insert: '\n' + text } : { from: 0, to: 0, insert: text + '\n' };
}
