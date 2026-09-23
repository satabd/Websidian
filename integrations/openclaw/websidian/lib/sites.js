// Vault -> Websidian site mapping and plugin settings. Pure, standard library only.
//
// The agent hooks, the /brain command, the websidian_links tool and the pages served behind the Gateway
// all derive site slugs from the same `vaults` setting through normalizeVaults(), so the links the agent
// shares point at the sites the plugin serves.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Websidian is mounted at this path on the Gateway: /plugins/websidian/w/<slug>/...
export const ROUTE_PREFIX = '/plugins/websidian';
export const WEBSIDIAN_MOUNT = ROUTE_PREFIX + '/w';
// The native Memory surface in OpenClaw's Control UI: a second HTTP route, authenticated by the Gateway
// itself (auth: "gateway"), so the operator signs in once — to OpenClaw — and never again here.
//
// A sibling of the stand-alone prefix, not a child of it: OpenClaw refuses two plugin routes whose
// prefixes overlap ("http route overlap rejected", seen on 2026.9.5), and the stand-alone pages must keep
// their own path and their own sign-in. The session cookie the Memory route mints is still scoped to
// ROUTE_PREFIX, so it reaches the proxy and never travels to this route.
export const MEMORY_PREFIX = ROUTE_PREFIX + '-memory';
export const MEMORY_PAGE_ID = 'memory';
export const DEFAULT_PORT = 8095;
export const DEFAULT_GATEWAY_PORT = 18789;
export const DEFAULT_SESSION_HOURS = 12;

export const DEFAULT_PROTECT = Object.freeze([
  'SKILL.md', 'SOUL.md', 'AGENTS.md', 'MEMORY.md', 'USER.md', 'TOOLS.md', 'IDENTITY.md', 'HEARTBEAT.md', 'BOOTSTRAP.md',
]);

export function asBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return fallback;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

// Lowercase [a-z0-9_-]; never starts with "_" (Websidian's own routes: /_health, /_static).
export function slugify(value) {
  let s = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  s = s.replace(/-{2,}/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  return s.slice(0, 64).replace(/^[-_]+|[-_]+$/g, '');
}

function urlSlug(url) {
  let pathname;
  try { pathname = new URL(String(url)).pathname; } catch { return ''; }
  const segs = pathname.split('/').filter(Boolean);
  return segs.length ? slugify(segs[segs.length - 1]) : '';
}

function folderSlug(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return s ? slugify(s.split('/').pop()) : '';
}

// [{path, url, slug, title, edit, untrusted}] with unique slugs, in the configured order.
// slug: explicit -> last path segment of url -> folder name -> "vault"; duplicates get -2, -3...
// untrusted defaults to true and edit to false: a vault an agent writes to is also a vault every browser
// user could rewrite, so browser editing is opt-in per vault.
export function normalizeVaults(vaults) {
  const out = [];
  const used = new Set();
  for (const v of Array.isArray(vaults) ? vaults : []) {
    if (!v || typeof v !== 'object') continue;
    const p = String(v.path || '').trim();
    if (!p) continue;
    let url = String(v.url || '').trim();
    if (url && !url.endsWith('/')) url += '/';
    const base = slugify(v.slug || '') || urlSlug(url) || folderSlug(p) || 'vault';
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    const title = String(v.title || '').trim() || path.basename(p.replace(/\\/g, '/').replace(/\/+$/, '')) || slug;
    out.push({ path: p, url, slug, title, edit: asBool(v.edit, false), untrusted: asBool(v.untrusted, true) });
  }
  return out;
}

// URL path prefix of the Gateway as browsers see it ("https://x.example/openclaw" -> "/openclaw"), no trailing slash.
export function publicPrefix(publicBase) {
  let pathname;
  try { pathname = new URL(String(publicBase || '')).pathname; } catch { return ''; }
  const p = '/' + pathname.split('/').filter(Boolean).join('/');
  return p === '/' ? '' : p;
}

export function websidianBasePath(publicBase) {
  return publicPrefix(publicBase) + WEBSIDIAN_MOUNT;
}

// Site base behind the Gateway: <publicBase>/plugins/websidian/w/<slug>/
export function siteUrl(publicBase, slug) {
  return String(publicBase).replace(/\/+$/, '') + WEBSIDIAN_MOUNT + '/' + slug + '/';
}

export function expandHome(p, env = process.env) {
  const s = String(p || '');
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) {
    const home = env.HOME || env.USERPROFILE || os.homedir();
    return path.join(home, s.slice(1));
  }
  return s;
}

// OpenClaw's state directory: $OPENCLAW_STATE_DIR, else ~/.openclaw (mirrors OpenClaw's own default).
export function resolveStateDir(env = process.env) {
  const configured = String(env.OPENCLAW_STATE_DIR || '').trim();
  if (configured) return path.resolve(expandHome(configured, env));
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, '.openclaw');
}

// The agent workspaces the Gateway config names: agents.defaults.workspace and every agents.list[].workspace,
// plus OpenClaw's default (<state dir>/workspace, or workspace-<profile>) when nothing is configured.
export function workspaceDirs(cfg, env = process.env) {
  const out = new Set();
  const agents = (cfg && cfg.agents) || {};
  const add = (p) => { if (typeof p === 'string' && p.trim()) out.add(path.resolve(expandHome(p.trim(), env))); };
  add(agents.defaults && agents.defaults.workspace);
  for (const a of Array.isArray(agents.list) ? agents.list : []) add(a && a.workspace);
  if (!(agents.defaults && agents.defaults.workspace)) {
    const profile = String(env.OPENCLAW_PROFILE || '').trim();
    out.add(path.join(resolveStateDir(env), profile && profile !== 'default' ? `workspace-${profile}` : 'workspace'));
  }
  return [...out];
}

