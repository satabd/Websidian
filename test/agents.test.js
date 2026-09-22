'use strict';
// Agents in the editor. No real agent runs: each backend's argv and parser are checked against
// what the real CLIs print (recorded 2026-09-23 from Claude Code 2.1.222, codex-cli 0.144.4 and
// Hermes Agent 0.20.5), and the HTTP flow runs against test/fake-agent.js, which speaks Claude
// Code's JSON and can write into the vault.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { makeVault, FIXTURE } = require('./helpers');
const A = require('../src/agents');

const withProbe = (result, fn) => { const real = A._spawnSync; A._spawnSync = () => result; try { return fn(); } finally { A._spawnSync = real; } };
const PROBE_OK = { status: 0, stdout: '1.0\n' };
const T = over => ({ mode: 'review', protect: ['SOUL.md', 'AGENTS.md'], skillDirs: ['/skills/obsidian-skills'], pluginDirs: ['/skills/obsidian-skills'], cwd: '/vault', sessionId: null, newId: 'new-id', ...over });
const agentOf = (cfg) => withProbe(PROBE_OK, () => A.resolveAgents({ agents: { skills: false, list: [cfg] } }).agents.values().next().value);

// ---- argv: what each CLI is asked to do ------------------------------------

test('claude-cli review: read tools only, nothing asked, a new session id, the skills as a plugin', () => {
  const a = agentOf({ backend: 'claude-cli', model: 'claude-opus-5', effort: 'medium' });
  const argv = A.claudeArgv(a, T());
  assert.deepEqual(argv.slice(a.command.length, a.command.length + 3), ['-p', '--output-format', 'json']);
  assert.match(a.command.join(' '), /claude/);
  assert.equal(argv[argv.indexOf('--session-id') + 1], 'new-id');
  assert.equal(argv.indexOf('--resume'), -1);
  assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Glob,Grep,Skill', 'no Edit or Write in review');
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk', 'anything not allowed is refused, not asked');
  assert.ok(argv.includes('Read(./**)'));
  const allow = argv.slice(argv.indexOf('--allowedTools') + 1, argv.indexOf('--disallowedTools'));
  assert.ok(!allow.includes('Grep') && !allow.includes('Glob'), 'Grep and Glob are scoped by the Read rule, never allowed disk-wide');
  assert.ok(!argv.some(x => /^(Edit|Write)\(\.\/\*\*\)$/.test(x)));
  assert.equal(argv[argv.indexOf('--plugin-dir') + 1], '/skills/obsidian-skills');
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-opus-5');
  assert.equal(argv[argv.indexOf('--effort') + 1], 'medium');
});

test('claude-cli edit: write tools inside the vault, instruction files and .git denied; a later turn resumes', () => {
  const a = agentOf({ backend: 'claude-cli', modes: ['review', 'edit'] });
  const argv = A.claudeArgv(a, T({ mode: 'edit', sessionId: 'abc' }));
  assert.equal(argv[argv.indexOf('--resume') + 1], 'abc');
  assert.equal(argv.indexOf('--session-id'), -1);
  assert.match(argv[argv.indexOf('--tools') + 1], /Edit,Write/);
  assert.ok(argv.includes('Edit(./**)') && argv.includes('Write(./**)'));
  const deny = argv.slice(argv.indexOf('--disallowedTools') + 1);
  assert.ok(deny.includes('Edit(./**/SOUL.md)') && deny.includes('Write(./AGENTS.md)'));
  assert.ok(deny.includes('Edit(./.git/**)') && deny.includes('Write(./.obsidian/**)'));
});

test('a Windows skills path becomes a Claude Code absolute rule', () => {
  assert.equal(A.claudePathRule('D:\\x\\agent-skills\\obsidian-skills'), '//d/x/agent-skills/obsidian-skills');
  assert.equal(A.claudePathRule('/opt/skills'), '//opt/skills');
});

