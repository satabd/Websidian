'use strict';
// Per-site access control, two flavours that can be combined:
//   auth.users  { name: password }   -> HTTP Basic auth (browser prompt)
//   auth.token  "secret"             -> ?token=secret once, then a cookie
// A request signed in by a trusted reverse proxy (top-level proxyAuth, req.proxyUser) passes.
// Both use constant-time comparison. Passwords live in the config file, so
// keep that file out of the vault and out of version control.

const crypto = require('crypto');

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookieName(slug) { return 'md2html_' + slug.replace(/[^a-z0-9]/gi, '_'); }

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

// Returns null when the request may proceed, otherwise sends the challenge and returns true.
// `limiter` (a RateLimiter, optional) counts FAILED Basic-auth attempts per client IP; once an IP
// is over the budget it gets 429 without its credentials being checked. Successful requests
// never consume the budget (browsers send the Authorization header on every request).
function enforce(vault, req, res, limiter) {
  const auth = vault.auth;
  if (!auth || (!auth.users && !auth.token)) return null;
  // Signed in by a trusted reverse proxy (see proxyauth.js): no Basic auth or token needed.
  if (req.proxyUser) return null;

  if (auth.token) {
    const q = req.query.token;
    if (q !== undefined && safeEqual(q, auth.token)) {
      res.cookie(cookieName(vault.slug), auth.token, { httpOnly: true, sameSite: 'lax', path: vault.siteUrl(), maxAge: 30 * 24 * 3600 * 1000 });
      const clean = req.originalUrl.replace(/([?&])token=[^&]*&?/, '$1').replace(/[?&]$/, '');
      res.redirect(302, clean); return true;
    }
    const c = parseCookies(req.headers.cookie)[cookieName(vault.slug)];
    if (c !== undefined && safeEqual(c, auth.token)) return null;
  }

  if (auth.users) {
    const h = req.headers.authorization || '';
    if (h.startsWith('Basic ')) {
      const ip = req.ip || (req.socket && req.socket.remoteAddress) || '?';
      if (limiter) {
        const p = limiter.peek(ip);
        if (!p.ok) { res.set('Retry-After', String(p.retryAfterSec)); res.status(429).type('text').send('Too many failed sign-in attempts. Try again later.'); return true; }
      }
      const [user, ...rest] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
      const pass = rest.join(':');
      const expected = Object.prototype.hasOwnProperty.call(auth.users, user) ? auth.users[user] : undefined;
      if (expected !== undefined && safeEqual(pass, expected)) return null;
      if (limiter) limiter.hit(ip);
    }
    res.set('WWW-Authenticate', `Basic realm="${vault.title.replace(/"/g, '')}", charset="UTF-8"`);
    res.status(401).type('text').send('Authentication required'); return true;
  }

  res.status(403).type('text').send('This site needs an access token: open the link you were given (…?token=…)'); return true;
}

module.exports = { enforce, safeEqual, parseCookies, cookieName };
