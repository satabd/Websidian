'use strict';
// The CodeMirror editor's own modules (public/cm/*.js), tested in Node: they
// are plain ES modules that import CodeMirror by bare name, which Node resolves
// from node_modules just as the browser does through the import map.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const mod = name => import(pathToFileURL(path.join(__dirname, '..', 'public', 'cm', name)).href);
let syntax, vi, commands, complete, bm, cmState, cmMarkdown, cmAutocomplete;

before(async () => {
  [syntax, vi, commands, complete, bm] = await Promise.all([mod('syntax.js'), mod('vault-index.js'), mod('commands.js'), mod('complete.js'), mod('blocks-model.js')]);
  cmState = await import('@codemirror/state');
  cmMarkdown = await import('@codemirror/lang-markdown');
  cmAutocomplete = await import('@codemirror/autocomplete');
});

// ---- syntax -------------------------------------------------------------------------------

async function nodes(src) {
  const { parser } = await import('@lezer/markdown');
  const tree = parser.configure(syntax.obsidianMarkdown).parse(src);
  const out = [];
  tree.iterate({ enter: n => { out.push([n.name, src.slice(n.from, n.to)]); } });
  return out;
}
const has = (list, name, text) => list.some(([n, t]) => n === name && (text === undefined || t === text));

test('syntax: wikilinks, embeds, aliases, headings, escaped pipes in tables', async () => {
  const n = await nodes('See [[Note]], [[a/b|Alias]], [[Note#Part B]] and ![[pic.png|120]].\n\n| a | [[x\\|y]] |\n|---|---|\n| 1 | 2 |\n');
  assert.ok(has(n, 'WikiLink', '[[Note]]') && has(n, 'WikiTarget', 'Note'));
  assert.ok(has(n, 'WikiAlias', 'Alias') && has(n, 'WikiTarget', 'a/b'));
  assert.ok(has(n, 'WikiTarget', 'Note#Part B'));
  assert.ok(has(n, 'Embed', '![[pic.png|120]]') && has(n, 'WikiAlias', '120'));
  assert.ok(has(n, 'Table') && has(n, 'WikiTarget', 'x') && has(n, 'WikiAlias', 'y'), 'table cell pipe escaped as \\|');
  assert.ok(!has(n, 'Link'), 'wikilinks are not parsed as Markdown links');
});

test('syntax: highlight, comments, math (money is not math), tags, block ids, footnotes', async () => {
  const n = await nodes('==hi== %%c%% $x^2$ costs $5 and $10 #tag #a/b #1984 x#no ^blk-1\n\nText[^1] and ^[inline].\n');
  assert.ok(has(n, 'Highlight', '==hi==') && has(n, 'ObsComment', '%%c%%') && has(n, 'InlineMath', '$x^2$'));
  assert.equal(n.filter(([x]) => x === 'InlineMath').length, 1, '$5 and $10 stays text');
  assert.ok(has(n, 'Hashtag', '#tag') && has(n, 'Hashtag', '#a/b'));
  assert.ok(!has(n, 'Hashtag', '#1984') && !has(n, 'Hashtag', '#no'), 'digits-only and mid-word are not tags');
  assert.ok(has(n, 'BlockId', '^blk-1') && has(n, 'FootnoteRef', '[^1]') && has(n, 'InlineFootnote', '^[inline]'));
});

test('syntax: $$ and %% blocks, tasks with any status character, callout is not a link', async () => {
  const n = await nodes('$$\n\\frac{a}{b}\n$$\n\n%%\nhidden\n%%\n\n- [x] done\n- [/] half\n- [ ] open\n\n> [!tip] Title\n> body\n');
  assert.ok(has(n, 'MathBlock', '$$\n\\frac{a}{b}\n$$') && has(n, 'ObsCommentBlock', '%%\nhidden\n%%'));
  assert.deepEqual(n.filter(([x]) => x === 'TaskMarker').map(([, t]) => t), ['[x]', '[/]', '[ ]']);
  assert.ok(has(n, 'Blockquote'));
});

