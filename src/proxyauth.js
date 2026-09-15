'use strict';
// Trusted reverse proxy sign-in (top-level `proxyAuth`), for running Websidian behind a
// proxy that already has its own login, e.g. the Hermes Agent dashboard plugin backend:
//
//   "proxyAuth": { "secret": "<random, >= 32 chars>", "secretHeader": "x-websidian-proxy-secret",
//                  "userHeader": "x-websidian-user", "allowFrom": ["127.0.0.1", "::1"] }
//
// A request is proxy-authenticated when it comes from an allowed address AND carries the
// shared secret. It then passes the site `auth` gate and counts as signed in to the editor
// as the user named in userHeader (still subject to `edit` being configured and edit.allowFrom).
// The secret is the gate: the proxy is expected to strip client-supplied x-websidian-* headers,
// but nothing here relies on that.

const { safeEqual } = require('./auth');
const { ipAllowed } = require('./editor');

const DEFAULTS = { secretHeader: 'x-websidian-proxy-secret', userHeader: 'x-websidian-user', allowFrom: ['127.0.0.1', '::1'] };
const MIN_SECRET = 32;

// Normalised settings, or null (with a warning through `warn`) when absent or unusable.
function resolveProxyAuth(raw, warn = () => {}) {
  if (raw === undefined || raw === null || raw === false) return null;
  if (typeof raw !== 'object') { warn('proxyAuth must be an object; proxy sign-in is disabled'); return null; }
  const secret = typeof raw.secret === 'string' ? raw.secret : '';
  if (secret.length < MIN_SECRET) { warn(`proxyAuth.secret is missing or shorter than ${MIN_SECRET} characters; proxy sign-in is disabled`); return null; }
  const header = (v, def) => (typeof v === 'string' && /^[A-Za-z0-9-]+$/.test(v) ? v.toLowerCase() : def);
  return {
    secret,
    secretHeader: header(raw.secretHeader, DEFAULTS.secretHeader),
    userHeader: header(raw.userHeader, DEFAULTS.userHeader),
    allowFrom: Array.isArray(raw.allowFrom) && raw.allowFrom.length ? raw.allowFrom.map(String) : DEFAULTS.allowFrom,
  };
}

function cleanUser(value) {
  const u = String(Array.isArray(value) ? value[0] : value == null ? '' : value).replace(/[^A-Za-z0-9 ._@-]/g, '').trim().slice(0, 64).trim();
  return u || 'proxy';
}

// Express middleware: sets req.proxyUser (string) on proxy-authenticated requests.
// `trustProxy` false -> the address check uses the socket peer, never X-Forwarded-For.
function middleware(cfg, { trustProxy, log }) {
  return (req, res, next) => {
    if (!cfg) return next();
    const presented = req.headers[cfg.secretHeader];
    if (presented === undefined) return next();
    const ip = trustProxy ? req.ip : (req.socket && req.socket.remoteAddress);
    const ipOk = ipAllowed(ip, cfg.allowFrom);
    const secretOk = typeof presented === 'string' && safeEqual(presented, cfg.secret);
    if (ipOk && secretOk) req.proxyUser = cleanUser(req.headers[cfg.userHeader]);
    else log('proxy-auth-denied', { ip: ip || '?', reason: !ipOk ? 'address' : 'secret', path: req.originalUrl });
    next();
  };
}

module.exports = { resolveProxyAuth, middleware, cleanUser, MIN_SECRET };
