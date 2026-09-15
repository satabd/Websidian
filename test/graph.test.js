'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeVault } = require('./helpers');
const { Vault } = require('../src/vault');
const { buildGraph } = require('../src/graph');
const { page, graphDocument } = require('../src/layout');

const FILES = {
  'A.md': '---\ntags: [hms, demo]\n---\n# A\n[[B]] [[B]] [[sub/C]] [[Missing]] ![[pic.png]]\n',
  'sub/B.md': '---\ntags: [hms]\n---\n# B\n[[A]] [[C]]\n',
  'sub/C.md': '# C\n[[D]]\n',
  'sub/D.md': '# D\n',
  'Lonely.md': '# Lonely\nno links\n',
  'sub/Draft.md': '---\nstatus: draft\n---\n[[A]]\n',
  'pic.png': 'x',
};

let tmp, vault;
before(async () => { tmp = makeVault(FILES); vault = new Vault({ slug: 's', root: tmp.root, excludeStatus: ['draft'] }); await vault.scan(); });
after(() => tmp.rm());

test('global graph: nodes for visible notes, directed deduplicated edges, folder groups, tags on nodes', () => {
  const g = buildGraph(vault);
  assert.deepEqual(g.nodes.map(n => n.id), ['A.md', 'Lonely.md', 'sub/B.md', 'sub/C.md', 'sub/D.md']);
  const keys = g.edges.map(e => e.source + '>' + e.target).sort();
  assert.deepEqual(keys, ['A.md>sub/B.md', 'A.md>sub/C.md', 'sub/B.md>A.md', 'sub/B.md>sub/C.md', 'sub/C.md>sub/D.md']);
  assert.equal(g.nodes.find(n => n.id === 'A.md').links, 2, 'undirected degree');
  assert.deepEqual(g.nodes.find(n => n.id === 'A.md').tags, ['hms', 'demo']);
  assert.equal(g.nodes.find(n => n.id === 'Lonely.md').links, 0);
  assert.deepEqual(g.groups.map(x => x.title), [vault.title, 'Sub']);
  assert.equal(g.nodes.find(n => n.id === 'sub/B.md').url, '/s/sub/B');
  assert.ok(!g.nodes.some(n => n.id === 'sub/Draft.md'), 'hidden notes excluded, and their links too');
});

test('local graph: depth-limited neighbourhood', () => {
  const d1 = buildGraph(vault, { rel: 'A.md', depth: 1 });
  assert.deepEqual(d1.nodes.map(n => n.id).sort(), ['A.md', 'sub/B.md', 'sub/C.md']);
  assert.equal(d1.edges.length, 4);
  assert.equal(d1.center, 'A.md');
  const d2 = buildGraph(vault, { rel: 'A.md', depth: 2 });
  assert.deepEqual(d2.nodes.map(n => n.id).sort(), ['A.md', 'sub/B.md', 'sub/C.md', 'sub/D.md']);
  assert.deepEqual(buildGraph(vault, { rel: 'Lonely.md' }).nodes.map(n => n.id), ['Lonely.md']);
  assert.deepEqual(buildGraph(vault, { rel: 'nope.md' }).nodes, []);
});

test('tag nodes are optional', () => {
  const g = buildGraph(vault, { tags: true });
  const tags = g.nodes.filter(n => n.type === 'tag');
  assert.deepEqual(tags.map(t => t.id), ['#demo', '#hms']);
  assert.equal(tags.find(t => t.id === '#hms').links, 2);
  assert.ok(g.edges.some(e => e.source === 'A.md' && e.target === '#demo'));
  assert.equal(g.groups[g.groups.length - 1].title, 'Tags');
  assert.equal(buildGraph(vault).nodes.filter(n => n.type === 'tag').length, 0);
});