// ---- vault index -------------------------------------------------------------------------------

function index(rel = 'guides/Start.md', settings = {}) {
  const ix = new vi.VaultIndex({ rel, base: '/s/', settings });
  ix.setNotes([{ rel: 'guides/Start.md', title: 'Start' }, { rel: 'guides/Setup.md', title: 'Setup' }, { rel: 'ref/Setup.md', title: 'Setup (ref)' }, { rel: 'Glossary.md', title: 'Glossary', aliases: ['Terms'] }, { rel: 'deep/nested/Glossary.md', title: 'Other glossary' }]);
  ix.setFiles([{ rel: 'img/pic one.png', name: 'pic one.png' }, { rel: 'docs/manual.pdf', name: 'manual.pdf' }]);
  ix.loaded = true;
  return ix;
}

test('vault index: resolves like Obsidian (same folder first, then shortest path)', () => {
  const ix = index();
  assert.equal(ix.resolveNote('Setup'), 'guides/Setup.md', 'same folder wins');
  assert.equal(index('Glossary.md').resolveNote('Setup'), 'ref/Setup.md', 'else shortest path (ties alphabetical)');
  assert.equal(ix.resolveNote('ref/Setup'), 'ref/Setup.md');
  assert.equal(ix.resolveNote('glossary'), 'Glossary.md', 'case-insensitive, shortest');
  assert.equal(ix.resolveNote('nested/Glossary'), 'deep/nested/Glossary.md', 'path suffix');
  assert.deepEqual(ix.resolve('pic one.png'), { kind: 'file', rel: 'img/pic one.png' });
  assert.deepEqual(ix.resolve('Setup#Install|how'), { kind: 'note', rel: 'guides/Setup.md' });
  assert.equal(ix.resolve('Nope'), null);
  assert.equal(ix.resolve('#Local heading').self, true);
  assert.equal(ix.fileUrl('img/pic one.png'), '/s/img/pic%20one.png');
});

test('vault index: link text follows the vault "new link format"', () => {
  assert.equal(index().linkText('Glossary.md'), 'Glossary', 'shortest: bare name… ');
  assert.equal(index().linkText('ref/Setup.md'), 'ref/Setup', '…unless another note has the same name');
  assert.equal(index('guides/Start.md', { newLinkFormat: 'absolute' }).linkText('Glossary.md'), 'Glossary');
  assert.equal(index('guides/Start.md', { newLinkFormat: 'absolute' }).linkText('ref/Setup.md'), 'ref/Setup');
  assert.equal(index('guides/Start.md', { newLinkFormat: 'relative' }).linkText('ref/Setup.md'), '../ref/Setup');
  assert.equal(index().linkText('img/pic one.png', { isFile: true }), 'pic one.png');
});

test('vault index: link target parsing, fuzzy ranking, word counts', () => {
  assert.deepEqual(vi.parseLinkTarget('Note#Head|Alias'), { path: 'Note', heading: 'Head', block: null, alias: 'Alias' });
  assert.deepEqual(vi.parseLinkTarget('Note#^blk'), { path: 'Note', heading: null, block: 'blk', alias: null });
  const list = ['Setup guide', 'Glossary', 'System setup', 'Scenario 9 - Charges'].map(name => ({ name }));
  assert.equal(vi.fuzzyFilter('setup', list, [['name', 1]])[0].name, 'Setup guide', 'prefix beats later match');
  assert.deepEqual(vi.fuzzyFilter('sc9', list, [['name', 1]]).map(x => x.name), ['Scenario 9 - Charges'], 'fuzzy characters in order');
  assert.equal(vi.fuzzyFilter('zzz', list, [['name', 1]]).length, 0);
  assert.deepEqual(vi.countText('---\ntitle: x y z\n---\nHello world, مرحبا بالعالم!\n'), { words: 4, chars: 28 });
  assert.equal(vi.fileKind('a.PNG'), 'image'); assert.equal(vi.fileKind('a.pdf'), 'pdf'); assert.equal(vi.fileKind('Note'), 'note');
});

