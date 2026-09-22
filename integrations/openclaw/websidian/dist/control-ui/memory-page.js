// The native Memory page inside OpenClaw's Control UI.
//
// OpenClaw-shaped chrome — a header with search, a tab bar, cards, a timeline — drawn in the Control UI
// document from the model the plugin's Gateway route returns. Only the reading of a note, the vault tree
// and the graph are Websidian, in shell mode, in one frame in the content area. Nothing here reads the
// workspace itself: OpenClaw's workspace stays the one source of truth and the plugin's route reads it.
//
// This code runs with the operator's authority in the Control UI document, so nothing an agent wrote is
// ever parsed as markup here: titles, excerpts and search snippets are all set as text (see markText).
//
// Plain ES modules, no framework and no build step: the Gateway serves this directory's .js and .css
// files as they are (readPluginControlUiAssets), so what ships is what you read here.

const MEMORY_ROUTE = '/plugins/websidian-memory';
const JSON_PATH = MEMORY_ROUTE + '/memory.json';
const TABS = [
  { id: 'overview', label: 'Overview', icon: 'home' },
  { id: 'timeline', label: 'Timeline', icon: 'clock' },
  { id: 'browse', label: 'Browse', icon: 'folder' },
  { id: 'graph', label: 'Graph', icon: 'graph' },
];
const SECTION_ICONS = { 'long-term': 'brain', user: 'user', dreams: 'moon' };
const RECENT_ON_OVERVIEW = 8;
const REFRESH_MS = 60_000;
const STORE_KEY = 'websidian:memory:view';

// {view, note} this tab last showed, or {} (page parameters, when a link carries them, win).
function restore(props) {
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || '{}') || {}; } catch { saved = {}; }
  return {
    view: typeof props.view === 'string' ? props.view : typeof saved.view === 'string' ? saved.view : '',
    note: typeof props.note === 'string' ? props.note : typeof saved.note === 'string' ? saved.note : '',
  };
}

// ---------------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------------------------------

// "dark", "light", or "" when the colour says nothing (not a colour, or fully transparent).
export function themeFromColour(colour) {
  const m = /rgba?\(([^)]+)\)/.exec(String(colour || ''));
  if (!m) return '';
  const parts = m[1].split(',').map(v => parseFloat(v));
  const [r, g, b] = parts;
  if (parts.length > 3 && parts[3] === 0) return '';
  if (![r, g, b].every(Number.isFinite)) return '';
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128 ? 'dark' : 'light';
}

// A same-origin path from the model, or "". Frames and links only ever point back at the Gateway.
export function safePath(url) {
  const s = String(url || '');
  return s.startsWith('/') && !s.startsWith('//') && !/[\s\\]/.test(s) ? s : '';
}

// Websidian in shell mode. `chrome` is '' (its topbar and tree), 'tree' (tree only: the page has its own
// search) or 'none' (the note alone: a reading pane).
export function shellUrl(url, theme, chrome = '') {
  const path = safePath(url);
  if (!path) return '';
  const sep = path.indexOf('?') >= 0 ? '&' : '?';
  return path + sep + 'shell=1'
    + (theme === 'dark' || theme === 'light' ? '&theme=' + theme : '')
    + (chrome === 'tree' || chrome === 'none' ? '&chrome=' + chrome : '');
}

