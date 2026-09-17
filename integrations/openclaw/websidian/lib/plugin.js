// What register(api) wires up (index.js calls registerWebsidian; every call is feature-probed, so an older
// OpenClaw degrades gracefully):
//
// - before_tool_call: guard.js - agent instruction files need human approval (write, edit, apply_patch, exec);
//   vault writes must be plain Markdown (no scripts, frames, event handlers, javascript: URLs, .html/.svg/.js files).
// - after_tool_call: remember notes written inside a vault, per session.
// - message_sending: append "Notes updated:" with view and edit links to the outgoing reply.
// - before_prompt_build: a short system-prompt section pointing the agent at the vaults and the skill.
// - tool websidian_links: links for given paths, or for the notes changed this session.
// - command /brain [query]: the 10 most recently modified notes, with links.
// - service websidian-runtime + HTTP route /plugins/websidian: the vaults served behind the Gateway (ui.enabled).
//
// Settings live under plugins.entries.websidian.config in openclaw.json (api.pluginConfig, and per hook
// event.context.pluginConfig).
import { ChangeTracker } from './tracker.js';
import { evaluate, GUARDED_TOOLS, settingsFromConfig, TRACKED_TOOLS, writtenPaths } from './guard.js';
import { formatLinksBlock, linksForPath, recentNotes } from './links.js';
import { ROUTE_PREFIX, workspaceFor } from './sites.js';
import { Supervisor } from './supervisor.js';
import { createRouteHandler } from './proxy.js';

export const PLUGIN_ID = 'websidian';
export const TOOL_NAME = 'websidian_links';
export const SERVICE_ID = 'websidian-runtime';
const APPROVAL_TITLE = 'Websidian: approve this write';
const HOOK_PRIORITY = 50;

function logger(api) {
  const l = api.logger || {};
  return {
    info: (m) => (l.info ? l.info(m) : undefined),
    warn: (m) => (l.warn ? l.warn(m) : undefined),
    debug: (m) => (l.debug ? l.debug(m) : undefined),
  };
}

export function systemPrompt(settings) {
  if (!settings.vaults.length) return '';
  const lines = ['Websidian vaults (Obsidian notes published as a website):'];
  for (const v of settings.vaults.slice(0, 10)) lines.push(`- ${v.path}` + (v.url ? ` -> ${v.url}` : ''));
  lines.push(`Before writing notes there, load the "websidian" skill. Notes are plain Obsidian Markdown (no raw HTML); agent instruction files need human approval. After writing notes, share their view links (the ${TOOL_NAME} tool returns them).`);
  return lines.join('\n').slice(0, 3900);
}

// The before_tool_call result for a guard directive.
export function hookResult(directive) {
  if (!directive) return undefined;
  if (directive.action === 'block') return { block: true, blockReason: directive.message };
  return {
    requireApproval: {
      title: APPROVAL_TITLE,
      description: String(directive.message).slice(0, 256),
      severity: 'warning',
      timeoutMs: 120_000,
      timeoutBehavior: 'deny',
      allowedDecisions: ['allow-once', 'deny'],
    },
  };
}

function resultFailed(event) {
  if (event.error) return true;
  const r = event.result;
  return !!(r && typeof r === 'object' && (r.isError === true || r.error));
}

