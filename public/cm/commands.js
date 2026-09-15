// Obsidian's editing commands and default hotkeys, as CodeMirror commands.
// Every command here is also listed in the command palette (Ctrl+P) and the
// slash menu, with the hotkey Obsidian uses for it.
import { EditorSelection, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentMore, indentLess, insertTab, undo, redo, selectAll } from '@codemirror/commands';
import { foldAll, unfoldAll, foldCode, unfoldCode } from '@codemirror/language';
import { openSearchPanel } from '@codemirror/search';
import { startCompletion } from '@codemirror/autocomplete';
import { linkAt, editorContext } from './live-preview.js';

// ---- inline wrappers ------------------------------------------------------------------------

// Toggle `mark` around every selection: unwraps when the selection is already
// wrapped (inside or just outside the marks), wraps the word under an empty
// cursor, or inserts an empty pair with the cursor between.
export function toggleWrap(mark, close = mark) {
  return (view) => {
    const { state } = view;
    view.dispatch(state.changeByRange(range => {
      const { from, to } = range;
      const before = state.sliceDoc(from - mark.length, from), after = state.sliceDoc(to, to + close.length);
      if (before === mark && after === close) {
        return { changes: [{ from: from - mark.length, to: from }, { from: to, to: to + close.length }], range: EditorSelection.range(from - mark.length, to - mark.length) };
      }
      const text = state.sliceDoc(from, to);
      if (text.length >= mark.length + close.length && text.startsWith(mark) && text.endsWith(close)) {
        return { changes: { from, to, insert: text.slice(mark.length, text.length - close.length) }, range: EditorSelection.range(from, to - mark.length - close.length) };
      }
      if (range.empty) {
        const word = state.wordAt(from);
        if (word && word.from < from && word.to > from) {
          return { changes: [{ from: word.from, insert: mark }, { from: word.to, insert: close }], range: EditorSelection.cursor(from + mark.length) };
        }
        return { changes: { from, insert: mark + close }, range: EditorSelection.cursor(from + mark.length) };
      }
      return { changes: [{ from, insert: mark }, { from: to, insert: close }], range: EditorSelection.range(from + mark.length, to + mark.length) };
    }), { userEvent: 'input.format', scrollIntoView: true });
    return true;
  };
}

// Ctrl+K: [selection]() with the cursor in the parentheses; a selected URL becomes [](url).
export function insertMarkdownLink(view) {
  view.dispatch(view.state.changeByRange(range => {
    const text = view.state.sliceDoc(range.from, range.to);
    if (/^(https?:\/\/|mailto:|www\.)\S+$/.test(text)) {
      return { changes: { from: range.from, to: range.to, insert: `[](${text})` }, range: EditorSelection.cursor(range.from + 1) };
    }
    const ins = `[${text}]()`;
    return { changes: { from: range.from, to: range.to, insert: ins }, range: EditorSelection.cursor(range.from + ins.length - 1) };
  }), { userEvent: 'input.format', scrollIntoView: true });
  return true;
}

// [[selection]] and open the note suggestions.
export function insertWikilink(embed) {
  return (view) => {
    const open = embed ? '![[' : '[[';
    view.dispatch(view.state.changeByRange(range => {
      const text = view.state.sliceDoc(range.from, range.to);
      return { changes: { from: range.from, to: range.to, insert: open + text + ']]' }, range: EditorSelection.cursor(range.from + open.length + text.length) };
    }), { userEvent: 'input.format' });
    startCompletion(view);
    return true;
  };
}

// ---- line prefixes ----------------------------------------------------------------------------

function selectedLines(state) {
  const seen = new Set(), out = [];
  for (const r of state.selection.ranges) {
    for (let pos = r.from; pos <= r.to;) {
      const line = state.doc.lineAt(pos);
      if (!seen.has(line.number)) { seen.add(line.number); out.push(line); }
      pos = line.to + 1;
    }
  }
  return out;
}

