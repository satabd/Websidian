'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeVault, FIXTURE } = require('./helpers');
const { Vault } = require('../src/vault');

let tmp, vault;
before(async () => {
  tmp = makeVault(FIXTURE);
  vault = new Vault({ slug: 's', root: tmp.root, excludeStatus: ['draft'], basePath: '/docs', home: 'Home' });
  await vault.scan();
});
after(() => tmp.rm());

test('index lists notes and files, skips dot-folders', () => {
  assert.deepEqual([...vault.notes.keys()].sort(), ['Home.md', 'ar/عربي.md', 'sub/Draft.md', 'sub/Second.md']);
  assert.deepEqual([...vault.files.keys()], ['img/pic.png']);
  assert.equal(vault.note('Home.md').title, 'Home Page');
});

test('hidden notes are excluded from navigation and home resolves', () => {
  assert.equal(vault.note('sub/Draft.md').hidden, true);
  assert.ok(!vault.visibleNotesSorted().some(n => n.rel === 'sub/Draft.md'));
  assert.equal(vault.homeRel(), 'Home.md');
  const tree = vault.getTree();
  assert.deepEqual(tree.folders.map(f => f.title), ['Ar', 'Sub']);
  assert.deepEqual(tree.folders[1].notes.map(n => n.title), ['Second']);
});

test('resolution: basename, path, case-insensitive, relative, files', () => {
  assert.equal(vault.resolveNote('Second', 'Home.md'), 'sub/Second.md');
  assert.equal(vault.resolveNote('sub/Second', ''), 'sub/Second.md');
  assert.equal(vault.resolveNote('second.md', ''), 'sub/Second.md');
  assert.equal(vault.resolveNote('Second', 'sub/Draft.md'), 'sub/Second.md');
  assert.equal(vault.resolveNote('Nope', ''), null);
  assert.equal(vault.resolveFile('pic.png', 'Home.md'), 'img/pic.png');
  assert.deepEqual(vault.resolve('pic.png', ''), { kind: 'file', rel: 'img/pic.png', isImage: true });
});

test('urls honour basePath and encode unicode', () => {
  assert.equal(vault.siteUrl(), '/docs/s/');
  assert.equal(vault.noteUrl('sub/Second.md'), '/docs/s/sub/Second');
  assert.equal(vault.noteUrl('ar/عربي.md'), '/docs/s/ar/%D8%B9%D8%B1%D8%A8%D9%8A');
  assert.equal(vault.fileUrl('img/pic.png'), '/docs/s/img/pic.png');
});

test('backlinks and neighbours', () => {
  assert.deepEqual(vault.backlinksOf('sub/Second.md').map(n => n.rel), ['Home.md']);
  assert.deepEqual(vault.backlinksOf('Home.md').map(n => n.rel), ['ar/عربي.md', 'sub/Second.md']); // hidden Draft never listed, self-link ignored
  const { prev, next } = vault.neighbours('sub/Second.md');
  assert.equal(prev, null); assert.equal(next, null); // Draft is hidden, so Second is alone in its folder
});

test('rescan picks up new, changed and removed notes; hashes move only when they should', async () => {
  const list1 = vault.listHash, links1 = vault.linkHash;
  fs.writeFileSync(path.join(tmp.root, 'Missing Note.md'), '# Missing Note\n[[Second]]\n');
  await vault.scan();
  assert.notEqual(vault.listHash, list1, 'file list changed');
  assert.notEqual(vault.linkHash, links1, 'links changed');
  assert.equal(vault.resolveNote('Missing Note', ''), 'Missing Note.md');
  assert.ok(vault.backlinksOf('sub/Second.md').some(n => n.rel === 'Missing Note.md'));

  const list2 = vault.listHash;
  fs.writeFileSync(path.join(tmp.root, 'Missing Note.md'), '# Missing Note\n[[Second]] edited body only\n');
  await vault.scan();
  assert.equal(vault.listHash, list2, 'content edit does not change the file-list hash');

  fs.unlinkSync(path.join(tmp.root, 'Missing Note.md'));
  await vault.scan();
  assert.equal(vault.resolveNote('Missing Note', ''), null);
  assert.equal(vault.listHash, list1);
});