export function registerWebsidian(api, { env = process.env } = {}) {
  const log = logger(api);
  const tracker = new ChangeTracker();
  const config = () => {
    try { const cur = api.runtime && api.runtime.config && api.runtime.config.current ? api.runtime.config.current() : null; if (cur) return cur; } catch { /* fall back */ }
    return api.config || {};
  };
  const settingsFor = (pluginConfig) => settingsFromConfig(pluginConfig || api.pluginConfig || {}, config(), env);
  const sessionOf = (ctx, event) => String((ctx && ctx.sessionKey) || (event && event.context && event.context.sessionKey) || (ctx && ctx.sessionId) || 'default');
  const pluginConfigOf = (event) => (event && event.context && event.context.pluginConfig) || undefined;

  if (typeof api.on !== 'function') { log.warn('websidian: this OpenClaw has no api.on(); hooks are unavailable'); return; }

  api.on('before_tool_call', async (event, ctx) => {
    if (!event || !GUARDED_TOOLS.includes(event.toolName)) return undefined;
    try {
      const settings = settingsFor(pluginConfigOf(event));
      if (!settings.vaults.length && !settings.protect.length) return undefined;
      const base = workspaceFor(config(), ctx && ctx.agentId, env);
      return hookResult(evaluate(event.toolName, event.params, settings, { base }));
    } catch (err) { // fail closed for the tools we guard
      log.warn(`websidian: before_tool_call failed for ${event.toolName}: ${err && err.stack ? err.stack : err}`);
      return { block: true, blockReason: `websidian: the write guard failed (${err && err.name ? err.name : 'Error'}); refusing ${event.toolName} to be safe.` };
    }
  }, { priority: HOOK_PRIORITY });

  api.on('after_tool_call', async (event, ctx) => {
    if (!event || !TRACKED_TOOLS.includes(event.toolName) || resultFailed(event)) return;
    try {
      const settings = settingsFor(pluginConfigOf(event));
      if (!settings.vaults.length) return;
      const base = workspaceFor(config(), ctx && ctx.agentId, env);
      const sid = sessionOf(ctx, event);
      for (const p of writtenPaths(event.toolName, event.params)) {
        const entry = linksForPath(p, settings.vaults, base);
        if (entry) tracker.record(sid, entry);
      }
    } catch (err) { log.debug(`websidian: after_tool_call failed: ${err}`); }
  }, { priority: HOOK_PRIORITY });

  api.on('message_sending', async (event, ctx) => {
    try {
      const sid = sessionOf(ctx, event);
      if (!tracker.hasPending(sid) || typeof event.content !== 'string' || !event.content.trim()) return undefined;
      const settings = settingsFor(pluginConfigOf(event));
      const pending = tracker.takePending(sid);
      if (!settings.appendLinks) return undefined;
      const missing = pending.filter(e => !e.view || !event.content.includes(e.view));
      if (!missing.length) return undefined; // the agent already shared every link
      return { content: event.content.trimEnd() + '\n\n' + formatLinksBlock(missing) };
    } catch (err) { log.debug(`websidian: message_sending failed: ${err}`); return undefined; }
  }, { priority: HOOK_PRIORITY });

  api.on('before_prompt_build', async (event) => {
    try {
      const text = systemPrompt(settingsFor(pluginConfigOf(event)));
      return text ? { appendSystemContext: text } : undefined;
    } catch { return undefined; }
  }, { priority: HOOK_PRIORITY });

  if (typeof api.registerTool === 'function') {
    api.registerTool((toolCtx) => ({
      name: TOOL_NAME,
      label: 'Websidian links',
      description: 'Get Websidian web links (view URL and editor URL) for notes in the configured Obsidian vault(s). Pass file paths, or omit them to get every note written in this session. Include the view links in your reply after creating or updating notes.',
      parameters: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: 'Note file paths (absolute, ~ or relative to the workspace). Omit for notes changed this session.' },
        },
        required: [],
      },
      async execute(_toolCallId, params) {
        const result = linksTool(params, toolCtx);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }], details: result };
      },
    }), { name: TOOL_NAME });
  }

  function linksTool(params, toolCtx) {
    const settings = settingsFor();
    if (!settings.vaults.length) return { error: 'websidian: no vaults configured (plugins.entries.websidian.config.vaults)' };
    const paths = params && Array.isArray(params.paths) ? params.paths : params && typeof params.paths === 'string' ? [params.paths] : [];
    const base = workspaceFor(config(), toolCtx && toolCtx.agentId, env);
    if (paths.length) {
      const notes = [];
      const outside = [];
      for (const p of paths) { const entry = linksForPath(String(p), settings.vaults, base); if (entry) notes.push(entry); else outside.push(String(p)); }
      return { notes, not_in_vault: outside };
    }
    const sid = String((toolCtx && toolCtx.sessionKey) || (toolCtx && toolCtx.sessionId) || 'default');
    return { notes: tracker.all(sid), vaults: settings.vaults.map(v => ({ path: v.path, url: v.url, slug: v.slug })) };
  }

  if (typeof api.registerCommand === 'function') {
    api.registerCommand({
      name: 'brain',
      description: 'List recently modified Websidian notes with links (/brain <query> to filter)',
      acceptsArgs: true,
      handler: async (ctx) => ({ text: brainCommand(ctx && ctx.args) }),
    });
  }

  function brainCommand(rawArgs) {
    const settings = settingsFor();
    if (!settings.vaults.length) return 'websidian: no vaults configured. Set plugins.entries.websidian.config.vaults in openclaw.json.';
    const query = String(rawArgs || '').trim();
    const notes = recentNotes(settings.vaults, { query, limit: 10 });
    if (!notes.length) return query ? `No notes matching '${query}'.` : 'No notes found in the configured vaults.';
    const lines = [query ? `Notes matching '${query}' (most recent first):` : 'Recently modified notes:'];
    for (const n of notes) { const name = n.rel.slice(0, -3); lines.push(n.view ? `- ${name}: ${n.view}` : `- ${name} (${n.path})`); }
    if (settings.ui.enabled) lines.push(`Pages: ${settings.ui.publicBase}${ROUTE_PREFIX}/`);
    return lines.join('\n');
  }

  // The vaults served behind the Gateway.
  const ui = settingsFor().ui;
  if (ui.enabled && typeof api.registerService === 'function' && typeof api.registerHttpRoute === 'function') {
    const supervisor = new Supervisor(() => settingsFor(), { log: log.info });
    api.registerService({
      id: SERVICE_ID,
      start: async () => { supervisor.startBackground(15_000); },
      stop: async () => { supervisor.stopBackground(); await supervisor.stop(); },
    });
    api.registerHttpRoute({
      path: ROUTE_PREFIX,
      match: 'prefix',
      auth: 'plugin',
      handler: createRouteHandler({ supervisor, getSettings: () => settingsFor(), getConfig: config, log: log.warn, env }),
    });
    if (!api.registrationMode || api.registrationMode === 'full') log.info(`websidian: pages at ${ui.publicBase}${ROUTE_PREFIX}/ (Websidian on 127.0.0.1:${ui.port}, runtime ${ui.appDir})`);
  } else if (!ui.enabled) {
    log.info('websidian: ui.enabled is false; guard and links only');
  }

  return { tracker, settingsFor };
}
