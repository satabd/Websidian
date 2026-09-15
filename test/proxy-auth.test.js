'use strict';
// Trusted reverse proxy sign-in (top-level proxyAuth): a request from an allowed address with the
// shared secret passes the site auth gate and is signed in to the editor as the header user.
// The main server also checks a deep basePath mount, as the Hermes dashboard plugin uses it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { makeVault, FIXTURE } = require('./helpers');
const { resolveProxyAuth, cleanUser } = require('../src/proxyauth');
const { resolveConfig } = require('../src/editor');

const BASE = '/api/plugins/websidian/w';
const SECRET = 'proxy-secret-0123456789-abcdefghijklmnop';
const PORT0 = 24080 + Math.floor(Math.random() * 900);
let tmp;
const servers = {};

function boot(name, port, cfgObj) {
  const cfg = path.join(tmp.root, `cfg-${name}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ port, host: '127.0.0.1', cacheDir: false, warm: false, log: 'json', ...cfgObj }));
  const s = { port, logs: '', proc: null };
  s.proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, MD2HTML_CONFIG: cfg, WEBSIDIAN_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers[name] = s;
  return new Promise((resolve, reject) => {
    s.proc.stdout.on('data', d => { s.logs += d; if (s.logs.includes('listening')) resolve(s); });
    s.proc.stderr.on('data', d => { s.logs += d; });
    s.proc.on('exit', code => reject(new Error(`server ${name} exited ${code}\n${s.logs}`)));
    setTimeout(() => reject(new Error(`server ${name} did not start\n${s.logs}`)), 10000);
  });
}
const req = (name, p, { method = 'GET', headers = {}, body } = {}) => fetch(`http://127.0.0.1:${servers[name].port}${p}`, {
  method, redirect: 'manual', headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
});
const proxied = (extra = {}) => ({ 'x-websidian-proxy-secret': SECRET, 'x-websidian-user': 'Hermes User', ...extra });

const site = (extra = {}) => ({ slug: 'hermes', title: 'Hermes', root: '.', untrusted: true, snippets: 'all', auth: { users: { owner: 'pw' } }, ...extra });

before(async () => {
  tmp = makeVault({
    ...FIXTURE,
    'skills/x/SKILL.md': '# Skill\n',
    '.obsidian/snippets/brand.css': 'body { color: red; }\n',
  });
  const edit = { allowFrom: ['127.0.0.1', '::1'], secret: 'session-secret' };
  await Promise.all([
    boot('main', PORT0, { basePath: BASE, proxyAuth: { secret: SECRET }, edit, sites: [site()] }),
    boot('ip', PORT0 + 1, { proxyAuth: { secret: SECRET, allowFrom: ['10.9.9.9'] }, edit, sites: [site()] }),
    boot('short', PORT0 + 2, { proxyAuth: { secret: 'too-short' }, edit, sites: [site()] }),
  ]);
});
after(() => { for (const s of Object.values(servers)) if (s.proc) s.proc.kill(); if (tmp) tmp.rm(); });

// ---- pure helpers ------------------------------------------------------------------

test('resolveProxyAuth: defaults, short secret refused with a warning', () => {
  const warnings = [];
  assert.equal(resolveProxyAuth(undefined), null);
  assert.equal(resolveProxyAuth({ secret: 'x'.repeat(31) }, m => warnings.push(m)), null);
  assert.equal(resolveProxyAuth({}, m => warnings.push(m)), null);
  assert.equal(warnings.length, 2);
  const c = resolveProxyAuth({ secret: SECRET });
  assert.deepEqual(c, { secret: SECRET, secretHeader: 'x-websidian-proxy-secret', userHeader: 'x-websidian-user', allowFrom: ['127.0.0.1', '::1'] });
  assert.equal(resolveProxyAuth({ secret: SECRET, secretHeader: 'X-Secret', allowFrom: ['10.0.0.0/8'] }).secretHeader, 'x-secret');
});

test('cleanUser: allowed characters only, 64 max, default "proxy"', () => {
  assert.equal(cleanUser('  sat@example.com '), 'sat@example.com');
  assert.equal(cleanUser('a<script>b'), 'ascriptb');
  assert.equal(cleanUser('x'.repeat(100)).length, 64);
  assert.equal(cleanUser(undefined), 'proxy');
  assert.equal(cleanUser('<>'), 'proxy');
});

test('resolveConfig: edit without users/token is enabled only with proxy auth', () => {
  assert.equal(resolveConfig(undefined, { allowFrom: ['127.0.0.1'] }), null);
  const c = resolveConfig(undefined, { allowFrom: ['127.0.0.1'] }, { proxy: true });
  assert.equal(c.proxy, true); assert.equal(c.users, null); assert.deepEqual(c.allowFrom, ['127.0.0.1']);
  assert.equal(resolveConfig(false, { token: 't' }, { proxy: true }), null);
});

// ---- the proxy, with a deep basePath -------------------------------------------------

