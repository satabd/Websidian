'use strict';
// Block references, footnotes, math, Excalidraw, translations, snippets, cssclasses.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeVault } = require('./helpers');
const { Vault } = require('../src/vault');
const { Renderer, extractBlock } = require('../src/render');
const { page } = require('../src/layout');

const FILES = {
  'Main.md': `---
title: Main
lang: en
cssclasses: [wide, brochure]
translation: "[[Rapport]]"
---
# Main

A paragraph with an id. ^para1

- item one
- item two ^item2

| a | b |
|---|---|
| 1 | 2 |

^tbl

See [[Other#^p]] and footnote[^1] and $E = mc^2$ inline, $5 and $6 are money.

$$
\\int_0^1 x\\,dx
$$

![[Other#^p]] ![[Sketch.excalidraw]] ![[Missing.excalidraw]]

Link to [[Arabic Edition]] and [[Glossary]].

[^1]: The footnote text.
`,
  'Other.md': `# Other\n\nIntro line.\n\nThe referenced block. ^p\n\nTrailing.\n`,
  'Rapport.md': `---\ntitle: Rapport\nlang: fr\n---\n# Rapport\n`,
  'Arabic Edition.md': `---\ntitle: النسخة\nlang: ar\n---\n# النسخة\n\nرابط إلى [[Main]].\n`,
  'Unrelated.md': `---\nlang: ar\n---\n[[Main]] links to main but main does not link back.\n`,
  'Glossary.md': `---\nlang: bilingual\n---\n[[Main]] mutual link, but "bilingual" is not a language code.\n`,
  'Sketch.excalidraw.md': `---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data\n`,
  'Sketch.excalidraw.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  '.obsidian/appearance.json': JSON.stringify({ enabledCssSnippets: ['brochure'] }),
  '.obsidian/snippets/brochure.css': '.brochure { color: red; }',
  '.obsidian/snippets/disabled.css': '.nope {}',
};

let tmp, vault, out;
before(async () => {
  tmp = makeVault(FILES);
  vault = new Vault({ slug: 's', root: tmp.root });
  await vault.scan();
  out = await new Renderer().render(vault, 'Main.md');
});
after(() => tmp.rm());

test('block ids on paragraphs, list items and tables', () => {
  assert.match(out.html, /<p id="\^para1" dir="auto">A paragraph with an id\.<\/p>/);
  assert.match(out.html, /<li id="\^item2">item two<\/li>/);
  assert.match(out.html, /<table id="\^tbl" dir="auto">/);
  assert.ok(!out.html.includes('^tbl</p>'), 'bare ^id line is removed');
  assert.match(out.html, /<a href="\/s\/Other#%5Ep" class="internal-link">Other › \^p<\/a>/);
});

test('block transclusion embeds only the referenced block', () => {
  assert.match(out.html, /<div class="embed-note embed-block">.*<p dir="auto">The referenced block\.<\/p>/s);
  assert.ok(!out.html.includes('Intro line'));
  assert.equal(extractBlock('a\n\nb c ^x\n\nd', 'x'), 'b c');
  assert.equal(extractBlock('| t |\n|---|\n| 1 |\n\n^t', 't'), '| t |\n|---|\n| 1 |');
  assert.equal(extractBlock('nothing', 'zz'), null);
});

test('search text has no callout markers, block ids or footnote refs', () => {
  assert.ok(!/\[!|\^para1|\^item2|\[\^1\]/.test(out.text), out.text);
  assert.ok(out.text.includes('A paragraph with an id'));
});

test('footnotes render with backlinks', () => {
  assert.match(out.html, /<sup class="footnote-ref"><a href="#fn1"/);
  assert.match(out.html, /<section class="footnotes">.*The footnote text\./s);
});

test('math: inline, display, and currency left alone', () => {
  assert.ok(out.html.includes('<span class="math math-inline">E = mc^2</span>'));
  assert.match(out.html, /<div class="math math-block">\\int_0\^1 x\\,dx<\/div>/);
  assert.ok(out.html.includes('$5 and $6 are money'));
});

test('excalidraw: exported svg is used, missing export is a labelled placeholder, drawing note is hidden', () => {
  assert.match(out.html, /<img class="excalidraw" src="\/s\/Sketch\.excalidraw\.svg"/);
  assert.match(out.html, /<span class="embed excalidraw-missing"[^>]*>✎ Drawing: Missing\.excalidraw<\/span>/);
  assert.equal(vault.note('Sketch.excalidraw.md').hidden, true);
});

test('translations: explicit frontmatter and mutual-link heuristic, not one-way links', () => {
  const t = vault.translationsOf('Main.md');
  assert.deepEqual(t.map(x => [x.lang, x.rel]), [['ar', 'Arabic Edition.md'], ['fr', 'Rapport.md']]);
  assert.deepEqual(vault.translationsOf('Arabic Edition.md').map(x => x.rel), ['Main.md']);
  assert.deepEqual(vault.translationsOf('Unrelated.md'), []);
});

test('snippets: only Obsidian-enabled ones, and configurable', async () => {
  assert.deepEqual(vault.snippets.map(s => s.name), ['brochure']);
  const all = new Vault({ slug: 's', root: tmp.root, snippets: 'all' }); await all.scan();
  assert.deepEqual(all.snippets.map(s => s.name), ['brochure', 'disabled']);
  const none = new Vault({ slug: 's', root: tmp.root, snippets: false }); await none.scan();
  assert.deepEqual(none.snippets, []);
});

test('layout: cssclasses, snippet link, language switch, math assets, print button, seo tags', () => {
  const html = page({ vault, vaults: [vault], config: { publicUrl: 'https://d.example' }, rel: 'Main.md', title: 'Main', body: out.html, data: out.data, headings: out.headings });
  assert.match(html, /<html lang="en" dir="ltr" class="wide brochure">/);
  assert.match(html, /<article class="note markdown-body wide brochure"/);
  assert.ok(html.includes('href="/s/_snippets/brochure.css?v='));
  assert.match(html, /<nav class="lang-switch"[^>]*><span class="lang-current" lang="en">English<\/span><a href="\/s\/Arabic%20Edition" lang="ar" hreflang="ar"[^>]*>العربية<\/a><a href="\/s\/Rapport" lang="fr"/);
  assert.ok(html.includes('/_vendor/katex/katex.min.css') && html.includes('/_vendor/katex/katex.min.js'));
  assert.ok(html.includes('id="printBtn"'));
  assert.ok(html.includes('<link rel="canonical" href="https://d.example/s/Main">'));
  assert.ok(html.includes('<meta property="og:image" content="https://d.example/s/Sketch.excalidraw.svg">'));
  assert.ok(html.includes('<meta property="og:locale" content="en">'));
  const embed = page({ vault, vaults: [vault], rel: 'Main.md', title: 'Main', body: out.html, data: out.data, embed: true });
  assert.ok(embed.includes('href="/s/Rapport?embed=1"') && !embed.includes('id="printBtn"'));
});
