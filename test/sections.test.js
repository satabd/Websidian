'use strict';
// Navigation order and folder notes: `order:` in frontmatter decides the
// sidebar, `Folder/Folder.md` becomes the folder's own page, and a folder
// without one still gets a generated index instead of a 404.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { makeVault } = require('./helpers');
const { Vault, compareOrder } = require('../src/vault');

const FILES = {
  'Home.md': '---\ntitle: Home\norder: 1\n---\n# Home\n',
  'Zebra.md': '---\ntitle: Zebra\n---\nno order, sorts last\n',
  // 01 Guide/01 Guide.md is the folder note for "01 Guide".
  '01 Guide/01 Guide.md': '---\ntitle: The Guide\norder: 1\ndescription: How to use it\n---\n# The Guide\n\nRead these in order.\n',
  '01 Guide/Beta.md': '---\ntitle: Beta\norder: 2\ndescription: second\n---\nb\n',
  '01 Guide/Alpha.md': '---\ntitle: Alpha\norder: 1\nupdated: 2026-09-16\n---\na\n',
  '01 Guide/Unordered.md': '---\ntitle: Unordered\n---\nno order\n',
  '01 Guide/Hidden.md': '---\ntitle: Hidden\nstatus: draft\n---\nsecret\n',
  // 02 Reference has no folder note: its page is generated.
  '02 Reference/Keys.md': '---\ntitle: Keys\n---\nk\n',
  '02 Reference/Deep/Nested.md': '---\ntitle: Nested\n---\nn\n',
  // index.md is accepted as a folder note too.
  'Legacy/index.md': '---\ntitle: Legacy Section\n---\n# Legacy Section\n',
  'Legacy/Thing.md': '---\ntitle: Thing\n---\nt\n',
  '.obsidian/app.json': '{}',
};

let tmp, vault;
before(async () => {
  tmp = makeVault(FILES);
  vault = new Vault({ slug: 's', root: tmp.root, excludeStatus: ['draft'], home: 'Home' });
  await vault.scan();
});
after(() => tmp.rm());

test('compareOrder: numbers first, then the natural fallback', () => {
  assert.ok(compareOrder(1, 2, 'a', 'b') < 0);
  assert.ok(compareOrder(2, 1, 'a', 'b') > 0);
  assert.ok(compareOrder(1, undefined, 'z', 'a') < 0, 'an ordered note beats an unordered one');
  assert.ok(compareOrder(undefined, undefined, 'a', 'b') < 0, 'both unordered: natural sort');
  assert.ok(compareOrder(1, 1, 'a', 'b') < 0, 'tie: natural sort');
  assert.ok(compareOrder('nonsense', 1, 'a', 'b') > 0, 'a non-numeric order is ignored, not trusted');
});

test('order: decides the sidebar, unordered notes follow in natural order', () => {
  const guide = vault.folderNode('01 Guide');
  assert.deepEqual(guide.notes.map(n => n.title), ['Alpha', 'Beta', 'Unordered']);
  const root = vault.getTree();
  assert.deepEqual(root.notes.map(n => n.title), ['Home', 'Zebra']);
});

test('a folder note becomes the folder: title, order, and no duplicate entry', () => {
  const guide = vault.folderNode('01 Guide');
  assert.equal(guide.title, 'The Guide', 'the folder note names the folder');
  assert.equal(guide.rel, '01 Guide/01 Guide.md');
  assert.ok(!guide.notes.some(n => n.rel === '01 Guide/01 Guide.md'), 'not listed inside itself');
  assert.equal(vault.folderNoteRel('01 Guide'), '01 Guide/01 Guide.md');
  assert.equal(vault.folderOfNote('01 Guide/01 Guide.md'), '01 Guide');
  assert.equal(vault.folderOfNote('01 Guide/Alpha.md'), null);
});

test('index.md counts as a folder note', () => {
  const legacy = vault.folderNode('Legacy');
  assert.equal(legacy.title, 'Legacy Section');
  assert.equal(legacy.rel, 'Legacy/index.md');
  assert.deepEqual(legacy.notes.map(n => n.title), ['Thing']);
});

