'use strict';
// Right-to-left notes without `lang:` in their frontmatter. Agent-written notes (Hermes) rarely carry one,
// so an Arabic note used to render as a left-to-right page with right-aligned paragraphs at best.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { makeVault } = require('./helpers');
const { Vault } = require('../src/vault');
const { Renderer, detectDirection } = require('../src/render');

const ARABIC = `# ملاحظات المشروع

هذه ملاحظة مكتوبة بالعربية عن إعداد الخادم وتشغيله.

- استخدم \`npm install\` لتثبيت الحزم
- راجع https://example.com/a/long/latin/url/that/should/not/count للتفاصيل

> [!note] تنبيه
> لا تنسَ إعادة تشغيل الخادم.

This English line stays left to right.

| العمود | القيمة |
|---|---|
| المنفذ | 8095 |
`;

const FILES = {
  'عربي.md': ARABIC,
  'English.md': '# Notes\n\nPlain English, with one Arabic word: مرحبا.\n',
  'Forced.md': '---\nlang: en\n---\n' + ARABIC,
  'Hebrew.md': '# הערות\n\nזוהי הערה בעברית על השרת.\n',
  'Code.md': '# Setup\n\n```bash\n# تعليق عربي طويل داخل كتلة الشيفرة لا يغيّر اتجاه الصفحة أبداً\n```\n\nShort English text.\n',
};

test('detectDirection: majority of letters, ignoring URLs and inline code', () => {
  assert.deepEqual(detectDirection('مرحبا بكم في الموقع'), { dir: 'rtl', lang: 'ar' });
  assert.deepEqual(detectDirection('שלום עולם'), { dir: 'rtl', lang: 'he' });
  assert.deepEqual(detectDirection('Hello world, and مرحبا'), { dir: 'ltr', lang: '' });
  assert.deepEqual(detectDirection(''), { dir: 'ltr', lang: '' });
  assert.deepEqual(detectDirection('12345 !!!'), { dir: 'ltr', lang: '' });
  // Technical Arabic: Latin commands and a long URL must not outvote the prose.
  assert.equal(detectDirection('استخدم `npm install express` لتثبيت الحزمة https://registry.npmjs.org/express/very/long').dir, 'rtl');
});

let tmp, vault, renderer;
before(async () => {
  tmp = makeVault(FILES);
  vault = new Vault({ slug: 's', root: tmp.root });
  await vault.scan();
  renderer = new Renderer();
});
after(() => tmp.rm());

test('render: the note direction comes back with the HTML; fenced code does not count', async () => {
  assert.deepEqual((({ dir, lang }) => ({ dir, lang }))(await renderer.render(vault, 'عربي.md')), { dir: 'rtl', lang: 'ar' });
  assert.equal((await renderer.render(vault, 'English.md')).dir, 'ltr');
  assert.equal((await renderer.render(vault, 'Hebrew.md')).lang, 'he');
  assert.equal((await renderer.render(vault, 'Code.md')).dir, 'ltr');
});

for (const untrusted of [false, true]) {
  test(`top-level blocks get dir="auto" so mixed lines read the right way (${untrusted ? 'untrusted' : 'trusted'})`, async () => {
    const v = new Vault({ slug: 's', root: tmp.root, untrusted });
    await v.scan();
    const { html } = await renderer.render(v, 'عربي.md');
    assert.match(html, /<h1[^>]* dir="auto"/);
    assert.match(html, /<p dir="auto">This English line/);
    assert.match(html, /<ul dir="auto">/);
    assert.match(html, /<table dir="auto">/);
    assert.match(html, /<div class="callout callout-note" data-callout="note" dir="auto">/);
    // dir="auto" ignores descendants that have their own dir, so nested blocks must not carry one:
    // otherwise the list's bullets or the quote bar would stay on the side of the page, not the text.
    assert.doesNotMatch(html, /<li[^>]* dir=/, 'list items follow their list');
    assert.doesNotMatch(html, /class="callout-content"><p dir=/, 'callout paragraphs follow their callout');
    assert.doesNotMatch(html, /<td dir=/, 'cells follow their table, so a number-only cell does not flip');
    assert.doesNotMatch(html, /<pre[^>]* dir=/, 'code stays left to right');
  });
}

// ---- the page, over HTTP, as the Hermes dashboard tab gets it -----------------------------------
const PORT = 19100 + Math.floor(Math.random() * 400);
let proc, cfgDir;
const get = p => fetch(`http://127.0.0.1:${PORT}${p}`);
const htmlTag = async p => { const t = await (await get(p)).text(); return /<html[^>]*>/.exec(t)[0]; };

before(async () => {
  cfgDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'websidian-dir-'));
  const cfg = path.join(cfgDir, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ port: PORT, host: '127.0.0.1', cacheDir: false, warm: false, log: false,
    sites: [{ slug: 'u', title: 'Untrusted', root: tmp.root, untrusted: true }] }));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, WEBSIDIAN_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let out = '';
    const poll = setInterval(() => get('/_health').then(r => { if (r.ok) { clearInterval(poll); resolve(); } }).catch(() => {}), 100);
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', code => { clearInterval(poll); reject(new Error('server exited ' + code + '\n' + out)); });
    setTimeout(() => { clearInterval(poll); reject(new Error('server did not start\n' + out)); }, 10000);
  });
});
after(() => { if (proc) proc.kill(); if (cfgDir) fs.rmSync(cfgDir, { recursive: true, force: true }); });

test('an Arabic note without lang: is a right-to-left page, on an untrusted site too', async () => {
  const tag = await htmlTag('/u/' + encodeURIComponent('عربي'));
  assert.match(tag, /lang="ar"/);
  assert.match(tag, /dir="rtl"/);
  assert.match(await htmlTag('/u/' + encodeURIComponent('عربي') + '?embed=1'), /dir="rtl"/, 'embed mode, as in an iframe');
});

test('an explicit lang: wins over detection; English and Hebrew notes get what they are', async () => {
  assert.match(await htmlTag('/u/Forced'), /lang="en" dir="ltr"/);
  assert.match(await htmlTag('/u/English'), /dir="ltr"/);
  assert.match(await htmlTag('/u/Hebrew'), /lang="he" dir="rtl"/);
});

test('sidebar, table of contents and backlink titles carry dir="auto"', async () => {
  const html = await (await get('/u/English')).text();
  assert.match(html, /class="nav-note[^"]*" href="[^"]*" dir="auto"/);
});
