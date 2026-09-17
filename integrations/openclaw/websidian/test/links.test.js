import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editUrl, formatLinksBlock, isNoteRel, linksForPath, noteLinks, noteRelToUrlPath, recentNotes, relativeNotePath, viewUrl } from '../lib/links.js';
import { normalizeVaults, publicPrefix, resolveLinks, siteUrl, slugify, uiSettings, websidianBasePath, workspaceDirs, workspaceFor } from '../lib/sites.js';
import { ChangeTracker } from '../lib/tracker.js';

let tmp, vault;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-links-'));
  vault = path.join(tmp, 'brain');
  fs.mkdirSync(path.join(vault, 'Folder'), { recursive: true });
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Folder', 'My Note.md'), '# x');
  fs.writeFileSync(path.join(vault, 'Older.md'), '# y');
  fs.writeFileSync(path.join(vault, '.obsidian', 'app.md'), '{}');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(vault, 'Older.md'), past, past);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('urls', () => {
  test('view and edit URLs match Websidian noteUrl', () => {
    assert.equal(viewUrl('https://b.example/hermes/', 'Folder/My Note.md'), 'https://b.example/hermes/Folder/My%20Note');
    assert.equal(editUrl('https://b.example/hermes', 'Folder/My Note.md'), 'https://b.example/hermes/_edit/Folder/My%20Note');
    assert.equal(noteRelToUrlPath('A\\B#1.MD'), 'A/B%231');
    assert.equal(noteRelToUrlPath('عربي/ملاحظة.md'), '%D8%B9%D8%B1%D8%A8%D9%8A/%D9%85%D9%84%D8%A7%D8%AD%D8%B8%D8%A9');
  });
  test('relativeNotePath: nested, relative, backslashes, outside', () => {
    assert.equal(relativeNotePath(path.join(vault, 'Folder', 'My Note.md'), vault), 'Folder/My Note.md');
    assert.equal(relativeNotePath('Folder/My Note.md', vault, vault), 'Folder/My Note.md');
    assert.equal(relativeNotePath(vault.replace(/\//g, '\\') + '\\Folder\\My Note.md', vault), 'Folder/My Note.md');
    assert.equal(relativeNotePath(path.join(tmp, 'other.md'), vault), null);
    assert.equal(relativeNotePath(vault, vault), null);
  });
  test('isNoteRel', () => {
    assert.ok(isNoteRel('A/B.md'));
    assert.ok(!isNoteRel('.obsidian/x.md'));
    assert.ok(!isNoteRel('A/.trash/x.md'));
    assert.ok(!isNoteRel('A/x.png'));
  });
});

describe('sites', () => {
  test('slug sources and uniqueness', () => {
    const v = normalizeVaults([
      { path: '/x/My Brain' }, { path: '/y', url: 'https://b.example/hermes/' }, { path: '/z', slug: 'Custom Slug' }, { path: '/w/My Brain' }, { path: '' }, null,
    ]);
    assert.deepEqual(v.map(x => x.slug), ['my-brain', 'hermes', 'custom-slug', 'my-brain-2']);
    assert.equal(v[1].url, 'https://b.example/hermes/');
    assert.equal(v[0].title, 'My Brain');
    assert.equal(v[0].edit, false);
    assert.equal(v[0].untrusted, true);
    assert.equal(slugify('_hidden_'), 'hidden');
  });
  test('ui defaults and overrides', () => {
    const d = uiSettings({}, { gateway: { port: 19000 } }, { OPENCLAW_STATE_DIR: tmp });
    assert.equal(d.publicBase, 'http://127.0.0.1:19000');
    assert.equal(d.port, 8095);
    assert.equal(d.auth, 'gateway');
    assert.equal(d.dataDir, path.join(tmp, 'plugin-data', 'websidian'));
    assert.equal(d.appDir, path.join(tmp, 'plugin-data', 'websidian', 'app'));
    const o = uiSettings({ port: '7000', publicBase: 'https://g.example/oc/', auth: 'password', password: 'pw', sessionHours: 2, appDir: '~/app', enabled: 'false' }, {}, { OPENCLAW_STATE_DIR: tmp, HOME: tmp, USERPROFILE: tmp });
    assert.equal(o.port, 7000);
    assert.equal(o.publicBase, 'https://g.example/oc');
    assert.equal(o.auth, 'password');
    assert.equal(o.sessionHours, 2);
    assert.equal(o.appDir, path.join(tmp, 'app'));
    assert.equal(o.enabled, false);
  });
  test('links: plugin-served sites, external url, ui off', () => {
    const ui = uiSettings({ publicBase: 'http://127.0.0.1:18789' }, {});
    const [served, external] = resolveLinks(normalizeVaults([{ path: vault }, { path: '/y', url: 'https://b.example/hermes' }]), ui);
    assert.equal(served.url, 'http://127.0.0.1:18789/plugins/websidian/w/brain/');
    assert.deepEqual(noteLinks(served, 'Folder/My Note.md'), ['http://127.0.0.1:18789/plugins/websidian/w/brain/Folder/My%20Note', '']);
    assert.deepEqual(noteLinks({ ...served, edit: true }, 'A.md'), ['http://127.0.0.1:18789/plugins/websidian/w/brain/A', 'http://127.0.0.1:18789/plugins/websidian/w/brain/_edit/A']);
    assert.equal(external.url, 'https://b.example/hermes/');
    assert.deepEqual(noteLinks(external, 'A.md'), ['https://b.example/hermes/A', 'https://b.example/hermes/_edit/A']);
    const [off] = resolveLinks(normalizeVaults([{ path: vault }]), { ...ui, enabled: false });
    assert.equal(off.url, '');
    assert.deepEqual(noteLinks(off, 'A.md'), ['', '']);
  });
  test('public prefix and mount', () => {
    assert.equal(publicPrefix('https://x.example/openclaw/'), '/openclaw');
    assert.equal(publicPrefix('http://127.0.0.1:18789'), '');
    assert.equal(websidianBasePath('https://x.example/openclaw'), '/openclaw/plugins/websidian/w');
    assert.equal(siteUrl('https://x.example/openclaw/', 'brain'), 'https://x.example/openclaw/plugins/websidian/w/brain/');
  });
  test('workspaces from the Gateway config', () => {
    const env = { OPENCLAW_STATE_DIR: tmp };
    assert.deepEqual(workspaceDirs({}, env), [path.join(tmp, 'workspace')]);
    assert.deepEqual(workspaceDirs({}, { ...env, OPENCLAW_PROFILE: 'work' }), [path.join(tmp, 'workspace-work')]);
    const cfg = { agents: { defaults: { workspace: '/ws/main' }, list: [{ id: 'main' }, { id: 'ops', workspace: '/ws/ops' }] } };
    assert.deepEqual(workspaceDirs(cfg, env), [path.resolve('/ws/main'), path.resolve('/ws/ops')]);
    assert.equal(workspaceFor(cfg, 'ops', env), path.resolve('/ws/ops'));
    assert.equal(workspaceFor(cfg, 'main', env), path.resolve('/ws/main'));
    assert.equal(workspaceFor({}, undefined, env), path.join(tmp, 'workspace'));
  });
});

describe('linksForPath, recentNotes, formatting, tracker', () => {
  const vaults = () => resolveLinks(normalizeVaults([{ path: vault }]), uiSettings({ publicBase: 'http://g' }, {}));
  test('linksForPath', () => {
    const e = linksForPath(path.join(vault, 'Folder', 'My Note.md'), vaults());
    assert.equal(e.rel, 'Folder/My Note.md');
    assert.equal(e.title, 'My Note');
    assert.equal(e.view, 'http://g/plugins/websidian/w/brain/Folder/My%20Note');
    assert.equal(linksForPath(path.join(vault, '.obsidian', 'app.md'), vaults()), null);
    assert.equal(linksForPath(path.join(tmp, 'x.md'), vaults()), null);
  });
  test('recentNotes skips dot folders, sorts by mtime, filters', () => {
    const notes = recentNotes(vaults(), { limit: 10 });
    assert.deepEqual(notes.map(n => n.rel), ['Folder/My Note.md', 'Older.md']);
    assert.deepEqual(recentNotes(vaults(), { query: 'old' }).map(n => n.rel), ['Older.md']);
    assert.deepEqual(recentNotes([{ path: path.join(tmp, 'missing') }]), []);
  });
  test('formatLinksBlock', () => {
    assert.equal(formatLinksBlock([{ rel: 'A/B.md', view: 'v', edit: 'e' }, { rel: 'C.md', view: '' }]), 'Notes updated:\n- A/B: v (edit: e)\n- C.md (no url configured for this vault)');
  });
  test('tracker: per session, pending drains, LRU caps', () => {
    const t = new ChangeTracker();
    t.record('s1', { rel: 'A.md', vault: 'v', view: 'x' });
    t.record('s1', { rel: 'A.md', vault: 'v', view: 'x2' });
    t.record('s2', { rel: 'B.md', vault: 'v', view: 'y' });
    assert.equal(t.hasPending('s1'), true);
    assert.deepEqual(t.takePending('s1').map(e => e.view), ['x2']);
    assert.equal(t.hasPending('s1'), false);
    assert.deepEqual(t.all('s1').map(e => e.rel), ['A.md']);
    assert.deepEqual(t.all('s2').map(e => e.rel), ['B.md']);
    assert.deepEqual(t.takePending('nope'), []);
    for (let i = 0; i < 250; i++) t.record('s3', { rel: `N${i}.md`, vault: 'v', view: 'z' });
    assert.equal(t.all('s3').length, 200);
    for (let i = 0; i < 300; i++) t.record(`sess${i}`, { rel: 'x.md', vault: 'v', view: 'z' });
    assert.equal(t.all('s1').length, 0); // evicted
  });
});