test('codex-cli: read-only sandbox for review, workspace-write for edit, resume by thread id, prompt from stdin', () => {
  const a = agentOf({ backend: 'codex-cli', model: 'gpt-5.5', modes: ['review', 'edit'] });
  const first = A.codexArgv(a, T());
  assert.equal(first[a.command.length], 'exec');
  assert.ok(first.includes('sandbox_mode="read-only"'));
  assert.equal(first[first.indexOf('-C') + 1], '/vault');
  assert.equal(first[first.length - 1], '-', 'the message is read from stdin');
  const later = A.codexArgv(a, T({ mode: 'edit', sessionId: '01a0-thread' }));
  assert.deepEqual(later.slice(a.command.length, a.command.length + 3), ['exec', 'resume', '01a0-thread']);
  assert.ok(later.includes('sandbox_mode="workspace-write"'));
  assert.equal(later.indexOf('-C'), -1, '`exec resume` has no -C; the working directory is the spawn cwd');
  assert.ok(!first.some(x => /windows\.sandbox/.test(x)), 'Codex keeps its own Windows sandbox unless told');
  const win = agentOf({ backend: 'codex-cli', windowsSandbox: 'unelevated' });
  assert.ok(A.codexArgv(win, T()).includes('windows.sandbox="unelevated"'));
});

test('hermes-cli: one query from stdin, in the vault, resumed by id, rules off unless asked', () => {
  const a = agentOf({ backend: 'hermes-cli', toolsets: 'file', preloadSkills: ['obsidian'] });
  const argv = A.hermesArgv(a, T({ sessionId: '20260923_011601_e4d8a0' }));
  assert.deepEqual(argv.slice(a.command.length, a.command.length + 4), ['chat', '--query-file', '-', '-Q']);
  assert.equal(argv[argv.indexOf('--in') + 1], '/vault');
  assert.equal(argv[argv.indexOf('--resume') + 1], '20260923_011601_e4d8a0');
  assert.ok(argv.includes('--ignore-rules'));
  assert.equal(argv[argv.indexOf('-t') + 1], 'file');
  assert.equal(argv[argv.indexOf('-s') + 1], 'obsidian');
  const b = agentOf({ backend: 'hermes-cli', ignoreRules: false });
  assert.ok(!A.hermesArgv(b, T()).includes('--ignore-rules'));
});

test('openclaw-cli: a command in a container, our own session id kept from the first turn', () => {
  const a = agentOf({ backend: 'openclaw-cli', command: ['docker', 'exec', '-i', 'claw', 'openclaw'], agent: 'main', effort: 'low', timeoutMs: 90_000 });
  const argv = A.openclawArgv(a, T({ newId: 'websidian-1' }));
  assert.deepEqual(argv.slice(0, 6), ['docker', 'exec', '-i', 'claw', 'openclaw', 'agent']);
  assert.equal(argv[argv.indexOf('--session-id') + 1], 'websidian-1');
  assert.equal(argv[argv.indexOf('--message-file') + 1], '-');
  assert.equal(argv[argv.indexOf('--agent') + 1], 'main');
  assert.equal(argv[argv.indexOf('--thinking') + 1], 'low');
  assert.equal(argv[argv.indexOf('--timeout') + 1], '90');
  assert.equal(A.openclawArgv(a, T({ sessionId: 'websidian-1', newId: 'other' }))[argv.indexOf('--session-id') + 1], 'websidian-1');
});

// ---- parsing what they print -----------------------------------------------

