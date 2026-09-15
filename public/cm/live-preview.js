// Decorations that make CodeMirror look and behave like Obsidian's editor.
//
// obsidianClasses (always on, Source mode too): Obsidian's own DOM class names
//   on lines (HyperMD-header-2, HyperMD-list-line, HyperMD-codeblock, …) and on
//   tokens (cm-formatting-*, cm-hmd-internal-link, cm-hashtag, …), so themes and
//   CSS snippets written for Obsidian style this editor unchanged.
// livePreview (toggle): hides Markdown syntax away from the cursor and renders
//   widgets (checkboxes, bullets, links, images, embeds, math, callouts, rules,
//   mermaid diagrams), revealing the source of whatever the selection touches.
import { Decoration, ViewPlugin, WidgetType, EditorView } from '@codemirror/view';
import { StateField, StateEffect, Facet } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { parseLinkTarget, fileKind } from './vault-index.js';
import { TableWidget, PropertiesWidget } from './blocks.js';

// Dispatched when outside data changes (vault index loaded, theme switched).
export const refreshEffect = StateEffect.define();
const refreshed = u => u.transactions.some(tr => tr.effects.some(e => e.is(refreshEffect)));

// { index: VaultIndex, openLink({type, target|href, newTab}), isDark() }
export const editorContext = Facet.define({ combine: v => v[0] || {} });

// ---- callouts -------------------------------------------------------------------------
const CALLOUT_ALIASES = { summary: 'abstract', tldr: 'abstract', hint: 'tip', important: 'tip', check: 'success', done: 'success', help: 'question', faq: 'question', caution: 'warning', attention: 'warning', fail: 'failure', missing: 'failure', error: 'danger', cite: 'quote' };
const CALLOUT_STYLE = {
  note: ['8, 109, 221', '✎'], abstract: ['0, 191, 188', '☰'], info: ['8, 109, 221', 'ℹ'], todo: ['8, 109, 221', '☑'],
  tip: ['0, 191, 188', '✦'], success: ['8, 185, 78', '✓'], question: ['236, 117, 0', '?'], warning: ['236, 117, 0', '⚠'],
  failure: ['233, 49, 71', '✕'], danger: ['233, 49, 71', 'ϟ'], bug: ['233, 49, 71', '✱'], example: ['120, 82, 238', '≡'], quote: ['158, 158, 158', '❝'],
};
const CALLOUT_RE = /^>\s*\[!([^\]\s]+)\]([+-]?)[ \t]?(.*)$/;
export function calloutInfo(type) {
  const t = String(type).toLowerCase(); const canon = CALLOUT_ALIASES[t] || t;
  const [color, icon] = CALLOUT_STYLE[canon] || CALLOUT_STYLE.note;
  return { type: t, canon, color, icon };
}

// ---- helpers ------------------------------------------------------------------------------
const HEADING = /^(?:ATX|Setext)Heading(\d)$/;
const listDepth = node => { let d = 0; for (let p = node.parent; p; p = p.parent) if (p.name === 'BulletList' || p.name === 'OrderedList') d++; return d; };
function frontmatterRange(doc) {
  if (doc.lines < 2 || !/^---\s*$/.test(doc.line(1).text)) return null;
  for (let i = 2; i <= Math.min(doc.lines, 400); i++) if (/^(---|\.\.\.)\s*$/.test(doc.line(i).text)) return { from: 0, to: doc.line(i).to, endLine: i };
  return null;
}
const clsName = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-');

