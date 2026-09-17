import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Settings } from '../lib/guard.js';
import { uiSettings } from '../lib/sites.js';
import { buildConfig, loadOrCreateSecrets, resolveRuntime, versionSkew, writeConfigIfChanged, readVersionStamp, tailLines, Supervisor } from '../lib/supervisor.js';
import { cleanUser, expectedCredential, filterRequestHeaders, filterResponseHeaders, loginPage, makeSession, parseCookies, readSession, safeNext, statusPage, upstreamTarget } from '../lib/proxy.js';

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-rt-')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const settings = (ui = {}) => new Settings({
  vaults: [{ path: path.join(tmp, 'brain'), edit: true }, { path: path.join(tmp, 'notes') }, { path: '/ext', url: 'https://b.example/hermes/' }],
  ui: uiSettings({ publicBase: 'https://g.example/oc', dataDir: path.join(tmp, 'data'), ...ui }, {}),
});

describe('runtime config', () => {
  test('resolveRuntime and buildConfig', () => {
    const rt = resolveRuntime(settings());
    assert.equal(rt.basePath, '/oc/plugins/websidian/w');
    assert.equal(rt.configPath, path.join(tmp, 'data', 'websidian.config.json'));
    assert.equal(rt.appDir, path.join(tmp, 'data', 'app'));
    assert.deepEqual(rt.sites.map(s => s.slug), ['brain', 'notes']); // the external site is not served here
    const cfg = buildConfig(rt, { proxy_secret: 'p'.repeat(48), edit_secret: 'e'.repeat(48), site_token: 't'.repeat(48) });
    assert.equal(cfg.host, '127.0.0.1');
    assert.equal(cfg.basePath, '/oc/plugins/websidian/w');
    assert.equal(cfg.publicUrl, 'https://g.example/oc');
    assert.equal(cfg.proxyAuth.secretHeader, 'x-websidian-proxy-secret');
    assert.deepEqual(cfg.proxyAuth.allowFrom, ['127.0.0.1', '::1']);
    assert.equal(cfg.sites[0].untrusted, true);
    assert.deepEqual(cfg.sites[0].edit, { allowFrom: ['127.0.0.1', '::1'], secret: 'e'.repeat(48) });
    assert.equal(cfg.sites[1].edit, false);
    assert.equal(cfg.sites[0].auth.token, 't'.repeat(48));
  });
  test('secrets persist and change detection', () => {
    const p = path.join(tmp, 'sec', 'secrets.json');
    const a = loadOrCreateSecrets(p);
    const b = loadOrCreateSecrets(p);
    assert.deepEqual(a, b);
    for (const k of ['proxy_secret', 'edit_secret', 'site_token', 'session_secret']) assert.ok(a[k].length >= 48, k);
    const cfgPath = path.join(tmp, 'sec', 'c.json');
    assert.equal(writeConfigIfChanged(cfgPath, { b: 1, a: [2] }), true);
    assert.equal(writeConfigIfChanged(cfgPath, { a: [2], b: 1 }), false);
    assert.equal(writeConfigIfChanged(cfgPath, { a: [3], b: 1 }), true);
    if (process.platform !== 'win32') assert.equal(fs.statSync(cfgPath).mode & 0o777, 0o600);
  });
  test('version stamps, tails', () => {
    const p = path.join(tmp, 'websidian.version');
    fs.writeFileSync(p, JSON.stringify({ revision: 'abc', component: 'runtime' }));
    assert.equal(readVersionStamp(p).revision, 'abc');
    assert.equal(readVersionStamp(path.join(tmp, 'nope')), null);
    assert.equal(versionSkew({ revision: 'a' }, { revision: 'b' }), true);
    assert.equal(versionSkew({ revision: 'a' }, null), false);
    const log = path.join(tmp, 'server.log');
    fs.writeFileSync(log, 'l1\nl2\nl3\n');
    assert.deepEqual(tailLines(log, 2), ['l2\n', 'l3\n']);
    assert.deepEqual(tailLines(path.join(tmp, 'nope.log')), []);
  });
  test('supervisor reports a missing runtime and no vaults without spawning anything', async () => {
    const sup = new Supervisor(() => settings({ port: 1 }));
    const r = await sup.ensure();
    assert.equal(r.running, false);
    assert.match(r.error, /not installed/);
    const empty = new Supervisor(() => new Settings({ ui: uiSettings({ dataDir: path.join(tmp, 'data') }, {}) }));
    assert.match((await empty.ensure()).error, /no vaults/);
    const status = await sup.status();
    assert.equal(status.running, false);
    assert.equal(status.appDirPresent, false);
    assert.deepEqual(status.sites.map(s => s.url), ['/oc/plugins/websidian/w/brain/', '/oc/plugins/websidian/w/notes/']);
  });
});

