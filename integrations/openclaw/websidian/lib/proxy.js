// The pages the plugin serves on the Gateway under /plugins/websidian/ (auth: "plugin", so this module is the
// gate): a sign-in page, a status page, and a reverse proxy to the supervised Websidian server at
// /plugins/websidian/w/<slug>/... . The browser signs in once with the Gateway token (or the configured
// password) and gets an HttpOnly session cookie scoped to /plugins/websidian; the proxy then signs every
// request in to Websidian with a shared secret header (proxyAuth), so Websidian itself needs no login.
import crypto from 'node:crypto';
import http from 'node:http';
import { ROUTE_PREFIX, WEBSIDIAN_MOUNT } from './sites.js';
import { PROXY_SECRET_HEADER, PROXY_USER_HEADER } from './supervisor.js';

export const COOKIE_NAME = 'websidian_session';
// Sign-in and sign-out forms carry a nonce that must match this SameSite=Lax cookie (double submit). The Origin
// header cannot be relied on: the Gateway answers with `Referrer-Policy: no-referrer`, so browsers send
// `Origin: null` on same-origin form posts.
export const CSRF_COOKIE = 'websidian_csrf';
export const MAX_BODY_BYTES = 20 * 1024 * 1024;
const LOGIN_PATH = ROUTE_PREFIX + '/login';
const LOGOUT_PATH = ROUTE_PREFIX + '/logout';
const STATUS_JSON_PATH = ROUTE_PREFIX + '/status.json';

// Request headers forwarded to Websidian. Everything else is dropped: cookie and authorization (the Gateway's
// session), x-forwarded-*, and any client-supplied x-websidian-* header.
export const REQUEST_HEADER_ALLOWLIST = new Set([
  'content-type', 'accept', 'accept-language', 'if-none-match', 'if-modified-since', 'range', 'x-requested-with', 'user-agent', 'content-length',
]);
// Response headers passed back to the browser. Set-Cookie is never forwarded.
export const RESPONSE_HEADER_ALLOWLIST = new Set([
  'content-type', 'content-length', 'etag', 'last-modified', 'cache-control', 'content-security-policy', 'x-content-type-options',
  'location', 'retry-after', 'content-disposition', 'accept-ranges', 'content-range', 'x-render',
]);

export function cleanUser(user) {
  const u = String(user == null ? '' : user).replace(/[^A-Za-z0-9 ._@-]/g, '').trim().slice(0, 64).trim();
  return u || 'openclaw';
}

export function filterRequestHeaders(headers, secret, user) {
  const out = [];
  for (const [k, v] of headers) if (REQUEST_HEADER_ALLOWLIST.has(k.toLowerCase())) out.push([k.toLowerCase(), v]);
  out.push(['accept-encoding', 'identity']); // bodies are streamed through unchanged
  out.push([PROXY_SECRET_HEADER, secret]);
  out.push([PROXY_USER_HEADER, cleanUser(user)]);
  return out;
}

export function filterResponseHeaders(headers) {
  return Object.entries(headers).filter(([k]) => RESPONSE_HEADER_ALLOWLIST.has(k.toLowerCase())).map(([k, v]) => [k.toLowerCase(), v]);
}

const DOT_SEGMENT = /(^|\/)(\.|%2e){1,2}(\/|$)/i;

// Path + query to request from Websidian for a Gateway request whose raw (still percent-encoded) path is
// `rawPath`. null when the request must be refused: not under `basePath`, dot segments (which an HTTP client
// would normalise out of the mount), encoded slashes/backslashes/NULs, or control characters.
export function upstreamTarget(rawPath, query, basePath) {
  if (typeof rawPath !== 'string') return null;
  for (const c of rawPath + (query || '')) if (c.charCodeAt(0) < 0x21 || c === '#' || c === '\\') return null;
  if (rawPath !== basePath && !rawPath.startsWith(basePath + '/')) return null;
  const rest = rawPath.slice(basePath.length);
  if (DOT_SEGMENT.test(rest) || /%(2f|5c|00)/i.test(rest)) return null;
  return rawPath + (query ? '?' + query : '');
}

