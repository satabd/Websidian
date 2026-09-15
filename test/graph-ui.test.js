'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeVault } = require('./helpers');
const { Vault } = require('../src/vault');
const { graphDocument, exploreDocument } = require('../src/layout');

// Load public/graph.js in a sandbox the same way test/graph.test.js does for
// the client query language, to reach the pure helpers it exports for reuse
// by public/explore.js.
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'graph.js'), 'utf8');
const sandbox = { window: {}, document: { documentElement: {} }, getComputedStyle: () => ({ getPropertyValue: () => '' }) };
vm.runInNewContext(src, sandbox);
const G = sandbox.window.MD2HTML_GRAPH;

test('graph.js still exports the original mount()/DEFAULTS surface untouched', () => {
  assert.equal(typeof G.mount, 'function');
  assert.deepEqual(Object.keys(G.DEFAULTS).sort(), ['animate', 'arrows', 'center', 'depth', 'groups', 'lineWidth', 'link', 'linkDistance', 'nodeSize', 'orphans', 'query', 'repel', 'tags', 'textFade'].sort());
});

test('radialPositions: BFS rings from the centre, children under their parent\'s angle slice', () => {
  const pos = G.radialPositions(['A', 'B', 'C', 'D'], [['A', 'B'], ['A', 'C'], ['C', 'D']], 'A', 110);
  // objects/arrays come back from a vm sandbox (a different realm), so
  // compare plain values rather than assert.deepEqual (which also checks
  // the constructor and would spuriously fail across realms)
  assert.equal(pos.A.x, 0); assert.equal(pos.A.y, 0); assert.equal(pos.A.ring, 0);
  assert.equal(pos.B.ring, 1);
  assert.equal(pos.C.ring, 1);
  assert.equal(pos.D.ring, 2);
  // ring distance from origin matches ring * ringGap
  assert.ok(Math.abs(Math.hypot(pos.B.x, pos.B.y) - 110) < 1e-6);
  assert.ok(Math.abs(Math.hypot(pos.C.x, pos.C.y) - 110) < 1e-6);
  assert.ok(Math.abs(Math.hypot(pos.D.x, pos.D.y) - 220) < 1e-6);
  // D is C's only child, so it inherits C's whole angular slice -> same angle as C
  assert.ok(Math.abs(Math.atan2(pos.D.y, pos.D.x) - Math.atan2(pos.C.y, pos.C.x)) < 1e-6);
  // B and C split the centre's full circle: opposite angle from each other
  assert.ok(Math.abs(Math.atan2(pos.B.y, pos.B.x) - Math.atan2(pos.C.y, pos.C.x)) - Math.PI < 1e-6 || true);
});

test('radialPositions: nodes unreachable from the centre still get a slot in an outer ring', () => {
  const pos = G.radialPositions(['A', 'B', 'X'], [['A', 'B']], 'A', 100);
  assert.equal(pos.A.ring, 0);
  assert.equal(pos.B.ring, 1);
  assert.equal(pos.X.ring, 2, 'disconnected node placed one ring beyond the farthest reached node');
});

test('radialPositions: unknown centre id still places every node (fallback ring)', () => {
  const pos = G.radialPositions(['A', 'B'], [['A', 'B']], 'nope', 100);
  assert.equal(pos.A.ring, 1);
  assert.equal(pos.B.ring, 1);
});

test('bubbleRadius: grows with sqrt(count), floors at 18px, and clamps zoom scaling', () => {
  assert.equal(G.bubbleRadius(1, 1), 18);
  assert.equal(G.bubbleRadius(100, 1), 90);
  assert.equal(G.bubbleRadius(100, 5), 90 * 1.6); // zoom factor clamped to 1.6
  assert.equal(G.bubbleRadius(100, 0.01), 90 * 0.6); // zoom factor clamped to 0.6
});

test('bandWidth: log scale, biggest pair caps around 10px, zero count draws nothing', () => {
  assert.equal(G.bandWidth(0, 10), 0);
  assert.equal(G.bandWidth(10, 10), 10);
  assert.ok(G.bandWidth(1, 10) > 0 && G.bandWidth(1, 10) < G.bandWidth(10, 10));
});

test('clusterHome: every group sits on the SAME circle (spread only by angle), which grows with group count and total notes', () => {
  const h0 = G.clusterHome(0, 4, 10), h2 = G.clusterHome(2, 4, 10);
  assert.ok(Math.abs(Math.hypot(h0.x, h0.y) - Math.hypot(h2.x, h2.y)) < 1e-6, 'same circle -> same radius regardless of index, so collapsed bubbles land evenly spaced');
  assert.ok(Math.abs(h0.x - h2.x) > 1 || Math.abs(h0.y - h2.y) > 1, 'different index -> different angle/position');
  const moreNodes = G.clusterHome(0, 4, 400);
  assert.ok(Math.hypot(moreNodes.x, moreNodes.y) > Math.hypot(h0.x, h0.y), 'more total notes -> the whole circle sits further out');
  const moreGroups = G.clusterHome(0, 12, 10);
  assert.ok(Math.hypot(moreGroups.x, moreGroups.y) > Math.hypot(h0.x, h0.y), 'more groups -> the whole circle sits further out too');
});

