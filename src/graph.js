'use strict';
// Graph data for the Obsidian-style graph view. Built from the vault index
// (backlinks are already resolved there), so it costs nothing per request
// beyond serialisation. Two shapes:
//   global:  every visible note (+ optional tag nodes) and every link
//   local:   the notes within `depth` hops of one note
// Edges are directed (source links to target), one per direction.
const { folderTitle, collator } = require('./vault');

function topFolder(rel) { const i = rel.indexOf('/'); return i < 0 ? '' : rel.slice(0, i); }
const listOf = v => Array.isArray(v) ? v : (v == null ? [] : [v]);
const tagsOf = data => listOf(data.tags).map(t => String(t).replace(/^#/, '')).filter(Boolean);

// Named views, declared in frontmatter. Two shapes, both under `views:`:
//   - an object defines a view:  { id, label, note, focus: [note names] }
//     (`focus` entries are wikilink targets, resolved from the declaring note)
//   - a string joins the note to a view of that id (created if never defined)
// Members are the definition's focus list in order, then joined notes by
// title. Hidden notes never appear, and a view with no visible member is
// dropped. Returned sorted by label.
function collectViews(vault, visible) {
  const byRel = new Map(visible.map(n => [n.rel, n]));
  const views = new Map();
  const viewOf = (id, from) => {
    if (!views.has(id)) views.set(id, { id, label: id, note: '', focus: [], joined: [], from });
    return views.get(id);
  };
  const slug = v => String(v).trim().toLowerCase().replace(/[^a-z0-9\u0600-\u06ff_-]+/g, '-').replace(/^-+|-+$/g, '');
  for (const n of visible) {
    for (const item of listOf(n.data.views)) {
      if (item == null) continue;
      if (typeof item !== 'object') { const id = slug(item); if (id) viewOf(id, n.rel).joined.push(n.rel); continue; }
      const id = slug(item.id != null ? item.id : (item.label != null ? item.label : ''));
      if (!id) continue;
      const v = viewOf(id, n.rel); v.from = n.rel;
      if (item.label != null) v.label = String(item.label);
      if (item.note != null) v.note = String(item.note);
      for (const target of listOf(item.focus)) {
        const name = String(target).replace(/^\[\[|\]\]$/g, '').split('|')[0].split('#')[0].trim();
        const rel = name ? vault.resolveNote(name, n.rel) : null;
        if (rel && byRel.has(rel) && !v.focus.includes(rel)) v.focus.push(rel);
      }
    }
  }
  const out = [];
  for (const v of views.values()) {
    const joined = v.joined.filter(r => !v.focus.includes(r)).sort((a, b) => collator.compare(byRel.get(a).title, byRel.get(b).title));
    const members = v.focus.concat(joined);
    if (!members.length) continue;
    out.push({ id: v.id, label: v.label, note: v.note, from: v.from, members });
  }
  return out.sort((a, b) => collator.compare(a.label, b.label));
}

// The visible-note list and the named views, memoised per scan of the vault (vault.indexGen). Both are
// needed twice per graph request - once for the ETag, once to build the answer - and each rebuild sorts
// the whole index and re-reads every note's frontmatter. Without this, a conditional GET that ends in a
// cheap 304 still paid for a full rescan.
function viewsOf(vault) {
  const gen = vault.indexGen || 0;
  const cached = vault._viewsCache;
  if (cached && cached.gen === gen) return cached;
  const visible = vault.visibleNotesSorted();
  const views = collectViews(vault, visible);
  const hash = require('crypto').createHash('sha1').update(JSON.stringify(views)).digest('hex').slice(0, 12);
  const entry = { gen, visible, views, hash };
  vault._viewsCache = entry;
  return entry;
}

function buildGraph(vault, { rel = null, depth = 1, tags = false } = {}) {
  const { visible, views } = viewsOf(vault);
  const byRel = new Map(visible.map(n => [n.rel, n]));

  // Directed edges from the resolved backlinks map (target -> sources), plus
  // an undirected adjacency for degrees/neighbourhood search and directed
  // in/out adjacency (distinct-neighbour counts, not multi-edge counts).
  const adj = new Map(); const inAdj = new Map(); const outAdj = new Map();
  const seen = new Set(); const edges = [];
  const addEdge = (from, to) => {
    if (from === to || !byRel.has(from) || !byRel.has(to)) return;
    const key = from + '\n' + to; if (seen.has(key)) return; seen.add(key);
    edges.push({ source: from, target: to });
    if (!adj.has(from)) adj.set(from, new Set()); if (!adj.has(to)) adj.set(to, new Set());
    adj.get(from).add(to); adj.get(to).add(from);
    if (!outAdj.has(from)) outAdj.set(from, new Set()); outAdj.get(from).add(to);
    if (!inAdj.has(to)) inAdj.set(to, new Set()); inAdj.get(to).add(from);
  };
  for (const [target, sources] of vault.backlinks) for (const s of sources) addEdge(s, target);

  // Local graph: breadth-first out to `depth`, tracking hop distance from
  // `rel` so nodes can carry it (used for e.g. fading far-away nodes).
  let keep = null; const distOf = new Map();
  if (rel) {
    if (!byRel.has(rel)) return { nodes: [], edges: [], groups: [], clusters: [], clusterLinks: [], views, center: rel };
    keep = new Set([rel]); distOf.set(rel, 0); let frontier = [rel];
    for (let d = 0; d < Math.max(0, Math.min(depth, 6)); d++) {
      const next = [];
      for (const r of frontier) for (const n of adj.get(r) || []) if (!keep.has(n)) { keep.add(n); distOf.set(n, d + 1); next.push(n); }
      frontier = next;
    }
  }

  const groupIds = new Map(); const groups = [];
  const groupOf = folder => {
    const key = topFolder(folder ? folder + '/' : '');
    if (!groupIds.has(key)) { groupIds.set(key, groups.length); groups.push({ id: groups.length, key, title: key ? folderTitle(key, vault.folderNames) : vault.title }); }
    return groupIds.get(key);
  };

  const nodes = [];
  for (const n of visible) {
    if (keep && !keep.has(n.rel)) continue;
    nodes.push({
      id: n.rel, title: n.title, url: vault.noteUrl(n.rel), folder: n.folder, group: groupOf(n.folder),
      lang: n.data.lang || null, tags: tagsOf(n.data),
      links: (adj.get(n.rel) || new Set()).size,
      in: (inAdj.get(n.rel) || new Set()).size, out: (outAdj.get(n.rel) || new Set()).size,
      status: n.data.status != null ? String(n.data.status) : null,
      updated: n.mtimeMs, dist: keep ? distOf.get(n.rel) : null,
      type: 'note',
    });
  }
  const outEdges = keep ? edges.filter(e => keep.has(e.source) && keep.has(e.target)) : edges.slice();

  if (tags) {
    const tagGroup = groups.length; groups.push({ id: tagGroup, key: '#', title: 'Tags' });
    const tagNodes = new Map();
    for (const node of nodes) {
      for (const t of node.tags) {
        const id = '#' + t;
        if (!tagNodes.has(id)) tagNodes.set(id, { id, title: id, url: null, folder: '', group: tagGroup, lang: null, tags: [], links: 0, in: 0, out: 0, status: null, updated: null, dist: null, type: 'tag' });
        const tagNode = tagNodes.get(id);
        tagNode.links++; node.links++;
        tagNode.in++; node.out++;
        outEdges.push({ source: node.id, target: id });
      }
    }
    nodes.push(...[...tagNodes.values()].sort((a, b) => collator.compare(a.id, b.id)));
  }

  // Per-group rollups for the client's cluster view: how many nodes each
  // folder/tag group holds in this result, how many edges stay inside it,
  // and how many cross to each other group (both directions summed).
  const groupOfId = new Map(nodes.map(n => [n.id, n.group]));
  const clusters = groups.map(g => ({ id: g.id, count: 0, internal: 0 }));
  for (const n of nodes) clusters[n.group].count++;
  const crossing = new Map();
  for (const e of outEdges) {
    const ga = groupOfId.get(e.source), gb = groupOfId.get(e.target);
    if (ga === undefined || gb === undefined) continue;
    if (ga === gb) clusters[ga].internal++;
    else {
      const a = Math.min(ga, gb), b = Math.max(ga, gb), key = a + '\n' + b;
      crossing.set(key, (crossing.get(key) || 0) + 1);
    }
  }
  const clusterLinks = [...crossing.entries()]
    .map(([key, count]) => { const [a, b] = key.split('\n').map(Number); return { a, b, count }; })
    .sort((x, y) => x.a - y.a || x.b - y.b);

  return { nodes, edges: outEdges, groups, clusters, clusterLinks, views, center: rel || null };
}

// A short hash of the declared views, for the graph JSON's ETag: the list and
// link hashes do not see a frontmatter edit that only changes `views:`.
function viewsHash(vault) { return viewsOf(vault).hash; }

module.exports = { buildGraph, collectViews, viewsOf, viewsHash, topFolder };
