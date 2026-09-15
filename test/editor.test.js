'use strict';
// The browser editor: a separate surface with its own login, IP gate, session
// cookie and JSON API. The public viewer must stay exactly as it was.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { makeVault, FIXTURE } = require('./helpers');
const { safeNoteRel, ipAllowed, resolveConfig, makeSession, readSession, anchorsOf, obsidianSettings } = require('../src/editor');
const { extractTags } = require('../src/vault');
const { buildPackages, entryOf } = require('../src/esm');

const PORT = 21080 + Math.floor(Math.random() * 1000);
let tmp, proc, logLines = '', cookie = '';
const url = p => `http://127.0.0.1:${PORT}${p}`;
const get = (p, headers = {}) => fetch(url(p), { headers, redirect: 'manual' });
const json = (method, p, body, headers = {}) => fetch(url(p), { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-requested-with': 'md2html', cookie, ...headers }, redirect: 'manual' });
const form = (p, fields, headers = {}) => fetch(url(p), { method: 'POST', body: new URLSearchParams(fields).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, redirect: 'manual' });

before(async () => {
  tmp = makeVault({
    ...FIXTURE, 'Crlf.md': 'line one\r\nline two\r\n',
    'Tagged.md': '---\ntags: [alpha, "#beta"]\naliases: [Other name]\nstatus: ready\n---\n# Tagged\n\nInline #gamma and #nested/tag, not #123 or `#code` or q#zz.\n\n## Part Two ^blk\n\nA paragraph. ^para-1\n',
    '.obsidian/app.json': JSON.stringify({ useTab: false, tabSize: 2, newLinkFormat: 'relative', livePreview: false, tabSizeBogus: 'x', spellcheck: 'nope' }),
  });
  const cfg = path.join(tmp.root, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({
    port: PORT, host: '127.0.0.1', cacheDir: 'cache', warm: false, log: 'json',
    edit: { users: { sat: 'pw-1' }, token: 'api-1' },
    sites: [
      { slug: 's', title: 'Site S', root: '.', excludeStatus: ['draft'], exclude: ['locked'] },
      { slug: 'n', title: 'No edit', root: '.', edit: false },
      { slug: 'ip', title: 'Office only', root: '.', edit: { users: { sat: 'pw-1' }, allowFrom: ['10.0.0.0/8'] } },
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

// ---- pure helpers -------------------------------------------------------------

test('safeNoteRel: only .md notes inside the vault, nothing hidden or excluded', () => {
  const vault = { root: tmp.root, isExcluded: (rel) => rel.split('/').some(p => p.startsWith('.')) || rel === 'locked' || rel.startsWith('locked/') };
  assert.equal(safeNoteRel(vault, 'sub/Second').rel, 'sub/Second.md');
  assert.equal(safeNoteRel(vault, '/sub\\Second.md/').rel, 'sub/Second.md');
  assert.ok(safeNoteRel(vault, 'img/pic.png', { strict: true }).error, 'the API must name the .md explicitly');
  for (const bad of ['', '../x.md', 'sub/../Home.md', '.obsidian/app.md', '.trash/x.md', 'a/.hidden/x.md', 'locked/x.md', 'x<y.md', 'a\0b.md', 'trailing./x.md', 'a/ /b.md']) {
    assert.ok(safeNoteRel(vault, bad).error, `should reject ${JSON.stringify(bad)}`);
  }
});

test('ipAllowed: exact, prefix, cidr, ipv4-mapped', () => {
  assert.equal(ipAllowed('1.2.3.4', null), true);
  assert.equal(ipAllowed('::1', ['::1']), true);
  assert.equal(ipAllowed('::ffff:127.0.0.1', ['127.0.0.1']), true);
  assert.equal(ipAllowed('10.20.30.40', ['10.0.0.0/8']), true);
  assert.equal(ipAllowed('11.20.30.40', ['10.0.0.0/8']), false);
  assert.equal(ipAllowed('192.168.1.7', ['192.168.']), true);
  assert.equal(ipAllowed('192.169.1.7', ['192.168.']), false);
  assert.equal(ipAllowed('8.8.8.8', ['10.0.0.0/8', '::1']), false);
});

test('resolveConfig: site overrides global, false disables, needs users or token', () => {
  assert.equal(resolveConfig(undefined, undefined), null);
  assert.equal(resolveConfig(false, { users: { a: 'b' } }), null);
  assert.equal(resolveConfig({}, { users: { a: 'b' } }), null, 'empty site object has no credentials');
  assert.deepEqual(resolveConfig(undefined, { users: { a: 'b' } }).users, { a: 'b' });
  assert.equal(resolveConfig({ token: 't' }, { users: { a: 'b' } }).users, null);
  assert.equal(resolveConfig({ users: { a: 'b' }, sessionHours: 2 }, null).sessionHours, 2);
});

test('sessions: signed, expiring, site-bound', () => {
  const s = makeSession('secret', 's', 'sat', 1);
  assert.equal(readSession('secret', 's', s.value), 'sat');
  assert.equal(readSession('other', 's', s.value), null, 'wrong secret');
  assert.equal(readSession('secret', 'p', s.value), null, 'other site');
  assert.equal(readSession('secret', 's', s.value.replace(/\.[^.]+$/, '.AAAA')), null, 'tampered signature');
  assert.equal(readSession('secret', 's', makeSession('secret', 's', 'sat', -1).value), null, 'expired');
});

test('extractTags: frontmatter and inline tags, Obsidian rules', () => {
  assert.deepEqual(extractTags('Text #one and #two/three, (#four) not#five #6 `#code` [x](#frag) %%#hidden%%\n```\n#fenced\n```\n', { tags: ['#fm', 'fm2'], tag: 'solo' }).sort(),
    ['fm', 'fm2', 'four', 'one', 'solo', 'two/three']);
  assert.deepEqual(extractTags('#Arabic_وسم ok', {}), ['Arabic_وسم']);
});

test('anchorsOf: headings and ^block ids, skipping frontmatter and code', () => {
  const a = anchorsOf('---\ntitle: x\n# not a heading\n---\n# One\n```\n# in code ^nope\n```\n## Two ^blk\n- item text ^li-1\nPlain ^p1\n');
  assert.deepEqual(a.headings.map(h => [h.level, h.text]), [[1, 'One'], [2, 'Two ^blk']]);
  assert.deepEqual(a.blocks.map(b => [b.id, b.text]), [['blk', '## Two'], ['li-1', 'item text'], ['p1', 'Plain']]);
});

test('obsidianSettings: app.json values of the right type, Obsidian defaults otherwise', async () => {
  const s = await obsidianSettings({ root: tmp.root });
  assert.equal(s.useTab, false); assert.equal(s.tabSize, 2); assert.equal(s.newLinkFormat, 'relative'); assert.equal(s.livePreview, false);
  assert.equal(s.spellcheck, true, 'wrong type falls back'); assert.equal(s.autoPairBrackets, true); assert.equal(s.readableLineLength, true);
  assert.equal((await obsidianSettings({ root: path.join(tmp.root, 'nope') })).useTab, true, 'no .obsidian: defaults');
});

test('esm: every CodeMirror package and dependency resolves to one ES module file', () => {
  const pkgs = buildPackages(path.join(__dirname, '..', 'node_modules'));
  for (const name of ['@codemirror/state', '@codemirror/view', '@codemirror/lang-markdown', '@lezer/markdown', 'style-mod', 'w3c-keyname', 'crelt', '@marijn/find-cluster-break']) {
    assert.ok(pkgs.has(name), name); assert.ok(fs.existsSync(pkgs.get(name).file));
  }
  assert.equal(entryOf({ module: 'dist/index.js' }), 'dist/index.js');
  assert.equal(entryOf({ exports: { '.': { import: './src/index.js' } } }), './src/index.js');
  assert.equal(entryOf({ exports: { import: './x.js' } }), './x.js');
});

// ---- HTTP: gates -----------------------------------------------------------------

test('site without edit: editor URLs do not exist and the viewer has no edit button', async () => {
  assert.equal((await get('/n/_edit/')).status, 404);
  assert.equal((await get('/n/_api/note?rel=Home.md')).status, 404);
  assert.ok(!(await (await get('/n/')).text()).includes('edit-btn'));
  const stats = await (await get('/_stats')).json();
  assert.deepEqual(stats.sites.map(s => s.edit), [true, false, true]);
});

test('unauthenticated: page redirects to login, API says 401', async () => {
  const r = await get('/s/_edit/sub/Second');
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/s/_edit/_login?next=%2Fs%2F_edit%2Fsub%2FSecond');
  const a = await get('/s/_api/note?rel=sub/Second.md');
  assert.equal(a.status, 401); assert.equal((await a.json()).login, '/s/_edit/_login');
  const login = await get('/s/_edit/_login');
  assert.equal(login.status, 200); assert.match(await login.text(), /<form method="post" action="\/s\/_edit\/_login"/);
});

test('allowFrom: editor is unreachable from other networks, viewer unchanged', async () => {
  assert.equal((await get('/ip/_edit/_login')).status, 403);
  assert.equal((await get('/ip/_api/note?rel=Home.md')).status, 403);
  assert.equal((await get('/ip/')).status, 200);
});

test('login: wrong password 401, right password sets a session cookie and redirects to next', async () => {
  const bad = await form('/s/_edit/_login', { user: 'sat', password: 'nope', next: '/s/_edit/Home' });
  assert.equal(bad.status, 401); assert.match(await bad.text(), /Wrong name or password/);
  assert.equal(bad.headers.get('set-cookie'), null);
  const ok = await form('/s/_edit/_login', { user: 'sat', password: 'pw-1', next: '/s/_edit/sub/Second' });
  assert.equal(ok.status, 303); assert.equal(ok.headers.get('location'), '/s/_edit/sub/Second');
  const sc = ok.headers.get('set-cookie');
  assert.match(sc, /^md2html_edit_s=/); assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Path=\/s\//);
  cookie = sc.split(';')[0];
  const evil = await form('/s/_edit/_login', { user: 'sat', password: 'pw-1', next: 'https://evil.example/' });
  assert.equal(evil.headers.get('location'), '/s/_edit/Home', 'open redirect refused');
});

// ---- HTTP: editor page and viewer integration ---------------------------------------

test('editor page: home redirect, canonical redirect, hidden notes listed, new-note mode', async () => {
  const home = await get('/s/_edit/', { cookie }); assert.equal(home.status, 302); assert.equal(home.headers.get('location'), '/s/_edit/Home');
  const canon = await get('/s/_edit/sub/Second.md', { cookie }); assert.equal(canon.status, 302); assert.equal(canon.headers.get('location'), '/s/_edit/sub/Second');
  const r = await get('/s/_edit/sub/Second', { cookie }); assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  const html = await r.text();
  assert.match(html, /window\.MD2HTML_EDIT=\{"site":"s","base":"\/s\/","rel":"sub\/Second.md","exists":true/);
  assert.ok(html.includes('<textarea id="edText"') && html.includes('_static/editor.js'));
  assert.match(html, /class="nav-note is-hidden" href="\/s\/_edit\/sub\/Draft"/, 'draft notes are editable');
  assert.match(html, /class="nav-note is-current" href="\/s\/_edit\/sub\/Second"/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  const fresh = await get('/s/_edit/guides/Brand%20New', { cookie }); assert.equal(fresh.status, 200);
  assert.match(await fresh.text(), /"rel":"guides\/Brand New.md","exists":false/);
  assert.equal((await get('/s/_edit/.obsidian/app', { cookie })).status, 400);
});

test('viewer: edit button only with a session, distinct ETag, 404 offers to create', async () => {
  const anon = await get('/s/sub/Second'); const anonHtml = await anon.text();
  assert.ok(!anonHtml.includes('edit-btn'));
  const mine = await get('/s/sub/Second', { cookie }); const mineHtml = await mine.text();
  assert.match(mineHtml, /<a class="edit-btn" href="\/s\/_edit\/sub\/Second"/);
  assert.notEqual(anon.headers.get('etag'), mine.headers.get('etag'));
  assert.ok(!(await (await get('/s/sub/Second?embed=1', { cookie })).text()).includes('edit-btn'), 'embeds never show it');
  const nf = await get('/s/guides/Nope', { cookie }); assert.equal(nf.status, 404);
  assert.match(await nf.text(), /href="\/s\/_edit\/guides\/Nope">Create/);
  assert.ok(!(await (await get('/s/guides/Nope')).text()).includes('_edit/'));
});

test('editor page: import map for CodeMirror and the editor modules, vault settings, status bar', async () => {
  const html = await (await get('/s/_edit/Home', { cookie })).text();
  const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
  assert.match(map.imports['@codemirror/view'], /^\/_vendor\/esm\/@codemirror\/view@[\d.]+\.js$/);
  assert.match(map.imports['ws/editor'], /^\/_static\/cm\/editor\.js\?v=\w+$/);
  assert.equal(map.imports['/_static/cm/syntax.js'], map.imports['ws/syntax'], 'relative imports between modules are versioned too');
  assert.ok(html.indexOf('type="importmap"') < html.indexOf('<script src='), 'the map comes before any script');
  assert.match(html, /"settings":\{[^}]*"useTab":false[^}]*"tabSize":2/);
  assert.match(html, /_static\/cm\/obsidian\.css\?v=\w+/);
  assert.match(html, /<footer class="status-bar"/);
  // the mapped module URLs are served, as JavaScript, cacheable forever
  const js = await get(map.imports['@codemirror/state']);
  assert.equal(js.status, 200); assert.match(js.headers.get('content-type'), /javascript/); assert.match(js.headers.get('cache-control'), /immutable/);
  assert.match(await js.text(), /export \{/);
  const own = await get(map.imports['ws/editor']); assert.equal(own.status, 200); assert.match(await own.text(), /export function createEditor/);
  for (const bad of ['/_vendor/esm/@codemirror/state@0.0.0.js', '/_vendor/esm/..%2Fpackage.json', '/_vendor/esm/express@4.21.2.js']) assert.equal((await get(bad)).status, 404, bad);
});

test('API: files, tags, properties and anchors for suggestions', async () => {
  const files = await (await json('GET', '/s/_api/files')).json();
  assert.deepEqual(files.find(f => f.rel === 'img/pic.png'), { rel: 'img/pic.png', name: 'pic.png', ext: 'png', folder: 'img', url: '/s/img/pic.png', size: fs.statSync(path.join(tmp.root, 'img/pic.png')).size });
  const tags = await (await json('GET', '/s/_api/tags')).json();
  const names = tags.map(t => t.tag);
  for (const t of ['alpha', 'beta', 'gamma', 'nested/tag', 'a']) assert.ok(names.includes(t), t);
  assert.ok(!names.includes('123') && !names.includes('code') && !names.includes('zz'));
  const props = await (await json('GET', '/s/_api/properties')).json();
  const status = props.find(p => p.name === 'status');
  assert.ok(status.values.includes('ready') && status.values.includes('draft'));
  assert.equal(props.find(p => p.name === 'tags').type, 'list');
  const notes = await (await json('GET', '/s/_api/notes')).json();
  assert.deepEqual(notes.find(n => n.rel === 'Tagged.md').aliases, ['Other name']);
  const anchors = await (await json('GET', '/s/_api/anchors?rel=Tagged.md')).json();
  assert.deepEqual(anchors.headings.map(h => h.text), ['Tagged', 'Part Two ^blk']);
  assert.deepEqual(anchors.blocks.map(b => b.id), ['blk', 'para-1']);
  assert.equal((await json('GET', '/s/_api/anchors?rel=../cfg.json')).status, 400);
  assert.equal((await json('GET', '/s/_api/anchors?rel=Nope.md')).status, 404);
  assert.equal((await fetch(url('/s/_api/tags'))).status, 401, 'needs a session like the rest of the API');
});

// ---- HTTP: API --------------------------------------------------------------------------

test('API: read, CSRF header required, stale stamp conflicts, save invalidates page and search', async () => {
  const r = await json('GET', '/s/_api/note?rel=sub/Second.md'); assert.equal(r.status, 200);
  const note = await r.json();
  assert.ok(note.text.startsWith('---\ntitle: Second')); assert.match(note.stamp, /^\d+(\.\d+)?-\d+$/); assert.equal(note.url, '/s/sub/Second');
  const noHeader = await fetch(url('/s/_api/note'), { method: 'PUT', body: '{}', headers: { 'content-type': 'application/json', cookie } });
  assert.equal(noHeader.status, 403);
  const stale = await json('PUT', '/s/_api/note', { rel: 'sub/Second.md', text: 'x', stamp: '1-1' });
  assert.equal(stale.status, 409); assert.equal((await stale.json()).stamp, note.stamp);
  const text = note.text.replace('bravo content', 'bravo content plus zebrafish');
  const saved = await json('PUT', '/s/_api/note', { rel: 'sub/Second.md', text, stamp: note.stamp });
  assert.equal(saved.status, 200); const j = await saved.json(); assert.equal(j.ok, true); assert.notEqual(j.stamp, note.stamp);
  assert.equal(fs.readFileSync(path.join(tmp.root, 'sub/Second.md'), 'utf8'), text);
  assert.match(await (await get('/s/sub/Second')).text(), /zebrafish/, 'page re-rendered');
  const hits = await (await get('/s/_search?q=zebrafish')).json(); assert.equal(hits.length, 1);
  assert.equal(fs.readdirSync(path.join(tmp.root, 'sub')).filter(f => f.endsWith('.tmp')).length, 0, 'no temp files left behind');
});

test('API: create with stamp null, then it is served and listed; creating twice conflicts', async () => {
  const r = await json('PUT', '/s/_api/note', { rel: 'guides/Brand New.md', text: '---\ntitle: Brand New\n---\n# Hello\n\n[[Home]]\n', stamp: null });
  assert.equal(r.status, 201); const j = await r.json(); assert.equal(j.created, true); assert.equal(j.url, '/s/guides/Brand%20New'); assert.equal(j.title, 'Brand New');
  const page = await get('/s/guides/Brand%20New'); assert.equal(page.status, 200);
  assert.match(await page.text(), /href="\/s\/Home" class="internal-link"/);
  assert.match(await (await get('/s/')).text(), /href="\/s\/guides\/Brand%20New">Brand New</, 'in the sidebar');
  assert.equal((await json('PUT', '/s/_api/note', { rel: 'guides/Brand New.md', text: 'again', stamp: null })).status, 409);
  const list = await (await json('GET', '/s/_api/notes')).json();
  assert.ok(list.some(n => n.rel === 'guides/Brand New.md') && list.some(n => n.rel === 'sub/Draft.md' && n.hidden));
});

test('API: refuses bad paths and non-notes', async () => {
  for (const rel of ['../escape.md', 'sub/../Home.md', '.obsidian/app.md', 'locked/x.md', 'img/pic.png']) {
    const r = await json('PUT', '/s/_api/note', { rel, text: 'x', stamp: null });
    assert.equal(r.status, 400, rel);
  }
  assert.equal((await json('PUT', '/s/_api/note', { rel: 'Home.md', text: 42 })).status, 400);
  assert.equal((await json('GET', '/s/_api/note?rel=../cfg.json')).status, 400);
  assert.ok(!fs.existsSync(path.join(tmp.root, '..', 'escape.md')));
});

test('API: preview renders unsaved text with links resolved from the note position', async () => {
  const r = await json('POST', '/s/_api/preview', { rel: 'sub/Second.md', text: '# Hi\n\n[[Home]] and ==x== and [[Nope]]\n\n```mermaid\nflowchart LR\nA-->B\n```\n' });
  assert.equal(r.status, 200); const j = await r.json();
  assert.match(j.html, /href="\/s\/Home" class="internal-link"/); assert.match(j.html, /<mark>x<\/mark>/); assert.match(j.html, /unresolved/); assert.match(j.html, /<pre class="mermaid">/);
  assert.deepEqual(j.headings.map(h => h.text), ['Hi']);
  assert.equal(fs.readFileSync(path.join(tmp.root, 'sub/Second.md'), 'utf8').includes('==x=='), false, 'preview never writes');
});

test('API: CRLF files stay CRLF', async () => {
  const note = await (await json('GET', '/s/_api/note?rel=Crlf.md')).json();
  assert.equal(note.text, 'line one\nline two\n', 'normalised for the editor');
  await json('PUT', '/s/_api/note', { rel: 'Crlf.md', text: 'line one\nline two\nline three\n', stamp: note.stamp });
  assert.equal(fs.readFileSync(path.join(tmp.root, 'Crlf.md'), 'utf8'), 'line one\r\nline two\r\nline three\r\n');
});

test('API: delete moves the note to .trash, page becomes 404', async () => {
  const r = await json('DELETE', '/s/_api/note?rel=guides/Brand New.md');
  assert.deepEqual(await r.json(), { ok: true, rel: 'guides/Brand New.md', trashed: '.trash/guides/Brand New.md' });
  assert.ok(fs.existsSync(path.join(tmp.root, '.trash/guides/Brand New.md')));
  assert.equal((await get('/s/guides/Brand%20New')).status, 404);
  assert.equal((await json('DELETE', '/s/_api/note?rel=guides/Brand New.md')).status, 404);
});

test('API token: scripts can use Authorization: Bearer without a session', async () => {
  const r = await fetch(url('/s/_api/note?rel=Home.md'), { headers: { authorization: 'Bearer api-1' } });
  assert.equal(r.status, 200);
  assert.equal((await fetch(url('/s/_api/note?rel=Home.md'), { headers: { authorization: 'Bearer wrong' } })).status, 401);
});

test('logout clears the session; login attempts are rate limited', async () => {
  const out = await form('/s/_edit/_logout', {}, { cookie });
  assert.equal(out.status, 303); assert.match(out.headers.get('set-cookie'), /md2html_edit_s=;/);
  assert.equal((await get('/s/_edit/Home', { cookie: 'md2html_edit_s=garbage' })).status, 302);
  let last;
  for (let i = 0; i < 12; i++) last = await form('/s/_edit/_login', { user: 'x', password: 'y' });
  assert.equal(last.status, 429);
  await new Promise(r => setTimeout(r, 100));
  const events = logLines.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
  assert.ok(events.some(e => e.event === 'edit-login' && e.ok === true && e.user === 'sat'));
  assert.ok(events.some(e => e.event === 'edit' && e.action === 'create' && e.rel === 'guides/Brand New.md'));
  assert.ok(events.some(e => e.event === 'edit' && e.action === 'trash'));
  assert.ok(events.some(e => e.event === 'edit-denied' && e.site === 'ip'));
});