test('valid secret from 127.0.0.1 passes site auth; without it, 401', async () => {
  assert.equal((await req('main', `${BASE}/hermes/`)).status, 401);
  const r = await req('main', `${BASE}/hermes/Home`, { headers: proxied() });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Home Page/);
  assert.ok(html.includes(`href="${BASE}/hermes/_edit/Home"`), 'signed-in proxy user sees the Edit button');
});

test('wrong secret: normal 401, logged once as proxy-auth-denied without the secret', async () => {
  const before = servers.main.logs.split('proxy-auth-denied').length;
  const r = await req('main', `${BASE}/hermes/Home`, { headers: proxied({ 'x-websidian-proxy-secret': 'wrong-' + SECRET }) });
  assert.equal(r.status, 401);
  assert.equal((await req('main', `${BASE}/hermes/_api/note?rel=Home.md`, { headers: proxied({ 'x-websidian-proxy-secret': 'nope', authorization: 'Basic ' + Buffer.from('owner:pw').toString('base64') }) })).status, 401);
  await new Promise(res => setTimeout(res, 100));
  assert.equal(servers.main.logs.split('proxy-auth-denied').length - before, 2, 'one log line per denied request');
  assert.ok(!servers.main.logs.includes(SECRET), 'the secret never appears in logs');
  // Normal auth still works for the same request.
  assert.equal((await req('main', `${BASE}/hermes/Home`, { headers: { 'x-websidian-proxy-secret': 'nope', authorization: 'Basic ' + Buffer.from('owner:pw').toString('base64') } })).status, 200);
});

test('editor API: GET and PUT as the header user; CSRF header still required', async () => {
  const g = await req('main', `${BASE}/hermes/_api/note?rel=Home.md`, { headers: proxied() });
  assert.equal(g.status, 200);
  const note = await g.json();
  assert.equal(note.exists, true);
  const noCsrf = await req('main', `${BASE}/hermes/_api/note`, { method: 'PUT', headers: proxied(), body: { rel: 'Proxy.md', text: '# via proxy\n', stamp: null } });
  assert.equal(noCsrf.status, 403);
  const p = await req('main', `${BASE}/hermes/_api/note`, { method: 'PUT', headers: proxied({ 'x-requested-with': 'hermes' }), body: { rel: 'Proxy.md', text: '# via proxy\n', stamp: null } });
  assert.equal(p.status, 201);
  const out = await p.json();
  assert.equal(out.url, `${BASE}/hermes/Proxy`);
  assert.equal(fs.readFileSync(path.join(tmp.root, 'Proxy.md'), 'utf8'), '# via proxy\n');
  await new Promise(res => setTimeout(res, 100));
  assert.match(servers.main.logs, /"event":"edit","site":"hermes","user":"Hermes User","rel":"Proxy.md"/);
  // Default user name when the proxy sends none.
  const anon = await req('main', `${BASE}/hermes/_edit/Home`, { headers: { 'x-websidian-proxy-secret': SECRET } });
  assert.equal(anon.status, 200);
  assert.match(await anon.text(), /"user":"proxy"/);
});

test('untrusted site: protected files still need confirmation through the proxy', async () => {
  const h = proxied({ 'x-requested-with': 'hermes' });
  const { stamp } = await (await req('main', `${BASE}/hermes/_api/note?rel=skills/x/SKILL.md`, { headers: h })).json();
  const r = await req('main', `${BASE}/hermes/_api/note`, { method: 'PUT', headers: h, body: { rel: 'skills/x/SKILL.md', text: '# changed\n', stamp } });
  assert.equal(r.status, 428);
  assert.equal((await r.json()).needsConfirm, 'instructions');
  const ok = await req('main', `${BASE}/hermes/_api/note`, { method: 'PUT', headers: h, body: { rel: 'skills/x/SKILL.md', text: '# changed\n', stamp, confirm: 'instructions' } });
  assert.equal(ok.status, 200);
});

test('editor page under the deep basePath: import map, assets, no logout form; login explains the proxy', async () => {
  const r = await req('main', `${BASE}/hermes/_edit/Home`, { headers: proxied() });
  assert.equal(r.status, 200);
  const html = await r.text();
  const map = JSON.parse(html.match(/<script type="importmap"[^>]*>(.*?)<\/script>/s)[1]);
  const urls = Object.values(map.imports);
  assert.ok(urls.length > 5);
  for (const u of urls) assert.ok(u.startsWith(`${BASE}/_vendor/esm/`) || u.startsWith(`${BASE}/_static/cm/`), u);
  for (const u of [urls.find(x => x.includes('@codemirror/state@')), map.imports['ws/editor']]) {
    const a = await req('main', u);
    assert.equal(a.status, 200, u);
    assert.match(a.headers.get('content-type'), /javascript/);
  }
  assert.ok(html.includes(`src="${BASE}/_static/editor.js?v=`));
  assert.ok(html.includes(`"base":"${BASE}/hermes/"`));
  assert.ok(html.includes(`href="${BASE}/hermes/_snippets/brand.css?v=`));
  assert.ok(!html.includes('_edit/_logout'), 'nothing to log out of');
  assert.match(html, /Hermes User/);
  // Not proxied: redirect to the login page, which says sign-in happens through the proxy.
  const noProxy = await req('main', `${BASE}/hermes/_edit/Home`, { headers: { authorization: 'Basic ' + Buffer.from('owner:pw').toString('base64') } });
  assert.equal(noProxy.status, 302);
  const loc = noProxy.headers.get('location');
  assert.ok(loc.startsWith(`${BASE}/hermes/_edit/_login?next=${encodeURIComponent(`${BASE}/hermes/_edit/Home`)}`), loc);
  const login = await req('main', loc, { headers: { authorization: 'Basic ' + Buffer.from('owner:pw').toString('base64') } });
  assert.equal(login.status, 403);
  assert.match(await login.text(), /through the proxy/);
  // A proxied visit to the login page goes on to a safe `next` under the basePath.
  const back = await req('main', loc, { headers: proxied() });
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), `${BASE}/hermes/_edit/Home`);
  const evil = await req('main', `${BASE}/hermes/_edit/_login?next=${encodeURIComponent('https://evil.example/')}`, { headers: proxied() });
  assert.equal(evil.headers.get('location'), `${BASE}/hermes/_edit/Home`);
});