// "3 hours ago", "yesterday", in the host's locale.
export function relativeTime(ms, now = Date.now(), locale = undefined) {
  if (!ms) return '';
  // A file dated ahead of this browser's clock (the Gateway is often another machine) was written just now.
  const diff = Math.min(0, (ms - now) / 1000);
  const abs = Math.abs(diff);
  let rtf;
  try { rtf = new Intl.RelativeTimeFormat(locale || undefined, { numeric: 'auto' }); } catch { rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' }); }
  if (abs < 45) return rtf.format(0, 'second');
  const units = [['minute', 60], ['hour', 3600], ['day', 86400], ['week', 604800], ['month', 2629800], ['year', 31557600]];
  let unit = 'minute', size = 60;
  for (const [u, s] of units) { if (abs >= s * 0.9) { unit = u; size = s; } }
  return rtf.format(Math.round(diff / size), unit);
}

// "2026-09-23" for a moment, in *this browser's* timezone: "today" is the reader's today, not the
// Gateway's (which is often another machine, and usually UTC).
export function localDay(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Dated notes grouped by day, newest day first, with "today" and "yesterday" in the reader's timezone.
// A note named with a date keeps that date; any other note is filed under the day it last changed.
export function groupDays(notes, now = Date.now()) {
  const today = localDay(now);
  const yesterday = localDay(now - 86_400_000);
  const days = new Map();
  for (const n of notes) {
    const day = n.named && n.day ? n.day : localDay(n.mtime);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(n);
  }
  return [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([day, list]) => ({ day, when: day === today ? 'today' : day === yesterday ? 'yesterday' : '', notes: list }));
}

// A search snippet from Websidian ("…escaped text with <mark>terms</mark>…") as [{text, marked}] pieces,
// so the page can build it with text nodes. Only <mark> is honoured; every entity is decoded, nothing
// else is ever markup.
export function markText(html) {
  const decode = (s) => s.replace(/&(lt|gt|quot|#39|amp);/g, (m, e) => ({ lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' }[e]));
  const out = [];
  let marked = false;
  for (const part of String(html || '').split(/(<\/?mark>)/i)) {
    if (/^<mark>$/i.test(part)) { marked = true; continue; }
    if (/^<\/mark>$/i.test(part)) { marked = false; continue; }
    if (part) out.push({ text: decode(part.replace(/<[^>]*>/g, '')), marked });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------------------------------

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};

const ICONS = {
  brain: 'M9.5 2a2.5 2.5 0 0 1 2.5 2.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24A2.5 2.5 0 0 1 9.5 2Zm5 0A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24A2.5 2.5 0 0 0 14.5 2Z',
  user: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  moon: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z',
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 6v6l4 2',
  folder: 'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z',
  graph: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8.6 13.5l6.8 4M15.4 6.5l-6.8 4',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3',
  refresh: 'M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5',
  back: 'M19 12H5M12 19l-7-7 7-7',
  external: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  file: 'M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2ZM14 2v6h6',
};

function icon(name, className = 'wsd-icon') {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ICONS[name] || ICONS.file);
  svg.append(path);
  return svg;
}

function button(className, label, iconName, title) {
  const b = el('button', className);
  b.type = 'button';
  if (iconName) b.append(icon(iconName));
  if (label) b.append(el('span', '', label));
  if (title) { b.title = title; b.setAttribute('aria-label', title); }
  return b;
}

// Is the host drawing a dark surface? Read it off the page rather than guessing from a class name, so
// this keeps working whatever the Control UI's theme is called.
export function hostTheme(doc = document) {
  const probe = doc.body || doc.documentElement;
  const theme = themeFromColour(probe ? getComputedStyle(probe).backgroundColor : '');
  if (theme) return theme;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// The Gateway may sit behind a path prefix. The route itself is absolute on the Gateway, so try it
// plain first and fall back to the Control UI's base path.
async function loadModel(host) {
  const candidates = [JSON_PATH];
  const base = host && host.basePath ? String(host.basePath).replace(/\/+$/, '') : '';
  if (base) candidates.push(base + JSON_PATH);
  let lastError = '';
  for (const url of candidates) {
    let res;
    try { res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } }); }
    catch (err) { lastError = String(err && err.message ? err.message : err); continue; }
    if (res.ok) return { ok: true, model: await res.json() };
    lastError = `${res.status} ${res.statusText}`;
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'OpenClaw did not authorise this page.', hint: 'Enable Custom plugin UI in Settings → Labs, restart the Gateway and reload.' };
    }
    if (res.status === 503) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body.error || 'The Memory page has no vault to read.', hint: 'Add the workspace to plugins.entries.websidian.config.vaults.' };
    }
  }
  return { ok: false, error: `The Websidian plugin did not answer (${lastError}).`, hint: 'Check that it is enabled and that ui.enabled is true.' };
}

// ---------------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------------

