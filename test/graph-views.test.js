'use strict';
// Named views (frontmatter `views:`) in the graph JSON, the directed reach
// helper in public/graph.js, and the Explore panel controls for both.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeVault } = require('./helpers');
const { Vault } = require('../src/vault');
const { buildGraph, collectViews, viewsHash } = require('../src/graph');
const { exploreDocument } = require('../src/layout');

const FILES = {
  'Start.md': [
    '---',
    'views:',
    '  - id: onboarding',
    '    label: Start here',
    '    note: The path a new reader should take.',
    '    focus: ["[[Tour]]", "guide/Setup", "Missing note", "Hidden", "Tour"]',
    '  - label: Deep dive',
    '    focus: [Setup]',
    '---',
    '# Start',
    '[[Tour]] [[Setup]]',
  ].join('\n'),
  'Tour.md': '---\nviews: [onboarding, extras]\n---\n# Tour\n[[guide/Setup]]\n',
  'guide/Setup.md': '---\nviews: Extras\n---\n# Setup\n[[Deploy]]\n',
  'guide/Deploy.md': '# Deploy\n[[Start]]\n',
  'Hidden.md': '---\nstatus: draft\nviews: [onboarding]\n---\n# Hidden\n[[Tour]]\n',
  'Alone.md': '---\nviews:\n  - id: empty\n    focus: [Nowhere]\n---\n# Alone\n',
};

let tmp, vault;
before(async () => { tmp = makeVault(FILES); vault = new Vault({ slug: 's', root: tmp.root, excludeStatus: ['draft'] }); await vault.scan(); });
after(() => tmp.rm());

test('collectViews: object form defines, string form joins, focus order first, hidden and unknown notes dropped', () => {
  const views = collectViews(vault, vault.visibleNotesSorted());
  assert.deepEqual(views.map(v => v.id), ['deep-dive', 'extras', 'onboarding'], 'sorted by label; a view with no visible member is dropped');
  const onboarding = views.find(v => v.id === 'onboarding');
  assert.equal(onboarding.label, 'Start here');
  assert.equal(onboarding.note, 'The path a new reader should take.');
  assert.equal(onboarding.from, 'Start.md');
  // focus resolves wikilink syntax and paths, ignores the missing and the hidden note, deduplicates; joined notes (Tour) are not repeated
  assert.deepEqual(onboarding.members, ['Tour.md', 'guide/Setup.md']);
  const extras = views.find(v => v.id === 'extras');
  assert.equal(extras.label, 'extras', 'a joined-only view takes its id as label');
  assert.deepEqual(extras.members, ['guide/Setup.md', 'Tour.md'], 'joined notes ordered by title');
  const deep = views.find(v => v.id === 'deep-dive');
  assert.equal(deep.label, 'Deep dive', 'id derived from the label when absent');
  assert.deepEqual(deep.members, ['guide/Setup.md']);
});

test('buildGraph carries the views in both the global and the local shape', () => {
  assert.equal(buildGraph(vault).views.length, 3);
  assert.equal(buildGraph(vault, { rel: 'Tour.md', depth: 1 }).views.length, 3);
  assert.equal(buildGraph(vault, { rel: 'nope.md' }).views.length, 3);
});

test('viewsHash changes when a views: declaration changes', async () => {
  const h1 = viewsHash(vault);
  fs.writeFileSync(path.join(tmp.root, 'guide/Deploy.md'), '---\nviews: [onboarding]\n---\n# Deploy\n[[Start]]\n');
  await vault.scan();
  const h2 = viewsHash(vault);
  assert.notEqual(h1, h2);
  assert.deepEqual(collectViews(vault, vault.visibleNotesSorted()).find(v => v.id === 'onboarding').members, ['Tour.md', 'guide/Setup.md', 'guide/Deploy.md']);
  fs.writeFileSync(path.join(tmp.root, 'guide/Deploy.md'), FILES['guide/Deploy.md']);
  await vault.scan();
  assert.equal(viewsHash(vault), h1);
});

// ---- the client helper --------------------------------------------------
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'graph.js'), 'utf8');
const sandbox = { window: {}, document: { documentElement: {} }, getComputedStyle: () => ({ getPropertyValue: () => '' }) };
vm.runInNewContext(src, sandbox);
const G = sandbox.window.WEBSIDIAN_GRAPH;

// A -> B -> C -> D, and E -> C; D -> A closes a cycle
const IDS = ['A', 'B', 'C', 'D', 'E'];
const EDGES = [['A', 'B'], ['B', 'C'], ['C', 'D'], ['E', 'C'], ['D', 'A']];
const plain = o => JSON.parse(JSON.stringify(o));

test('reach: downstream follows links out, upstream follows links in, with hop counts', () => {
  const down = plain(G.reach(IDS, EDGES, 'B', 'down', 0));
  assert.deepEqual(down.depth, { B: 0, C: 1, D: 2, A: 3 });
  assert.deepEqual(down.edges, [['B', 'C'], ['C', 'D'], ['D', 'A'], ['A', 'B']], 'the cycle edge back into the root is walked too');
  const up = plain(G.reach(IDS, EDGES, 'C', 'up', 0));
  assert.deepEqual(up.depth, { C: 0, B: 1, E: 1, A: 2, D: 3 });
  assert.ok(up.edges.some(e => e[0] === 'E' && e[1] === 'C'), 'edges keep the graph direction');
  assert.ok(up.edges.every(e => e[0] in up.depth && e[1] in up.depth), 'every walked edge joins two reached notes');
});

test('reach: hop limit, both directions, self-loops ignored, unknown root is null', () => {
  const one = plain(G.reach(IDS, EDGES, 'B', 'down', 1));
  assert.deepEqual(one.depth, { B: 0, C: 1 });
  assert.deepEqual(one.edges, [['B', 'C']]);
  const both = plain(G.reach(IDS, EDGES, 'C', 'both', 1));
  assert.deepEqual(both.depth, { C: 0, D: 1, B: 1, E: 1 });
  assert.equal(both.edges.length, 3);
  assert.equal(G.reach(IDS, EDGES.concat([['C', 'C']]), 'C', 'down', 1).edges.length, 1);
  assert.equal(G.reach(IDS, EDGES, 'Z', 'up', 0), null);
  assert.equal(G.reach(IDS, [], 'A', 'both', 0).edges.length, 0);
});

test('exploreDocument: reach and views controls, the caption, and the R hotkey hint', () => {
  const html = exploreDocument({ vault, vaults: [vault], focus: '' });
  for (const id of ['exReachFrom', 'exReachDir', 'exReachDepth', 'exReachGo', 'exReachClear', 'exReachResult', 'exViews', 'exCaption', 'exCaptionTitle', 'exCaptionNote', 'exCaptionList', 'exCaptionClose']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /<option value="up"[^>]*>Upstream/);
  assert.match(html, /<option value="0"[^>]*>Any</);
  assert.match(html, /<kbd>R<\/kbd> over a node shows its reach/);
  // the earlier controls are still there
  for (const id of ['exPathGo', 'exCollapseAll', 'exLayout', 'exColorBy']) assert.match(html, new RegExp(`id="${id}"`), id);
});
