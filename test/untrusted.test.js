'use strict';
// `untrusted: true` sites (folders written by AI agents): no raw HTML, strict
// mermaid, attachment allowlist, CSP with a per-request nonce. Two sites serve
// the SAME folder: "u" untrusted, "t" trusted, so cache sharing would show.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { makeVault, FIXTURE } = require('./helpers');
const { isServableAttachment, withNonce } = require('../src/untrusted');

const PORT = 21080 + Math.floor(Math.random() * 1000);
let tmp, proc;
const url = p => `http://127.0.0.1:${PORT}${p}`;
const get = (p, headers = {}) => fetch(url(p), { headers, redirect: 'manual' });
const TOKEN = 'edit-token-123';

const EVIL = `---
title: Evil
tags: ["<script>alert(1)</script>"]
description: '"><script>alert(2)</script>'
---
# Evil

<script>alert('raw')</script>

<img src=x onerror="alert('img')">

Inline <b onclick="x()">bold</b> text.

> [!tip] Careful
> callout body

See [[Home]] and ![[pic.png|50]] and ![[Second#Part B]] and $x^2$.

$$
a+b
$$

- [x] done

Footnote[^1] ^blk

[^1]: the note

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`
`;

before(async () => {
  tmp = makeVault({
    ...FIXTURE,
    'Evil.md': EVIL,
    'auth.json': '{"token":"secret"}',
    'config.yaml': 'key: secret',
    'x.html': '<script>alert(1)</script>',
    'state.db': 'SQLite format 3',
    'd.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    'Cat.base': 'views:\n  - type: table\n    name: T\n    order: [file.name]\n',
  });
  const cfg = path.join(tmp.root, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({
    port: PORT, host: '127.0.0.1', cacheDir: 'cache', warm: false, exclude: [],
    sites: [
      { slug: 't', title: 'Trusted', root: '.', exclude: ['cache', 'cfg.json'], brand: { headHtml: '<script src="/a.js"></script>' } },
      { slug: 'u', title: 'Untrusted', root: '.', untrusted: true, exclude: ['cache', 'cfg.json'], edit: { token: TOKEN }, brand: { headHtml: '<script src="/a.js"></script><script>var x=1</script>' } },
    ],
  }));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, MD2HTML_CONFIG: cfg, WEBSIDIAN_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', d => { out += d; if (out.includes('listening')) resolve(); });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', code => reject(new Error('server exited ' + code + '\n' + out)));
    setTimeout(() => reject(new Error('server did not start\n' + out)), 10000);
  });
});
after(() => { if (proc) proc.kill(); if (tmp) tmp.rm(); });

// Every <script> tag without src must carry exactly the header's nonce.
function checkNonces(html, csp) {
  const m = csp.match(/'nonce-([^']+)'/); assert.ok(m, 'CSP has a nonce');
  const nonce = m[1];
  const tags = [...html.matchAll(/<script\b[^>]*>/gi)].map(x => x[0]);
  assert.ok(tags.length > 0);
  for (const t of tags) {
    if (/\ssrc=/.test(t) && !/nonce=/.test(t)) continue;       // external same-origin scripts are allowed by 'self'
    assert.ok(t.includes(`nonce="${nonce}"`), `inline script has the nonce: ${t}`);
  }
  return nonce;
}

test('helpers: allowlist and nonce injection', () => {
  for (const e of ['.png', 'JPG', '.svg', '.pdf', '.mp4', '.flac']) assert.ok(isServableAttachment(e), e);
  for (const e of ['.html', '.json', '.yaml', '.db', '.js', '.base', '', '.md']) assert.ok(!isServableAttachment(e), e);
  assert.equal(withNonce('<script src="a"></script><SCRIPT>x</SCRIPT>', 'N'), '<script nonce="N" src="a"></script><script nonce="N">x</SCRIPT>');
  assert.equal(withNonce('<script>x</script>', ''), '<script>x</script>');
});

test('raw HTML is escaped on the untrusted site and passed through on the trusted one (cache not shared)', async () => {
  // Trusted first, so a shared cache entry would leak into the untrusted render.
  const t = await (await get('/t/Evil')).text();
  assert.ok(t.includes("<script>alert('raw')</script>"));
  assert.ok(t.includes('<img src=x onerror="alert(\'img\')">'));
  const r = await get('/u/Evil'); const u = await r.text();
  assert.ok(!u.includes("<script>alert('raw')</script>"), 'no raw script');
  assert.ok(u.includes('&lt;script&gt;alert(\'raw\')&lt;/script&gt;'));
  assert.ok(!/<img src=x onerror/.test(u) && !/<b onclick/.test(u));
  assert.ok(!u.includes('<script>alert(1)</script>') && !u.includes('<script>alert(2)</script>'), 'frontmatter escaped');
  // Obsidian constructs still work.
  assert.match(u, /<div class="callout callout-tip" data-callout="tip">/);
  assert.match(u, /<a href="\/u\/Home" class="internal-link">Home<\/a>/);
  assert.match(u, /<img src="\/u\/img\/pic.png" alt="pic.png" loading="lazy" width="50">/);
  assert.match(u, /<div class="embed-note">.*bravo content/s);
  assert.match(u, /<span class="math math-inline">x\^2<\/span>/);
  assert.match(u, /<div class="math math-block">a\+b<\/div>/);
  assert.match(u, /<input type="checkbox" disabled checked>/);
  assert.match(u, /class="footnote-ref"/);
  assert.match(u, /id="\^blk"/);
  assert.match(u, /<pre class="mermaid">/);
  assert.notEqual(r.headers.get('etag'), (await get('/t/Evil')).headers.get('etag'));
});

test('CSP with a per-request nonce on untrusted pages; none on trusted; nosniff everywhere', async () => {
  const r1 = await get('/u/Evil'); const csp1 = r1.headers.get('content-security-policy');
  assert.ok(csp1 && csp1.includes("script-src 'self' 'nonce-") && csp1.includes("object-src 'none'") && csp1.includes("base-uri 'none'"));
  assert.ok(!csp1.includes('frame-ancestors'), 'embeds stay frameable');
  const html = await r1.text();
  const n1 = checkNonces(html, csp1);
  assert.ok(html.includes(`<script nonce="${n1}" src="/a.js"></script><script nonce="${n1}">var x=1</script>`), 'brand.headHtml scripts get the nonce');
  assert.match(html, /<html lang="en" dir="ltr" data-untrusted="1">/);
  const r2 = await get('/u/Evil'); const csp2 = r2.headers.get('content-security-policy');
  assert.notEqual(csp1, csp2, 'fresh nonce per request');
  checkNonces(await r2.text(), csp2);
  assert.equal(r1.headers.get('x-content-type-options'), 'nosniff');

  // 304 carries no new nonce (browsers merge 304 headers into the cached page).
  const r304 = await get('/u/Evil', { 'if-none-match': r1.headers.get('etag') });
  assert.equal(r304.status, 304); assert.equal(r304.headers.get('content-security-policy'), null);

  const t = await get('/t/Evil'); const th = await t.text();
  assert.equal(t.headers.get('content-security-policy'), null);
  assert.equal(t.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(!th.includes('nonce=') && !th.includes('data-untrusted'));
  assert.ok(th.includes('<script src="/a.js"></script>'));
  assert.equal((await get('/_health')).headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await get('/_static/app.js')).headers.get('x-content-type-options'), 'nosniff');
});

test('every HTML surface of the untrusted site: embed, graph, explore, 404, base, editor, login', async () => {
  for (const p of ['/u/Evil?embed=1', '/u/_graph', '/u/_explore?focus=Home.md', '/u/nope/here', '/u/Cat.base', '/u/_edit/Evil']) {
    const r = await get(p, p.includes('_edit') ? { authorization: 'Bearer ' + TOKEN } : {});
    assert.ok([200, 404].includes(r.status), p + ' ' + r.status);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
    const csp = r.headers.get('content-security-policy'); assert.ok(csp && csp.includes('nonce-'), p);
    const html = await r.text();
    checkNonces(html, csp);
    assert.ok(/data-untrusted="1"/.test(html), p + ' has the mermaid flag');
    assert.ok(!/\son(change|click|load|error)=/.test(html.replace(/&lt;[\s\S]*?&gt;/g, '')), p + ' has no inline handlers');
  }
  const ed = await (await get('/u/_edit/Evil', { authorization: 'Bearer ' + TOKEN })).text();
  assert.match(ed, /<script type="importmap" nonce="[^"]+">/);
  const login = await get('/u/_edit/_login');
  assert.ok(login.headers.get('content-security-policy'));
  // Trusted graph page unchanged: no nonce, no flag.
  const tg = await (await get('/t/_graph')).text();
  assert.ok(!tg.includes('nonce=') && !tg.includes('data-untrusted'));
});

test('site switcher uses a script, not an inline handler', async () => {
  const html = await (await get('/t/Home')).text();
  assert.match(html, /<select class="site-switch" aria-label="Site">/);
  assert.ok(html.includes('/_static/site-switch.js'));
  assert.ok(!html.includes('onchange='));
  assert.match(await (await get('/t/_graph')).text(), /<select class="site-switch" data-suffix="_graph"/);
});

test('attachment allowlist on the untrusted site', async () => {
  for (const p of ['auth.json', 'config.yaml', 'x.html', 'state.db']) {
    assert.equal((await get('/u/' + p)).status, 404, 'untrusted ' + p);
    assert.equal((await get('/t/' + p)).status, 200, 'trusted still serves ' + p);
  }
  const png = await get('/u/img/pic.png');
  assert.equal(png.status, 200); assert.equal(png.headers.get('content-type'), 'image/png');
  assert.equal(png.headers.get('content-security-policy'), null);
  const svg = await get('/u/d.svg');
  assert.equal(svg.status, 200);
  assert.equal(svg.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  assert.equal((await get('/t/d.svg')).headers.get('content-security-policy'), null);
  const raw = await get('/u/Evil?raw'); assert.equal(raw.status, 200); assert.ok(raw.headers.get('content-type').startsWith('text/markdown'));
  const braw = await get('/u/Cat.base?raw'); assert.equal(braw.status, 200); assert.ok(braw.headers.get('content-type').startsWith('text/plain'));
  const base = await get('/u/Cat.base'); assert.equal(base.status, 200); assert.match(await base.text(), /class="base"/);
  // The editor's attachment list does not advertise refused files.
  const files = await (await get('/u/_api/files', { authorization: 'Bearer ' + TOKEN })).json();
  const names = files.map(f => f.name).sort();
  assert.ok(names.includes('pic.png') && names.includes('d.svg'));
  assert.ok(!names.includes('auth.json') && !names.includes('x.html') && !names.includes('Cat.base'));
});

test('editor preview uses the untrusted renderer', async () => {
  const r = await fetch(url('/u/_api/preview'), { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', 'x-requested-with': 't' }, body: JSON.stringify({ rel: 'P.md', text: '<script>alert(1)</script>\n\n> [!note]\n> hi' }) });
  const j = await r.json();
  assert.ok(!j.html.includes('<script>') && j.html.includes('&lt;script&gt;'));
  assert.match(j.html, /callout-note/);
});

test('CSS snippets are off by default on untrusted sites, still opt-in', () => {
  const Vault = require('../src/vault');
  const V = Vault.Vault || Vault;
  assert.equal(new V({ slug: 'a', title: 'A', root: '.', untrusted: true }).snippetsCfg, false);
  assert.equal(new V({ slug: 'b', title: 'B', root: '.', untrusted: true, snippets: true }).snippetsCfg, true);
  assert.equal(new V({ slug: 'c', title: 'C', root: '.' }).snippetsCfg, true);
});
