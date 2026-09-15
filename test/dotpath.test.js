'use strict';
// A vault whose absolute path contains a dot-folder (e.g. ~/.hermes/memories) must still serve its
// attachments: the dotfile refusal applies to the vault-relative path only.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 23080 + Math.floor(Math.random() * 1000);
const url = p => `http://127.0.0.1:${PORT}${p}`;
let dir, proc;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-dot-'));
  const vault = path.join(dir, '.agent', 'vault');
  fs.mkdirSync(path.join(vault, 'img'), { recursive: true });
  fs.mkdirSync(path.join(vault, '.hidden'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Note.md'), '# Note\n\n![[pic.png]]\n');
  fs.writeFileSync(path.join(vault, 'img', 'pic.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.writeFileSync(path.join(vault, '.hidden', 'secret.png'), 'x');
  const cfg = path.join(dir, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ port: PORT, host: '127.0.0.1', cacheDir: false, warm: false,
    sites: [{ slug: 't', title: 'T', root: vault }, { slug: 'u', title: 'U', root: vault, untrusted: true }] }));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, MD2HTML_CONFIG: cfg, WEBSIDIAN_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', d => { out += d; if (out.includes('listening')) resolve(); });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', code => reject(new Error('server exited ' + code + '\n' + out)));
    setTimeout(() => reject(new Error('server did not start\n' + out)), 10000);
  });
});
after(() => { if (proc) proc.kill(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('attachments are served from a vault under a dot-folder; dot paths inside the vault are not', async () => {
  for (const site of ['t', 'u']) {
    const ok = await fetch(url(`/${site}/img/pic.png`));
    assert.equal(ok.status, 200, `${site}: attachment under .agent/ is served`);
    const hidden = await fetch(url(`/${site}/.hidden/secret.png`));
    assert.notEqual(hidden.status, 200, `${site}: dot-folder inside the vault stays hidden`);
  }
  const page = await fetch(url('/u/Note'));
  assert.equal(page.status, 200);
});

test('the editor modules handler serves files by name only (dotfile check on the file name)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'esm.js'), 'utf8');
  assert.match(src, /sendFile\(path\.basename\(file\), \{ root: path\.dirname\(file\)/);
});