describe('proxy rules', () => {
  test('request headers: allowlist, identity encoding, secret and user', () => {
    const out = filterRequestHeaders([['Cookie', 'x'], ['Authorization', 'y'], ['Content-Type', 'text/plain'], ['X-Websidian-User', 'evil'], ['X-Forwarded-For', '1']], 's', 'Al ice');
    assert.deepEqual(out, [['content-type', 'text/plain'], ['accept-encoding', 'identity'], ['x-websidian-proxy-secret', 's'], ['x-websidian-user', 'Al ice']]);
    assert.equal(cleanUser('<b>x</b>'), 'bxb');
    assert.equal(cleanUser(''), 'openclaw');
  });
  test('response headers drop Set-Cookie', () => {
    assert.deepEqual(filterResponseHeaders({ 'set-cookie': ['a=b'], 'Content-Type': 'text/html', etag: '"x"', 'x-powered-by': 'e' }), [['content-type', 'text/html'], ['etag', '"x"']]);
  });
  test('upstream target validation', () => {
    const b = '/plugins/websidian/w';
    assert.equal(upstreamTarget(b + '/brain/My%20Note', 'q=1', b), b + '/brain/My%20Note?q=1');
    assert.equal(upstreamTarget(b, '', b), b);
    assert.equal(upstreamTarget('/plugins/websidianx/a', '', b), null);
    assert.equal(upstreamTarget(b + '/../x', '', b), null);
    assert.equal(upstreamTarget(b + '/%2e%2e/x', '', b), null);
    assert.equal(upstreamTarget(b + '/a%2fb', '', b), null);
    assert.equal(upstreamTarget(b + '/a\\b', '', b), null);
    assert.equal(upstreamTarget(b + '/a b', '', b), null);
    assert.equal(upstreamTarget(b + '/a', 'x\ny', b), null);
  });
  test('sessions round-trip, expire, and reject tampering', () => {
    const s = makeSession('secret', 'operator', 1);
    assert.equal(readSession('secret', s.value), 'operator');
    assert.equal(readSession('other', s.value), null);
    assert.equal(readSession('secret', s.value.replace('operator', 'admin')), null);
    assert.equal(readSession('secret', makeSession('secret', 'x', -1).value), null);
    assert.equal(readSession('secret', 'garbage'), null);
    assert.deepEqual(parseCookies('a=1; websidian_session=x.y.z; b=%20'), { a: '1', websidian_session: 'x.y.z', b: ' ' });
  });
  test('safeNext keeps only plugin pages', () => {
    assert.equal(safeNext('/plugins/websidian/w/brain/A'), '/plugins/websidian/w/brain/A');
    assert.equal(safeNext('/plugins/websidian'), '/plugins/websidian');
    assert.equal(safeNext('https://evil'), '/plugins/websidian/');
    assert.equal(safeNext('//evil'), '/plugins/websidian/');
    assert.equal(safeNext('/plugins/websidian/login?next=x'), '/plugins/websidian/');
    assert.equal(safeNext('/other'), '/plugins/websidian/');
  });
  test('expected credential: gateway token, gateway password, ui password, none', () => {
    const ui = uiSettings({}, {});
    assert.deepEqual(expectedCredential({ gateway: { auth: { mode: 'token', token: 'tok' } } }, ui, {}).kind, 'token');
    assert.equal(expectedCredential({ gateway: { auth: { mode: 'token', token: 'tok' } } }, ui, {}).secret, 'tok');
    assert.equal(expectedCredential({ gateway: { auth: { mode: 'password', password: 'pw' } } }, ui, {}).kind, 'password');
    assert.equal(expectedCredential({}, ui, { OPENCLAW_GATEWAY_TOKEN: 'envtok' }).secret, 'envtok');
    assert.equal(expectedCredential({ gateway: { auth: { mode: 'token', token: { source: 'env', provider: 'x', id: 'y' } } } }, ui, {}).kind, 'none');
    assert.equal(expectedCredential({}, uiSettings({ auth: 'password', password: 'p' }, {}), {}).secret, 'p');
    assert.equal(expectedCredential({}, uiSettings({ auth: 'password' }, {}), {}).kind, 'none');
    assert.equal(expectedCredential({}, ui, {}).kind, 'none');
  });
  test('pages escape their inputs', () => {
    assert.ok(loginPage({ next: '"><script>', error: '<b>', hint: 'x', csrf: '"x' }).includes('&quot;&gt;&lt;script&gt;'));
    assert.ok(loginPage({ next: '/', error: '', hint: 'x', csrf: '"x' }).includes('value="&quot;x"'));
    const html = statusPage({ running: false, error: '<boom>', sites: [{ title: '<t>', slug: 's', url: '/u/', edit: true, root: '/r', untrusted: true }], appDir: '/a', appDirPresent: true, port: 1, node: 'node', appVersion: null, pluginVersion: null, versionSkew: false, logTail: ['<log>\n'] }, '<u>');
    assert.ok(html.includes('&lt;boom&gt;') && html.includes('&lt;t&gt;') && html.includes('&lt;log&gt;') && html.includes('&lt;u&gt;'));
    assert.ok(!html.includes('<boom>') && !html.includes('<log>'));
    assert.ok(html.includes('http-equiv="refresh"'));
  });
});
