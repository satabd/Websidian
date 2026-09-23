// Config generation, secrets and the Node supervisor for the Websidian server the plugin runs behind the Gateway.
// Standard library only (no OpenClaw imports) so it can be unit-tested anywhere; plugin.js wires it in.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { websidianBasePath } from './sites.js';

export const PROXY_SECRET_HEADER = 'x-websidian-proxy-secret';
export const PROXY_USER_HEADER = 'x-websidian-user';
export const LOOPBACK = Object.freeze(['127.0.0.1', '::1']);
export const VERSION_FILE = 'websidian.version';
const SECRET_KEYS = ['proxy_secret', 'edit_secret', 'site_token', 'session_secret'];

// Everything the supervisor needs, derived from the plugin settings (guard.Settings).
export function resolveRuntime(settings) {
  const ui = settings.ui;
  return {
    dataDir: ui.dataDir,
    appDir: ui.appDir,
    bundleDir: ui.bundleDir || '',
    node: ui.node,
    port: ui.port,
    publicBase: ui.publicBase,
    basePath: websidianBasePath(ui.publicBase),
    configPath: path.join(ui.dataDir, 'websidian.config.json'),
    logPath: path.join(ui.dataDir, 'server.log'),
    pidPath: path.join(ui.dataDir, 'server.pid'),
    secretsPath: path.join(ui.dataDir, 'secrets.json'),
    sites: settings.vaults.filter(v => !v.external),
  };
}

// Atomic write with mode 0600 (where the OS supports it).
export function writePrivate(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  try { fs.renameSync(tmp, p); } catch (err) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } throw err; }
  try { fs.chmodSync(p, 0o600); } catch { /* not supported */ }
}

// {proxy_secret, edit_secret, site_token, session_secret}, generated once (64 url-safe chars each) and kept in `p`.
export function loadOrCreateSecrets(p) {
  let data = {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (raw && typeof raw === 'object') data = Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string'));
  } catch { /* first run or unreadable: regenerate */ }
  let changed = false;
  for (const k of SECRET_KEYS) {
    if (!data[k] || data[k].length < 48) { data[k] = crypto.randomBytes(48).toString('base64url'); changed = true; }
  }
  if (changed || !fs.existsSync(p)) writePrivate(p, JSON.stringify(data, null, 2) + '\n');
  return data;
}

// The Websidian config for the plugin-managed server (bound to loopback, proxy sign-in only).
export function buildConfig(runtime, secrets) {
  const sites = runtime.sites.map(s => ({
    slug: s.slug,
    title: s.title,
    root: path.resolve(s.path),
    untrusted: !!s.untrusted,
    // Defence in depth for other local processes: only the proxy (which passes proxyAuth) gets in.
    auth: { token: secrets.site_token },
    edit: s.edit ? { allowFrom: [...LOOPBACK], secret: secrets.edit_secret } : false,
  }));
  return {
    host: '127.0.0.1',
    port: runtime.port,
    basePath: runtime.basePath,
    publicUrl: runtime.publicBase,
    cacheDir: path.join(runtime.dataDir, 'cache'),
    warm: false,
    proxyAuth: { secret: secrets.proxy_secret, secretHeader: PROXY_SECRET_HEADER, userHeader: PROXY_USER_HEADER, allowFrom: [...LOOPBACK] },
    sites,
  };
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sortKeys(value[k])]));
  return value;
}

export function configText(cfg) { return JSON.stringify(sortKeys(cfg), null, 2) + '\n'; }

// Write atomically (0600: it holds secrets). True when the content changed.
export function writeConfigIfChanged(p, cfg) {
  const text = configText(cfg);
  try { if (fs.readFileSync(p, 'utf8') === text) return false; } catch { /* missing */ }
  writePrivate(p, text);
  return true;
}

export function tailLines(p, n = 20, maxBytes = 64_000) {
  let data;
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      data = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  return data.split(/(?<=\n)/).slice(-n);
}

// {revision, installed_at, source, component} written by the installers, or null (a checkout has no stamp).
export function readVersionStamp(p) {
  try { const data = JSON.parse(fs.readFileSync(p, 'utf8')); return data && typeof data === 'object' ? data : null; } catch { return null; }
}

// True only when both stamps name a revision and the two differ (half an upgrade).
export function versionSkew(app, plugin) {
  const a = String((app && app.revision) || '');
  const p = String((plugin && plugin.revision) || '');
  return !!(a && p && a !== p);
}