// ---- commands ----------------------------------------------------------------------------------

// A minimal stand-in for EditorView: enough for commands that only read state and dispatch.
function fakeView(doc, anchor, head = anchor) {
  const { EditorState, EditorSelection } = cmState;
  const v = { state: EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: [EditorState.allowMultipleSelections.of(true)] }) };
  v.dispatch = (...specs) => { v.state = v.state.update(...specs).state; };
  return v;
}

test('commands: toggle bold wraps the selection, the word under the cursor, and unwraps', () => {
  const bold = commands.toggleWrap('**');
  let v = fakeView('make this bold', 5, 9); bold(v);
  assert.equal(v.state.doc.toString(), 'make **this** bold'); assert.equal(v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to), 'this');
  bold(v); assert.equal(v.state.doc.toString(), 'make this bold', 'second press unwraps');
  v = fakeView('make this bold', 7); bold(v); assert.equal(v.state.doc.toString(), 'make **this** bold', 'word under an empty cursor');
  v = fakeView('x ', 2); bold(v); assert.equal(v.state.doc.toString(), 'x ****'); assert.equal(v.state.selection.main.head, 4, 'cursor between the marks');
});

test('commands: headings keep quote prefixes; checklist cycles; lists toggle', () => {
  let v = fakeView('> Plain quote', 3); commands.setHeading(2)(v);
  assert.equal(v.state.doc.toString(), '> ## Plain quote');
  commands.setHeading(2)(v); assert.equal(v.state.doc.toString(), '> Plain quote', 'same level toggles off');
  v = fakeView('## Title', 0); commands.setHeading(3)(v); assert.equal(v.state.doc.toString(), '### Title');
  v = fakeView('buy milk', 0);
  commands.toggleChecklist(v); assert.equal(v.state.doc.toString(), '- [ ] buy milk');
  commands.toggleChecklist(v); assert.equal(v.state.doc.toString(), '- [x] buy milk');
  commands.toggleChecklist(v); assert.equal(v.state.doc.toString(), '- [ ] buy milk');
  v = fakeView('  - item', 4); commands.toggleChecklist(v); assert.equal(v.state.doc.toString(), '  - [ ] item', 'indented bullet gains a box');
  v = fakeView('a\nb', 0, 3); commands.toggleNumberedList(v); assert.equal(v.state.doc.toString(), '1. a\n2. b');
  commands.toggleNumberedList(v); assert.equal(v.state.doc.toString(), 'a\nb');
  v = fakeView('a', 0); commands.toggleBulletList(v); assert.equal(v.state.doc.toString(), '- a');
});

test('commands: Ctrl+K link, delete paragraph', () => {
  let v = fakeView('see docs', 4, 8); commands.insertMarkdownLink(v);
  assert.equal(v.state.doc.toString(), 'see [docs]()'); assert.equal(v.state.selection.main.head, 11, 'cursor in the parentheses');
  v = fakeView('https://x.io', 0, 12); commands.insertMarkdownLink(v);
  assert.equal(v.state.doc.toString(), '[](https://x.io)'); assert.equal(v.state.selection.main.head, 1);
  v = fakeView('one\ntwo\nthree', 5); commands.deleteParagraph(v); assert.equal(v.state.doc.toString(), 'one\nthree');
  v = fakeView('one\ntwo', 6); commands.deleteParagraph(v); assert.equal(v.state.doc.toString(), 'one');
});

test('commands: the list has Obsidian names and hotkeys, and slash entries', () => {
  const list = commands.editorCommands();
  const byId = Object.fromEntries(list.map(c => [c.id, c]));
  assert.equal(byId['editor:toggle-bold'].hotkey, 'Mod-b');
  assert.equal(byId['editor:toggle-checklist-status'].hotkey, 'Mod-l');
  assert.equal(byId['editor:delete-paragraph'].hotkey, 'Mod-d');
  assert.equal(byId['editor:insert-link'].hotkey, 'Mod-k');
  assert.ok(list.filter(c => c.slash).length >= 15);
  assert.equal(new Set(list.map(c => c.id)).size, list.length, 'ids are unique');
});

