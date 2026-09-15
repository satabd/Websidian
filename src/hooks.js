'use strict';
// Operational endpoints:
//   POST /_purge?site=x        (Authorization: Bearer <adminToken>)  -> clear caches, rescan
//   POST /_hooks/git/:site      (GitHub X-Hub-Signature-256 or ?token=) -> run the site's
//                                update command (default: git pull --ff-only) in the vault, rescan.
// Both are disabled unless the corresponding secret is configured.

const crypto = require('crypto');
const { execFile } = require('child_process');
const { safeEqual } = require('./auth');

function bearer(req) { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : (req.query.token !== undefined ? String(req.query.token) : ''); }

function verifyGithub(rawBody, secret, header) {
  if (!header || !header.startsWith('sha256=')) return false;
  const mac = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(mac, header);
}

function runCommand(cmd, cwd, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const [file, ...args] = Array.isArray(cmd) ? cmd : String(cmd).split(/\s+/);
    execFile(file, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') + (err && !stderr ? String(err.message) : '') });
    });
  });
}

function install(router, { config, vaults, bySlug, cache, searchIndex, log }) {
  router.post('/_purge', async (req, res) => {
    if (!config.adminToken) return res.status(404).json({ error: 'purge disabled: set adminToken in the config' });
    if (!safeEqual(bearer(req), config.adminToken)) return res.status(401).json({ error: 'bad token' });
    const site = req.query.site ? String(req.query.site) : null;
    if (site && !bySlug.has(site)) return res.status(404).json({ error: 'unknown site' });
    await cache.clear(site);
    if (searchIndex) for (const k of [...searchIndex.byVault.keys()]) if (!site || k === site) searchIndex.byVault.delete(k);
    for (const v of vaults) if (!site || v.slug === site) { v.metaCache.clear(); await v.scan(); }
    log('purge', { site: site || 'all' });
    res.json({ ok: true, site: site || 'all' });
  });

  // Raw body needed for the HMAC; parse ourselves (small payloads only).
  router.post('/_hooks/git/:site', (req, res) => {
    const vault = bySlug.get(req.params.site);
    if (!vault || !vault.webhook || !vault.webhook.secret) return res.status(404).json({ error: 'no webhook configured for this site' });
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size <= 1_000_000) chunks.push(c); });
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const sig = req.headers['x-hub-signature-256'];
      const authorised = sig ? verifyGithub(raw, vault.webhook.secret, String(sig)) : safeEqual(bearer(req), vault.webhook.secret);
      if (!authorised) return res.status(401).json({ error: 'bad signature or token' });
      if (req.headers['x-github-event'] === 'ping') return res.json({ ok: true, pong: true });
      const cmd = vault.webhook.command || 'git pull --ff-only';
      const t0 = Date.now();
      const result = await runCommand(cmd, vault.root, vault.webhook.timeoutMs);
      await vault.scan();
      log('webhook', { site: vault.slug, ok: result.ok, code: result.code, ms: Date.now() - t0 });
      res.status(result.ok ? 200 : 500).json({ ok: result.ok, code: result.code, stdout: result.stdout.slice(-2000), stderr: result.stderr.slice(-2000), ms: Date.now() - t0 });
    });
  });
}

module.exports = { install, verifyGithub, runCommand };
