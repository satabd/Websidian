// The native Memory page inside OpenClaw's Control UI.
//
// It draws OpenClaw-shaped chrome — a title, a tab bar, cards — from the model the plugin's Gateway
// route returns, and hands the actual reading of a note to Websidian in shell mode inside the content
// area. Nothing here fetches the vault itself: OpenClaw's workspace stays the one source of truth and
// the plugin's route is the only thing that reads it.
//
// Plain ES modules, no framework and no build step: the Gateway serves this directory's .js and .css
// files as they are (readPluginControlUiAssets), so what ships is what you read here.

const MEMORY_ROUTE = '/plugins/websidian-memory';
const JSON_PATH = MEMORY_ROUTE + '/memory.json';
const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'graph', label: 'Graph' },
  { id: 'search', label: 'Search' },
];

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};

function stamp(ms) {
  if (!ms) return '';
  try { return new Date(ms).toLocaleString(); } catch { return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); }
}

// "dark", "light", or "" when the colour says nothing (not a colour, or fully transparent).
// Kept pure so it can be tested without a browser.
export function themeFromColour(colour) {
  const m = /rgba?\(([^)]+)\)/.exec(String(colour || ''));
  if (!m) return '';
  const parts = m[1].split(',').map(v => parseFloat(v));
  const [r, g, b] = parts;
  if (parts.length > 3 && parts[3] === 0) return '';
  if (![r, g, b].every(Number.isFinite)) return '';
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128 ? 'dark' : 'light';
}

// Is the host drawing a dark surface? Read it off the page rather than guessing from a class name, so
// this keeps working whatever the Control UI's theme is called.
export function hostTheme(doc = document) {
  const probe = doc.body || doc.documentElement;
  const theme = themeFromColour(probe ? getComputedStyle(probe).backgroundColor : '');
  if (theme) return theme;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Websidian in shell mode: its own note tree, search, backlinks and local graph, none of the chrome
// OpenClaw already draws.
export function shellUrl(url, theme) {
  if (!url) return '';
  const sep = url.indexOf('?') >= 0 ? '&' : '?';
  return url + sep + 'shell=1' + (theme ? '&theme=' + encodeURIComponent(theme) : '');
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
    if (res.ok) return { ok: true, model: await res.json(), url };
    lastError = `${res.status} ${res.statusText}`;
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'OpenClaw did not authorise this page. Enable Custom plugin UI in Settings → Labs, restart the Gateway and reload.' };
    }
  }
  return { ok: false, error: `The Websidian plugin did not answer (${lastError}). Check that it is enabled and that ui.enabled is true.` };
}

// One card per named memory file. A file the workspace does not have is shown, greyed, rather than
// silently missing: "no DREAMS.md yet" is information.
function cards(model, open, theme) {
  const wrap = el('div', 'wsd-cards');
  for (const section of model.sections) {
    const card = el('button', 'wsd-card');
    card.type = 'button';
    card.append(el('h3', 'wsd-card-title', section.label));
    card.append(el('div', 'wsd-card-meta', section.entry.rel + ' · ' + stamp(section.entry.mtime)));
    if (section.note) card.append(el('div', 'wsd-card-note', section.note));
    card.addEventListener('click', () => open(section.entry));
    wrap.append(card);
  }
  for (const gap of model.missing) {
    const card = el('div', 'wsd-card wsd-card-absent');
    card.append(el('h3', 'wsd-card-title', gap.label));
    card.append(el('div', 'wsd-card-meta', 'no ' + gap.file + ' in this workspace yet'));
    wrap.append(card);
  }
  if (!wrap.childElementCount) wrap.append(el('p', 'wsd-empty', 'This workspace has no memory files yet.'));
  return wrap;
}

function noteList(notes, open) {
  const list = el('ul', 'wsd-notes');
  for (const note of notes) {
    const item = el('li');
    const link = el('button', 'wsd-note');
    link.type = 'button';
    // dir="auto" belongs on the title alone: on the row it would flip the whole layout for an Arabic
    // note and move the timestamp to the other side of every such line.
    const title = el('span', 'wsd-note-title', note.title);
    title.dir = 'auto';
    link.append(title);
    link.append(el('span', 'wsd-note-meta', stamp(note.mtime)));
    link.addEventListener('click', () => open(note));
    item.append(link);
    list.append(item);
  }
  return list;
}

