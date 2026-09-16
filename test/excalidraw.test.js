'use strict';
// Excalidraw viewer: the plugin's file format, the safe scene for the browser,
// the embed markup, drawing pages and the JSON route over HTTP.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { makeVault } = require('./helpers');
const { Vault } = require('../src/vault');
const { Renderer } = require('../src/render');
const ex = require('../src/excalidraw');

// A two-element scene (a rectangle and an Arabic/English text in font 5,
// Excalifont) compressed with lz-string's compressToBase64, wrapped at 80
// columns the way the plugin writes it.
const COMPRESSED = `N4IgLgngDgpiBcIYA8DGBDANgSwCYCd0B3EAGhADcZ8BnbAewDsEAmcm+gV31TkQAswYKDXgB6MSgw4C
xAHSp6AWzJJMMJTEZgaCANqg8CEOgCMqyLGP4YqMOkYBzdauQJTABg/kI7r+SI8MH5WfxB+GGxHQT9vE
ycXeDiaMHx6AGsYAGF6THp8YwBiUxgSktUAI3RUdMc0zkZcHLyCxFSHGih0G21VADNsTEwAZUhEkA4ZV
RS0zIB1IJD4NgnUjJhRiHHJo3J66MYYGl14U3J6LtRsSFjyOq4oAElcE70AXXI+wk1nhEZOIZ7LiNQ7H
BCgSx8ADMAF92DAYLh3OQqLQGMxTijqHQmAA5Ji8ZEgbA0AAiMHUYERCD6WBoMHIFWBuAAoupNNpXh8Q
JwoLh0FSkZiQDhGOk/gDMOQ8jVqfBaZh6XDDELwOZyJDjFTkGBXO4WHFfKcoXFArhgu4AGxxCJRGLLAC
s5Aczj4yTWmWa+SKZVKcEZ1Vq9UaXta4EIjE63S0us+gxGYz4E1yu1WsxgC3NSxWM3Wm22KaRQM4ByOJ
zOIAu1WuRs8cXuvOeXM+3xgv3g/0BIGDuFBJ07UomCKFK1ROIxFbH6PxjEJwpJ5MpcoV9MZzLZGhj/cl
5F5/MFRNF4o7O5F9FlQpXDPAKF1iAAEhS8gACQCcYIByMEAImCAUTB+kwwMM2AAF58Aanz/gAYugSiDE
aTo3jqACCOCOBiIowH0saUNQYDYNIyFRGhYAXJU6D0qKfCmAAHOQijaOg2CHPg7YDuc+BRIxWAACq3sY
j5DPQb5fr+0qMTAj52nephyCwDowty6BQFAowCnwoB1HggEgRKXYUNgMBEAAQoGDYhrk3qIIUfTWTZIB
wiAAzqCcwAwjCQA=`;

