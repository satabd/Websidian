'use strict';
// Obsidian Bases (.base files): a YAML description of filters, formulas and
// views over the notes' frontmatter. This renders the *table* views as HTML
// tables from the vault index — no Obsidian needed.
//
// Supported subset (the parts that make sense on a website):
//   filters:  and / or / not, with expressions
//             file.inFolder("x")  file.ext == "md"  file.hasTag("t")  file.name == "x"
//             prop == "v"  prop != "v"  prop.contains("v")  prop  (truthy)  !prop
//   formulas: string literals, property refs, file.name / file.folder,
//             if(cond, a, b) nested, ==, !=, +, &&, ||
//   views:    type table; name; filters; order (columns); groupBy; sort; limit
//   properties: displayName per column

const yaml = require('js-yaml');
const { escapeHtml } = require('./render');
const { folderTitle } = require('./vault');

// ---- tiny expression language ------------------------------------------------
function tokenize(src) {
  const out = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") { let j = i + 1, s = ''; while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; s += src[j]; j++; } out.push({ t: 'str', v: s }); i = j + 1; continue; }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '&&', '||', '>=', '<='].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('(),!+<>'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    const m = src.slice(i).match(/^[\p{L}\p{N}_.]+/u);
    if (m) { const v = m[0]; out.push(/^-?\d+(\.\d+)?$/.test(v) ? { t: 'num', v: Number(v) } : { t: 'id', v }); i += v.length; continue; }
    throw new Error(`Unexpected character "${c}" in expression: ${src}`);
  }
  return out;
}

// Grammar: or := and ('||' and)*  ; and := cmp ('&&' cmp)* ; cmp := sum (('=='|'!='|'<'|'>'|'<='|'>=') sum)? ; sum := unary ('+' unary)* ; unary := '!' unary | primary
// primary := str | num | id ['(' args ')'] | '(' or ')'
function parse(src) {
  const toks = tokenize(src); let p = 0;
  const peek = () => toks[p], next = () => toks[p++];
  const expect = v => { const t = next(); if (!t || t.v !== v) throw new Error(`Expected "${v}" in: ${src}`); };
  function or() { let l = and(); while (peek() && peek().v === '||') { next(); const r = and(); l = { k: 'or', l, r }; } return l; }
  function and() { let l = cmp(); while (peek() && peek().v === '&&') { next(); const r = cmp(); l = { k: 'and', l, r }; } return l; }
  function cmp() { const l = sum(); const t = peek(); if (t && t.t === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(t.v)) { next(); return { k: 'cmp', op: t.v, l, r: sum() }; } return l; }
  function sum() { let l = unary(); while (peek() && peek().v === '+') { next(); l = { k: 'add', l, r: unary() }; } return l; }
  function unary() { if (peek() && peek().v === '!') { next(); return { k: 'not', e: unary() }; } return primary(); }
  function primary() {
    const t = next(); if (!t) throw new Error(`Unexpected end of expression: ${src}`);
    if (t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'num') return { k: 'lit', v: t.v };
    if (t.v === '(') { const e = or(); expect(')'); return e; }
    if (t.t === 'id') {
      if (peek() && peek().v === '(') { next(); const args = []; if (peek().v !== ')') { args.push(or()); while (peek().v === ',') { next(); args.push(or()); } } expect(')'); return { k: 'call', name: t.v, args }; }
      return { k: 'ref', name: t.v };
    }
    throw new Error(`Unexpected token "${t.v}" in: ${src}`);
  }
  const e = or(); if (p < toks.length) throw new Error(`Trailing input in: ${src}`); return e;
}

const truthy = v => !(v == null || v === false || v === '' || (Array.isArray(v) && v.length === 0));
const str = v => v == null ? '' : (v instanceof Date ? v.toISOString().slice(0, 10) : Array.isArray(v) ? v.join(', ') : String(v));