// --------------------------------------------------------------------------------------------------
// Sign-in
// --------------------------------------------------------------------------------------------------

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb) && String(a).length === String(b).length;
}

// What a browser must present: {kind: "token" | "password" | "none", secret, hint}. The Gateway's own auth
// (gateway.auth.token / gateway.auth.password, or the OPENCLAW_GATEWAY_TOKEN / _PASSWORD variables) by default;
// ui.password when ui.auth is "password". A SecretRef object cannot be verified here.
export function expectedCredential(cfg, ui, env = process.env) {
  if (ui.auth === 'password') {
    return ui.password ? { kind: 'password', secret: ui.password, hint: 'the password from plugins.entries.websidian.config.ui.password' }
      : { kind: 'none', secret: '', hint: 'ui.auth is "password" but ui.password is empty' };
  }
  const auth = (cfg && cfg.gateway && cfg.gateway.auth) || {};
  const envToken = String(env.OPENCLAW_GATEWAY_TOKEN || '');
  const envPassword = String(env.OPENCLAW_GATEWAY_PASSWORD || '');
  if (auth.mode === 'password' || (!auth.mode && (typeof auth.password === 'string' || envPassword))) {
    const secret = typeof auth.password === 'string' ? auth.password : envPassword;
    return secret ? { kind: 'password', secret, hint: 'the Gateway password' } : { kind: 'none', secret: '', hint: 'the Gateway password is not a plain string (a SecretRef?); set ui.auth: "password" and ui.password instead' };
  }
  const secret = typeof auth.token === 'string' ? auth.token : envToken;
  if (secret) return { kind: 'token', secret, hint: 'the Gateway token (gateway.auth.token)' };
  return { kind: 'none', secret: '', hint: 'the Gateway has no token or password to sign in with; set gateway.auth.token, or ui.auth: "password" and ui.password' };
}

export function signSession(secret, user, exp) {
  return crypto.createHmac('sha256', secret).update(`${user}|${exp}`).digest('base64url');
}

export function makeSession(secret, user, hours) {
  const exp = Math.floor(Date.now() / 1000 + hours * 3600);
  return { value: `${encodeURIComponent(user)}.${exp}.${signSession(secret, user, exp)}`, exp };
}

export function readSession(secret, value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 3) return null;
  let user;
  try { user = decodeURIComponent(parts[0]); } catch { return null; }
  const exp = parseInt(parts[1], 10);
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return null;
  return safeEqual(parts[2], signSession(secret, user, exp)) ? user : null;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) { try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); } }
  }
  return out;
}

// Only targets inside the plugin's own pages survive a login redirect.
export function safeNext(next) {
  const s = String(next || '');
  if (!s.startsWith(ROUTE_PREFIX + '/') && s !== ROUTE_PREFIX) return ROUTE_PREFIX + '/';
  if (s.startsWith('//') || /[\r\n\\]/.test(s) || s.startsWith(LOGIN_PATH)) return ROUTE_PREFIX + '/';
  return s;
}

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PAGE_CSS = 'body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:2rem;color:#e6e6e6;background:#121212}main{max-width:52rem;margin:auto}h1{font-size:1.4rem}a{color:#8ab4f8}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.35rem .5rem;border-bottom:1px solid #333;vertical-align:top}pre{white-space:pre-wrap;background:#000;padding:1rem;max-height:50vh;overflow:auto;font-size:13px}input,button{font:inherit;padding:.4rem .6rem;border-radius:4px;border:1px solid #555;background:#1e1e1e;color:#eee}button{cursor:pointer;background:#2d5bd1;border-color:#2d5bd1;color:#fff}.err{color:#ff8a80}.ok{color:#9ccc65}.muted{color:#999}code{background:#222;padding:0 .25rem}';

