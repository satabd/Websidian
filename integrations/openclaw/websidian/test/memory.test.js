// The Memory model and the Gateway-authenticated Memory route: what the page shows, what it links to,
// and what it refuses to expose.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { dateFromName, dayLabel, groupByDay, memoryModel, memoryVault, previewOf, MEMORY_SECTIONS } from '../lib/memory.js';
import { createMemoryHandler, memoryPage, memoryPayload, noteHref, siteBase, themeOf } from '../lib/native.js';
import { createRouteHandler, COOKIE_NAME, readSession } from '../lib/proxy.js';
import { Settings } from '../lib/guard.js';
import { normalizeVaults, resolveLinks, uiSettings } from '../lib/sites.js';

let root;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'websidian-memory-'));
  fs.writeFileSync(path.join(root, 'MEMORY.md'), '# Long term\n');
  fs.writeFileSync(path.join(root, 'USER.md'), '# The user\n');
  // No DREAMS.md: the page has to say so rather than show nothing.
  fs.mkdirSync(path.join(root, 'memory', 'daily'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory', '2026-09-21.md'), 'today\n');
  fs.writeFileSync(path.join(root, 'memory', '2026-09-20.md'), 'yesterday\n');
  fs.writeFileSync(path.join(root, 'memory', 'daily', '2026-09-19-groceries.md'), 'older\n');
  fs.mkdirSync(path.join(root, '.secrets'), { recursive: true });
  fs.writeFileSync(path.join(root, '.secrets', 'auth.md'), 'token\n');
  fs.writeFileSync(path.join(root, 'memory', 'state.db'), 'not a note\n');
  // A sibling of the vault: nothing may reach it.
  fs.writeFileSync(path.join(root, '..', path.basename(root) + '-outside.md'), 'outside\n');
});
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows holds files */ } });

const vaultOf = () => normalizeVaults([{ path: root, slug: 'workspace', title: 'Workspace' }])[0];
const BASE = '/plugins/websidian/w/workspace/';

