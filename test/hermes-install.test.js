'use strict';
// The Hermes dashboard supervisor starts `node <app_dir>/src/server.js`, where app_dir is a *copy* of
// this repository made by deploy/install-local.{sh,ps1} — not a checkout. A copy that misses public/ or
// node_modules boots far enough to look installed and then serves broken pages, which is exactly what
// the 2026-09-16 macOS install report ran into. So build that layout here and boot it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const DEPLOY = path.join(REPO, 'integrations', 'hermes', 'websidian', 'deploy');
// What an installed app_dir holds. Keep in step with both installer scripts (asserted below).
const RUNTIME = ['src', 'public', 'package.json', 'package-lock.json'];

const PORT = 18500 + Math.floor(Math.random() * 400);
const get = (p, headers = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, { headers, redirect: 'manual' });

let tmp, appDir, proc;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'websidian-install-'));
  appDir = path.join(tmp, 'plugin-data', 'websidian', 'app');
  fs.mkdirSync(appDir, { recursive: true });
  for (const entry of RUNTIME) {
    fs.cpSync(path.join(REPO, entry), path.join(appDir, entry), { recursive: true });
  }
  // Stands in for `npm --prefix <app_dir> ci --omit=dev`: same location, without the network.
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(appDir, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  // The installers stamp the copy so the dashboard can tell runtime and plugin apart when they drift.
  fs.writeFileSync(path.join(appDir, 'websidian.version'), JSON.stringify(
    { revision: 'abc1234', installed_at: '2026-09-16T00:00:00Z', source: REPO, component: 'runtime' }));

  const vault = path.join(tmp, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, 'Hello.md'), '# Hello\n\nInstalled, with `code` and $x^2$.\n');
  const cfg = path.join(tmp, 'websidian.config.json');
  fs.writeFileSync(cfg, JSON.stringify({
    port: PORT, host: '127.0.0.1', cacheDir: path.join(tmp, 'cache'), warm: false,
    sites: [{ slug: 'smoke', title: 'Smoke', root: vault, untrusted: true }],
  }));

  proc = spawn(process.execPath, [path.join(appDir, 'src', 'server.js')],
    { env: { ...process.env, WEBSIDIAN_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', d => { out += d; if (out.includes('listening')) resolve(); });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', code => reject(new Error(`installed server exited ${code}\n${out}`)));
    setTimeout(() => reject(new Error(`installed server did not start\n${out}`)), 15000);
  });
});

after(() => {
  if (proc) proc.kill();
  // The junction points at the real node_modules; remove it without following it.
  try { fs.unlinkSync(path.join(appDir, 'node_modules')); } catch { /* already gone */ }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('/_health answers from the installed copy', async () => {
  const r = await get('/_health');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.sites.map(s => [s.slug, s.notes, s.ok]), [['smoke', 1, true]]);
});

test('/_health reports the install stamp, so a half-upgraded pair is visible', async () => {
  const body = await (await get('/_health')).json();
  assert.equal(body.version.revision, 'abc1234');
  assert.equal(body.version.component, 'runtime');
});

test('an untrusted note renders with nosniff and a CSP', async () => {
  const r = await get('/smoke/Hello');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy') || '', /script-src[^;]*'nonce-/);
  assert.match(await r.text(), /Installed, with/);
});

test('assets resolve: public/ and the vendored node_modules came along', async () => {
  const page = await (await get('/smoke/Hello')).text();
  const assets = [...page.matchAll(/(?:href|src)="(\/_(?:static|vendor)\/[^"]+)"/g)].map(m => m[1]);
  assert.ok(assets.some(a => a.startsWith('/_static/')), 'page should load something from public/');
  for (const asset of new Set(assets)) {
    const r = await get(asset.replace(/&amp;/g, '&'));
    assert.equal(r.status, 200, `${asset} -> ${r.status}`);
  }
  // /_vendor/* is served straight out of node_modules, so check one whether or not this page uses it.
  assert.equal((await get('/_vendor/hljs/styles/github.min.css')).status, 200);
});

test('both installers copy the same runtime files', () => {
  for (const script of ['install-local.sh', 'install-local.ps1']) {
    const text = fs.readFileSync(path.join(DEPLOY, script), 'utf8');
    for (const entry of RUNTIME) {
      assert.match(text, new RegExp(entry.replace('.', '\\.')), `${script} should install ${entry}`);
    }
    assert.match(text, /npm .*--prefix|--prefix \$AppDir/, `${script} should run npm ci inside app_dir`);
    assert.match(text, /websidian\.version/, `${script} should stamp both copies with the revision`);
    assert.match(text, /restart-runtime|RestartRuntime/, `${script} should offer the runtime-only restart`);
  }
});
