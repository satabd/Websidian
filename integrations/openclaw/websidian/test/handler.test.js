// The route handler over a real HTTP server, with a stub supervisor: sign-in, CSRF, sessions, status, logout.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRouteHandler, COOKIE_NAME, CSRF_COOKIE } from '../lib/proxy.js';
import { Settings } from '../lib/guard.js';
import { uiSettings } from '../lib/sites.js';

let server, base;
const secrets = { session_secret: 's'.repeat(48), proxy_secret: 'p'.repeat(48) };
const supervisor = {
  runtime: null,
  resolve() { return { basePath: '/plugins/websidian/w', port: 1, sites: [] }; },
  secrets() { return secrets; },
  async status() { return { running: false, error: 'stub', sites: [], appDir: '/a', appDirPresent: false, port: 1, node: 'node', appVersion: null, pluginVersion: null, versionSkew: false, logTail: [] }; },
  async ensure() { return { running: false }; },
};
const settings = () => new Settings({ ui: uiSettings({ sessionHours: 1 }, {}) });
const cfg = { gateway: { auth: { mode: 'token', token: 'the-token' } } };

before(async () => {
  const handle = createRouteHandler({ supervisor, getSettings: settings, getConfig: () => cfg, env: {} });
  server = http.createServer(async (req, res) => { if (await handle(req, res) === false) { res.statusCode = 404; res.end('not plugin'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const cookieOf = (r, name) => (r.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).find(c => c.startsWith(name + '='));
const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body });

async function loginForm() {
  const r = await fetch(base + '/plugins/websidian/login');
  const html = await r.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
  return { csrf, cookie: cookieOf(r, CSRF_COOKIE) };
}

describe('sign-in over HTTP', () => {
  test('the form carries a nonce that matches a SameSite=Lax cookie', async () => {
    const r = await fetch(base + '/plugins/websidian/login');
    const setCookie = r.headers.getSetCookie()[0];
    assert.match(setCookie, new RegExp(`^${CSRF_COOKIE}=[A-Za-z0-9_-]{20,}; Path=/plugins/websidian; HttpOnly; SameSite=Lax`));
    const html = await r.text();
    assert.ok(html.includes(`name="csrf" value="${setCookie.split(';')[0].split('=')[1]}"`));
  });
  test('a post without the nonce, or with a foreign Origin, is refused; Origin "null" is fine', async () => {
    const { csrf, cookie } = await loginForm();
    let r = await post('/plugins/websidian/login', 'secret=the-token');
    assert.equal(r.status, 403);
    assert.match(await r.text(), /expired or came from another site/);
    r = await post('/plugins/websidian/login', `secret=the-token&csrf=${csrf}`, { cookie, origin: 'http://evil.example' });
    assert.equal(r.status, 403);
    r = await post('/plugins/websidian/login', `secret=the-token&csrf=${csrf}&next=%2Fplugins%2Fwebsidian%2F`, { cookie, origin: 'null' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/plugins/websidian/');
    assert.ok(cookieOf(r, COOKIE_NAME));
  });
  test('a wrong secret answers 401 with a fresh form; the right one signs in and the status page loads', async () => {
    const { csrf, cookie } = await loginForm();
    let r = await post('/plugins/websidian/login', `secret=nope&csrf=${csrf}`, { cookie });
    assert.equal(r.status, 401);
    assert.match(await r.text(), /That is not the token/);
    const fresh = await loginForm();
    r = await post('/plugins/websidian/login', `secret=the-token&csrf=${fresh.csrf}&next=%2Fplugins%2Fwebsidian%2Fw%2Fx%2FNote`, { cookie: fresh.cookie });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/plugins/websidian/w/x/Note');
    const session = cookieOf(r, COOKIE_NAME);
    r = await fetch(base + '/plugins/websidian/', { headers: { cookie: session } });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /Signed in as operator/);
    const logoutCsrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
    const logoutCookie = cookieOf(r, CSRF_COOKIE);
    r = await post('/plugins/websidian/logout', `csrf=${logoutCsrf}`, { cookie: `${session}; ${logoutCookie}` });
    assert.equal(r.status, 302);
    assert.ok(r.headers.getSetCookie().some(c => c.startsWith(`${COOKIE_NAME}=;`)));
    r = await post('/plugins/websidian/logout', 'csrf=x', { cookie: session });
    assert.equal(r.status, 403);
  });
  test('without a session: pages redirect, JSON answers 401, other paths are not ours', async () => {
    let r = await fetch(base + '/plugins/websidian/w/x/Note', { redirect: 'manual' });
    assert.equal(r.status, 302);
    r = await fetch(base + '/plugins/websidian/status.json');
    assert.equal(r.status, 401);
    r = await fetch(base + '/other');
    assert.equal(r.status, 404);
    assert.equal(await r.text(), 'not plugin');
  });
});