// ---- completion --------------------------------------------------------------------------------

function completionCtx(extra = {}) {
  return {
    index: index('guides/Start.md'), rel: 'guides/Start.md', settings: {}, ready: Promise.resolve(),
    load: { anchors: async rel => (rel === 'Glossary.md' ? { headings: [{ level: 2, text: 'Terms A–Z' }], blocks: [{ id: 'def-1', text: 'A definition' }] } : { headings: [], blocks: [] }) },
    tags: async () => [{ tag: 'project', count: 3 }, { tag: 'hms/billing', count: 1 }],
    properties: async () => [{ name: 'status', count: 5, type: 'string', values: ['draft', 'ready'] }, { name: 'tags', count: 3, type: 'list', values: [] }],
    commands: () => commands.editorCommands(),
    ...extra,
  };
}
function run(source, doc, pos = doc.length, explicit = false) {
  const { EditorState } = cmState;
  const state = EditorState.create({ doc, extensions: [cmMarkdown.markdown({ extensions: syntax.obsidianMarkdown })] });
  return source(new cmAutocomplete.CompletionContext(state, pos, explicit));
}

test('completion: [[ suggests notes, aliases and a new-note option; ![[ puts files first', async () => {
  const s = complete.completionSources(completionCtx());
  const r = await run(s.wikiSource, 'See [[glos');
  assert.equal(r.from, 6);
  const labels = r.options.map(o => o.label);
  assert.ok(labels.includes('Glossary') && labels.includes('Other glossary'));
  assert.ok(labels.includes('glos') && r.options.find(o => o.label === 'glos').detail === 'Link to a new note');
  const alias = (await run(s.wikiSource, '[[terms')).options.find(o => o.label === 'Terms');
  assert.ok(alias && alias.detail.includes('Glossary'), 'aliases are suggested');
  const emb = await run(s.wikiSource, '![[pic');
  assert.equal(emb.options[0].label, 'pic one.png');
  assert.equal(await run(s.wikiSource, '```\n[[glos'), null, 'not inside a code block');
  assert.equal(await run(s.wikiSource, '[[Glossary|x'), null, 'not in the alias part');
});

test('completion: [[note# headings, [[note#^ blocks, [[# this note', async () => {
  const s = complete.completionSources(completionCtx());
  const h = await run(s.wikiSource, '[[Glossary#ter');
  assert.deepEqual(h.options.map(o => o.label), ['Terms A–Z']); assert.equal(h.from, 11);
  const b = await run(s.wikiSource, '[[Glossary#^de');
  assert.deepEqual(b.options.map(o => o.label), ['^def-1']);
  const local = await run(s.wikiSource, '# First\n\n## Second\n\n[[#sec');
  assert.deepEqual(local.options.map(o => o.label), ['Second'], 'headings of the unsaved text');
});

test('completion: #tags outside code and frontmatter; property names and values in frontmatter', async () => {
  const s = complete.completionSources(completionCtx());
  assert.deepEqual((await run(s.tagSource, 'text #pro')).options.map(o => o.label), ['project']);
  assert.deepEqual((await run(s.tagSource, 'text #bill')).options.map(o => o.label), ['hms/billing']);
  assert.equal(await run(s.tagSource, '```\n#pro'), null, 'not inside a code block');
  assert.equal(await run(s.tagSource, 'a#pro'), null, 'mid-word # is not a tag');
  const fm = '---\nsta\n---\n';
  assert.deepEqual((await run(s.propertySource, fm, 7)).options.map(o => o.label), ['status']);
  const val = '---\nstatus: dr\n---\n';
  assert.deepEqual((await run(s.propertySource, val, 14)).options.map(o => o.label), ['draft']);
  const tagList = '---\ntags:\n  - pro\n---\n';
  assert.deepEqual((await run(s.propertySource, tagList, 17)).options.map(o => o.label), ['project'], 'list items under tags: use the vault tags');
});

