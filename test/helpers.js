'use strict';
// Builds a throw-away vault in the OS temp folder for tests.
const fs = require('fs');
const os = require('os');
const path = require('path');

function makeVault(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md2html-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return { root, rm: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// A 1x1 PNG so image resolution has a real file to find.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const FIXTURE = {
  'Home.md': `---
title: Home Page
tags: [a, b]
status: ready
---
# Home

See [[Second]], [[sub/Second|aliased]], [[Second#Part B]], [[Missing Note]] and [[Home]].

![[pic.png|120]] ![[Second#Part B]]

> [!tip]- Fold me
> Hidden **bold** text
> > [!warning] Nested
> > inner

> [!abstract]
> Default title

- [x] done task
- [ ] open task

==highlighted== and %%hidden comment%% end.

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`

\`\`\`js
const x = 1;
\`\`\`

| h1 | h2 |
|---|---|
| a | b |

Line one
Line two

See [../src/thing.py:42](../src/thing.py:42) and [ext](https://example.com) and Odoo.sh plain.
`,
  'sub/Second.md': `---
title: Second
---
# Second

## Part A
alpha [[Home]]

## Part B
bravo content
`,
  'sub/Draft.md': `---
title: Draft
status: draft
---
secret
`,
  'ar/عربي.md': `---
title: عربي
lang: ar
---
# مرحبا
[[Home]]
`,
  'img/pic.png': PNG,
  '.obsidian/app.json': '{}',
};

module.exports = { makeVault, FIXTURE };
