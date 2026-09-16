'use strict';
// Auth, rate limiting, LRU cache cap, SEO helpers, webhook signature, search index.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { safeEqual, enforce, parseCookies } = require('../src/auth');
const { RateLimiter } = require('../src/ratelimit');
const { RenderCache } = require('../src/cache');
const { verifyGithub, runCommand } = require('../src/hooks');
const { SearchIndex, snippet } = require('../src/search');
const { sitemap, robots, pageTags } = require('../src/seo');

function fakeRes() {
  const res = { headers: {}, code: 200, body: null, cookies: [], redirected: null };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.status = c => { res.code = c; return res; };
  res.type = () => res;
  res.send = b => { res.body = b; return res; };
  res.cookie = (n, v, o) => { res.cookies.push({ n, v, o }); return res; };
  res.redirect = (c, u) => { res.code = c; res.redirected = u; return res; };
  return res;
}
const fakeVault = auth => ({ slug: 's', title: 'S', auth, siteUrl: () => '/s/' });

test('safeEqual is constant-length aware', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('basic auth: challenge, wrong password, right password', () => {
  const v = fakeVault({ users: { sat: 'pw:1' } });
  let res = fakeRes();
  assert.equal(enforce(v, { headers: {}, query: {} }, res), true); assert.equal(res.code, 401); assert.match(res.headers['WWW-Authenticate'], /Basic realm="S"/);
  res = fakeRes();
  assert.equal(enforce(v, { headers: { authorization: 'Basic ' + Buffer.from('sat:nope').toString('base64') }, query: {} }, res), true); assert.equal(res.code, 401);
  res = fakeRes();
  assert.equal(enforce(v, { headers: { authorization: 'Basic ' + Buffer.from('sat:pw:1').toString('base64') }, query: {} }, res), null);
});

test('token auth: query sets cookie and redirects, cookie grants access, otherwise 403', () => {
  const v = fakeVault({ token: 'secret' });
  let res = fakeRes();
  assert.equal(enforce(v, { headers: {}, query: { token: 'secret' }, originalUrl: '/s/Page?token=secret&embed=1' }, res), true);
  assert.equal(res.code, 302); assert.equal(res.redirected, '/s/Page?embed=1'); assert.equal(res.cookies[0].v, 'secret'); assert.equal(res.cookies[0].o.httpOnly, true);
  res = fakeRes();
  assert.equal(enforce(v, { headers: { cookie: 'x=1; websidian_s=secret' }, query: {} }, res), null);
  res = fakeRes();
  assert.equal(enforce(v, { headers: { cookie: 'websidian_s=wrong' }, query: {} }, res), true); assert.equal(res.code, 403);
  assert.deepEqual(parseCookies('a=1; b=%20x'), { a: '1', b: ' x' });
  assert.equal(enforce(fakeVault(null), { headers: {}, query: {} }, fakeRes()), null);
});

test('rate limiter: fixed window per key', () => {
  const rl = new RateLimiter({ limit: 3, windowMs: 1000 });
  const t = 1_000_000;
  assert.equal(rl.hit('a', t).ok, true); assert.equal(rl.hit('a', t).ok, true); assert.equal(rl.hit('a', t).remaining, 0);
  const fourth = rl.hit('a', t); assert.equal(fourth.ok, false); assert.equal(fourth.retryAfterSec, 1);
  assert.equal(rl.hit('b', t).ok, true, 'other keys unaffected');
  assert.equal(rl.hit('a', t + 1001).ok, true, 'window reset');
});

test('cache LRU cap evicts the least recently used entry', async () => {
  const c = new RenderCache({ enabled: false, maxEntries: 2 });
  const ok = async () => true;
  await c.set('s', 'a', { stamp: '1', html: 'a' });
  await c.set('s', 'b', { stamp: '1', html: 'b' });
  await c.get('s', 'a', '1', ok);                 // a is now most recent
  await c.set('s', 'c', { stamp: '1', html: 'c' }); // evicts b
  assert.equal(c.size(), 2);
  assert.equal(await c.get('s', 'b', '1', ok), null);
  assert.equal((await c.get('s', 'a', '1', ok)).html, 'a');
  assert.equal(c.stats.evictions, 1);
  await c.clear(); assert.equal(c.size(), 0);
});

test('github webhook signature', () => {
  const body = Buffer.from('{"ref":"refs/heads/main"}');
  const sig = 'sha256=' + crypto.createHmac('sha256', 'hook-secret').update(body).digest('hex');
  assert.equal(verifyGithub(body, 'hook-secret', sig), true);
  assert.equal(verifyGithub(body, 'other', sig), false);
  assert.equal(verifyGithub(body, 'hook-secret', 'sha1=abc'), false);
  assert.equal(verifyGithub(body, 'hook-secret', undefined), false);
});

test('runCommand captures output and failure', async () => {
  const ok = await runCommand([process.execPath, '-e', 'console.log("pulled")'], process.cwd());
  assert.equal(ok.ok, true); assert.match(ok.stdout, /pulled/);
  const bad = await runCommand([process.execPath, '-e', 'process.exit(3)'], process.cwd());
  assert.equal(bad.ok, false); assert.equal(bad.code, 3);
});

test('search index: fuzzy, prefix, title boost, highlighted snippet, rebuild on change', async () => {
  const notes = [
    { rel: 'a.md', title: 'Insurance Claims', folder: '', mtimeMs: 1, size: 1, data: {} },
    { rel: 'b.md', title: 'Pharmacy', folder: 'x', mtimeMs: 1, size: 1, data: { aliases: ['Dispensing'] } },
  ];
  const texts = { 'a.md': 'How claims are submitted to the insurer.', 'b.md': 'The pharmacist dispenses medication and files an insurance claim for it.' };
  const vault = { slug: 's', listHash: 'h', visibleNotesSorted: () => notes };
  const idx = new SearchIndex();
  const ms = await idx.ensure(vault, async (v, rel) => ({ text: texts[rel] }));
  let hits = idx.query(ms, 'insurance claim');
  assert.equal(hits[0].rel, 'a.md', 'title match ranks first');
  assert.equal(hits.length, 2);
  assert.match(hits[1].snippet, /<mark>insurance<\/mark> <mark>claim<\/mark>/);
  assert.equal(idx.query(ms, 'pharmasist').length, 1, 'fuzzy');
  assert.equal(idx.query(ms, 'dispens')[0].rel, 'b.md', 'prefix + alias');
  assert.equal(await idx.ensure(vault, async () => { throw new Error('should not rebuild'); }), ms, 'same version reuses index');
  notes[0].mtimeMs = 2;
  const ms2 = await idx.ensure(vault, async (v, rel) => ({ text: texts[rel] }));
  assert.notEqual(ms2, ms, 'changed stamp rebuilds');
  assert.equal(snippet('a <b> c', ['b']), 'a &lt;<mark>b</mark>&gt; c');
});

test('seo: sitemap, robots, page tags', () => {
  const vault = { slug: 's', title: 'S', brand: {}, auth: null, notes: new Map([['A.md', 1]]), siteUrl: () => '/s/', noteUrl: r => '/s/' + r.replace(/\.md$/, ''), visibleNotesSorted: () => [{ rel: 'A.md', mtimeMs: Date.UTC(2026, 0, 2) }] };
  const config = { publicUrl: 'https://d.example/' };
  assert.match(sitemap(vault, config), /<loc>https:\/\/d\.example\/s\/A<\/loc><lastmod>2026-01-02<\/lastmod>/);
  const rb = robots([vault, { ...vault, slug: 'p', auth: { token: 'x' }, siteUrl: () => '/p/' }], config, '');
  assert.match(rb, /Disallow: \/p\//); assert.match(rb, /Sitemap: https:\/\/d\.example\/s\/sitemap\.xml/); assert.ok(!rb.includes('Sitemap: https://d.example/p/'));
  const tags = pageTags({ vault, config, rel: 'A.md', title: 'A & B', data: { lang: 'ar' }, bodyHtml: '<h1>x</h1><p>First <b>para</b>.</p><img src="/s/i.png">' });
  assert.ok(tags.includes('<link rel="canonical" href="https://d.example/s/A">'));
  assert.ok(tags.includes('<meta property="og:title" content="A &amp; B">'));
  assert.ok(tags.includes('<meta property="og:description" content="First para.">'));
  assert.ok(tags.includes('<meta property="og:image" content="https://d.example/s/i.png">'));
  assert.ok(tags.includes('<meta name="twitter:card" content="summary_large_image">'));
  assert.ok(!tags.includes('noindex'));
  assert.ok(pageTags({ vault: { ...vault, auth: { token: 1 } }, config, rel: 'A.md', title: 'A', data: {}, bodyHtml: '' }).includes('noindex'));
});