test('completion: slash commands at a line start or after a space, not in paths', async () => {
  const s = complete.completionSources(completionCtx());
  const r = await run(s.slashSource, 'x /callout');
  assert.ok(r.options[0].label.startsWith('Insert callout')); assert.equal(r.from, 2);
  assert.equal(await run(s.slashSource, 'and/or'), null);
  assert.equal(await run(s.slashSource, '/zzzzqq'), null);
  assert.equal((await run(s.slashSource, '/table')).options[0].label, 'Insert table');
  assert.equal(await run(s.slashSource, '---\n/tab\n---\n', 8), null, 'not inside frontmatter');
});

// ---- table editor model ------------------------------------------------------------------------

const applyEdit = (src, ch) => src.slice(0, ch.from) + ch.insert + src.slice(ch.to);

test('table model: rows, escaped pipes, alignment, empty header (as in the OdooHMS notes)', () => {
  const src = '| | |\n|---|:---:|\n| **Front desk** | Registration, [[Glossary\\|terms]] |\n| Pharmacy | Stock |';
  const m = bm.parseTable(src);
  assert.equal(m.cols, 2); assert.deepEqual(m.aligns, [null, 'center']);
  assert.deepEqual(bm.tableMatrix(m), { header: ['', ''], aligns: [null, 'center'], body: [['**Front desk**', 'Registration, [[Glossary|terms]]'], ['Pharmacy', 'Stock']] });
  assert.equal(bm.parseTable('not | a table\njust text'), null);
  assert.deepEqual(bm.splitRow('a | b').map(c => c.text), ['a', 'b'], 'outer pipes are optional');
});

test('table model: editing one cell changes only that cell', () => {
  const src = '| h1 | h2 |\n|---|---|\n| a | b |\n| c | d |';
  const m = bm.parseTable(src);
  assert.equal(applyEdit(src, bm.cellChange(m, 3, 1, 'dee')), '| h1 | h2 |\n|---|---|\n| a | b |\n| c | dee |');
  assert.equal(applyEdit(src, bm.cellChange(m, 0, 0, 'x|y')), '| x\\|y | h2 |\n|---|---|\n| a | b |\n| c | d |', 'pipes are escaped');
  const short = '| h1 | h2 |\n|---|---|\n| only |';
  assert.equal(applyEdit(short, bm.cellChange(bm.parseTable(short), 2, 1, 'new')), '| h1 | h2 |\n|---|---|\n| only | new |', 'short rows are completed');
});

