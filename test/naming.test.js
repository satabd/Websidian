'use strict';
// The md2html -> Websidian rename (roadmap phase 0). Two of the old names are a
// public contract — a page someone else wrote listens for them — so they are
// kept as aliases rather than dropped, and that is worth a test.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { makeVault, FIXTURE } = require('./helpers');

const PORT = 18700 + Math.floor(Math.random() * 300);
let tmp, proc;
const get = (p, headers = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, { headers, redirect: 'manual' });

before(async () => {
  tmp = makeVault(FIXTURE);
  const cfg = path.join(tmp.root, 'naming-cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({
    port: PORT, host: '127.0.0.1', cacheDir: 'cache', warm: false, log: false,
    sites: [
      { slug: 's', title: 'S', root: '.', home: 'Home' },
      { slug: 'p', title: 'P', root: '.', home: 'Home', auth: { token: 'tok-1' } },
    ],
    edit: { users: { u: 'p' }, secret: 'x'.repeat(40) },
  }));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, WEBSIDIAN_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', d => { out += d; if (out.includes('listening')) resolve(); });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', code => reject(new Error(`server exited ${code}\n${out}`)));
    setTimeout(() => reject(new Error(`server did not start\n${out}`)), 10000);
  });
});
after(() => { if (proc) proc.kill(); if (tmp) tmp.rm(); });

test('the page global is window.WEBSIDIAN, with window.MD2HTML kept as an alias', async () => {
  const html = await (await get('/s/')).text();
  assert.match(html, /window\.WEBSIDIAN=window\.MD2HTML=\{site:/,
    'both names must be assigned, so a script written against the old one still works');
});

test('site cookies are websidian_, not md2html_', async () => {
  // A share-token link sets the cookie and redirects to the clean URL.
  const res = await get('/p/?token=tok-1');
  const cookie = res.headers.get('set-cookie') || '';
  assert.match(cookie, /websidian_p=tok-1/);
  assert.doesNotMatch(cookie, /md2html_p=/);
});

test('the editor cookie is websidian_edit_, and its global is aliased too', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/s/_edit/_login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'user=u&password=p',
    redirect: 'manual',
  });
  const cookie = res.headers.get('set-cookie') || '';
  assert.match(cookie, /websidian_edit_s=/);
  const session = cookie.split(';')[0];
  const page = await (await get('/s/_edit/Home', { cookie: session })).text();
  assert.match(page, /window\.WEBSIDIAN_EDIT=window\.MD2HTML_EDIT=/);
});

test('the embed height message is sent under both names', () => {
  // public/app.js runs in the browser; assert on the source rather than boot one.
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /'websidian:height'/);
  assert.match(app, /'md2html:height'/, 'existing embedders listen for the old type');
});

test('both config env vars still select the config file', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(server, /WEBSIDIAN_CONFIG \|\| process\.env\.MD2HTML_CONFIG/);
  assert.match(server, /websidian\.config\.json/);
  assert.match(server, /md2html\.config\.json/);
});

test('no example in the docs uses a real client vault name', () => {
  const docs = path.join(__dirname, '..', 'docs');
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out); else if (e.name.endsWith('.md')) out.push(full);
    }
    return out;
  };
  const files = [...walk(docs), path.join(__dirname, '..', 'README.md')];
  const bad = [];
  for (const f of files) {
    // The work log is a historical record; it may name what actually happened.
    if (path.basename(f) === 'Work log.md') continue;
    const body = fs.readFileSync(f, 'utf8');
    for (const term of ['odoohms', 'OdooHMS', 'AlDawliya']) {
      if (body.includes(term)) bad.push(`${path.relative(path.join(__dirname, '..'), f)} → ${term}`);
    }
  }
  assert.deepStrictEqual(bad, [], `client project names leaked into the docs:\n  ${bad.join('\n  ')}`);
});