// Replace each selected line's prefix via fn(text) -> new text (only the prefix may change).
function mapLines(view, fn) {
  const changes = [];
  for (const line of selectedLines(view.state)) {
    const next = fn(line.text, line);
    if (next !== line.text) {
      let i = 0; while (i < line.text.length && i < next.length && line.text[i] === next[i]) i++;
      let j = 0; while (j < line.text.length - i && j < next.length - i && line.text[line.text.length - 1 - j] === next[next.length - 1 - j]) j++;
      changes.push({ from: line.from + i, to: line.to - j, insert: next.slice(i, next.length - j) });
    }
  }
  if (changes.length) view.dispatch({ changes, userEvent: 'input.format', scrollIntoView: true });
  return true;
}

const LIST_RE = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[.\]\s+)?/;

export function setHeading(level) {
  return view => mapLines(view, text => {
    const pre = /^\s*(?:>\s?)*/.exec(text)[0]; const rest = text.slice(pre.length);   // keep quote/callout prefixes
    const m = /^(#{1,6})\s+/.exec(rest); const body = m ? rest.slice(m[0].length) : rest;
    if (level === 0 || (m && m[1].length === level)) return pre + body;
    return pre + '#'.repeat(level) + ' ' + body;
  });
}

// Ctrl+L: plain line -> "- [ ] ", unchecked -> checked, checked -> unchecked.
export function toggleChecklist(view) {
  return mapLines(view, text => {
    const m = LIST_RE.exec(text);
    if (m && m[6]) { const ch = m[6][1]; const at = m[0].length - m[6].length + 1; return text.slice(0, at) + (ch === ' ' ? 'x' : ' ') + text.slice(at + 1); }
    if (m) return text.slice(0, m[0].length) + '[ ] ' + text.slice(m[0].length);
    const ind = /^\s*/.exec(text)[0];
    return ind + '- [ ] ' + text.slice(ind.length);
  });
}

export function toggleBulletList(view) {
  return mapLines(view, text => {
    const m = LIST_RE.exec(text); const ind = /^\s*/.exec(text)[0];
    if (m && m[2] && !m[6]) return m[1] + text.slice(m[0].length);
    if (m) return m[1] + '- ' + text.slice(m[0].length);
    return ind + '- ' + text.slice(ind.length);
  });
}

export function toggleNumberedList(view) {
  let n = 0;
  return mapLines(view, text => {
    const m = LIST_RE.exec(text); const ind = /^\s*/.exec(text)[0];
    if (m && m[3]) return m[1] + text.slice(m[0].length);
    n++;
    return (m ? m[1] : ind) + n + '. ' + text.slice(m ? m[0].length : ind.length);
  });
}

export function toggleBlockquote(view) {
  const lines = selectedLines(view.state);
  const all = lines.every(l => /^\s*>/.test(l.text));
  return mapLines(view, text => (all ? text.replace(/^(\s*)>\s?/, '$1') : '> ' + text));
}

// ---- blocks -------------------------------------------------------------------------------------

// Insert a block of text on its own line(s) at the cursor; `cursor` marks where the caret goes.
function insertBlock(template) {
  return (view) => {
    const { state } = view; const r = state.selection.main; const line = state.doc.lineAt(r.from);
    const selected = state.sliceDoc(r.from, r.to);
    let text = template.replace('{sel}', selected);
    const caret = text.indexOf('{cursor}'); text = text.replace('{cursor}', '');
    const atEmpty = line.text.trim() === '' && r.empty;
    const prefix = atEmpty ? '' : (r.from === line.from ? '' : '\n');
    const from = atEmpty ? line.from : r.from, to = atEmpty ? line.to : r.to;
    const insert = prefix + text;
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + prefix.length + (caret >= 0 ? caret : text.length) }, userEvent: 'input.insert', scrollIntoView: true });
    return true;
  };
}