test('parsers read the reply and the session id each CLI prints', () => {
  const claude = A.parseClaude({ code: 0, out: JSON.stringify({ is_error: false, result: 'Hi', session_id: 'd5a1', usage: { input_tokens: 1, cache_read_input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.05 }) });
  assert.deepEqual([claude.text, claude.sessionId, claude.usage.input, claude.usage.costUsd], ['Hi', 'd5a1', 11, 0.05]);
  assert.match(A.parseClaude({ code: 1, out: JSON.stringify({ is_error: true, result: 'Not logged in' }) }).error, /Not logged in/);

  const codexOut = [
    '{"type":"thread.started","thread_id":"01a0cb30"}', '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I will check Test.md."}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"cat Test.md"}}',
    '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"The word is PAPAYA."}}',
    '{"type":"turn.completed","usage":{"input_tokens":79757,"output_tokens":410}}',
  ].join('\n');
  const codex = A.parseCodex({ code: 0, out: codexOut });
  assert.deepEqual([codex.text, codex.sessionId, codex.usage.output], ['The word is PAPAYA.', '01a0cb30', 410]);
  assert.deepEqual(codex.notes, ['I will check Test.md.']);
  assert.match(A.parseCodex({ code: 1, out: '{"type":"thread.started","thread_id":"x"}\n{"type":"turn.failed","error":{"message":"model requires a newer version"}}' }).error, /newer version/);

  const hermes = A.parseHermes({ code: 0, out: 'The number was 417.\n', err: '↻ Resumed session 20260923_011601_e4d8a0\n\nsession_id: 20260923_011601_e4d8a0\n' });
  assert.deepEqual([hermes.text, hermes.sessionId], ['The number was 417.', '20260923_011601_e4d8a0']);

  const oc = A.parseOpenclaw({ code: 0, out: 'gateway: connected\n{"payloads":[{"text":"One"},{"text":"Two"}],"meta":{"durationMs":1200}}' }, { newId: 'w-1' });
  assert.deepEqual([oc.text, oc.sessionId], ['One\n\nTwo', 'w-1']);
});

// ---- configuration ---------------------------------------------------------

test('resolveAgents: every agent is configured on its own; bad or missing ones are left out with a warning', () => {
  const warnings = [];
  const agents = withProbe(PROBE_OK, () => A.resolveAgents({ agents: { skills: false, list: [
    { id: 'claude', backend: 'claude-cli', label: 'Claude (docs)', model: 'claude-opus-5', modes: ['review', 'edit'], sites: ['docs'], users: ['sat'] },
    { backend: 'codex-cli', model: 'gpt-5.5', modes: ['nonsense'] },
    { id: 'x', backend: 'gpt-cli' },
    { id: 'claude', backend: 'hermes-cli' },
    { id: 'off', backend: 'hermes-cli', enabled: false },
  ] } }, w => warnings.push(w)));
  assert.deepEqual([...agents.agents.keys()], ['claude', 'codex']);
  assert.deepEqual(agents.agents.get('codex').modes, ['review'], 'unknown modes fall back to review');
  assert.equal(agents.agents.get('claude').label, 'Claude (docs)');
  assert.ok(warnings.some(w => /gpt-cli/.test(w)) && warnings.some(w => /used twice/.test(w)));
  const menu = A.menu(agents, { slug: 'docs' }, 'sat');
  assert.deepEqual(menu.agents.map(a => a.id), ['claude', 'codex']);
  assert.deepEqual(A.menu(agents, { slug: 'other' }, 'sat').agents.map(a => a.id), ['codex'], '`sites` limits an agent');
  assert.deepEqual(A.menu(agents, { slug: 'docs' }, 'guest').agents.map(a => a.id), ['codex'], '`users` limits an agent');

  const none = withProbe({ status: 1 }, () => A.resolveAgents({ agents: { skills: false, list: [{ backend: 'claude-cli' }] } }, () => {}));
  assert.equal(none, null, 'a CLI that is not installed means no panel, not a broken one');
  assert.equal(A.resolveAgents({}), null);
});

test('skills: the kepano layout is read, and a plugin folder is also handed to Claude Code', () => {
  const v = makeVault({
    'obsidian-skills/.claude-plugin/plugin.json': '{"name":"obsidian"}',
    'obsidian-skills/skills/obsidian-markdown/SKILL.md': '---\nname: obsidian-markdown\ndescription: Create and edit Obsidian Flavored Markdown.\n---\n# x',
    'obsidian-skills/skills/json-canvas/SKILL.md': '---\nname: json-canvas\ndescription: "Canvas files"\n---\n',
    'mine/house-style/SKILL.md': '---\nname: house-style\ndescription: Our style\n---\n',
  });
  try {
    const s = A.loadSkills([path.join(v.root, 'obsidian-skills'), path.join(v.root, 'mine')], () => {});
    assert.deepEqual(s.skills.map(x => x.name).sort(), ['house-style', 'json-canvas', 'obsidian-markdown']);
    assert.deepEqual(s.pluginDirs, [path.join(v.root, 'obsidian-skills')]);
    assert.equal(s.skills.find(x => x.name === 'json-canvas').description, 'Canvas files');
  } finally { v.rm(); }
});

// ---- the context is sent once ----------------------------------------------

test('the first turn carries the context and the skills; later turns carry only the message and what changed', () => {
  const agents = { instructions: 'House rule.', skills: { skills: [{ name: 'obsidian-markdown', description: 'OFM', file: '/s/obsidian-markdown/SKILL.md' }] } };
  const agent = { label: 'Claude Code', skills: true, instructions: '' };
  const t = { ...T(), user: 'sat', rel: 'Home.md', vaultPath: '/vault', cwdIsVault: true, siteTitle: 'Docs', message: 'Review this.', protect: ['SOUL.md'] };
  const first = A.turnMessage(agents, agent, t, null);
  assert.match(first, /Vault: \/vault \(your working directory\)/);
  assert.match(first, /Open note: Home\.md/);
  assert.match(first, /Mode: REVIEW/);
  assert.match(first, /obsidian-markdown — OFM \(\/s\/obsidian-markdown\/SKILL\.md\)/);
  assert.match(first, /House rule\./);
  assert.ok(first.endsWith('Review this.'));

  const same = A.turnMessage(agents, agent, t, { rel: 'Home.md', mode: 'review' });
  assert.equal(same, 'Review this.', 'nothing but the message');
  const moved = A.turnMessage(agents, agent, { ...t, rel: 'Other.md', mode: 'edit', selection: 'a line', dirty: true }, { rel: 'Home.md', mode: 'review' });
  assert.match(moved, /open note is now Other\.md/);
  assert.match(moved, /Mode: EDIT/);
  assert.match(moved, /unsaved changes/);
  assert.match(moved, /```\na line\n```/);
  assert.doesNotMatch(moved, /Vault:/);
});

test('unifiedDiff shows what changed with context', () => {
  const d = A.unifiedDiff('a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nb\nc\nD\ne\nf\ng\nh\nnew\n');
  assert.match(d, /^@@ -1,\d+ \+1,\d+ @@/);
  assert.match(d, /\n-d\n\+D\n/);
  assert.match(d, /\n\+new/);
  assert.equal(A.unifiedDiff('same\n', 'same\n'), '');
  assert.match(A.unifiedDiff(null, 'x'), /^@@ -1,1 \+1,1 @@\n-\n\+x$/);
});

// ---- over HTTP, with a fake agent ------------------------------------------

const PORT = 19250 + Math.floor(Math.random() * 300);
const url = p => `http://127.0.0.1:${PORT}${p}`;
let tmp, proc, out = '', cookie = '', agentLog;
const api = (method, p, body) => fetch(url('/s/_api/' + p), { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-requested-with': 't', cookie } });
const calls = () => fs.existsSync(agentLog) ? fs.readFileSync(agentLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

async function turn(message, extra = {}) {
  const r = await api('POST', 'agents/fake/turn', { rel: 'Home.md', message, ...extra });
  const j = await r.json();
  if (r.status !== 202) return { status: r.status, ...j };
  for (let i = 0; i < 200; i++) {
    const s = await (await api('GET', 'agent-turns/' + j.turn)).json();
    if (s.state !== 'running') return s;
    await new Promise(res => setTimeout(res, 50));
  }
  throw new Error('turn never finished');
}

before(async () => {
  tmp = makeVault({ ...FIXTURE, 'SOUL.md': '# soul\n' });
  agentLog = path.join(os.tmpdir(), `ws-fake-agent-${process.pid}-${Date.now()}.log`);
  const skills = path.join(tmp.root, '..', path.basename(tmp.root) + '-skills');
  fs.mkdirSync(path.join(skills, 'skills', 'obsidian-markdown'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'skills', 'obsidian-markdown', 'SKILL.md'), '---\nname: obsidian-markdown\ndescription: OFM\n---\n');
  const cfg = path.join(os.tmpdir(), `ws-agents-cfg-${process.pid}.json`);
  fs.writeFileSync(cfg, JSON.stringify({
    port: PORT, host: '127.0.0.1', cacheDir: false, warm: false, log: false,
    sites: [{ slug: 's', title: 'S', root: tmp.root, home: 'Home' }, { slug: 'off', title: 'Off', root: tmp.root, agents: false }],
    edit: { users: { u: 'p' }, secret: 'x'.repeat(40) },
    rateLimit: { agents: 1000 },
    agents: {
      skills: [skills],
      stateFile: path.join(os.tmpdir(), `ws-agents-state-${process.pid}.json`),
      list: [{ id: 'fake', backend: 'claude-cli', label: 'Fake', command: [process.execPath, path.join(__dirname, 'fake-agent.js')], modes: ['review', 'edit'], env: { FAKE_AGENT_LOG: agentLog } }],
    },
  }));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, WEBSIDIAN_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', d => { out += d; if (out.includes('listening')) resolve(); });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', code => reject(new Error(`server exited ${code}\n${out}`)));
    setTimeout(() => reject(new Error(`server did not start\n${out}`)), 10000);
  });
  const login = await fetch(url('/s/_edit/_login'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'user=u&password=p', redirect: 'manual' });
  cookie = (login.headers.get('set-cookie') || '').split(';')[0];
});
after(() => { if (proc) proc.kill(); if (tmp) tmp.rm(); try { fs.rmSync(agentLog, { force: true }); } catch { /* */ } });

test('the menu lists the configured agent and the skills; signed out it is 401, on an opted-out site 404', async () => {
  const j = await (await api('GET', 'agents')).json();
  assert.deepEqual(j.agents.map(a => [a.id, a.label, a.modes.join('+')]), [['fake', 'Fake', 'review+edit']]);
  assert.deepEqual(j.skills, ['obsidian-markdown']);
  assert.equal((await fetch(url('/s/_api/agents'))).status, 401);
  const offLogin = await fetch(url('/off/_edit/_login'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'user=u&password=p', redirect: 'manual' });
  const offCookie = (offLogin.headers.get('set-cookie') || '').split(';')[0];
  assert.equal((await fetch(url('/off/_api/agents'), { headers: { cookie: offCookie } })).status, 404);
  const page = await (await fetch(url('/s/_edit/Home'), { headers: { cookie } })).text();
  assert.match(page, /agent-panel\.js/, 'the panel script is on the editor page');
  const offPage = await (await fetch(url('/off/_edit/Home'), { headers: { cookie: offCookie } })).text();
  assert.doesNotMatch(offPage, /agent-panel\.js/);
});

test('one session across turns: the context goes once, then only the message', async () => {
  const one = await turn('First question');
  assert.equal(one.state, 'done', JSON.stringify(one));
  assert.equal(one.text, 'Reply to: First question');
  assert.equal(one.resumed, false);
  const two = await turn('Second question');
  assert.equal(two.text, 'Reply to: Second question');
  assert.equal(two.resumed, true);
  assert.equal(two.sessionId, one.sessionId);
  const [c1, c2] = calls().slice(-2);
  assert.ok(c1.argv.includes('--session-id') && c2.argv.includes('--resume'));
  assert.equal(c2.argv[c2.argv.indexOf('--resume') + 1], one.sessionId);
  assert.match(c1.stdin, /Open note: Home\.md/);
  assert.match(c1.stdin, /obsidian-markdown/);
  assert.equal(c2.stdin, 'Second question', 'the second turn sends the message and nothing else');
  assert.equal(path.resolve(c1.cwd), path.resolve(tmp.root), 'the agent runs in the vault');
  assert.ok(!c1.argv.some(a => a.includes('First question')), 'the message is never on the command line');

  const s = await (await api('GET', 'agents/fake/session?rel=Home.md')).json();
  assert.equal(s.turns, 2);
  assert.deepEqual(s.history.map(m => m.role), ['user', 'agent', 'user', 'agent']);
  assert.equal((await api('DELETE', 'agents/fake/session?rel=Home.md')).status, 200);
  const three = await turn('After reset');
  assert.equal(three.resumed, false);
  assert.match(calls().pop().stdin, /Open note: Home\.md/, 'a new conversation gets the context again');
});

test('edit: every file the agent touched comes back as a diff, and Revert puts it back', async () => {
  const before = fs.readFileSync(path.join(tmp.root, 'Home.md'), 'utf8');
  const r = await turn('Please WRITE and CREATE', { mode: 'edit' });
  assert.equal(r.state, 'done', JSON.stringify(r));
  const home = r.changes.find(c => c.rel === 'Home.md');
  const made = r.changes.find(c => c.rel === 'Made by agent.md');
  assert.equal(home.status, 'modified');
  assert.match(home.diff, /\n\+agent was here/);
  assert.equal(home.unexpected, false);
  assert.equal(made.status, 'created');
  const c = calls().pop();
  assert.match(c.argv[c.argv.indexOf('--tools') + 1], /Edit/);

  const rev = await (await api('POST', `agent-turns/${r.turn}/revert`, { rel: 'Home.md' })).json();
  assert.equal(rev.status, 'restored');
  assert.equal(fs.readFileSync(path.join(tmp.root, 'Home.md'), 'utf8'), before);
  const rev2 = await (await api('POST', `agent-turns/${r.turn}/revert`, { rel: 'Made by agent.md' })).json();
  assert.equal(rev2.status, 'trashed');
  assert.ok(!fs.existsSync(path.join(tmp.root, 'Made by agent.md')));
  assert.ok(fs.existsSync(path.join(tmp.root, '.trash', 'Made by agent.md')), 'moved to .trash, not deleted');
});

test('a file written in review mode is flagged, and revert refuses a file that changed again', async () => {
  // Claude Code cannot write in review; Hermes and OpenClaw can, and this is what the person sees.
  const r = await turn('WRITE anyway');
  const home = r.changes.find(c => c.rel === 'Home.md');
  assert.equal(home.unexpected, true);
  fs.appendFileSync(path.join(tmp.root, 'Home.md'), 'a human edit\n');
  const res = await api('POST', `agent-turns/${r.turn}/revert`, { rel: 'Home.md' });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /changed again/);
});

test('edit mode must be allowed; bad input is refused before anything runs', async () => {
  const n = calls().length;
  assert.equal((await turn('')).status, 400);
  assert.equal((await turn('x'.repeat(20_001))).status, 413);
  assert.equal((await api('POST', 'agents/nope/turn', { rel: 'Home.md', message: 'hi' })).status, 404);
  assert.equal((await turn('hi', { rel: '../outside.md' })).status, 400);
  assert.equal(calls().length, n, 'no agent was started');
});

test('a failing agent shows one line; its output stays in the server log', async () => {
  const r = await turn('FAIL now');
  assert.equal(r.state, 'failed');
  assert.match(r.error, /could not answer/);
  assert.doesNotMatch(JSON.stringify(r), /sk-secret-123/);
});

test('an agent reply is rendered with the vault\'s links but without raw HTML', async () => {
  const r = await turn('HTML please');
  assert.equal(r.state, 'done', JSON.stringify(r));
  const j = await (await api('POST', 'agents/render', { rel: 'Home.md', texts: [r.text] })).json();
  assert.match(j.html[0], /internal-link/, 'wikilinks resolve');
  assert.doesNotMatch(j.html[0], /<img/, 'the agent\'s HTML is text, not markup');
});