test('a folder note lives at the folder URL', () => {
  assert.equal(vault.noteUrl('01 Guide/01 Guide.md'), '/s/01%20Guide/');
  assert.equal(vault.noteUrl('01 Guide/Alpha.md'), '/s/01%20Guide/Alpha');
  assert.equal(vault.folderUrl('02 Reference/Deep'), '/s/02%20Reference/Deep/');
});

test('folders sort by their folder note order, then naturally', () => {
  const names = vault.getTree().folders.map(f => f.name);
  // "01 Guide" has order 1; the rest are unordered and sort naturally.
  assert.equal(names[0], '01 Guide');
  assert.deepEqual(names.slice(1), ['02 Reference', 'Legacy']);
});

test('folderNode finds nested folders and nothing else', () => {
  assert.equal(vault.folderNode('02 Reference/Deep').name, 'Deep');
  assert.equal(vault.folderNode('nope'), null);
  assert.equal(vault.folderNode('01 Guide/Alpha'), null, 'a note is not a folder');
});

test('hidden notes stay out of the tree and the counts', () => {
  const guide = vault.folderNode('01 Guide');
  assert.ok(!guide.notes.some(n => n.title === 'Hidden'));
});

// ---- over HTTP -------------------------------------------------------------
// Same shape as server.test.js: spawn the real server on the scratch vault.
// Site "s" has generated folder pages; site "n" has them turned off.

const PORT = 18300 + Math.floor(Math.random() * 400);
let proc;
const get = (p) => fetch(`http://127.0.0.1:${PORT}${p}`, { redirect: 'manual' });

before(async () => {
  const cfg = path.join(tmp.root, 'sections-cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({
    port: PORT, host: '127.0.0.1', cacheDir: 'cache', warm: false, log: false,
    sites: [
      { slug: 's', title: 'S', root: '.', home: 'Home', excludeStatus: ['draft'] },
      { slug: 'n', title: 'N', root: '.', home: 'Home', excludeStatus: ['draft'], sectionIndex: false },
    ],
  }));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, MD2HTML_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', d => { out += d; if (out.includes('listening')) resolve(); });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', code => reject(new Error(`server exited ${code}\n${out}`)));
    setTimeout(() => reject(new Error(`server did not start\n${out}`)), 10000);
  });
});
after(() => { if (proc) proc.kill(); });

test('a folder with a folder note serves it at the folder URL', async () => {
  const r = await get('/s/01%20Guide/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Read these in order/);
});

test("the folder note's own path redirects to the folder URL", async () => {
  const r = await get('/s/01%20Guide/01%20Guide');
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/s/01%20Guide/');
});

test('a folder without a folder note gets a generated index', async () => {
  const r = await get('/s/02%20Reference/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /section-index/);
  assert.match(html, /Keys/);
  assert.match(html, /Deep/, 'subfolders are listed too');
});

test('the generated index does not leak hidden notes', async () => {
  const html = await (await get('/s/01%20Guide/')).text();
  assert.doesNotMatch(html, /Hidden/);
});

test('a folder that does not exist is still a 404', async () => {
  assert.equal((await get('/s/nope/')).status, 404);
});

test('sectionIndex: false turns generated folder pages off, folder notes stay', async () => {
  assert.equal((await get('/n/02%20Reference/')).status, 404, 'no generated page');
  assert.equal((await get('/n/01%20Guide/')).status, 200, 'a real folder note is still served');
});

test('a folder note has no previous/next: it is the section, not a step in it', () => {
  assert.deepEqual(vault.neighbours('01 Guide/01 Guide.md'), { prev: null, next: null });
  // Inside the section the pager still works, and skips the folder note.
  const fromAlpha = vault.neighbours('01 Guide/Alpha.md');
  assert.equal(fromAlpha.prev, null, 'Alpha is first; the folder note is not before it');
  assert.equal(fromAlpha.next.title, 'Beta');
});

test('dates survive YAML parsing into the section index', () => {
  const { listHtml } = require('../src/sections');
  const html = listHtml(vault, vault.folderNode('01 Guide'));
  assert.match(html, /updated 2026-09-16/, 'a Date from js-yaml is still shown');
  assert.match(html, /second/, 'description: is shown when a note has one');
});