function evaluate(ast, ctx) {
  switch (ast.k) {
    case 'lit': return ast.v;
    case 'ref': return resolveRef(ast.name, ctx);
    case 'not': return !truthy(evaluate(ast.e, ctx));
    case 'and': return truthy(evaluate(ast.l, ctx)) && truthy(evaluate(ast.r, ctx));
    case 'or': return truthy(evaluate(ast.l, ctx)) || truthy(evaluate(ast.r, ctx));
    case 'add': { const a = evaluate(ast.l, ctx), b = evaluate(ast.r, ctx); return typeof a === 'number' && typeof b === 'number' ? a + b : str(a) + str(b); }
    case 'cmp': {
      const a = evaluate(ast.l, ctx), b = evaluate(ast.r, ctx);
      const eq = Array.isArray(a) ? a.map(str).includes(str(b)) : str(a) === str(b);
      switch (ast.op) { case '==': return eq; case '!=': return !eq; case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b; }
      return false;
    }
    case 'call': {
      const args = ast.args.map(a => evaluate(a, ctx));
      const [name, method] = splitMethod(ast.name);
      if (!method) {
        if (name === 'if') return truthy(args[0]) ? args[1] : args[2];
        if (name === 'not') return !truthy(args[0]);
        if (name === 'lower') return str(args[0]).toLowerCase();
        if (name === 'upper') return str(args[0]).toUpperCase();
        if (name === 'contains') return str(args[0]).includes(str(args[1]));
        throw new Error(`Unknown function ${name}`);
      }
      const recv = resolveRef(name, ctx);
      if (name === 'file' || name.startsWith('file.')) {
        if (ast.name === 'file.inFolder') return ctx.note.folder === str(args[0]).replace(/\/$/, '') || ctx.note.folder.startsWith(str(args[0]).replace(/\/$/, '') + '/');
        if (ast.name === 'file.hasTag') return listOf(ctx.note.data.tags).map(t => String(t).replace(/^#/, '')).includes(str(args[0]).replace(/^#/, ''));
        if (ast.name === 'file.hasLink') return (ctx.vault.metaCache.get(ctx.note.rel)?.links || []).some(t => ctx.vault.resolveNote(t, ctx.note.rel) === ctx.vault.resolveNote(str(args[0]), ''));
      }
      if (method === 'contains') return Array.isArray(recv) ? recv.map(str).includes(str(args[0])) : str(recv).includes(str(args[0]));
      if (method === 'isEmpty') return !truthy(recv);
      if (method === 'lower') return str(recv).toLowerCase();
      if (method === 'upper') return str(recv).toUpperCase();
      if (method === 'startsWith') return str(recv).startsWith(str(args[0]));
      if (method === 'endsWith') return str(recv).endsWith(str(args[0]));
      throw new Error(`Unknown method ${ast.name}`);
    }
  }
  throw new Error('bad ast');
}
function splitMethod(name) { const i = name.lastIndexOf('.'); return i > 0 && !name.startsWith('file.') ? [name.slice(0, i), name.slice(i + 1)] : (name.startsWith('file.') && ['inFolder', 'hasTag', 'hasLink'].includes(name.slice(5)) ? ['file', name.slice(5)] : (i > 0 ? [name.slice(0, i), name.slice(i + 1)] : [name, null])); }
const listOf = v => Array.isArray(v) ? v : (v == null ? [] : [v]);

function resolveRef(name, ctx) {
  const n = ctx.note;
  switch (name) {
    case 'true': return true; case 'false': return false; case 'null': return null;
    case 'file.name': return n.base;
    case 'file.basename': return n.base;
    case 'file.title': return n.title;
    case 'file.path': return n.rel;
    case 'file.folder': return n.folder;
    case 'file.ext': return 'md';
    case 'file.mtime': return new Date(n.mtimeMs);
    case 'file.size': return n.size;
    case 'file.tags': return listOf(n.data.tags);
    case 'file.links': return ctx.vault.metaCache.get(n.rel)?.links || [];
  }
  if (name.startsWith('formula.')) return ctx.formula(name.slice(8));
  if (name.startsWith('note.')) return n.data[name.slice(5)];
  if (name.startsWith('file.')) return undefined;
  return n.data[name];
}

// ---- base file -> rows ------------------------------------------------------
function compileFilter(f) {
  if (f == null) return () => true;
  if (typeof f === 'string') { const ast = parse(f); return ctx => truthy(evaluate(ast, ctx)); }
  if (Array.isArray(f)) { const fs = f.map(compileFilter); return ctx => fs.every(x => x(ctx)); }
  if (f.and) { const fs = listOf(f.and).map(compileFilter); return ctx => fs.every(x => x(ctx)); }
  if (f.or) { const fs = listOf(f.or).map(compileFilter); return ctx => fs.some(x => x(ctx)); }
  if (f.not) { const fs = listOf(f.not).map(compileFilter); return ctx => !fs.some(x => x(ctx)); }
  return () => true;
}

function parseBase(text) {
  const doc = yaml.load(text) || {};
  const formulas = {}; for (const [k, v] of Object.entries(doc.formulas || {})) formulas[k] = parse(String(v));
  const views = listOf(doc.views).filter(v => v && (v.type || 'table') === 'table');
  return { doc, formulas, baseFilter: compileFilter(doc.filters), views, properties: doc.properties || {} };
}

function makeCtx(vault, note, formulas) {
  const ctx = { vault, note, formula: null };
  const memo = {};
  ctx.formula = name => { if (!(name in memo)) { memo[name] = null; memo[name] = formulas[name] ? evaluate(formulas[name], ctx) : undefined; } return memo[name]; };
  return ctx;
}

function columnLabel(col, properties) {
  if (properties[col] && properties[col].displayName) return properties[col].displayName;
  if (col.startsWith('formula.')) return col.slice(8);
  if (col.startsWith('file.')) return col.slice(5).replace(/^\w/, c => c.toUpperCase());
  return col;
}

function cellHtml(vault, note, col, ctx) {
  if (col === 'file.name' || col === 'file.title' || col === 'file.basename') return `<a href="${vault.noteUrl(note.rel)}">${escapeHtml(col === 'file.title' ? note.title : note.base)}</a>`;
  if (col === 'file.folder') return escapeHtml(note.folder.split('/').map(p => folderTitle(p, vault.folderNames)).join(' / '));
  let v; try { v = col.startsWith('formula.') ? ctx.formula(col.slice(8)) : resolveRef(col, ctx); } catch (e) { return `<span class="base-error" title="${escapeHtml(e.message)}">⚠</span>`; }
  if (Array.isArray(v)) return v.map(x => `<span class="chip">${escapeHtml(str(x))}</span>`).join(' ');
  if (typeof v === 'boolean') return v ? '✓' : '';
  return escapeHtml(str(v));
}

// Render every table view of a .base as HTML (tabs if more than one).
function renderBase(vault, text, { baseName = '' } = {}) {
  let parsed;
  try { parsed = parseBase(text); } catch (e) { return `<div class="callout callout-danger"><div class="callout-title"><span class="callout-icon"></span><span class="callout-title-inner">Base could not be read</span></div><div class="callout-content"><p>${escapeHtml(e.message)}</p></div></div>`; }
  const { formulas, baseFilter, views, properties } = parsed;
  if (!views.length) views.push({ name: 'Table', order: ['file.name'] });
  const notes = vault.visibleNotesSorted();
  const rowsFor = view => {
    const vf = compileFilter(view.filters);
    let rows = [];
    for (const n of notes) {
      const ctx = makeCtx(vault, n, formulas);
      let keep = false; try { keep = baseFilter(ctx) && vf(ctx); } catch { keep = false; }
      if (keep) rows.push({ note: n, ctx });
    }
    for (const s of listOf(view.sort).reverse()) {
      const prop = typeof s === 'string' ? s : s.property; const dir = (typeof s === 'object' && s.direction === 'DESC') ? -1 : 1;
      rows.sort((a, b) => { const x = str(safeRef(prop, a.ctx)), y = str(safeRef(prop, b.ctx)); return dir * x.localeCompare(y, undefined, { numeric: true }); });
    }
    if (view.limit) rows = rows.slice(0, Number(view.limit));
    return rows;
  };
  const tabs = views.map((view, i) => {
    const cols = listOf(view.order).length ? listOf(view.order) : ['file.name'];
    const rows = rowsFor(view);
    const groupBy = view.groupBy && (typeof view.groupBy === 'string' ? view.groupBy : view.groupBy.property);
    const groups = new Map();
    for (const r of rows) { const g = groupBy ? str(safeRef(groupBy, r.ctx)) : ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); }
    const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (view.groupBy && view.groupBy.direction === 'DESC') keys.reverse();
    const head = `<thead><tr>${cols.map(c => `<th>${escapeHtml(columnLabel(c, properties))}</th>`).join('')}</tr></thead>`;
    const body = keys.map(k => (groupBy ? `<tr class="base-group"><th colspan="${cols.length}">${escapeHtml(k || '—')} <span class="muted">(${groups.get(k).length})</span></th></tr>` : '')
      + groups.get(k).map(r => `<tr>${cols.map(c => `<td>${cellHtml(vault, r.note, c, r.ctx)}</td>`).join('')}</tr>`).join('')).join('');
    return { name: view.name || `View ${i + 1}`, count: rows.length, html: `<div class="table-wrap base-table"><table>${head}<tbody>${body}</tbody></table></div>` };
  });
  const nav = tabs.length > 1 ? `<div class="base-tabs" role="tablist">${tabs.map((t, i) => `<button type="button" class="base-tab${i === 0 ? ' is-active' : ''}" data-tab="${i}">${escapeHtml(t.name)} <span class="muted">${t.count}</span></button>`).join('')}</div>` : '';
  return `<div class="base" data-base="${escapeHtml(baseName)}">${nav}${tabs.map((t, i) => `<div class="base-view" data-view="${i}"${i ? ' hidden' : ''}>${t.html}</div>`).join('')}</div>`;
}
function safeRef(name, ctx) { try { return name.startsWith('formula.') ? ctx.formula(name.slice(8)) : resolveRef(name, ctx); } catch { return ''; } }

module.exports = { renderBase, parseBase, parse, evaluate, tokenize };
