// Excalidraw viewer for the site and the editor preview.
//
// Every `.excalidraw-view` box (see src/excalidraw.js) holds the plugin's
// exported image as a fallback. When one scrolls into view this script fetches
// the drawing as JSON from `_drawing/<path>`, loads Excalidraw (and React) from
// /_vendor once, and mounts the real component in view mode. Nothing is
// fetched on pages without a drawing; a page with three drawings loads the
// library once.
(function () {
  'use strict';
  var W = window.WEBSIDIAN || window.MD2HTML || window.WEBSIDIAN_EDIT || window.MD2HTML_EDIT || {};
  var inEditor = !!(window.WEBSIDIAN_EDIT || window.MD2HTML_EDIT);
  var root = document.documentElement;

  function assetsBase() {
    if (W.assets != null) return W.assets;
    var l = document.querySelector('link[href*="/_static/app.css"]');
    return l ? l.getAttribute('href').split('/_static/')[0] : '';
  }
  function isDark() { var t = root.getAttribute('data-theme'); return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; }
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script'); s.src = src; s.async = false;
      s.onload = resolve; s.onerror = function () { reject(new Error('could not load ' + src)); };
      document.head.appendChild(s);
    });
  }
  var lib = null;
  function loadLib() {
    if (lib) return lib;
    var base = assetsBase();
    window.EXCALIDRAW_ASSET_PATH = base + '/_vendor/excalidraw/';   // fonts and locale chunks
    lib = (window.React ? Promise.resolve() : loadScript(base + '/_vendor/react/react.production.min.js'))
      .then(function () { return window.ReactDOM ? null : loadScript(base + '/_vendor/react-dom/react-dom.production.min.js'); })
      .then(function () { return window.ExcalidrawLib ? null : loadScript(base + '/_vendor/excalidraw/excalidraw.production.min.js'); });
    return lib;
  }

  function getJson(url) { return fetch(url, { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }); }
  function asDataURL(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then(function (blob) { return new Promise(function (resolve, reject) { var fr = new FileReader(); fr.onload = function () { resolve(fr.result); }; fr.onerror = reject; fr.readAsDataURL(blob); }); });
  }

  // Bounding box of the drawing, for the height of an inline box.
  function bounds(elements) {
    var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    elements.forEach(function (e) {
      if (!isFinite(e.x) || !isFinite(e.y)) return;
      x1 = Math.min(x1, e.x); y1 = Math.min(y1, e.y);
      x2 = Math.max(x2, e.x + (e.width || 0)); y2 = Math.max(y2, e.y + (e.height || 0));
    });
    return x1 < x2 && y1 < y2 ? { x1: x1, y1: y1, w: x2 - x1, h: y2 - y1 } : null;
  }
  // Zoom and scroll that show the whole drawing in a w×h box, computed up front
  // so the first frame is already right (Excalidraw's own scrollToContent only
  // centres, and it runs after the fonts have loaded).
  function initialView(elements, w, h) {
    var b = bounds(elements); if (!b || !w || !h) return {};
    var zoom = Math.min((w * 0.9) / b.w, (h * 0.9) / b.h, 1.5);
    zoom = Math.max(0.1, Math.min(zoom, 30));
    return { zoom: { value: zoom }, scrollX: -b.x1 + (w / zoom - b.w) / 2, scrollY: -b.y1 + (h / zoom - b.h) / 2 };
  }

  function mountOne(el) {
    if (el.__excalidraw) return;
    el.__excalidraw = true;
    var src = el.getAttribute('data-drawing');
    var isPage = el.classList.contains('excalidraw-page');
    Promise.all([loadLib(), getJson(src)]).then(function (r) {
      var scene = r[1];
      // Images stored in the vault: the browser fetches them and hands Excalidraw data URLs.
      var files = scene.files || {};
      var ids = Object.keys(scene.images || {});
      return Promise.all(ids.map(function (id) {
        var img = scene.images[id];
        return asDataURL(img.url).then(function (dataURL) { files[id] = { id: id, mimeType: img.mimeType || 'image/png', dataURL: dataURL, created: Date.now() }; }).catch(function () {});
      })).then(function () { scene.files = files; return scene; });
    }).then(function (scene) { render(el, scene, isPage); })
      .catch(function (err) {
        el.__excalidraw = false; el.classList.add('is-failed');
        var ph = el.querySelector('.excalidraw-missing'); if (ph) ph.textContent = '✎ ' + (el.getAttribute('data-title') || 'Drawing') + ' — could not be loaded';
        if (window.console) console.warn('excalidraw', err);
      });
  }

  function render(el, scene, isPage) {
    var elements = scene.elements || [];
    if (!isPage && !el.style.height) {
      var b = bounds(elements), w = el.clientWidth || 640;
      var h = b ? Math.round(w * b.h / b.w) + 48 : 420;
      el.style.height = Math.max(240, Math.min(h, Math.round(window.innerHeight * 0.8))) + 'px';
    }
    var fallback = el.querySelector('img.excalidraw'); if (fallback) fallback.hidden = true;
    var ph = el.querySelector('.excalidraw-missing'); if (ph) ph.remove();

    var host = document.createElement('div'); host.className = 'excalidraw-host'; host.dir = 'ltr'; el.appendChild(host);
    var tools = document.createElement('div'); tools.className = 'excalidraw-tools';
    var fitBtn = document.createElement('button'); fitBtn.type = 'button'; fitBtn.title = 'Fit the drawing to the view'; fitBtn.textContent = '⤢'; tools.appendChild(fitBtn);
    var pageUrl = el.getAttribute('data-page');
    if (pageUrl && !isPage) {
      var open = document.createElement('a'); open.href = pageUrl + (W.embed ? '?embed=1' : ''); open.textContent = 'Open ↗'; open.title = 'Open the drawing on its own page';
      if (inEditor) open.target = '_blank';
      tools.appendChild(open);
    }
    el.appendChild(tools);

    var api = null;
    function fit() { if (api) { try { api.scrollToContent(elements, { fitToViewport: true, viewportZoomFactor: 0.9, animate: false }); } catch (e) {} } }
    fitBtn.addEventListener('click', fit);
    var view = initialView(elements, host.clientWidth, host.clientHeight);

    var reactRoot = window.ReactDOM.createRoot(host);
    function props() {
      return {
        initialData: { elements: elements, appState: Object.assign({}, scene.appState || {}, view), files: scene.files || {} },
        viewModeEnabled: true, zenModeEnabled: true, gridModeEnabled: !!scene.grid,
        theme: isDark() ? 'dark' : 'light',
        detectScroll: false, handleKeyboardGlobally: false, autoFocus: false,
        UIOptions: { canvasActions: { changeViewBackgroundColor: false, clearCanvas: false, export: false, loadScene: false, saveToActiveFile: false, saveAsImage: false, toggleTheme: false } },
        excalidrawAPI: function (a) { api = a; el.__api = a; },
      };
    }
    function draw() { reactRoot.render(window.React.createElement(window.ExcalidrawLib.Excalidraw, props())); }
    draw();

    // Follow the site's theme toggle.
    var last = isDark();
    var sync = function () { var d = isDark(); if (d !== last) { last = d; draw(); } };
    new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', sync); } catch (e) {}

    // Inline boxes stay inert until clicked, so the wheel scrolls the page, not the drawing.
    if (!isPage) {
      var shield = document.createElement('div'); shield.className = 'excalidraw-shield'; shield.setAttribute('data-hint', 'Click to pan and zoom');
      el.appendChild(shield);
      shield.addEventListener('click', function () { el.classList.add('is-active'); });
      document.addEventListener('click', function (e) { if (!el.contains(e.target)) el.classList.remove('is-active'); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') el.classList.remove('is-active'); });
    }
    el.classList.add('is-live');
  }

  var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (en) { if (en.isIntersecting) { io.unobserve(en.target); mountOne(en.target); } });
  }, { rootMargin: '200px' }) : null;

  function mount(scope) {
    (scope || document).querySelectorAll('.excalidraw-view').forEach(function (el) {
      if (el.__excalidraw || el.__observed) return;
      el.__observed = true;
      var r = el.getBoundingClientRect();
      if (!io || (r.bottom > -200 && r.top < window.innerHeight + 200)) mountOne(el); else io.observe(el);
    });
  }

  window.websidianExcalidraw = { mount: mount };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { mount(); }); else mount();
})();
