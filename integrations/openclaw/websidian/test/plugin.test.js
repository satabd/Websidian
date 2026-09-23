// The plugin against a fake OpenClaw plugin API: what register() wires up and how the hooks behave together.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import entry from '../index.js';
import { registerWebsidian, hookResult, TOOL_NAME } from '../lib/plugin.js';

let tmp, vault, workspace;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-plugin-'));
  vault = path.join(tmp, 'brain');
  workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(vault, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(vault, 'Plan.md'), '# Plan');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fakeApi({ pluginConfig, config } = {}) {
  const api = {
    id: 'websidian',
    pluginConfig: pluginConfig || { vaults: [{ path: vault }] },
    config: config || { agents: { defaults: { workspace } }, gateway: { port: 18789 } },
    logger: { info() {}, warn(m) { api.warnings.push(m); }, debug() {} },
    hooks: {}, tools: [], commands: [], services: [], routes: [], descriptors: [], warnings: [],
    on(name, handler, opts) { api.hooks[name] = { handler, opts }; },
    registerTool(tool, opts) { api.tools.push({ tool, opts }); },
    registerCommand(def) { api.commands.push(def); },
    registerService(s) { api.services.push(s); },
    registerHttpRoute(r) { api.routes.push(r); },
    session: { controls: { registerControlUiDescriptor(d) { api.descriptors.push(d); } } },
  };
  return api;
}

const env = () => ({ OPENCLAW_STATE_DIR: path.join(tmp, 'state') });

describe('registration', () => {
  test('the entry matches the manifest and registers hooks, tool, command', () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
    assert.equal(entry.id, manifest.id);
    assert.deepEqual(entry.configSchema, manifest.configSchema);
    assert.deepEqual(manifest.contracts.tools, [TOOL_NAME]);
    assert.deepEqual(manifest.skills, ['skills']);
    assert.ok(fs.existsSync(new URL('../skills/websidian/SKILL.md', import.meta.url)));
    const api = fakeApi({ pluginConfig: { vaults: [{ path: vault }], ui: { enabled: false } } });
    entry.register(api);
    assert.deepEqual(Object.keys(api.hooks).sort(), ['after_tool_call', 'before_prompt_build', 'before_tool_call', 'message_sending']);
    assert.equal(api.tools.length, 1);
    assert.equal(api.tools[0].opts.name, TOOL_NAME);
    assert.equal(api.commands[0].name, 'brain');
    assert.equal(api.commands[0].acceptsArgs, true);
    assert.equal(api.services.length, 0, 'ui.enabled false: no service');
    assert.equal(api.routes.length, 0);
  });
  test('with the pages enabled, a service and a prefix route are registered', () => {
    const api = fakeApi({ pluginConfig: { vaults: [{ path: vault }] } });
    registerWebsidian(api, { env: env() });
    assert.equal(api.services[0].id, 'websidian-runtime');
    assert.deepEqual([api.routes[0].path, api.routes[0].match, api.routes[0].auth], ['/plugins/websidian', 'prefix', 'plugin']);
    assert.equal(typeof api.routes[0].handler, 'function');
  });

  test('the Memory surface: a Gateway-authenticated route and the Control UI tab that points at it', () => {
    const api = fakeApi({ pluginConfig: { vaults: [{ path: vault }] } });
    registerWebsidian(api, { env: env() });
    const memory = api.routes.find(r => r.path === '/plugins/websidian-memory');
    assert.ok(memory, 'the Memory route is registered');
    assert.deepEqual([memory.match, memory.auth], ['prefix', 'gateway'], 'the Gateway authenticates it, so there is no second sign-in');
    const tab = api.descriptors.find(d => d.id === 'memory');
    assert.ok(tab, 'the sidebar entry');
    assert.equal(tab.surface, 'tab');
    assert.equal(tab.label, 'Memory');
    assert.equal(tab.icon, 'brain');
    assert.equal(tab.path, '/plugins/websidian-memory');
    assert.equal(tab.group, 'control');
    assert.deepEqual(tab.requiredScopes, ['operator.read']);
  });

  test('ui.memory.enabled false leaves the rest of the plugin registered', () => {
    const api = fakeApi({ pluginConfig: { vaults: [{ path: vault }], ui: { memory: { enabled: false } } } });
    registerWebsidian(api, { env: env() });
    assert.equal(api.routes.length, 1, 'only the stand-alone route');
    assert.equal(api.routes[0].path, '/plugins/websidian');
    assert.equal(api.descriptors.length, 0);
    assert.equal(api.services[0].id, 'websidian-runtime', 'the supervised Websidian is untouched');
  });

  test('an OpenClaw with no Control UI descriptors still gets the Memory route', () => {
    const api = fakeApi({ pluginConfig: { vaults: [{ path: vault }] } });
    delete api.session;
    registerWebsidian(api, { env: env() });
    assert.ok(api.routes.some(r => r.path === '/plugins/websidian-memory'));
  });
  test('an API without api.on is tolerated', () => {
    const api = fakeApi();
    delete api.on;
    registerWebsidian(api, { env: env() });
    assert.match(api.warnings[0], /no api\.on/);
  });
});

