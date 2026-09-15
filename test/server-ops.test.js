'use strict';
// End-to-end for the operational and hardening features: auth, sitemap/robots,
// snippets, bases, health, JSON logs, rate limit, purge, git webhook.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { makeVault, FIXTURE } = require('./helpers');

const PORT = 19080 + Math.floor(Math.random() * 1000);
let tmp, proc, logLines = '';
const url = p => `http://127.0.0.1:${PORT}${p}`;
const get = (p, headers = {}) => fetch(url(p), { headers, redirect: 'manual' });
const post = (p, body, headers = {}) => fetch(url(p), { method: 'POST', body, headers, redirect: 'manual' });

before(async () => {
  tmp = makeVault({
    ...FIXTURE,
    'Catalogue.base': 'views:\n  - type: table\n    name: All\n    order: [file.name, status]\n',
    '.obsidian/appearance.json': JSON.stringify({ enabledCssSnippets: ['brand'] }),
    '.obsidian/snippets/brand.css': 'h1 { color: teal; }',
  });
  fs.writeFileSync(path.join(tmp.root, 'pulled.js'), 'require("fs").writeFileSync("Pulled.md", "# Pulled\\n"); console.log("ok")');
  const cfg = path.join(tmp.root, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({
    port: PORT, host: '127.0.0.1', cacheDir: 'cache', warm: false, log: 'json', publicUrl: 'https://docs.example', adminToken: 'admin-1', rateLimit: { search: 3 },
    sites: [
      { slug: 's', title: 'Site S', root: '.', excludeStatus: ['draft'], webhook: { secret: 'hook-1', command: [process.execPath, 'pulled.js'] } },
      { slug: 'p', title: 'Private', root: '.', auth: { token: 'tok-1' } },
      { slug: 'b', title: 'Basic', root: '.', auth: { users: { sat: 'pw' } } },
    ],
  }));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, MD2HTML_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', d => { logLines += d; if (logLines.includes('listening')) resolve(); });
    proc.stderr.on('data', d => { logLines += d; });
    proc.on('exit', code => reject(new Error('server exited ' + code + '\n' + logLines)));
    setTimeout(() => reject(new Error('server did not start\n' + logLines)), 10000);
  });
});
after(() => { if (proc) proc.kill(); if (tmp) tmp.rm(); });

test('health and stats', async () => {
  const h = await (await get('/_health')).json();
  assert.equal(h.ok, true); assert.equal(h.sites.length, 3); assert.equal(h.sites[0].notes, 4);
  const s = await (await get('/_stats')).json();
  assert.equal(s.cache.maxEntries, 2000); assert.deepEqual(s.sites[0].snippets, ['brand']); assert.equal(s.sites[1].auth, true);
});

test('token-protected site: 403, then ?token= sets cookie and redirects, cookie works, search protected too', async () => {
  assert.equal((await get('/p/')).status, 403);
  const r = await get('/p/sub/Second?token=tok-1');
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/p/sub/Second');
  const cookie = r.headers.get('set-cookie').split(';')[0];
  assert.ok(cookie.startsWith('md2html_p=tok-1'));
  assert.equal((await get('/p/sub/Second', { cookie })).status, 200);
  assert.equal((await get('/p/_search?q=bravo')).status, 403);
  assert.equal((await get('/p/_search?q=bravo', { cookie })).status, 200);
  const html = await (await get('/p/', { cookie })).text();
  assert.ok(html.includes('<meta name="robots" content="noindex">'));
});

test('basic-auth site', async () => {
  const r = await get('/b/'); assert.equal(r.status, 401); assert.match(r.headers.get('www-authenticate'), /^Basic realm="Basic"/);
  assert.equal((await get('/b/', { authorization: 'Basic ' + Buffer.from('sat:pw').toString('base64') })).status, 200);
  assert.equal((await get('/b/', { authorization: 'Basic ' + Buffer.from('sat:no').toString('base64') })).status, 401);
});

test('sitemap, robots, canonical', async () => {
  const sm = await get('/s/sitemap.xml'); assert.equal(sm.status, 200); assert.match(sm.headers.get('content-type'), /xml/);
  const xml = await sm.text();
  assert.ok(xml.includes('<loc>https://docs.example/s/sub/Second</loc>') && !xml.includes('Draft'));
  const rb = await (await get('/robots.txt')).text();
  assert.ok(rb.includes('Disallow: /p/') && rb.includes('Disallow: /b/') && rb.includes('Sitemap: https://docs.example/s/sitemap.xml'));
  const html = await (await get('/s/')).text();
  assert.ok(html.includes('<link rel="canonical" href="https://docs.example/s/Home">'));
  assert.ok(html.includes('<meta property="og:image" content="https://docs.example/s/img/pic.png">'));
});

