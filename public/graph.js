/* Obsidian-style graph view: force-directed layout on a <canvas>.
 * No dependencies. Handles a few thousand nodes; the simulation cools down
 * and stops, then only redraws on interaction.
 *
 *   var g = WEBSIDIAN_GRAPH.mount(canvasEl, { url, center, mini, onLoad, onHover, onNavigate, settings })
 *   g.set({ repel: 1.4, linkDistance: 90, arrows: true, ... })   // live tuning
 *
 * Filter query syntax (like Obsidian): words match title/path, `path:x`,
 * `tag:#x` / `tag:x`, `file:x`, `-term` excludes, quotes for phrases.
 *
 * This file also exports a handful of small pure helpers (colour/layout
 * math with no DOM dependency) that the separate full-screen "Explore" view
 * (public/explore.js) reuses instead of duplicating the logic. They are not
 * called anywhere in mount() below, so they do not change this renderer's
 * own behaviour.
 */
(function () {
  'use strict';
  var PALETTE = ['#4c8dff', '#ff7a45', '#2fbf71', '#b56cff', '#f2b134', '#ff5c8a', '#00b8d9', '#8d6e63', '#7cb342', '#e91e63', '#5c6bc0', '#26a69a'];
  var DEFAULTS = {
    // filters
    query: '', tags: false, orphans: true, depth: 1,
    // display
    arrows: false, textFade: 1.0, nodeSize: 1.0, lineWidth: 1.0, animate: true,
    // forces (1.0 = default strength)
    center: 1.0, repel: 1.0, link: 1.0, linkDistance: 1.0,
    // colour rules: [{ query, color }] – first match wins, else folder palette
    groups: []
  };

  // ---- query language ----------------------------------------------------
  function parseQuery(q) {
    var terms = []; var re = /(-)?(?:(path|tag|file|folder):)?(?:"([^"]*)"|(\S+))/g, m;
    while ((m = re.exec(q || ''))) terms.push({ neg: !!m[1], field: m[2] || null, value: (m[3] !== undefined ? m[3] : m[4]).toLowerCase().replace(/^#/, '') });
    return terms;
  }
  function matchTerm(t, n) {
    var v = t.value; if (!v) return true;
    switch (t.field) {
      case 'path': case 'folder': return n.id.toLowerCase().indexOf(v) >= 0 || (n.folder || '').toLowerCase().indexOf(v) >= 0;
      case 'tag': return (n.tags || []).some(function (x) { return x.toLowerCase() === v || x.toLowerCase().indexOf(v + '/') === 0; }) || (n.type === 'tag' && n.id.slice(1).toLowerCase() === v);
      case 'file': return n.title.toLowerCase().indexOf(v) >= 0;
      default: return n.title.toLowerCase().indexOf(v) >= 0 || n.id.toLowerCase().indexOf(v) >= 0 || (n.tags || []).some(function (x) { return x.toLowerCase().indexOf(v) >= 0; });
    }
  }
  function matches(terms, n) { for (var i = 0; i < terms.length; i++) { var hit = matchTerm(terms[i], n); if (terms[i].neg ? hit : !hit) return false; } return true; }

  function mount(canvas, opts) {
    opts = opts || {};
    var ctx = canvas.getContext('2d');
    var cssVars = getComputedStyle(document.documentElement);
    var theme = function () { cssVars = getComputedStyle(document.documentElement); return { fg: cssVars.getPropertyValue('--fg').trim() || '#222', muted: cssVars.getPropertyValue('--muted').trim() || '#888', line: cssVars.getPropertyValue('--line').trim() || '#ccc', bg: cssVars.getPropertyValue('--bg').trim() || '#fff', accent: cssVars.getPropertyValue('--accent').trim() || '#0969da', font: cssVars.getPropertyValue('--font') || 'sans-serif' }; };
    var S = Object.assign({}, DEFAULTS, opts.settings || {});
    var mini = !!opts.mini;
    var nodes = [], pairs = [], groups = [], byId = {}, raw = null;
    var W = 0, H = 0, dpr = Math.max(1, window.devicePixelRatio || 1);
    var view = { x: 0, y: 0, k: 1 };
    var hover = null, drag = null, alpha = 1, running = false, raf = 0, pinned = null;
    var qTerms = parseQuery(S.query), groupRules = [];
    var visCache = null;

    function compileGroups() { groupRules = (S.groups || []).filter(function (g) { return g && g.query; }).map(function (g) { return { terms: parseQuery(g.query), color: g.color || '#888' }; }); }
    compileGroups();

    function resize() {
      var r = canvas.getBoundingClientRect(); W = Math.max(1, r.width); H = Math.max(1, r.height);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); draw();
    }

    function load(data) {
      raw = data; groups = data.groups || [];
      var prev = byId; byId = {};
      var count = data.nodes.length, R0 = Math.sqrt(count) * 30 + 40;
      nodes = data.nodes.map(function (n, i) {
        var old = prev[n.id];
        var a = i * 2.399963, rr = R0 * Math.sqrt((i + 1) / count); // sunflower seeding: even spread
        var node = { id: n.id, title: n.title, url: n.url, group: n.group, type: n.type, links: n.links, lang: n.lang, folder: n.folder, tags: n.tags || [],
          x: old ? old.x : Math.cos(a) * rr, y: old ? old.y : Math.sin(a) * rr, vx: 0, vy: 0, fixed: old ? old.fixed : false };
        node.r0 = n.type === 'tag' ? 2.6 : Math.min(13, 2.6 + Math.sqrt(n.links) * 1.35);
        if (opts.center && n.id === opts.center) node.center = true;
        byId[n.id] = node; return node;
      });
      // directed edges -> unordered pairs with direction flags (one spring per pair)
      var pm = {}; pairs = [];
      data.edges.forEach(function (e) {
        var s = byId[e.source], t = byId[e.target]; if (!s || !t) return;
        var key = s.id < t.id ? s.id + '\n' + t.id : t.id + '\n' + s.id;
        var p = pm[key]; if (!p) { p = pm[key] = { a: s.id < t.id ? s : t, b: s.id < t.id ? t : s, ab: false, ba: false }; pairs.push(p); }
        if (p.a === s) p.ab = true; else p.ba = true;
      });
      nodes.forEach(function (n) { n.deg = 0; }); pairs.forEach(function (p) { p.a.deg++; p.b.deg++; });
      visCache = null; alpha = 1;
      if (!prev || !Object.keys(prev).length) fit();
      start();
      if (opts.onLoad) opts.onLoad({ nodes: nodes.length, edges: data.edges.length, groups: groups, visible: visibleNodes().length });
    }

    function isVisible(n) {
      if (n.type === 'tag' && !S.tags) return false;
      if (!S.orphans && n.deg === 0 && n.type !== 'tag') return false;
      if (qTerms.length && !matches(qTerms, n)) return false;
      return true;
    }
    function visibleNodes() { if (!visCache) { visCache = nodes.filter(isVisible); visCache.forEach(function (n) { n.vis = true; }); nodes.forEach(function (n) { if (visCache.indexOf(n) < 0) n.vis = false; }); } return visCache; }
    function colorOf(n) {
      if (n.type === 'tag') return theme().muted;
      for (var i = 0; i < groupRules.length; i++) if (matches(groupRules[i].terms, n)) return groupRules[i].color;
      return PALETTE[n.group % PALETTE.length];
    }

    // ---- simulation: grid-bucketed repulsion, springs, centre gravity ----
    function tick() {
      var vis = visibleNodes(); var n = vis.length; if (!n) return;
      var i, j, a, b, dx, dy, d2, d, f;
      var repel = (mini ? 1200 : 2600) * S.repel;
      var linkLen = (mini ? 60 : 55 + Math.sqrt(n) * 2.2) * S.linkDistance;
      var spring = 0.018 * S.link;
      var gravity = (mini ? 0.03 : 0.0035 + 0.02 / Math.sqrt(n)) * S.center;
      var cell = Math.max(60, linkLen * 1.2), grid = {}, key, range = cell * cell * 4;
      for (i = 0; i < n; i++) { a = vis[i]; key = Math.floor(a.x / cell) + ',' + Math.floor(a.y / cell); (grid[key] = grid[key] || []).push(a); }
      for (i = 0; i < n; i++) {
        a = vis[i]; var gx = Math.floor(a.x / cell), gy = Math.floor(a.y / cell);
        for (var ox = -1; ox <= 1; ox++) for (var oy = -1; oy <= 1; oy++) {
          var bucket = grid[(gx + ox) + ',' + (gy + oy)]; if (!bucket) continue;
          for (j = 0; j < bucket.length; j++) {
            b = bucket[j]; if (b === a) continue;
            dx = a.x - b.x; dy = a.y - b.y; d2 = dx * dx + dy * dy + 0.05; if (d2 > range) continue;
            f = repel / d2 * alpha; d = Math.sqrt(d2); a.vx += dx / d * f; a.vy += dy / d * f;
          }
        }
      }
      for (i = 0; i < pairs.length; i++) {
        var p = pairs[i]; if (!p.a.vis || !p.b.vis) continue;
        dx = p.b.x - p.a.x; dy = p.b.y - p.a.y; d = Math.sqrt(dx * dx + dy * dy) + 0.01;
        // hubs get a little more room
        var want = linkLen * (1 + Math.min(1.5, (Math.sqrt(p.a.deg) + Math.sqrt(p.b.deg)) * 0.08));
        f = (d - want) * spring * alpha; dx = dx / d * f; dy = dy / d * f;
        p.a.vx += dx; p.a.vy += dy; p.b.vx -= dx; p.b.vy -= dy;
      }
      for (i = 0; i < n; i++) {
        a = vis[i];
        if (a.center) { a.vx -= a.x * 0.12; a.vy -= a.y * 0.12; } else { a.vx -= a.x * gravity * alpha; a.vy -= a.y * gravity * alpha; }
        if ((drag && drag.node === a) || a.fixed) { a.vx = a.vy = 0; continue; }
        a.vx *= 0.55; a.vy *= 0.55; a.x += a.vx; a.y += a.vy;
      }
      alpha = Math.max(0.015, alpha * (S.animate ? 0.988 : 0.9));
    }
    function start() { if (!running) { running = true; loop(); } }
    function loop() {
      if (!running) return;
      tick(); draw();
      if (alpha <= 0.0151 && !drag) { running = false; return; }
      raf = requestAnimationFrame(loop);
    }
    function reheat(a) { alpha = Math.max(alpha, a || 0.3); start(); }

    // ---- drawing ----
    function toScreen(x, y) { return [W / 2 + (x + view.x) * view.k, H / 2 + (y + view.y) * view.k]; }
    function toWorld(sx, sy) { return [(sx - W / 2) / view.k - view.x, (sy - H / 2) / view.k - view.y]; }
    function fit() {
      var vis = visibleNodes(); if (!vis.length) return;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      vis.forEach(function (n) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); });
      var k = Math.min(2.5, 0.9 * Math.min(W / Math.max(60, maxX - minX + 100), H / Math.max(60, maxY - minY + 100)));
      view = { k: k, x: -(minX + maxX) / 2, y: -(minY + maxY) / 2 };
    }
    function arrow(ax, ay, bx, by, r, color) {
      var dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy) || 1; var ux = dx / d, uy = dy / d;
      var tipX = bx - ux * (r + 1), tipY = by - uy * (r + 1), size = 4 + 2 * Math.min(1, view.k);
      ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - ux * size - uy * size * 0.55, tipY - uy * size + ux * size * 0.55);
      ctx.lineTo(tipX - ux * size + uy * size * 0.55, tipY - uy * size - ux * size * 0.55); ctx.closePath(); ctx.fill();
    }
    function draw() {
      var t = theme(); ctx.clearRect(0, 0, W, H);
      var focus = hover || pinned, neighbours = null;
      if (focus) { neighbours = {}; neighbours[focus.id] = true; pairs.forEach(function (p) { if (p.a === focus) neighbours[p.b.id] = true; if (p.b === focus) neighbours[p.a.id] = true; }); }
      // hairline links like Obsidian: thin, light, a little bolder when zoomed in
      var lw = Math.max(0.3, S.lineWidth * Math.min(1.1, 0.35 + view.k * 0.3));
      var sizeK = S.nodeSize * Math.pow(view.k, 0.6);
      // edges
      pairs.forEach(function (p) {
        if (!p.a.vis || !p.b.vis) return;
        var A = toScreen(p.a.x, p.a.y), B = toScreen(p.b.x, p.b.y);
        var hot = focus && (p.a === focus || p.b === focus);
        ctx.strokeStyle = hot ? t.accent : t.line; ctx.globalAlpha = focus ? (hot ? 0.95 : 0.08) : 0.45; ctx.lineWidth = hot ? lw * 1.8 : lw;
        ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke();
        if (S.arrows && view.k > 0.45) {
          var col = hot ? t.accent : t.line;
          if (p.ab) arrow(A[0], A[1], B[0], B[1], p.b.r0 * sizeK, col);
          if (p.ba) arrow(B[0], B[1], A[0], A[1], p.a.r0 * sizeK, col);
        }
      });
      // nodes. Labels fade in with zoom (Obsidian's "text fade threshold"):
      // none at fit-to-screen zoom, all when zoomed in about 2x.
      var labelAlpha = Math.max(0, Math.min(1, (view.k - 1.0 * S.textFade) / (0.8 * S.textFade)));
      if (mini) labelAlpha = Math.max(0, Math.min(1, (view.k - 0.6) / 0.6));
      var vis = visibleNodes(); var labels = [];
      vis.forEach(function (n) {
        var p = toScreen(n.x, n.y), r = n.r0 * sizeK;
        if (p[0] < -r || p[1] < -r || p[0] > W + r || p[1] > H + r) return;
        var dim = neighbours && !neighbours[n.id];
        ctx.globalAlpha = dim ? 0.18 : 1;
        ctx.fillStyle = colorOf(n);
        ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.fill();
        if (n.center || n === focus) { ctx.strokeStyle = t.fg; ctx.lineWidth = 2; ctx.globalAlpha = 1; ctx.stroke(); }
        if (n.fixed) { ctx.strokeStyle = t.muted; ctx.lineWidth = 1; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.arc(p[0], p[1], r + 3, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
        var priority = n === focus || (neighbours && neighbours[n.id]) || (mini && n.center);
        if (priority) labels.push({ n: n, p: p, r: r, a: 1, priority: true });
        else if (labelAlpha > 0.02 && !dim) labels.push({ n: n, p: p, r: r, a: labelAlpha, priority: false });
      });
      // labels last so they sit above circles; priority first, then hubs; a label
      // that would overlap one already placed is skipped, so it never gets crowded
      labels.sort(function (x, y) { return (y.priority - x.priority) || (y.n.deg - x.n.deg); });
      var placed = [];
      labels.forEach(function (l) {
        var label = l.n.title.length > 42 ? l.n.title.slice(0, 40) + '…' : l.n.title;
        var fs = mini ? 11 : Math.max(10, Math.min(14, 10 * Math.pow(view.k, 0.3)));
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

    // ---- interaction ----
    function nodeAt(sx, sy) {
      var best = null, bd = 14 * 14, sizeK = S.nodeSize * Math.pow(view.k, 0.6);
      visibleNodes().forEach(function (n) { var p = toScreen(n.x, n.y); var dx = p[0] - sx, dy = p[1] - sy, d2 = dx * dx + dy * dy, rr = Math.max(9, n.r0 * sizeK + 3); if (d2 < rr * rr && d2 < bd) { bd = d2; best = n; } });
      return best;
    }
    function pos(ev) { var r = canvas.getBoundingClientRect(); var p = ev.touches ? ev.touches[0] : ev; return [p.clientX - r.left, p.clientY - r.top]; }
    function open(n, ev) { if (!n.url) { api.set({ query: 'tag:' + n.id }); if (opts.onQuery) opts.onQuery('tag:' + n.id); return; } if (opts.onNavigate) opts.onNavigate(n, ev); else if (ev && (ev.ctrlKey || ev.metaKey)) window.open(n.url, '_blank'); else location.href = n.url; }
    canvas.addEventListener('mousemove', function (ev) {
      var p = pos(ev);
      if (drag) {
        drag.moved = drag.moved || Math.hypot(p[0] - drag.x, p[1] - drag.y) > 3;
        if (drag.node) { var w = toWorld(p[0], p[1]); drag.node.x = w[0]; drag.node.y = w[1]; reheat(0.12); }
        else { view.x += (p[0] - drag.px) / view.k; view.y += (p[1] - drag.py) / view.k; drag.px = p[0]; drag.py = p[1]; draw(); }
        return;
      }
      var h = nodeAt(p[0], p[1]);
      if (h !== hover) { hover = h; canvas.style.cursor = h ? 'pointer' : 'grab'; draw(); if (opts.onHover) opts.onHover(h); }
    });
    canvas.addEventListener('mousedown', function (ev) { if (ev.button !== 0) return; var p = pos(ev); var n = nodeAt(p[0], p[1]); drag = { node: n, x: p[0], y: p[1], px: p[0], py: p[1], moved: false, t: Date.now() }; canvas.style.cursor = 'grabbing'; });
    window.addEventListener('mouseup', function (ev) {
      if (!drag) return;
      var d = drag; drag = null; canvas.style.cursor = hover ? 'pointer' : 'grab';
      if (d.node) {
        if (!d.moved && Date.now() - d.t < 600) open(d.node, ev);
        else if (d.moved) { d.node.fixed = true; }   // dropped nodes stay where you put them (double-click releases)
      } else if (!d.moved) { pinned = null; draw(); }
      start();
    });
    canvas.addEventListener('dblclick', function (ev) { var p = pos(ev); var n = nodeAt(p[0], p[1]); if (n) { n.fixed = false; reheat(0.2); } else { fit(); draw(); } });
    canvas.addEventListener('contextmenu', function (ev) { var p = pos(ev); var n = nodeAt(p[0], p[1]); if (n) { ev.preventDefault(); pinned = pinned === n ? null : n; draw(); } });
    canvas.addEventListener('mouseleave', function () { if (hover) { hover = null; draw(); } });
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
    canvas.addEventListener('touchend', function () { pinch = null; if (drag && drag.node && !drag.moved && Date.now() - drag.t < 500) open(drag.node); drag = null; start(); });

    if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas); else window.addEventListener('resize', resize);
    resize();

    var api = {
      load: load,
      reload: function (url) { if (url) opts.url = url; return fetch(opts.url).then(function (r) { return r.json(); }).then(load); },
      // change any settings; physics/filters react live
      set: function (patch) {
        var needFilter = false, needTags = false, needFit = false;
        Object.keys(patch).forEach(function (k) {
          if (S[k] === patch[k] && k !== 'groups') return;
          S[k] = patch[k];
          if (k === 'query') { qTerms = parseQuery(S.query); needFilter = true; }
          if (k === 'groups') compileGroups();
          if (k === 'orphans') needFilter = true;
          if (k === 'tags') { needFilter = true; needTags = true; }
          if (k === 'depth') needFit = true;
        });
        if (needTags && raw && !raw.nodes.some(function (n) { return n.type === 'tag'; }) && S.tags && opts.url) { api.reload(opts.url + (opts.url.indexOf('?') >= 0 ? '&' : '?') + 'tags=1'); return; }
        if (needFilter) { visCache = null; reheat(0.25); } else { reheat(0.12); }
        if (needFit) { fit(); }
        draw();
      },
      settings: function () { return Object.assign({}, S); },
      zoom: function (f) { view.k = Math.max(0.08, Math.min(8, view.k * f)); draw(); },
      fit: function () { fit(); draw(); },
      focus: function (id) { var n = byId[id]; if (!n) return; pinned = n; view.x = -n.x; view.y = -n.y; view.k = Math.max(view.k, 1.4); draw(); },
      release: function () { nodes.forEach(function (n) { n.fixed = false; }); reheat(0.4); },
      redraw: draw, reheat: reheat,
      groups: function () { return groups; },
      state: function () { return { nodes: nodes.length, visible: visibleNodes().length, edges: pairs.length, alpha: alpha, running: running, view: view, pinned: pinned && pinned.id }; }
    };
    if (opts.url) api.reload();
    return api;
  }

  // ---- pure helpers shared with public/explore.js (no DOM, unit-testable) ----

  // Colour for a node under a colour mode ('folder' | 'lang' | 'status').
  // Custom query-matched group rules (compiled { terms, color } list) always
  // win, whatever the mode. `ctx.langs` is a sorted list of lang codes for a
  // stable per-lang palette assignment.
  function colorFor(node, mode, rules, ctx) {
    ctx = ctx || {};
    if (node.type === 'tag') return ctx.muted || '#888';
    rules = rules || [];
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].terms && matches(rules[i].terms, node)) return rules[i].color;
    }
    if (mode === 'lang') {
      var langs = ctx.langs || [];
      var idx = langs.indexOf(node.lang || '');
      if (idx < 0) idx = langs.length;
      return PALETTE[idx % PALETTE.length];
    }
    if (mode === 'status') {
      var s = String(node.status || '').toLowerCase();
      if (/^(ready|agreed|accepted)$/.test(s)) return '#2fbf71';
      if (/^(draft|in-progress|in progress)$/.test(s)) return '#f2b134';
      if (!s) return '#d5d8dc';
      return '#9aa0a6';
    }
    if (mode === 'updated') {
      var bucket = recencyBucket(node.updated, ctx.now);
      return ['#2fbf71', '#4c8dff', '#f2b134', '#9aa0a6'][bucket];
    }
    return PALETTE[(node.group || 0) % PALETTE.length];
  }

  // Recency bucket for colorBy 'updated': 0 = this week, 1 = this month,
  // 2 = this year, 3 = older than a year (or unknown).
  function recencyBucket(updatedMs, nowMs) {
    if (!updatedMs) return 3;
    var now = typeof nowMs === 'number' ? nowMs : Date.now();
    var days = (now - updatedMs) / 86400000;
    if (days <= 7) return 0;
    if (days <= 31) return 1;
    if (days <= 365) return 2;
    return 3;
  }

  // Bubble radius for a collapsed section: grows with sqrt(note count), never
  // smaller than 18px, and gently follows zoom but stays within a sane range.
  function bubbleRadius(count, k) {
    k = typeof k === 'number' && !isNaN(k) ? k : 1;
    var base = Math.max(18, Math.sqrt(Math.max(0, count || 0)) * 9);
    var scale = Math.max(0.6, Math.min(1.6, k));
    return base * scale;
  }

  // Cross-section link "band" width: log scale so one busy pair of sections
  // doesn't dwarf everything else; capped around 10px for the busiest pair.
  function bandWidth(count, maxCount) {
    if (!count || !maxCount) return 0;
    var v = Math.log(1 + count) / Math.log(1 + maxCount);
    return Math.max(1, v * 10);
  }

  // 'cluster' layout: a home position on a circle for a group, ordered by
  // index among all groups. Every group sits on the SAME circle (spread
  // purely by angle) so collapsed section bubbles land evenly spaced
  // instead of piling up; the circle grows with the number of groups and
  // with the total note count so a bigger vault gets more room overall.
  function clusterHome(index, total, totalNodes) {
    var angle = total ? (index / total) * Math.PI * 2 : 0;
    var radius = 55 * Math.sqrt(Math.max(1, total || 1)) + Math.sqrt(Math.max(0, totalNodes || 0)) * 12;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  }

  // 'radial' layout: BFS distance rings from a centre node. `ids` is every
  // node id that should be placed; `edgePairs` is [idA, idB] pairs to walk.
  // Children are given an angular slice under their parent's own slice so
  // the tree reads outward cleanly. Nodes unreachable from the centre still
  // get a slot in an outer ring instead of being dropped.
  function radialPositions(ids, edgePairs, centerId, ringGap) {
    ringGap = ringGap || 110;
    var idSet = {}; (ids || []).forEach(function (id) { idSet[id] = true; });
    var adj = {}; (ids || []).forEach(function (id) { adj[id] = []; });
    (edgePairs || []).forEach(function (pr) {
      var a = pr[0], b = pr[1];
      if (!idSet[a] || !idSet[b] || a === b) return;
      adj[a].push(b); adj[b].push(a);
    });
    var dist = {}, parent = {}, order = [];
    if (idSet[centerId]) {
      dist[centerId] = 0; order.push(centerId);
      var queue = [centerId], qi = 0;
      while (qi < queue.length) {
        var cur = queue[qi++];
        adj[cur].forEach(function (nb) {
          if (dist[nb] === undefined) { dist[nb] = dist[cur] + 1; parent[nb] = cur; order.push(nb); queue.push(nb); }
        });
      }
    }
    var maxRing = 0;
    order.forEach(function (id) { if (dist[id] > maxRing) maxRing = dist[id]; });
    (ids || []).forEach(function (id) { if (dist[id] === undefined) { dist[id] = maxRing + 1; order.push(id); } });

    var children = {}; order.forEach(function (id) { children[id] = []; });
    order.forEach(function (id) { if (parent[id] !== undefined) children[parent[id]].push(id); });

    var angleStart = {}, angleSpan = {};
    if (idSet[centerId]) { angleStart[centerId] = 0; angleSpan[centerId] = Math.PI * 2; }
    order.forEach(function (id) {
      var kids = children[id]; if (!kids || !kids.length) return;
      var start = angleStart[id] !== undefined ? angleStart[id] : 0;
      var span = angleSpan[id] !== undefined ? angleSpan[id] : Math.PI * 2;
      var per = span / kids.length;
      kids.forEach(function (kid, i) { angleStart[kid] = start + i * per; angleSpan[kid] = per; });
    });
    // nodes never reached from the centre (disconnected component): spread
    // them evenly around the outer ring so they still get a stable slot.
    var unreached = (ids || []).filter(function (id) { return id !== centerId && parent[id] === undefined && angleStart[id] === undefined; });
    var per2 = unreached.length ? Math.PI * 2 / unreached.length : 0;
    unreached.forEach(function (id, i) { angleStart[id] = i * per2; angleSpan[id] = per2; });

    var pos = {};
    (ids || []).forEach(function (id) {
      if (id === centerId) { pos[id] = { x: 0, y: 0, ring: 0 }; return; }
      var r = dist[id] * ringGap;
      var a = (angleStart[id] || 0) + (angleSpan[id] || 0) / 2;
      pos[id] = { x: r * Math.cos(a), y: r * Math.sin(a), ring: dist[id] };
    });
    return pos;
  }

  // Shortest undirected path between two node ids, BFS over `edgePairs`
  // ([idA, idB] tuples). Returns an array of ids from `fromId` to `toId`
  // inclusive, or null when there is no path (or either id is unknown).
  function shortestPath(ids, edgePairs, fromId, toId) {
    var idSet = {}; (ids || []).forEach(function (id) { idSet[id] = true; });
    if (!idSet[fromId] || !idSet[toId]) return null;
    if (fromId === toId) return [fromId];
    var adj = {}; (ids || []).forEach(function (id) { adj[id] = []; });
    (edgePairs || []).forEach(function (pr) {
      var a = pr[0], b = pr[1]; if (!idSet[a] || !idSet[b]) return;
      adj[a].push(b); adj[b].push(a);
    });
    var parent = {}; parent[fromId] = null;
    var queue = [fromId], qi = 0, found = false;
    while (qi < queue.length) {
      var cur = queue[qi++];
      if (cur === toId) { found = true; break; }
      adj[cur].forEach(function (nb) { if (!(nb in parent)) { parent[nb] = cur; queue.push(nb); } });
    }
    if (!found && !(toId in parent)) return null;
    var path = [], step = toId;
    while (step !== null && step !== undefined) { path.unshift(step); step = parent[step]; }
    return path[0] === fromId ? path : null;
  }

  // Directed reach from one node: everything that links into it, transitively
  // ('up' — its upstream, the notes that depend on it), everything it links
  // out to ('down' — what it builds on), or both. `edges` are [from, to]
  // tuples as the server sends them (source links to target). Returns
  // { depth: {id: hops}, edges: [[from, to]] } where depth[fromId] === 0 and
  // the edges are the ones walked; null when fromId is unknown. maxDepth of
  // null/0 means unlimited.
  function reach(ids, edges, fromId, dir, maxDepth) {
    var idSet = {}; (ids || []).forEach(function (id) { idSet[id] = true; });
    if (!idSet[fromId]) return null;
    var outs = {}, ins = {}; (ids || []).forEach(function (id) { outs[id] = []; ins[id] = []; });
    (edges || []).forEach(function (e) { var a = e[0], b = e[1]; if (!idSet[a] || !idSet[b] || a === b) return; outs[a].push(b); ins[b].push(a); });
    var limit = maxDepth > 0 ? maxDepth : Infinity;
    var depth = {}; depth[fromId] = 0; var walked = [], seenEdge = {};
    function walk(next, forward) {
      var queue = [fromId], qi = 0, local = {}; local[fromId] = 0;
      while (qi < queue.length) {
        var cur = queue[qi++], d = local[cur]; if (d >= limit) continue;
        next[cur].forEach(function (nb) {
          var key = forward ? cur + '|' + nb : nb + '|' + cur;
          if (!seenEdge[key]) { seenEdge[key] = true; walked.push(forward ? [cur, nb] : [nb, cur]); }
          if (nb in local) return; local[nb] = d + 1; queue.push(nb);
          if (!(nb in depth) || depth[nb] > d + 1) depth[nb] = d + 1;
        });
      }
    }
    if (dir === 'down' || dir === 'both') walk(outs, true);
    if (dir === 'up' || dir === 'both') walk(ins, false);
    return { depth: depth, edges: walked };
  }

  window.WEBSIDIAN_GRAPH = window.MD2HTML_GRAPH = {
    mount: mount, PALETTE: PALETTE, DEFAULTS: DEFAULTS, parseQuery: parseQuery, matches: matches,
    colorFor: colorFor, recencyBucket: recencyBucket, bubbleRadius: bubbleRadius, bandWidth: bandWidth,
    clusterHome: clusterHome, radialPositions: radialPositions, shortestPath: shortestPath, reach: reach
  };
})();