test('deep basePath: page links, assets, graph json, search, snippets, 304, sitemap, robots, embed', async () => {
  const h = proxied();
  const page = await req('main', `${BASE}/hermes/Home`, { headers: h });
  const html = await page.text();
  assert.ok(html.includes(`href="${BASE}/hermes/sub/Second"`), 'wikilinks');
  assert.ok(html.includes(`src="${BASE}/hermes/img/pic.png"`), 'attachments');
  assert.ok(html.includes(`href="${BASE}/_static/app.css?v=`), 'assets');
  assert.ok(html.includes(`"${BASE}/hermes/"`), 'client base');
  assert.ok(html.includes(`${BASE}/hermes/_graph.json`), 'local graph url');
  assert.equal((await req('main', `${BASE}/hermes/img/pic.png`, { headers: h })).status, 200);
  assert.equal((await req('main', `${BASE}/_static/app.js`)).status, 200);
  // 304 on the same ETag.
  const etag = page.headers.get('etag');
  assert.equal((await req('main', `${BASE}/hermes/Home`, { headers: { ...h, 'if-none-match': etag } })).status, 304);
  // Bare name redirects to the canonical URL under the basePath.
  const redir = await req('main', `${BASE}/hermes/Second`, { headers: h });
  assert.equal(redir.status, 301);
  assert.equal(redir.headers.get('location'), `${BASE}/hermes/sub/Second`);

  const graph = await (await req('main', `${BASE}/hermes/_graph.json`, { headers: h })).json();
  assert.ok(graph.nodes.length > 1);
  for (const n of graph.nodes.filter(x => x.url)) assert.ok(n.url.startsWith(`${BASE}/hermes/`), n.url);
  const gp = await (await req('main', `${BASE}/hermes/_graph`, { headers: h })).text();
  assert.ok(gp.includes(`data-graph="${BASE}/hermes/_graph.json"`));
  assert.equal((await req('main', `${BASE}/hermes/_explore`, { headers: h })).status, 200);

  const hits = await (await req('main', `${BASE}/hermes/_search?q=bravo`, { headers: h })).json();
  assert.ok(hits.length >= 1);
  for (const x of hits) assert.ok(x.url.startsWith(`${BASE}/hermes/`), x.url);

  const css = await req('main', `${BASE}/hermes/_snippets/brand.css`, { headers: h });
  assert.equal(css.status, 200);
  const embed = await (await req('main', `${BASE}/hermes/Home?embed=1`, { headers: h })).text();
  assert.match(embed, /embed:true/);
  assert.equal((await req('main', `${BASE}/hermes/sitemap.xml`, { headers: h })).status, 200);
  assert.equal((await req('main', `${BASE}/robots.txt`)).status, 200);
  const root = await req('main', '/');
  assert.equal(root.headers.get('location'), `${BASE}/`);
});

// ---- denied / disabled -----------------------------------------------------------------

test('right secret from an address not in proxyAuth.allowFrom: no privileges', async () => {
  assert.equal((await req('ip', '/hermes/Home', { headers: proxied() })).status, 401);
  const api = await req('ip', '/hermes/_api/note?rel=Home.md', { headers: proxied({ authorization: 'Basic ' + Buffer.from('owner:pw').toString('base64') }) });
  assert.equal(api.status, 401, 'site auth passes with Basic, but the editor has no session');
  await new Promise(res => setTimeout(res, 100));
  assert.match(servers.ip.logs, /"event":"proxy-auth-denied".*"reason":"address"/);
});

test('short secret: proxy auth disabled with a warning, editor without users is off', async () => {
  assert.match(servers.short.logs, /proxyAuth\.secret is missing or shorter than 32/);
  assert.equal((await req('short', '/hermes/Home', { headers: { 'x-websidian-proxy-secret': 'too-short' } })).status, 401);
  const basic = { authorization: 'Basic ' + Buffer.from('owner:pw').toString('base64') };
  assert.equal((await req('short', '/hermes/_api/note?rel=Home.md', { headers: { ...basic, 'x-websidian-proxy-secret': 'too-short' } })).status, 404, 'no editor at all');
});
