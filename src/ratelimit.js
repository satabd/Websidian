'use strict';
// Fixed-window rate limiter keyed by client IP. Enough to stop a script from
// hammering the search endpoint; put a reverse proxy in front for more.

class RateLimiter {
  constructor({ limit = 60, windowMs = 60_000 } = {}) {
    this.limit = limit; this.windowMs = windowMs; this.buckets = new Map();
    this._sweep = setInterval(() => { const now = Date.now(); for (const [k, b] of this.buckets) if (b.reset <= now) this.buckets.delete(k); }, windowMs);
    if (this._sweep.unref) this._sweep.unref();
  }
  // Returns { ok, remaining, retryAfterSec }.
  hit(key, now = Date.now()) {
    let b = this.buckets.get(key);
    if (!b || b.reset <= now) { b = { count: 0, reset: now + this.windowMs }; this.buckets.set(key, b); }
    b.count++;
    return { ok: b.count <= this.limit, remaining: Math.max(0, this.limit - b.count), retryAfterSec: Math.ceil((b.reset - now) / 1000) };
  }
  // Like hit() but does not count: is this key already over its budget?
  peek(key, now = Date.now()) {
    const b = this.buckets.get(key);
    if (!b || b.reset <= now) return { ok: true, remaining: this.limit, retryAfterSec: 0 };
    return { ok: b.count < this.limit, remaining: Math.max(0, this.limit - b.count), retryAfterSec: Math.ceil((b.reset - now) / 1000) };
  }
  middleware() {
    return (req, res, next) => {
      const r = this.hit(req.ip || req.socket.remoteAddress || '?');
      res.set('X-RateLimit-Remaining', String(r.remaining));
      if (r.ok) return next();
      res.set('Retry-After', String(r.retryAfterSec));
      res.status(429).json({ error: 'Too many requests', retryAfter: r.retryAfterSec });
    };
  }
}

module.exports = { RateLimiter };