export function mountMemoryPage(container, context) {
  const host = context.host;
  const state = { tab: 'overview', model: null, error: '', note: null, theme: hostTheme() };

  const root = el('div', 'websidian-memory');
  const header = el('header', 'wsd-header');
  const heading = el('div', 'wsd-heading');
  const title = el('h1', 'wsd-title', 'Memory');
  const subtitle = el('p', 'wsd-subtitle', 'Loading…');
  heading.append(title, subtitle);
  const actions = el('div', 'wsd-actions');
  const refresh = el('button', 'wsd-button', 'Refresh');
  refresh.type = 'button';
  actions.append(refresh);
  header.append(heading, actions);

  const tabs = el('nav', 'wsd-tabs');
  const tabButtons = new Map();
  for (const tab of TABS) {
    const button = el('button', 'wsd-tab', tab.label);
    button.type = 'button';
    button.addEventListener('click', () => { state.note = null; select(tab.id); });
    tabButtons.set(tab.id, button);
    tabs.append(button);
  }

  const body = el('div', 'wsd-body');
  root.append(header, tabs, body);
  container.append(root);

  // One frame, reused: switching tabs should not throw away a loaded Websidian.
  const frame = el('iframe', 'wsd-frame');
  frame.setAttribute('title', 'Websidian');
  frame.setAttribute('referrerpolicy', 'no-referrer');

  function frameTo(url) {
    const next = shellUrl(url, state.theme);
    if (frame.getAttribute('src') !== next) frame.setAttribute('src', next);
    return frame;
  }

  function openNote(entry) {
    state.note = entry;
    select('note');
  }

  function crumb() {
    const bar = el('div', 'wsd-crumb');
    const back = el('button', 'wsd-link', '← Memory');
    back.type = 'button';
    back.addEventListener('click', () => { state.note = null; select('overview'); });
    bar.append(back);
    if (state.note) bar.append(el('span', 'wsd-crumb-title', state.note.rel));
    return bar;
  }

  function render() {
    body.replaceChildren();
    for (const [id, button] of tabButtons) button.classList.toggle('is-current', id === state.tab && !state.note);
    if (state.error) {
      body.append(el('p', 'wsd-error', state.error));
      return;
    }
    const model = state.model;
    if (!model) { body.append(el('p', 'wsd-empty', 'Loading…')); return; }
    if (!model.ok) { body.append(el('p', 'wsd-error', model.error || 'The Memory page has no vault to read.')); return; }

    if (state.note) {
      body.append(crumb(), frameTo(state.note.url));
      return;
    }
    if (state.tab === 'graph') { body.append(frameTo(model.graphUrl)); return; }
    if (state.tab === 'search') { body.append(frameTo(model.base)); return; }
    if (state.tab === 'timeline') {
      if (!model.timeline.length) { body.append(el('p', 'wsd-empty', 'No dated memory entries yet.')); return; }
      const wrap = el('div', 'wsd-timeline');
      for (const day of model.timeline) {
        wrap.append(el('h2', 'wsd-day', day.label));
        wrap.append(noteList(day.notes, openNote));
      }
      body.append(wrap);
      return;
    }
    const overview = el('div', 'wsd-overview');
    overview.append(cards(model, openNote, state.theme));
    if (model.recent.length) {
      overview.append(el('h2', 'wsd-day', 'Recent memory'));
      overview.append(noteList(model.recent.slice(0, 10), openNote));
    }
    body.append(overview);
  }

  function select(tab) {
    state.tab = tab;
    render();
  }

  async function reload() {
    refresh.disabled = true;
    const result = await loadModel(host);
    refresh.disabled = false;
    if (context.signal.aborted) return;
    if (!result.ok) { state.error = result.error; state.model = null; }
    else { state.error = ''; state.model = result.model; }
    const model = state.model;
    title.textContent = (model && model.label) || 'Memory';
    // The agent whose workspace this is. One vault today; this is where a per-agent vault will be
    // chosen once OpenClaw agents point at different workspaces.
    const agent = host.agents && host.agents.selectedId ? host.agents.selectedId : '';
    subtitle.textContent = model && model.ok
      ? [model.title, agent ? 'agent ' + agent : '', model.counts.dated + ' dated ' + (model.counts.dated === 1 ? 'entry' : 'entries')].filter(Boolean).join(' · ')
      : '';
    render();
  }

  refresh.addEventListener('click', () => { reload(); });
  reload();

  // The host owns the theme; hand every change down to the frame without reloading it.
  const syncTheme = () => {
    const theme = hostTheme();
    if (theme === state.theme) return;
    state.theme = theme;
    if (frame.contentWindow) frame.contentWindow.postMessage({ type: 'websidian:theme', theme }, '*');
  };
  const unsubscribe = typeof host.subscribe === 'function' ? host.subscribe(syncTheme) : null;
  const media = matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', syncTheme);

  return {
    update() { syncTheme(); },
    focus() { refresh.focus(); },
    dispose() {
      media.removeEventListener('change', syncTheme);
      if (unsubscribe) unsubscribe();
      root.remove();
    },
  };
}