export function mountMemoryPage(container, context) {
  const host = context.host;
  const locale = host && host.locale ? host.locale : undefined;
  const start = restore((context && context.props) || {});
  const state = {
    view: TABS.some(t => t.id === start.view) ? start.view : 'overview',
    note: null,                        // {rel, title, url} while a note is open
    pendingNote: start.note,
    back: 'overview',                  // the view "Back" returns to from a note
    model: null,
    error: null,
    loading: true,
    theme: hostTheme(),
    query: '',
    results: null,                     // null: not searching; [] or hits otherwise
    active: -1,
    graphFocus: '',                    // the note the Graph tab is centred on, if any
  };
  const since = (ms) => relativeTime(ms, Date.now(), locale);

  // ---- skeleton of the page ----
  const root = el('div', 'websidian-memory');
  root.setAttribute('data-theme', state.theme);

  const header = el('header', 'wsd-header');
  const heading = el('div', 'wsd-heading');
  const titleRow = el('div', 'wsd-title-row');
  titleRow.append(icon('brain', 'wsd-icon wsd-title-icon'), el('h1', 'wsd-title', 'Memory'));
  const subtitle = el('p', 'wsd-subtitle', '');
  heading.append(titleRow, subtitle);

  const tools = el('div', 'wsd-tools');
  const searchBox = el('label', 'wsd-search');
  searchBox.append(icon('search'));
  const search = el('input', 'wsd-search-input');
  search.type = 'search';
  search.placeholder = 'Search memory';
  search.setAttribute('aria-label', 'Search memory');
  search.autocomplete = 'off';
  const kbd = el('kbd', 'wsd-kbd', '/');
  searchBox.append(search, kbd);
  const refresh = button('wsd-icon-button', '', 'refresh', 'Refresh');
  tools.append(searchBox, refresh);
  header.append(heading, tools);

  const tabs = el('nav', 'wsd-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Memory views');
  const tabButtons = new Map();
  for (const tab of TABS) {
    const b = button('wsd-tab', tab.label, tab.icon);
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => go(tab.id));
    tabButtons.set(tab.id, b);
    tabs.append(b);
  }
  tabs.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
    const ids = TABS.map(t => t.id);
    const at = Math.max(0, ids.indexOf(state.note ? state.back : state.view));
    const dir = (ev.key === 'ArrowRight') === (getComputedStyle(root).direction !== 'rtl') ? 1 : -1;
    const next = ids[(at + dir + ids.length) % ids.length];
    go(next);
    tabButtons.get(next).focus();
    ev.preventDefault();
  });

  const body = el('div', 'wsd-body');
  const live = el('div', 'wsd-sr');
  live.setAttribute('aria-live', 'polite');
  root.append(header, tabs, body, live);
  container.append(root);

  // One frame, reused: switching between Browse, Graph and a note should not throw a loaded page away.
  const frame = el('iframe', 'wsd-frame');
  frame.setAttribute('title', 'Websidian');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  const frameTo = (url, chrome) => {
    const next = shellUrl(url, state.theme, chrome);
    if (next && frame.getAttribute('src') !== next) frame.setAttribute('src', next);
    return frame;
  };

  // ---- navigation ----
  function go(view) {
    state.note = null;
    state.graphFocus = '';
    clearSearch(false);
    state.view = view;
    render();
    remember();
  }

  function openNote(entry) {
    const url = safePath(entry && entry.url);
    if (!url) return;
    if (!state.note) state.back = state.view;
    state.note = { rel: entry.rel || '', title: entry.heading || entry.title || entry.rel || '', url };
    clearSearch(false);
    render();
    remember();
  }

  // Remember the view and the open note for this browser tab, so a reload lands in the same place. Not in
  // the address bar: OpenClaw highlights a sidebar entry only when the page parameters match it exactly,
  // and "Memory" going grey in the sidebar costs more than a shareable URL gains.
  function remember() {
    const saved = { view: state.note ? state.back : state.view, note: state.note ? state.note.rel : '' };
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(saved)); } catch { /* storage blocked */ }
  }

  // ---- search ----
  let searchTimer = null;
  let searchSeq = 0;
  function clearSearch(focus) {
    state.query = '';
    state.results = null;
    state.active = -1;
    search.value = '';
    if (focus) search.focus();
  }
  async function runSearch() {
    const q = search.value.trim();
    state.query = q;
    if (q.length < 2 || !state.model || !state.model.ok) { state.results = null; render(); return; }
    const seq = ++searchSeq;
    let hits = [];
    try {
      const res = await fetch(safePath(state.model.base) + '_search?q=' + encodeURIComponent(q), { credentials: 'same-origin', headers: { accept: 'application/json' } });
      hits = res.ok ? await res.json() : [];
    } catch { hits = []; }
    if (seq !== searchSeq || search.value.trim() !== q) return;
    state.results = Array.isArray(hits) ? hits : [];
    state.active = state.results.length ? 0 : -1;
    live.textContent = state.results.length ? `${state.results.length} results` : 'No results';
    render();
  }
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 160); });
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { clearSearch(false); render(); search.blur(); return; }
    const hits = state.results || [];
    if (!hits.length) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      state.active = (state.active + (ev.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
      render();
      ev.preventDefault();
    } else if (ev.key === 'Enter' && state.active >= 0) {
      openNote(hits[state.active]);
      ev.preventDefault();
    }
  });
  const onKey = (ev) => {
    if (ev.key !== '/' || ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
    if (!root.isConnected || !root.offsetParent) return;
    ev.preventDefault();
    search.focus();
  };
  document.addEventListener('keydown', onKey);

  // ---- rendering ----
  function render() {
    for (const [id, b] of tabButtons) {
      const current = id === (state.note ? state.back : state.view) && state.results === null;
      b.classList.toggle('is-current', current);
      b.setAttribute('aria-selected', String(current));
      b.tabIndex = current ? 0 : -1;
    }
    root.classList.toggle('is-framed', state.results === null && !!state.model && state.model.ok && (!!state.note || state.view === 'browse' || state.view === 'graph'));
    body.replaceChildren();

    if (state.error) { body.append(problem(state.error)); return; }
    if (state.loading && !state.model) { body.append(skeleton()); return; }
    const model = state.model;
    if (!model) return;
    if (state.results !== null) { body.append(results(state.results)); return; }
    if (state.note) { body.append(reader(), frameTo(state.note.url, 'none')); return; }
    if (state.view === 'browse') { body.append(frameTo(model.base, 'tree')); return; }
    if (state.view === 'graph') { body.append(frameTo(model.graphUrl + (state.graphFocus ? '?focus=' + encodeURIComponent(state.graphFocus) : ''), '')); return; }
    if (state.view === 'timeline') { body.append(timeline(model)); return; }
    body.append(overview(model));
  }

  function problem(err) {
    const box = el('div', 'wsd-problem');
    box.append(icon('brain', 'wsd-icon wsd-problem-icon'), el('p', 'wsd-problem-title', err.error));
    if (err.hint) box.append(el('p', 'wsd-problem-hint', err.hint));
    const retry = button('wsd-button', 'Try again', 'refresh');
    retry.addEventListener('click', () => reload());
    box.append(retry);
    return box;
  }

  function skeleton() {
    const wrap = el('div', 'wsd-overview');
    const cards = el('div', 'wsd-cards');
    for (let i = 0; i < 3; i++) cards.append(el('div', 'wsd-card wsd-skeleton'));
    wrap.append(cards);
    for (let i = 0; i < 4; i++) wrap.append(el('div', 'wsd-row wsd-skeleton'));
    return wrap;
  }

  function sectionTitle(text, extra) {
    const h = el('div', 'wsd-section-title');
    h.append(el('h2', '', text));
    if (extra) h.append(extra);
    return h;
  }

  function overview(model) {
    const wrap = el('div', 'wsd-overview');
    wrap.append(sectionTitle('Core memory'));
    const cards = el('div', 'wsd-cards');
    for (const section of model.sections) {
      const e = section.entry;
      const card = el('button', 'wsd-card');
      card.type = 'button';
      const top = el('div', 'wsd-card-top');
      top.append(icon(SECTION_ICONS[section.id] || 'file', 'wsd-icon wsd-card-icon'), el('span', 'wsd-card-label', section.label));
      const excerpt = el('p', 'wsd-card-excerpt', e.excerpt || section.note || '');
      excerpt.dir = 'auto';
      const foot = el('div', 'wsd-card-foot');
      foot.append(el('span', 'wsd-card-file', e.rel), el('span', '', [since(e.mtime), e.words ? `${e.words} words` : ''].filter(Boolean).join(' · ')));
      card.append(top, excerpt, foot);
      card.addEventListener('click', () => openNote(e));
      cards.append(card);
    }
    for (const gap of model.missing) {
      const card = el('div', 'wsd-card is-absent');
      const top = el('div', 'wsd-card-top');
      top.append(icon(SECTION_ICONS[gap.id] || 'file', 'wsd-icon wsd-card-icon'), el('span', 'wsd-card-label', gap.label));
      card.append(top, el('p', 'wsd-card-excerpt', `No ${gap.file} in this workspace yet.`));
      cards.append(card);
    }
    wrap.append(cards);

    const more = model.recent.length > RECENT_ON_OVERVIEW ? button('wsd-link', `All ${model.recent.length} in Timeline`, '') : null;
    if (more) more.addEventListener('click', () => go('timeline'));
    wrap.append(sectionTitle('Recent', more));
    if (!model.recent.length) wrap.append(empty('No dated memory yet', 'Notes the agent writes under memory/ appear here, newest first.'));
    else wrap.append(noteList(model.recent.slice(0, RECENT_ON_OVERVIEW)));
    return wrap;
  }

  function timeline(model) {
    const wrap = el('div', 'wsd-timeline');
    if (!model.recent.length) { wrap.append(empty('No dated memory yet', 'Notes the agent writes under memory/ appear here, grouped by day.')); return wrap; }
    for (const day of groupDays(model.recent)) {
      const group = el('section', 'wsd-day');
      const label = day.when === 'today' ? 'Today' : day.when === 'yesterday' ? 'Yesterday' : longDay(day.day);
      const head = el('h2', 'wsd-day-title', label);
      head.append(el('span', 'wsd-day-count', String(day.notes.length)));
      group.append(head, noteList(day.notes));
      wrap.append(group);
    }
    return wrap;
  }

  function longDay(iso) {
    try { return new Date(iso + 'T12:00:00Z').toLocaleDateString(locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); } catch { return iso; }
  }

  function noteList(notes) {
    const list = el('ul', 'wsd-notes');
    for (const note of notes) {
      const item = el('li');
      const row = el('button', 'wsd-row');
      row.type = 'button';
      const main = el('span', 'wsd-row-main');
      const title = el('span', 'wsd-row-title', note.heading && note.heading !== note.title ? `${note.title} — ${note.heading}` : note.title);
      title.dir = 'auto';
      main.append(title);
      if (note.excerpt) { const ex = el('span', 'wsd-row-excerpt', note.excerpt); ex.dir = 'auto'; main.append(ex); }
      const when = el('time', 'wsd-row-time', since(note.mtime));
      when.dateTime = new Date(note.mtime).toISOString();
      when.title = new Date(note.mtime).toLocaleString(locale);
      row.append(icon('file', 'wsd-icon wsd-row-icon'), main, when);
      row.addEventListener('click', () => openNote(note));
      item.append(row);
      list.append(item);
    }
    return list;
  }

  function empty(title, text) {
    const box = el('div', 'wsd-empty');
    box.append(el('p', 'wsd-empty-title', title), el('p', 'wsd-empty-text', text));
    return box;
  }

  function results(hits) {
    const wrap = el('div', 'wsd-results');
    // Sentence case, not the uppercase section style: that would shout the operator's own words back.
    wrap.append(el('p', 'wsd-results-title', hits.length ? `${hits.length} ${hits.length === 1 ? 'note mentions' : 'notes mention'} “${state.query}”` : `Nothing mentions “${state.query}”`));
    if (!hits.length) { wrap.append(empty('No results', 'Try fewer words, or a word from the note’s title.')); return wrap; }
    const list = el('ul', 'wsd-notes');
    hits.forEach((hit, i) => {
      const item = el('li');
      const row = el('button', 'wsd-row' + (i === state.active ? ' is-active' : ''));
      row.type = 'button';
      const main = el('span', 'wsd-row-main');
      const title = el('span', 'wsd-row-title', hit.title || hit.rel);
      title.dir = 'auto';
      main.append(title);
      const snip = el('span', 'wsd-row-excerpt');
      snip.dir = 'auto';
      for (const piece of markText(hit.snippet)) snip.append(piece.marked ? el('mark', '', piece.text) : document.createTextNode(piece.text));
      main.append(snip);
      row.append(icon('file', 'wsd-icon wsd-row-icon'), main, el('span', 'wsd-row-time', hit.folder || ''));
      row.addEventListener('click', () => openNote(hit));
      item.append(row);
      list.append(item);
      if (i === state.active) queueMicrotask(() => row.scrollIntoView({ block: 'nearest' }));
    });
    wrap.append(list);
    return wrap;
  }

  function reader() {
    const bar = el('div', 'wsd-reader');
    const back = button('wsd-icon-button', '', 'back', 'Back');
    back.addEventListener('click', () => go(state.back));
    const titles = el('div', 'wsd-reader-titles');
    const t = el('h2', 'wsd-reader-title', state.note.title);
    t.dir = 'auto';
    titles.append(t, el('span', 'wsd-reader-path', state.note.rel));
    const actions = el('div', 'wsd-reader-actions');
    const inGraph = button('wsd-button', 'Graph', 'graph', 'Show this note in the graph');
    inGraph.addEventListener('click', () => {
      const rel = state.note.rel;
      go('graph');
      state.graphFocus = rel;
      render();
    });
    const full = el('a', 'wsd-button');
    full.href = state.note.url;
    full.target = '_blank';
    full.rel = 'noopener';
    full.title = 'Open the full page in a new tab';
    full.append(icon('external'), el('span', '', 'Open'));
    actions.append(inGraph, full);
    bar.append(back, titles, actions);
    return bar;
  }

  // ---- the frame tells us where the reader went ----
  const onMessage = (ev) => {
    if (ev.source !== frame.contentWindow || !ev.data || ev.data.type !== 'websidian:navigate') return;
    const d = ev.data;
    const url = safePath(String(d.url || '').split('?')[0]);
    if (!url || !d.rel) return;
    if (state.note) {
      // A link followed inside the reading pane: follow along in the header.
      if (d.rel === state.note.rel) return;
      state.note = { rel: String(d.rel), title: String(d.title || d.rel), url };
      const bar = body.querySelector('.wsd-reader');
      if (bar) bar.replaceWith(reader());
      remember();
    } else if (state.view === 'graph') {
      // A node clicked in the graph: read it in the reading pane rather than inside the graph tab.
      openNote({ rel: String(d.rel), title: String(d.title || d.rel), url });
    }
  };
  window.addEventListener('message', onMessage);

  // ---- data ----
  async function reload() {
    refresh.disabled = true;
    root.classList.add('is-loading');
    const result = await loadModel(host);
    refresh.disabled = false;
    root.classList.remove('is-loading');
    if (context.signal && context.signal.aborted) return;
    state.loading = false;
    if (!result.ok) { state.error = result; state.model = null; }
    else { state.error = null; state.model = result.model; }
    describe();
    if (state.pendingNote && state.model && state.model.ok) {
      const rel = state.pendingNote;
      state.pendingNote = '';
      const known = [...state.model.sections.map(s => s.entry), ...state.model.recent].find(n => n.rel === rel);
      const url = known ? known.url : safePath(state.model.base) + rel.replace(/\.md$/i, '').split('/').map(encodeURIComponent).join('/');
      state.back = state.view;
      state.note = { rel, title: known ? (known.heading || known.title) : rel.replace(/\.md$/i, '').split('/').pop(), url };
    }
    // A frame the reader is using is left alone; everything else is redrawn with the new model.
    if (!root.classList.contains('is-framed') || !frame.getAttribute('src')) render();
  }

  function describe() {
    const model = state.model;
    const agent = host && host.agents && host.agents.selectedId ? host.agents.selectedId : '';
    if (!model || !model.ok) { subtitle.textContent = ''; return; }
    // One vault today. This is where a per-agent vault will be chosen once OpenClaw agents point at
    // different workspaces (the backend's memoryVault() already takes a slug).
    subtitle.replaceChildren();
    const bits = [model.title, agent ? `agent ${agent}` : '', model.updated ? `updated ${since(model.updated)}` : ''].filter(Boolean);
    subtitle.textContent = bits.join(' · ');
  }

  refresh.addEventListener('click', () => { reload(); });
  reload();

  // Fresh when it matters: when the operator comes back to the tab, and once a minute while the
  // overview or the timeline is on screen.
  const onVisible = () => { if (document.visibilityState === 'visible' && !root.classList.contains('is-framed')) reload(); };
  document.addEventListener('visibilitychange', onVisible);
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible' && !root.classList.contains('is-framed') && state.results === null) reload();
  }, REFRESH_MS);

  // The host owns the theme; hand every change down to the frame without reloading it.
  const syncTheme = () => {
    const theme = hostTheme();
    if (theme === state.theme) return;
    state.theme = theme;
    root.setAttribute('data-theme', theme);
    if (frame.contentWindow) frame.contentWindow.postMessage({ type: 'websidian:theme', theme }, '*');
  };
  const unsubscribe = host && typeof host.subscribe === 'function' ? host.subscribe(() => { syncTheme(); describe(); }) : null;
  const media = matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', syncTheme);

  return {
    update(next) {
      syncTheme();
      const p = (next && next.props) || {};
      if (TABS.some(t => t.id === p.view) && !state.note && p.view !== state.view) { state.view = p.view; render(); }
    },
    focus() { search.focus(); },
    dispose() {
      clearInterval(timer);
      clearTimeout(searchTimer);
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('message', onMessage);
      media.removeEventListener('change', syncTheme);
      if (unsubscribe) unsubscribe();
      root.remove();
    },
  };
}