test('vault CSS snippet served and linked; unknown snippet 404', async () => {
  const html = await (await get('/s/')).text();
  assert.match(html, /<link rel="stylesheet" href="\/s\/_snippets\/brand\.css\?v=\d+">/);
  const css = await get('/s/_snippets/brand.css'); assert.equal(css.status, 200); assert.equal(await css.text(), 'h1 { color: teal; }');
  assert.equal((await get('/s/_snippets/nope.css')).status, 404);
});

test('base file renders as a page, appears in navigation, raw still available', async () => {
  const r = await get('/s/Catalogue.base'); assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<h1>Catalogue<\/h1><div class="base"/);
  assert.match(html, /<th>Name<\/th><th>status<\/th>/);
  assert.ok(html.includes('href="/s/sub/Second">Second</a>') && !html.includes('>Draft<'), 'hidden notes excluded');
  assert.match(html, /class="nav-note is-current nav-base" href="\/s\/Catalogue\.base"/);
  assert.equal(r.headers.get('etag') && r.headers.get('cache-control'), 'no-cache');
  assert.equal((await get('/s/Catalogue.base', { 'if-none-match': r.headers.get('etag') })).status, 304);
  const raw = await get('/s/Catalogue.base?raw'); assert.equal(raw.status, 200); assert.ok((await raw.text()).startsWith('views:'));
});

test('search: minisearch results with highlighted snippets, then rate limited', async () => {
  const hits = await (await get('/s/_search?q=bravo')).json();
  assert.equal(hits.length, 1); assert.equal(hits[0].url, '/s/sub/Second'); assert.match(hits[0].snippet, /<mark>bravo<\/mark>/);
  await get('/s/_search?q=x1'); await get('/s/_search?q=x2');
  const limited = await get('/s/_search?q=x3');
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) >= 1);
});

test('purge requires the admin token and clears the cache', async () => {
  assert.equal((await post('/_purge')).status, 401);
  await get('/s/sub/Second');
  const before = (await (await get('/_stats')).json()).cache.entries; assert.ok(before >= 1);
  const r = await post('/_purge?site=s', null, { authorization: 'Bearer admin-1' });
  assert.deepEqual(await r.json(), { ok: true, site: 's' });
  const afterSite = (await (await get('/_stats')).json()).cache.entries;
  assert.ok(afterSite < before, 'site s entries gone, other sites kept');
  const all = await post('/_purge', null, { authorization: 'Bearer admin-1' });
  assert.deepEqual(await all.json(), { ok: true, site: 'all' });
  assert.equal((await (await get('/_stats')).json()).cache.entries, 0);
  assert.equal((await post('/_purge?site=zzz', null, { authorization: 'Bearer admin-1' })).status, 404);
});

test('git webhook: signature checked, command runs in the vault, index rescans', async () => {
  const body = JSON.stringify({ ref: 'refs/heads/main' });
  assert.equal((await post('/_hooks/git/s', body, { 'x-hub-signature-256': 'sha256=bad' })).status, 401);
  assert.equal((await post('/_hooks/git/p', body)).status, 404, 'no webhook configured');
  const sig = 'sha256=' + crypto.createHmac('sha256', 'hook-1').update(body).digest('hex');
  const ping = await post('/_hooks/git/s', body, { 'x-hub-signature-256': sig, 'x-github-event': 'ping' });
  assert.deepEqual(await ping.json(), { ok: true, pong: true });
  const r = await post('/_hooks/git/s', body, { 'x-hub-signature-256': sig, 'x-github-event': 'push' });
  const j = await r.json(); assert.equal(r.status, 200); assert.equal(j.ok, true); assert.match(j.stdout, /ok/);
  assert.equal((await get('/s/Pulled')).status, 200, 'note created by the command is served after rescan');
  assert.equal((await post('/_hooks/git/s?token=hook-1', body)).status, 200, 'plain token also accepted');
});

test('json logs carry http events', async () => {
  await get('/s/');
  await new Promise(r => setTimeout(r, 100));
  const events = logLines.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
  assert.ok(events.some(e => e.event === 'vault' && e.site === 's'));
  assert.ok(events.some(e => e.event === 'http' && e.path === '/s/' && e.status === 200));
  assert.ok(events.some(e => e.event === 'webhook' && e.ok === true));
  assert.ok(events.some(e => e.event === 'purge'));
});
