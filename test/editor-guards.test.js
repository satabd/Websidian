'use strict';
// Editor guards: site login rate limiting, symlink/junction escapes on writes, and
// confirmation for agent instruction files (SKILL.md, MEMORY.md…) on untrusted sites.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { makeVault } = require('./helpers');
const { isProtected, memoryWarnings, resolveConfig, DEFAULT_PROTECT } = require('../src/editor');

const PORT = 23080 + Math.floor(Math.random() * 1000);
let tmp, outside, proc, logLines = '', junction = false;
const url = p => `http://127.0.0.1:${PORT}${p}`;
const api = (method, p, body) => fetch(url(p), { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-requested-with': 'test', authorization: 'Bearer tok' }, redirect: 'manual' });
const basic = (user, pass) => ({ authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') });

before(async () => {
  tmp = makeVault({
    'Home.md': '# Home\n',
    'skills/x/SKILL.md': '# Skill\nDo things.\n',
    'Agents.md': '# agents\n',
    'memories/MEMORY.md': 'one\n§\ntwo\n',
    'notes/MEMORY.md': 'not a hermes memory\n',
    'Plain.md': '# plain\n',
  });
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'md2html-outside-'));
  fs.writeFileSync(path.join(outside, 'victim.md'), 'outside\n');
  try { fs.symlinkSync(outside, path.join(tmp.root, 'linkdir'), 'junction'); junction = true; } catch { junction = false; }
  const cfg = path.join(tmp.root, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({
    port: PORT, host: '127.0.0.1', cacheDir: false, warm: false, log: 'json',
    rateLimit: { login: 3 },
    edit: { token: 'tok' },
    sites: [
      { slug: 'u', title: 'Untrusted', root: '.', untrusted: true },
      { slug: 'off', title: 'Untrusted, protection off', root: '.', untrusted: true, edit: { token: 'tok', protect: [] } },
      { slug: 'tr', title: 'Trusted', root: '.' },
      { slug: 'cp', title: 'Custom protect', root: '.', edit: { token: 'tok', protect: ['Plain.md'], memoryLimits: { 'MEMORY.md': 5 } } },
      { slug: 'b', title: 'Basic', root: '.', edit: false, auth: { users: { sat: 'pw' } } },
    ],
  }));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, MD2HTML_CONFIG: cfg, WEBSIDIAN_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', d => { logLines += d; if (logLines.includes('listening')) resolve(); });
    proc.stderr.on('data', d => { logLines += d; });
    proc.on('exit', code => reject(new Error('server exited ' + code + '\n' + logLines)));
    setTimeout(() => reject(new Error('server did not start\n' + logLines)), 10000);
  });
});
after(() => {
  if (proc) proc.kill();
  if (tmp) { try { fs.rmSync(path.join(tmp.root, 'linkdir'), { force: true, recursive: false }); } catch { try { fs.unlinkSync(path.join(tmp.root, 'linkdir')); } catch { /* ignore */ } } tmp.rm(); }
  if (outside) fs.rmSync(outside, { recursive: true, force: true });
});

// ---- pure helpers ---------------------------------------------------------------

test('isProtected: basenames in any folder, case-insensitive, globs with paths', () => {
  assert.equal(isProtected(DEFAULT_PROTECT, 'skills/x/SKILL.md'), true);
  assert.equal(isProtected(DEFAULT_PROTECT, 'agents.md'), true);
  assert.equal(isProtected(DEFAULT_PROTECT, 'notes/MySKILL.md'), false);
  assert.equal(isProtected([], 'SKILL.md'), false);
  assert.equal(isProtected(['prompts/**'], 'prompts/a/b.md'), true);
  assert.equal(isProtected(['prompts/*.md'], 'prompts/a/b.md'), false);
  assert.equal(isProtected(['*.prompt.md'], 'x/y.PROMPT.md'), true);
});

test('resolveConfig: protect and memoryLimits, site value else top-level', () => {
  assert.equal(resolveConfig(undefined, { token: 't' }).protect, null);
  assert.deepEqual(resolveConfig({ token: 't', protect: [] }, { token: 't', protect: ['A.md'] }).protect, []);
  assert.deepEqual(resolveConfig({ token: 't' }, { token: 't', protect: ['A.md'] }).protect, ['A.md']);
});