test('table model: add/delete rows and columns, align', () => {
  const m = bm.parseTable('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.equal(bm.tableOp(m, 'addRow', 1), '| a | b |\n| --- | --- |\n| 1 | 2 |\n|  |  |');
  assert.equal(bm.tableOp(m, 'deleteRow', 0), '| a | b |\n| --- | --- |');
  assert.equal(bm.tableOp(m, 'addCol', 1), '| a |  | b |\n| --- | --- | --- |\n| 1 |  | 2 |');
  assert.equal(bm.tableOp(m, 'deleteCol', 0), '| b |\n| --- |\n| 2 |');
  assert.equal(bm.tableOp(m, 'align:right', 1), '| a | b |\n| --- | ---: |\n| 1 | 2 |');
});

// ---- properties model --------------------------------------------------------------------------

const FM = '---\ntitle: What the System Does\ndate: 2026-09-06\ntags:\n  - hms\n  - doc\naliases: [System Overview, "One Pager"]\nlang: en\ndraft: false\ncount: 3\nrelated: "[[Glossary]]"\nnested:\n  a: 1\n---';

test('properties: parse scalars, block and inline lists, raw values; infer Obsidian types', () => {
  const p = bm.frontmatterParts(FM); const { entries } = bm.parseProperties(p.body);
  const by = Object.fromEntries(entries.map(e => [e.key, e]));
  assert.equal(by.title.value, 'What the System Does');
  assert.deepEqual(by.tags.value, ['hms', 'doc']); assert.equal(by.tags.style, 'block');
  assert.deepEqual(by.aliases.value, ['System Overview', 'One Pager']); assert.equal(by.aliases.style, 'inline');
  assert.equal(by.related.value, '[[Glossary]]');
  assert.equal(by.nested.kind, 'raw');
  const t = k => bm.propertyType(by[k]);
  assert.deepEqual(['title', 'date', 'tags', 'aliases', 'draft', 'count', 'nested'].map(t), ['text', 'date', 'tags', 'aliases', 'checkbox', 'number', 'raw']);
  assert.equal(bm.propertyType(by.count, { count: 'text' }), 'text', 'types.json wins');
});

test('properties: edits touch only their entry and write valid YAML', () => {
  const p = bm.frontmatterParts(FM); const parsed = bm.parseProperties(p.body);
  const idx = k => parsed.entries.findIndex(e => e.key === k);
  const edit = (k, text) => { const ch = bm.entryChange(parsed, idx(k), text); return applyEdit(p.body, ch); };
  assert.equal(edit('title', bm.serializeEntry('title', 'text', 'New: title')).split('\n')[0], 'title: "New: title"', 'quoted when YAML needs it');
  const tags = edit('tags', bm.serializeEntry('tags', 'tags', ['hms', '#doc', 'new'], { style: 'block' }));
  assert.match(tags, /^tags:\n  - hms\n  - doc\n  - new\naliases:/m, 'block list kept, # stripped from tags');
  assert.match(edit('aliases', bm.serializeEntry('aliases', 'aliases', ['A'], { style: 'inline' })), /^aliases: \[A\]$/m);
  assert.match(edit('draft', bm.serializeEntry('draft', 'checkbox', true)), /^draft: true$/m);
  const removed = applyEdit(p.body, bm.entryChange(parsed, idx('lang'), null));
  assert.ok(!removed.includes('lang:') && removed.includes('date: 2026-09-06\ntags:') && removed.includes('draft: false'));
  assert.equal(bm.yamlScalar('[[Glossary]]'), '"[[Glossary]]"', 'wikilinks must be quoted');
  assert.equal(bm.yamlScalar('true'), '"true"', 'text that looks like a boolean is quoted');
  assert.equal(bm.yamlScalar('2026-09-06', 'date'), '2026-09-06');
});

test('properties: add to empty and non-empty frontmatter', () => {
  const empty = '---\n---'; const p = bm.frontmatterParts(empty);
  const ch = bm.appendEntry(bm.parseProperties(p.body), 'status: draft');
  assert.equal(empty.slice(0, p.bodyStart + ch.from) + ch.insert + empty.slice(p.bodyStart + ch.to), '---\nstatus: draft\n---');
  const one = '---\ntitle: x\n---'; const q = bm.frontmatterParts(one);
  const ch2 = bm.appendEntry(bm.parseProperties(q.body), 'tags:');
  assert.equal(one.slice(0, q.bodyStart + ch2.from) + ch2.insert + one.slice(q.bodyStart + ch2.to), '---\ntitle: x\ntags:\n---');
});

test('table cells: a click in the rendered text maps to the same character in the Markdown', async () => {
  const { sourceOffset, renderInline } = await mod('blocks.js');
  assert.equal(sourceOffset('**Front desk**', 'Front desk', 1), 3, 'after "F" in **Front desk**');
  assert.equal(sourceOffset('**Front desk**', 'Front desk', 10), 12, 'end of the bold text, before the closing **');
  assert.equal(sourceOffset('see [[Glossary|terms]] now', 'see terms now', 13), 26);
  assert.equal(renderInline('**b** `x|y` [[Note|n]] [s](https://a.b) ==h== #tag 42'),
    '<strong>b</strong> <code>x|y</code> <a class="internal-link" data-wikilink="Note">n</a> <a class="external-link" data-href="https://a.b">s</a> <mark>h</mark> <span class="tag">#tag</span> 42');
});