describe('hook flow', () => {
  test('before_tool_call: block, approval, allow, and fail-closed mapping', async () => {
    const api = fakeApi();
    registerWebsidian(api, { env: env() });
    const before = api.hooks.before_tool_call.handler;
    const blocked = await before({ toolName: 'write', params: { path: path.join(vault, 'X.md'), content: '<script>x</script>' } }, { agentId: 'main' });
    assert.equal(blocked.block, true);
    assert.match(blocked.blockReason, /active HTML/);
    const approval = await before({ toolName: 'write', params: { path: 'SOUL.md', content: 'x' } }, { agentId: 'main' }); // relative to the workspace
    assert.equal(approval.requireApproval.severity, 'warning');
    assert.equal(approval.requireApproval.timeoutBehavior, 'deny');
    assert.ok(approval.requireApproval.title.length <= 80 && approval.requireApproval.description.length <= 256);
    assert.equal(await before({ toolName: 'write', params: { path: path.join(vault, 'X.md'), content: '# ok' } }, {}), undefined);
    assert.equal(await before({ toolName: 'read', params: { path: path.join(vault, 'SOUL.md') } }, {}), undefined);
    assert.deepEqual(hookResult(null), undefined);
    assert.equal(hookResult({ action: 'block', message: 'm' }).blockReason, 'm');
  });
  test('per-hook plugin config (event.context.pluginConfig) wins over the registration snapshot', async () => {
    const api = fakeApi({ pluginConfig: { vaults: [] } });
    registerWebsidian(api, { env: env() });
    const before = api.hooks.before_tool_call.handler;
    const event = { toolName: 'write', params: { path: path.join(vault, 'X.md'), content: '<script>x</script>' }, context: { pluginConfig: { vaults: [{ path: vault }] } } };
    assert.equal((await before(event, {})).block, true);
  });
  test('after_tool_call + message_sending append links once; the tool lists them', async () => {
    const api = fakeApi();
    registerWebsidian(api, { env: env() });
    const ctx = { sessionKey: 'agent:main:main' };
    await api.hooks.after_tool_call.handler({ toolName: 'write', params: { path: path.join(vault, 'Plan.md'), content: '# Plan' }, result: { content: [] } }, ctx);
    await api.hooks.after_tool_call.handler({ toolName: 'write', params: { path: path.join(vault, 'Bad.md'), content: 'x' }, error: 'refused' }, ctx);
    await api.hooks.after_tool_call.handler({ toolName: 'write', params: { path: path.join(tmp, 'outside.md'), content: 'x' } }, ctx);
    const sent = await api.hooks.message_sending.handler({ content: 'Done.' }, ctx);
    assert.equal(sent.content, 'Done.\n\nNotes updated:\n- Plan: http://127.0.0.1:18789/plugins/websidian/w/brain/Plan');
    assert.equal(await api.hooks.message_sending.handler({ content: 'Again.' }, ctx), undefined, 'pending drained');
    // a reply that already carries the link is left alone
    await api.hooks.after_tool_call.handler({ toolName: 'edit', params: { path: path.join(vault, 'Plan.md'), edits: [] } }, ctx);
    assert.equal(await api.hooks.message_sending.handler({ content: 'See http://127.0.0.1:18789/plugins/websidian/w/brain/Plan' }, ctx), undefined);
    // media-only payloads keep the links for the next text
    await api.hooks.after_tool_call.handler({ toolName: 'edit', params: { path: path.join(vault, 'Plan.md'), edits: [] } }, ctx);
    assert.equal(await api.hooks.message_sending.handler({ content: undefined }, ctx), undefined);
    assert.match((await api.hooks.message_sending.handler({ content: 'text' }, ctx)).content, /Notes updated/);
    // the tool
    const tool = api.tools[0].tool({ sessionKey: 'agent:main:main', agentId: 'main' });
    const all = await tool.execute('id', {});
    assert.deepEqual(all.details.notes.map(n => n.rel), ['Plan.md']);
    assert.equal(all.details.vaults[0].slug, 'brain');
    const some = await tool.execute('id', { paths: [path.join(vault, 'Plan.md'), path.join(tmp, 'nope.md')] });
    assert.deepEqual(some.details.not_in_vault, [path.join(tmp, 'nope.md')]);
    assert.equal(some.content[0].type, 'text');
  });
  test('appendLinks: false keeps replies untouched', async () => {
    const api = fakeApi({ pluginConfig: { vaults: [{ path: vault }], appendLinks: false, ui: { enabled: false } } });
    registerWebsidian(api, { env: env() });
    const ctx = { sessionKey: 's' };
    await api.hooks.after_tool_call.handler({ toolName: 'write', params: { path: path.join(vault, 'Plan.md'), content: '' } }, ctx);
    assert.equal(await api.hooks.message_sending.handler({ content: 'Done.' }, ctx), undefined);
  });
  test('system prompt section and /brain', async () => {
    const api = fakeApi();
    registerWebsidian(api, { env: env() });
    const prompt = await api.hooks.before_prompt_build.handler({});
    assert.match(prompt.appendSystemContext, /Websidian vaults/);
    assert.match(prompt.appendSystemContext, new RegExp(TOOL_NAME));
    const text = (await api.commands[0].handler({ args: '' })).text;
    assert.match(text, /Recently modified notes:\n- Plan: http:\/\/127\.0\.0\.1:18789\/plugins\/websidian\/w\/brain\/Plan/);
    assert.match((await api.commands[0].handler({ args: 'zzz' })).text, /No notes matching/);
  });
  test('vaults not set: the default agent workspace is the vault', async () => {
    const api = fakeApi({ pluginConfig: { ui: { enabled: false } } });
    registerWebsidian(api, { env: env() });
    assert.doesNotMatch((await api.commands[0].handler({ args: '' })).text, /no vaults configured/);
    const prompt = await api.hooks.before_prompt_build.handler({});
    assert.match(JSON.stringify(prompt || {}), /Websidian vaults/, 'the prompt section is there');
  });

  test('no vaults configured (an explicit empty list)', async () => {
    const api = fakeApi({ pluginConfig: { vaults: [], ui: { enabled: false } } });
    registerWebsidian(api, { env: env() });
    assert.match((await api.commands[0].handler({ args: '' })).text, /no vaults configured/);
    assert.equal(await api.hooks.before_prompt_build.handler({}), undefined);
    const tool = api.tools[0].tool({});
    assert.match((await tool.execute('id', {})).details.error, /no vaults/);
    // protection still applies to the workspace even without vaults
    const d = await api.hooks.before_tool_call.handler({ toolName: 'write', params: { path: path.join(workspace, 'AGENTS.md'), content: 'x' } }, {});
    assert.ok(d.requireApproval);
  });
});