test('memoryWarnings: only untrusted memories/MEMORY.md and USER.md over the limit', () => {
  const v = { untrusted: true, editor: {} };
  const long = 'x'.repeat(1500) + '\n§\n' + 'y'.repeat(1000);
  const w = memoryWarnings(v, 'memories/MEMORY.md', long);
  assert.equal(w.length, 1); assert.match(w[0], /2 entries/); assert.match(w[0], /2,200/);
  assert.deepEqual(memoryWarnings(v, 'notes/MEMORY.md', long), []);
  assert.deepEqual(memoryWarnings({ untrusted: false, editor: {} }, 'memories/MEMORY.md', long), []);
  assert.equal(memoryWarnings(v, 'memories/USER.md', 'u'.repeat(1400)).length, 1);
  assert.deepEqual(memoryWarnings(v, 'memories/USER.md', 'u'.repeat(1300)), []);
});

// ---- site HTTP Basic auth rate limiting ---------------------------------------------

test('basic auth: failures hit 429 after the limit, successes do not count', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await fetch(url('/b/'), { headers: basic('sat', 'pw'), redirect: 'manual' })).status, 200, 'success ' + i);
  assert.equal((await fetch(url('/b/'))).status, 401, 'no credentials: challenge, not counted');
  for (let i = 0; i < 3; i++) assert.equal((await fetch(url('/b/'), { headers: basic('sat', 'wrong') })).status, 401, 'failure ' + i);
  const blocked = await fetch(url('/b/'), { headers: basic('sat', 'wrong') });
  assert.equal(blocked.status, 429); assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await fetch(url('/b/'), { headers: basic('sat', 'pw') })).status, 429, 'credentials are not checked while blocked');
});

// ---- symlink / junction escapes ---------------------------------------------------------

test('junction pointing outside the vault: write and delete refused', async (t) => {
  if (!junction) return t.skip('cannot create a junction/symlink here');
  const w = await api('PUT', '/tr/_api/note', { rel: 'linkdir/evil.md', text: 'pwned', stamp: null });
  assert.equal(w.status, 400); assert.match((await w.json()).error, /link/);
  assert.ok(!fs.existsSync(path.join(outside, 'evil.md')));
  const w2 = await api('PUT', '/tr/_api/note', { rel: 'linkdir/sub/evil.md', text: 'pwned', stamp: null });
  assert.equal(w2.status, 400); assert.ok(!fs.existsSync(path.join(outside, 'sub')));
  const d = await api('DELETE', '/tr/_api/note?rel=' + encodeURIComponent('linkdir/victim.md'));
  assert.equal(d.status, 400);
  assert.ok(fs.existsSync(path.join(outside, 'victim.md')));
  const ok = await api('PUT', '/tr/_api/note', { rel: 'deep/nested/New.md', text: '# new\n', stamp: null });
  assert.equal(ok.status, 201);
  assert.equal(fs.readFileSync(path.join(tmp.root, 'deep/nested/New.md'), 'utf8'), '# new\n');
  assert.equal((await api('DELETE', '/tr/_api/note?rel=' + encodeURIComponent('deep/nested/New.md'))).status, 200);
});

test('trash folder that is a junction outside the vault: delete refused', async (t) => {
  if (!junction) return t.skip('cannot create a junction/symlink here');
  const trashOut = fs.mkdtempSync(path.join(os.tmpdir(), 'md2html-trash-'));
  try {
    fs.mkdirSync(path.join(tmp.root, '.trash'), { recursive: true });
    fs.symlinkSync(trashOut, path.join(tmp.root, '.trash', 'jt'), 'junction');
    fs.writeFileSync(path.join(tmp.root, 'jt.md'), 'x'); fs.mkdirSync(path.join(tmp.root, 'jt'), { recursive: true }); fs.writeFileSync(path.join(tmp.root, 'jt', 'n.md'), 'x');
    const d = await api('DELETE', '/tr/_api/note?rel=' + encodeURIComponent('jt/n.md'));
    assert.equal(d.status, 400);
    assert.ok(fs.existsSync(path.join(tmp.root, 'jt', 'n.md')));
  } finally { try { fs.unlinkSync(path.join(tmp.root, '.trash', 'jt')); } catch { fs.rmSync(path.join(tmp.root, '.trash', 'jt'), { force: true }); } fs.rmSync(trashOut, { recursive: true, force: true }); }
});

// ---- instruction files -----------------------------------------------------------------