export const insertCallout = (type = 'note') => insertBlock(`> [!${type}] {cursor}\n> {sel}`);
export const insertCodeBlock = insertBlock('```{cursor}\n{sel}\n```');
export const insertMathBlock = insertBlock('$$\n{sel}{cursor}\n$$');
export const insertTable = insertBlock('| {cursor}Column 1 | Column 2 |\n| --- | --- |\n|  |  |');
export const insertHorizontalRule = insertBlock('\n---\n{cursor}');
export const insertComment = toggleWrap('%%');

function pad(n) { return String(n).padStart(2, '0'); }
export function insertText(fn) {
  return view => { const t = fn(); view.dispatch(view.state.replaceSelection(t), { userEvent: 'input.insert' }); return true; };
}
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const now = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// ---- structure ----------------------------------------------------------------------------------

// Ctrl+D (Obsidian "Delete paragraph"): delete the selected lines.
export function deleteParagraph(view) {
  const lines = selectedLines(view.state); if (!lines.length) return false;
  const first = lines[0], last = lines[lines.length - 1]; const doc = view.state.doc;
  const from = last.to < doc.length ? first.from : Math.max(0, first.from - 1);
  const to = last.to < doc.length ? last.to + 1 : last.to;
  view.dispatch({ changes: { from, to }, selection: { anchor: Math.min(from, doc.length - (to - from)) }, userEvent: 'delete.line', scrollIntoView: true });
  return true;
}

// Tab: indent list items (and selections) like Obsidian; elsewhere insert the indent unit.
export function smartTab(view) {
  const { state } = view;
  if (!state.selection.ranges.every(r => r.empty)) return indentMore(view);
  if (selectedLines(state).some(l => LIST_RE.test(l.text) || /^\s*>/.test(l.text))) return indentMore(view);
  return insertTab(view);
}

// Follow the link under the cursor (Alt+Enter), or open it in a new tab (Ctrl+Enter).
export function followLink(newTab) {
  return (view) => {
    const link = linkAt(view.state, view.state.selection.main.head);
    const { openLink } = view.state.facet(editorContext);
    if (!link || !openLink) return false;
    openLink({ ...link, newTab: newTab || link.type === 'url' });
    return true;
  };
}

// Ctrl+Enter: open the link under the cursor in a new tab; on a task line toggle its checkbox instead.
function modEnter(view) {
  if (followLink(true)(view)) return true;
  if (selectedLines(view.state).some(l => /^\s*(?:[-*+]|\d+[.)])\s+\[.\]/.test(l.text))) return toggleChecklist(view);
  return false;
}

