/**
 * Websidian — Hermes dashboard tab.
 *
 * The tab draws its own chrome in the dashboard's style: a search box that searches every vault, and the views
 * Overview (vaults, memory, recent notes), Memory (Hermes's MEMORY.md / USER.md entry by entry), Skills (every
 * SKILL.md by category), Browse (a vault's note tree) and Graph. Websidian itself only does the reading: one
 * iframe, in shell mode (?shell=1), which is a reading pane (&chrome=none) or the note tree (&chrome=tree).
 * The model comes from GET /api/plugins/websidian/overview (dashboard/wsd_model.py), search from each site's
 * own /_search. Plain IIFE, no build step; React comes from window.__HERMES_PLUGIN_SDK__.
 *
 * Deep links (the dashboard router matches the tab path exactly, so state lives in the query string):
 *   /websidian?site=<slug>&note=<Folder/Note, no .md>[&edit=1][&q=<encoded iframe query>][&view=<view>]
 * A note or query whose plain form would need percent-escaping travels as base64url in note64/q64 instead,
 * so the link also survives the login redirect (see noteQuery below and note_query in sites.py). Both forms
 * are accepted; older note=/q= links keep working. The address bar follows the reader (history.replaceState).
 *
 * Nothing a vault holds is ever markup in the dashboard: titles, excerpts, memory entries and search snippets
 * are React text (only <mark> from a snippet is rebuilt, as an element with text in it). The iframe is not
 * sandboxed, because Websidian's pages and editor fetch their own JSON with the dashboard session cookie; what
 * protects the dashboard from vault content is Websidian's untrusted mode (no raw HTML, strict CSP with
 * per-request nonces), which the backend enables by default. Frames only ever point at the model's own paths.
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK || !window.__HERMES_PLUGINS__) return;

  var React = SDK.React;
  var h = React.createElement;
  var useState = SDK.hooks.useState;
  var useEffect = SDK.hooks.useEffect;
  var useRef = SDK.hooks.useRef;
  var useCallback = SDK.hooks.useCallback;

  var MOUNT = "/api/plugins/websidian/w";
  var API = "/api/plugins/websidian";
  var VIEWS = ["overview", "memory", "skills", "browse", "graph"];
  var RECENT_ON_OVERVIEW = 8;
  var REFRESH_MS = 60000;

  function basePath() {
    var raw = String(window.__HERMES_BASE_PATH__ || "").trim();
    if (!raw || raw === "/") return "";
    return ("/" + raw.replace(/^\/+|\/+$/g, "")).replace(/\/{2,}/g, "/");
  }

  function encodeNote(note) {
    return String(note || "").split("/").filter(function (s) { return s !== ""; })
      .map(encodeURIComponent).join("/");
  }

  function noteText(note) {
    return String(note || "").split("/").filter(function (s) { return s !== ""; }).join("/");
  }

  // --- base64url (no padding), the decode-stable form of a deep-link value -----------------------------
  // A deep link opened without a session goes through /login?next=<the whole path?query, percent-encoded>,
  // and Hermes decodes that one time more than it encoded it, so percent-escapes inside a value are lost
  // ("Plan%20%232" comes back as "Plan #2" and the query falls apart on the "#"). Values that need no
  // escaping are left readable; the rest go as base64url ([A-Za-z0-9_-], which decoding never changes) in
  // note64/q64. sites.py (note_query / search_query / note_from_query) builds and parses the same links.
  var STABLE_QUERY = /^[A-Za-z0-9\-._~!*'()=,:/]*$/;

  function b64encode(text) {
    var bytes = new TextEncoder().encode(String(text || ""));
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64decode(value) {
    var s = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    try {
      var bin = atob(s);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    } catch (e) {
      return "";
    }
  }

  function noteQuery(note) {
    var raw = noteText(note);
    var plain = encodeNote(raw);
    return plain === raw ? "note=" + plain : "note64=" + b64encode(raw);
  }

  function searchQuery(q) {
    q = String(q || "").replace(/^\?/, "");
    return STABLE_QUERY.test(q) ? "q=" + q : "q64=" + b64encode(q);
  }

  function readQuery() {
    var p = new URLSearchParams(window.location.search);
    var view = p.get("view") || "";
    return {
      view: VIEWS.indexOf(view) >= 0 ? view : "",
      site: p.get("site") || "",
      note: p.has("note64") ? b64decode(p.get("note64")) : (p.get("note") || ""),
      edit: p.get("edit") === "1",
      q: p.has("q64") ? b64decode(p.get("q64")) : (p.get("q") || ""),
    };
  }

  function dashboardSearch(state) {
    var parts = [];
    if (state.view && state.view !== "overview" && !state.note) parts.push("view=" + state.view);
    if (state.view === "browse" && state.note) parts.push("view=browse");
    if (state.site) parts.push("site=" + encodeURIComponent(state.site));
    if (state.note) parts.push(noteQuery(state.note));
    if (state.edit) parts.push("edit=1");
    if (state.q) parts.push(searchQuery(state.q));
    return parts.length ? "?" + parts.join("&") : "";
  }

  // A same-origin path, or "". Frames and links only ever point back at the dashboard.
  function safePath(url) {
    var s = String(url || "");
    return s.charAt(0) === "/" && s.charAt(1) !== "/" && !/[\s\\]/.test(s) ? s : "";
  }

  function siteBase(slug) {
    return basePath() + MOUNT + "/" + encodeURIComponent(slug) + "/";
  }

  // Websidian's URL for a note. `chrome`: "none" (a reading pane), "tree" (with the note tree), "" (plain).
  function noteUrl(slug, note, opts) {
    opts = opts || {};
    var url = siteBase(slug) + (opts.edit ? "_edit/" : "") + encodeNote(String(note || "").replace(/\.md$/i, ""));
    var query = String(opts.q || "").replace(/^\?/, "");
    if (!opts.edit) query = withShell(query, opts.theme, opts.chrome, opts.flow);
    return url + (query ? "?" + query : "");
  }

  // flow: the page is as tall as its content and scrolls with the dashboard page (not inside a box).
  function withShell(query, theme, chrome, flow) {
    var q = stripShell(query);
    return (q ? q + "&" : "") + "shell=1" + (theme ? "&theme=" + theme : "") + (chrome ? "&chrome=" + chrome : "") + (flow ? "&flow=1" : "");
  }

  function stripShell(query) {
    return String(query || "").replace(/^\?/, "").split("&").filter(function (kv) {
      return kv && !/^(shell|theme|chrome|embed|flow)=/.test(kv);
    }).join("&");
  }

  // {site, note, edit, q, page} for a Websidian location inside the iframe, or null when it is not a site page.
  // `page` is "note", "graph", "explore" or "other" (another underscore page).
  function stateFromFrame(loc) {
    var prefix = basePath() + MOUNT + "/";
    if (!loc || loc.pathname.indexOf(prefix) !== 0) return null;
    var parts = loc.pathname.slice(prefix.length).split("/");
    var site = decodeURIComponent(parts.shift() || "");
    if (!site || site.charAt(0) === "_") return null;
    var edit = false;
    if (parts[0] === "_edit") { edit = true; parts.shift(); }
    var page = "note";
    if (parts[0] && parts[0].charAt(0) === "_") page = parts[0] === "_graph" ? "graph" : parts[0] === "_explore" ? "explore" : "other";
    var note = page !== "note" ? "" : parts.map(function (s) {
      try { return decodeURIComponent(s); } catch (e) { return s; }
    }).filter(function (s) { return s !== ""; }).join("/");
    return { site: site, note: note, edit: edit, q: stripShell(loc.search), page: page };
  }

  // --- time ----------------------------------------------------------------------------------------------
  function relativeTime(ms, now) {
    if (!ms) return "";
    now = now || Date.now();
    var diff = Math.min(0, (ms - now) / 1000); // ahead of this browser's clock: "just now"
    var abs = Math.abs(diff);
    var rtf;
    try { rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }); } catch (e) { return new Date(ms).toLocaleString(); }
    if (abs < 45) return rtf.format(0, "second");
    var units = [["minute", 60], ["hour", 3600], ["day", 86400], ["week", 604800], ["month", 2629800], ["year", 31557600]];
    var unit = "minute", size = 60;
    units.forEach(function (u) { if (abs >= u[1] * 0.9) { unit = u[0]; size = u[1]; } });
    return rtf.format(Math.round(diff / size), unit);
  }

  function fullTime(ms) {
    try { return new Date(ms).toLocaleString(); } catch (e) { return ""; }
  }

  function count(n, one, many) {
    return Number(n || 0).toLocaleString() + " " + (n === 1 ? one : many);
  }

  // --- colours ---------------------------------------------------------------------------------------------
  // Any CSS colour (hex, oklch, color-mix, var()) as [r, g, b, a], read back from a 1×1 canvas.
  var probeCtx = null;
  function rgbOf(css) {
    if (!css) return null;
    try {
      if (!probeCtx) {
        var c = document.createElement("canvas");
        c.width = c.height = 1;
        probeCtx = c.getContext("2d", { willReadFrequently: true });
      }
      probeCtx.clearRect(0, 0, 1, 1);
      probeCtx.fillStyle = "#010203";
      probeCtx.fillStyle = css;
      if (probeCtx.fillStyle === "#010203" && css.replace(/\s/g, "") !== "#010203") return null;
      probeCtx.fillRect(0, 0, 1, 1);
      var d = probeCtx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    } catch (e) {
      return null;
    }
  }

  function hex(rgb) {
    return "#" + rgb.slice(0, 3).map(function (v) { return ("0" + Math.round(v).toString(16)).slice(-2); }).join("");
  }

  function mix(a, b, t) { // t of a over b
    return [0, 1, 2].map(function (i) { return a[i] * t + b[i] * (1 - t); });
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function isDark(rgb) {
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] < 128;
  }

  // The dashboard's theme as {theme, palette}: the palette is handed to the reading pane so the note sits
  // in the same colours as the page around it (Websidian takes #rrggbb values only).
  function hostLook() {
    var bg = rgbOf(cssVar("--background-base")) || rgbOf(getComputedStyle(document.body).backgroundColor);
    var fg = rgbOf(cssVar("--midground-base")) || rgbOf(getComputedStyle(document.body).color);
    if (!bg || bg[3] === 0) {
      return { theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light", palette: null, key: "" };
    }
    var theme = isDark(bg) ? "dark" : "light";
    if (!fg) return { theme: theme, palette: null, key: theme };
    var warm = rgbOf(cssVar("--color-warning")) || [255, 189, 56];
    var accent = mix(warm, fg, 0.55);
    if (theme === "light") accent = mix(accent, [0, 0, 0], 0.6);
    var palette = {
      bg: hex(bg), bg2: hex(mix(fg, bg, 0.05)), fg: hex(fg), muted: hex(mix(fg, bg, 0.68)),
      line: hex(mix(fg, bg, 0.16)), accent: hex(accent), accentBg: hex(mix(accent, bg, 0.14)),
      codeBg: hex(mix(fg, bg, 0.07)), mark: hex(mix(warm, bg, 0.32)),
    };
    return { theme: theme, palette: palette, key: theme + JSON.stringify(palette) };
  }

  // --- reading themes ------------------------------------------------------------------------------------
  // What notes, the tree and the graph look like, chosen per browser: the dashboard's own colours, or a theme
  // made for reading. Only the frame changes; the tab itself stays in the dashboard's theme.
  var READING_THEMES = [
    { id: "hermes", label: "Match Hermes", note: "The dashboard's colours" },
    { id: "light", label: "Light", theme: "light", palette: null, swatch: ["#ffffff", "#1f2328", "#0969da"] },
    { id: "dark", label: "Dark", theme: "dark", palette: null, swatch: ["#0d1117", "#e6edf3", "#58a6ff"] },
    { id: "paper", label: "Paper", theme: "light", palette: {
      bg: "#f8f1e3", bg2: "#efe6d2", fg: "#3b3228", muted: "#7a6b58", line: "#ddd0b8",
      accent: "#9a5b13", accentBg: "#f0dfc2", codeBg: "#efe5d0", mark: "#f3d98b" } },
    { id: "nord", label: "Nord", theme: "dark", palette: {
      bg: "#2e3440", bg2: "#3b4252", fg: "#e5e9f0", muted: "#a3adbf", line: "#4c566a",
      accent: "#88c0d0", accentBg: "#3b4c5a", codeBg: "#3b4252", mark: "#6b6440" } },
    { id: "night", label: "Night", theme: "dark", palette: {
      bg: "#000000", bg2: "#111111", fg: "#e8e8e8", muted: "#9a9a9a", line: "#2a2a2a",
      accent: "#8ab4f8", accentBg: "#14213a", codeBg: "#151515", mark: "#5a4b00" } },
  ];
  var THEME_KEY = "websidian:hermes:reading-theme";

  function savedReadingTheme() {
    var id = "";
    try { id = localStorage.getItem(THEME_KEY) || ""; } catch (e) { id = ""; }
    return READING_THEMES.some(function (t) { return t.id === id; }) ? id : "hermes";
  }

  // The look the frame gets: the host's for "hermes", otherwise the preset's.
  function readingLook(id, host) {
    var t = READING_THEMES.filter(function (x) { return x.id === id; })[0];
    if (!t || t.id === "hermes") return host;
    return { theme: t.theme, palette: t.palette, key: t.id };
  }

  function swatchOf(t, host) {
    if (t.swatch) return t.swatch;
    if (t.palette) return [t.palette.bg, t.palette.fg, t.palette.accent];
    var p = host && host.palette;
    return p ? [p.bg, p.fg, p.accent] : ["#041c1c", "#ffe6cb", "#ffcf7a"];
  }

  // --- search snippets -------------------------------------------------------------------------------------
  // "…escaped text with <mark>terms</mark>…" as [{text, marked}]: only <mark> is honoured, entities are
  // decoded, nothing else is ever markup.
  function markText(html) {
    var decode = function (s) {
      return s.replace(/&(lt|gt|quot|#39|amp);/g, function (m, e) { return { lt: "<", gt: ">", quot: '"', "#39": "'", amp: "&" }[e]; });
    };
    var out = [];
    var marked = false;
    String(html || "").split(/(<\/?mark>)/i).forEach(function (part) {
      if (/^<mark>$/i.test(part)) { marked = true; return; }
      if (/^<\/mark>$/i.test(part)) { marked = false; return; }
      if (part) out.push({ text: decode(part.replace(/<[^>]*>/g, "")), marked: marked });
    });
    return out;
  }

  // What a list calls a note: its title, or for a skill (…/<name>/SKILL.md) the skill's folder.
  function listTitle(hit) {
    var parts = String(hit.rel || "").split("/");
    if (/^SKILL(\.md)?$/i.test(parts[parts.length - 1]) && parts.length > 1) return parts[parts.length - 2];
    return hit.title || hit.rel;
  }

  // --- icons -----------------------------------------------------------------------------------------------
  var ICONS = {
    brain: "M9.5 2a2.5 2.5 0 0 1 2.5 2.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24A2.5 2.5 0 0 1 9.5 2Zm5 0A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24A2.5 2.5 0 0 0 14.5 2Z",
    user: "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
    home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z",
    folder: "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z",
    graph: "M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8.6 13.5l6.8 4M15.4 6.5l-6.8 4",
    search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3",
    refresh: "M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5",
    back: "M19 12H5M12 19l-7-7 7-7",
    external: "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
    file: "M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2ZM14 2v6h6",
    spark: "M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8",
    pencil: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z",
    book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14ZM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5",
    lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
    palette: "M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4 4h-1.8a1.8 1.8 0 0 0-1.3 3.1A1.8 1.8 0 0 1 13.6 22H12ZM7.5 11.5h.01M10.5 7.5h.01M15.5 7.5h.01M18 11.5h.01",
    check: "M20 6 9 17l-5-5",
    close: "M18 6 6 18M6 6l12 12",
    chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z",
  };
  var KIND_ICON = { memory: "brain", skills: "spark", vault: "book" };

  function Icon(props) {
    return h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", className: "wsd-icon " + (props.className || "") },
      h("path", { d: ICONS[props.name] || ICONS.file }));
  }

  // --- small parts -----------------------------------------------------------------------------------------
  function Label(props) {
    return h("div", { className: "wsd-label" }, h("span", null, props.children), props.extra || null);
  }

  function Empty(props) {
    return h("div", { className: "wsd-empty" },
      h("p", { className: "wsd-empty-title" }, props.title),
      props.text ? h("p", { className: "wsd-empty-text" }, props.text) : null);
  }

  function Meter(props) {
    var pct = props.limit ? Math.min(100, Math.round(props.value / props.limit * 100)) : 0;
    var tone = pct >= 90 ? " is-full" : pct >= 75 ? " is-high" : "";
    return h("div", { className: "wsd-meter" + tone, title: props.value.toLocaleString() + " of " + props.limit.toLocaleString() + " characters" },
      h("div", { className: "wsd-meter-bar" }, h("span", { style: { width: pct + "%" } })),
      h("span", { className: "wsd-meter-text" }, pct + "% full"));
  }

  function Time(props) {
    if (!props.ms) return null;
    return h("time", { className: props.className || "wsd-time", dateTime: new Date(props.ms).toISOString(), title: fullTime(props.ms) },
      relativeTime(props.ms));
  }

  function versionLabel(v) {
    if (!v || !v.revision) return "unknown";
    var when = String(v.installed_at || "").slice(0, 10);
    return v.revision + (when ? " (installed " + when + ")" : "");
  }

  function StatusPanel(props) {
    var st = props.status;
    var err = props.error;
    return h("div", { className: "wsd-problem" },
      h(Icon, { name: "book", className: "wsd-problem-icon" }),
      h("p", { className: "wsd-problem-title" }, err ? "Cannot reach the Websidian backend" : "Websidian is starting or not running"),
      err ? h("p", { className: "wsd-problem-hint" }, String(err)) : null,
      st && st.error ? h("p", { className: "wsd-problem-hint" }, st.error) : null,
      st ? h("dl", { className: "wsd-facts" },
        h("dt", null, "Port"), h("dd", null, "127.0.0.1:" + st.port),
        h("dt", null, "App"), h("dd", null, st.app_dir + (st.app_dir_present ? "" : " (missing)")),
        h("dt", null, "Node"), h("dd", null, st.node + " " + (st.node_version || "")),
        h("dt", null, "Runtime"), h("dd", null, versionLabel(st.app_version)),
        h("dt", null, "Plugin"), h("dd", null, versionLabel(st.plugin_version)),
        h("dt", null, "Vaults"), h("dd", null, (st.sites || []).map(function (s) { return s.slug + " → " + s.root; }).join(", ") || "none configured")
      ) : null,
      st && st.log_tail && st.log_tail.length ? h("pre", { className: "wsd-log" }, st.log_tail.join("")) : null,
      h("p", { className: "wsd-problem-hint" }, "Checking again every few seconds."),
      h("button", { type: "button", className: "wsd-button", onClick: props.onRetry }, h(Icon, { name: "refresh" }), h("span", null, "Try again")));
  }

  function NoteRow(props) {
    var n = props.note;
    var site = props.site;
    var title = n.heading && n.heading !== n.title ? n.heading : n.title;
    return h("li", null,
      h("button", { type: "button", className: "wsd-row" + (props.active ? " is-active" : ""), onClick: props.onOpen, ref: props.rowRef },
        h(Icon, { name: site ? KIND_ICON[site.kind] || "file" : "file", className: "wsd-row-icon" }),
        h("span", { className: "wsd-row-main" },
          h("span", { className: "wsd-row-title", dir: "auto" }, title),
          props.snippet ? h("span", { className: "wsd-row-excerpt", dir: "auto" }, props.snippet)
            : n.excerpt ? h("span", { className: "wsd-row-excerpt", dir: "auto" }, n.excerpt) : null),
        h("span", { className: "wsd-row-meta" },
          site && props.showSite ? h("span", { className: "wsd-chip" }, site.title) : null,
          props.meta ? h("span", { className: "wsd-row-folder" }, props.meta) : h(Time, { ms: n.mtime }))));
  }

  // ---------------------------------------------------------------------------------------------------------
  // The agent panel beside a note
  // ---------------------------------------------------------------------------------------------------------
  // Talks to Websidian's reader door, <site>/_ask/ (a site with `"agents": "readers"`): Review mode only, one
  // continuing conversation of the agent's own CLI per vault (or per note). An agent's reply is Markdown written
  // by a model that may have read a prompt-injected note, so it is never markup here: mdBlocks() turns it into
  // elements with text in them, and only http(s) links become links.
  var AGENT_KEY = "websidian:hermes:agent";
  var PANEL_KEY = "websidian:hermes:agent-panel";

  function askUrl(slug, path) { return siteBase(slug) + "_ask/" + path; }

  function askFetch(slug, path, opts) {
    opts = opts || {};
    var init = { method: opts.method || "GET", credentials: "same-origin", headers: { accept: "application/json" } };
    if (init.method !== "GET") init.headers["x-requested-with"] = "websidian-hermes-tab";
    if (opts.body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(opts.body); }
    return fetch(askUrl(slug, path), init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        if (!res.ok) { var e = new Error(j && j.error ? j.error : res.status + " " + res.statusText); e.status = res.status; throw e; }
        return j;
      });
    });
  }

  function mdInline(text, keyBase) {
    var out = [];
    var re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[\[[^\]\n]+\]\]|\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\)|\*[^*\s][^*\n]*\*)/g;
    var last = 0, m, i = 0;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      var t = m[0], k = keyBase + "-" + (i++);
      if (t.charAt(0) === "`") out.push(h("code", { key: k }, t.slice(1, -1)));
      else if (t.slice(0, 2) === "**") out.push(h("strong", { key: k }, t.slice(2, -2)));
      else if (t.slice(0, 2) === "[[") {
        var inner = t.slice(2, -2), bar = inner.indexOf("|");
        out.push(h("span", { key: k, className: "wsd-wl", title: bar >= 0 ? inner.slice(0, bar) : inner }, bar >= 0 ? inner.slice(bar + 1) : inner.split("#")[0] || inner));
      } else if (t.charAt(0) === "[") {
        var close = t.indexOf("](");
        out.push(h("a", { key: k, href: m[2], target: "_blank", rel: "noopener noreferrer" }, t.slice(1, close)));
      } else {
        var star = t.indexOf("*");
        if (star > 0) out.push(t.slice(0, star));
        out.push(h("em", { key: k }, t.slice(star + 1, -1)));
      }
      last = re.lastIndex;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  // Markdown to elements: fenced code, headings, lists, quotes, paragraphs. Enough for a chat reply.
  function mdBlocks(text) {
    var blocks = [];
    var lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    var i = 0, n = 0;
    function para(buf) {
      if (!buf.length) return;
      var parts = [];
      buf.forEach(function (l, j) { if (j) parts.push(h("br", { key: "br" + j })); parts.push.apply(parts, mdInline(l, "p" + n + "-" + j)); });
      blocks.push(h("p", { key: "b" + (n++), dir: "auto" }, parts));
    }
    var buf = [];
    while (i < lines.length) {
      var line = lines[i];
      var fence = /^\s*(```|~~~)(.*)$/.exec(line);
      if (fence) {
        para(buf); buf = [];
        var code = [];
        i++;
        while (i < lines.length && lines[i].trim().indexOf(fence[1]) !== 0) { code.push(lines[i]); i++; }
        i++;
        blocks.push(h("pre", { key: "b" + (n++) }, h("code", null, code.join("\n"))));
        continue;
      }
      var head = /^(#{1,6})\s+(.*)$/.exec(line);
      if (head) { para(buf); buf = []; blocks.push(h("p", { key: "b" + (n++), className: "wsd-md-h", dir: "auto" }, mdInline(head[2], "h" + n))); i++; continue; }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        para(buf); buf = [];
        var ordered = /^\s*\d/.test(line), items = [];
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          items.push(h("li", { key: items.length, dir: "auto" }, mdInline(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+(\[.\]\s+)?/, ""), "l" + n + "-" + items.length)));
          i++;
        }
        blocks.push(h(ordered ? "ol" : "ul", { key: "b" + (n++) }, items));
        continue;
      }
      if (/^\s*>/.test(line)) {
        para(buf); buf = [];
        var q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        blocks.push(h("blockquote", { key: "b" + (n++), dir: "auto" }, mdInline(q.join(" "), "q" + n)));
        continue;
      }
      if (!line.trim()) { para(buf); buf = []; i++; continue; }
      buf.push(line);
      i++;
    }
    para(buf);
    return blocks;
  }

  function Change(props) {
    var c = props.change;
    var _o = useState(!!props.open), open = _o[0], setOpen = _o[1];
    var _s = useState(""), state = _s[0], setState = _s[1];
    function revert() {
      setState("…");
      askFetch(props.site, "agent-turns/" + encodeURIComponent(props.turn) + "/revert", { method: "POST", body: { rel: c.rel } })
        .then(function (r) { setState(r.status === "trashed" ? "Moved to .trash" : "Restored"); if (props.onReverted) props.onReverted(c.rel); })
        .catch(function (e) { setState(e.message); });
    }
    return h("li", { className: "wsd-change" + (c.unexpected ? " is-unexpected" : "") + (c.protected ? " is-protected" : "") },
      h("div", { className: "wsd-change-row" },
        h("span", { className: "wsd-change-status" }, c.status),
        h("span", { className: "wsd-change-rel", title: c.rel }, c.rel),
        c.diff ? h("button", { type: "button", className: "wsd-link", onClick: function () { setOpen(!open); } }, open ? "Hide diff" : "Diff") : null,
        c.revertible && props.turn && !state ? h("button", { type: "button", className: "wsd-link", onClick: revert }, "Revert") : null,
        state ? h("span", { className: "wsd-muted" }, state) : null),
      c.unexpected ? h("p", { className: "wsd-change-warn" }, "⚠ Changed in Review mode" + (c.protected ? " — and it is an agent instruction file" : "")) : null,
      open && c.diff ? h("pre", { className: "wsd-diff" }, c.diff.split("\n").map(function (l, j) {
        var cls = l.charAt(0) === "+" && l.slice(0, 3) !== "+++" ? "is-add" : l.charAt(0) === "-" && l.slice(0, 3) !== "---" ? "is-del" : l.slice(0, 2) === "@@" ? "is-hunk" : "";
        return h("span", { key: j, className: cls }, l + "\n");
      })) : null);
  }

  function AgentPanel(props) {
    var slug = props.site, rel = props.rel, menu = props.menu;
    var agents = (menu && menu.agents) || [];
    var saved = "";
    try { saved = localStorage.getItem(AGENT_KEY) || ""; } catch (e) { saved = ""; }
    var _ag = useState(agents.some(function (a) { return a.id === saved; }) ? saved : (agents[0] || {}).id), agentId = _ag[0], setAgentId = _ag[1];
    var _hi = useState(null), history = _hi[0], setHistory = _hi[1];
    var _tx = useState(""), text = _tx[0], setText = _tx[1];
    var _tu = useState(null), turn = _tu[0], setTurn = _tu[1];           // {id, started} while one runs
    var _er = useState(""), err = _er[0], setErr = _er[1];
    var _fr = useState({}), fresh = _fr[0], setFresh = _fr[1];          // turn id -> changes with diffs
    var _el = useState(0), elapsed = _el[0], setElapsed = _el[1];
    var logRef = useRef(null);
    var agent = agents.filter(function (a) { return a.id === agentId; })[0] || agents[0];
    var noteRel = /\.md$/i.test(rel) ? rel : rel + ".md";

    var loadSession = useCallback(function () {
      if (!agent) return Promise.resolve();
      return askFetch(slug, "agents/" + encodeURIComponent(agent.id) + "/session?rel=" + encodeURIComponent(noteRel))
        .then(function (s) { setHistory(s.history || []); })
        .catch(function (e) { setHistory([]); setErr(e.message); });
    }, [slug, noteRel, agent && agent.id]);

    useEffect(function () { setHistory(null); setErr(""); loadSession(); }, [loadSession]);

    useEffect(function () {
      var el = logRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }, [history, turn]);

    // Poll the running turn.
    useEffect(function () {
      if (!turn) return undefined;
      var stop = false;
      var tick = setInterval(function () { setElapsed(Date.now() - turn.started); }, 1000);
      function poll() {
        askFetch(slug, "agent-turns/" + encodeURIComponent(turn.id)).then(function (r) {
          if (stop) return;
          if (r.state === "running") { setTimeout(poll, 1200); return; }
          if (r.changes && r.changes.length) {
            setFresh(function (f) { var n = Object.assign({}, f); n[turn.id] = r.changes; return n; });
            if (props.onChanged) props.onChanged(r.changes.map(function (c) { return c.rel; }));
          }
          if (r.state === "failed") {
            setErr(r.error || "The agent failed.");
            // The failed message is not in the conversation: give it back, to send again.
            setText(function (t) { return t || turn.message || ""; });
          }
          setTurn(null);
          loadSession();
        }).catch(function (e) { if (!stop) { setErr(e.message); setTurn(null); } });
      }
      poll();
      return function () { stop = true; clearInterval(tick); };
    }, [turn && turn.id]);

    function send() {
      var msg = text.trim();
      if (!msg || turn || !agent) return;
      setErr("");
      setHistory(function (h0) { return (h0 || []).concat({ role: "user", text: msg, pending: true }); });
      setText("");
      askFetch(slug, "agents/" + encodeURIComponent(agent.id) + "/turn", { method: "POST", body: { rel: noteRel, message: msg, mode: "review" } })
        .then(function (r) { setElapsed(0); setTurn({ id: r.turn, started: Date.now(), message: msg }); })
        .catch(function (e) { setErr(e.message); setText(msg); loadSession(); });
    }

    function stopTurn() {
      if (!turn) return;
      askFetch(slug, "agent-turns/" + encodeURIComponent(turn.id) + "/cancel", { method: "POST", body: {} }).catch(function () {});
    }

    function reset() {
      if (turn || !agent) return;
      askFetch(slug, "agents/" + encodeURIComponent(agent.id) + "/session?rel=" + encodeURIComponent(noteRel), { method: "DELETE" })
        .then(function () { setHistory([]); setFresh({}); setErr(""); })
        .catch(function (e) { setErr(e.message); });
    }

    function pick(id) {
      if (turn) return;
      setAgentId(id);
      try { localStorage.setItem(AGENT_KEY, id); } catch (e) { /* this visit only */ }
    }

    var prompts = [
      "Review this note: what is unclear, wrong or missing?",
      "Which other notes in this vault relate to this one?",
      "Summarise this note in five bullet points.",
    ];

    return h("aside", { className: "wsd-agent", "aria-label": "Agent" },
      h("div", { className: "wsd-agent-head" },
        agents.length > 1 ? h("div", { className: "wsd-sitebar wsd-agent-pick", role: "group", "aria-label": "Agent" }, agents.map(function (a) {
          return h("button", { key: a.id, type: "button", className: "wsd-seg" + (a.id === agentId ? " is-current" : ""), "aria-pressed": String(a.id === agentId), disabled: !!turn && a.id !== agentId, onClick: function () { pick(a.id); } }, a.label);
        })) : h("span", { className: "wsd-agent-name" }, agent ? agent.label : "Agent"),
        h("span", { className: "wsd-spacer" }),
        h("button", { type: "button", className: "wsd-icon-button wsd-small", title: "New conversation", "aria-label": "New conversation", disabled: !!turn, onClick: reset }, h(Icon, { name: "refresh" })),
        h("button", { type: "button", className: "wsd-icon-button wsd-small", title: "Close", "aria-label": "Close the agent panel", onClick: props.onClose }, h(Icon, { name: "close" }))),
      h("p", { className: "wsd-agent-mode" },
        h("strong", null, "Review"), " — ",
        agent && agent.enforcesReview ? agent.label + " can read the vault but cannot change it."
          : (agent ? agent.label : "The agent") + " is asked not to change files. Anything it changes anyway is listed below with Revert."),
      h("div", { className: "wsd-agent-log", ref: logRef, "aria-live": "polite" },
        history === null ? h("p", { className: "wsd-muted" }, "Loading the conversation…")
          : !history.length && !turn ? h("div", { className: "wsd-agent-empty" },
            h("p", null, "Ask ", agent ? agent.label : "the agent", " about ", h("strong", null, props.title || rel), ". It reads the vault itself, and remembers this conversation", menu && menu.scope === "vault" ? " as you move between notes." : " for this note."),
            prompts.map(function (p) { return h("button", { key: p, type: "button", className: "wsd-prompt", onClick: function () { setText(p); } }, p); }))
            : history.map(function (m, i) {
              var changes = m.turn && fresh[m.turn] ? fresh[m.turn] : (m.changes || []);
              return h("div", { key: i, className: "wsd-msg is-" + m.role + (m.pending ? " is-pending" : "") },
                m.role === "user" ? h("p", { dir: "auto" }, m.text) : h("div", { className: "wsd-md" }, mdBlocks(m.text)),
                m.role === "user" && m.rel && m.rel !== noteRel ? h("span", { className: "wsd-msg-note" }, "about " + m.rel.replace(/\.md$/i, "")) : null,
                changes.length ? h("ul", { className: "wsd-changes" }, changes.map(function (c) {
                  return h(Change, { key: c.rel, change: c, turn: m.turn, site: slug, open: changes.length === 1, onReverted: function (r) { if (props.onChanged) props.onChanged([r]); } });
                })) : null);
            }),
        turn ? h("div", { className: "wsd-msg is-agent is-working" },
          h("span", { className: "wsd-dots", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
          h("span", null, (agent ? agent.label : "The agent") + " is working · " + Math.round(elapsed / 1000) + " s"),
          h("button", { type: "button", className: "wsd-link", onClick: stopTurn }, "Stop")) : null),
      err ? h("p", { className: "wsd-agent-err" }, err) : null,
      h("form", { className: "wsd-agent-form", onSubmit: function (e) { e.preventDefault(); send(); } },
        h("textarea", {
          value: text, rows: 3, dir: "auto", placeholder: "Ask " + (agent ? agent.label : "the agent") + " about this note…",
          "aria-label": "Message", disabled: !agent,
          onChange: function (e) { setText(e.target.value); },
          onKeyDown: function (e) { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } },
        }),
        h("div", { className: "wsd-agent-send" },
          h("span", { className: "wsd-muted" }, "Enter to send · Shift+Enter for a new line"),
          h("button", { type: "submit", className: "wsd-button is-on", disabled: !text.trim() || !!turn || !agent }, "Send"))));
  }

  // ---------------------------------------------------------------------------------------------------------
  // The page
  // ---------------------------------------------------------------------------------------------------------

  function WebsidianPage() {
    var initial = useRef(readQuery()).current;
    var _st = useState(null), status = _st[0], setStatus = _st[1];
    var _er = useState(null), error = _er[0], setError = _er[1];
    var _m = useState(null), model = _m[0], setModel = _m[1];
    var _me = useState(""), modelError = _me[0], setModelError = _me[1];
    var _v = useState(initial.view || (initial.note ? "" : "overview")), view = _v[0], setView = _v[1];
    var _s = useState(initial.site), site = _s[0], setSite = _s[1];
    // The open note: {site, rel, title, edit, q}, or null.
    var _n = useState(initial.note ? { site: initial.site, rel: initial.note, title: "", edit: initial.edit, q: initial.q } : null), note = _n[0], setNote = _n[1];
    var _b = useState(initial.view || "overview"), back = _b[0], setBack = _b[1];
    var _q = useState(""), query = _q[0], setQuery = _q[1];
    var _r = useState(null), results = _r[0], setResults = _r[1];
    var _a = useState(-1), active = _a[0], setActive = _a[1];
    var _gf = useState(""), graphFocus = _gf[0], setGraphFocus = _gf[1];
    var _sk = useState(""), skillFilter = _sk[0], setSkillFilter = _sk[1];
    var _sc = useState(""), skillCategory = _sc[0], setSkillCategory = _sc[1];
    var _lk = useState(hostLook), look = _lk[0], setLook = _lk[1];
    var _rt = useState(savedReadingTheme), readTheme = _rt[0], setReadTheme = _rt[1];
    var _tm = useState(false), themeMenu = _tm[0], setThemeMenu = _tm[1];
    var reading = readingLook(readTheme, look);
    var _am = useState({}), agentMenus = _am[0], setAgentMenus = _am[1];   // site slug -> menu, or false
    var _po = useState(function () { try { return localStorage.getItem(PANEL_KEY) === "open"; } catch (e) { return false; } }), panelOpen = _po[0], setPanelOpen = _po[1];
    var _h = useState(600), height = _h[0], setHeight = _h[1];
    var _fs = useState(0), frameSeq = _fs[0], setFrameSeq = _fs[1];
    var frameRef = useRef(null);
    var frameWrapRef = useRef(null);
    var searchRef = useRef(null);
    var activeRowRef = useRef(null);
    var searchSeq = useRef(0);
    var lookRef = useRef(look);
    var readingRef = useRef(reading);
    var postViewportRef = useRef(function () {});
    lookRef.current = look;
    readingRef.current = reading;

    var sites = (model && model.sites) || [];
    var siteBySlug = {};
    sites.forEach(function (s) { siteBySlug[s.slug] = s; });
    var running = !!(status && status.running);

    // A deep link without a known site reads from the first vault.
    useEffect(function () {
      if (note && sites.length && !siteBySlug[note.site]) setNote(Object.assign({}, note, { site: sites[0].slug }));
      // ...and "Back" from a deep-linked note goes to the view that vault belongs to.
      if (note && !initial.view && siteBySlug[note.site]) {
        var kind = siteBySlug[note.site].kind;
        setBack(kind === "memory" && model.memory ? "memory" : kind === "skills" && model.skills ? "skills" : "browse");
      }
    }, [sites.length]);

    // ---- data ----
    var loadStatus = useCallback(function () {
      return SDK.fetchJSON(API + "/status").then(function (st) {
        setStatus(st); setError(null);
      }).catch(function (e) { setError(e && e.message ? e.message : String(e)); });
    }, []);

    var loadModel = useCallback(function () {
      return SDK.fetchJSON(API + "/overview").then(function (m) {
        setModel(m); setModelError("");
      }).catch(function (e) { setModelError(e && e.message ? e.message : String(e)); });
    }, []);

    useEffect(function () { loadStatus(); loadModel(); }, [loadStatus, loadModel]);

    // Poll while the server is down (the backend restarts it).
    useEffect(function () {
      if (!error && running) return undefined;
      var t = setInterval(loadStatus, 4000);
      return function () { clearInterval(t); };
    }, [running, error, loadStatus]);

    // Fresh when it matters: back on the browser tab, and once a minute while a native view is on screen.
    var framed = !!note || view === "browse" || view === "graph";
    useEffect(function () {
      if (framed || results !== null) return undefined;
      var onVisible = function () { if (document.visibilityState === "visible") loadModel(); };
      document.addEventListener("visibilitychange", onVisible);
      var t = setInterval(function () { if (document.visibilityState === "visible") loadModel(); }, REFRESH_MS);
      return function () { document.removeEventListener("visibilitychange", onVisible); clearInterval(t); };
    }, [framed, results, loadModel]);

    // The site Browse and Graph show: the chosen one, else the first plain vault, else the first.
    var browseSite = siteBySlug[site] ? site : ((sites.filter(function (s) { return s.kind === "vault"; })[0] || sites[0] || {}).slug || "");

    // ---- the address bar follows the page ----
    useEffect(function () {
      var state = note
        ? { view: view === "browse" ? "browse" : "", site: note.site, note: note.rel, edit: note.edit, q: note.q }
        : { view: view, site: (view === "browse" || view === "graph") && site ? site : "", note: "", edit: false, q: "" };
      var url = window.location.pathname + dashboardSearch(state) + window.location.hash;
      if (url !== window.location.pathname + window.location.search + window.location.hash) {
        try { window.history.replaceState(window.history.state, "", url); } catch (e) { /* ignore */ }
      }
    }, [view, site, note]);

    // ---- the agent panel: is there one for this vault? ----
    var noteSite = note ? note.site : "";
    useEffect(function () {
      if (!noteSite || !running || agentMenus[noteSite] !== undefined) return;
      askFetch(noteSite, "agents").then(function (m) {
        setAgentMenus(function (a) { var n = Object.assign({}, a); n[noteSite] = m && m.agents && m.agents.length ? m : false; return n; });
      }).catch(function () {
        setAgentMenus(function (a) { var n = Object.assign({}, a); n[noteSite] = false; return n; });
      });
    }, [noteSite, running]);

    function togglePanel(open) {
      setPanelOpen(open);
      try { localStorage.setItem(PANEL_KEY, open ? "open" : "closed"); } catch (e) { /* this visit only */ }
    }

    // The agent changed files: reload the note if it was one of them, and the lists.
    function agentChanged(rels) {
      if (note && rels.some(function (r) { return r.replace(/\.md$/i, "") === note.rel.replace(/\.md$/i, ""); })) setFrameSeq(function (n) { return n + 1; });
      loadModel();
    }

    // ---- theme: follow the dashboard's theme switcher live ----
    useEffect(function () {
      var sync = function () {
        var next = hostLook();
        if (next.key !== lookRef.current.key) setLook(next);
      };
      var mo = new MutationObserver(sync);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
      if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
      var media = matchMedia("(prefers-color-scheme: dark)");
      media.addEventListener("change", sync);
      var t = setInterval(sync, 3000); // theme changes that touch neither (a stylesheet swap)
      return function () { mo.disconnect(); media.removeEventListener("change", sync); clearInterval(t); };
    }, []);

    var postLook = useCallback(function () {
      var w = frameRef.current && frameRef.current.contentWindow;
      if (!w) return;
      var l = readingRef.current;
      try {
        w.postMessage({ type: "websidian:theme", theme: l.theme }, window.location.origin);
        w.postMessage({ type: "websidian:palette", palette: l.palette || {} }, window.location.origin);
      } catch (e) { /* frame gone */ }
    }, []);
    useEffect(function () { postLook(); }, [reading.key, reading.theme, postLook]);

    function chooseTheme(id) {
      setReadTheme(id);
      setThemeMenu(false);
      try { localStorage.setItem(THEME_KEY, id); } catch (e) { /* storage blocked: this visit only */ }
    }

    // Close the theme menu on a click elsewhere or Escape.
    useEffect(function () {
      if (!themeMenu) return undefined;
      function onDown(ev) { if (!ev.target.closest || !ev.target.closest(".wsd-theme")) setThemeMenu(false); }
      function onKey(ev) { if (ev.key === "Escape") setThemeMenu(false); }
      document.addEventListener("mousedown", onDown);
      document.addEventListener("keydown", onKey);
      return function () { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
    }, [themeMenu]);

    // ---- "/" to search ----
    useEffect(function () {
      function onKey(ev) {
        if (ev.key !== "/" || ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
        var t = ev.target;
        if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
        if (!searchRef.current) return;
        ev.preventDefault();
        searchRef.current.focus();
      }
      document.addEventListener("keydown", onKey);
      return function () { document.removeEventListener("keydown", onKey); };
    }, []);

    // ---- search every vault ----
    useEffect(function () {
      var q = query.trim();
      if (q.length < 2 || !sites.length) { setResults(null); setActive(-1); return undefined; }
      var seq = ++searchSeq.current;
      var t = setTimeout(function () {
        Promise.all(sites.map(function (s) {
          return fetch(safePath(s.base) + "_search?limit=12&q=" + encodeURIComponent(q), { credentials: "same-origin", headers: { accept: "application/json" } })
            .then(function (res) { return res.ok ? res.json() : []; })
            .then(function (hits) { return (Array.isArray(hits) ? hits : []).map(function (hit) { return Object.assign({}, hit, { site: s.slug }); }); })
            .catch(function () { return []; });
        })).then(function (lists) {
          if (seq !== searchSeq.current) return;
          var all = [].concat.apply([], lists).sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
          setResults(all);
          setActive(all.length ? 0 : -1);
        });
      }, 200);
      return function () { clearTimeout(t); };
    }, [query, sites.length]);

    useEffect(function () {
      if (activeRowRef.current) activeRowRef.current.scrollIntoView({ block: "nearest" });
    }, [active, results]);

    // ---- navigation ----
    function go(next, slug) {
      setNote(null);
      setGraphFocus("");
      setQuery("");
      setView(next);
      if (slug !== undefined) setSite(slug);
    }

    function openNote(entry) {
      if (!entry || !entry.site || !entry.rel) return;
      if (!note) setBack(view || "overview");
      setNote({ site: entry.site, rel: String(entry.rel).replace(/\.md$/i, ""), title: entry.title || "", edit: !!entry.edit, q: "" });
      setQuery("");
      setFrameSeq(function (n) { return n + 1; });
    }

    function closeNote() {
      var to = back || "overview";
      setNote(null);
      setView(to);
    }

    function toggleEdit() {
      if (!note) return;
      setNote(Object.assign({}, note, { edit: !note.edit, q: "" }));
      setFrameSeq(function (n) { return n + 1; });
    }

    function showInGraph() {
      if (!note) return;
      var rel = note.rel;
      setSite(note.site);
      setNote(null);
      setView("graph");
      setGraphFocus(rel.replace(/\.md$/i, "") + ".md");
    }

    // ---- the one frame ----
    // A note and Browse flow with the dashboard page (the frame is as tall as the page in it); the graph and
    // the editor need a viewport of their own and get the height that is left below the bar.
    var frameSrc = "";
    var readerUrl = function (slug, rel, edit, q) {
      return safePath(noteUrl(slug, rel, { edit: edit, q: q, theme: reading.theme, chrome: "none", flow: !edit }));
    };
    if (note && siteBySlug[note.site]) {
      frameSrc = readerUrl(note.site, note.rel, note.edit && siteBySlug[note.site].edit, note.q);
    } else if (note && !sites.length) {
      frameSrc = "";
    } else if (note) {
      frameSrc = readerUrl((sites[0] || {}).slug || note.site, note.rel, false, "");
    } else if (view === "browse" && browseSite) {
      frameSrc = siteBase(browseSite) + "?" + withShell("", reading.theme, "tree", true);
    } else if (view === "graph" && browseSite) {
      frameSrc = siteBase(browseSite) + "_graph?" + withShell(graphFocus ? "focus=" + encodeURIComponent(graphFocus) : "", reading.theme, "");
    }
    frameSrc = safePath(frameSrc);

    // Point the frame at frameSrc when that changes (not on every render: the reader may have moved on inside
    // it, and a theme change is posted to the page rather than reloading it).
    var lastSrc = useRef({ src: "", seq: -1, theme: reading.theme });
    useEffect(function () {
      var f = frameRef.current;
      if (!f || !frameSrc || !running) return;
      var prev = lastSrc.current;
      var sameButTheme = prev.src && prev.src.replace(/theme=\w+/, "") === frameSrc.replace(/theme=\w+/, "") && prev.seq === frameSeq;
      if (prev.src === frameSrc && prev.seq === frameSeq) return;
      lastSrc.current = { src: frameSrc, seq: frameSeq, theme: reading.theme };
      if (sameButTheme) return;
      f.setAttribute("src", frameSrc);
    }, [frameSrc, frameSeq, running]);

    function onFrameLoad() {
      postLook();
      postViewportRef.current();
      var f = frameRef.current;
      var loc = null, doc = null;
      try { loc = f && f.contentWindow ? f.contentWindow.location : null; doc = f.contentDocument; } catch (e) { loc = null; }
      var at = stateFromFrame(loc);
      if (!at) return;
      var h1 = null;
      try { h1 = doc && doc.querySelector(".note h1, main h1"); } catch (e) { h1 = null; }
      var title = h1 ? h1.textContent.trim() : "";
      if (note) {
        if (!title && at.site === note.site && at.note === note.rel) title = note.title;
        if (at.page !== "note") return;
        if (at.site !== note.site || at.note !== note.rel || at.edit !== !!note.edit || title !== note.title) {
          var next = { site: at.site, rel: at.note, title: title, edit: at.edit, q: at.q };
          lastSrc.current = { src: readerUrl(at.site, at.note, at.edit, at.q), seq: frameSeq, theme: reading.theme };
          setNote(next);
        }
        // A link followed at the bottom of a long note: start the next one at its top.
        var bar = document.querySelector(".wsd-topbar");
        if (bar && bar.getBoundingClientRect().top < 0) bar.scrollIntoView({ block: "start" });
      } else if (view === "graph" && at.page === "note" && at.note) {
        // A node clicked in the graph: read it in the reading pane, not inside the graph.
        setBack("graph");
        setNote({ site: at.site, rel: at.note, title: title, edit: false, q: "" });
        setFrameSeq(function (n) { return n + 1; });
      }
    }

    // ---- flow mode: the page says how tall it is; we say how much of it a reader sees at once ----
    var _fh = useState(0), flowHeight = _fh[0], setFlowHeight = _fh[1];
    useEffect(function () {
      function onMessage(ev) {
        var f = frameRef.current;
        if (!f || ev.source !== f.contentWindow || !ev.data || ev.data.type !== "websidian:height") return;
        var hgt = Math.round(Number(ev.data.height));
        if (hgt > 0 && hgt < 1000000) setFlowHeight(hgt);
      }
      function postViewport() {
        var w = frameRef.current && frameRef.current.contentWindow;
        if (w) try { w.postMessage({ type: "websidian:viewport", height: Math.max(240, window.innerHeight - 140) }, window.location.origin); } catch (e) { /* gone */ }
      }
      window.addEventListener("message", onMessage);
      window.addEventListener("resize", postViewport);
      postViewportRef.current = postViewport;
      return function () { window.removeEventListener("message", onMessage); window.removeEventListener("resize", postViewport); };
    }, []);

    // ---- fill the viewport below the frame's top ----
    useEffect(function () {
      function fit() {
        var el = frameWrapRef.current;
        if (!el || !el.offsetParent) return;
        var top = el.getBoundingClientRect().top;
        setHeight(Math.max(320, Math.floor(window.innerHeight - top - 20)));
      }
      fit();
      window.addEventListener("resize", fit);
      var t = setTimeout(fit, 120);
      return function () { window.removeEventListener("resize", fit); clearTimeout(t); };
    }, [framed, note && note.title, note && note.edit, results, running, model]);

    // ---- keyboard in the search box ----
    function onSearchKey(ev) {
      if (ev.key === "Escape") { setQuery(""); ev.target.blur(); return; }
      var hits = results || [];
      if (!hits.length) return;
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        setActive((active + (ev.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length);
        ev.preventDefault();
      } else if (ev.key === "Enter" && active >= 0) {
        openNote(hits[active]);
        ev.preventDefault();
      }
    }

    function onTabKey(ev, ids) {
      if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
      var current = note ? back : view;
      var at = Math.max(0, ids.indexOf(current));
      var next = ids[(at + (ev.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length];
      go(next);
      ev.preventDefault();
      setTimeout(function () {
        var b = document.querySelector('.wsd-tab[data-view="' + next + '"]');
        if (b) b.focus();
      }, 0);
    }

    // ---------------------------------------------------------------------------------------------------
    // Rendering
    // ---------------------------------------------------------------------------------------------------

    if (error || (status && !status.running)) {
      return h("div", { className: "websidian-page" }, h(StatusPanel, { status: status, error: error, onRetry: function () { loadStatus(); loadModel(); } }));
    }

    var tabs = [{ id: "overview", label: "Overview", icon: "home" }];
    if (model && model.memory) tabs.push({ id: "memory", label: "Memory", icon: "brain" });
    if (model && model.skills) tabs.push({ id: "skills", label: "Skills", icon: "spark" });
    tabs.push({ id: "browse", label: "Browse", icon: "folder" }, { id: "graph", label: "Graph", icon: "graph" });
    var tabIds = tabs.map(function (t) { return t.id; });
    var currentTab = results !== null ? "" : note ? back : view;

    var mismatch = status && status.base_path && status.base_path !== basePath() + MOUNT;
    var totalNotes = sites.reduce(function (n, s) { return n + (s.notes || 0); }, 0);
    var updated = sites.reduce(function (n, s) { return Math.max(n, s.updated || 0); }, 0);

    var summary = model ? [count(sites.length, "vault", "vaults"), count(totalNotes, "note", "notes"), updated ? "updated " + relativeTime(updated) : ""].filter(Boolean).join(" · ") : "";
    var tools = h("div", { className: "wsd-tools" },
        h("label", { className: "wsd-search" },
          h(Icon, { name: "search" }),
          h("input", {
            ref: searchRef, type: "search", value: query, placeholder: "Search every vault", "aria-label": "Search every vault",
            autoComplete: "off", spellCheck: false, onChange: function (e) { setQuery(e.target.value); }, onKeyDown: onSearchKey,
          }),
          query ? null : h("kbd", { className: "wsd-kbd" }, "/")),
        themePicker(),
        h("button", { type: "button", className: "wsd-icon-button", title: "Refresh", "aria-label": "Refresh", onClick: function () { loadStatus(); loadModel(); } },
          h(Icon, { name: "refresh" })));

    var tabBar = h("nav", { className: "wsd-tabs", role: "tablist", "aria-label": "Websidian views", onKeyDown: function (ev) { onTabKey(ev, tabIds); } },
      tabs.map(function (t) {
        var current = t.id === currentTab;
        return h("button", {
          key: t.id, type: "button", role: "tab", "data-view": t.id, className: "wsd-tab" + (current ? " is-current" : ""),
          "aria-selected": String(current), tabIndex: current || (!currentTab && t.id === "overview") ? 0 : -1,
          onClick: function () { go(t.id); },
        }, h(Icon, { name: t.icon }), h("span", null, t.label));
      }));

    var banners = [
      mismatch ? h("div", { key: "m", className: "wsd-banner" },
        "dashboard.public_base gives the path prefix " + JSON.stringify(status.base_path) + " but this dashboard is served under " +
        JSON.stringify(basePath() + MOUNT) + ". Fix plugins.entries.websidian.settings.dashboard.public_base.") : null,
      status && status.version_skew ? h("div", { key: "v", className: "wsd-banner" },
        "Half an upgrade: this plugin is " + versionLabel(status.plugin_version) + " but the Websidian runtime in " +
        status.app_dir + " is " + versionLabel(status.app_version) + ". Re-run deploy/install-local.sh, then restart the dashboard.") : null,
      modelError ? h("div", { key: "e", className: "wsd-banner" }, "Could not read the vaults: " + modelError) : null,
    ];

    // ---- the body ----
    var body = null;
    var showFrame = false;
    if (results !== null) {
      body = searchResults();
    } else if (!model) {
      body = skeleton();
    } else if (note) {
      showFrame = !!frameSrc;
      body = reader();
    } else if (view === "browse" || view === "graph") {
      showFrame = !!frameSrc;
      body = sitePicker();
    } else if (view === "memory") {
      body = memoryView();
    } else if (view === "skills") {
      body = skillsView();
    } else {
      body = overview();
    }

    var flowing = showFrame && ((note && !note.edit) || (!note && view === "browse"));
    var showPanel = showFrame && !!note && !note.edit && results === null && panelOpen && !!agentMenus[note.site];
    return h("div", { className: "websidian-page" + (showFrame ? " is-framed" : "") + (look.theme === "light" ? " is-light" : "") },
      h("div", { className: "wsd-topbar" }, tabBar, tools), banners, body,
      h("div", { className: "wsd-stage" + (showPanel ? " with-panel" : "") },
      h("div", { ref: frameWrapRef, className: "wsd-frame-wrap" + (flowing ? " is-flow" : "") + (readTheme !== "hermes" ? " has-theme" : ""), hidden: !showFrame, style: { height: (flowing ? flowHeight || height : height) + "px" } },
        h("iframe", { ref: frameRef, title: "Websidian", className: "wsd-frame", referrerPolicy: "same-origin", onLoad: onFrameLoad })),
      showPanel ? h(AgentPanel, {
        key: note.site, site: note.site, rel: note.rel, title: note.title, menu: agentMenus[note.site],
        onClose: function () { togglePanel(false); }, onChanged: agentChanged,
      }) : null));

    // ---- views ----
    function themePicker() {
      return h("div", { className: "wsd-theme" },
        h("button", {
          type: "button", className: "wsd-icon-button" + (themeMenu ? " is-open" : ""), title: "Reading theme", "aria-label": "Reading theme",
          "aria-haspopup": "true", "aria-expanded": String(themeMenu), onClick: function () { setThemeMenu(!themeMenu); },
        }, h(Icon, { name: "palette" })),
        themeMenu ? h("div", { className: "wsd-theme-menu", role: "menu", "aria-label": "Reading theme" },
          h("div", { className: "wsd-panel-label" }, "Reading theme"),
          READING_THEMES.map(function (t) {
            var sw = swatchOf(t, look);
            var current = t.id === readTheme;
            return h("button", {
              key: t.id, type: "button", role: "menuitemradio", "aria-checked": String(current),
              className: "wsd-theme-item" + (current ? " is-current" : ""), onClick: function () { chooseTheme(t.id); },
            },
              h("span", { className: "wsd-swatch", style: { background: sw[0], color: sw[1], borderColor: sw[2] } }, "Aa"),
              h("span", { className: "wsd-theme-label" }, t.label, t.note ? h("small", null, t.note) : null),
              current ? h(Icon, { name: "check" }) : null);
          }),
          h("p", { className: "wsd-theme-foot" }, "For notes, the tree and the graph. Kept in this browser.")) : null);
    }

    function skeleton() {
      return h("div", { className: "wsd-overview" },
        h("div", { className: "wsd-cards" }, [0, 1, 2].map(function (i) { return h("div", { key: i, className: "wsd-card wsd-skeleton" }); })),
        [0, 1, 2, 3].map(function (i) { return h("div", { key: i, className: "wsd-row wsd-skeleton" }); }));
    }

    function overview() {
      var mem = model.memory;
      var recent = model.recent || [];
      return h("div", { className: "wsd-overview" },
        summary ? h("p", { className: "wsd-subtitle" }, summary) : null,
        mem ? h("section", null,
          h(Label, { extra: h("button", { type: "button", className: "wsd-link", onClick: function () { go("memory"); } }, "All entries") }, "Memory"),
          h("div", { className: "wsd-cards wsd-cards-2" }, mem.files.map(function (f) {
            if (!f.present) {
              return h("div", { key: f.id, className: "wsd-card is-absent" },
                h("div", { className: "wsd-card-top" }, h(Icon, { name: f.id === "user" ? "user" : "brain", className: "wsd-card-icon" }), h("span", { className: "wsd-card-label" }, f.label)),
                h("p", { className: "wsd-card-excerpt" }, "No " + f.file + " yet. Hermes creates it the first time it saves a memory."));
            }
            var first = f.entries.slice(0, 2);
            return h("button", { key: f.id, type: "button", className: "wsd-card", onClick: function () { go("memory"); } },
              h("div", { className: "wsd-card-top" },
                h(Icon, { name: f.id === "user" ? "user" : "brain", className: "wsd-card-icon" }),
                h("span", { className: "wsd-card-label" }, f.label),
                h("span", { className: "wsd-card-count" }, count(f.entries.length, "entry", "entries"))),
              first.length ? h("ul", { className: "wsd-card-entries" }, first.map(function (e, i) { return h("li", { key: i, dir: "auto" }, e); }))
                : h("p", { className: "wsd-card-excerpt" }, "Empty."),
              h("div", { className: "wsd-card-foot" }, h(Meter, { value: f.chars, limit: f.limit }), h(Time, { ms: f.mtime })));
          }))) : null,
        h("section", null,
          h(Label, null, "Vaults"),
          h("div", { className: "wsd-cards" }, sites.map(function (s) {
            var target = s.kind === "memory" && mem ? "memory" : s.kind === "skills" && model.skills ? "skills" : "browse";
            return h("button", { key: s.slug, type: "button", className: "wsd-card wsd-vault" + (s.present ? "" : " is-absent"), onClick: function () { go(target, s.slug); } },
              h("div", { className: "wsd-card-top" },
                h(Icon, { name: KIND_ICON[s.kind] || "book", className: "wsd-card-icon" }),
                h("span", { className: "wsd-card-label" }, s.title),
                s.edit ? h("span", { className: "wsd-chip", title: "Signed-in dashboard users can edit this vault" }, h(Icon, { name: "pencil" }), "Editable")
                  : h("span", { className: "wsd-chip is-quiet", title: "Browser editing is off for this vault (vaults[].edit)" }, h(Icon, { name: "lock" }), "Read-only")),
              h("p", { className: "wsd-card-excerpt" }, s.present
                ? count(s.notes, "note", "notes") + (s.partial ? "+" : "") + (s.kind === "skills" && model.skills ? " · " + count(model.skills.skills.length, "skill", "skills") : "")
                : "This folder is missing."),
              h("div", { className: "wsd-card-foot" }, h("span", { className: "wsd-card-file" }, s.slug), h(Time, { ms: s.updated })));
          }))),
        h("section", null,
          h(Label, null, "Recently changed"),
          recent.length ? h("ul", { className: "wsd-notes" }, recent.slice(0, RECENT_ON_OVERVIEW).map(function (n) {
            return h(NoteRow, { key: n.site + "/" + n.rel, note: n, site: siteBySlug[n.site], showSite: sites.length > 1, onOpen: function () { openNote(n); } });
          })) : h(Empty, { title: "Nothing here yet", text: "Notes the agent writes into these vaults appear here, newest first." })));
    }

    function memoryView() {
      var mem = model.memory;
      var memSite = siteBySlug[mem.site] || {};
      return h("div", { className: "wsd-memory" },
        h("p", { className: "wsd-intro" }, "What Hermes remembers between sessions. Both files go into its prompt when a session starts, so a change made during a session counts from the next one. When a file is full, Hermes has to replace or remove entries before it can add another."),
        h("div", { className: "wsd-memory-cols" }, mem.files.map(function (f) {
          return h("section", { key: f.id, className: "wsd-panel" },
            h("div", { className: "wsd-panel-head" },
              h("div", { className: "wsd-panel-title" },
                h(Icon, { name: f.id === "user" ? "user" : "brain", className: "wsd-card-icon" }),
                h("div", null, h("h2", null, f.label), h("p", null, f.present ? f.file + " · " + count(f.entries.length, "entry", "entries") : f.file))),
              f.present ? h("div", { className: "wsd-panel-actions" },
                h("button", { type: "button", className: "wsd-button", onClick: function () { openNote({ site: mem.site, rel: f.rel, title: f.label }); } },
                  h(Icon, { name: "file" }), h("span", null, "Open")),
                memSite.edit ? h("button", { type: "button", className: "wsd-button", onClick: function () { openNote({ site: mem.site, rel: f.rel, title: f.label, edit: true }); } },
                  h(Icon, { name: "pencil" }), h("span", null, "Edit")) : null) : null),
            f.present ? h("div", { className: "wsd-panel-meter" }, h(Meter, { value: f.chars, limit: f.limit }),
              h("span", { className: "wsd-muted" }, f.chars.toLocaleString() + " / " + f.limit.toLocaleString() + " characters"), h(Time, { ms: f.mtime })) : null,
            !f.present ? h(Empty, { title: "No " + f.file + " yet", text: "Hermes creates it the first time it saves a memory." })
              : !f.entries.length ? h(Empty, { title: "Empty", text: "Hermes has not saved anything here yet." })
                : h("ol", { className: "wsd-entries" }, f.entries.map(function (e, i) {
                  return h("li", { key: i, className: "wsd-entry" }, h("span", { className: "wsd-entry-n" }, i + 1), h("p", { dir: "auto" }, e));
                })));
        })));
    }

    function skillsView() {
      var sk = model.skills;
      var f = skillFilter.trim().toLowerCase();
      var list = sk.skills.filter(function (s) {
        if (skillCategory && s.category !== skillCategory) return false;
        return !f || (s.name + " " + s.description + " " + s.category).toLowerCase().indexOf(f) >= 0;
      });
      var cat = sk.categories.filter(function (c) { return c.id === skillCategory; })[0];
      var label = function (id) { return id ? id.replace(/[-_]+/g, " ") : "Uncategorised"; };
      return h("div", { className: "wsd-skills" },
        h("aside", { className: "wsd-panel wsd-skill-cats" },
          h("div", { className: "wsd-panel-label" }, "Categories"),
          h("button", { type: "button", className: "wsd-cat" + (!skillCategory ? " is-current" : ""), onClick: function () { setSkillCategory(""); } },
            h("span", null, "All"), h("span", { className: "wsd-cat-n" }, sk.skills.length)),
          sk.categories.map(function (c) {
            return h("button", { key: c.id || "_", type: "button", className: "wsd-cat" + (skillCategory === c.id ? " is-current" : ""), title: c.description || undefined, onClick: function () { setSkillCategory(c.id); } },
              h("span", null, label(c.id)), h("span", { className: "wsd-cat-n" }, c.count));
          })),
        h("section", { className: "wsd-panel wsd-skill-list" },
          h("div", { className: "wsd-panel-head" },
            h("div", { className: "wsd-panel-title" }, h("div", null,
              h("h2", null, cat ? label(cat.id) : "All skills"),
              h("p", null, cat && cat.description ? cat.description : "The skill documents Hermes loads when a task calls for them. Open one to read it with its links and backlinks."))),
            h("label", { className: "wsd-search wsd-search-small" },
              h(Icon, { name: "search" }),
              h("input", { type: "search", value: skillFilter, placeholder: "Filter skills", "aria-label": "Filter skills", onChange: function (e) { setSkillFilter(e.target.value); } }))),
          list.length ? h("ul", { className: "wsd-skill-rows" }, list.map(function (s) {
            return h("li", { key: s.rel },
              h("button", { type: "button", className: "wsd-skill", onClick: function () { openNote({ site: sk.site, rel: s.rel, title: s.name }); } },
                h("span", { className: "wsd-skill-name" }, s.name),
                s.category && !skillCategory ? h("span", { className: "wsd-skill-cat" }, label(s.category)) : null,
                h("span", { className: "wsd-skill-desc", dir: "auto" }, s.description)));
          })) : h(Empty, { title: "No skill matches", text: f ? "Try another word, or clear the filter." : "This category is empty." })));
    }

    function sitePicker() {
      if (sites.length < 2) return null;
      return h("div", { className: "wsd-sitebar", role: "group", "aria-label": "Vault" },
        sites.map(function (s) {
          var current = s.slug === browseSite;
          return h("button", {
            key: s.slug, type: "button", className: "wsd-seg" + (current ? " is-current" : ""), "aria-pressed": String(current),
            onClick: function () { setSite(s.slug); setGraphFocus(""); },
          }, h(Icon, { name: KIND_ICON[s.kind] || "book" }), h("span", null, s.title));
        }));
    }

    function reader() {
      var s = siteBySlug[note.site] || {};
      var title = note.title || note.rel.split("/").pop();
      var canEdit = !!s.edit;
      var full = safePath(note.edit ? noteUrl(note.site, note.rel, { edit: true }) : siteBase(note.site) + encodeNote(note.rel));
      return h("div", { className: "wsd-reader" },
        h("button", { type: "button", className: "wsd-icon-button", title: "Back", "aria-label": "Back", onClick: closeNote }, h(Icon, { name: "back" })),
        h("div", { className: "wsd-reader-titles" },
          h("h2", { className: "wsd-reader-title", dir: "auto" }, title),
          h("span", { className: "wsd-reader-path" }, (s.title || note.site) + " / " + note.rel + (note.edit ? " · editing" : ""))),
        h("div", { className: "wsd-reader-actions" },
          agentMenus[note.site] && !note.edit ? h("button", {
            type: "button", className: "wsd-button" + (panelOpen ? " is-on" : ""), title: "Ask an agent about this note",
            "aria-pressed": String(panelOpen), onClick: function () { togglePanel(!panelOpen); },
          }, h(Icon, { name: "chat" }), h("span", null, "Ask")) : null,
          canEdit ? h("button", { type: "button", className: "wsd-button" + (note.edit ? " is-on" : ""), onClick: toggleEdit },
            h(Icon, { name: note.edit ? "book" : "pencil" }), h("span", null, note.edit ? "Done" : "Edit")) : null,
          note.edit ? null : h("button", { type: "button", className: "wsd-button", title: "Show this note in the graph", onClick: showInGraph },
            h(Icon, { name: "graph" }), h("span", null, "Graph")),
          h("a", { className: "wsd-button", href: full, target: "_blank", rel: "noopener", title: "Open the full page in a new tab" },
            h(Icon, { name: "external" }), h("span", null, "Open"))));
    }

    function searchResults() {
      var hits = results || [];
      var q = query.trim();
      return h("div", { className: "wsd-results" },
        h("p", { className: "wsd-results-title" }, hits.length
          ? count(hits.length, "note mentions", "notes mention") + " “" + q + "”"
          : "Nothing mentions “" + q + "”"),
        hits.length ? h("ul", { className: "wsd-notes" }, hits.map(function (hit, i) {
          var snippet = markText(hit.snippet).map(function (p, j) { return p.marked ? h("mark", { key: j }, p.text) : p.text; });
          return h(NoteRow, {
            key: hit.site + "/" + hit.rel, note: { title: listTitle(hit), rel: hit.rel }, site: siteBySlug[hit.site], showSite: sites.length > 1,
            snippet: snippet, meta: hit.folder || "", active: i === active, rowRef: i === active ? activeRowRef : undefined,
            onOpen: function () { openNote({ site: hit.site, rel: hit.rel, title: hit.title }); },
          });
        })) : h(Empty, { title: "No results", text: "Try fewer words, or a word from the note’s title." }));
    }
  }

  window.__HERMES_PLUGINS__.register("websidian", WebsidianPage);
})();