test('layout: graph button, local graph panel only for linked notes', () => {
  const linked = page({ vault, vaults: [vault], rel: 'A.md', title: 'A', body: '<p>x</p>', data: {} });
  assert.ok(linked.includes('class="graph-btn" href="/s/_graph?focus=A.md"'));
  assert.match(linked, /<canvas class="local-graph-canvas" data-graph="\/s\/_graph\.json\?rel=A\.md&depth=1" data-center="A\.md"/);
  assert.ok(linked.includes('/_static/graph.js?v='));
  const lonely = page({ vault, vaults: [vault], rel: 'Lonely.md', title: 'L', body: '<p>x</p>', data: {} });
  assert.ok(!lonely.includes('local-graph-canvas'));
  const embed = page({ vault, vaults: [vault], rel: 'A.md', title: 'A', body: '<p>x</p>', data: {}, embed: true });
  assert.ok(!embed.includes('graph-btn') && !embed.includes('graph.js'));
});

test('full-screen graph document: panel sections, local controls only with focus', () => {
  const global = graphDocument({ vault, vaults: [vault], focus: '' });
  assert.ok(global.includes('<html lang="en" dir="ltr" class="graph-doc">'));
  assert.ok(global.includes('id="graphCanvas"') && global.includes('data-graph="/s/_graph.json"'));
  for (const id of ['gpQuery', 'gpTags', 'gpOrphans', 'gpGroups', 'gpArrows', 'gpTextFade', 'gpNodeSize', 'gpLineWidth', 'gpCenter', 'gpRepel', 'gpLink', 'gpLinkDistance', 'gpReset', 'gzFit']) assert.ok(global.includes(`id="${id}"`), id);
  assert.ok(!global.includes('id="gpLocal"') && !global.includes('id="sidebar"'));
  assert.ok(global.includes('/_static/graph-page.js'));
  const local = graphDocument({ vault, vaults: [vault], focus: 'A.md' });
  assert.ok(local.includes('id="gpLocal"') && local.includes('id="gpDepth"'));
  assert.ok(local.includes('data-graph="/s/_graph.json?rel=A.md&depth=1"') && local.includes('data-focus="A.md"'));
  assert.ok(local.includes(`<title>Graph · A · ${vault.title}</title>`));
});

test('client query language (parseQuery / matches) from public/graph.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'graph.js'), 'utf8');
  const sandbox = { window: {}, document: { documentElement: {} }, getComputedStyle: () => ({ getPropertyValue: () => '' }) };
  vm.runInNewContext(src, sandbox);
  const { parseQuery, matches } = sandbox.window.MD2HTML_GRAPH;
  const n = { id: 'docs/sub/Note One.md', title: 'Note One', folder: 'docs/sub', tags: ['hms', 'demo/x'], type: 'note' };
  assert.equal(matches(parseQuery('note'), n), true);
  assert.equal(matches(parseQuery('"note one"'), n), true);
  assert.equal(matches(parseQuery('path:docs/sub'), n), true);
  assert.equal(matches(parseQuery('path:other'), n), false);
  assert.equal(matches(parseQuery('tag:#hms'), n), true);
  assert.equal(matches(parseQuery('tag:demo'), n), true, 'nested tag prefix');
  assert.equal(matches(parseQuery('tag:nope'), n), false);
  assert.equal(matches(parseQuery('-tag:hms'), n), false);
  assert.equal(matches(parseQuery('note -path:other'), n), true);
  assert.equal(matches(parseQuery(''), n), true);
  assert.equal(matches(parseQuery('tag:hms'), { id: '#hms', title: '#hms', type: 'tag', tags: [] }), true, 'tag nodes match their own tag');
});

// ---- in/out, status, updated, dist, clusters -------------------------------
// Its own small vault: two notes in the root folder linking both ways (so the
// root group has an internal edge), plus a two-level folder chain so a link
// crosses between three different groups.
const CLUSTER_FILES = {
  'Root.md': '---\nstatus: ready\n---\n# Root\n[[sub/Leaf]] [[Other]]\n',
  'Other.md': '# Other\n[[Root]]\n',
  'sub/Leaf.md': '# Leaf\n[[Root]]\n',
  'sub2/Far.md': '# Far\n[[sub/Leaf]]\n',
};

