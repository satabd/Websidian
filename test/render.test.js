'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeVault, FIXTURE } = require('./helpers');
const { Vault } = require('../src/vault');
const { Renderer, slugify } = require('../src/render');

let tmp, vault, out;
before(async () => {
  tmp = makeVault(FIXTURE);
  vault = new Vault({ slug: 's', root: tmp.root, codeLinks: { base: 'https://git.example/repo/blob/main/', vaultPathInRepo: 'docs' } });
  await vault.scan();
  out = await new Renderer().render(vault, 'Home.md');
});
after(() => tmp.rm());

test('frontmatter is parsed and not rendered', () => {
  assert.equal(out.data.title, 'Home Page');
  assert.deepEqual(out.data.tags, ['a', 'b']);
  assert.ok(!out.html.includes('title: Home Page'));
});

test('wikilinks resolve by name, path, alias and heading', () => {
  assert.match(out.html, /<a href="\/s\/sub\/Second" class="internal-link">Second<\/a>/);
  assert.match(out.html, /<a href="\/s\/sub\/Second" class="internal-link">aliased<\/a>/);
  assert.match(out.html, /<a href="\/s\/sub\/Second#part-b" class="internal-link">Second › Part B<\/a>/);
  assert.match(out.html, /<span class="internal-link unresolved"[^>]*>Missing Note<\/span>/);
});

test('image embed with size and note section transclusion', () => {
  assert.match(out.html, /<img src="\/s\/img\/pic\.png" alt="pic\.png" loading="lazy" width="120">/);
  assert.match(out.html, /<div class="embed-note">.*bravo content/s);
  assert.ok(!out.html.includes('alpha'), 'only the requested section is embedded');
  assert.deepEqual(out.deps.map(d => d.rel), ['sub/Second.md']);
});

test('callouts: foldable, nested, default title', () => {
  assert.match(out.html, /<details class="callout callout-tip" data-callout="tip" dir="auto">\s*<summary class="callout-title">.*Fold me/s);
  assert.match(out.html, /<div class="callout callout-warning" data-callout="warning">.*inner/s);   // nested: inherits
  assert.match(out.html, /callout-abstract.*<span class="callout-title-inner">Abstract<\/span>.*Default title/s);
  assert.ok(!out.html.includes('[!tip]'));
});

test('tasks, highlight, comments, mermaid, code, tables, line breaks', () => {
  assert.match(out.html, /<li class="task-list-item is-done"><input type="checkbox" disabled checked> done task/);
  assert.match(out.html, /<li class="task-list-item"><input type="checkbox" disabled> open task/);
  assert.ok(out.html.includes('<mark>highlighted</mark>'));
  assert.ok(!out.html.includes('hidden comment'));
  assert.match(out.html, /<pre class="mermaid">flowchart LR\n\s+A --&gt; B/);
  assert.match(out.html, /<code class="hljs language-js">const x = 1;/);
  assert.match(out.html, /<div class="table-wrap"><table dir="auto">.*<th>h1<\/th>/s);
  assert.match(out.html, /Line one<br>\nLine two/);
});

test('links: repo rewrite, external target, no fuzzy linkify', () => {
  assert.match(out.html, /href="https:\/\/git\.example\/repo\/blob\/main\/src\/thing\.py#L42"/);
  assert.match(out.html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener" class="external-link">ext<\/a>/);
  assert.ok(!out.html.includes('href="http://Odoo.sh"'), 'bare domains are not auto-linked');
});

test('headings get ids and are collected for the TOC', () => {
  assert.match(out.html, /<h1 id="home" dir="auto">Home<\/h1>/);
  assert.deepEqual(out.headings[0], { level: 1, text: 'Home', id: 'home' });
  assert.equal(slugify('ADR-07 — Physical locations are not departments'), 'adr-07-physical-locations-are-not-departments');
  assert.equal(slugify('الخطوات'), 'الخطوات');
});

test('plain text for search strips markup', () => {
  assert.ok(out.text.includes('bravo') === false, 'embeds are not indexed twice');
  assert.ok(out.text.includes('Hidden bold text'));
  assert.ok(!out.text.includes('<'));
});

test('rendering is deterministic', async () => {
  const again = await new Renderer().render(vault, 'Home.md');
  assert.equal(again.html, out.html);
});