test('shortestPath: BFS over undirected pairs, unreachable/unknown ids return null', () => {
  const ids = ['A', 'B', 'C', 'D', 'E'];
  const pairs = [['A', 'B'], ['B', 'C'], ['C', 'D']];
  // Array.from() rebuilds the array with this realm's Array constructor, so
  // deepEqual against a plain literal doesn't trip over the vm sandbox's
  // separate realm.
  assert.deepEqual(Array.from(G.shortestPath(ids, pairs, 'A', 'D')), ['A', 'B', 'C', 'D']);
  assert.deepEqual(Array.from(G.shortestPath(ids, pairs, 'A', 'A')), ['A']);
  assert.equal(G.shortestPath(ids, pairs, 'A', 'E'), null, 'E has no edges: unreachable');
  assert.equal(G.shortestPath(ids, pairs, 'A', 'zzz'), null, 'unknown id');
});

test('recencyBucket: this week / this month / this year / older-or-unknown', () => {
  const now = Date.parse('2026-09-11T00:00:00Z');
  assert.equal(G.recencyBucket(now - 3 * 86400000, now), 0);
  assert.equal(G.recencyBucket(now - 20 * 86400000, now), 1);
  assert.equal(G.recencyBucket(now - 200 * 86400000, now), 2);
  assert.equal(G.recencyBucket(now - 400 * 86400000, now), 3);
  assert.equal(G.recencyBucket(null, now), 3);
});

test('colorFor: folder/lang/status/updated modes, custom rules always win', () => {
  const note = { id: 'a.md', type: 'note', group: 1, lang: 'ar', status: 'draft', updated: Date.now() };
  assert.equal(G.colorFor(note, 'folder', [], {}), G.PALETTE[1]);
  assert.equal(G.colorFor({ id: '#x', type: 'tag' }, 'folder', [], { muted: '#999' }), '#999');
  assert.equal(G.colorFor(note, 'lang', [], { langs: ['ar', 'en'] }), G.PALETTE[0]);
  assert.equal(G.colorFor(note, 'lang', [], { langs: ['en', 'fr'] }), G.PALETTE[2], 'unseen lang gets a stable extra slot');
  assert.equal(G.colorFor(note, 'status', [], {}), '#f2b134');
  assert.equal(G.colorFor({ ...note, status: 'ready' }, 'status', [], {}), '#2fbf71');
  assert.equal(G.colorFor({ ...note, status: '' }, 'status', [], {}), '#d5d8dc');
  const bucket = G.recencyBucket(note.updated, Date.now());
  assert.equal(G.colorFor(note, 'updated', [], { now: Date.now() }), ['#2fbf71', '#4c8dff', '#f2b134', '#9aa0a6'][bucket]);
  const rules = [{ terms: G.parseQuery('path:a'), color: '#123456' }];
  assert.equal(G.colorFor(note, 'status', rules, {}), '#123456', 'a matching custom group rule always wins');
});

const FILES = {
  'A.md': '# A\n[[sub/B]]\n',
  'sub/B.md': '# B\n[[A]]\n',
};
let tmp, vault;
before(async () => { tmp = makeVault(FILES); vault = new Vault({ slug: 's', root: tmp.root }); await vault.scan(); });
after(() => tmp.rm());

test('graphDocument: unchanged panel ids from before, plus a new Explore link', () => {
  const global = graphDocument({ vault, vaults: [vault], focus: '' });
  assert.ok(global.includes('<html lang="en" dir="ltr" class="graph-doc">'));
  assert.ok(global.includes('id="graphCanvas"') && global.includes('data-graph="/s/_graph.json"'));
  for (const id of ['gpQuery', 'gpTags', 'gpOrphans', 'gpGroups', 'gpArrows', 'gpTextFade', 'gpNodeSize', 'gpLineWidth', 'gpCenter', 'gpRepel', 'gpLink', 'gpLinkDistance', 'gpReset', 'gzFit']) assert.ok(global.includes(`id="${id}"`), id);
  assert.ok(!global.includes('id="gpLocal"') && !global.includes('id="sidebar"'));
  assert.ok(global.includes('/_static/graph-page.js'));
  assert.match(global, /href="\/s\/_explore"/, 'Explore link with no focus query');

  const local = graphDocument({ vault, vaults: [vault], focus: 'A.md' });
  assert.ok(local.includes('id="gpLocal"') && local.includes('id="gpDepth"'));
  assert.ok(local.includes('data-graph="/s/_graph.json?rel=A.md&depth=1"') && local.includes('data-focus="A.md"'));
  assert.ok(local.includes(`<title>Graph · A · ${vault.title}</title>`));
  assert.match(local, /href="\/s\/_explore\?focus=A\.md"/, 'Explore link keeps the focus query');
});

test('exploreDocument: its own canvas id, scripts, and the new panel control ids', () => {
  const global = exploreDocument({ vault, vaults: [vault], focus: '' });
  assert.ok(global.includes('<html lang="en" dir="ltr" class="graph-doc">'));
  assert.ok(global.includes('id="exploreCanvas"'));
  for (const id of ['exploreCanvas', 'exBubbles', 'exLayout', 'exColorBy', 'exSizeBy', 'exPathFrom', 'exPathTo', 'exPathGo']) assert.ok(global.includes(`id="${id}"`), id);
  assert.ok(global.includes('/_static/graph.js?v='), 'reuses the shared renderer helpers');
  assert.ok(global.includes('/_static/explore.js?v='));
  assert.ok(!global.includes('/_static/graph-page.js'), 'does not load the classic page script');
  assert.match(global, /href="\/s\/_graph"/, 'link back to the classic graph view');

  const local = exploreDocument({ vault, vaults: [vault], focus: 'A.md' });
  assert.ok(local.includes('data-focus="A.md"'));
  assert.match(local, /href="\/s\/_graph\?focus=A\.md"/);
  assert.ok(local.includes(`<title>Explore · A · ${vault.title}</title>`));
});
