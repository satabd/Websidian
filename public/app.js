(function () {
  'use strict';
  var root = document.documentElement;
  function whenReady(check, fn, tries) { if (check()) fn(); else if (tries > 0) setTimeout(function () { whenReady(check, fn, tries - 1); }, 100); }

  // ---- embed and shell mode: keep the mode on internal links ----
  // The server writes the mode onto the links it renders itself (sidebar, breadcrumbs, backlinks…);
  // this covers the rest: links inside the note body and anything built in the browser, such as
  // search results. A delegated handler in the capture phase sees those too.
  var W = window.WEBSIDIAN || window.MD2HTML;
  var MODE = W && W.embed ? 'embed' : W && W.shell ? 'shell' : '';
  // In shell mode the host's theme travels with the mode, so one click does not drop back to the
  // browser's own theme; the server writes the same pair onto the links it renders.
  var THEME = MODE === 'shell' ? (/[?&]theme=(dark|light)\b/.exec(location.search) || ['', ''])[1] : '';
  var CHROME = MODE === 'shell' ? (/[?&]chrome=(tree|none)\b/.exec(location.search) || ['', ''])[1] : '';
  // flow=1: the host sizes the frame to the page and scrolls it with its own page (the Hermes dashboard tab),
  // so nothing is sized to the frame's viewport and the page reports its height (websidian:height).
  var FLOW = MODE === 'shell' && /[?&]flow=1\b/.test(location.search);
  if (FLOW) root.classList.add('shell-flow');
  function withMode(h) {
    if (!MODE || !h || h.indexOf(W.base) !== 0) return h;
    if (/\.(png|jpe?g|gif|svg|webp|pdf)(\?|#|$)/i.test(h)) return h;
    var i = h.indexOf('#'); var hash = i >= 0 ? h.slice(i) : ''; var p = i >= 0 ? h.slice(0, i) : h;
    // The server writes the mode onto its own links, but not flow: that one is added here.
    if (p.indexOf(MODE + '=') >= 0) return FLOW && !/[?&]flow=/.test(p) ? p + '&flow=1' + hash : h;
    return p + (p.indexOf('?') >= 0 ? '&' : '?') + MODE + '=1' + (THEME ? '&theme=' + THEME : '') + (CHROME ? '&chrome=' + CHROME : '') + (FLOW ? '&flow=1' : '') + hash;
  }
  if (MODE) {
    document.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
      if (!a || a.target === '_blank') return;
      var h = a.getAttribute('href'); var next = withMode(h);
      if (next !== h) a.setAttribute('href', next);
    }, true);
    document.querySelectorAll('a[href]').forEach(function (a) { a.setAttribute('href', withMode(a.getAttribute('href'))); });
  }
  if (W && W.embed) {
    // Tell a parent page our height so an iframe can size itself. Both names are
    // sent: "md2html:height" is the older one and pages still listen for it.
    var post = function () {
      if (window.parent === window) return;
      var h = document.documentElement.scrollHeight;
      window.parent.postMessage({ type: 'websidian:height', height: h, rel: W.rel }, '*');
      window.parent.postMessage({ type: 'md2html:height', height: h, rel: W.rel }, '*');
    };
    window.addEventListener('load', post); new MutationObserver(post).observe(document.body, { childList: true, subtree: true }); setTimeout(post, 1500);
  }
  if (W && W.shell) {
    // The host draws the title bar and owns the theme. Tell it which note is open so it can follow
    // along, and let it push a theme down without a reload.
    if (window.parent !== window && FLOW) {
      var lastH = 0;
      var postHeight = function () {
        var h = Math.ceil(document.documentElement.getBoundingClientRect().height);
        if (h === lastH) return;
        lastH = h;
        window.parent.postMessage({ type: 'websidian:height', height: h, rel: W.rel }, '*');
      };
      if (window.ResizeObserver) new ResizeObserver(postHeight).observe(document.documentElement);
      window.addEventListener('load', postHeight);
      postHeight();
    }
    if (window.parent !== window) {
      window.addEventListener('load', function () {
        var h1 = document.querySelector('.note h1');
        window.parent.postMessage({ type: 'websidian:navigate', site: W.site, rel: W.rel, title: h1 ? h1.textContent : document.title, url: location.pathname + location.search }, '*');
      });
    }
    window.addEventListener('message', function (ev) {
      var d = ev.data;
      if (d && d.type === 'websidian:palette' && ev.source === window.parent) { applyPalette(d.palette); return; }
      // In flow mode the frame is as tall as the page, so the host says how much of it a reader sees at once:
      // that bounds the note tree, which would otherwise make the page as long as the whole vault.
      if (d && d.type === 'websidian:viewport' && ev.source === window.parent && FLOW) {
        var vh = Math.round(Number(d.height));
        if (vh >= 200 && vh <= 10000) root.style.setProperty('--flow-view-h', vh + 'px');
        return;
      }
      if (!d || d.type !== 'websidian:theme') return;
      if (d.theme === 'dark' || d.theme === 'light') { root.setAttribute('data-theme', d.theme); renderMermaid(true); }
    });
  }
  // A host palette ({bg, bg2, fg, muted, line, accent, accentBg, codeBg, mark}) over the theme's colours, so a
  // reading pane looks like the application around it. Only #rrggbb values are taken: nothing the parent
  // sends can become anything but a colour.
  function applyPalette(p) {
    if (!p || typeof p !== 'object') return;
    var names = { bg: '--bg', bg2: '--bg2', fg: '--fg', muted: '--muted', line: '--line', accent: '--accent', accentBg: '--accent-bg', codeBg: '--code-bg', mark: '--mark' };
    Object.keys(names).forEach(function (k) {
      var v = p[k];
      if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) root.style.setProperty(names[k], v);
      else root.style.removeProperty(names[k]);
    });
  }

  // ---- theme toggle (remembered per browser; in shell mode the host owns it) ----
  try { var saved = W && W.shell ? '' : (localStorage.getItem('websidian-theme') || localStorage.getItem('md2html-theme')); if (saved) root.setAttribute('data-theme', saved); } catch (e) {}
  var themeBtn = document.getElementById('themeBtn');
  if (themeBtn) themeBtn.addEventListener('click', function () {
    var dark = root.getAttribute('data-theme') === 'dark' || (!root.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    var next = dark ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('websidian-theme', next); } catch (e) {}
    renderMermaid(true);
  });

  // ---- print ----
  var printBtn = document.getElementById('printBtn');
  if (printBtn) printBtn.addEventListener('click', function () { window.print(); });

  // ---- math (KaTeX, only loaded when the page has math) ----
  whenReady(function () { return !document.querySelector('.math') || !!window.katex; }, function () {
    if (!window.katex) return;
    document.querySelectorAll('.math').forEach(function (el) {
      try { window.katex.render(el.textContent, el, { displayMode: el.classList.contains('math-block'), throwOnError: false }); } catch (e) {}
    });
  }, 50);

  // ---- bases: view tabs ----
  document.querySelectorAll('.base').forEach(function (base) {
    base.querySelectorAll('.base-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        base.querySelectorAll('.base-tab').forEach(function (t) { t.classList.toggle('is-active', t === tab); });
        base.querySelectorAll('.base-view').forEach(function (v) { v.hidden = v.getAttribute('data-view') !== tab.getAttribute('data-tab'); });
      });
    });
  });

  // ---- graph views (needs graph.js, loaded on pages that have a graph canvas) ----
  whenReady(function () { return !document.querySelector('canvas[data-graph]') || !!window.WEBSIDIAN_GRAPH; }, function () {
    if (!window.WEBSIDIAN_GRAPH) return;
    document.querySelectorAll('canvas.local-graph-canvas').forEach(function (c) {
      window.WEBSIDIAN_GRAPH.mount(c, { url: c.getAttribute('data-graph'), center: c.getAttribute('data-center'), mini: true });
    });
    var big = document.getElementById('graphCanvas');
    if (big) {
      var legend = document.getElementById('graphLegend'), stats = document.getElementById('graphStats');
      var g = window.WEBSIDIAN_GRAPH.mount(big, {
        url: big.getAttribute('data-graph'), center: big.getAttribute('data-focus') || null,
        onLoad: function (info) {
          if (stats) stats.textContent = info.nodes + ' notes · ' + info.edges + ' links';
          if (legend) legend.innerHTML = info.groups.filter(function (gr) { return gr.key !== '#'; }).map(function (gr) {
            return '<label><input type="checkbox" checked data-group="' + gr.id + '"><span class="swatch" style="background:' + window.WEBSIDIAN_GRAPH.PALETTE[gr.id % window.WEBSIDIAN_GRAPH.PALETTE.length] + '"></span>' + gr.title.replace(/[&<>]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]; }) + '</label>';
          }).join('');
          legend.querySelectorAll('input').forEach(function (cb) { cb.addEventListener('change', function () { g.setGroup(Number(cb.getAttribute('data-group')), cb.checked); cb.parentElement.classList.toggle('is-off', !cb.checked); }); });
        }
      });
      var q = document.getElementById('graphSearch'), tags = document.getElementById('graphTags'), labels = document.getElementById('graphLabels'), fit = document.getElementById('graphFit');
      if (q) q.addEventListener('input', function () { g.setQuery(q.value); });
      if (tags) tags.addEventListener('change', function () { g.setTags(tags.checked); if (tags.checked && big.getAttribute('data-graph').indexOf('tags=') < 0) { big.setAttribute('data-graph', big.getAttribute('data-graph') + '?tags=1'); fetch(big.getAttribute('data-graph')).then(function (r) { return r.json(); }).then(g.load); } });
      if (labels) labels.addEventListener('change', function () { g.setLabels(labels.value); });
      if (fit) fit.addEventListener('click', function () { g.fit(); });
      window.WEBSIDIAN_GRAPH.instance = g;
    }
  }, 60);

  // ---- mobile sidebar ----
  var sidebar = document.getElementById('sidebar'), menuBtn = document.getElementById('menuBtn');
  if (menuBtn) menuBtn.addEventListener('click', function () { sidebar.classList.toggle('is-open'); });
  document.addEventListener('click', function (e) { if (sidebar && sidebar.classList.contains('is-open') && !sidebar.contains(e.target) && e.target !== menuBtn) sidebar.classList.remove('is-open'); });
  var cur = sidebar && sidebar.querySelector('.is-current');
  // Centre the current note in the tree by scrolling the tree only: scrollIntoView would scroll the page too,
  // and a note would open halfway down whenever it sits low in the tree.
  if (cur) sidebar.scrollTop += cur.getBoundingClientRect().top - sidebar.getBoundingClientRect().top - (sidebar.clientHeight - cur.offsetHeight) / 2;

  // ---- mermaid diagrams ----
  var mermaidSources = null;
  function renderMermaid(rerender) {
    if (!window.mermaid) return;
    var blocks = document.querySelectorAll('pre.mermaid');
    if (!blocks.length) return;
    if (!mermaidSources) mermaidSources = Array.prototype.map.call(blocks, function (b) { return b.textContent; });
    if (rerender) blocks.forEach(function (b, i) { b.textContent = mermaidSources[i]; b.removeAttribute('data-processed'); });
    var dark = root.getAttribute('data-theme') === 'dark' || (!root.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    // Untrusted sites (<html data-untrusted>): no HTML labels, no click callbacks.
    var strict = root.hasAttribute('data-untrusted');
    window.mermaid.initialize(strict
      ? { startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false } }
      : { startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'loose', flowchart: { htmlLabels: true } });
    window.mermaid.run({ nodes: blocks }).catch(function (err) { console.warn('mermaid', err); });
  }
  whenReady(function () { return !!window.mermaid; }, function () { renderMermaid(false); }, 50);
  whenReady(function () { return !!window.hljs; }, function () { document.querySelectorAll('pre code.hljs').forEach(function (el) { try { window.hljs.highlightElement(el); } catch (e) {} }); }, 50);

  // ---- table of contents scroll spy ----
  var tocLinks = document.querySelectorAll('.toc a');
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var map = {};
    tocLinks.forEach(function (a) { map[decodeURIComponent(a.getAttribute('href').slice(1))] = a; });
    var visible = new Set();
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) visible.add(en.target.id); else visible.delete(en.target.id); });
      var first = null;
      document.querySelectorAll('.note h2[id], .note h3[id]').forEach(function (h) { if (!first && visible.has(h.id)) first = h.id; });
      if (first) { tocLinks.forEach(function (a) { a.classList.remove('is-active'); }); if (map[first]) map[first].classList.add('is-active'); }
    }, { rootMargin: '-60px 0px -70% 0px' });
    document.querySelectorAll('.note h2[id], .note h3[id]').forEach(function (h) { io.observe(h); });
  }

  // ---- search ----
  var input = document.getElementById('searchInput'), results = document.getElementById('searchResults');
  if (input) {
    var G0 = window.WEBSIDIAN || window.MD2HTML;
    var timer = null, active = -1, site = G0 && G0.site;
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function close() { results.hidden = true; results.innerHTML = ''; active = -1; }
    function run() {
      var q = input.value.trim();
      if (q.length < 2) return close();
      fetch(G0.base + '_search?q=' + encodeURIComponent(q)).then(function (r) { return r.json(); }).then(function (hits) {
        if (input.value.trim() !== q) return;
        results.hidden = false; active = -1;
        results.innerHTML = hits.length ? hits.map(function (h) {
          return '<a href="' + h.url + '"' + (h.lang ? ' lang="' + esc(h.lang) + '"' : '') + '><span class="r-title">' + esc(h.title) + '</span><span class="r-folder">' + esc(h.folder) + '</span><span class="r-snip">' + h.snippet + '</span></a>';
        }).join('') : '<div class="r-empty">No results for “' + esc(q) + '”</div>';
      }).catch(close);
    }
    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(run, 150); });
    input.addEventListener('focus', function () { if (results.innerHTML) results.hidden = false; });
    input.addEventListener('keydown', function (e) {
      var items = results.querySelectorAll('a');
      if (e.key === 'Escape') { close(); input.blur(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!items.length) return; e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach(function (a, i) { a.classList.toggle('is-active', i === active); });
        items[active].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && active >= 0 && items[active]) { location.href = items[active].href; }
    });
    document.addEventListener('click', function (e) { if (!e.target.closest('#search')) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === '/' && document.activeElement !== input && !/input|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); input.focus(); } });
  }
})();
