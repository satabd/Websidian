// Live Preview block editors, as in Obsidian:
//   TableWidget       a Markdown table shown as a grid you edit in place (Tab/Enter to move,
//                     toolbar to add/remove rows and columns, align, or edit as Markdown)
//   PropertiesWidget  the frontmatter as Obsidian's Properties panel (text, lists as pills,
//                     checkboxes, dates, numbers; add, rename, remove; or edit as YAML)
// Every edit becomes the smallest change to the note text (see blocks-model.js), so undo,
// save, conflicts and the reading view all keep working on plain Markdown.
import { WidgetType } from '@codemirror/view';
import { undo, redo } from '@codemirror/commands';
import {
  parseTable, cellChange, tableOp, unescapeCell,
  frontmatterParts, parseProperties, propertyType, isListType, serializeEntry, entryChange, appendEntry, yamlKey,
} from './blocks-model.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const isMod = e => e.ctrlKey || e.metaKey;

// Inline Markdown inside table cells when they are not being edited.
export function renderInline(src, ctx = {}) {
  const index = ctx.index;
  let s = esc(src); const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0001${codes.push(c) - 1}\u0002`);
  s = s.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  s = s.replace(/(!?)\[\[([^\]]+?)\]\]/g, (m, bang, inner) => {
    const [target, alias] = inner.split(/\\?\|/);
    const r = index && index.loaded ? index.resolve(target) : null;
    if (bang && r && r.kind === 'file' && /\.(png|jpe?g|gif|svg|webp|avif|bmp)$/i.test(r.rel)) {
      const w = /^\d+$/.test(alias || '') ? ` width="${alias}"` : '';
      return `<img class="ws-cell-img" src="${esc(index.fileUrl(r.rel))}" alt=""${w}>`;
    }
    const unresolved = index && index.loaded && !r ? ' is-unresolved' : '';
    const label = alias && !/^\d+$/.test(alias) ? alias : target.replace(/#\^?/, ' › ');
    return `<a class="internal-link${unresolved}" data-wikilink="${target}">${label}</a>`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, '<a class="external-link" data-href="$2">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>').replace(/==([^=]+)==/g, '<mark>$1</mark>');
  s = s.replace(/(^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu, '$1<span class="tag">#$2</span>');
  return s.replace(/\u0001(\d+)\u0002/g, (_, i) => `<code>${codes[i]}</code>`);
}

// Ctrl/Cmd+click on a link inside a widget follows it (a plain click edits).
function linkClick(e, ctx) {
  const a = e.target instanceof Element ? e.target.closest('a[data-wikilink], a[data-href]') : null;
  if (!a || !isMod(e) || !ctx.openLink) return false;
  e.preventDefault(); e.stopPropagation();
  if (a.hasAttribute('data-wikilink')) ctx.openLink({ type: 'wiki', target: a.getAttribute('data-wikilink'), newTab: true });
  else ctx.openLink({ type: 'url', href: a.getAttribute('data-href'), newTab: true });
  return true;
}

// Caret offset inside a plain-text contenteditable, and setting it back.
function caretOffset(node) {
  const sel = node.ownerDocument.getSelection(); if (!sel || !sel.rangeCount || !node.contains(sel.anchorNode)) return null;
  const r = sel.getRangeAt(0).cloneRange(); r.selectNodeContents(node); r.setEnd(sel.anchorNode, sel.anchorOffset);
  return r.toString().length;
}
function setCaret(node, offset) {
  const doc = node.ownerDocument; const range = doc.createRange(); let left = offset == null ? Infinity : offset; let placed = false;
  const walk = n => {
    if (placed) return;
    if (n.nodeType === 3) { if (left <= n.length) { range.setStart(n, left); placed = true; } else left -= n.length; }
    else for (const c of n.childNodes) walk(c);
  };
  walk(node);
  if (!placed) { range.selectNodeContents(node); range.collapse(false); } else range.collapse(true);
  const sel = doc.getSelection(); sel.removeAllRanges(); sel.addRange(range);
}
function plainEditable(node) {
  try { node.contentEditable = 'plaintext-only'; } catch { node.contentEditable = 'true'; }
  if (node.contentEditable !== 'plaintext-only') {
    node.contentEditable = 'true';
    node.addEventListener('paste', e => { e.preventDefault(); document.execCommand('insertText', false, (e.clipboardData.getData('text/plain') || '').replace(/\r?\n/g, ' ')); });
  }
}

// Move the editor cursor out of a widget, above (-1) or below (1) it.
function leave(view, dom, length, dir) {
  const from = view.posAtDOM(dom); const doc = view.state.doc;
  const pos = dir < 0 ? Math.max(0, from - 1) : Math.min(doc.length, from + length + 1);
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  view.focus();
}
// Reveal the Markdown of a widget (the cursor inside its range makes Live Preview show the source).
function revealSource(view, dom, offset = 0) {
  view.dispatch({ selection: { anchor: view.posAtDOM(dom) + offset }, scrollIntoView: true });
  view.focus();
}

// ---- table ------------------------------------------------------------------------------------

export class TableWidget extends WidgetType {
  constructor(src, ctx) { super(); this.src = src; this.ctx = ctx; }
  eq(o) { return o.src === this.src; }
  get estimatedHeight() { return Math.max(1, this.src.split('\n').length - 1) * 36 + 44; }
  ignoreEvent() { return true; }
  toDOM(view) {
    const dom = el('div', 'cm-embed-block cm-table-widget markdown-rendered');
    dom._ws = { src: this.src, ctx: this.ctx, view, last: { r: 2, c: 0 }, composing: false };
    buildTable(dom);
    return dom;
  }
  updateDOM(dom, view) {
    const st = dom._ws; if (!st) return false;
    const prev = st.src; st.src = this.src; st.ctx = this.ctx; st.view = view;
    if (prev !== this.src && !quietTable(dom, prev, this.src)) buildTable(dom);
    return true;
  }
}

// After a keystroke in a cell the only change is that cell: keep the DOM (and the caret) as it is.
function quietTable(dom, prev, next) {
  const a = document.activeElement; if (!a || !dom.contains(a) || !a.dataset.cell) return false;
  const pm = parseTable(prev), nm = parseTable(next); if (!pm || !nm || pm.rows.length !== nm.rows.length || pm.cols !== nm.cols) return false;
  const [fr, fc] = a.dataset.cell.split(':').map(Number);
  for (let r = 0; r < nm.rows.length; r++) {
    if (r === 1) continue;
    for (let c = 0; c < nm.cols; c++) {
      const pt = pm.rows[r][c] ? pm.rows[r][c].text : '', nt = nm.rows[r][c] ? nm.rows[r][c].text : '';
      if (r === fr && c === fc) { if (unescapeCell(nt) !== a.textContent.replace(/\n/g, ' ').trim()) return false; }
      else if (pt !== nt) return false;
    }
  }
  if (pm.aligns.join() !== nm.aligns.join()) return false;
  return true;
}

function buildTable(dom) {
  const st = dom._ws; const { ctx, view } = st;
  const model = parseTable(st.src);
  // Remember focus so a rebuild (undo, row added…) puts the caret back where it was.
  const a = document.activeElement; let focus = st.pending || null;
  if (!focus && a && dom.contains(a) && a.dataset.cell) { const [r, c] = a.dataset.cell.split(':').map(Number); focus = { r, c, caret: caretOffset(a) }; }
  st.pending = null;
  dom.textContent = '';
  if (!model) { dom.appendChild(el('pre', 'ws-table-raw', st.src)); return; }

  const toolbar = el('div', 'ws-table-toolbar');
  const btn = (label, title, fn) => { const b = el('button', 'ws-table-btn', label); b.type = 'button'; b.title = title; b.addEventListener('mousedown', e => e.preventDefault()); b.addEventListener('click', fn); toolbar.appendChild(b); return b; };
  const op = (name, at, focusAfter) => () => {
    const m = parseTable(st.src); if (!m) return;
    const from = view.posAtDOM(dom); const next = tableOp(m, name, at());
    st.pending = focusAfter ? focusAfter() : { r: st.last.r, c: st.last.c };
    view.dispatch({ changes: { from, to: from + st.src.length, insert: next }, userEvent: 'input.table' });
  };
  const bodyIndex = () => Math.max(0, st.last.r - 2);
  btn('+ Row', 'Add a row below the current one', op('addRow', () => (st.last.r < 2 ? 0 : bodyIndex() + 1), () => ({ r: Math.max(2, st.last.r + 1), c: st.last.c })));
  btn('− Row', 'Delete the current row', op('deleteRow', bodyIndex, () => ({ r: Math.max(2, st.last.r - 1), c: st.last.c })));
  btn('+ Column', 'Add a column right of the current one', op('addCol', () => st.last.c + 1, () => ({ r: st.last.r, c: st.last.c + 1 })));
  btn('− Column', 'Delete the current column', op('deleteCol', () => st.last.c, () => ({ r: st.last.r, c: Math.max(0, st.last.c - 1) })));
  btn('⇤', 'Align column left', op('align:left', () => st.last.c));
  btn('↔', 'Center column', op('align:center', () => st.last.c));
  btn('⇥', 'Align column right', op('align:right', () => st.last.c));
  btn('</>', 'Edit the table as Markdown', () => revealSource(view, dom, 1));

  const wrap = el('div', 'table-wrapper');
  const table = el('table', 'table-editor'); table.dir = 'auto';   // an Arabic table runs right to left
  const thead = el('thead'), tbody = el('tbody');
  const rowIdx = [0, ...model.rows.map((_, i) => i).slice(2)];
  const cellEls = new Map();
  for (const r of rowIdx) {
    const tr = el('tr');
    for (let c = 0; c < model.cols; c++) {
      const td = el(r === 0 ? 'th' : 'td');
      const align = model.aligns[c]; if (align) td.style.textAlign = align;
      const raw = model.rows[r][c] ? unescapeCell(model.rows[r][c].text) : '';
      const cell = el('div', 'table-cell-wrapper');
      cell.dataset.cell = `${r}:${c}`; cell._raw = raw; cell.dir = 'auto';
      cell.innerHTML = renderInline(raw, ctx);
      plainEditable(cell);
      cell.spellcheck = true;
      wireCell(dom, cell, r, c);
      cellEls.set(cell.dataset.cell, cell);
      td.appendChild(cell); tr.appendChild(td);
    }
    (r === 0 ? thead : tbody).appendChild(tr);
  }
  table.append(thead, tbody); wrap.appendChild(table); dom.append(toolbar, wrap);

  if (focus) {
    const target = cellEls.get(`${focus.r}:${focus.c}`) || cellEls.get(`${Math.min(focus.r, rowIdx[rowIdx.length - 1])}:${Math.min(focus.c, model.cols - 1)}`);
    if (target) { enterCell(target); target.focus(); setCaret(target, focus.caret); }
  }
}

function enterCell(cell) { if (!cell.classList.contains('is-editing')) { cell.textContent = cell._raw; cell.classList.add('is-editing'); } }

// Offset in the rendered text of a click, then the matching offset in the Markdown source
// (skipping the markup the rendering hid: **, [[ ]], link targets…), so the caret lands where you clicked.
function renderedOffsetAt(cell, x, y) {
  let node = null, offset = 0;
  if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (p) { node = p.offsetNode; offset = p.offset; } }
  else if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); if (r) { node = r.startContainer; offset = r.startOffset; } }
  if (!node || !cell.contains(node)) return null;
  const range = document.createRange(); range.selectNodeContents(cell); range.setEnd(node, offset);
  return range.toString().length;
}
export function sourceOffset(raw, rendered, off) {
  let i = 0, j = 0;
  while (j < off && i < raw.length) { if (raw[i] === rendered[j]) j++; i++; }
  return i;
}

function wireCell(dom, cell, r, c) {
  const st = dom._ws;
  const focusCell = (rr, cc, atEnd = true) => {
    const t = dom.querySelector(`[data-cell="${rr}:${cc}"]`); if (!t) return false;
    enterCell(t); t.focus(); setCaret(t, atEnd ? null : 0); return true;
  };
  cell.addEventListener('mousedown', e => {
    if (linkClick(e, st.ctx) || e.button !== 0 || cell.classList.contains('is-editing')) return;
    // First click into a rendered cell: switch it to its Markdown and put the caret at the clicked character.
    const off = renderedOffsetAt(cell, e.clientX, e.clientY);
    const rendered = cell.textContent;
    e.preventDefault();
    enterCell(cell); cell.focus();
    setCaret(cell, off == null ? null : sourceOffset(cell._raw, rendered, off));
  });
  cell.addEventListener('focus', () => { st.last = { r, c }; if (!cell.classList.contains('is-editing')) { enterCell(cell); setCaret(cell, null); } });
  cell.addEventListener('blur', () => { cell.classList.remove('is-editing'); cell._raw = cell.textContent.replace(/\n/g, ' ').trim(); cell.innerHTML = renderInline(cell._raw, st.ctx); });
  cell.addEventListener('compositionstart', () => { st.composing = true; });
  cell.addEventListener('compositionend', () => { st.composing = false; commit(); });
  cell.addEventListener('input', () => { if (!st.composing) commit(); });
  function commit() {
    const m = parseTable(st.src); if (!m) return;
    const text = cell.textContent.replace(/\n/g, ' ').trim();
    const cur = m.rows[r] && m.rows[r][c] ? unescapeCell(m.rows[r][c].text) : '';
    if (text === cur) return;
    cell._raw = text;
    const ch = cellChange(m, r, c, text); const from = st.view.posAtDOM(dom);
    st.view.dispatch({ changes: { from: from + ch.from, to: from + ch.to, insert: ch.insert }, userEvent: 'input.table' });
  }
  cell.addEventListener('keydown', e => {
    const m = parseTable(st.src); if (!m) return;
    const lastRow = m.rows.length - 1;
    const addRowAndGo = cc => { st.pending = { r: lastRow + 1, c: cc, caret: 0 }; const from = st.view.posAtDOM(dom); st.view.dispatch({ changes: { from, to: from + st.src.length, insert: tableOp(m, 'addRow', m.rows.length - 2) }, userEvent: 'input.table' }); };
    const next = dr => (r === 0 ? (dr > 0 ? 2 : -1) : r + dr === 1 ? 0 : r + dr);
    if (isMod(e) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(st.view); return; }
      if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(st.view); return; }
      if (k === 'b' || k === 'i') {
        e.preventDefault(); const mark = k === 'b' ? '**' : '*'; const sel = document.getSelection().toString();
        document.execCommand('insertText', false, mark + sel + mark); return;
      }
      return;   // Ctrl+S etc. bubble up to the page
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (!e.shiftKey) { if (c < m.cols - 1) focusCell(r, c + 1); else if (r < lastRow) focusCell(next(1), 0); else addRowAndGo(0); }
      else if (c > 0) focusCell(r, c - 1); else if (r > 0) focusCell(next(-1), m.cols - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) { document.execCommand('insertText', false, '<br>'); return; }
      if (r < lastRow) focusCell(next(1), c); else addRowAndGo(c);
    } else if (e.key === 'ArrowUp' && !e.shiftKey) {
      e.preventDefault(); if (r === 0) leave(st.view, dom, st.src.length, -1); else focusCell(next(-1), c);
    } else if (e.key === 'ArrowDown' && !e.shiftKey) {
      e.preventDefault(); if (r === lastRow) leave(st.view, dom, st.src.length, 1); else focusCell(next(1), c);
    } else if (e.key === 'Escape') {
      e.preventDefault(); leave(st.view, dom, st.src.length, 1);
    }
  });
}

// ---- properties ---------------------------------------------------------------------------------

const TYPE_ICON = { text: '≡', multitext: '☰', tags: '#', aliases: '↪', number: '№', checkbox: '☑', date: '◷', datetime: '◷', raw: '{ }' };

export class PropertiesWidget extends WidgetType {
  constructor(src, ctx) { super(); this.src = src; this.ctx = ctx; }
  eq(o) { return o.src === this.src; }
  get estimatedHeight() { return 44 + Math.max(1, (this.src.match(/\n[^\s-]/g) || []).length) * 34; }
  ignoreEvent() { return true; }
  toDOM(view) {
    const dom = el('div', 'metadata-container cm-embed-block');
    dom.setAttribute('data-property-count', '0');
    dom._ws = { src: this.src, ctx: this.ctx, view, collapsed: false, adding: false };
    buildProps(dom);
    return dom;
  }
  updateDOM(dom, view) {
    const st = dom._ws; if (!st) return false;
    const prev = st.src; st.src = this.src; st.ctx = this.ctx; st.view = view;
    if (prev !== this.src && !quietProps(dom, prev, this.src)) buildProps(dom);
    return true;
  }
}

function propsOf(src) { const p = frontmatterParts(src); return p ? { parts: p, parsed: parseProperties(p.body) } : null; }

// Typing in a text value only changes that value: keep the DOM and the caret.
function quietProps(dom, prev, next) {
  const a = document.activeElement; if (!a || !dom.contains(a) || !a.dataset.fid) return false;
  const pp = propsOf(prev), np = propsOf(next); if (!pp || !np || pp.parsed.entries.length !== np.parsed.entries.length) return false;
  const [key, field] = JSON.parse(a.dataset.fid);
  for (let i = 0; i < np.parsed.entries.length; i++) {
    const pe = pp.parsed.entries[i], ne = np.parsed.entries[i];
    if (pe.key !== ne.key) return false;
    if (ne.key === key && field === 'value') { if (String(ne.value ?? '') !== a.value) return false; }
    else if (pe.raw !== ne.raw) return false;
  }
  return true;
}

function buildProps(dom) {
  const st = dom._ws; const { view, ctx } = st; const types = (ctx.settings && ctx.settings.propertyTypes) || {};
  const a = document.activeElement; let focus = st.pending || null;
  if (!focus && a && dom.contains(a) && a.dataset.fid) focus = { fid: a.dataset.fid, caret: a.selectionStart };
  st.pending = null;
  dom.textContent = '';
  const model = propsOf(st.src);
  if (!model) { dom.appendChild(el('pre', 'ws-table-raw', st.src)); return; }
  const { parts, parsed } = model;
  dom.setAttribute('data-property-count', String(parsed.entries.filter(e => e.key !== null).length));

  // Apply an edit to the YAML body (positions from the current source).
  const apply = (change) => {
    const now = frontmatterParts(st.src); if (!now) return;
    const from = view.posAtDOM(dom) + now.bodyStart;
    view.dispatch({ changes: { from: from + change.from, to: from + change.to, insert: change.insert }, userEvent: 'input.property' });
  };
  const current = key => { const m = propsOf(st.src); if (!m) return null; const i = m.parsed.entries.findIndex(e => e.key === key); return i < 0 ? null : { m, i, e: m.parsed.entries[i] }; };
  const setValue = (key, type, value) => {
    const c = current(key); if (!c) return;
    apply(entryChange(c.m.parsed, c.i, serializeEntry(key, type, value, { style: c.e.style || 'block' })));
  };

  const heading = el('div', 'metadata-properties-heading');
  const collapse = el('span', 'collapse-indicator' + (st.collapsed ? ' is-collapsed' : ''), st.collapsed ? '›' : '⌄');
  const title = el('span', 'metadata-properties-title', 'Properties');
  const yamlBtn = el('button', 'ws-prop-source', '</>'); yamlBtn.type = 'button'; yamlBtn.title = 'Edit the properties as YAML';
  heading.append(collapse, title, yamlBtn);
  heading.addEventListener('mousedown', e => e.preventDefault());
  heading.addEventListener('click', e => {
    if (e.target === yamlBtn) { revealSource(view, dom, 4); return; }
    st.collapsed = !st.collapsed; buildProps(dom); view.requestMeasure();
  });
  dom.appendChild(heading);
  if (st.collapsed) { dom.classList.add('is-collapsed'); return; }
  dom.classList.remove('is-collapsed');

  const content = el('div', 'metadata-content'); const list = el('div', 'metadata-properties');
  const lists = new Map();
  const suggestions = (key, type) => {
    const id = 'ws-dl-' + key.replace(/[^\w-]/g, '_');
    if (!lists.has(id)) {
      const dl = el('datalist'); dl.id = id; content.appendChild(dl); lists.set(id, dl);
      const fill = vals => { dl.textContent = ''; for (const v of vals.slice(0, 200)) { const o = el('option'); o.value = v; dl.appendChild(o); } };
      if (type === 'tags' && ctx.tags) ctx.tags().then(ts => fill(ts.map(t => t.tag)));
      else if (ctx.properties) ctx.properties().then(ps => { const p = ps.find(x => x.name === key); fill(p ? p.values : []); });
    }
    return id;
  };

  for (const e of parsed.entries) {
    if (e.key === null) continue;
    const type = propertyType(e, types);
    const row = el('div', 'metadata-property'); row.dataset.propertyKey = e.key; row.dataset.propertyType = type;
    const keyBox = el('div', 'metadata-property-key');
    const icon = el('span', 'metadata-property-icon', TYPE_ICON[type] || '≡'); icon.title = type;
    const keyInput = el('input', 'metadata-property-key-input'); keyInput.dir = 'auto'; keyInput.value = e.key; keyInput.dataset.fid = JSON.stringify([e.key, 'key']); keyInput.spellcheck = false;
    keyInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); keyInput.blur(); } if (ev.key === 'Escape') { keyInput.value = e.key; keyInput.blur(); } });
    keyInput.addEventListener('change', () => {
      const nk = keyInput.value.trim(); if (!nk || nk === e.key) { keyInput.value = e.key; return; }
      if (current(nk)) { keyInput.value = e.key; keyInput.setCustomValidity('That property already exists'); return; }
      const c = current(e.key); if (!c) return;
      // Only the key text changes; the value lines stay exactly as they were.
      const first = c.m.parsed.lines[c.e.startLine];
      const renamed = first.replace(/^("[^"]*"|'[^']*'|[^:]+):/, () => yamlKey(nk) + ':');
      apply(entryChange(c.m.parsed, c.i, renamed + c.e.raw.slice(first.length)));
    });
    keyBox.append(icon, keyInput);
    const valueBox = el('div', 'metadata-property-value');
    valueBox.appendChild(valueEditor(e, type));
    const remove = el('button', 'metadata-property-remove', '×'); remove.type = 'button'; remove.title = 'Remove property';
    remove.addEventListener('mousedown', ev => ev.preventDefault());
    remove.addEventListener('click', () => { const c = current(e.key); if (c) apply(entryChange(c.m.parsed, c.i, null)); });
    row.append(keyBox, valueBox, remove);
    list.appendChild(row);
  }

  function valueEditor(e, type) {
    const fid = JSON.stringify([e.key, 'value']);
    if (type === 'raw') {
      const code = el('code', 'ws-prop-raw', e.raw.split('\n').slice(0, 4).join('\n') + (e.raw.split('\n').length > 4 ? '\n…' : ''));
      code.title = 'Complex value: click to edit as YAML'; code.addEventListener('click', () => revealSource(view, dom, 4));
      return code;
    }
    if (isListType(type)) {
      const box = el('div', 'multi-select-container');
      const items = e.kind === 'list' ? e.value.slice() : (e.kind === 'scalar' && e.value !== '' ? [String(e.value)] : []);
      items.forEach((item, k) => {
        const pill = el('div', 'multi-select-pill' + (type === 'tags' ? ' is-tag' : ''));
        const text = el('span', 'multi-select-pill-content', type === 'tags' ? item.replace(/^#?/, '') : item); text.dir = 'auto';
        const x = el('span', 'multi-select-pill-remove-button', '×'); x.title = 'Remove';
        x.addEventListener('mousedown', ev => ev.preventDefault());
        x.addEventListener('click', () => { const next = items.slice(); next.splice(k, 1); st.pending = { fid }; setValue(e.key, type, next); });
        pill.append(text, x); box.appendChild(pill);
      });
      const input = el('input', 'multi-select-input'); input.dir = 'auto'; input.dataset.fid = fid; input.placeholder = items.length ? '' : 'Empty';
      input.setAttribute('list', suggestions(e.key, type));
      const add = () => { const v = input.value.trim().replace(/,$/, ''); if (!v) return; input.value = ''; st.pending = { fid }; setValue(e.key, type, [...items, v]); };
      input.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' || ev.key === ',') { ev.preventDefault(); add(); }
        else if (ev.key === 'Backspace' && !input.value && items.length) { ev.preventDefault(); st.pending = { fid }; setValue(e.key, type, items.slice(0, -1)); }
      });
      input.addEventListener('change', add);
      box.appendChild(input);
      box.addEventListener('mousedown', ev => { if (ev.target === box) { ev.preventDefault(); input.focus(); } });
      return box;
    }
    if (type === 'checkbox') {
      const box = el('input', 'metadata-input-checkbox'); box.type = 'checkbox'; box.dataset.fid = fid;
      box.checked = /^true$/i.test(String(e.value));
      box.addEventListener('change', () => { st.pending = { fid }; setValue(e.key, type, box.checked); });
      return box;
    }
    const input = el('input', 'metadata-input metadata-input-' + type); input.dir = 'auto'; input.dataset.fid = fid;
    input.type = type === 'number' ? 'number' : type === 'date' ? 'date' : type === 'datetime' ? 'datetime-local' : 'text';
    input.value = e.kind === 'scalar' ? String(e.value) : '';
    if (type === 'datetime') input.value = input.value.replace(' ', 'T').slice(0, 16);
    input.placeholder = 'Empty'; input.spellcheck = type === 'text';
    if (type === 'text') input.setAttribute('list', suggestions(e.key, type));
    if (type === 'text' || type === 'number') input.addEventListener('input', () => setValue(e.key, type, input.value));
    else input.addEventListener('change', () => { st.pending = { fid }; setValue(e.key, type, input.value); });
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === 'Escape') { ev.preventDefault(); leave(view, dom, st.src.length, 1); } });
    return input;
  }

  // "+ Add property": name first, then the value.
  const addRow = el('div', 'metadata-add-property');
  if (st.adding) {
    const nk = el('input', 'metadata-property-key-input ws-new-key'); nk.placeholder = 'Property name'; nk.dataset.fid = JSON.stringify(['', 'new']);
    const commitNew = () => {
      const k = nk.value.trim(); st.adding = false;
      if (!k || current(k)) { buildProps(dom); return; }
      const m = propsOf(st.src); st.pending = { fid: JSON.stringify([k, 'value']) };
      apply(appendEntry(m.parsed, serializeEntry(k, types[k] || 'text', isListType(types[k]) ? [] : '')));
    };
    nk.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); commitNew(); } if (ev.key === 'Escape') { st.adding = false; buildProps(dom); } });
    nk.addEventListener('blur', () => { if (st.adding) commitNew(); });
    addRow.appendChild(nk);
    if (!focus) focus = { fid: JSON.stringify(['', 'new']) };
  } else {
    const addBtn = el('button', 'metadata-add-button', '+ Add property'); addBtn.type = 'button';
    addBtn.addEventListener('mousedown', ev => ev.preventDefault());
    addBtn.addEventListener('click', () => { st.adding = true; buildProps(dom); view.requestMeasure(); });
    addRow.appendChild(addBtn);
  }
  content.append(list, addRow); dom.appendChild(content);

  if (focus) {
    const t = [...dom.querySelectorAll('[data-fid]')].find(x => x.dataset.fid === focus.fid);
    if (t) { t.focus(); if (focus.caret != null && typeof t.setSelectionRange === 'function' && /^(text|search)$/.test(t.type)) { try { t.setSelectionRange(focus.caret, focus.caret); } catch { /* ignore */ } } }
  }
}