test('untrusted site: protected file needs confirm to save; GET shows protected', async () => {
  const g = await (await api('GET', '/u/_api/note?rel=skills/x/SKILL.md')).json();
  assert.equal(g.protected, true); assert.ok(g.reason);
  const text = g.text + 'More.\n';
  const r = await api('PUT', '/u/_api/note', { rel: 'skills/x/SKILL.md', text, stamp: g.stamp });
  assert.equal(r.status, 428);
  const j = await r.json(); assert.equal(j.needsConfirm, 'instructions'); assert.match(j.reason, /instructions/); assert.deepEqual(j.warnings, []);
  assert.equal(fs.readFileSync(path.join(tmp.root, 'skills/x/SKILL.md'), 'utf8'), g.text, 'not written');
  const ok = await api('PUT', '/u/_api/note', { rel: 'skills/x/SKILL.md', text, stamp: g.stamp, confirm: 'instructions' });
  assert.equal(ok.status, 200);
  assert.equal(fs.readFileSync(path.join(tmp.root, 'skills/x/SKILL.md'), 'utf8'), text);
  // creating a new one needs it too
  assert.equal((await api('PUT', '/u/_api/note', { rel: 'skills/y/skill.md', text: 'x', stamp: null })).status, 428);
  const nf = await (await api('GET', '/u/_api/note?rel=skills/y/SKILL.md')).json();
  assert.equal(nf.exists, false); assert.equal(nf.protected, true);
});

test('untrusted site: delete of a protected file needs ?confirm=instructions', async () => {
  fs.writeFileSync(path.join(tmp.root, 'TOOLS.md'), 'tools\n');
  const r = await api('DELETE', '/u/_api/note?rel=TOOLS.md');
  assert.equal(r.status, 428); assert.equal((await r.json()).needsConfirm, 'instructions');
  assert.ok(fs.existsSync(path.join(tmp.root, 'TOOLS.md')));
  assert.equal((await api('DELETE', '/u/_api/note?rel=TOOLS.md&confirm=instructions')).status, 200);
  assert.ok(!fs.existsSync(path.join(tmp.root, 'TOOLS.md')));
});

test('untrusted site: non-protected file saves normally', async () => {
  const g = await (await api('GET', '/u/_api/note?rel=Plain.md')).json();
  assert.equal(g.protected, false);
  assert.equal((await api('PUT', '/u/_api/note', { rel: 'Plain.md', text: '# plain 2\n', stamp: g.stamp })).status, 200);
});

test('edit.protect [] disables the confirmation', async () => {
  const g = await (await api('GET', '/off/_api/note?rel=Agents.md')).json();
  assert.equal(g.protected, false);
  assert.equal((await api('PUT', '/off/_api/note', { rel: 'Agents.md', text: '# agents 2\n', stamp: g.stamp })).status, 200);
});

test('trusted site without edit.protect: no confirmation; with edit.protect: its own list', async () => {
  const g = await (await api('GET', '/tr/_api/note?rel=skills/x/SKILL.md')).json();
  assert.equal(g.protected, false);
  assert.equal((await api('PUT', '/tr/_api/note', { rel: 'skills/x/SKILL.md', text: g.text + 'trusted\n', stamp: g.stamp })).status, 200);
  const p = await (await api('GET', '/cp/_api/note?rel=Plain.md')).json();
  assert.equal(p.protected, true);
  assert.equal((await api('PUT', '/cp/_api/note', { rel: 'Plain.md', text: 'x', stamp: p.stamp })).status, 428);
  assert.equal((await api('GET', '/cp/_api/note?rel=skills/x/SKILL.md').then(r => r.json())).protected, false, 'custom list replaces the default');
  const m = await (await api('GET', '/cp/_api/note?rel=memories/MEMORY.md')).json();
  assert.equal((await api('PUT', '/cp/_api/note', { rel: 'memories/MEMORY.md', text: m.text + 'more text', stamp: m.stamp })).status, 200, 'memory limits only on untrusted sites');
});

test('memories/MEMORY.md over the limit: 428 with a warning, saved with confirm', async () => {
  const g = await (await api('GET', '/u/_api/note?rel=memories/MEMORY.md')).json();
  const text = Array.from({ length: 5 }, (_, i) => `entry ${i} ` + 'z'.repeat(600)).join('\n§\n');
  const r = await api('PUT', '/u/_api/note', { rel: 'memories/MEMORY.md', text, stamp: g.stamp });
  assert.equal(r.status, 428);
  const j = await r.json(); assert.equal(j.warnings.length, 1); assert.match(j.warnings[0], /5 entries/); assert.match(j.warnings[0], /over the agent's limit of 2,200/);
  assert.equal((await api('PUT', '/u/_api/note', { rel: 'memories/MEMORY.md', text, stamp: g.stamp, confirm: 'instructions' })).status, 200);
  // outside a memories folder: protected by name, but no length warning
  const n = await (await api('GET', '/u/_api/note?rel=notes/MEMORY.md')).json();
  const r2 = await (await api('PUT', '/u/_api/note', { rel: 'notes/MEMORY.md', text, stamp: n.stamp })).json();
  assert.deepEqual(r2.warnings, []);
});
