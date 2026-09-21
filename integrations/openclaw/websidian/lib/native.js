// The Memory surface inside OpenClaw's Control UI.
//
// A second HTTP route, `/plugins/websidian/memory`, registered with auth: "gateway" — the Gateway
// authenticates the operator before this handler runs, so there is no second sign-in. It serves:
//
//   GET /plugins/websidian/memory              the Memory dashboard as HTML, for a host that frames the
//                                              tab because it has no native view for it
//   GET /plugins/websidian/memory/memory.json  the same model as JSON, for the native Control UI page
//
// Both answers also mint the plugin's own session cookie for the browser that asked. That cookie is the
// one a successful sign-in on the form mints — same secret, same HMAC, same scope — so the notes the page
// links to are read through the existing, tested proxy at /plugins/websidian/w/… with no second code path
// and no new kind of credential. Minting it is safe precisely because the Gateway already said who this is.
import { memoryModel, memoryVault } from './memory.js';
import { gatewaySessionCookie } from './proxy.js';
import { MEMORY_PREFIX, publicPrefix, WEBSIDIAN_MOUNT } from './sites.js';

const JSON_PATH = MEMORY_PREFIX + '/memory.json';
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Same-origin URL prefix the notes of `slug` are read at. A path, never an absolute URL: the Gateway may
// be reached by several names and the browser is already on the right one.
export function siteBase(ui, slug) {
  return publicPrefix(ui.publicBase) + WEBSIDIAN_MOUNT + '/' + slug + '/';
}

// Notes always open in shell mode: Websidian keeps its sidebar, search, backlinks and local graph, and
// drops the chrome OpenClaw already draws.
export function noteHref(url, theme) {
  return url + '?shell=1' + (theme ? '&theme=' + encodeURIComponent(theme) : '');
}

export function themeOf(value) {
  return value === 'dark' || value === 'light' ? value : '';
}

// The whole model the page (native or framed) renders.
export function memoryPayload(settings, { now = Date.now() } = {}) {
  const ui = settings.ui;
  const vault = memoryVault(settings.vaults, ui.memory.vault);
  if (!vault) {
    return { ok: false, error: 'websidian: no vault to read memory from. Add one to plugins.entries.websidian.config.vaults.', label: ui.memory.label, sections: [], missing: [], recent: [], timeline: [], sites: [] };
  }
  const base = siteBase(ui, vault.slug);
  const model = memoryModel(vault, { base, now });
  return {
    ok: true,
    label: ui.memory.label,
    base,
    graphUrl: base + '_graph',
    exploreUrl: base + '_explore',
    // Read-only by design: the Memory page never offers the editor, whatever the vault allows elsewhere.
    editable: false,
    ...model,
    sites: settings.vaults.filter(v => !v.external && v.path).map(v => ({ slug: v.slug, title: v.title })),
  };
}

const PAGE_CSS = [
  ':root{color-scheme:light dark}',
  '*{box-sizing:border-box}',
  'body{font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:24px;color:#1f2328;background:#fff}',
  '@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}}',
  ':root[data-theme="dark"] body{color:#e6edf3;background:#0d1117}',
  ':root[data-theme="light"] body{color:#1f2328;background:#fff}',
  'main{max-width:64rem;margin:0 auto}',
  'h1{font-size:1.5rem;margin:0 0 .25rem}',
  '.sub{color:#8b949e;margin:0 0 1.5rem}',
  '.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:12px;margin-bottom:2rem}',
  '.card{border:1px solid rgba(140,140,140,.35);border-radius:10px;padding:14px 16px;text-decoration:none;color:inherit;display:block}',
  '.card:hover{border-color:#58a6ff}',
  '.card h2{font-size:.95rem;margin:0 0 .2rem}',
  '.card .meta{font-size:.8rem;color:#8b949e}',
  '.card.absent{opacity:.55}',
  '.day{margin:0 0 .4rem;font-size:.85rem;text-transform:uppercase;letter-spacing:.04em;color:#8b949e}',
  'ul.notes{list-style:none;margin:0 0 1.4rem;padding:0}',
  'ul.notes li{padding:.3rem 0;border-bottom:1px solid rgba(140,140,140,.2)}',
  'ul.notes a{color:inherit;text-decoration:none}',
  'ul.notes a:hover{text-decoration:underline}',
  '.links a{margin-inline-end:1rem}',
  '.err{color:#d1242f}',
].join('\n');