// ---- the command list ------------------------------------------------------------------------------
// { id, name, hotkey, run(view), slash? } — names match Obsidian's command palette.
export function editorCommands() {
  const cmd = (id, name, run, hotkey, slash = false) => ({ id: 'editor:' + id, name, run, hotkey, slash });
  return [
    cmd('toggle-bold', 'Toggle bold', toggleWrap('**'), 'Mod-b'),
    cmd('toggle-italics', 'Toggle italics', toggleWrap('*'), 'Mod-i'),
    cmd('toggle-strikethrough', 'Toggle strikethrough', toggleWrap('~~')),
    cmd('toggle-highlight', 'Toggle highlight', toggleWrap('==')),
    cmd('toggle-code', 'Toggle inline code', toggleWrap('`')),
    cmd('toggle-inline-math', 'Toggle inline math', toggleWrap('$')),
    cmd('toggle-comment', 'Toggle comment', insertComment, 'Mod-/'),
    cmd('insert-link', 'Insert Markdown link', insertMarkdownLink, 'Mod-k', true),
    cmd('insert-wikilink', 'Add internal link', insertWikilink(false), null, true),
    cmd('insert-embed', 'Add embed', insertWikilink(true), null, true),
    cmd('toggle-checklist-status', 'Toggle checkbox status', toggleChecklist, 'Mod-l', true),
    cmd('toggle-bullet-list', 'Toggle bullet list', toggleBulletList, null, true),
    cmd('toggle-numbered-list', 'Toggle numbered list', toggleNumberedList, null, true),
    cmd('toggle-blockquote', 'Toggle blockquote', toggleBlockquote, null, true),
    ...[1, 2, 3, 4, 5, 6].map(n => cmd('set-heading-' + n, 'Set as heading ' + n, setHeading(n), null, true)),
    cmd('set-heading-0', 'Remove heading', setHeading(0)),
    cmd('insert-callout', 'Insert callout', insertCallout('note'), null, true),
    ...['tip', 'info', 'warning', 'danger', 'example', 'question', 'todo', 'quote'].map(t => cmd('insert-callout-' + t, 'Insert callout: ' + t, insertCallout(t), null, true)),
    cmd('insert-table', 'Insert table', insertTable, null, true),
    cmd('insert-codeblock', 'Insert code block', insertCodeBlock, null, true),
    cmd('insert-mathblock', 'Insert math block', insertMathBlock, null, true),
    cmd('insert-mermaid', 'Insert Mermaid diagram', insertBlock('```mermaid\nflowchart LR\n  A{cursor} --> B\n```'), null, true),
    cmd('insert-hr', 'Insert horizontal rule', insertHorizontalRule, null, true),
    cmd('insert-date', 'Insert current date', insertText(today), null, true),
    cmd('insert-time', 'Insert current time', insertText(now), null, true),
    cmd('insert-footnote', 'Insert footnote', insertText(() => '^[]'), null, true),
    cmd('delete-paragraph', 'Delete paragraph', deleteParagraph, 'Mod-d'),
    cmd('indent-list', 'Indent list', indentMore, 'Mod-]'),
    cmd('unindent-list', 'Unindent list', indentLess, 'Mod-['),
    cmd('follow-link', 'Follow link under cursor', followLink(false), 'Alt-Enter'),
    cmd('open-link-new-tab', 'Open link under cursor in new tab', modEnter, 'Mod-Enter'),
    cmd('fold-all', 'Fold all headings and lists', foldAll),
    cmd('unfold-all', 'Unfold all headings and lists', unfoldAll),
    cmd('fold-less', 'Fold more', foldCode, 'Mod-Shift-['),
    cmd('fold-more', 'Unfold', unfoldCode, 'Mod-Shift-]'),
    cmd('search', 'Search current file', openSearchPanel, 'Mod-f'),
    cmd('replace', 'Search & replace in current file', openSearchPanel, 'Mod-h'),
    cmd('undo', 'Undo', undo, 'Mod-z'),
    cmd('redo', 'Redo', redo, 'Mod-Shift-z'),
    cmd('select-all', 'Select all', selectAll, 'Mod-a'),
  ];
}

// Keymap for the commands that have a hotkey, above CodeMirror's defaults
// (so Ctrl+D deletes the paragraph, Ctrl+I italicises, as in Obsidian).
export function obsidianKeymap(commands) {
  const bindings = commands.filter(c => c.hotkey && !/^editor:(undo|redo|select-all|search)$/.test(c.id)).map(c => ({ key: c.hotkey, run: c.run, preventDefault: true }));
  bindings.push({ key: 'Tab', run: smartTab }, { key: 'Shift-Tab', run: indentLess });
  return Prec.high(keymap.of(bindings));
}

// "Auto pair Markdown syntax": typing * _ = ~ ` $ % over a selection wraps it instead of replacing it.
const WRAP_CHARS = new Set(['*', '_', '=', '~', '`', '$', '%']);
export const wrapOnType = EditorView.inputHandler.of((view, from, to, text) => {
  if (from === to || !WRAP_CHARS.has(text) || view.state.selection.ranges.some(r => r.empty)) return false;
  view.dispatch(view.state.changeByRange(r => ({
    changes: [{ from: r.from, insert: text }, { from: r.to, insert: text }],
    range: EditorSelection.range(r.from + 1, r.to + 1),
  })), { userEvent: 'input.type' });
  return true;
});