// The workspace file tools resolve relative paths against for `agentId` (mirrors resolveAgentWorkspaceDir).
export function workspaceFor(cfg, agentId, env = process.env) {
  const agents = (cfg && cfg.agents) || {};
  const list = Array.isArray(agents.list) ? agents.list : [];
  const id = String(agentId || '').trim().toLowerCase();
  const own = list.find(a => a && String(a.id || '').toLowerCase() === id && typeof a.workspace === 'string' && a.workspace.trim());
  if (own) return path.resolve(expandHome(own.workspace.trim(), env));
  if (agents.defaults && typeof agents.defaults.workspace === 'string' && agents.defaults.workspace.trim()) {
    return path.resolve(expandHome(agents.defaults.workspace.trim(), env));
  }
  return workspaceDirs(cfg, env)[0];
}

// The Websidian runtime a packed plugin carries inside itself (deploy/pack.mjs), so `openclaw plugins install`
// alone is a complete install: on first start the supervisor copies it to <dataDir>/app and installs its locked
// dependencies there (supervisor.provision). It never runs in place: OpenClaw overrides some dependency
// versions for every plugin (path-to-regexp 8, which Express 4 cannot use) and loads plugins from a rebuilt
// copy. A plugin copied from a checkout by the installers has no runtime/; the installers fill <dataDir>/app.
export const BUNDLED_RUNTIME = path.resolve(fileURLToPath(new URL('../runtime/', import.meta.url)));
export function bundledRuntime(dir = BUNDLED_RUNTIME) {
  return fs.existsSync(path.join(dir, 'src', 'server.js')) ? dir : '';
}

// The vaults used when `vaults` is not set at all: the default agent's workspace, once it exists, so a fresh
// install shows the agent's memory without any config. An explicit `vaults: []` means none.
export function defaultVaults(cfg = {}, env = process.env) {
  const ws = workspaceFor(cfg, '', env);
  return ws && fs.existsSync(ws) ? [{ path: ws, slug: 'workspace', title: 'Agent workspace' }] : [];
}

// Normalized `ui` setting: {enabled, port, appDir, bundleDir, dataDir, node, publicBase, auth, password, sessionHours}.
export function uiSettings(raw, cfg = {}, env = process.env) {
  const d = raw && typeof raw === 'object' ? raw : {};
  let port = parseInt(d.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) port = DEFAULT_PORT;
  const gatewayPort = parseInt(cfg && cfg.gateway && cfg.gateway.port, 10);
  const publicBase = String(d.publicBase || '').trim().replace(/\/+$/, '')
    || `http://127.0.0.1:${Number.isInteger(gatewayPort) && gatewayPort > 0 ? gatewayPort : DEFAULT_GATEWAY_PORT}`;
  const stateDir = resolveStateDir(env);
  const dataDir = String(d.dataDir || '').trim() ? path.resolve(expandHome(String(d.dataDir).trim(), env)) : path.join(stateDir, 'plugin-data', 'websidian');
  const appDirSet = !!String(d.appDir || '').trim();
  const appDir = appDirSet ? path.resolve(expandHome(String(d.appDir).trim(), env)) : path.join(dataDir, 'app');
  const auth = String(d.auth || '').trim().toLowerCase() === 'password' ? 'password' : 'gateway';
  const mem = d.memory && typeof d.memory === 'object' ? d.memory : {};
  let sessionHours = Number(d.sessionHours);
  if (!Number.isFinite(sessionHours) || sessionHours <= 0) sessionHours = DEFAULT_SESSION_HOURS;
  return {
    enabled: asBool(d.enabled, true),
    port,
    appDir,
    // Where provision() installs the runtime from: the bundled copy, unless ui.appDir names a runtime of its own.
    bundleDir: appDirSet ? '' : bundledRuntime(),
    dataDir,
    node: String(d.node || '').trim() || process.execPath,
    publicBase,
    auth,
    password: typeof d.password === 'string' ? d.password : '',
    sessionHours,
    // The Memory page: which vault it reads, and how it is labelled in the Control UI sidebar.
    memory: {
      enabled: asBool(mem.enabled, true),
      vault: String(mem.vault || '').trim(),
      label: String(mem.label || '').trim() || 'Memory',
      icon: String(mem.icon || '').trim() || 'brain',
      order: Number.isFinite(Number(mem.order)) ? Number(mem.order) : 20,
    },
  };
}

// Add `url` (the site base links point at) to each vault: an explicit external url wins; otherwise the site
// the plugin serves itself (when the pages are enabled); otherwise "" (no links).
// A plugin-served site with `edit: false` gets no edit link (Websidian would refuse the editor); an external
// url is somebody else's Websidian, whose config decides, so it keeps both.
export function resolveLinks(vaults, ui) {
  return vaults.map(v => {
    const out = { ...v };
    if (v.url) {
      out.external = true;
    } else if (ui && ui.enabled) {
      out.url = siteUrl(ui.publicBase, v.slug);
      out.external = false;
    } else {
      out.url = '';
      out.external = false;
    }
    return out;
  });
}
