// The docs/ vault is the project's living reference (see CLAUDE.md). A [[wikilink]]
// that points at nothing is a broken page on the documentation site, so check them
// the same way the vault index resolves links: by basename, case-insensitively.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DOCS = path.join(__dirname, '..', 'docs');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(DOCS);
const notes = files.filter((f) => f.endsWith('.md'));
const rel = (f) => path.relative(DOCS, f).replace(/\\/g, '/');

// What a [[target]] may resolve to: a note by basename, or any file by name
// (attachments are embedded as ![[shot.png]]).
const targets = new Set();
for (const f of files) {
  const name = path.basename(f);
  targets.add(name.toLowerCase());
  targets.add(name.replace(/\.md$/, '').toLowerCase());
  targets.add(rel(f).toLowerCase());
  targets.add(rel(f).replace(/\.md$/, '').toLowerCase());
}
for (const f of notes) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(f, 'utf8'));
  if (!fm) continue;
  const aliases = /^aliases:\s*\[(.*?)\]/m.exec(fm[1]);
  if (!aliases) continue;
  for (const a of aliases[1].split(',')) {
    const v = a.trim().replace(/^["']|["']$/g, '');
    if (v) targets.add(v.toLowerCase());
  }
}

// [[target]], [[target|label]], [[target#heading]], ![[embed]]. Skip [[#local heading]].
const LINK = /!?\[\[([^\]\n]+)\]\]/g;

// Notes about wikilink syntax write [[Note]] inside code, and that is not a link.
function withoutCode(body) {
  return body.replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '');
}

test('every [[wikilink]] in docs/ points at an existing note or file', () => {
  const broken = [];
  for (const f of notes) {
    const body = withoutCode(fs.readFileSync(f, 'utf8'));
    for (const m of body.matchAll(LINK)) {
      const raw = m[1].split('|')[0].trim();
      const target = raw.split('#')[0].trim();
      if (!target) continue; // [[#heading]] — same note
      if (!targets.has(target.toLowerCase())) {
        broken.push(`${rel(f)} → [[${raw}]]`);
      }
    }
  }
  assert.deepStrictEqual(broken, [], `broken wikilinks:\n  ${broken.join('\n  ')}`);
});

test('every note embedded as an image exists in docs/attachments', () => {
  const missing = [];
  for (const f of notes) {
    const body = withoutCode(fs.readFileSync(f, 'utf8'));
    for (const m of body.matchAll(/!\[\[([^\]|#]+\.(?:png|jpg|jpeg|gif|svg|webp))/gi)) {
      const name = m[1].trim();
      if (!fs.existsSync(path.join(DOCS, 'attachments', name))) missing.push(`${rel(f)} → ${name}`);
    }
  }
  assert.deepStrictEqual(missing, [], `missing screenshots:\n  ${missing.join('\n  ')}`);
});

test('every note has title, tags and updated in its frontmatter', () => {
  const bad = [];
  for (const f of notes) {
    const fm = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(f, 'utf8'));
    if (!fm) { bad.push(`${rel(f)} — no frontmatter`); continue; }
    for (const key of ['title', 'tags', 'updated']) {
      if (!new RegExp(`^${key}:`, 'm').test(fm[1])) bad.push(`${rel(f)} — no ${key}:`);
    }
  }
  assert.deepStrictEqual(bad, [], `frontmatter problems:\n  ${bad.join('\n  ')}`);
});
