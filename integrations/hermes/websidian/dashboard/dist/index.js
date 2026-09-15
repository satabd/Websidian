/**
 * Websidian — Hermes dashboard tab.
 *
 * Shows the Websidian sites served by the plugin backend (/api/plugins/websidian/) in an iframe that fills the
 * content area. Plain IIFE, no build step; React and components come from window.__HERMES_PLUGIN_SDK__.
 *
 * Deep links (the dashboard router matches the tab path exactly, so state lives in the query string):
 *   /websidian?site=<slug>&note=<Folder/Note, no .md>[&edit=1][&q=<encoded iframe query>]
 * The dashboard URL follows navigation inside the iframe (history.replaceState).
 *
 * The iframe is NOT sandboxed: Websidian's pages and editor fetch their own JSON API with the dashboard session
 * cookie, which needs the same origin. What protects the dashboard from vault content is Websidian's untrusted
 * mode (no raw HTML in notes, strict CSP with per-request nonces), which the backend always enables by default.
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK || !window.__HERMES_PLUGINS__) return;

  var React = SDK.React;
  var h = React.createElement;
  var C = SDK.components || {};
  var useState = SDK.hooks.useState;
  var useEffect = SDK.hooks.useEffect;
  var useRef = SDK.hooks.useRef;
  var useCallback = SDK.hooks.useCallback;

  var MOUNT = "/api/plugins/websidian/w";
  var API = "/api/plugins/websidian";

  function basePath() {
    var raw = String(window.__HERMES_BASE_PATH__ || "").trim();
    if (!raw || raw === "/") return "";
    return ("/" + raw.replace(/^\/+|\/+$/g, "")).replace(/\/{2,}/g, "/");
  }

  function encodeNote(note) {
    return String(note || "").split("/").filter(function (s) { return s !== ""; })
      .map(encodeURIComponent).join("/");
  }

  function readQuery() {
    var p = new URLSearchParams(window.location.search);
    return { site: p.get("site") || "", note: p.get("note") || "", edit: p.get("edit") === "1", q: p.get("q") || "" };
  }

  // Websidian URL (same origin, through the proxy) for a dashboard state.
  function frameUrl(state) {
    var url = basePath() + MOUNT + "/" + encodeURIComponent(state.site) + "/";
    if (state.edit) url += "_edit/";
    url += encodeNote(state.note);
    if (state.q) url += (state.q.charAt(0) === "?" ? "" : "?") + state.q;
    return url;
  }

  // Dashboard state for a Websidian location inside the iframe, or null when it is not a site page.
  function stateFromFrame(loc) {
    var prefix = basePath() + MOUNT + "/";
    if (!loc || loc.pathname.indexOf(prefix) !== 0) return null;
    var parts = loc.pathname.slice(prefix.length).split("/");
    var site = decodeURIComponent(parts.shift() || "");
    if (!site || site.charAt(0) === "_") return null;
    var edit = false;
    if (parts[0] === "_edit") { edit = true; parts.shift(); }
    var note = parts.map(function (s) {
      try { return decodeURIComponent(s); } catch (e) { return s; }
    }).filter(function (s) { return s !== ""; }).join("/");
    return { site: site, note: note, edit: edit, q: (loc.search || "").replace(/^\?/, "") };
  }

  function dashboardSearch(state) {
    var p = new URLSearchParams();
    if (state.site) p.set("site", state.site);
    if (state.note) p.set("note", state.note);
    if (state.edit) p.set("edit", "1");
    if (state.q) p.set("q", state.q);
    var s = p.toString();
    return s ? "?" + s : "";
  }

  function selectChange(setter) {
    return {
      onValueChange: function (v) { setter(v == null ? "" : v); },
      onChange: function (e) { setter(e && e.target ? e.target.value : e); },
    };
  }

  function LinkButton(props) {
    return h("a", {
      href: props.href, target: props.target, rel: props.target ? "noopener" : undefined,
      className: "websidian-link-button", title: props.title,
    }, props.children);
  }

  function StatusPanel(props) {
    var st = props.status;
    var err = props.error;
    return h("div", { className: "websidian-status" },
      h("h2", { className: "websidian-status-title" }, err ? "Cannot reach the Websidian backend" : "Websidian is not running"),
      err ? h("p", null, String(err)) : null,
      st && st.error ? h("p", null, st.error) : null,
      st ? h("dl", { className: "websidian-facts" },
        h("dt", null, "Port"), h("dd", null, "127.0.0.1:" + st.port),
        h("dt", null, "App"), h("dd", null, st.app_dir + (st.app_dir_present ? "" : " (missing)")),
        h("dt", null, "Node"), h("dd", null, st.node + " " + (st.node_version || "")),
        h("dt", null, "Sites"), h("dd", null, (st.sites || []).map(function (s) { return s.slug + " → " + s.root; }).join(", ") || "none configured"),
      ) : null,
      st && st.log_tail && st.log_tail.length ? h("pre", { className: "websidian-log" }, st.log_tail.join("")) : null,
      h("div", { className: "websidian-actions" },
        C.Button ? h(C.Button, { size: "sm", onClick: props.onRetry }, "Retry") :
          h("button", { type: "button", onClick: props.onRetry }, "Retry")),
    );
  }

  function WebsidianPage() {
    var initial = readQuery();
    var _s = useState(null), status = _s[0], setStatus = _s[1];
    var _e = useState(null), error = _e[0], setError = _e[1];
    var _v = useState(initial), view = _v[0], setView = _v[1];
    var _src = useState(null), src = _src[0], setSrc = _src[1];
    var _h = useState(600), height = _h[0], setHeight = _h[1];
    var _n = useState(0), navCount = _n[0], setNavCount = _n[1];
    var frameRef = useRef(null);
    var wrapRef = useRef(null);

    var load = useCallback(function () {
      SDK.fetchJSON(API + "/status").then(function (st) {
        setStatus(st); setError(null);
      }).catch(function (e) { setError(e && e.message ? e.message : String(e)); });
    }, []);

    useEffect(function () { load(); }, [load]);

    // Poll while the server is down (the backend restarts it).
    useEffect(function () {
      if (!error && status && status.running) return undefined;
      var t = setInterval(load, 4000);
      return function () { clearInterval(t); };
    }, [status, error, load]);

    // Pick a site once the status arrives, and point the iframe at the deep-linked note.
    var sites = (status && status.sites) || [];
    useEffect(function () {
      if (!sites.length || src) return;
      var site = sites.some(function (s) { return s.slug === view.site; }) ? view.site : sites[0].slug;
      var next = { site: site, note: site === view.site ? view.note : "", edit: site === view.site && view.edit, q: site === view.site ? view.q : "" };
      setView(next);
      setSrc(frameUrl(next));
    }, [sites.length, src]);

    // Fill the viewport below the toolbar.
    useEffect(function () {
      function fit() {
        var el = wrapRef.current;
        if (!el) return;
        var top = el.getBoundingClientRect().top;
        setHeight(Math.max(320, Math.floor(window.innerHeight - top - 16)));
      }
      fit();
      window.addEventListener("resize", fit);
      var t = setTimeout(fit, 150);
      return function () { window.removeEventListener("resize", fit); clearTimeout(t); };
    }, [status && status.running, src]);

    function onFrameLoad() {
      var frame = frameRef.current;
      var loc = null;
      try { loc = frame && frame.contentWindow ? frame.contentWindow.location : null; } catch (e) { loc = null; }
      var next = stateFromFrame(loc);
      if (!next) return;
      setView(next);
      var url = window.location.pathname + dashboardSearch(next) + window.location.hash;
      if (url !== window.location.pathname + window.location.search + window.location.hash) {
        try { window.history.replaceState(window.history.state, "", url); } catch (e) { /* ignore */ }
      }
    }

    // Navigate the iframe (the counter forces a reload even when the URL equals the last src).
    function go(next) {
      setView(next);
      setSrc(frameUrl(next));
      setNavCount(function (n) { return n + 1; });
    }

    function chooseSite(slug) {
      if (slug) go({ site: slug, note: "", edit: false, q: "" });
    }

    function toggleEdit() {
      go({ site: view.site, note: view.note, edit: !view.edit, q: "" });
    }

    if (error || (status && !status.running)) {
      return h("div", { className: "websidian-page" }, h(StatusPanel, { status: status, error: error, onRetry: load }));
    }
    if (!status || !src) {
      return h("div", { className: "websidian-page websidian-loading" }, "Loading Websidian…");
    }

    var current = frameUrl(view);
    var siteBase = basePath() + MOUNT + "/" + encodeURIComponent(view.site) + "/";
    var graph = siteBase + "_graph" + (view.note && !view.edit && view.note.charAt(0) !== "_" ? "?focus=" + encodeURIComponent(view.note + ".md") : "");
    var siteMeta = sites.filter(function (s) { return s.slug === view.site; })[0] || {};
    var mismatch = status.base_path && status.base_path !== basePath() + MOUNT;

    var picker = sites.length > 1
      ? (C.Select && C.SelectOption
        ? h(C.Select, Object.assign({ value: view.site, className: "h-8" }, selectChange(chooseSite)),
            sites.map(function (s) { return h(C.SelectOption, { key: s.slug, value: s.slug }, s.title || s.slug); }))
        : h("select", { value: view.site, className: "websidian-select", onChange: function (e) { chooseSite(e.target.value); } },
            sites.map(function (s) { return h("option", { key: s.slug, value: s.slug }, s.title || s.slug); })))
      : h("span", { className: "websidian-site-title" }, siteMeta.title || view.site);

    return h("div", { className: "websidian-page" },
      h("div", { className: "websidian-toolbar" },
        picker,
        C.Badge && siteMeta.untrusted === false ? h(C.Badge, { variant: "destructive" }, "trusted mode") : null,
        h("span", { className: "websidian-spacer" }),
        siteMeta.edit ? h("button", { type: "button", className: "websidian-link-button", onClick: toggleEdit },
          view.edit ? "Reading view" : "Edit") : null,
        h(LinkButton, { href: graph, target: "_blank", title: "Open the graph view in a new tab" }, "Graph"),
        h(LinkButton, { href: current, target: "_blank", title: "Open this page without the dashboard" }, "Open full page"),
      ),
      mismatch ? h("div", { className: "websidian-warning" },
        "dashboard.public_base gives the path prefix " + JSON.stringify(status.base_path) + " but this dashboard is served under " +
        JSON.stringify(basePath() + MOUNT) + ". Fix plugins.entries.websidian.settings.dashboard.public_base.") : null,
      h("div", { ref: wrapRef, className: "websidian-frame-wrap", style: { height: height + "px" } },
        h("iframe", {
          ref: frameRef,
          key: src + "#" + navCount,
          src: src,
          title: "Websidian",
          className: "websidian-frame",
          referrerPolicy: "same-origin",
          onLoad: onFrameLoad,
        })),
    );
  }

  window.__HERMES_PLUGINS__.register("websidian", WebsidianPage);
})();