let ctmp, cvault;
before(async () => { ctmp = makeVault(CLUSTER_FILES); cvault = new Vault({ slug: 'c', root: ctmp.root }); await cvault.scan(); });
after(() => ctmp.rm());

test('every node gets in/out (distinct neighbours), status and updated', () => {
  const g = buildGraph(cvault);
  const root = g.nodes.find(n => n.id === 'Root.md');
  const other = g.nodes.find(n => n.id === 'Other.md');
  const leaf = g.nodes.find(n => n.id === 'sub/Leaf.md');
  const far = g.nodes.find(n => n.id === 'sub2/Far.md');

  assert.equal(root.in, 2); assert.equal(root.out, 2); assert.equal(root.links, 2);
  assert.equal(other.in, 1); assert.equal(other.out, 1);
  assert.equal(leaf.in, 2); assert.equal(leaf.out, 1);
  assert.equal(far.in, 0); assert.equal(far.out, 1);

  assert.equal(root.status, 'ready');
  assert.equal(other.status, null, 'no status frontmatter -> null');

  assert.equal(typeof root.updated, 'number');
  assert.equal(root.updated, cvault.note('Root.md').mtimeMs);

  assert.equal(root.dist, null, 'no dist without a local rel query');
});

test('dist: BFS distance from rel, present only for a local graph', () => {
  const g = buildGraph(cvault, { rel: 'Root.md', depth: 2 });
  assert.equal(g.nodes.find(n => n.id === 'Root.md').dist, 0);
  assert.equal(g.nodes.find(n => n.id === 'Other.md').dist, 1);
  assert.equal(g.nodes.find(n => n.id === 'sub/Leaf.md').dist, 1);
  assert.equal(g.nodes.find(n => n.id === 'sub2/Far.md').dist, 2, 'reached through sub/Leaf at depth 2');
});

test('clusters and clusterLinks summarise the folder groups', () => {
  const g = buildGraph(cvault);
  const rootGroup = g.nodes.find(n => n.id === 'Root.md').group;
  const subGroup = g.nodes.find(n => n.id === 'sub/Leaf.md').group;
  const sub2Group = g.nodes.find(n => n.id === 'sub2/Far.md').group;
  assert.equal(g.clusters.length, g.groups.length);

  const rootCluster = g.clusters.find(c => c.id === rootGroup);
  assert.equal(rootCluster.count, 2, 'Root.md + Other.md');
  assert.equal(rootCluster.internal, 2, 'Root>Other and Other>Root');

  const subCluster = g.clusters.find(c => c.id === subGroup);
  assert.equal(subCluster.count, 1); assert.equal(subCluster.internal, 0);

  const rootSub = g.clusterLinks.find(l => (l.a === rootGroup && l.b === subGroup) || (l.a === subGroup && l.b === rootGroup));
  assert.ok(rootSub, 'root<->sub crossing recorded');
  assert.equal(rootSub.count, 2, 'Root>Leaf and Leaf>Root, both directions summed');
  assert.ok(rootSub.a < rootSub.b, 'a < b');

  const subSub2 = g.clusterLinks.find(l => (l.a === subGroup && l.b === sub2Group) || (l.a === sub2Group && l.b === subGroup));
  assert.ok(subSub2, 'sub<->sub2 crossing recorded');
  assert.equal(subSub2.count, 1);
});

test('clusters include the tag group when tags=true', () => {
  const g = buildGraph(vault, { tags: true });
  const tagGroupId = g.groups[g.groups.length - 1].id;
  const tagCluster = g.clusters.find(c => c.id === tagGroupId);
  assert.ok(tagCluster, 'tag group has a cluster entry');
  assert.equal(tagCluster.count, 2, '#hms and #demo');
});
