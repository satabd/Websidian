/* Full-screen graph page: wires the floating panel to the renderer and
 * remembers settings per browser (localStorage, per site). */
(function () {
  'use strict';
  var G = window.WEBSIDIAN_GRAPH || window.MD2HTML_GRAPH; if (!G) return;
  var canvas = document.getElementById('graphCanvas'); if (!canvas) return;
  var site = canvas.getAttribute('data-site'), focus = canvas.getAttribute('data-focus') || null;
  var KEY = 'md2html-graph-' + site;
  var saved = {}; try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
  var S = Object.assign({}, G.DEFAULTS, saved);
  delete S.query; // the search box always starts empty
  var $ = function (id) { return document.getElementById(id); };
  var stats = $('graphStats'), hoverBox = $('graphHover'), legend = $('gpLegend'), groupsBox = $('gpGroups');
  var localMode = !!focus, g;
  var baseUrl = (window.WEBSIDIAN || window.MD2HTML).base + '_graph.json';
  function cur() { return g ? g.settings() : S; }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(cur())); } catch (e) {} }
  function urlFor() { var q = []; if (localMode && focus) { q.push('rel=' + encodeURIComponent(focus)); q.push('depth=' + cur().depth); } if (cur().tags) q.push('tags=1'); return baseUrl + (q.length ? '?' + q.join('&') : ''); }

  g = G.mount(canvas, {
    url: null, center: focus, settings: S,
    onLoad: function (info) {
      if (stats) stats.textContent = info.visible + (info.visible !== info.nodes ? ' of ' + info.nodes : '') + ' notes · ' + info.edges + ' links';
      renderLegend(info.groups);
    },
    onHover: function (n) { if (hoverBox) hoverBox.textContent = n ? (n.type === 'tag' ? n.id : n.title + (n.folder ? '  ·  ' + n.folder : '') + '  ·  ' + n.links + ' links') : ''; },
    onQuery: function (q) { $('gpQuery').value = q; }
  });
  g.reload(urlFor());

  // ---- legend (folder colours) + custom colour groups ----
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function renderLegend(groups) {
    if (!legend) return;
    legend.innerHTML = groups.filter(function (gr) { return gr.key !== '#'; }).map(function (gr) {
      return '<span class="gp-chip"><i style="background:' + G.PALETTE[gr.id % G.PALETTE.length] + '"></i>' + esc(gr.title) + '</span>';
    }).join('');
  }
  function renderGroups() {
    var list = cur().groups || [];
    groupsBox.innerHTML = list.map(function (gr, i) {
      return '<div class="gp-group"><input type="color" value="' + esc(gr.color) + '" data-i="' + i + '"><code title="' + esc(gr.query) + '">' + esc(gr.query) + '</code><button type="button" data-del="' + i + '" title="Remove">×</button></div>';
    }).join('') || '<div class="muted gp-empty">No custom groups. Default colour = top folder.</div>';
    groupsBox.querySelectorAll('input[type=color]').forEach(function (inp) { inp.addEventListener('input', function () { var l = cur().groups.slice(); l[Number(inp.getAttribute('data-i'))] = Object.assign({}, l[Number(inp.getAttribute('data-i'))], { color: inp.value }); g.set({ groups: l }); save(); }); });
    groupsBox.querySelectorAll('button[data-del]').forEach(function (b) { b.addEventListener('click', function () { var l = cur().groups.slice(); l.splice(Number(b.getAttribute('data-del')), 1); g.set({ groups: l }); save(); renderGroups(); }); });
  }
  renderGroups();
  $('gpGroupAdd').addEventListener('click', function () {
    var q = $('gpGroupQuery').value.trim(); if (!q) return;
    g.set({ groups: (cur().groups || []).concat([{ query: q, color: $('gpGroupColor').value }]) }); save(); renderGroups(); $('gpGroupQuery').value = '';
  });
  $('gpGroupQuery').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('gpGroupAdd').click(); });

  // ---- bind controls ----
  var TOGGLES = { gpTags: 'tags', gpOrphans: 'orphans', gpArrows: 'arrows', gpAnimate: 'animate' };
  var SLIDERS = { gpTextFade: 'textFade', gpNodeSize: 'nodeSize', gpLineWidth: 'lineWidth', gpCenter: 'center', gpRepel: 'repel', gpLink: 'link', gpLinkDistance: 'linkDistance' };
  function bindToggle(id, key, after) { var el = $(id); if (!el) return; el.checked = !!S[key]; el.addEventListener('change', function () { var p = {}; p[key] = el.checked; g.set(p); save(); if (after) after(); }); }
  function bindSlider(id, key, after) { var el = $(id); if (!el) return; el.value = S[key]; el.nextElementSibling.textContent = S[key]; el.addEventListener('input', function () { var v = Number(el.value); el.nextElementSibling.textContent = v; var p = {}; p[key] = v; g.set(p); save(); if (after) after(); }); }
  var qEl = $('gpQuery'), qTimer;
  qEl.addEventListener('input', function () { clearTimeout(qTimer); qTimer = setTimeout(function () { g.set({ query: qEl.value }); }, 120); });
  Object.keys(TOGGLES).forEach(function (id) { bindToggle(id, TOGGLES[id], id === 'gpTags' ? function () { g.reload(urlFor()); } : null); });
  Object.keys(SLIDERS).forEach(function (id) { bindSlider(id, SLIDERS[id]); });
  if ($('gpLocal')) {
    $('gpLocal').checked = true;
    $('gpLocal').addEventListener('change', function () { localMode = $('gpLocal').checked; $('gpDepth').disabled = !localMode; g.reload(urlFor()).then(function () { g.fit(); }); });
    bindSlider('gpDepth', 'depth', function () { g.reload(urlFor()).then(function () { g.fit(); }); });
  }
  $('gpReset').addEventListener('click', function () {
    g.set(Object.assign({}, G.DEFAULTS, { depth: cur().depth, query: qEl.value })); save();
    Object.keys(TOGGLES).forEach(function (id) { var el = $(id); if (el) el.checked = !!G.DEFAULTS[TOGGLES[id]]; });
    Object.keys(SLIDERS).forEach(function (id) { var el = $(id); if (el) { el.value = G.DEFAULTS[SLIDERS[id]]; el.nextElementSibling.textContent = G.DEFAULTS[SLIDERS[id]]; } });
    renderGroups(); g.reload(urlFor());
  });
  $('gzIn').addEventListener('click', function () { g.zoom(1.3); });
  $('gzOut').addEventListener('click', function () { g.zoom(1 / 1.3); });
  $('gzFit').addEventListener('click', function () { g.fit(); });
  $('gzRelease').addEventListener('click', function () { g.release(); });

  var panel = $('graphPanel'), toggleBtn = $('gpToggle');
  var panelHidden = false; try { panelHidden = localStorage.getItem(KEY + '-panel') === 'hidden'; } catch (e) {}
  if (panelHidden || window.innerWidth < 700) panel.classList.add('is-hidden');
  toggleBtn.addEventListener('click', function () { panel.classList.toggle('is-hidden'); try { localStorage.setItem(KEY + '-panel', panel.classList.contains('is-hidden') ? 'hidden' : 'shown'); } catch (e) {} });
  document.addEventListener('keydown', function (e) {
    if (/input|textarea|select/i.test(document.activeElement.tagName)) { if (e.key === 'Escape') document.activeElement.blur(); return; }
    if (e.key === '/') { e.preventDefault(); panel.classList.remove('is-hidden'); qEl.focus(); }
    else if (e.key === 'f') g.fit();
    else if (e.key === '+' || e.key === '=') g.zoom(1.3);
    else if (e.key === '-') g.zoom(1 / 1.3);
    else if (e.key === 'Escape') panel.classList.add('is-hidden');
  });

  // theme toggle (same behaviour as app.js, which is not loaded on this page). In shell mode the host owns
  // the theme: there is no button, the saved choice is ignored, and the host can push a change down.
  var root = document.documentElement;
  var hosted = !!(window.WEBSIDIAN && window.WEBSIDIAN.shell);
  if (!hosted) { try { var t = localStorage.getItem('md2html-theme'); if (t) root.setAttribute('data-theme', t); } catch (e) {} }
  var themeBtn = $('themeBtn');
  if (themeBtn) themeBtn.addEventListener('click', function () {
    var dark = root.getAttribute('data-theme') === 'dark' || (!root.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    root.setAttribute('data-theme', dark ? 'light' : 'dark'); try { localStorage.setItem('md2html-theme', dark ? 'light' : 'dark'); } catch (e) {}
    g.redraw();
  });
  if (hosted) window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (d && d.type === 'websidian:theme' && (d.theme === 'dark' || d.theme === 'light')) { root.setAttribute('data-theme', d.theme); g.redraw(); }
  });
  window.WEBSIDIAN_GRAPH.instance = g;
})();
