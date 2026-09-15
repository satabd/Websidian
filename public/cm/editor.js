// Websidian's note editor: CodeMirror 6 (what Obsidian itself is built on),
// configured to feel like Obsidian — Live Preview and Source mode, Obsidian
// Flavored Markdown, Obsidian's hotkeys and suggestions — and to read the
// vault's .obsidian/app.json (tabs, auto-pairing, link format, line numbers…).
//
// Loaded by /_static/editor.js through the import map; if anything here fails
// to load, the page keeps its plain textarea.
import { EditorState, Compartment, EditorSelection } from '@codemirror/state';
import { EditorView, keymap, drawSelection, dropCursor, rectangularSelection, lineNumbers, highlightSpecialChars } from '@codemirror/view';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { syntaxHighlighting, indentUnit, indentOnInput, codeFolding, foldGutter, foldKeymap, LanguageDescription, syntaxTree } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { search, searchKeymap } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import { tagHighlighter, tags as t } from '@lezer/highlight';
import { obsidianMarkdown, obsTags } from './syntax.js';
import { obsidianClasses, livePreview, linkClicks, editorContext, refreshEffect } from './live-preview.js';
import { editorCommands, obsidianKeymap, wrapOnType } from './commands.js';
import { obsidianCompletion } from './complete.js';
import { VaultIndex, countText, parseLinkTarget, fuzzyFilter } from './vault-index.js';

export { countText, fuzzyFilter };

// Token classes: Obsidian's names for Markdown, CodeMirror 5 names for code
// (what Obsidian themes style inside code blocks).
const highlighter = tagHighlighter([
  ...[1, 2, 3, 4, 5, 6].map(n => ({ tag: t['heading' + n], class: `cm-header cm-header-${n}` })),
  { tag: t.heading, class: 'cm-header' },
  { tag: t.strong, class: 'cm-strong' },
  { tag: t.emphasis, class: 'cm-em' },
  { tag: t.strikethrough, class: 'cm-strikethrough' },
  { tag: obsTags.highlight, class: 'cm-highlight' },
  { tag: obsTags.math, class: 'cm-math' },
  { tag: t.processingInstruction, class: 'cm-formatting' },
  { tag: t.quote, class: 'cm-quote' },
  { tag: t.comment, class: 'cm-comment' },
  { tag: t.keyword, class: 'cm-keyword' },
  { tag: [t.string, t.special(t.string)], class: 'cm-string' },
  { tag: t.regexp, class: 'cm-string-2' },
  { tag: [t.number, t.integer, t.float], class: 'cm-number' },
  { tag: [t.bool, t.null, t.atom], class: 'cm-atom' },
  { tag: t.definition(t.variableName), class: 'cm-def' },
  { tag: t.function(t.variableName), class: 'cm-variable cm-function' },
  { tag: t.variableName, class: 'cm-variable' },
  { tag: t.definition(t.propertyName), class: 'cm-def cm-property' },
  { tag: t.propertyName, class: 'cm-property' },
  { tag: t.operator, class: 'cm-operator' },
  { tag: [t.typeName, t.className, t.namespace], class: 'cm-type' },
  { tag: t.tagName, class: 'cm-tag' },
  { tag: t.attributeName, class: 'cm-attribute' },
  { tag: t.meta, class: 'cm-meta' },
  { tag: [t.standard(t.variableName), t.self], class: 'cm-builtin' },
  { tag: [t.bracket, t.paren, t.brace, t.squareBracket, t.angleBracket], class: 'cm-bracket' },
  { tag: t.punctuation, class: 'cm-punctuation' },
  { tag: t.invalid, class: 'cm-error' },
]);

// Fenced code languages, loaded on first use.
const lang = (name, alias, load) => LanguageDescription.of({ name, alias, load });
const codeLanguages = [
  lang('JavaScript', ['js', 'javascript', 'jsx', 'mjs', 'cjs', 'node'], () => import('@codemirror/lang-javascript').then(m => m.javascript({ jsx: true }))),
  lang('TypeScript', ['ts', 'typescript', 'tsx'], () => import('@codemirror/lang-javascript').then(m => m.javascript({ typescript: true, jsx: true }))),
  lang('CSS', ['css', 'scss', 'less'], () => import('@codemirror/lang-css').then(m => m.css())),
  lang('HTML', ['html', 'htm', 'vue', 'svelte'], () => import('@codemirror/lang-html').then(m => m.html())),
  lang('JSON', ['json', 'json5', 'jsonc'], () => import('@codemirror/lang-json').then(m => m.json())),
  lang('Python', ['python', 'py'], () => import('@codemirror/lang-python').then(m => m.python())),
  lang('YAML', ['yaml', 'yml'], () => import('@codemirror/lang-yaml').then(m => m.yaml())),
  lang('SQL', ['sql', 'pgsql', 'postgresql', 'mysql', 'sqlite'], () => import('@codemirror/lang-sql').then(m => m.sql())),
  lang('XML', ['xml', 'svg', 'xsl', 'plist'], () => import('@codemirror/lang-xml').then(m => m.xml())),
];