function page(title, body, { refresh = 0 } = {}) {
  const meta = refresh ? `<meta http-equiv="refresh" content="${refresh}">` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${meta}<title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><main>${body}</main></body></html>`;
}

export function loginPage({ next, error, hint, csrf = '' }) {
  return page('Websidian: sign in', `
<h1>Websidian</h1>
<p>Sign in with ${esc(hint)}.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="${LOGIN_PATH}">
  <input type="hidden" name="next" value="${esc(next)}">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <p><input type="password" name="secret" autocomplete="current-password" autofocus size="40" placeholder="Token or password"> <button type="submit">Sign in</button></p>
</form>`);
}

export function statusPage(status, user, csrf = '') {
  const rows = status.sites.map(s => `<tr><td>${esc(s.title)}</td><td><code>${esc(s.slug)}</code></td><td><a href="${esc(s.url)}">open</a>${s.edit ? ` · <a href="${esc(s.url)}_edit/">edit</a>` : ''}</td><td class="muted">${esc(s.root)}${s.untrusted ? '' : ' · trusted'}</td></tr>`).join('');
  const state = status.running ? '<span class="ok">running</span>' : `<span class="err">not running</span>${status.error ? ` - ${esc(status.error)}` : ''}`;
  const skew = status.versionSkew ? `<p class="err">The Websidian runtime (${esc(status.appVersion.revision)}) and this plugin (${esc(status.pluginVersion.revision)}) are on different revisions: re-run the installer.</p>` : '';
  const tail = !status.running && status.logTail.length ? `<h2>server.log</h2><pre>${esc(status.logTail.join(''))}</pre>` : '';
  return page('Websidian', `
<h1>Websidian <span class="muted">behind the Gateway</span></h1>
<p>Status: ${state}. <span class="muted">Signed in as ${esc(user)} · <form method="post" action="${LOGOUT_PATH}" style="display:inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit">sign out</button></form></span></p>
${skew}
<table><tr><th>Vault</th><th>Slug</th><th>Pages</th><th>Folder</th></tr>${rows || '<tr><td colspan="4" class="muted">No vaults configured (plugins.entries.websidian.config.vaults).</td></tr>'}</table>
<p class="muted">Runtime: <code>${esc(status.appDir)}</code>${status.appDirPresent ? '' : ' (missing)'} · port ${status.port} · node <code>${esc(status.node)}</code>${status.appVersion ? ` · revision ${esc(status.appVersion.revision || '?')}` : ''}</p>
${tail}`, { refresh: status.running ? 0 : 10 });
}

// --------------------------------------------------------------------------------------------------
// Handler
// --------------------------------------------------------------------------------------------------

// One Set-Cookie shape for both surfaces: HttpOnly, SameSite=Lax and scoped to the plugin prefix, so it
// never travels to another plugin or to the Control UI itself.
export function cookieFor(req, value, maxAgeSec, name = COOKIE_NAME) {
  return `${name}=${value}; Path=${ROUTE_PREFIX}; HttpOnly; SameSite=Lax${isSecure(req) ? '; Secure' : ''}; Max-Age=${maxAgeSec}`;
}

// The session cookie for a browser the *Gateway* has already authenticated (native.js): the same signed
// session a successful sign-in on the form would mint, so the proxy below needs no second code path.
export function gatewaySessionCookie(req, secret, hours, user = 'operator') {
  return cookieFor(req, makeSession(secret, user, hours).value, Math.round(hours * 3600));
}

function isSecure(req) {
  if (req.socket && req.socket.encrypted) return true;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

// An explicit foreign Origin is refused; a missing or "null" Origin (no-referrer policy) is decided by the CSRF nonce.
function foreignOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return false;
  try { return new URL(origin).host !== String(req.headers.host || ''); } catch { return true; }
}

export function csrfMatches(cookieHeader, formValue) {
  const expected = parseCookies(cookieHeader)[CSRF_COOKIE] || '';
  const presented = String(formValue || '');
  return expected.length >= 16 && presented.length === expected.length && safeEqual(expected, presented);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', d => { size += d.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, type, body, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extraHeaders });
  res.end(body);
}

class LoginLimiter { // failed sign-ins per address: 10 per 5 minutes
  constructor() { this.hits = new Map(); }
  allowed(ip) { const now = Date.now(); const h = (this.hits.get(ip) || []).filter(t => now - t < 300_000); this.hits.set(ip, h); return h.length < 10; }
  fail(ip) { (this.hits.get(ip) || (this.hits.set(ip, []), this.hits.get(ip))).push(Date.now()); }
}

// The reverse proxy to the supervised Websidian, shared by the stand-alone pages (this module) and the
// native Memory surface (native.js): one implementation of the header allowlists, the path rules and the
// 502 page. `user` is the name Websidian records for the request (proxyAuth), never a browser credential.
export function createProxy({ supervisor, log = () => {} }) {
  function proxy(req, res, user, rawPath, query) {
    const rt = supervisor.runtime || supervisor.resolve();
    const target = upstreamTarget(rawPath, query, rt.basePath);
    if (!target) return send(res, 400, 'text/plain; charset=utf-8', 'Bad request');
    const length = parseInt(req.headers['content-length'] || '0', 10);
    if (length > MAX_BODY_BYTES) return send(res, 413, 'text/plain; charset=utf-8', 'Request body too large');
    const headers = Object.fromEntries(filterRequestHeaders(Object.entries(req.headers), supervisor.secrets(rt).proxy_secret, user));
    const upstream = http.request({ host: '127.0.0.1', port: rt.port, method: req.method, path: target, headers, timeout: 120_000 }, (up) => {
      const out = Object.fromEntries(filterResponseHeaders(up.headers));
      res.writeHead(up.statusCode || 502, out);
      if (req.method === 'HEAD') { up.resume(); res.end(); return; }
      up.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', async (err) => {
      log(`websidian: proxy error for ${rawPath}: ${err.message}`);
      if (res.headersSent) { res.destroy(); return; }
      const status = await supervisor.status();
      send(res, 502, 'text/html; charset=utf-8', page('Websidian is not running', `<h1>502 Websidian is not running</h1><p>${esc(status.error || err.message)}</p>${status.logTail.length ? `<pre>${esc(status.logTail.join(''))}</pre>` : ''}<p><a href="${ROUTE_PREFIX}/">Status page</a></p>`, { refresh: 5 }));
      supervisor.ensure().catch(() => {});
    });
    if (req.method === 'GET' || req.method === 'HEAD') upstream.end();
    else req.pipe(upstream);
    return true;
  }
  return proxy;
}

// The route handler for `api.registerHttpRoute({ path: "/plugins/websidian", match: "prefix", auth: "plugin" })`.
// Returns true when it answered (the Gateway treats anything but `false` as handled).
export function createRouteHandler({ supervisor, getSettings, getConfig, log = () => {}, env = process.env }) {
  const limiter = new LoginLimiter();

  // A fresh nonce for every page that carries a form; the cookie and the hidden field must agree on the post.
  const csrfFor = (req, res) => {
    const nonce = crypto.randomBytes(18).toString('base64url');
    res.setHeader('set-cookie', cookieFor(req, nonce, 3600, CSRF_COOKIE));
    return nonce;
  };
  const csrfOk = (req, form) => !foreignOrigin(req) && csrfMatches(req.headers.cookie, form.get('csrf'));

  const sessionUser = (req) => {
    const secrets = supervisor.secrets();
    return readSession(secrets.session_secret, parseCookies(req.headers.cookie)[COOKIE_NAME]);
  };

  const redirect = (res, to) => { res.writeHead(302, { location: to, 'cache-control': 'no-store' }); res.end(); };

  async function handleLogin(req, res, url) {
    const settings = getSettings();
    const expected = expectedCredential(getConfig(), settings.ui, env);
    if (req.method === 'GET' || req.method === 'HEAD') {
      return send(res, 200, 'text/html; charset=utf-8', loginPage({ next: safeNext(url.searchParams.get('next')), error: '', hint: expected.hint, csrf: csrfFor(req, res) }));
    }
    if (req.method !== 'POST') return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
    const ip = (req.socket && req.socket.remoteAddress) || '?';
    let form;
    try { form = new URLSearchParams(await readBody(req)); } catch { return send(res, 413, 'text/plain; charset=utf-8', 'Form too large'); }
    const next = safeNext(form.get('next'));
    if (!csrfOk(req, form)) {
      log(`websidian: sign-in form refused from ${ip} (origin=${req.headers.origin || '-'}, csrf ${form.get('csrf') ? 'mismatch' : 'missing'})`);
      return send(res, 403, 'text/html; charset=utf-8', loginPage({ next, error: 'The sign-in form had expired or came from another site; try again.', hint: expected.hint, csrf: csrfFor(req, res) }));
    }
    if (!limiter.allowed(ip)) return send(res, 429, 'text/html; charset=utf-8', loginPage({ next, error: 'Too many failed sign-ins; try again in a few minutes.', hint: expected.hint, csrf: csrfFor(req, res) }), { 'retry-after': '300' });
    const presented = String(form.get('secret') || '');
    if (expected.kind === 'none' || !presented || !safeEqual(presented, expected.secret)) {
      limiter.fail(ip);
      log(`websidian: sign-in refused from ${ip}`);
      return send(res, 401, 'text/html; charset=utf-8', loginPage({ next, error: expected.kind === 'none' ? expected.hint : 'That is not the ' + expected.kind + '.', hint: expected.hint, csrf: csrfFor(req, res) }));
    }
    const user = expected.kind === 'password' && settings.ui.auth === 'password' ? 'websidian' : 'operator';
    const session = makeSession(supervisor.secrets().session_secret, user, settings.ui.sessionHours);
    res.writeHead(302, { location: next, 'set-cookie': cookieFor(req, session.value, Math.round(settings.ui.sessionHours * 3600)), 'cache-control': 'no-store' });
    res.end();
    return true;
  }

  const proxy = createProxy({ supervisor, log });

  return async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const rawPath = (req.url || '/').split('?')[0];
    const pathname = url.pathname;
    if (pathname !== ROUTE_PREFIX && !pathname.startsWith(ROUTE_PREFIX + '/')) return false;
    if (pathname === LOGIN_PATH) return handleLogin(req, res, url);

    const user = sessionUser(req);
    if (pathname === LOGOUT_PATH) {
      if (req.method !== 'POST') return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
      let form;
      try { form = new URLSearchParams(await readBody(req)); } catch { return send(res, 413, 'text/plain; charset=utf-8', 'Form too large'); }
      if (!csrfOk(req, form)) return send(res, 403, 'text/plain; charset=utf-8', 'Sign-out form refused');
      res.writeHead(302, { location: LOGIN_PATH, 'set-cookie': [cookieFor(req, '', 0), cookieFor(req, '', 0, CSRF_COOKIE)], 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    if (!user) {
      const wantsPage = (req.method === 'GET' || req.method === 'HEAD') && !pathname.endsWith('.json');
      if (wantsPage) return redirect(res, `${LOGIN_PATH}?next=${encodeURIComponent(rawPath + (url.search || ''))}`);
      return send(res, 401, 'application/json; charset=utf-8', JSON.stringify({ error: 'unauthenticated', login_url: LOGIN_PATH }));
    }
    if (pathname === ROUTE_PREFIX || pathname === ROUTE_PREFIX + '/') {
      if (pathname === ROUTE_PREFIX) return redirect(res, ROUTE_PREFIX + '/');
      const status = await supervisor.status();
      if (!status.running) supervisor.ensure().catch(() => {});
      return send(res, 200, 'text/html; charset=utf-8', statusPage(status, user, csrfFor(req, res)));
    }
    if (pathname === STATUS_JSON_PATH) return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(await supervisor.status()));
    if (pathname === WEBSIDIAN_MOUNT || pathname.startsWith(WEBSIDIAN_MOUNT + '/')) {
      const rt = supervisor.runtime || supervisor.resolve();
      // The Gateway may sit behind a path prefix (ui.publicBase); Websidian is mounted at that prefix + the mount.
      const prefixed = rt.basePath === WEBSIDIAN_MOUNT ? rawPath : rt.basePath + rawPath.slice(WEBSIDIAN_MOUNT.length);
      return proxy(req, res, user, prefixed, url.search.slice(1));
    }
    return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  };
}
