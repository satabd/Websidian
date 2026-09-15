'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeVault } = require('./helpers');
const { Vault } = require('../src/vault');
const { renderBase, parse, evaluate, tokenize } = require('../src/bases');

const FILES = {
  'docs/A.md': '---\ntitle: Alpha\nstatus: ready\nlang: en\ntags: [hms, demo]\nsection: overview\nduration: 5\n---\n# A\n',
  'docs/B.md': '---\ntitle: Beta\nstatus: review\nlang: ar\ntags: [hms]\nsection: training\n---\n# B\n',
  'docs/C.md': '---\ntitle: Gamma\nstatus: ready\nlang: bilingual\nsection: overview\n---\n# C\n',
  'elsewhere/D.md': '---\ntitle: Delta\nstatus: ready\n---\n# D\n',
  'Catalogue.base': `filters:
  and:
    - file.inFolder("docs")
    - file.ext == "md"
formulas:
  ready: if(status == "ready", "✅", if(status == "review", "👀", "✏️"))
  language: if(lang == "ar", "العربية", if(lang == "bilingual", "EN + AR", "English"))
properties:
  formula.language:
    displayName: Language
  section:
    displayName: Section
views:
  - type: table
    name: Everything
    groupBy:
      property: section
      direction: ASC
    order:
      - formula.ready
      - file.name
      - section
      - formula.language
      - status
      - tags
  - type: table
    name: Ready only
    filters:
      and:
        - status == "ready"
        - '!file.hasTag("demo")'
    order:
      - file.name
      - formula.ready
    sort:
      - property: file.name
        direction: DESC
  - type: cards
    name: Ignored
`,
};

let tmp, vault;
before(async () => { tmp = makeVault(FILES); vault = new Vault({ slug: 's', root: tmp.root }); await vault.scan(); });
after(() => tmp.rm());

test('expression parser and evaluator', () => {
  const ctx = { vault, note: vault.note('docs/A.md'), formula: () => undefined };
  const ev = src => evaluate(parse(src), ctx);
  assert.equal(ev('status == "ready"'), true);
  assert.equal(ev('status != "ready"'), false);
  assert.equal(ev('if(status == "ready", "yes", "no")'), 'yes');
  assert.equal(ev('if(lang == "ar", "A", if(lang == "bilingual", "B", "C"))'), 'C');
  assert.equal(ev('file.inFolder("docs")'), true);
  assert.equal(ev('file.inFolder("elsewhere")'), false);
  assert.equal(ev('file.hasTag("demo")'), true);
  assert.equal(ev('!file.hasTag("nope")'), true);
  assert.equal(ev('tags.contains("hms") && duration > 3'), true);
  assert.equal(ev('file.name + " (" + status + ")"'), 'A (ready)');
  assert.equal(ev('file.ext == "md"'), true);
  assert.equal(ev('missing'), undefined);
  assert.throws(() => parse('if(('), /Unexpected|Expected/);
  assert.deepEqual(tokenize('a == "x y"').map(t => t.v), ['a', '==', 'x y']);
});

test('table views render with filters, formulas, groups, labels and sort', () => {
  const html = renderBase(vault, FILES['Catalogue.base'], { baseName: 'Catalogue' });
  assert.equal((html.match(/<div class="base-view"/g) || []).length, 2, 'cards view ignored');
  assert.match(html, /<button type="button" class="base-tab is-active" data-tab="0">Everything <span class="muted">3<\/span>/);
  assert.match(html, /<th>ready<\/th><th>Name<\/th><th>Section<\/th><th>Language<\/th><th>status<\/th><th>tags<\/th>/);
  assert.match(html, /<tr class="base-group"><th colspan="6">overview <span class="muted">\(2\)<\/span>/);
  assert.match(html, /<a href="\/s\/docs\/A">A<\/a><\/td><td>overview<\/td><td>English<\/td><td>ready<\/td><td><span class="chip">hms<\/span> <span class="chip">demo<\/span>/);
  assert.match(html, /<td>👀<\/td><td><a href="\/s\/docs\/B">B<\/a>/);
  assert.match(html, /<td>EN \+ AR<\/td>/);
  assert.ok(!html.includes('Delta') && !html.includes('/s/elsewhere/D'), 'base filter excludes other folders');
  // second view: ready and not tagged demo -> C only (A has demo), sorted desc
  const second = html.slice(html.indexOf('data-view="1"'));
  assert.ok(second.includes('/s/docs/C') && !second.includes('/s/docs/A') && !second.includes('/s/docs/B'));
});

test('broken base yields a readable error, not a crash', () => {
  const html = renderBase(vault, 'formulas:\n  x: if((\nviews:\n  - type: table\n', {});
  assert.match(html, /callout-danger.*Base could not be read/s);
});
