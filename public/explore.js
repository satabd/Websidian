/* Explore view: a second, separate full-screen graph page. Built on top of
 * the pure helpers exported by public/graph.js (window.WEBSIDIAN_GRAPH) —
 * parseQuery/matches/colorFor/bubbleRadius/bandWidth/clusterHome/
 * radialPositions/shortestPath/reach — but with its own self-contained
 * renderer, so the existing graph.js mount()/graph-page.js pair is never
 * touched.
 *
 * Adds: section bubbles (semantic zoom), cluster/radial/force layouts,
 * colour-by (folder/lang/status/recency) and size-by (links/in/out/equal),
 * a shortest-path finder between two notes, directed reach (upstream /
 * downstream of one note) and named views declared in frontmatter.
 * Settings persist per site in localStorage under 'md2html-explore-<site>';
 * the active view or reach lives in the URL (?view= / ?reach=&dir=&hops=)
 * so it can be shared, and is never persisted.
 */
(function () {
  'use strict';
  // Keep the chrome mode (?embed=1 / ?shell=1, and in shell mode the host's theme and chrome) when a
  // click on the canvas opens a note; the server writes it onto rendered links, but these URLs come from
  // the graph JSON.
  function withMode(u) {
    var W = window.WEBSIDIAN || window.MD2HTML;
    var m = W && W.embed ? 'embed' : W && W.shell ? 'shell' : '';
    if (!m || !u || u.indexOf(m + '=') >= 0) return u;
    var t = m === 'shell' ? (/[?&]theme=(dark|light)\b/.exec(location.search) || ['', ''])[1] : '';
    var c = m === 'shell' ? (/[?&]chrome=(tree|none)\b/.exec(location.search) || ['', ''])[1] : '';
    var i = u.indexOf('#'); var hash = i >= 0 ? u.slice(i) : ''; var p = i >= 0 ? u.slice(0, i) : u;
    return p + (p.indexOf('?') >= 0 ? '&' : '?') + m + '=1' + (t ? '&theme=' + t : '') + (c ? '&chrome=' + c : '') + hash;
  }
  var G = window.WEBSIDIAN_GRAPH || window.MD2HTML_GRAPH; if (!G) return;
  var canvas = document.getElementById('exploreCanvas'); if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var site = canvas.getAttribute('data-site'), focusAttr = canvas.getAttribute('data-focus') || '';
  var KEY = 'md2html-explore-' + site;
  var $ = function (id) { return document.getElementById(id); };

  var DEFAULTS = { query: '', tags: false, orphans: true, depth: 1, textFade: 1.0, nodeSize: 1.0, lineWidth: 1.0, animate: true, colorBy: 'folder', sizeBy: 'links', layout: 'cluster', bubbles: true, collapsed: [], reachDir: 'up', reachHops: 0 };
  var saved = {}; try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
  var S = Object.assign({}, DEFAULTS, saved);
  var hadSavedLayout = Object.prototype.hasOwnProperty.call(saved, 'layout');
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }

  var cssVars = getComputedStyle(document.documentElement);
  var theme = function () { cssVars = getComputedStyle(document.documentElement); return { fg: cssVars.getPropertyValue('--fg').trim() || '#222', muted: cssVars.getPropertyValue('--muted').trim() || '#888', line: cssVars.getPropertyValue('--line').trim() || '#ccc', bg: cssVars.getPropertyValue('--bg').trim() || '#fff', accent: cssVars.getPropertyValue('--accent').trim() || '#0969da', font: cssVars.getPropertyValue('--font') || 'sans-serif' }; };
  var UP = '#4c8dff', DOWN = '#2fbf71'; // reach colours: upstream (links here) / downstream (linked from here)

  var baseUrl = (window.WEBSIDIAN || window.MD2HTML).base + '_graph.json';
  var centerId = focusAttr || null;
  // a focused note is a natural entry point for the radial layout, but only
  // default to it the first time — once the visitor picks a layout, respect it
  if (!hadSavedLayout && centerId) S.layout = 'radial';
  function urlFor() {
    var q = [];
    if (centerId) { q.push('rel=' + encodeURIComponent(centerId)); q.push('depth=' + S.depth); }
    if (S.tags) q.push('tags=1');
    return baseUrl + (q.length ? '?' + q.join('&') : '');
  }

  var nodes = [], pairs = [], dirEdges = [], groups = [], views = [], byId = {}, groupInfo = {}, langList = [];
  var clusterLinksRaw = [], fallbackLinksCache = null, homesCache = null, bubbleNodes = {};
  var W = 0, H = 0, dpr = Math.max(1, window.devicePixelRatio || 1);
  var view = { x: 0, y: 0, k: 1 };
  var hover = null, drag = null, alpha = 1, running = false, pinned = null;
  var qTerms = G.parseQuery(S.query);
  var visCache = null;
  // The one active highlight, or null:
  //   { kind: 'path'|'reach'|'view', ids: {id: true}, edges: {a|b: 'path'|'up'|'down'|'view'},
  //     arrows: {from|to: true}, order: [ids], root, view, dir, hops, title, note }
  var hl = null;
  var pendingFit = null; // ids to frame once the simulation settles (a view opened from the URL)
  var laidOut = false; // the canvas has had a real size (a tab opened in the background starts at 0×0)

  var statsEl = $('exploreStats'), hoverEl = $('exploreHover'), legendEl = $('exLegend'), noteListEl = $('exNoteList'), pathResultEl = $('exPathResult');
  var reachResultEl = $('exReachResult'), viewsEl = $('exViews');
  var captionEl = $('exCaption'), captionTitleEl = $('exCaptionTitle'), captionNoteEl = $('exCaptionNote'), captionListEl = $('exCaptionList');

  function resize() {
    var r = canvas.getBoundingClientRect(); W = Math.max(1, r.width); H = Math.max(1, r.height);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // the first real size: frame the graph now (a fit against a 0×0 canvas
    // zooms out to nothing), and a view waiting to be framed, too
    if (!laidOut && r.width > 1 && r.height > 1) { laidOut = true; if (nodes.length) { if (pendingFit && !running) { fitTo(pendingFit); pendingFit = null; } else fit(); } }
    draw();
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function edgeKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

  function load(data) {
    groups = data.groups || []; clusterLinksRaw = data.clusterLinks || []; views = data.views || [];
    var clustersRaw = data.clusters || [];
    var prev = byId; byId = {};
    var count = (data.nodes || []).length || 1, R0 = Math.sqrt(count) * 30 + 40;
    nodes = (data.nodes || []).map(function (n, i) {
      var old = prev[n.id];
      var a = i * 2.399963, rr = R0 * Math.sqrt((i + 1) / count); // sunflower seeding: even spread
      var node = { id: n.id, title: n.title, url: n.url, group: n.group, type: n.type, links: n.links || 0, in: n.in || 0, out: n.out || 0, lang: n.lang, folder: n.folder, tags: n.tags || [], status: n.status, updated: n.updated || null,
        x: old ? old.x : Math.cos(a) * rr, y: old ? old.y : Math.sin(a) * rr, vx: 0, vy: 0, fixed: old ? old.fixed : false };
      if (centerId && n.id === centerId) node.center = true;
      byId[n.id] = node; return node;
    });
    var pm = {}; pairs = []; dirEdges = [];
    (data.edges || []).forEach(function (e) {
      var s = byId[e.source], t = byId[e.target]; if (!s || !t) return;
      dirEdges.push([s.id, t.id]);
      var key = s.id < t.id ? s.id + '\n' + t.id : t.id + '\n' + s.id;
      var p = pm[key]; if (!p) { p = pm[key] = { a: s.id < t.id ? s : t, b: s.id < t.id ? t : s }; pairs.push(p); }
    });
    nodes.forEach(function (n) { n.deg = 0; }); pairs.forEach(function (p) { p.a.deg++; p.b.deg++; });
    groupInfo = {};
    groups.forEach(function (g) { groupInfo[g.id] = { id: g.id, key: g.key, title: g.title, count: 0, memberIds: [] }; });
    nodes.forEach(function (n) {
      var gi = groupInfo[n.group];
      if (!gi) gi = groupInfo[n.group] = { id: n.group, key: '', title: 'Group ' + n.group, count: 0, memberIds: [] };
      gi.count++; gi.memberIds.push(n.id);
    });
    clustersRaw.forEach(function (c) { if (groupInfo[c.id]) groupInfo[c.id].count = c.count; });
    var langSet = {}; nodes.forEach(function (n) { if (n.lang) langSet[n.lang] = true; }); langList = Object.keys(langSet).sort();
    fallbackLinksCache = null; homesCache = null; bubbleNodes = {};
    visCache = null; alpha = 1;
    if ((!prev || !Object.keys(prev).length) && laidOut) fit();
    start();
    updateNoteList();
    renderViews();
    reapplyHighlight();
    var visN = visibleNodes();
    if (statsEl) statsEl.textContent = visN.length + (visN.length !== nodes.length ? ' of ' + nodes.length : '') + ' notes · ' + pairs.length + ' links';
    renderLegend();
  }

  function isVisible(n) {
    if (n.type === 'tag' && !S.tags) return false;
    if (!S.orphans && n.deg === 0 && n.type !== 'tag') return false;
    if (qTerms.length && !G.matches(qTerms, n)) return false;
    return true;
  }
  function visibleNodes() { if (!visCache) { visCache = nodes.filter(isVisible); visCache.forEach(function (n) { n.vis = true; }); nodes.forEach(function (n) { if (visCache.indexOf(n) < 0) n.vis = false; }); } return visCache; }
  function colorOf(n) { return G.colorFor(n, S.colorBy, [], { langs: langList, muted: theme().muted, now: Date.now() }); }
  function sizeMetric(n) { return S.sizeBy === 'in' ? n.in : S.sizeBy === 'out' ? n.out : n.links; }
  function nodeRadius(n) {
    if (n.type === 'tag') return 2.6;
    if (S.sizeBy === 'equal') return 6.5;
    return Math.min(13, 2.6 + Math.sqrt(Math.max(0, sizeMetric(n))) * 1.35);
  }

  // ---- section bubbles: collapsed groups drawn as one pseudo-node -------
  function isCollapsed(gid) { return (S.collapsed || []).indexOf(gid) >= 0; }
  function activeBubbleGroups() {
    var active = {};
    if (!S.bubbles) return active;
    Object.keys(groupInfo).forEach(function (key) { var gid = Number(key); if (isCollapsed(gid) || view.k < 0.55) active[gid] = true; });
    return active;
  }
  function bubbleFor(gid) {
    var info = groupInfo[gid] || { id: gid, title: 'Group ' + gid, count: 0, memberIds: [] };
    var b = bubbleNodes[gid];
    if (!b) {
      var mx = 0, my = 0, c = 0;
      (info.memberIds || []).forEach(function (id) { var nd = byId[id]; if (nd) { mx += nd.x; my += nd.y; c++; } });
      b = bubbleNodes[gid] = { id: 'bubble:' + gid, isBubble: true, group: gid, x: c ? mx / c : 0, y: c ? my / c : 0, vx: 0, vy: 0, fixed: false, vis: true, deg: 0 };
    }
    b.count = info.count; b.title = info.title + ' (' + info.count + ')';
    b.r0 = G.bubbleRadius(b.count, view.k); // drawn (screen) radius: zoom-aware, for rendering/hit-testing
    b.rw = G.bubbleRadius(b.count, 1) + 14; // world-space radius: zoom-independent, for collision/physics
    return b;
  }
  function computeSim() {
    var active = activeBubbleGroups();
    var visN = visibleNodes();
    var simN = [], bubbles = [];
    visN.forEach(function (n) { if (!active[n.group]) simN.push(n); });
    Object.keys(active).forEach(function (gid) { bubbles.push(bubbleFor(Number(gid))); });
    return { nodes: simN, bubbles: bubbles, all: simN.concat(bubbles), active: active };
  }
  function fallbackClusterLinks() {
    if (fallbackLinksCache) return fallbackLinksCache;
    var map = {};
    pairs.forEach(function (p) {
      if (p.a.group === p.b.group) return;
      var a = Math.min(p.a.group, p.b.group), b = Math.max(p.a.group, p.b.group), key = a + ':' + b;
      map[key] = map[key] || { a: a, b: b, count: 0 }; map[key].count++;
    });
    fallbackLinksCache = Object.keys(map).map(function (k) { return map[k]; });
    return fallbackLinksCache;
  }
  function clusterLinksFor(active) {
    var src = clusterLinksRaw && clusterLinksRaw.length ? clusterLinksRaw : fallbackClusterLinks();
    return src.filter(function (l) { return active[l.a] && active[l.b]; });
  }
  function clusterHomes() {
    if (homesCache) return homesCache;
    var gids = Object.keys(groupInfo).map(Number);
    // every group sits on the same circle (spread only by angle) so
    // sections - and collapsed section bubbles - land evenly spaced
    // instead of bunching up near the centre
    var totalNodes = nodes.length;
    var homes = {};
    gids.forEach(function (gid, i) { homes[gid] = G.clusterHome(i, gids.length, totalNodes); });
    homesCache = homes; return homes;
  }
  function radialTargetsNow(simNodesList) {
    var ids = simNodesList.map(function (n) { return n.id; });
    var idIdx = {}; ids.forEach(function (id) { idIdx[id] = true; });
    var edgePairs = [];
    pairs.forEach(function (p) { if (p.a.vis && p.b.vis && idIdx[p.a.id] && idIdx[p.b.id]) edgePairs.push([p.a.id, p.b.id]); });
    return G.radialPositions(ids, edgePairs, centerId, 110);
  }
  function expandBubble(b) {
    var gid = b.group, list = (S.collapsed || []).slice(), idx = list.indexOf(gid);
    if (idx >= 0) list.splice(idx, 1);
    S.collapsed = list; save();
    view.x = -b.x; view.y = -b.y; view.k = Math.min(2.5, Math.max(view.k * 1.25, 0.7));
    visCache = null; reheat(0.5); draw();
  }

  // ---- simulation: same grid-bucketed repulsion/springs/gravity approach
  // as the main graph renderer, plus cluster-home and radial-target springs
  function tick() {
    var sim = computeSim(); var all = sim.all, n = all.length; if (!n) return;
    var byGidBubble = {}; sim.bubbles.forEach(function (b) { byGidBubble[b.group] = b; });
    var i, j, a, b, dx, dy, d2, d, f;
    var radialActive = S.layout === 'radial' && centerId && byId[centerId] && byId[centerId].vis;
    var repel = 2600 * (radialActive ? 0.18 : 1);
    var linkLen = 55 + Math.sqrt(n) * 2.2;
    var spring = 0.018;
    var gravity = 0.0035 + 0.02 / Math.sqrt(n);
    var cell = Math.max(60, linkLen * 1.2), grid = {}, key, range = cell * cell * 4;
    for (i = 0; i < n; i++) { a = all[i]; key = Math.floor(a.x / cell) + ',' + Math.floor(a.y / cell); (grid[key] = grid[key] || []).push(a); }
    for (i = 0; i < n; i++) {
      a = all[i]; var gx = Math.floor(a.x / cell), gy = Math.floor(a.y / cell);
      for (var ox = -1; ox <= 1; ox++) for (var oy = -1; oy <= 1; oy++) {
        var bucket = grid[(gx + ox) + ',' + (gy + oy)]; if (!bucket) continue;
        for (j = 0; j < bucket.length; j++) {
          b = bucket[j]; if (b === a) continue;
          dx = a.x - b.x; dy = a.y - b.y; d2 = dx * dx + dy * dy + 0.05; if (d2 > range) continue;
          f = repel / d2 * alpha * (b.isBubble ? Math.max(1.4, b.r0 / 16) : 1);
          d = Math.sqrt(d2); a.vx += dx / d * f; a.vy += dy / d * f;
        }
      }
    }
    var isCluster = S.layout === 'cluster';
    if (!radialActive) {
      for (i = 0; i < pairs.length; i++) {
        var p = pairs[i]; if (!p.a.vis || !p.b.vis) continue;
        var ea = sim.active[p.a.group] ? byGidBubble[p.a.group] : p.a;
        var eb = sim.active[p.b.group] ? byGidBubble[p.b.group] : p.b;
        if (!ea || !eb || ea === eb) continue;
        // in the cluster layout, cross-section bridges are kept weak so they
        // read as bridges instead of dragging whole sections together
        var crossFactor = (isCluster && p.a.group !== p.b.group) ? 0.35 : 1;
        dx = eb.x - ea.x; dy = eb.y - ea.y; d = Math.sqrt(dx * dx + dy * dy) + 0.01;
        var want = linkLen * (1 + Math.min(1.5, (Math.sqrt(p.a.deg || 1) + Math.sqrt(p.b.deg || 1)) * 0.08));
        f = (d - want) * spring * crossFactor * alpha; dx = dx / d * f; dy = dy / d * f;
        ea.vx += dx; ea.vy += dy; eb.vx -= dx; eb.vy -= dy;
      }
    }
    var homes = isCluster ? clusterHomes() : null;
    var targets = radialActive ? radialTargetsNow(sim.nodes) : null;
    for (i = 0; i < n; i++) {
      a = all[i];
      if (a.center) { a.vx -= a.x * 0.12; a.vy -= a.y * 0.12; }
      else if (radialActive && !a.isBubble) {
        var tgt = targets[a.id];
        if (tgt) { a.vx += (tgt.x - a.x) * 0.09 * alpha; a.vy += (tgt.y - a.y) * 0.09 * alpha; }
        a.vx -= a.x * gravity * 0.15 * alpha; a.vy -= a.y * gravity * 0.15 * alpha;
      } else {
        a.vx -= a.x * gravity * alpha; a.vy -= a.y * gravity * alpha;
        // home spring applies to bubbles too (not alpha-scaled: sections must
        // stay put even once the simulation has mostly cooled down, otherwise
        // a "Collapse all" late in the simulation's life barely moves them)
        if (homes) { var home = homes[a.group]; if (home) { a.vx += (home.x - a.x) * 0.08; a.vy += (home.y - a.y) * 0.08; } }
      }
      if ((drag && drag.node === a) || a.fixed) { a.vx = a.vy = 0; continue; }
      a.vx *= 0.55; a.vy *= 0.55; a.x += a.vx; a.y += a.vy;
    }
    // explicit collision resolution for bubbles: the inverse-square repulsion
    // above weakens with distance and can leave several heavy bubbles stuck
    // overlapping (classic degenerate case when they start on top of each
    // other, e.g. right after "Collapse all"). Push apart anything that
    // still overlaps a bubble's world-space radius, directly, every frame.
    if (sim.bubbles.length) {
      for (i = 0; i < sim.bubbles.length; i++) {
        for (j = i + 1; j < sim.bubbles.length; j++) {
          var ba = sim.bubbles[i], bb = sim.bubbles[j];
          dx = bb.x - ba.x; dy = bb.y - ba.y; d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          var minD = ba.rw + bb.rw;
          if (d < minD) {
            var push = (minD - d) / 2, ux = dx / d, uy = dy / d;
            ba.x -= ux * push; ba.y -= uy * push; bb.x += ux * push; bb.y += uy * push;
          }
        }
        var bub = sim.bubbles[i];
        for (j = 0; j < sim.nodes.length; j++) {
          var nd = sim.nodes[j]; if ((drag && drag.node === nd) || nd.fixed) continue;
          dx = nd.x - bub.x; dy = nd.y - bub.y; d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          if (d < bub.rw) {
            var push2 = bub.rw - d, ux2 = dx / d, uy2 = dy / d;
            // the bubble is "heavy": the ordinary node yields almost all the way
            nd.x += ux2 * push2 * 0.9; nd.y += uy2 * push2 * 0.9;
            bub.x -= ux2 * push2 * 0.1; bub.y -= uy2 * push2 * 0.1;
          }
        }
      }
    }
    alpha = Math.max(0.015, alpha * (S.animate ? 0.988 : 0.9));
  }
  function start() { if (!running) { running = true; loop(); } }
  function loop() {
    if (!running) return; tick(); draw();
    // a view waiting to be framed: once the layout has mostly settled is soon
    // enough (nodes barely move after this), and much sooner than a full stop
    if (pendingFit && laidOut && alpha <= 0.05) { var ids = pendingFit; pendingFit = null; fitTo(ids); draw(); }
    if (alpha <= 0.0151 && !drag) { running = false; return; }
    requestAnimationFrame(loop);
  }
  function reheat(a) { alpha = Math.max(alpha, a || 0.3); start(); }

  // ---- drawing ----
  function toScreen(x, y) { return [W / 2 + (x + view.x) * view.k, H / 2 + (y + view.y) * view.k]; }
  function toWorld(sx, sy) { return [(sx - W / 2) / view.k - view.x, (sy - H / 2) / view.k - view.y]; }
  function fitBox(minX, minY, maxX, maxY) {
    var k = Math.min(2.5, 0.9 * Math.min(W / Math.max(60, maxX - minX + 100), H / Math.max(60, maxY - minY + 100)));
    view = { k: k, x: -(minX + maxX) / 2, y: -(minY + maxY) / 2 };
  }
  function fit() {
    var sim = computeSim(); var vis = sim.nodes.concat(sim.bubbles); if (!vis.length) return;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    vis.forEach(function (n) { var r = n.isBubble ? n.r0 : 0; minX = Math.min(minX, n.x - r); maxX = Math.max(maxX, n.x + r); minY = Math.min(minY, n.y - r); maxY = Math.max(maxY, n.y + r); });
    fitBox(minX, minY, maxX, maxY);
  }
  // frame a set of node ids (a view's members, a reach); falls back to fit()
  function fitTo(ids) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, c = 0;
    (ids || []).forEach(function (id) { var n = byId[id]; if (!n || !n.vis) return; c++; minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); });
    if (!c) { fit(); return; }
    fitBox(minX, minY, maxX, maxY);
    view.k = Math.min(view.k, 1.6);
  }
  function drawSectionHulls(t, sim) {
    var byGroup = {};
    sim.nodes.forEach(function (n) { (byGroup[n.group] = byGroup[n.group] || []).push(n); });
    Object.keys(byGroup).forEach(function (gid) {
      var list = byGroup[gid]; if (!list.length) return;
      var cx = 0, cy = 0; list.forEach(function (n) { cx += n.x; cy += n.y; }); cx /= list.length; cy /= list.length;
      var maxD = 0; list.forEach(function (n) { var dd = Math.hypot(n.x - cx, n.y - cy); if (dd > maxD) maxD = dd; });
      var radius = (Math.max(40, maxD + 30)) * view.k;
      var p = toScreen(cx, cy);
      if (p[0] < -radius || p[1] < -radius || p[0] > W + radius || p[1] > H + radius) return;
      var col = G.PALETTE[((Number(gid) % G.PALETTE.length) + G.PALETTE.length) % G.PALETTE.length];
      ctx.globalAlpha = 0.07; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(p[0], p[1], radius, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.3; ctx.lineWidth = 1; ctx.strokeStyle = col; ctx.stroke();
      var title = groupInfo[gid] ? groupInfo[gid].title : 'Group ' + gid;
      ctx.globalAlpha = 0.75; ctx.fillStyle = t.muted; ctx.font = '600 11px ' + t.font; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(title, p[0], p[1] - radius - 4);
    });
    ctx.globalAlpha = 1;
  }
  function hlColor(kind, t) { return kind === 'up' ? UP : kind === 'down' ? DOWN : t.accent; }
  // arrowhead at `to`, pulled back by the target node's radius
  function drawArrow(from, to, r, color) {
    var dx = to[0] - from[0], dy = to[1] - from[1], d = Math.hypot(dx, dy); if (d < r + 6) return;
    var ux = dx / d, uy = dy / d, tipX = to[0] - ux * (r + 1), tipY = to[1] - uy * (r + 1), size = 6;
    ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - ux * size - uy * size * 0.55, tipY - uy * size + ux * size * 0.55);
    ctx.lineTo(tipX - ux * size + uy * size * 0.55, tipY - uy * size - ux * size * 0.55);
    ctx.closePath(); ctx.fill();
  }
  function draw() {
    var t = theme(); ctx.clearRect(0, 0, W, H);
    var sim = computeSim();
    var byGidBubble = {}; sim.bubbles.forEach(function (b) { byGidBubble[b.group] = b; });
    // cluster layout: a faint translucent disc behind each section's still
    // -expanded nodes (centroid + radius covering them), labelled at its
    // top, so the regions read clearly even zoomed out and before/between
    // bubbles taking over
    if (S.layout === 'cluster') drawSectionHulls(t, sim);
    var focus = hover || pinned, neighbours = null;
    if (focus && !focus.isBubble) { neighbours = {}; neighbours[focus.id] = true; pairs.forEach(function (p) { if (p.a === focus) neighbours[p.b.id] = true; if (p.b === focus) neighbours[p.a.id] = true; }); }
    var hlSet = hl ? hl.ids : null, hlEdges = hl ? hl.edges : null, hlArrows = hl ? hl.arrows : null;
    var hlOrder = null;
    if (hl && hl.kind === 'view') { hlOrder = {}; hl.order.forEach(function (id, i) { hlOrder[id] = i + 1; }); }
    var lw = Math.max(0.3, S.lineWidth * Math.min(1.1, 0.35 + view.k * 0.3));
    var sizeK = S.nodeSize * Math.pow(view.k, 0.6);
    var bridgeSeen = {};
    var arrows = [];
    pairs.forEach(function (p) {
      if (!p.a.vis || !p.b.vis) return;
      var aHidden = sim.active[p.a.group], bHidden = sim.active[p.b.group];
      var lit = hlEdges && hlEdges[edgeKey(p.a.id, p.b.id)];
      if (aHidden && bHidden) return; // bubble<->bubble handled below as an aggregated band
      if (aHidden || bHidden) {
        var bub = aHidden ? byGidBubble[p.a.group] : byGidBubble[p.b.group];
        var node = aHidden ? p.b : p.a;
        if (!bub) return;
        var key = bub.id + '|' + node.id; if (bridgeSeen[key]) return; bridgeSeen[key] = true;
        var A0 = toScreen(bub.x, bub.y), B0 = toScreen(node.x, node.y);
        ctx.strokeStyle = t.line; ctx.globalAlpha = 0.3; ctx.lineWidth = Math.max(0.4, lw * 0.8);
        ctx.beginPath(); ctx.moveTo(A0[0], A0[1]); ctx.lineTo(B0[0], B0[1]); ctx.stroke();
        return;
      }
      var A = toScreen(p.a.x, p.a.y), B = toScreen(p.b.x, p.b.y);
      var hot = focus && !focus.isBubble && (p.a === focus || p.b === focus);
      var color = lit ? hlColor(lit, t) : (hot ? t.accent : t.line);
      ctx.strokeStyle = color;
      ctx.globalAlpha = hlSet ? (lit ? 0.95 : 0.06) : (focus ? (hot ? 0.95 : 0.08) : 0.45);
      ctx.lineWidth = (lit || hot) ? lw * 2 : lw;
      ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke();
      if (lit && hlArrows) {
        if (hlArrows[p.a.id + '|' + p.b.id]) arrows.push([A, B, nodeRadius(p.b) * sizeK, color]);
        if (hlArrows[p.b.id + '|' + p.a.id]) arrows.push([B, A, nodeRadius(p.a) * sizeK, color]);
      }
    });
    if (sim.bubbles.length > 1) {
      var links = clusterLinksFor(sim.active);
      var maxCount = links.reduce(function (m, l) { return Math.max(m, l.count); }, 1);
      links.forEach(function (l) {
        var ba = byGidBubble[l.a], bb = byGidBubble[l.b]; if (!ba || !bb) return;
        var A = toScreen(ba.x, ba.y), B = toScreen(bb.x, bb.y);
        ctx.strokeStyle = t.line; ctx.globalAlpha = 0.5; ctx.lineWidth = G.bandWidth(l.count, maxCount);
        ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke();
      });
    }
    var labelAlpha = Math.max(0, Math.min(1, (view.k - 1.0 * S.textFade) / (0.8 * S.textFade)));
    var labels = [], badges = [];
    sim.nodes.forEach(function (n) {
      var p = toScreen(n.x, n.y), r = nodeRadius(n) * sizeK;
      if (p[0] < -r || p[1] < -r || p[0] > W + r || p[1] > H + r) return;
      var inHl = hlSet && hlSet[n.id];
      var dim = (neighbours && !neighbours[n.id]) || (hlSet && !inHl);
      ctx.globalAlpha = dim ? 0.18 : 1;
      ctx.fillStyle = colorOf(n); ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.fill();
      if (inHl) {
        var ring = hl.kind === 'reach' ? (n.id === hl.root ? t.fg : hlColor(inHl, t)) : t.accent;
        ctx.strokeStyle = ring; ctx.lineWidth = n.id === (hl.root || '') ? 2.6 : 2.2; ctx.globalAlpha = 1; ctx.stroke();
      }
      else if (n.center || n === focus) { ctx.strokeStyle = t.fg; ctx.lineWidth = 2; ctx.globalAlpha = 1; ctx.stroke(); }
      if (n.fixed) { ctx.strokeStyle = t.muted; ctx.lineWidth = 1; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.arc(p[0], p[1], r + 3, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
      if (hlOrder && hlOrder[n.id]) badges.push({ p: p, r: r, n: hlOrder[n.id] });
      var priority = n === focus || (neighbours && neighbours[n.id]) || inHl;
      if (priority) labels.push({ n: n, p: p, r: r, a: 1, priority: true });
      else if (labelAlpha > 0.02 && !dim) labels.push({ n: n, p: p, r: r, a: labelAlpha, priority: false });
    });
    ctx.globalAlpha = 1;
    arrows.forEach(function (a) { drawArrow(a[0], a[1], a[2], a[3]); });
    // a view's reading order, as a small numbered badge at the node's top-right
    badges.forEach(function (b) {
      var bx = b.p[0] + b.r * 0.8 + 4, by = b.p[1] - b.r * 0.8 - 4;
      ctx.fillStyle = t.accent; ctx.beginPath(); ctx.arc(bx, by, 7.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '600 9px ' + t.font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(b.n), bx, by + 0.5);
    });
    sim.bubbles.forEach(function (b) {
      var p = toScreen(b.x, b.y), r = b.r0;
      var bcol = G.PALETTE[((b.group % G.PALETTE.length) + G.PALETTE.length) % G.PALETTE.length];
      ctx.globalAlpha = 0.22; ctx.fillStyle = bcol; ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = (pinned === b || hover === b) ? 1 : 0.65; ctx.strokeStyle = bcol; ctx.lineWidth = (pinned === b || hover === b) ? 2.5 : 1.5; ctx.stroke();
      ctx.globalAlpha = 1;
      var fs = Math.max(11, Math.min(16, 11 + r * 0.035));
      ctx.font = '600 ' + fs + 'px ' + t.font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3; ctx.strokeStyle = t.bg; ctx.lineJoin = 'round';
      ctx.strokeText(b.title, p[0], p[1]); ctx.fillStyle = t.fg; ctx.fillText(b.title, p[0], p[1]);
    });
    labels.sort(function (x, y) { return (y.priority - x.priority) || (y.n.deg - x.n.deg); });
    var placed = [];
    labels.forEach(function (l) {
      var label = l.n.title.length > 42 ? l.n.title.slice(0, 40) + '…' : l.n.title;
      var fs = Math.max(10, Math.min(14, 10 * Math.pow(view.k, 0.3)));
      ctx.font = (l.n === focus ? '600 ' : '') + fs + 'px ' + t.font;
      var w = ctx.measureText(label).width, x0 = l.p[0] - w / 2, y0 = l.p[1] + l.r + 3;
      var pad = 4;
      if (!l.priority) { for (var i = 0; i < placed.length; i++) { var q = placed[i]; if (x0 - pad < q.x1 && x0 + w + pad > q.x0 && y0 - pad < q.y1 && y0 + fs + pad > q.y0) return; } }
      placed.push({ x0: x0, x1: x0 + w, y0: y0, y1: y0 + fs });
      ctx.globalAlpha = l.a; ctx.fillStyle = t.fg; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.lineWidth = 3; ctx.strokeStyle = t.bg; ctx.lineJoin = 'round'; ctx.strokeText(label, l.p[0], y0); ctx.fillText(label, l.p[0], y0);
    });
    ctx.globalAlpha = 1;
  }

  // ---- interaction --------------------------------------------------
  function nodeAt(sx, sy) {
    var sim = computeSim();
    var best = null, bd = 14 * 14, sizeK = S.nodeSize * Math.pow(view.k, 0.6);
    sim.nodes.forEach(function (n) { var p = toScreen(n.x, n.y); var r = nodeRadius(n) * sizeK; var dx = p[0] - sx, dy = p[1] - sy, d2 = dx * dx + dy * dy, rr = Math.max(9, r + 3); if (d2 < rr * rr && d2 < bd) { bd = d2; best = n; } });
    sim.bubbles.forEach(function (b) { var p = toScreen(b.x, b.y); var dx = p[0] - sx, dy = p[1] - sy, d2 = dx * dx + dy * dy; if (d2 < b.r0 * b.r0 && d2 < bd) { bd = d2; best = b; } });
    return best;
  }
  function pos(ev) { var r = canvas.getBoundingClientRect(); var p = ev.touches ? ev.touches[0] : ev; return [p.clientX - r.left, p.clientY - r.top]; }
  function updateHover(n) {
    if (!hoverEl) return;
    if (!n) { hoverEl.textContent = ''; return; }
    if (n.isBubble) { hoverEl.textContent = n.title; return; }
    if (n.type === 'tag') { hoverEl.textContent = n.id; return; }
    hoverEl.textContent = n.title + (n.folder ? '  ·  ' + n.folder : '') + '  ·  ' + (n.links || 0) + ' links';
  }
  function setCenter(id) {
    centerId = id; S.layout = 'radial'; var sel = $('exLayout'); if (sel) sel.value = 'radial'; save();
    nodes.forEach(function (n) { n.center = n.id === id; });
    fetchAndLoad();
  }
  function openNode(n, ev) {
    if (n.isBubble) { expandBubble(n); return; }
    if (!n.url) { S.query = 'tag:' + n.id; qTerms = G.parseQuery(S.query); var qEl2 = $('exQuery'); if (qEl2) qEl2.value = S.query; visCache = null; reheat(0.25); draw(); return; }
    if (ev && (ev.ctrlKey || ev.metaKey)) window.open(n.url, '_blank'); else location.href = withMode(n.url);
  }
  canvas.addEventListener('mousemove', function (ev) {
    var p = pos(ev);
    if (drag) {
      drag.moved = drag.moved || Math.hypot(p[0] - drag.x, p[1] - drag.y) > 3;
      if (drag.node) { var w = toWorld(p[0], p[1]); drag.node.x = w[0]; drag.node.y = w[1]; reheat(0.12); }
      else { view.x += (p[0] - drag.px) / view.k; view.y += (p[1] - drag.py) / view.k; drag.px = p[0]; drag.py = p[1]; draw(); }
      return;
    }
    var h = nodeAt(p[0], p[1]);
    if (h !== hover) { hover = h; canvas.style.cursor = h ? 'pointer' : 'grab'; draw(); updateHover(h); }
  });
  canvas.addEventListener('mousedown', function (ev) { if (ev.button !== 0) return; var p = pos(ev); var n = nodeAt(p[0], p[1]); drag = { node: n, x: p[0], y: p[1], px: p[0], py: p[1], moved: false, t: Date.now(), alt: ev.altKey }; canvas.style.cursor = 'grabbing'; });
  window.addEventListener('mouseup', function (ev) {
    if (!drag) return;
    var d = drag; drag = null; canvas.style.cursor = hover ? 'pointer' : 'grab';
    if (d.node) {
      if (!d.moved && Date.now() - d.t < 600) {
        if (!d.node.isBubble && d.alt && d.node.url) setCenter(d.node.id);
        else openNode(d.node, ev);
      } else if (d.moved) { d.node.fixed = true; }
    } else if (!d.moved) { pinned = null; draw(); }
    start();
  });
  canvas.addEventListener('dblclick', function (ev) { var p = pos(ev); var n = nodeAt(p[0], p[1]); if (n) { n.fixed = false; reheat(0.2); } else { fit(); draw(); } });
  canvas.addEventListener('contextmenu', function (ev) { var p = pos(ev); var n = nodeAt(p[0], p[1]); if (n) { ev.preventDefault(); pinned = pinned === n ? null : n; draw(); } });
  canvas.addEventListener('mouseleave', function () { if (hover) { hover = null; draw(); updateHover(null); } });
  canvas.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    var p = pos(ev), before = toWorld(p[0], p[1]);
    view.k = Math.max(0.08, Math.min(8, view.k * (ev.deltaY < 0 ? 1.15 : 1 / 1.15)));
    var after = toWorld(p[0], p[1]); view.x += after[0] - before[0]; view.y += after[1] - before[1]; draw();
  }, { passive: false });
  var pinch = null;
  canvas.addEventListener('touchstart', function (ev) { if (ev.touches.length === 2) { pinch = Math.hypot(ev.touches[0].clientX - ev.touches[1].clientX, ev.touches[0].clientY - ev.touches[1].clientY); } else { var p = pos(ev); drag = { node: nodeAt(p[0], p[1]), x: p[0], y: p[1], px: p[0], py: p[1], moved: false, t: Date.now() }; } }, { passive: true });
  canvas.addEventListener('touchmove', function (ev) {
    if (ev.touches.length === 2 && pinch) { var d = Math.hypot(ev.touches[0].clientX - ev.touches[1].clientX, ev.touches[0].clientY - ev.touches[1].clientY); view.k = Math.max(0.08, Math.min(8, view.k * d / pinch)); pinch = d; draw(); ev.preventDefault(); return; }
    if (!drag) return; var p = pos(ev); drag.moved = true;
    if (drag.node) { var w = toWorld(p[0], p[1]); drag.node.x = w[0]; drag.node.y = w[1]; reheat(0.12); } else { view.x += (p[0] - drag.px) / view.k; view.y += (p[1] - drag.py) / view.k; drag.px = p[0]; drag.py = p[1]; draw(); }
    ev.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchend', function () { pinch = null; if (drag && drag.node && !drag.moved && Date.now() - drag.t < 500) openNode(drag.node); drag = null; start(); });

  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas); else window.addEventListener('resize', resize);

  // ---- legend / note list -------------------------------------------
  function renderLegend() {
    if (!legendEl) return;
    var items;
    if (S.colorBy === 'lang') items = langList.map(function (l, i) { return { label: l, color: G.PALETTE[i % G.PALETTE.length] }; });
    else if (S.colorBy === 'status') items = [
      { label: 'ready/agreed/accepted', color: '#2fbf71' }, { label: 'draft/in-progress', color: '#f2b134' },
      { label: 'other', color: '#9aa0a6' }, { label: 'no status', color: '#d5d8dc' }
    ];
    else if (S.colorBy === 'updated') items = [
      { label: 'this week', color: '#2fbf71' }, { label: 'this month', color: '#4c8dff' },
      { label: 'this year', color: '#f2b134' }, { label: 'older / unknown', color: '#9aa0a6' }
    ];
    else items = groups.filter(function (g) { return g.key !== '#'; }).map(function (g) { return { label: g.title, color: G.PALETTE[g.id % G.PALETTE.length] }; });
    legendEl.innerHTML = items.map(function (it) { return '<span class="gp-chip"><i style="background:' + it.color + '"></i>' + esc(it.label) + '</span>'; }).join('');
  }
  function updateNoteList() {
    if (!noteListEl) return;
    noteListEl.innerHTML = nodes.filter(function (n) { return n.type !== 'tag'; }).map(function (n) { return '<option value="' + esc(n.title) + '">'; }).join('');
  }
  function titleToId(title) {
    var t = String(title || '').trim().toLowerCase(); if (!t) return null;
    var hit = nodes.filter(function (n) { return n.title.toLowerCase() === t || n.id.toLowerCase() === t; })[0];
    return hit ? hit.id : null;
  }
  // a clickable note link for the result lists: pins and centres the node
  function noteLink(id, cls, prefix) {
    var n = byId[id];
    return '<a data-id="' + esc(id) + '"' + (cls ? ' class="' + cls + '"' : '') + '>' + (prefix || '') + esc(n ? n.title : id) + '</a>';
  }
  function wireLinks(el) {
    if (!el) return;
    Array.prototype.forEach.call(el.querySelectorAll('a[data-id]'), function (a) {
      a.addEventListener('click', function () { var n = byId[a.getAttribute('data-id')]; if (!n) return; pinned = n; view.x = -n.x; view.y = -n.y; view.k = Math.max(view.k, 1.2); draw(); });
    });
  }

  // ---- highlights: path, reach, view ----------------------------------
  // The URL carries the active view or reach so a visitor can share it:
  //   ?view=<id>              ?reach=<rel>&dir=up|down|both&hops=<n|0>
  function syncUrl() {
    if (!window.history || !history.replaceState) return;
    var q = [];
    if (centerId && focusAttr) q.push('focus=' + encodeURIComponent(focusAttr));
    if (hl && hl.kind === 'view') q.push('view=' + encodeURIComponent(hl.view));
    if (hl && hl.kind === 'reach') { q.push('reach=' + encodeURIComponent(hl.root)); q.push('dir=' + hl.dir); if (hl.hops) q.push('hops=' + hl.hops); }
    var url = location.pathname + (q.length ? '?' + q.join('&') : '') + location.hash;
    if (url !== location.pathname + location.search + location.hash) history.replaceState(null, '', url);
  }
  function setHighlight(h) {
    hl = h; renderCaption(); renderViews(); renderReachResult(); syncUrl(); draw();
  }
  function clearHighlight() {
    if (!hl) return;
    if (hl.kind === 'path') { if (pathResultEl) pathResultEl.innerHTML = ''; }
    setHighlight(null);
  }
  function showPath(fromId, toId) {
    var visN = visibleNodes(), ids = visN.map(function (n) { return n.id; });
    var edgePairs = []; pairs.forEach(function (p) { if (p.a.vis && p.b.vis) edgePairs.push([p.a.id, p.b.id]); });
    var path = G.shortestPath(ids, edgePairs, fromId, toId);
    if (!path) { setHighlight(null); if (pathResultEl) pathResultEl.innerHTML = '<span class="muted">No path between those notes (within the current filter).</span>'; return; }
    var h = { kind: 'path', ids: {}, edges: {}, arrows: null, order: path };
    path.forEach(function (id, i) { h.ids[id] = true; if (i) h.edges[edgeKey(path[i - 1], id)] = 'path'; });
    setHighlight(h);
    if (pathResultEl) { pathResultEl.innerHTML = path.map(function (id) { return noteLink(id); }).join('<span class="muted"> → </span>'); wireLinks(pathResultEl); }
  }
  function showReach(rootId, dir, hops) {
    var visN = visibleNodes(), ids = visN.map(function (n) { return n.id; });
    var edges = dirEdges.filter(function (e) { var a = byId[e[0]], b = byId[e[1]]; return a && b && a.vis && b.vis; });
    var up = (dir === 'up' || dir === 'both') ? G.reach(ids, edges, rootId, 'up', hops) : null;
    var down = (dir === 'down' || dir === 'both') ? G.reach(ids, edges, rootId, 'down', hops) : null;
    if (!up && !down) { setHighlight(null); if (reachResultEl) reachResultEl.innerHTML = '<span class="muted">Pick a known note.</span>'; return; }
    var h = { kind: 'reach', ids: {}, edges: {}, arrows: {}, order: [], root: rootId, dir: dir, hops: hops, up: [], down: [] };
    h.ids[rootId] = 'root';
    function take(res, kind) {
      if (!res) return;
      Object.keys(res.depth).forEach(function (id) { if (id !== rootId && !h.ids[id]) { h.ids[id] = kind; h[kind].push({ id: id, hops: res.depth[id] }); } });
      res.edges.forEach(function (e) { var k = edgeKey(e[0], e[1]); if (!h.edges[k]) h.edges[k] = kind; h.arrows[e[0] + '|' + e[1]] = true; });
    }
    take(up, 'up'); take(down, 'down');
    var byHops = function (a, b) { return a.hops - b.hops || (byId[a.id] && byId[b.id] ? byId[a.id].title.localeCompare(byId[b.id].title) : 0); };
    h.up.sort(byHops); h.down.sort(byHops);
    h.order = [rootId].concat(h.up.map(function (x) { return x.id; }), h.down.map(function (x) { return x.id; }));
    setHighlight(h);
    var reachFromEl = $('exReachFrom'); if (reachFromEl && byId[rootId]) reachFromEl.value = byId[rootId].title;
  }
  function showView(id) {
    var v = null; views.forEach(function (x) { if (x.id === id) v = x; });
    if (!v) { setHighlight(null); return; }
    var h = { kind: 'view', ids: {}, edges: {}, arrows: null, order: v.members.slice(), view: v.id, title: v.label, note: v.note, missing: [] };
    v.members.forEach(function (m) { if (byId[m]) h.ids[m] = 'view'; else h.missing.push(m); });
    pairs.forEach(function (p) { if (h.ids[p.a.id] && h.ids[p.b.id]) h.edges[edgeKey(p.a.id, p.b.id)] = 'view'; });
    setHighlight(h);
    if (running) pendingFit = v.members.slice(); else { fitTo(v.members); draw(); }
  }
  // after a reload (tags toggled, radial depth, new centre) keep what was lit
  function reapplyHighlight() {
    if (!hl) return;
    if (hl.kind === 'view') showView(hl.view);
    else if (hl.kind === 'reach') { if (byId[hl.root]) showReach(hl.root, hl.dir, hl.hops); else setHighlight(null); }
    else clearHighlight();
  }
  function reachTitle(h) {
    var name = byId[h.root] ? byId[h.root].title : h.root;
    return (h.dir === 'up' ? 'Upstream of ' : h.dir === 'down' ? 'Downstream of ' : 'Reach of ') + name;
  }
  function renderReachResult() {
    if (!reachResultEl) return;
    if (!hl || hl.kind !== 'reach') { reachResultEl.innerHTML = ''; return; }
    var parts = [];
    if (hl.dir !== 'down') parts.push('<span class="is-up">' + hl.up.length + ' upstream</span>');
    if (hl.dir !== 'up') parts.push('<span class="is-down">' + hl.down.length + ' downstream</span>');
    reachResultEl.innerHTML = '<span class="muted">' + parts.join(' · ') + (hl.hops ? ' · within ' + hl.hops + ' hop' + (hl.hops > 1 ? 's' : '') : '') + '</span>';
  }
  function renderCaption() {
    if (!captionEl) return;
    if (!hl || hl.kind === 'path') { captionEl.hidden = true; return; }
    captionEl.hidden = false;
    if (hl.kind === 'view') {
      captionTitleEl.textContent = hl.title;
      captionNoteEl.textContent = hl.note || '';
      captionNoteEl.hidden = !hl.note;
      var rows = hl.order.map(function (id, i) {
        var known = byId[id];
        return '<span>' + '<span class="gp-num">' + (i + 1) + '.</span>' + (known ? noteLink(id) : '<span class="muted">' + esc(id.replace(/\.md$/i, '')) + ' (not in this graph)</span>') + '</span>';
      });
      captionListEl.innerHTML = rows.join('');
    } else {
      captionTitleEl.textContent = reachTitle(hl);
      var n = hl.up.length + hl.down.length;
      captionNoteEl.hidden = false;
      captionNoteEl.textContent = n ? (n + ' note' + (n > 1 ? 's' : '') + (hl.hops ? ' within ' + hl.hops + ' hop' + (hl.hops > 1 ? 's' : '') : '') + ' · arrows follow the links') : 'Nothing links ' + (hl.dir === 'up' ? 'here' : hl.dir === 'down' ? 'out of it' : 'in or out') + ' within the current filter.';
      var html = '';
      if (hl.up.length) html += '<span class="muted">Upstream — links here</span>' + hl.up.map(function (x) { return noteLink(x.id, 'is-up', '<span class="gp-num">' + x.hops + '</span>'); }).join('');
      if (hl.down.length) html += '<span class="muted">Downstream — linked from here</span>' + hl.down.map(function (x) { return noteLink(x.id, 'is-down', '<span class="gp-num">' + x.hops + '</span>'); }).join('');
      captionListEl.innerHTML = html;
    }
    wireLinks(captionListEl);
  }
  function renderViews() {
    if (!viewsEl) return;
    if (!views.length) { viewsEl.innerHTML = '<span class="muted">No views yet. Declare them under <code>views:</code> in a note’s frontmatter.</span>'; return; }
    var active = hl && hl.kind === 'view' ? hl.view : null;
    viewsEl.innerHTML = views.map(function (v) { return '<button type="button" data-view="' + esc(v.id) + '"' + (v.id === active ? ' class="is-active"' : '') + ' title="' + esc(v.note || (v.members.length + ' notes')) + '">' + esc(v.label) + '</button>'; }).join('');
    Array.prototype.forEach.call(viewsEl.querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () { var id = b.getAttribute('data-view'); if (hl && hl.kind === 'view' && hl.view === id) clearHighlight(); else showView(id); });
    });
  }

  // ---- panel wiring ---------------------------------------------------
  function bindToggle(id, key, after) { var el = $(id); if (!el) return; el.checked = !!S[key]; el.addEventListener('change', function () { S[key] = el.checked; save(); if (key === 'tags') { fetchAndLoad(); return; } visCache = null; reheat(key === 'bubbles' ? 0.45 : 0.2); draw(); if (after) after(); }); }
  function bindSlider(id, key, after) { var el = $(id); if (!el) return; el.value = S[key]; el.nextElementSibling.textContent = S[key]; el.addEventListener('input', function () { var v = Number(el.value); el.nextElementSibling.textContent = v; S[key] = v; save(); if (key === 'depth' && centerId) { fetchAndLoad(); return; } reheat(0.2); draw(); if (after) after(); }); }
  function bindSelect(id, key, after) { var el = $(id); if (!el) return; el.value = S[key]; el.addEventListener('change', function () { S[key] = el.value; save(); reheat(key === 'layout' ? 0.5 : 0.2); draw(); if (after) after(); }); }

  bindToggle('exTags', 'tags'); bindToggle('exOrphans', 'orphans'); bindToggle('exBubbles', 'bubbles'); bindToggle('exAnimate', 'animate');
  bindSlider('exDepth', 'depth'); bindSlider('exTextFade', 'textFade'); bindSlider('exNodeSize', 'nodeSize'); bindSlider('exLineWidth', 'lineWidth');
  bindSelect('exColorBy', 'colorBy', renderLegend); bindSelect('exSizeBy', 'sizeBy'); bindSelect('exLayout', 'layout');

  var qEl = $('exQuery'), qTimer;
  if (qEl) qEl.addEventListener('input', function () { clearTimeout(qTimer); qTimer = setTimeout(function () { S.query = qEl.value; save(); qTerms = G.parseQuery(S.query); visCache = null; reheat(0.25); draw(); }, 120); });

  var collapseAllBtn = $('exCollapseAll'), expandAllBtn = $('exExpandAll');
  if (collapseAllBtn) collapseAllBtn.addEventListener('click', function () { S.collapsed = Object.keys(groupInfo).map(Number); save(); visCache = null; reheat(0.45); draw(); });
  if (expandAllBtn) expandAllBtn.addEventListener('click', function () { S.collapsed = []; save(); visCache = null; reheat(0.45); draw(); });

  var pathGoBtn = $('exPathGo'), pathClearBtn = $('exPathClear'), pathFromEl = $('exPathFrom'), pathToEl = $('exPathTo');
  if (pathGoBtn) pathGoBtn.addEventListener('click', function () {
    var fromId = titleToId(pathFromEl && pathFromEl.value), toId = titleToId(pathToEl && pathToEl.value);
    if (!fromId || !toId) { setHighlight(null); if (pathResultEl) pathResultEl.innerHTML = '<span class="muted">Pick two known notes.</span>'; return; }
    showPath(fromId, toId);
  });
  if (pathClearBtn) pathClearBtn.addEventListener('click', function () { if (pathFromEl) pathFromEl.value = ''; if (pathToEl) pathToEl.value = ''; if (hl && hl.kind === 'path') clearHighlight(); if (pathResultEl) pathResultEl.innerHTML = ''; });

  // reach: direction and hop limit persist like the other settings; a live
  // reach follows a change straight away
  var reachGoBtn = $('exReachGo'), reachClearBtn = $('exReachClear'), reachFromEl = $('exReachFrom'), reachDirEl = $('exReachDir'), reachDepthEl = $('exReachDepth');
  if (reachDirEl) { reachDirEl.value = S.reachDir; reachDirEl.addEventListener('change', function () { S.reachDir = reachDirEl.value; save(); if (hl && hl.kind === 'reach') showReach(hl.root, S.reachDir, S.reachHops); }); }
  if (reachDepthEl) { reachDepthEl.value = String(S.reachHops); reachDepthEl.addEventListener('change', function () { S.reachHops = Number(reachDepthEl.value) || 0; save(); if (hl && hl.kind === 'reach') showReach(hl.root, S.reachDir, S.reachHops); }); }
  if (reachGoBtn) reachGoBtn.addEventListener('click', function () {
    var id = titleToId(reachFromEl && reachFromEl.value);
    if (!id) { if (reachResultEl) reachResultEl.innerHTML = '<span class="muted">Pick a known note.</span>'; return; }
    showReach(id, S.reachDir, S.reachHops);
  });
  if (reachClearBtn) reachClearBtn.addEventListener('click', function () { if (reachFromEl) reachFromEl.value = ''; if (hl && hl.kind === 'reach') clearHighlight(); if (reachResultEl) reachResultEl.innerHTML = ''; });
  var captionCloseBtn = $('exCaptionClose');
  if (captionCloseBtn) captionCloseBtn.addEventListener('click', clearHighlight);

  var resetBtn = $('exReset');
  if (resetBtn) resetBtn.addEventListener('click', function () {
    var keepDepth = S.depth;
    S = Object.assign({}, DEFAULTS, { depth: keepDepth });
    save();
    var t1 = $('exTags'), t2 = $('exOrphans'), t3 = $('exBubbles'), t4 = $('exAnimate');
    if (t1) t1.checked = DEFAULTS.tags; if (t2) t2.checked = DEFAULTS.orphans; if (t3) t3.checked = DEFAULTS.bubbles; if (t4) t4.checked = DEFAULTS.animate;
    [['exTextFade', 'textFade'], ['exNodeSize', 'nodeSize'], ['exLineWidth', 'lineWidth']].forEach(function (pair) {
      var el = $(pair[0]); if (el) { el.value = DEFAULTS[pair[1]]; el.nextElementSibling.textContent = DEFAULTS[pair[1]]; }
    });
    var cb = $('exColorBy'), sb = $('exSizeBy'), lb = $('exLayout');
    if (cb) cb.value = DEFAULTS.colorBy; if (sb) sb.value = DEFAULTS.sizeBy; if (lb) lb.value = DEFAULTS.layout;
    if (reachDirEl) reachDirEl.value = DEFAULTS.reachDir; if (reachDepthEl) reachDepthEl.value = String(DEFAULTS.reachHops);
    qTerms = G.parseQuery(S.query); if (qEl) qEl.value = '';
    clearHighlight();
    visCache = null; renderLegend(); reheat(0.5); draw();
  });

  var zIn = $('exzIn'), zOut = $('exzOut'), zFit = $('exzFit'), zRelease = $('exzRelease');
  if (zIn) zIn.addEventListener('click', function () { view.k = Math.max(0.08, Math.min(8, view.k * 1.3)); draw(); });
  if (zOut) zOut.addEventListener('click', function () { view.k = Math.max(0.08, Math.min(8, view.k / 1.3)); draw(); });
  if (zFit) zFit.addEventListener('click', function () { if (hl && hl.order && hl.order.length) fitTo(hl.order); else fit(); draw(); });
  if (zRelease) zRelease.addEventListener('click', function () { nodes.forEach(function (n) { n.fixed = false; }); reheat(0.4); });

  var panel = $('explorePanel'), toggleBtn = $('exToggle');
  if (panel && toggleBtn) {
    var panelHidden = false; try { panelHidden = localStorage.getItem(KEY + '-panel') === 'hidden'; } catch (e) {}
    if (panelHidden || window.innerWidth < 700) panel.classList.add('is-hidden');
    toggleBtn.addEventListener('click', function () { panel.classList.toggle('is-hidden'); try { localStorage.setItem(KEY + '-panel', panel.classList.contains('is-hidden') ? 'hidden' : 'shown'); } catch (e) {} });
  }
  document.addEventListener('keydown', function (e) {
    if (/input|textarea|select/i.test(document.activeElement.tagName)) { if (e.key === 'Escape') document.activeElement.blur(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); if (panel) panel.classList.remove('is-hidden'); if (qEl) qEl.focus(); }
    else if (e.key === 'f') { if (hl && hl.order && hl.order.length) fitTo(hl.order); else fit(); draw(); }
    else if (e.key === '+' || e.key === '=') { view.k = Math.min(8, view.k * 1.3); draw(); }
    else if (e.key === '-') { view.k = Math.max(0.08, view.k / 1.3); draw(); }
    else if (e.key === 'r' || e.key === 'R') {
      // reach from the node under the pointer (or the right-clicked one)
      var n = hover || pinned; if (!n || n.isBubble || !n.url) return;
      if (hl && hl.kind === 'reach' && hl.root === n.id) clearHighlight(); else showReach(n.id, S.reachDir, S.reachHops);
    }
    else if (e.key === 'Escape') { if (hl) clearHighlight(); else if (panel) panel.classList.add('is-hidden'); }
  });

  // In shell mode the host owns the theme: the saved choice is ignored and the host can push a change down.
  var root = document.documentElement;
  var hosted = !!(window.WEBSIDIAN && window.WEBSIDIAN.shell);
  if (!hosted) { try { var th = localStorage.getItem('md2html-theme'); if (th) root.setAttribute('data-theme', th); } catch (e) {} }
  var themeBtn = $('themeBtn');
  if (themeBtn) themeBtn.addEventListener('click', function () {
    var dark = root.getAttribute('data-theme') === 'dark' || (!root.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    root.setAttribute('data-theme', dark ? 'light' : 'dark'); try { localStorage.setItem('md2html-theme', dark ? 'light' : 'dark'); } catch (e) {}
    draw();
  });
  if (hosted) window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (d && d.type === 'websidian:theme' && (d.theme === 'dark' || d.theme === 'light')) { root.setAttribute('data-theme', d.theme); draw(); }
  });

  // the URL's view or reach, applied once the first graph has loaded
  function applyUrlHighlight() {
    var q; try { q = new URLSearchParams(location.search); } catch (e) { return; }
    var v = q.get('view'), r = q.get('reach');
    if (v) { showView(v); if (hl && hl.kind === 'view') pendingFit = hl.order.slice(); }
    else if (r && byId[r]) {
      var dir = q.get('dir'); if (dir !== 'up' && dir !== 'down' && dir !== 'both') dir = S.reachDir;
      var hops = Number(q.get('hops')); if (!(hops > 0)) hops = 0;
      showReach(r, dir, hops); pendingFit = hl && hl.order ? hl.order.slice() : null;
    }
  }

  function fetchAndLoad() { return fetch(urlFor()).then(function (r) { return r.json(); }).then(load); }
  resize();
  fetchAndLoad().then(applyUrlHighlight);
})();