// "Mod-Shift-b" -> "Ctrl + Shift + B" (or ⌘⇧B on a Mac), as Obsidian shows hotkeys.
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export function hotkeyLabel(key) {
  if (!key) return '';
  const parts = key.split('-').map(p => (p === '' ? '-' : p));
  const map = isMac ? { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Enter: '↵' } : { Mod: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Ctrl: 'Ctrl', Enter: 'Enter' };
  const out = parts.map(p => map[p] || (p.length === 1 ? p.toUpperCase() : p));
  return isMac ? out.join('') : out.join(' + ');
}

// cssclasses / cssclass from frontmatter (inline list, block list or scalar).
function cssClassesOf(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text); if (!fm) return [];
  const m = /^cssclass(?:es)?:[ \t]*(.*)$((?:\r?\n[ \t]+-.*)*)/m.exec(fm[1]); if (!m) return [];
  const inline = m[1].trim().replace(/^\[|\]$/g, '');
  const items = inline ? inline.split(/[,\s]+/) : m[2].split(/\r?\n/).map(l => l.replace(/^\s*-\s*/, ''));
  return items.map(s => s.trim().replace(/^["']|["']$/g, '')).filter(s => /^[\w-]+$/.test(s));
}

export function createEditor(opts) {
  const { parent, doc = '', rel, base, settings: S = {}, api, onChange, onSelection, openLink, isDark } = opts;
  const index = new VaultIndex({ rel, base, settings: S });
  let view = null, tagsP = null, propsP = null;
  const lp = new Compartment();
  let livePreviewOn = opts.livePreview !== undefined ? !!opts.livePreview : S.livePreview !== false;

  const commands = editorCommands();
  const ctx = {
    index, rel, settings: S, load: api,
    ready: Promise.all([api.notes(), api.files()]).then(([n, f]) => {
      index.setNotes(Array.isArray(n) ? n : []); index.setFiles(Array.isArray(f) ? f : []); index.loaded = true;
      if (view) view.dispatch({ effects: refreshEffect.of(null) });
    }).catch(() => {}),
    tags: () => tagsP || (tagsP = api.tags().catch(() => [])),
    properties: () => propsP || (propsP = api.properties().catch(() => [])),
    commands: () => commands,
    isDark: isDark || (() => false),
  };

  // Turn a clicked/followed link into something the page can navigate to.
  ctx.openLink = (link) => {
    if (!openLink || !link) return;
    if (link.type !== 'wiki') return openLink(link);
    const p = parseLinkTarget(link.target);
    const r = index.resolve(link.target);
    if (!r) return openLink({ type: 'new', path: p.path, newTab: link.newTab });
    if (r.kind === 'file') return openLink({ type: 'file', url: index.fileUrl(r.rel), newTab: link.newTab });
    if (r.self) { if (p.heading) scrollToHeading(p.heading); return; }
    openLink({ type: 'note', rel: r.rel, heading: p.heading, block: p.block, newTab: link.newTab });
  };

  const autoPair = S.autoPairBrackets !== false;
  const extensions = [
    editorContext.of(ctx),
    history(),
    drawSelection(),
    dropCursor(),
    highlightSpecialChars(),
    EditorState.allowMultipleSelections.of(true),
    EditorView.clickAddsSelectionRange.of(e => e.altKey),   // Ctrl+click follows links, as in Obsidian
    rectangularSelection(),
    indentOnInput(),
    autoPair ? closeBrackets() : [],
    EditorState.languageData.of(() => [{
      closeBrackets: { brackets: S.autoPairMarkdown !== false ? ['(', '[', '{', '`'] : ['(', '[', '{'], before: ')]}:;>`' },
      commentTokens: { block: { open: '%%', close: '%%' } },
    }]),
    S.autoPairMarkdown !== false ? wrapOnType : [],
    EditorView.lineWrapping,
    EditorView.perLineTextDirection.of(true),               // Arabic and English lines side by side
    EditorView.contentAttributes.of({ spellcheck: S.spellcheck === false ? 'false' : 'true', autocorrect: 'on', autocapitalize: 'sentences', 'aria-label': 'Note text' }),
    S.rightToLeft ? EditorView.contentAttributes.of({ dir: 'rtl' }) : [],
    indentUnit.of(S.useTab === false ? ' '.repeat(S.tabSize || 4) : '\t'),
    EditorState.tabSize.of(S.tabSize || 4),
    S.showLineNumber ? lineNumbers() : [],
    S.foldHeading !== false || S.foldIndent !== false ? [codeFolding({ placeholderText: '…' }), foldGutter({ markerDOM: open => { const s = document.createElement('span'); s.className = 'collapse-indicator' + (open ? '' : ' is-collapsed'); s.textContent = open ? '⌄' : '›'; return s; } })] : [],
    yamlFrontmatter({ content: markdown({ extensions: obsidianMarkdown, codeLanguages, addKeymap: S.smartIndentList !== false, completeHTMLTags: false }) }),
    syntaxHighlighting(highlighter),
    obsidianClasses,
    lp.of(livePreviewOn ? livePreview : []),
    linkClicks,
    search({ top: true }),
    obsidianCompletion(ctx),
    obsidianKeymap(commands),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap.filter(k => k.key !== 'Mod-d'), ...historyKeymap, ...foldKeymap]),
    EditorView.updateListener.of(u => {
      if (u.docChanged) { onChange && onChange(); scheduleCss(); }
      if ((u.selectionSet || u.docChanged) && onSelection) onSelection();
    }),
  ];

  // Start below the frontmatter, as Obsidian does (so the Properties panel is shown, not its YAML).
  let start = 0;
  const fmEnd = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(doc);
  if (fmEnd) start = Math.min(doc.length, fmEnd[0].length);
  view = new EditorView({ state: EditorState.create({ doc, extensions, selection: { anchor: start } }), parent });
  parent.classList.add('markdown-source-view', 'mod-cm6');
  parent.classList.toggle('is-live-preview', livePreviewOn);
  parent.classList.toggle('is-readable-line-width', S.readableLineLength !== false);

  // Frontmatter cssclasses apply to the editor too (Obsidian does the same).
  let cssTimer = null, cssApplied = [];
  function applyCss() {
    for (const c of cssApplied) parent.classList.remove(c);
    cssApplied = cssClassesOf(view.state.sliceDoc(0, Math.min(view.state.doc.length, 4000)));
    for (const c of cssApplied) parent.classList.add(c);
  }
  function scheduleCss() { clearTimeout(cssTimer); cssTimer = setTimeout(applyCss, 400); }
  applyCss();

  function scrollToHeading(text) {
    const want = String(text).trim().toLowerCase(); let found = -1;
    syntaxTree(view.state).iterate({ enter: n => {
      if (found >= 0) return false;
      if (/^ATXHeading\d$/.test(n.name)) {
        const h = view.state.sliceDoc(n.from, n.to).replace(/^#+\s*/, '').replace(/\s+#+\s*$/, '').trim().toLowerCase();
        if (h === want) found = n.from;
        return false;
      }
    } });
    if (found < 0) return false;
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.lineAt(found).to), effects: EditorView.scrollIntoView(found, { y: 'start', yMargin: 40 }) });
    view.focus();
    return true;
  }

  function setLivePreview(on) {
    livePreviewOn = !!on;
    view.dispatch({ effects: lp.reconfigure(livePreviewOn ? livePreview : []) });
    parent.classList.toggle('is-live-preview', livePreviewOn);
  }

  return {
    kind: 'codemirror', view, index,
    get: () => view.state.doc.toString(),
    set: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
    focus: () => view.focus(),
    isLivePreview: () => livePreviewOn,
    setLivePreview,
    refresh: () => view.dispatch({ effects: refreshEffect.of(null) }),
    scrollToHeading,
    cursor: () => { const h = view.state.selection.main.head; const l = view.state.doc.lineAt(h); return { line: l.number, col: h - l.from + 1, selected: view.state.selection.ranges.reduce((a, r) => a + r.to - r.from, 0) }; },
    selectedText: () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
    commands: commands.map(c => ({ id: c.id, name: c.name, hotkey: hotkeyLabel(c.hotkey), run: () => { view.focus(); c.run(view); } })),
    destroy: () => view.destroy(),
  };
}