// ---- layer 1: Obsidian class names ------------------------------------------------------------
function buildClasses(view) {
  const { state } = view; const doc = state.doc; const { index } = state.facet(editorContext);
  const marks = []; const lines = new Map();
  const line = (pos, cls, attrs) => {
    const l = doc.lineAt(pos); let e = lines.get(l.from);
    if (!e) lines.set(l.from, e = { cls: new Set(), attrs: {} });
    for (const c of cls.split(' ')) if (c) e.cls.add(c);
    if (attrs) Object.assign(e.attrs, attrs);
  };
  const eachLine = (from, to, vis, fn) => {
    const a = Math.max(from, vis.from), b = Math.min(to, vis.to);
    for (let p = a; p <= b;) { const l = doc.lineAt(p); fn(l); p = l.to + 1; }
  };
  const mark = (from, to, cls, attributes) => { if (to > from) marks.push(Decoration.mark(attributes ? { class: cls, attributes } : { class: cls }).range(from, to)); };
  const quoteCount = new Map();

  const fm = frontmatterRange(doc);
  if (fm) for (const vis of view.visibleRanges) eachLine(fm.from, fm.to, vis, l => line(l.from, 'HyperMD-frontmatter' + (l.number === 1 ? ' HyperMD-frontmatter-begin' : l.number === fm.endLine ? ' HyperMD-frontmatter-end' : ''), { spellcheck: 'false' }));

  for (const vis of view.visibleRanges) {
    syntaxTree(state).iterate({
      from: vis.from, to: vis.to,
      enter: (n) => {
        const name = n.name; let m;
        if ((m = HEADING.exec(name))) {
          if (name.startsWith('ATX')) line(n.from, `HyperMD-header HyperMD-header-${m[1]}`);
          else eachLine(n.from, n.to, vis, l => line(l.from, `HyperMD-header HyperMD-header-${m[1]}`));
          return;
        }
        switch (name) {
          case 'HeaderMark': { const lv = HEADING.exec(n.node.parent?.name || ''); mark(n.from, n.to, `cm-formatting-header cm-formatting-header-${lv ? lv[1] : 1}`); break; }
          case 'QuoteMark': { const l = doc.lineAt(n.from); quoteCount.set(l.from, (quoteCount.get(l.from) || 0) + 1); mark(n.from, n.to, 'cm-formatting-quote'); break; }
          case 'Blockquote': {
            const first = doc.lineAt(n.from); const cm = CALLOUT_RE.exec(doc.sliceString(n.from, first.to));
            if (cm) {
              const c = calloutInfo(cm[1]);
              eachLine(n.from, n.to, vis, l => line(l.from, 'HyperMD-callout' + (l.from === first.from ? ' ws-callout-title-line' : ''), { 'data-callout': c.type, style: `--callout-color: ${c.color}` }));
              const typeFrom = n.from + doc.sliceString(n.from, first.to).indexOf('[!');
              mark(typeFrom, typeFrom + cm[1].length + 3 + cm[2].length, 'cm-formatting cm-callout-type');
            }
            break;
          }
          case 'ListItem': { const d = listDepth(n.node); line(n.from, `HyperMD-list-line HyperMD-list-line-${d}`); break; }
          case 'ListMark': {
            const item = n.node.parent; const list = item && item.parent;
            const kind = list && list.name === 'OrderedList' ? 'ol' : 'ul';
            mark(n.from, n.to, `cm-formatting-list cm-formatting-list-${kind} cm-list-${item ? listDepth(item) : 1}`);
            break;
          }
          case 'Task': { const ch = doc.sliceString(n.from + 1, n.from + 2); line(n.from, 'HyperMD-task-line', { 'data-task': ch }); break; }
          case 'TaskMarker': { const ch = doc.sliceString(n.from + 1, n.from + 2); mark(n.from, n.to, 'cm-formatting-task ' + (ch === ' ' ? 'cm-meta' : 'cm-property')); break; }
          case 'FencedCode': case 'CodeBlock': {
            const fenced = name === 'FencedCode'; const firstL = doc.lineAt(n.from), lastL = doc.lineAt(n.to);
            const closed = fenced && lastL.number > firstL.number && /^\s*(`{3,}|~{3,})\s*$/.test(lastL.text.replace(/^(\s*>)+/, ''));
            eachLine(n.from, n.to, vis, l => {
              let c = 'HyperMD-codeblock HyperMD-codeblock-bg';
              if (fenced && l.number === firstL.number) c += ' HyperMD-codeblock-begin HyperMD-codeblock-begin-bg';
              else if (closed && l.number === lastL.number) c += ' HyperMD-codeblock-end HyperMD-codeblock-end-bg';
              line(l.from, c, { spellcheck: 'false', dir: 'ltr' });
            });
            break;
          }
          case 'CodeMark': mark(n.from, n.to, n.node.parent?.name === 'InlineCode' ? 'cm-formatting-code cm-inline-code' : 'cm-formatting-code-block cm-hmd-codeblock'); break;
          case 'CodeInfo': mark(n.from, n.to, 'cm-formatting-code-block cm-hmd-codeblock cm-hmd-codeblock-lang'); break;
          case 'InlineCode': mark(n.from, n.to, 'cm-inline-code'); break;
          case 'HorizontalRule': line(n.from, 'HyperMD-hr'); mark(n.from, n.to, 'cm-hr'); break;
          case 'Table': { let i = 0; eachLine(n.from, n.to, vis, l => line(l.from, `HyperMD-table-row HyperMD-table-row-${i++}`)); break; }
          case 'TableDelimiter': mark(n.from, n.to, 'cm-hmd-table-sep'); break;
          case 'EmphasisMark': mark(n.from, n.to, n.node.parent?.name === 'StrongEmphasis' ? 'cm-formatting-strong' : 'cm-formatting-em'); break;
          case 'StrikethroughMark': mark(n.from, n.to, 'cm-formatting-strikethrough'); break;
          case 'HighlightMark': mark(n.from, n.to, 'cm-formatting-highlight'); break;
          case 'MathMark': mark(n.from, n.to, 'cm-formatting-math'); break;
          case 'MathBlock': eachLine(n.from, n.to, vis, l => line(l.from, 'HyperMD-math-line', { spellcheck: 'false', dir: 'ltr' })); break;
          case 'ObsCommentMark': mark(n.from, n.to, 'cm-formatting-comment'); break;
          case 'Escape': mark(n.from, n.from + 1, 'cm-formatting cm-formatting-escape'); break;
          case 'Link': case 'Image': {
            const lm = n.node.getChildren('LinkMark'); const url = n.node.getChild('URL');
            if (!url && !n.node.getChild('LinkLabel')) break;   // "[text]" alone is not a link (nor is a callout's [!type])
            const href = url ? doc.sliceString(url.from, url.to) : null;
            if (lm.length >= 2) mark(lm[0].to, lm[1].from, name === 'Image' ? 'cm-image-alt-text cm-link' : 'cm-link', href && name === 'Link' ? { 'data-href': href } : null);
            for (const x of lm) mark(x.from, x.to, `cm-formatting-${name === 'Image' ? 'image' : 'link'} cm-link`);
            if (url) mark(url.from, url.to, 'cm-string cm-url');
            break;
          }
          case 'URL': { const p = n.node.parent?.name; if (p !== 'Link' && p !== 'Image') mark(n.from, n.to, 'cm-url', { 'data-href': doc.sliceString(n.from, n.to) }); break; }
          case 'LinkTitle': mark(n.from, n.to, 'cm-string'); break;
          case 'WikiLink': case 'Embed': {
            const tgt = n.node.getChild('WikiTarget'); const target = tgt ? doc.sliceString(tgt.from, tgt.to) : '';
            const unresolved = index && index.loaded && target && !index.resolve(target);
            const extra = (unresolved ? ' is-unresolved' : '') + (name === 'Embed' ? ' cm-hmd-embed' : '');
            const alias = n.node.getChild('WikiAlias');
            if (tgt) mark(tgt.from, tgt.to, 'cm-hmd-internal-link' + (alias ? ' cm-link-has-alias' : '') + extra, { 'data-wikilink': target });
            if (alias) mark(alias.from, alias.to, 'cm-hmd-internal-link cm-link-alias' + extra, { 'data-wikilink': target });
            const pipe = n.node.getChild('WikiPipe'); if (pipe) mark(pipe.from, pipe.to, 'cm-hmd-internal-link cm-link-alias-pipe');
            const wm = n.node.getChildren('WikiMark');
            if (wm[0]) mark(wm[0].from, wm[0].to, name === 'Embed' ? 'cm-formatting-link cm-formatting-link-start cm-formatting-embed' : 'cm-formatting-link cm-formatting-link-start');
            if (wm[1]) mark(wm[1].from, wm[1].to, 'cm-formatting-link cm-formatting-link-end');
            return false;
          }
          case 'Hashtag': {
            const tag = doc.sliceString(n.from + 1, n.to);
            mark(n.from, n.from + 1, 'cm-formatting cm-formatting-hashtag cm-hashtag cm-hashtag-begin cm-meta', { 'data-tag': tag });
            mark(n.from + 1, n.to, `cm-hashtag cm-meta cm-hashtag-end cm-tag-${clsName(tag)}`, { 'data-tag': tag });
            return false;
          }
          case 'BlockId': mark(n.from, n.to, 'cm-blockid'); break;
          case 'FootnoteRef': case 'InlineFootnote': mark(n.from, n.to, 'cm-footref' + (name === 'InlineFootnote' ? ' cm-inline-footnote' : '')); break;
        }
      },
    });
  }
  for (const [from, n] of quoteCount) line(from, `HyperMD-quote HyperMD-quote-${n}`);
  // Every line takes its direction from its own first letter (dir="auto"), as in Obsidian:
  // Arabic lines run right to left, English ones left to right, in the same note.
  for (const vis of view.visibleRanges) eachLine(vis.from, vis.to, vis, l => { const e = lines.get(l.from); if (!e || !e.attrs.dir) line(l.from, '', { dir: 'auto' }); });
  const all = marks;
  for (const [from, e] of lines) all.push(Decoration.line({ class: [...e.cls].join(' '), attributes: e.attrs }).range(from));
  return Decoration.set(all, true);
}

export const obsidianClasses = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildClasses(view); }
  update(u) { if (u.docChanged || u.viewportChanged || syntaxTree(u.state) !== syntaxTree(u.startState) || refreshed(u)) this.decorations = buildClasses(u.view); }
}, { decorations: v => v.decorations });

// ---- widgets ---------------------------------------------------------------------------------
// Clicking a rendered widget puts the cursor into its source (revealing it), like Obsidian.
function revealOnMouseDown(dom, view, offset = 0) {
  dom.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const pos = view.posAtDOM(dom);
    view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, pos + offset) } });
    view.focus();
  });
}

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement('span'); s.className = 'list-bullet'; s.textContent = '•'; return s; }
}

class CheckboxWidget extends WidgetType {
  constructor(ch) { super(); this.ch = ch; }
  eq(o) { return o.ch === this.ch; }
  toDOM(view) {
    const box = document.createElement('input');
    box.type = 'checkbox'; box.className = 'task-list-item-checkbox'; box.checked = this.ch !== ' '; box.setAttribute('data-task', this.ch);
    box.addEventListener('mousedown', e => e.preventDefault());
    box.addEventListener('click', e => {
      e.preventDefault();
      const pos = view.posAtDOM(box);
      if (!/^\[.\]$/.test(view.state.sliceDoc(pos, pos + 3))) return;
      const cur = view.state.sliceDoc(pos + 1, pos + 2);
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: cur === ' ' ? 'x' : ' ' }, userEvent: 'input.toggle' });
    });
    return box;
  }
  ignoreEvent() { return true; }
}

class SeparatorWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement('span'); s.className = 'ws-link-sep'; s.textContent = ' › '; return s; }
}

class HrWidget extends WidgetType {
  eq() { return true; }
  toDOM(view) { const s = document.createElement('span'); s.className = 'ws-hr'; revealOnMouseDown(s, view); return s; }
}

class FlairWidget extends WidgetType {
  constructor(lang) { super(); this.lang = lang; }
  eq(o) { return o.lang === this.lang; }
  toDOM() { const s = document.createElement('span'); s.className = 'code-block-flair'; s.textContent = this.lang; s.setAttribute('aria-hidden', 'true'); return s; }
}

class CalloutTitleWidget extends WidgetType {
  constructor(type, fold, title) { super(); this.type = type; this.fold = fold; this.title = title; }
  eq(o) { return o.type === this.type && o.fold === this.fold && o.title === this.title; }
  toDOM(view) {
    const c = calloutInfo(this.type);
    const s = document.createElement('span'); s.className = 'callout-title-widget';
    const icon = document.createElement('span'); icon.className = 'callout-icon'; icon.textContent = c.icon; s.appendChild(icon);
    if (!this.title) { const t = document.createElement('span'); t.className = 'callout-title-inner'; t.textContent = this.type.charAt(0).toUpperCase() + this.type.slice(1); s.appendChild(t); }
    if (this.fold) { const f = document.createElement('span'); f.className = 'callout-fold'; f.textContent = this.fold === '-' ? '▸' : '▾'; s.appendChild(f); }
    revealOnMouseDown(s, view, 0);
    return s;
  }
}

class ImageWidget extends WidgetType {
  constructor(src, alt, width, height) { super(); this.src = src; this.alt = alt; this.width = width; this.height = height; }
  eq(o) { return o.src === this.src && o.alt === this.alt && o.width === this.width && o.height === this.height; }
  toDOM(view) {
    const wrap = document.createElement('span'); wrap.className = 'internal-embed media-embed image-embed is-loaded';
    const img = document.createElement('img'); img.src = this.src; img.alt = this.alt || ''; img.loading = 'lazy';
    if (this.width) img.width = this.width; if (this.height) img.height = this.height;
    img.addEventListener('load', () => view.requestMeasure());
    img.addEventListener('error', () => { wrap.classList.add('is-broken'); wrap.textContent = '⚠ ' + (this.alt || this.src); });
    wrap.appendChild(img);
    revealOnMouseDown(wrap, view, 3);
    return wrap;
  }
  get estimatedHeight() { return this.height || 120; }
}

class EmbedWidget extends WidgetType {
  constructor(kind, label, url, missing) { super(); this.kind = kind; this.label = label; this.url = url; this.missing = missing; }
  eq(o) { return o.kind === this.kind && o.label === this.label && o.url === this.url && o.missing === this.missing; }
  toDOM(view) {
    const wrap = document.createElement('span');
    if (!this.missing && (this.kind === 'audio' || this.kind === 'video')) {
      wrap.className = 'internal-embed media-embed ' + this.kind + '-embed';
      const el = document.createElement(this.kind); el.controls = true; el.src = this.url; el.preload = 'metadata';
      wrap.appendChild(el);
      return wrap;
    }
    wrap.className = 'internal-embed ws-embed-chip' + (this.kind === 'note' ? ' markdown-embed' : ' file-embed') + (this.missing ? ' is-unresolved' : '');
    const icon = document.createElement('span'); icon.className = 'ws-embed-icon';
    icon.textContent = this.missing ? '⚠' : this.kind === 'note' ? '⧉' : this.kind === 'pdf' ? '📄' : '📎';
    const text = document.createElement('span'); text.textContent = this.missing ? `${this.label} (not found)` : this.label;
    wrap.append(icon, text);
    revealOnMouseDown(wrap, view, 3);
    return wrap;
  }
}

// KaTeX and mermaid are loaded by the page (deferred classic scripts): wait for them.
function whenGlobal(name, fn, tries = 60) { if (window[name]) fn(window[name]); else if (tries > 0) setTimeout(() => whenGlobal(name, fn, tries - 1), 100); }

class MathWidget extends WidgetType {
  constructor(tex, display, block) { super(); this.tex = tex; this.display = display; this.block = block; }
  eq(o) { return o.tex === this.tex && o.display === this.display; }
  toDOM(view) {
    const el = document.createElement(this.block ? 'div' : 'span');
    el.className = 'math' + (this.display ? ' math-block' : ' math-inline') + (this.block ? ' cm-embed-block' : '');
    el.textContent = this.tex;
    whenGlobal('katex', k => { try { k.render(this.tex, el, { displayMode: this.display, throwOnError: false }); view.requestMeasure(); } catch { /* leave source */ } });
    revealOnMouseDown(el, view, this.block ? 0 : 1);
    return el;
  }
  get estimatedHeight() { return this.block ? 60 : -1; }
}

const mermaidCache = new Map();
let mermaidSeq = 0, mermaidTheme = null;
class MermaidWidget extends WidgetType {
  constructor(code, dark) { super(); this.code = code; this.dark = dark; }
  eq(o) { return o.code === this.code && o.dark === this.dark; }
  toDOM(view) {
    const el = document.createElement('div'); el.className = 'cm-embed-block cm-lang-mermaid ws-mermaid';
    const key = (this.dark ? 'd:' : 'l:') + this.code;
    if (mermaidCache.has(key)) el.innerHTML = mermaidCache.get(key);
    else {
      el.textContent = 'Rendering diagram…';
      whenGlobal('mermaid', async mm => {
        try {
          const theme = this.dark ? 'dark' : 'default';
          if (mermaidTheme !== theme) { mm.initialize({ startOnLoad: false, theme, securityLevel: 'strict' }); mermaidTheme = theme; }
          if (await mm.parse(this.code, { suppressErrors: true }) === false) { el.textContent = 'Mermaid: syntax error'; el.classList.add('is-error'); return; }
          const { svg } = await mm.render('ws-mermaid-' + (++mermaidSeq), this.code);
          mermaidCache.set(key, svg); el.innerHTML = svg; view.requestMeasure();
        } catch (e) { el.textContent = 'Mermaid: ' + (e && e.message || 'error'); el.classList.add('is-error'); }
      });
    }
    revealOnMouseDown(el, view, 0);
    return el;
  }
  get estimatedHeight() { return 240; }
}

// ---- layer 2: live preview (inline, per visible range) -------------------------------------------
function parseSize(s) { const m = /^\s*(\d+)(?:\s*x\s*(\d+))?\s*$/.exec(s || ''); return m ? { w: Number(m[1]), h: m[2] ? Number(m[2]) : null } : null; }

function buildLive(view) {
  const { state } = view; const doc = state.doc; const sel = state.selection.ranges;
  const { index } = state.facet(editorContext);
  const deco = []; const hidden = [];
  const touches = (from, to) => sel.some(r => r.from <= to && r.to >= from);
  const lineTouched = pos => { const l = doc.lineAt(pos); return touches(l.from, l.to); };
  const covered = (from, to) => hidden.some(h => from >= h[0] && to <= h[1]);
  const hide = (from, to) => { if (to > from && !covered(from, to)) { hidden.push([from, to]); deco.push(Decoration.replace({}).range(from, to)); } };
  const widget = (from, to, w) => { if (!covered(from, to)) { hidden.push([from, to]); deco.push(Decoration.replace({ widget: w }).range(from, to)); } };
  const mark = (from, to, cls, attributes) => { if (to > from) deco.push(Decoration.mark({ class: cls, attributes }).range(from, to)); };
  const spaceAfter = pos => (/[ \t]/.test(doc.sliceString(pos, pos + 1)) ? 1 : 0);
  const fileUrl = rel => (index ? index.fileUrl(rel) : rel);
  const fm = frontmatterRange(doc);

  for (const vis of view.visibleRanges) {
    syntaxTree(state).iterate({
      from: vis.from, to: vis.to,
      enter: (n) => {
        const name = n.name;
        if (fm && n.to <= fm.to) return false;       // YAML frontmatter stays as source (properties panel later)
        switch (name) {
          case 'HeaderMark': {
            const p = n.node.parent; if (!p) break;
            if (p.name.startsWith('Setext')) { if (!lineTouched(n.from)) hide(n.from, n.to); break; }
            if (lineTouched(n.from)) break;
            if (n.from === p.from) hide(n.from, Math.min(doc.lineAt(n.from).to, n.to + spaceAfter(n.to)));
            else { let s = n.from; while (s > p.from && /[ \t]/.test(doc.sliceString(s - 1, s))) s--; hide(s, n.to); }
            break;
          }
          case 'Blockquote': {
            const first = doc.lineAt(n.from); const txt = doc.sliceString(n.from, first.to); const cm = CALLOUT_RE.exec(txt);
            if (cm && !lineTouched(n.from)) {
              const typeFrom = n.from + txt.indexOf('[!'); const typeTo = typeFrom + cm[1].length + 3 + cm[2].length;
              widget(n.from, Math.min(first.to, typeTo + spaceAfter(typeTo)), new CalloutTitleWidget(cm[1].toLowerCase(), cm[2], cm[3].trim()));
              if (cm[3].trim()) mark(Math.min(first.to, typeTo + spaceAfter(typeTo)), first.to, 'callout-title-inner');
            }
            break;
          }
          case 'QuoteMark': if (!lineTouched(n.from)) hide(n.from, n.to + spaceAfter(n.to)); break;
          case 'ListMark': {
            const item = n.node.parent; const list = item && item.parent; const task = item && item.getChild('Task');
            if (task) {
              const tm = task.getChild('TaskMarker');
              if (tm && !touches(n.from, tm.to)) { hide(n.from, tm.from); }
            } else if (list && list.name === 'BulletList' && !touches(n.from, n.to)) widget(n.from, n.to, new BulletWidget());
            break;
          }
          case 'TaskMarker': {
            const item = n.node.parent?.parent; const lm = item && item.getChild('ListMark');
            if (!touches(lm ? lm.from : n.from, n.to)) widget(n.from, n.to, new CheckboxWidget(doc.sliceString(n.from + 1, n.from + 2)));
            break;
          }
          case 'EmphasisMark': case 'StrikethroughMark': case 'HighlightMark': {
            const p = n.node.parent; if (p && !touches(p.from, p.to)) hide(n.from, n.to);
            break;
          }
          case 'CodeMark': {
            const p = n.node.parent; if (p && p.name === 'InlineCode' && !touches(p.from, p.to)) hide(n.from, n.to);
            break;
          }
          case 'Escape': if (!touches(n.from, n.to)) hide(n.from, n.from + 1); break;
          case 'Link': {
            if (touches(n.from, n.to)) break;
            const lm = n.node.getChildren('LinkMark'); const url = n.node.getChild('URL');
            if (!url && !n.node.getChild('LinkLabel')) break;
            if (lm.length >= 2 && lm[1].from > lm[0].to) {
              hide(lm[0].from, lm[0].to); hide(lm[1].from, n.to);
              mark(lm[0].to, lm[1].from, 'ws-lp-link external-link', url ? { 'data-href': doc.sliceString(url.from, url.to) } : undefined);
            }
            break;
          }
          case 'Autolink': {
            if (touches(n.from, n.to)) break;
            for (const x of n.node.getChildren('LinkMark')) hide(x.from, x.to);
            const url = n.node.getChild('URL'); if (url) mark(url.from, url.to, 'ws-lp-link external-link', { 'data-href': doc.sliceString(url.from, url.to) });
            return false;
          }
          case 'URL': {
            const p = n.node.parent?.name;
            if (p !== 'Link' && p !== 'Image' && p !== 'Autolink') mark(n.from, n.to, 'ws-lp-link external-link', { 'data-href': doc.sliceString(n.from, n.to) });
            break;
          }
          case 'Image': {
            if (touches(n.from, n.to)) break;
            const lm = n.node.getChildren('LinkMark'); const url = n.node.getChild('URL');
            if (!url || lm.length < 2) break;
            let alt = doc.sliceString(lm[0].to, lm[1].from); let size = null;
            const bar = alt.lastIndexOf('|'); if (bar >= 0 && (size = parseSize(alt.slice(bar + 1)))) alt = alt.slice(0, bar);
            let src = doc.sliceString(url.from, url.to).replace(/^<|>$/g, '');
            if (!/^(https?:|data:|\/)/i.test(src) && index) { const rel = index.resolveFile(src); if (rel) src = fileUrl(rel); }
            widget(n.from, n.to, new ImageWidget(src, alt, size && size.w, size && size.h));
            return false;
          }
          case 'WikiLink': {
            if (touches(n.from, n.to)) return false;
            const wm = n.node.getChildren('WikiMark'); const tgt = n.node.getChild('WikiTarget'); const alias = n.node.getChild('WikiAlias');
            if (wm.length < 2) return false;
            const target = tgt ? doc.sliceString(tgt.from, tgt.to) : '';
            hide(wm[0].from, wm[0].to);
            if (alias) { hide(wm[0].to, alias.from); mark(alias.from, alias.to, 'ws-lp-link', { 'data-wikilink': target }); }
            else if (tgt) {
              // [[Note#Heading]] reads "Note › Heading"; [[#Heading]] just "Heading".
              const hash = target.indexOf('#');
              if (hash === 0) hide(tgt.from, tgt.from + 1 + (target[1] === '^' ? 1 : 0));
              else if (hash > 0) widget(tgt.from + hash, tgt.from + hash + 1, new SeparatorWidget());
              mark(tgt.from, tgt.to, 'ws-lp-link', { 'data-wikilink': target });
            }
            hide(wm[1].from, wm[1].to);
            return false;
          }
          case 'Embed': {
            if (touches(n.from, n.to)) return false;
            const tgt = n.node.getChild('WikiTarget'); if (!tgt) return false;
            const alias = n.node.getChild('WikiAlias');
            const raw = doc.sliceString(tgt.from, tgt.to); const { path } = parseLinkTarget(raw);
            const aliasText = alias ? doc.sliceString(alias.from, alias.to) : '';
            const r = index && index.loaded ? index.resolve(raw) : null;
            const kind = r ? (r.kind === 'note' ? 'note' : fileKind(r.rel)) : fileKind(path);
            if (kind === 'image' && r) {
              const size = parseSize(aliasText);
              widget(n.from, n.to, new ImageWidget(fileUrl(r.rel), size ? path : (aliasText || path), size && size.w, size && size.h));
            } else if (index && index.loaded) {
              const note = r && r.kind === 'note' ? index.note(r.rel) : null;
              const label = aliasText && !parseSize(aliasText) ? aliasText : note ? note.title + (raw.includes('#') ? ' › ' + raw.slice(raw.indexOf('#') + 1) : '') : raw;
              widget(n.from, n.to, new EmbedWidget(kind, label, r ? fileUrl(r.rel) : '', !r));
            }
            return false;
          }
          case 'InlineMath': case 'DisplayMath': {
            if (touches(n.from, n.to)) return false;
            if (doc.lineAt(n.from).number !== doc.lineAt(n.to).number) return false;
            const k = name === 'InlineMath' ? 1 : 2;
            widget(n.from, n.to, new MathWidget(doc.sliceString(n.from + k, n.to - k), name === 'DisplayMath', false));
            return false;
          }
          case 'HorizontalRule': if (!lineTouched(n.from)) widget(n.from, n.to, new HrWidget()); break;
          case 'FencedCode': {
            if (touches(n.from, n.to)) return false;
            const firstL = doc.lineAt(n.from), lastL = doc.lineAt(n.to);
            const info = n.node.getChild('CodeInfo'); const lang = info ? doc.sliceString(info.from, info.to).trim() : '';
            if (lang.toLowerCase() === 'mermaid' && state.field(liveBlocks, false)?.mermaid.has(n.from)) return false;
            const fenceStart = n.from;
            widget(fenceStart, firstL.to, new FlairWidget(lang));
            const marks = n.node.getChildren('CodeMark'); const endMark = marks.length > 1 ? marks[marks.length - 1] : null;
            if (endMark && lastL.number > firstL.number) hide(endMark.from, lastL.to);
            return false;
          }
          case 'MathBlock': case 'ObsCommentBlock': return false;
          case 'Table': if (state.field(liveBlocks, false)?.tables.has(n.from)) return false; break;
        }
      },
    });
  }
  return Decoration.set(deco, true);
}

const livePlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildLive(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.state) !== syntaxTree(u.startState) || refreshed(u)) this.decorations = buildLive(u.view);
  }
}, { decorations: v => v.decorations });

// ---- layer 2b: block widgets (must come from a state field: they replace line breaks) ------------
function buildBlocks(state) {
  const doc = state.doc; const sel = state.selection.ranges; const ctx = state.facet(editorContext);
  const touches = (from, to) => sel.some(r => r.from <= to && r.to >= from);
  const deco = []; const mermaid = new Set(); const tables = new Set();
  const wholeLines = (from, to) => doc.lineAt(from).from === from && doc.lineAt(to).to === to;
  // Frontmatter as Obsidian's Properties panel (or hidden / left as YAML, per "Properties in document").
  const fm = frontmatterRange(doc); const S = ctx.settings || {};
  if (fm && S.propertiesInDocument !== 'source' && !touches(fm.from, fm.to)) {
    deco.push(S.propertiesInDocument === 'hidden'
      ? Decoration.replace({ block: true }).range(fm.from, fm.to)
      : Decoration.replace({ widget: new PropertiesWidget(doc.sliceString(fm.from, fm.to), ctx), block: true }).range(fm.from, fm.to));
  }
  syntaxTree(state).iterate({
    enter: (n) => {
      const name = n.name;
      if (fm && n.to <= fm.to) return false;
      if (name === 'Table') {
        // Top-level tables become the grid editor; tables inside quotes/lists stay as source.
        if (!touches(n.from, n.to) && wholeLines(n.from, n.to) && n.node.parent && n.node.parent.name === 'Document') {
          deco.push(Decoration.replace({ widget: new TableWidget(doc.sliceString(n.from, n.to), ctx), block: true }).range(n.from, n.to));
          tables.add(n.from);
        }
        return false;
      }
      if (name === 'MathBlock') {
        if (!touches(n.from, n.to) && wholeLines(n.from, n.to)) {
          const src = doc.sliceString(n.from, n.to).replace(/^\$\$/, '').replace(/\$\$$/, '');
          deco.push(Decoration.replace({ widget: new MathWidget(src.trim(), true, true), block: true }).range(n.from, n.to));
        }
        return false;
      }
      if (name === 'FencedCode') {
        const info = n.node.getChild('CodeInfo');
        const lang = info ? doc.sliceString(info.from, info.to).trim().toLowerCase() : '';
        const marks = n.node.getChildren('CodeMark');
        if (lang === 'mermaid' && marks.length > 1 && !touches(n.from, n.to) && wholeLines(n.from, n.to)) {
          const code = doc.sliceString(doc.lineAt(n.from).to + 1, marks[marks.length - 1].from).replace(/\n[ \t]*$/, '');
          deco.push(Decoration.replace({ widget: new MermaidWidget(code, !!(ctx.isDark && ctx.isDark())), block: true }).range(n.from, n.to));
          mermaid.add(n.from);
        }
        return false;
      }
      if (/^(Paragraph|ATXHeading\d|SetextHeading\d|HTMLBlock|LinkReference|CodeBlock|HorizontalRule|ObsCommentBlock|Blockquote|BulletList|OrderedList)$/.test(name)) return false;
    },
  });
  return { decorations: Decoration.set(deco, true), mermaid, tables };
}

const liveBlocks = StateField.define({
  create: state => buildBlocks(state),
  update(value, tr) {
    if (tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState) || tr.effects.some(e => e.is(refreshEffect))) return buildBlocks(tr.state);
    return value;
  },
  provide: f => EditorView.decorations.from(f, v => v.decorations),
});

export const livePreview = [liveBlocks, livePlugin, EditorView.editorAttributes.of({ class: 'is-live-preview' })];

// ---- links: Ctrl/Cmd+click to follow ------------------------------------------------------------------
// A plain click on a link puts the cursor there to edit it (its Markdown appears). Ctrl/Cmd+click or a
// middle click follows it: internal links open the note in the editor, in the same tab with Ctrl/Cmd
// and a new one with Ctrl/Cmd+Shift or the middle button. Holding Ctrl/Cmd shows links as clickable.
export const linkClicks = [
  EditorView.domEventHandlers({
    mousedown(e, view) {
      if (e.button !== 0 && e.button !== 1) return false;
      const el = e.target instanceof Element ? e.target.closest('[data-wikilink], [data-href]') : null;
      if (!el) return false;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod && e.button !== 1) return false;
      const { openLink } = view.state.facet(editorContext); if (!openLink) return false;
      e.preventDefault();
      const newTab = e.button === 1 || e.shiftKey;
      if (el.hasAttribute('data-wikilink')) openLink({ type: 'wiki', target: el.getAttribute('data-wikilink'), newTab });
      else openLink({ type: 'url', href: el.getAttribute('data-href'), newTab: true });
      return true;
    },
    keydown(e, view) { view.dom.classList.toggle('ws-mod-held', e.key === 'Control' || e.key === 'Meta' || e.ctrlKey || e.metaKey); return false; },
    keyup(e, view) { if (!e.ctrlKey && !e.metaKey) view.dom.classList.remove('ws-mod-held'); return false; },
    blur(e, view) { view.dom.classList.remove('ws-mod-held'); return false; },
    mousemove(e, view) { view.dom.classList.toggle('ws-mod-held', e.ctrlKey || e.metaKey); return false; },
  }),
];

// The link (wiki, markdown, bare URL) at a position, for "follow link under cursor".
export function linkAt(state, pos) {
  for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (node.name === 'WikiLink' || node.name === 'Embed') {
      const tgt = node.getChild('WikiTarget'); return tgt ? { type: 'wiki', target: state.sliceDoc(tgt.from, tgt.to) } : null;
    }
    if (node.name === 'Link' || node.name === 'Autolink') { const url = node.getChild('URL'); return url ? { type: 'url', href: state.sliceDoc(url.from, url.to) } : null; }
    if (node.name === 'URL') return { type: 'url', href: state.sliceDoc(node.from, node.to) };
    if (node.name === 'Hashtag') return { type: 'tag', tag: state.sliceDoc(node.from + 1, node.to) };
  }
  return null;
}