const scene = (elements, extra = {}) => JSON.stringify({ type: 'excalidraw', version: 2, elements, appState: { viewBackgroundColor: '#ffffff' }, files: {}, ...extra });
const el = (type, extra = {}) => ({ id: 'e' + Math.random().toString(36).slice(2, 8), type, x: 0, y: 0, width: 100, height: 50, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', isDeleted: false, groupIds: [], boundElements: null, link: null, locked: false, ...extra });

const pluginNote = (drawingBlock, sections = '') => `---
excalidraw-plugin: parsed
tags: [excalidraw]
---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==

# Excalidraw Data

## Text Elements
Hello ^t1

${sections}
%%
## Drawing
${drawingBlock}
%%`;

const FILES = {
  'Main.md': `# Main\n\n![[Sketch.excalidraw]] ![[Sketch.excalidraw|400x300]] ![[Exported.excalidraw]] ![[Hidden.excalidraw]] ![[Plain.excalidraw]] [[Sketch.excalidraw|open]]\n`,
  'Plain page.md': `# Plain\n\nNo drawing here.\n`,
  'draw/Sketch.excalidraw.md': pluginNote('```compressed-json\n' + COMPRESSED + '\n```', '## Element Links\nel1: [[Main]]\n\n## Embedded Files\nimg1: [[pic.png]]\n\nimg2: [[Other.excalidraw]]\n\nimg3: https://example.com/remote.png\n\nimg4: $$x^2$$\n'),
  'draw/Sketch.excalidraw.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  'draw/Exported.excalidraw.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
  'draw/Hidden.excalidraw.md': `---\nexcalidraw-plugin: parsed\npublish: false\n---\n# Excalidraw Data\n\n## Drawing\n\`\`\`json\n${scene([el('rectangle')])}\n\`\`\`\n`,
  'draw/Other.excalidraw.md': pluginNote('```json\n' + scene([el('rectangle')]) + '\n```'),
  'draw/Other.excalidraw.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
  'Plain.excalidraw': scene([el('ellipse'), el('embeddable', { link: 'https://youtube.com/x' }), el('text', { text: 'gone', isDeleted: true })], { appState: { viewBackgroundColor: '#fafafa', gridSize: 20, gridModeEnabled: true } }),
  'pic.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
  'Other.md': '# Other\n',
};

let tmp, vault;
before(async () => {
  tmp = makeVault(FILES);
  vault = new Vault({ slug: 's', root: tmp.root });
  await vault.scan();
});
after(() => tmp && tmp.rm());

test('lz-string: the plugin\'s compressed-json decompresses to the scene', () => {
  const json = ex.decompressFromBase64(COMPRESSED);
  const s = JSON.parse(json);
  assert.equal(s.elements.length, 2);
  assert.equal(s.elements[1].text, 'Hello عالم');
  assert.equal(ex.decompressFromBase64(''), '');
});

test('parseDrawing: compressed and plain fences, plain JSON files, embedded files section, nothing', () => {
  const p = ex.parseDrawing(FILES['draw/Sketch.excalidraw.md']);
  assert.equal(p.scene.elements.length, 2);
  assert.deepEqual([...p.embeds], [['img1', '[[pic.png]]'], ['img2', '[[Other.excalidraw]]'], ['img3', 'https://example.com/remote.png'], ['img4', '$$x^2$$']]);
  assert.equal(ex.parseDrawing(FILES['draw/Other.excalidraw.md']).scene.elements.length, 1);
  assert.equal(ex.parseDrawing(FILES['Plain.excalidraw'], { plainJson: true }).scene.elements.length, 3);
  assert.equal(ex.parseDrawing('# Excalidraw Data\n\nno drawing section'), null);
  assert.equal(ex.parseDrawing('## Drawing\n```json\nnot json\n```'), null);
});

test('toViewerScene: fonts mapped, links resolved, deleted dropped, embedded images become vault URLs', () => {
  const v = ex.toViewerScene(ex.parseDrawing(FILES['draw/Sketch.excalidraw.md']), vault, 'draw/Sketch.excalidraw.md');
  const t = v.elements.find(e => e.type === 'text');
  assert.equal(t.fontFamily, 1, 'Excalifont (5) is drawn with Virgil (1)');
  assert.equal(ex.mapFont(6), 2); assert.equal(ex.mapFont(8), 3); assert.equal(ex.mapFont(3), 3); assert.equal(ex.mapFont(99), 1);
  assert.deepEqual(v.images.img1, { url: '/s/pic.png', mimeType: 'image/png' });
  assert.deepEqual(v.images.img2, { url: '/s/draw/Other.excalidraw.png', mimeType: 'image/png' }, 'a nested drawing shows through its export');
  assert.deepEqual(v.images.img3, { url: 'https://example.com/remote.png', mimeType: 'image/png' });
  assert.equal(v.images.img4, undefined, 'LaTeX embeds are skipped');
  assert.equal(v.appState.viewBackgroundColor, '#ffffff');
  assert.equal(v.grid, false, 'gridSize alone does not mean a grid');

  const parsed = { scene: JSON.parse(scene([
    el('rectangle', { link: '[[Other]]' }), el('rectangle', { link: '[[Other#Heading|alias]]' }), el('rectangle', { link: 'Other' }),
    el('rectangle', { link: 'https://x.example/' }), el('rectangle', { link: 'javascript:alert(1)' }), el('text', { text: 'See [[Other|the other]] and [go](http://x)', originalText: 'See [[Other|the other]] and [go](http://x)', fontFamily: 7, rawText: 'x', customData: { a: 1 } }),
    el('rectangle', { isDeleted: true }), el('embeddable', { link: 'https://youtube.com/x' }),
  ], { files: { ok: { id: 'ok', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA', created: 1 }, bad: { id: 'bad', dataURL: 'data:text/html;base64,AAAA' } }, appState: { viewBackgroundColor: 'url(x)', gridSize: 20 } })), embeds: new Map() };
  const out = ex.toViewerScene(parsed, vault, 'Main.md');
  assert.deepEqual(out.elements.map(e => e.link), ['/s/Other', '/s/Other#Heading', '/s/Other', 'https://x.example/', null, null, 'https://youtube.com/x']);
  const txt = out.elements.find(e => e.type === 'text');
  assert.equal(txt.text, 'See the other and go'); assert.equal(txt.fontFamily, 2); assert.equal(txt.rawText, undefined); assert.equal(txt.customData, undefined);
  assert.equal(out.elements.length, 7, 'deleted element dropped, embeddable kept on a trusted site');
  assert.deepEqual(Object.keys(out.files), ['ok'], 'only image data URLs pass');
  assert.equal(out.appState.viewBackgroundColor, undefined, 'a non-colour background is dropped');
  assert.equal(out.grid, true, 'old files: gridSize set means grid on');

  const u = new Vault({ slug: 'u', root: tmp.root, untrusted: true });
  const outU = ex.toViewerScene(parsed, u, 'Main.md');
  assert.equal(outU.elements.some(e => e.type === 'embeddable'), false, 'iframes never on an untrusted site');
  assert.equal(ex.toViewerScene(ex.parseDrawing(FILES['draw/Sketch.excalidraw.md']), u, 'draw/Sketch.excalidraw.md').images.img3, undefined, 'no remote images on an untrusted site');
});

test('vault: drawings are hidden from navigation but resolvable; unpublished ones are not', () => {
  const n = vault.note('draw/Sketch.excalidraw.md');
  assert.equal(n.drawing, true); assert.equal(n.hidden, true); assert.equal(n.unpublished, false);
  assert.equal(vault.isDrawing('draw/Sketch.excalidraw.md'), true);
  assert.equal(vault.isDrawing('draw/Hidden.excalidraw.md'), false, 'publish: false');
  assert.equal(vault.isDrawing('Plain.excalidraw'), true);
  assert.equal(vault.isDrawing('Main.md'), false);
  assert.equal(vault.resolveDrawing('Sketch.excalidraw', 'Main.md'), 'draw/Sketch.excalidraw.md');
  assert.equal(vault.resolveDrawing('Sketch', 'Main.md'), 'draw/Sketch.excalidraw.md');
  assert.equal(vault.resolveDrawing('Hidden.excalidraw', 'Main.md'), null);
  assert.equal(vault.resolveDrawing('Exported.excalidraw', 'Main.md'), null, 'an export without the drawing');
  assert.equal(vault.resolveDrawing('Plain.excalidraw', 'Main.md'), 'Plain.excalidraw');
  assert.equal(vault.drawingUrl('draw/Sketch.excalidraw.md'), '/s/_drawing/draw/Sketch.excalidraw.md');
  assert.ok(!vault.visibleNotesSorted().some(x => x.drawing));
  const img = new Vault({ slug: 'i', root: tmp.root, excalidraw: 'image' });
  assert.equal(img.excalidraw, 'image');
  assert.equal(img.resolveDrawing('Sketch.excalidraw', 'Main.md'), null);
});

test('render: embeds become viewer boxes with the export inside; plain image when there is no drawing or the site says image', async () => {
  const out = await new Renderer().render(vault, 'Main.md');
  const boxes = out.html.match(/<div class="excalidraw-view"[^>]*>/g);
  assert.equal(boxes.length, 3, 'Sketch twice and Plain');
  assert.match(boxes[0], /data-drawing="\/s\/_drawing\/draw\/Sketch\.excalidraw\.md"/);
  assert.match(boxes[0], /data-page="\/s\/draw\/Sketch\.excalidraw"/);
  assert.match(boxes[0], /data-title="Sketch"/);
  assert.match(boxes[1], /style="max-width:400px;height:300px"/);
  assert.match(out.html, /<div class="excalidraw-view"[^>]*><img class="excalidraw" src="\/s\/draw\/Sketch\.excalidraw\.svg" alt="Sketch" loading="lazy"><\/div>/, 'export as fallback');
  assert.match(out.html, /<div class="excalidraw-view"[^>]*data-drawing="\/s\/_drawing\/Plain\.excalidraw"[^>]*><span class="excalidraw-missing">✎ Drawing: Plain<\/span><\/div>/);
  assert.match(out.html, /<img class="excalidraw" src="\/s\/draw\/Exported\.excalidraw\.png"/, 'export only: still a plain image');
  assert.match(out.html, /<span class="embed excalidraw-missing"[^>]*>✎ Drawing: draw\/Hidden\.excalidraw<\/span>/, 'unpublished drawing: placeholder');
  assert.match(out.html, /<a href="\/s\/draw\/Sketch\.excalidraw" class="internal-link">open<\/a>/);
  assert.ok(out.deps.some(d => d.rel === 'draw/Sketch.excalidraw.md'), 'the page re-renders when the drawing changes');

  const img = new Vault({ slug: 'i', root: tmp.root, excalidraw: 'image' }); await img.scan();
  const o2 = await new Renderer().render(img, 'Main.md');
  assert.ok(!o2.html.includes('excalidraw-view'));
  assert.match(o2.html, /<img class="excalidraw" src="\/i\/draw\/Sketch\.excalidraw\.svg"[^>]*width="400"/);
});

// ---- over HTTP ----------------------------------------------------------------
const PORT = 19080 + Math.floor(Math.random() * 1000);
let proc, tmp2;
const url = p => `http://127.0.0.1:${PORT}${p}`;
const get = (p, headers = {}) => fetch(url(p), { headers, redirect: 'manual' });

before(async () => {
  tmp2 = makeVault(FILES);
  const cfg = path.join(tmp2.root, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ port: PORT, host: '127.0.0.1', cacheDir: false, warm: false, log: false,
    sites: [
      { slug: 's', title: 'S', root: '.' },
      { slug: 'u', title: 'U', root: '.', untrusted: true },
      { slug: 'i', title: 'I', root: '.', excalidraw: 'image' },
    ],
    edit: { users: { ed: 'pw-1' }, allowFrom: ['127.0.0.1', '::1'], secret: 'test-secret-that-is-long-enough-for-sessions' } }));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, WEBSIDIAN_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', d => { out += d; if (out.includes('listening')) resolve(); });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', code => reject(new Error('server exited ' + code + '\n' + out)));
    setTimeout(() => reject(new Error('server did not start\n' + out)), 10000);
  });
});
after(() => { if (proc) proc.kill(); if (tmp2) tmp2.rm(); });

test('http: the drawing JSON route, with ETag revalidation', async () => {
  const r = await get('/s/_drawing/draw/Sketch.excalidraw.md');
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /json/);
  const j = await r.json();
  assert.equal(j.elements.length, 2); assert.equal(j.images.img1.url, '/s/pic.png');
  const etag = r.headers.get('etag'); assert.ok(etag);
  assert.equal((await get('/s/_drawing/draw/Sketch.excalidraw.md', { 'if-none-match': etag })).status, 304);
  assert.equal((await get('/s/_drawing/Plain.excalidraw')).status, 200, 'a plain .excalidraw file');
  assert.equal((await get('/s/_drawing/draw/Hidden.excalidraw.md')).status, 404, 'publish: false');
  assert.equal((await get('/s/_drawing/Main.md')).status, 404, 'not a drawing');
  assert.equal((await get('/s/_drawing/draw/Missing.excalidraw.md')).status, 404);
  assert.equal((await get('/s/_drawing/..%2Fcfg.json')).status, 404);
  assert.equal((await get('/i/_drawing/draw/Sketch.excalidraw.md')).status, 404, 'viewer off on this site');
});

test('http: a drawing is a page with the viewer; unpublished ones stay 404; the viewer script only where needed', async () => {
  const r = await get('/s/draw/Sketch.excalidraw');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('<title>Sketch · S</title>'));
  assert.match(html, /<div class="excalidraw-view excalidraw-page" data-drawing="\/s\/_drawing\/draw\/Sketch\.excalidraw\.md" data-title="Sketch">/);
  assert.ok(html.includes('/_static/excalidraw-view.js?v='));
  assert.ok(html.includes('<meta property="og:image"'), 'the export is the social image');
  assert.equal((await get('/s/draw/Sketch.excalidraw.md')).status, 301, 'canonical redirect');
  assert.equal((await get('/s/Sketch.excalidraw')).status, 301, 'bare name redirects');
  assert.equal((await get('/s/draw/Sketch.excalidraw?raw')).status, 200);
  assert.equal((await get('/s/Plain.excalidraw')).status, 200, 'a plain .excalidraw file is a page too');
  assert.ok((await (await get('/s/Plain.excalidraw?raw')).text()).startsWith('{'), '?raw still gives the JSON');
  assert.equal((await get('/s/draw/Hidden.excalidraw')).status, 404);
  assert.equal((await get('/i/draw/Sketch.excalidraw')).status, 404, 'images-only site: no drawing pages');
  const main = await (await get('/s/Main')).text();
  assert.ok(main.includes('/_static/excalidraw-view.js?v='));
  assert.ok(main.includes('"assets":""') || main.includes('assets:""'), 'page global carries the assets root');
  const plain = await (await get('/s/Plain%20page')).text();
  assert.ok(!plain.includes('excalidraw-view.js'), 'no viewer script on a page without drawings');
  assert.ok(!main.includes('Sketch.excalidraw</a></li>'), 'drawings stay out of the navigation');
});

test('http: the editor page carries the viewer script and its preview renders the viewer box', async () => {
  const login = await fetch(url('/s/_edit/_login'), { method: 'POST', body: new URLSearchParams({ user: 'ed', password: 'pw-1', next: '/s/_edit/Main' }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const html = await (await get('/s/_edit/Main', { cookie })).text();
  assert.ok(html.includes('/_static/excalidraw-view.js?v='), 'editor page loads the viewer glue');
  const pv = await fetch(url('/s/_api/preview'), { method: 'POST', body: JSON.stringify({ rel: 'Main.md', text: 'x ![[Sketch.excalidraw]]' }), headers: { 'content-type': 'application/json', 'x-requested-with': 'md2html', cookie } });
  assert.equal(pv.status, 200);
  assert.match((await pv.json()).html, /<div class="excalidraw-view" data-drawing="\/s\/_drawing\/draw\/Sketch\.excalidraw\.md"/);
});

test('http: untrusted site keeps its CSP and strips iframes; the viewer libraries and fonts are served locally', async () => {
  const r = await get('/u/_drawing/Plain.excalidraw');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.elements.map(e => e.type), ['ellipse']);
  const p = await get('/u/Plain.excalidraw');
  assert.equal(p.status, 200); assert.match(p.headers.get('content-security-policy'), /script-src 'self' 'nonce-/);
  for (const a of ['/_vendor/excalidraw/excalidraw.production.min.js', '/_vendor/excalidraw/excalidraw-assets/Virgil.woff2', '/_vendor/react/react.production.min.js', '/_vendor/react-dom/react-dom.production.min.js', '/_static/excalidraw-view.js']) {
    assert.equal((await get(a)).status, 200, a);
  }
});