describe('the memory model', () => {
  test('names the memory files it found and the ones it did not', () => {
    const model = memoryModel(vaultOf(), { base: BASE });
    assert.deepEqual(model.sections.map(s => s.id), ['long-term', 'user']);
    assert.deepEqual(model.missing.map(m => m.file), ['DREAMS.md']);
    assert.equal(model.sections[0].entry.url, BASE + 'MEMORY');
    assert.equal(model.sections[0].entry.title, 'MEMORY');
  });

  test('dated entries are notes only, newest first, dot-folders and non-notes left out', () => {
    const model = memoryModel(vaultOf(), { base: BASE });
    const rels = model.recent.map(n => n.rel);
    assert.deepEqual(rels, ['memory/2026-09-21.md', 'memory/2026-09-20.md', 'memory/daily/2026-09-19-groceries.md'].sort((a, b) => rels.indexOf(a) - rels.indexOf(b)));
    assert.equal(model.recent.length, 3);
    assert.ok(!rels.some(r => r.includes('.secrets')), 'dot-folders are never walked');
    assert.ok(!rels.some(r => r.endsWith('.db')), 'only .md notes');
  });

  test('never hands a filesystem path to the browser', () => {
    const model = memoryModel(vaultOf(), { base: BASE });
    const json = JSON.stringify(model);
    assert.ok(!json.includes(root.replace(/\\/g, '\\\\')) && !json.includes(root.replace(/\\/g, '/')), 'no absolute path in the payload');
    for (const note of [...model.recent, ...model.sections.map(s => s.entry)]) {
      assert.ok(!path.isAbsolute(note.rel) && !note.rel.includes('..'), note.rel);
    }
  });

  test('a vault that is not there yields an empty model, not a throw', () => {
    const model = memoryModel({ path: path.join(root, 'nope'), slug: 'x', title: 'X' }, { base: BASE });
    assert.deepEqual(model.sections, []);
    assert.equal(model.missing.length, MEMORY_SECTIONS.length);
    assert.deepEqual(model.recent, []);
  });

  test('day names come from the filename first, then the modification time', () => {
    assert.equal(dateFromName('2026-09-21.md'), '2026-09-21');
    assert.equal(dateFromName('2026-09-21-groceries.md'), '2026-09-21');
    assert.equal(dateFromName('2026-13-40.md'), '', 'not a real date');
    assert.equal(dateFromName('notes.md'), '');
    const now = Date.parse('2026-09-21T10:00:00Z');
    assert.equal(dayLabel('2026-09-21', now), 'today');
    assert.equal(dayLabel('2026-09-20', now), 'yesterday');
    assert.equal(dayLabel('2026-09-01', now), '2026-09-01');
  });

  test('groupByDay keeps the newest day first', () => {
    const days = groupByDay([{ day: '2026-09-19' }, { day: '2026-09-21' }, { day: '2026-09-21' }], Date.parse('2026-09-21T10:00:00Z'));
    assert.deepEqual(days.map(d => d.day), ['2026-09-21', '2026-09-19']);
    assert.equal(days[0].notes.length, 2);
    assert.equal(days[0].label, 'today');
  });

  test('previews are plain text: the first heading, an excerpt and a word count', () => {
    const source = [
      '---', 'title: x', '---',
      '# Long-term memory', '',
      '§ Prefers **short** updates.',
      '§ See [[USER|the user]], [[Websidian]] and [a site](https://x).',
      '- [x] done', '',
      '```js', 'secret()', '```',
      '<script>alert(1)</script>',
      '%% hidden %%',
      '| a | b |',
    ].join('\n');
    const p = previewOf(source);
    assert.equal(p.heading, 'Long-term memory');
    assert.equal(p.excerpt, 'Prefers short updates. See the user, Websidian and a site. done');
    assert.equal(p.words, 11);
    assert.ok(!/secret|alert|hidden|<|§/.test(p.excerpt), 'code, script, comments, tags and entry markers never reach it');
    const long = previewOf('word '.repeat(200));
    assert.ok(long.excerpt.length <= 221 && long.excerpt.endsWith('…'));
    assert.deepEqual(previewOf(''), { heading: '', excerpt: '', words: 0 });
  });

  test('the model carries previews for what the page shows, and when anything last changed', () => {
    const model = memoryModel(vaultOf(), { base: BASE });
    assert.equal(model.sections[0].entry.heading, 'Long term');
    assert.equal(model.recent.find(n => n.rel === 'memory/2026-09-21.md').named, true);
    assert.ok(model.updated >= Math.max(...model.recent.map(n => n.mtime)));
  });

  test('memoryVault picks the named vault, else the first the plugin serves itself', () => {
    const vaults = resolveLinks(normalizeVaults([
      { path: '/a', slug: 'a' },
      { path: '/b', slug: 'b' },
      { path: '/c', slug: 'c', url: 'https://elsewhere.example/c/' },
    ]), { enabled: true, publicBase: 'http://x' });
    assert.equal(memoryVault(vaults).slug, 'a');
    assert.equal(memoryVault(vaults, 'b').slug, 'b');
    assert.equal(memoryVault(vaults, 'c'), null, 'an external vault has no files here to read');
    assert.equal(memoryVault(vaults, 'nope'), null);
  });
});

const settingsWith = (over = {}) => new Settings({
  vaults: [{ path: root, slug: 'workspace', title: 'Workspace', edit: true }],
  ui: uiSettings({ publicBase: 'http://127.0.0.1:18789', sessionHours: 1, ...over }, {}),
});

describe('the memory payload and page', () => {
  test('links are same-origin paths in shell mode, and never the editor', () => {
    const payload = memoryPayload(settingsWith());
    assert.equal(payload.ok, true);
    assert.equal(payload.base, BASE);
    assert.equal(payload.editable, false, 'the Memory page is read-only whatever the vault allows');
    assert.equal(siteBase(settingsWith().ui, 'workspace'), BASE);
    assert.equal(noteHref(BASE + 'MEMORY', 'dark'), BASE + 'MEMORY?shell=1&theme=dark');
    assert.equal(noteHref(BASE + 'MEMORY', ''), BASE + 'MEMORY?shell=1');
    assert.ok(!JSON.stringify(payload).includes('_edit'), 'no editor URL reaches the browser');
  });

  test('a public base behind a path prefix keeps the prefix', () => {
    const payload = memoryPayload(settingsWith({ publicBase: 'https://example.test/openclaw' }));
    assert.equal(payload.base, '/openclaw/plugins/websidian/w/workspace/');
  });

  test('without a vault it explains itself instead of throwing', () => {
    const payload = memoryPayload(new Settings({ vaults: [], ui: uiSettings({}, {}) }));
    assert.equal(payload.ok, false);
    assert.match(payload.error, /no vault/);
    assert.doesNotThrow(() => memoryPage(payload));
  });

  test('themeOf only accepts the two themes a host can hand down', () => {
    assert.equal(themeOf('dark'), 'dark');
    assert.equal(themeOf('light'), 'light');
    assert.equal(themeOf('"><script>'), '');
    assert.equal(themeOf(null), '');
  });

  test('the framed page escapes what it prints and carries shell mode on every note link', () => {
    const html = memoryPage(memoryPayload(settingsWith()), { theme: 'dark' });
    assert.match(html, /<h1>Memory<\/h1>/);
    assert.match(html, /MEMORY\?shell=1&amp;theme=dark/);
    assert.match(html, /not in this workspace yet/, 'the absent DREAMS.md is shown, not hidden');
    assert.ok(!html.includes('<script'), 'the page carries no script at all');
    const nasty = memoryPayload(new Settings({
      vaults: [{ path: root, slug: 'workspace', title: '<img src=x onerror=alert(1)>' }],
      ui: uiSettings({}, {}),
    }));
    assert.ok(!memoryPage(nasty).includes('<img src=x'), 'a vault title cannot inject HTML');
  });
});