const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

// The framed fallback: everything the native page shows, rendered on the server. A host with no native
// view for the tab still gets a working Memory page from the plugin alone.
export function memoryPage(payload, { theme = '' } = {}) {
  const head = `<!doctype html><html lang="en"${theme ? ` data-theme="${esc(theme)}"` : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(payload.label || 'Memory')}</title><style>${PAGE_CSS}</style></head><body><main>`;
  const foot = '</main></body></html>';
  if (!payload.ok) return head + `<h1>${esc(payload.label || 'Memory')}</h1><p class="err">${esc(payload.error)}</p>` + foot;
  const card = (label, entry) => entry
    ? `<a class="card" href="${esc(noteHref(entry.url, theme))}"><h2>${esc(label)}</h2><div class="meta">${esc(entry.rel)} · ${esc(stamp(entry.mtime))}</div></a>`
    : `<div class="card absent"><h2>${esc(label)}</h2><div class="meta">not in this workspace yet</div></div>`;
  const cards = [
    ...payload.sections.map(s => card(s.label, s.entry)),
    ...payload.missing.map(m => card(m.label, null)),
  ].join('');
  const days = payload.timeline.map(d => `<h3 class="day">${esc(d.label)}</h3><ul class="notes">${d.notes.map(n => `<li><a href="${esc(noteHref(n.url, theme))}" dir="auto">${esc(n.title)}</a></li>`).join('')}</ul>`).join('');
  return head + `<h1>${esc(payload.label)}</h1>
<p class="sub">${esc(payload.title)} · ${payload.counts.dated} dated ${payload.counts.dated === 1 ? 'entry' : 'entries'}</p>
<div class="cards">${cards}</div>
${days ? `<h2>Recent memory</h2>${days}` : '<p class="sub">No dated memory entries yet.</p>'}
<p class="links"><a href="${esc(payload.graphUrl)}?shell=1">Graph</a><a href="${esc(payload.exploreUrl)}?shell=1">Explore</a><a href="${esc(noteHref(payload.base, theme))}">Open the vault</a></p>` + foot;
}

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // The Control UI frames this page from its own origin; nothing else may.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
    'referrer-policy': 'no-referrer',
    ...extra,
  });
  res.end(body);
  return true;
}

// The handler for api.registerHttpRoute({ path: MEMORY_PREFIX, match: "prefix", auth: "gateway" }).
// Returns true when it answered, false to let another route try.
export function createMemoryHandler({ supervisor, getSettings, log = () => {} }) {
  return async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;
    if (pathname !== MEMORY_PREFIX && !pathname.startsWith(MEMORY_PREFIX + '/')) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');

    const settings = getSettings();
    if (!settings.ui.enabled || !settings.ui.memory.enabled) return send(res, 404, 'text/plain; charset=utf-8', 'The Websidian Memory page is disabled');

    // The browser is here because the Gateway let it through. Give it the plugin's own session so the
    // notes this page links to open through the existing proxy without a second sign-in.
    let extra = {};
    try {
      extra = { 'set-cookie': gatewaySessionCookie(req, supervisor.secrets().session_secret, settings.ui.sessionHours) };
    } catch (err) { log(`websidian: could not mint the memory session (${err && err.message ? err.message : err})`); }

    const payload = memoryPayload(settings);
    if (pathname === JSON_PATH) return send(res, payload.ok ? 200 : 503, 'application/json; charset=utf-8', JSON.stringify(payload), extra);
    if (pathname === MEMORY_PREFIX || pathname === MEMORY_PREFIX + '/') {
      if (payload.ok) supervisor.ensure().catch(() => {});
      return send(res, 200, 'text/html; charset=utf-8', memoryPage(payload, { theme: themeOf(url.searchParams.get('theme')) }), extra);
    }
    return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  };
}
