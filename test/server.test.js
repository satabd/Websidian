'use strict';
// End-to-end: start the real server on a scratch vault and talk HTTP to it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { makeVault, FIXTURE } = require('./helpers');

const PORT = 18080 + Math.floor(Math.random() * 1000);
let tmp, proc;
const url = p => `http://127.0.0.1:${PORT}${p}`;
const get = (p, headers = {}) => fetch(url(p), { headers, redirect: 'manual' });

before(async () => {
  tmp = makeVault(FIXTURE);
  const cfg = path.join(tmp.root, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({
    port: PORT, host: '127.0.0.1', cacheDir: 'cache', warm: false, basePath: '/docs',
    sites: [
      { slug: 's', title: 'Site S', root: '.', excludeStatus: ['draft'], brand: { name: 'Brand S', backLink: { label: 'Back home', url: 'https://example.com' } } },
      { slug: 't', title: 'Site T', root: '.' },
    ],
  }));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, MD2HTML_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', d => { out += d; if (out.includes('listening')) resolve(); });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', code => reject(new Error('server exited ' + code + '\n' + out)));
    setTimeout(() => reject(new Error('server did not start\n' + out)), 10000);
  });
});
after(() => { if (proc) proc.kill(); if (tmp) tmp.rm(); });

test('root redirects under basePath; sites index lists both vaults', async () => {
  const r0 = await get('/'); assert.equal(r0.status, 302); assert.equal(r0.headers.get('location'), '/docs/');
  const r = await get('/docs/'); assert.equal(r.status, 200);
  const html = await r.text(); assert.ok(html.includes('/docs/s/') && html.includes('Site T'));
});

test('home page, branding, footer', async () => {
  const r = await get('/docs/s/'); assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('<title>Home Page · Brand S</title>'));
  assert.ok(html.includes('class="back-link" href="https://example.com">Back home'));
  assert.match(html, /Linked from.*href="\/docs\/s\/sub\/Second"/s);
  assert.ok(html.includes('href="/docs/_static/app.css'));
  assert.ok(!html.includes('Draft'), 'hidden note not in navigation');
});

test('ETag revalidation returns 304 until the note changes', async () => {
  const r1 = await get('/docs/s/sub/Second'); const etag = r1.headers.get('etag');
  assert.ok(etag && etag.startsWith('W/"'));
  assert.equal(r1.headers.get('cache-control'), 'no-cache');
  const r2 = await get('/docs/s/sub/Second', { 'if-none-match': etag }); assert.equal(r2.status, 304);
  await new Promise(r => setTimeout(r, 20));
  fs.appendFileSync(path.join(tmp.root, 'sub', 'Second.md'), '\nnew line\n');
  const r3 = await get('/docs/s/sub/Second', { 'if-none-match': etag });
  assert.equal(r3.status, 200);
  assert.ok((await r3.text()).includes('new line'));
  assert.notEqual(r3.headers.get('etag'), etag);
});

test('bare names redirect to canonical; unicode paths; raw markdown', async () => {
  const r = await get('/docs/s/Second'); assert.equal(r.status, 301); assert.equal(r.headers.get('location'), '/docs/s/sub/Second');
  const ar = await get('/docs/s/ar/' + encodeURIComponent('عربي')); assert.equal(ar.status, 200);
  assert.match(await ar.text(), /<html lang="ar" dir="rtl">/);
  const raw = await get('/docs/s/Home?raw'); assert.equal(raw.status, 200);
  assert.ok(raw.headers.get('content-type').includes('text/markdown'));
  assert.ok((await raw.text()).startsWith('---\ntitle: Home Page'));
});

test('attachments, hidden notes, traversal, 404', async () => {
  const img = await get('/docs/s/img/pic.png'); assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await get('/docs/s/sub/Draft')).status, 404);
  assert.equal((await get('/docs/s/../cfg.json')).status, 404);
  assert.equal((await get('/docs/s/nothing/here')).status, 404);
  assert.equal((await get('/docs/zzz/')).status, 404);
});

test('embed mode strips chrome and keeps links in embed mode', async () => {
  const r = await get('/docs/s/Home?embed=1'); const html = await r.text();
  assert.ok(html.includes('<body class="embed">'));
  assert.ok(!html.includes('class="topbar"') && !html.includes('id="sidebar"'));
  assert.match(html, /class="backlinks".*href="\/docs\/s\/sub\/Second\?embed=1"/s);
  const full = await (await get('/docs/s/Home')).text();
  assert.notEqual(r.headers.get('etag'), (await get('/docs/s/Home')).headers.get('etag'), 'embed and full pages have different ETags');
  assert.ok(full.includes('class="topbar"'));
});

test('graph endpoints: json with etag, local variant, page with focus', async () => {
  const r = await get('/docs/s/_graph.json'); assert.equal(r.status, 200);
  const g = await r.json();
  assert.ok(g.nodes.some(n => n.id === 'Home.md'));
  assert.ok(g.edges.some(e => [e.source, e.target].sort().join(' ') === 'Home.md sub/Second.md'), 'undirected edge between Home and Second');
  assert.ok(!g.nodes.some(n => n.id === 'sub/Draft.md'));
  assert.equal((await get('/docs/s/_graph.json', { 'if-none-match': r.headers.get('etag') })).status, 304);
  const local = await (await get('/docs/s/_graph.json?rel=sub%2FSecond.md&depth=1')).json();
  assert.deepEqual(local.nodes.map(n => n.id).sort(), ['Home.md', 'sub/Second.md'], 'Arabic note links to Home only, so it is 2 hops away');
  const html = await (await get('/docs/s/_graph?focus=Home.md')).text();
  assert.ok(html.includes('id="graphCanvas"') && html.includes('data-focus="Home.md"') && html.includes('<title>Graph · Home Page · Brand S</title>'));
  assert.ok(html.includes('/docs/_static/graph.js') && html.includes('/docs/_static/graph-page.js') && html.includes('id="graphPanel"'));
  const explore = await (await get('/docs/s/_explore?focus=Home.md')).text();
  assert.ok(explore.includes('id="exploreCanvas"') && explore.includes('/docs/_static/explore.js') && explore.includes('id="exPathGo"'));
  const unknownFocus = await (await get('/docs/s/_graph?focus=nope.md')).text();
  assert.ok(unknownFocus.includes('data-focus=""') && unknownFocus.includes('<title>Graph view · Brand S</title>'), 'unknown focus falls back to the global graph');
});

test('search finds notes by title and body, skips hidden', async () => {
  const hits = await (await get('/docs/s/_search?q=bravo')).json();
  assert.equal(hits.length, 1); assert.equal(hits[0].url, '/docs/s/sub/Second');
  const none = await (await get('/docs/s/_search?q=secret')).json();
  assert.equal(none.length, 0);
  const stats = await (await get('/docs/_stats')).json();
  assert.ok(stats.cache.renders >= 3);
});