describe('the memory route', () => {
  const secrets = { session_secret: 's'.repeat(48), proxy_secret: 'p'.repeat(48) };
  const supervisor = { secrets: () => secrets, async ensure() { return { running: true }; } };
  let server, base, settings = settingsWith();

  before(async () => {
    const memory = createMemoryHandler({ supervisor, getSettings: () => settings });
    const standalone = createRouteHandler({
      supervisor: {
        ...supervisor,
        runtime: null,
        resolve: () => ({ basePath: '/plugins/websidian/w', port: 1, sites: [] }),
        async status() { return { running: false, error: 'stub', sites: [], appDir: '/a', appDirPresent: false, port: 1, node: 'node', appVersion: null, pluginVersion: null, versionSkew: false, logTail: [] }; },
      },
      getSettings: () => settings,
      getConfig: () => ({}),
      env: {},
    });
    server = http.createServer(async (req, res) => {
      if (await memory(req, res) !== false) return;
      if (await standalone(req, res) !== false) return;
      res.statusCode = 404; res.end('no route');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const cookieOf = (r, name) => (r.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).find(c => c.startsWith(name + '='));

  test('the JSON answers the model and mints a session the stand-alone route accepts', async () => {
    const r = await fetch(base + '/plugins/websidian-memory/memory.json');
    assert.equal(r.status, 200);
    const model = await r.json();
    assert.equal(model.ok, true);
    assert.equal(model.slug, 'workspace');
    const cookie = cookieOf(r, COOKIE_NAME);
    assert.ok(cookie, 'the Gateway already said who this is, so the plugin session is minted here');
    const raw = (r.headers.getSetCookie?.() || []).find(c => c.startsWith(COOKIE_NAME + '='));
    assert.match(raw, /HttpOnly/);
    assert.match(raw, /SameSite=Lax/);
    assert.match(raw, /Path=\/plugins\/websidian/);
    assert.ok(readSession(secrets.session_secret, decodeURIComponent(cookie.split('=').slice(1).join('='))), 'signed with the session secret');
    // And it really opens the stand-alone surface, with no second sign-in.
    const status = await fetch(base + '/plugins/websidian/status.json', { headers: { cookie } });
    assert.equal(status.status, 200);
  });

  test('the framed page is HTML that only its own origin may frame', async () => {
    const r = await fetch(base + '/plugins/websidian-memory');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(await r.text(), /Long-term memory/);
  });

  test('it answers only GET, only its own paths', async () => {
    assert.equal((await fetch(base + '/plugins/websidian-memory/nope')).status, 404);
    assert.equal((await fetch(base + '/plugins/websidian-memory', { method: 'POST' })).status, 405);
    // The two surfaces are siblings, not nested (OpenClaw refuses overlapping plugin route prefixes).
    // Reaching the stand-alone one still means presenting its own session.
    const standalone = await fetch(base + '/plugins/websidian/status.json');
    assert.equal(standalone.status, 401);
    assert.equal((await standalone.json()).error, 'unauthenticated');
  });

  test('turning the Memory page off leaves the rest of the plugin alone', async () => {
    const previous = settings;
    settings = settingsWith({ memory: { enabled: false } });
    try {
      assert.equal((await fetch(base + '/plugins/websidian-memory/memory.json')).status, 404);
      const login = await fetch(base + '/plugins/websidian/login');
      assert.equal(login.status, 200, 'the stand-alone sign-in still works');
    } finally { settings = previous; }
  });
});