function pidAlive(pid) {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); } catch (err) { return err.code === 'EPERM'; }
  try { // a zombie (our exited child not reaped yet) is not alive
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'latin1');
    if (stat.split(')').pop().trim().split(/\s+/)[0] === 'Z') return false;
  } catch { /* no /proc */ }
  return true;
}

// Guard against PID reuse before signalling a PID read from the PID file.
function pidIsWebsidian(pid, serverJs) {
  let argv;
  try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch { return process.platform !== 'linux' && pidAlive(pid); }
  return argv.includes(serverJs);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// How to run npm with the Gateway's own node, without a shell: the npm that ships beside that node
// (Windows: <dir>/node_modules/npm; Unix: <prefix>/lib/node_modules/npm), else `npm` on PATH.
export function npmCommand(node = process.execPath, exists = fs.existsSync) {
  const dir = path.dirname(node);
  for (const cli of [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (exists(cli)) return { command: node, args: [cli], shell: false };
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [], shell: process.platform === 'win32' };
}

// True when <appDir> must be (re)installed from the bundle: no server.js yet, or another revision.
export function needsProvision(rt) {
  if (!rt.bundleDir) return false;
  if (!fs.existsSync(path.join(rt.appDir, 'src', 'server.js'))) return true;
  const have = readVersionStamp(path.join(rt.appDir, VERSION_FILE));
  const want = readVersionStamp(path.join(rt.bundleDir, VERSION_FILE));
  return !have || !want || have.revision !== want.revision || have.installed_at !== want.installed_at;
}

function run(cmd, args, { cwd, env, shell, logPath, timeoutMs = 15 * 60_000 }) {
  return new Promise((resolve) => {
    let logFd;
    try { logFd = fs.openSync(logPath, 'a'); } catch { /* no log */ }
    const child = spawn(cmd, args, { cwd, env, shell, windowsHide: true, stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'] });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    const done = (code, err) => { clearTimeout(timer); if (logFd !== undefined) try { fs.closeSync(logFd); } catch { /* closed */ } resolve({ code, err }); };
    child.on('error', (err) => done(-1, err));
    child.on('exit', (code) => done(code));
  });
}

// Keeps one Websidian Node process running for the Gateway.
// - ensure(): regenerate the config from settings, restart the process when the config changed, spawn it when
//   /_health does not answer, with a restart budget (maxStarts per windowMs) and exponential backoff between
//   consecutive failed starts.
// - The process runs detached with stdout/stderr appended to server.log; its PID is kept in server.pid so a
//   restarted Gateway can adopt (and later restart) it.
export class Supervisor {
  constructor(loadSettings, { maxStarts = 5, windowMs = 60_000, startupTimeoutMs = 20_000, log = () => {} } = {}) {
    this.loadSettings = loadSettings;
    this.maxStarts = maxStarts;
    this.windowMs = windowMs;
    this.startupTimeoutMs = startupTimeoutMs;
    this.log = log;
    this.starts = [];
    this.failures = 0;
    this.nextAllowed = 0;
    this.proc = null;
    this.runtime = null;
    this.lastError = '';
    this.secretsCache = null;
    this.timer = null;
    this.busy = null;
  }

  resolve() {
    this.runtime = resolveRuntime(this.loadSettings());
    return this.runtime;
  }

  async health(rt, timeoutMs = 1500) {
    rt = rt || this.runtime || this.resolve();
    try {
      const res = await fetch(`http://127.0.0.1:${rt.port}${rt.basePath}/_health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.status !== 200) return null;
      const data = await res.json();
      return data && data.ok ? data : null;
    } catch { return null; }
  }

  pid(rt) {
    rt = rt || this.runtime || this.resolve();
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return this.proc.pid;
    let pid;
    try { pid = parseInt(fs.readFileSync(rt.pidPath, 'utf8').trim(), 10); } catch { return null; }
    const serverJs = path.join(rt.appDir, 'src', 'server.js');
    return pidAlive(pid) && pidIsWebsidian(pid, serverJs) ? pid : null;
  }

  secrets(rt) {
    rt = rt || this.runtime || this.resolve();
    if (this.secretsCache && this.secretsCache.path === rt.secretsPath) return this.secretsCache.data;
    const data = loadOrCreateSecrets(rt.secretsPath);
    this.secretsCache = { path: rt.secretsPath, data };
    return data;
  }

  // Serialized: concurrent callers share one in-flight ensure().
  ensure() {
    if (this.busy) return this.busy;
    this.busy = this._ensure().finally(() => { this.busy = null; });
    return this.busy;
  }

  async _ensure() {
    const rt = this.resolve();
    if (!rt.sites.length) {
      this.lastError = 'no vaults configured (plugins.entries.websidian.config.vaults)';
      return { running: false, error: this.lastError };
    }
    if (needsProvision(rt)) {
      const res = await this.provision(rt);
      if (!res.ok) return { running: false, error: this.lastError };
    }
    const serverJs = path.join(rt.appDir, 'src', 'server.js');
    if (!fs.existsSync(serverJs)) {
      this.lastError = `Websidian is not installed: ${serverJs} not found (run deploy/install-local.sh or deploy/install-into-container.sh)`;
      return { running: false, error: this.lastError };
    }
    const cfg = buildConfig(rt, this.secrets(rt));
    const changed = writeConfigIfChanged(rt.configPath, cfg);
    let healthy = await this.health(rt);
    // Only replace a healthy process for a config change when a start is actually allowed: killing it and
    // then being refused by the restart budget would turn a config edit into an outage. The next tick
    // retries once the budget frees up, and the process keeps serving the old config until then.
    if (changed && this.pid(rt)) {
      if (this.canSpawn()) { await this.terminate(rt); healthy = null; } else if (healthy) {
        this.lastError = 'the config changed but the restart budget is exhausted; keeping the running process until it frees up';
        this.log(`websidian: ${this.lastError}`);
      }
    }
    if (healthy) { this.failures = 0; this.lastError = ''; return { running: true, pid: this.pid(rt) }; }
    if (this.pid(rt)) { // started but not answering yet (or wedged): give it time, then replace it
      if (await this.waitHealthy(rt, this.startupTimeoutMs / 2)) return { running: true, pid: this.pid(rt) };
      await this.terminate(rt);
    }
    return this.spawn(rt);
  }

  // Install the bundled runtime into <appDir>: copy it to a staging folder beside appDir, `npm ci` there with
  // Websidian's own lock file (no scripts, no dev dependencies), then swap it in. The stamp is copied last, so a
  // half-finished install is retried on the next tick. Shares the restart budget and backoff with spawn().
  async provision(rt) {
    if (!this.canSpawn()) return { ok: false };
    this.starts.push(Date.now());
    const staging = rt.appDir + '.installing';
    const old = rt.appDir + '.old';
    fs.mkdirSync(rt.dataDir, { recursive: true });
    this.lastError = 'installing the Websidian runtime (first start or an update; about a minute)';
    this.log(`websidian: ${this.lastError} into ${rt.appDir}`);
    try {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });
      for (const f of ['src', 'public', 'package.json', 'package-lock.json']) {
        if (fs.existsSync(path.join(rt.bundleDir, f))) fs.cpSync(path.join(rt.bundleDir, f), path.join(staging, f), { recursive: true });
      }
      try { fs.appendFileSync(rt.logPath, `
[${new Date().toISOString()}] websidian-openclaw: npm ci in ${staging}
`); } catch { /* no log */ }
      const npm = npmCommand(rt.node);
      const env = { ...process.env };
      delete env.NODE_OPTIONS;
      const res = await run(npm.command, [...npm.args, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: staging, env, shell: npm.shell, logPath: rt.logPath });
      if (res.code !== 0) throw new Error(res.err ? `cannot run npm: ${res.err.message}` : `npm ci exited with code ${res.code} (see server.log)`);
      await this.terminate(rt);
      fs.rmSync(old, { recursive: true, force: true });
      if (fs.existsSync(rt.appDir)) fs.renameSync(rt.appDir, old);
      fs.renameSync(staging, rt.appDir);
      fs.copyFileSync(path.join(rt.bundleDir, VERSION_FILE), path.join(rt.appDir, VERSION_FILE));
      fs.rmSync(old, { recursive: true, force: true });
      this.failures = 0;
      this.lastError = '';
      this.log(`websidian: runtime installed in ${rt.appDir}`);
      return { ok: true };
    } catch (err) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
      this.failed(`installing the Websidian runtime failed: ${err.message}`);
      return { ok: false };
    }
  }

  async waitHealthy(rt, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.health(rt, 1000)) return true;
      if (this.proc && this.proc.exitCode !== null) return false;
      await sleep(250);
    }
    return false;
  }

  // True when a start would be allowed right now (restart budget and backoff both clear).
  canSpawn(now = Date.now()) {
    this.starts = this.starts.filter(t => now - t <= this.windowMs);
    return this.starts.length < this.maxStarts && now >= this.nextAllowed;
  }

  async spawn(rt) {
    const now = Date.now();
    this.starts = this.starts.filter(t => now - t <= this.windowMs);
    if (this.starts.length >= this.maxStarts || now < this.nextAllowed) {
      const wait = Math.max(this.nextAllowed - now, this.starts.length >= this.maxStarts ? this.starts[0] + this.windowMs - now : 0);
      this.lastError = `Websidian keeps failing to start; next attempt in ${Math.floor(wait / 1000) + 1}s (see server.log)`;
      return { running: false, error: this.lastError };
    }
    this.starts.push(now);
    fs.mkdirSync(rt.dataDir, { recursive: true });
    const env = { ...process.env };
    for (const k of ['MD2HTML_CONFIG', 'NODE_OPTIONS']) delete env[k];
    Object.assign(env, { WEBSIDIAN_CONFIG: rt.configPath, HOST: '127.0.0.1', PORT: String(rt.port), NODE_ENV: 'production' });
    const serverJs = path.join(rt.appDir, 'src', 'server.js');
    let logFd;
    try {
      logFd = fs.openSync(rt.logPath, 'a');
      fs.writeSync(logFd, `\n[${new Date().toISOString()}] websidian-openclaw: starting ${rt.node} ${serverJs} on 127.0.0.1:${rt.port}\n`);
      this.proc = spawn(rt.node, [serverJs], { cwd: rt.appDir, env, stdio: ['ignore', logFd, logFd], detached: process.platform !== 'win32', windowsHide: true });
      this.proc.on('error', (err) => { this.lastError = `cannot start ${rt.node}: ${err.message}`; });
      this.proc.unref();
    } catch (err) {
      this.failed(`cannot start ${rt.node}: ${err.message}`);
      return { running: false, error: this.lastError };
    } finally {
      if (logFd !== undefined) fs.closeSync(logFd);
    }
    try { writePrivate(rt.pidPath, `${this.proc.pid}\n`); } catch { /* best effort */ }
    if (await this.waitHealthy(rt, this.startupTimeoutMs)) {
      this.failures = 0;
      this.lastError = '';
      this.log(`websidian: started ${serverJs} (pid ${this.proc.pid}) on 127.0.0.1:${rt.port}`);
      return { running: true, pid: this.proc.pid, started: true };
    }
    const code = this.proc.exitCode;
    this.failed(code !== null ? `Websidian exited with code ${code}` : `Websidian did not answer ${rt.basePath}/_health within ${Math.round(this.startupTimeoutMs / 1000)}s`);
    if (code === null) await this.terminate(rt);
    return { running: false, error: this.lastError };
  }

  failed(message) {
    this.failures += 1;
    this.nextAllowed = Date.now() + Math.min(60_000, 1000 * 2 ** (this.failures - 1));
    this.lastError = message;
    this.log(`websidian: ${message}`);
  }

  async terminate(rt, timeoutMs = 5000) {
    const pid = this.pid(rt);
    if (!pid) return;
    try { process.kill(pid, 'SIGTERM'); } catch { return; }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && pidAlive(pid)) await sleep(100);
    if (pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    if (this.proc && this.proc.pid === pid) this.proc = null;
    try { fs.unlinkSync(rt.pidPath); } catch { /* gone */ }
  }

  async stop() { await this.terminate(this.runtime || this.resolve()); }

  // ensure() now, then every `intervalMs` (config changes, crashes). The timer never keeps the process alive.
  startBackground(intervalMs = 15_000) {
    if (this.timer) return;
    const tick = () => this.ensure().catch(err => { this.lastError = `supervisor error: ${err.message}`; });
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stopBackground() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async status() {
    const rt = this.resolve();
    const health = await this.health(rt);
    const serverJs = path.join(rt.appDir, 'src', 'server.js');
    const appVersion = readVersionStamp(path.join(rt.appDir, VERSION_FILE));
    const pluginVersion = readVersionStamp(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', VERSION_FILE));
    return {
      running: !!health,
      pid: this.pid(rt),
      port: rt.port,
      basePath: rt.basePath,
      publicBase: rt.publicBase,
      sites: rt.sites.map(s => ({ slug: s.slug, title: s.title, root: s.path, edit: s.edit, untrusted: s.untrusted, url: `${rt.basePath}/${s.slug}/` })),
      appDir: rt.appDir,
      appDirPresent: fs.existsSync(serverJs),
      appVersion,
      pluginVersion,
      versionSkew: versionSkew(appVersion, pluginVersion),
      node: rt.node,
      error: health ? '' : this.lastError,
      logTail: health ? [] : tailLines(rt.logPath, 20),
    };
  }
}
