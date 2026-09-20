import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Settings, evaluate, findActiveContent, newActiveContent, parsePatch, writtenPaths, htmlUnescape, settingsFromConfig, checkShellCommand } from '../lib/guard.js';
import { uiSettings } from '../lib/sites.js';

let tmp, vault, state, workspace;
const settings = (extra = {}) => new Settings({ vaults: [{ path: vault }], roots: [state, workspace], ui: uiSettings({}, {}), ...extra });

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-guard-'));
  vault = path.join(tmp, 'vault');
  state = path.join(tmp, 'state');
  workspace = path.join(tmp, 'workspace');
  for (const d of [vault, state, workspace, path.join(vault, 'Sub'), path.join(state, 'skills', 'x')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(vault, 'Existing.md'), '# Existing\n\nplain <b>bold</b>\n');
  fs.writeFileSync(path.join(vault, 'HasScript.md'), '# Has\n\n<script>old()</script>\n');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('protected instruction files', () => {
  test('in the state dir, the workspace and the vault (case-insensitive)', () => {
    for (const p of [path.join(state, 'skills', 'x', 'SKILL.md'), path.join(workspace, 'soul.md'), path.join(vault, 'Sub', 'Agents.MD')]) {
      const d = evaluate('write', { path: p, content: 'x' }, settings());
      assert.equal(d.action, 'approve', p);
      assert.match(d.message, /agent instruction file/);
      assert.match(d.ruleKey, /^websidian:protect:/);
    }
  });
  test('relative paths resolve against the workspace base', () => {
    const d = evaluate('write', { path: 'SOUL.md', content: 'x' }, settings(), { base: workspace });
    assert.equal(d.action, 'approve');
    assert.equal(evaluate('write', { path: 'SOUL.md', content: 'x' }, settings(), { base: tmp }), null);
  });
  test('outside every root: not protected; unprotected names in a root: allowed', () => {
    assert.equal(evaluate('write', { path: path.join(tmp, 'elsewhere', 'SOUL.md'), content: 'x' }, settings()), null);
    assert.equal(evaluate('write', { path: path.join(workspace, 'notes.md'), content: 'x' }, settings()), null);
  });
  test('block mode', () => {
    const d = evaluate('write', { path: path.join(workspace, 'AGENTS.md'), content: 'x' }, settings({ protectMode: 'block' }));
    assert.equal(d.action, 'block');
    assert.match(d.message, /blocked/);
  });
  test('custom glob patterns', () => {
    const s = settings({ protect: ['*.rules', 'PLAN-?.md'] });
    assert.equal(evaluate('write', { path: path.join(workspace, 'x.rules'), content: '' }, s).action, 'approve');
    assert.equal(evaluate('write', { path: path.join(workspace, 'PLAN-1.md'), content: '' }, s).action, 'approve');
    assert.equal(evaluate('write', { path: path.join(workspace, 'SOUL.md'), content: '' }, s), null);
  });
  test('edit and apply_patch (including Move to) are covered', () => {
    assert.equal(evaluate('edit', { path: path.join(vault, 'SKILL.md'), edits: [{ oldText: 'a', newText: 'b' }] }, settings()).action, 'approve');
    const patch = `*** Begin Patch\n*** Update File: ${path.join(vault, 'Existing.md')}\n*** Move to: ${path.join(vault, 'AGENTS.md')}\n@@\n-x\n+y\n*** End Patch`;
    assert.equal(evaluate('apply_patch', { input: patch }, settings()).action, 'approve');
  });
  test('a symlink into a protected root is caught', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, () => {
    const link = path.join(tmp, 'link');
    fs.symlinkSync(workspace, link, 'dir');
    assert.equal(evaluate('write', { path: path.join(link, 'SOUL.md'), content: 'x' }, settings()).action, 'approve');
  });
  test('a link into a protected root is caught even when the file does not exist yet', () => {
    // fs.realpathSync throws unless the whole path exists, so a new file used to be judged by its
    // unresolved spelling and slipped the guard. Junctions work without privileges on Windows.
    const link = path.join(tmp, 'link2');
    try {
      if (process.platform === 'win32') execFileSync('cmd', ['/c', 'mklink', '/J', link, workspace], { stdio: 'ignore' });
      else fs.symlinkSync(workspace, link, 'dir');
    } catch { return; } // no privilege to make one: nothing to assert
    const through = path.join(link, 'SOUL.md');
    assert.ok(!fs.existsSync(through), 'the target must not exist for this test to mean anything');
    assert.equal(evaluate('write', { path: through, content: 'x' }, settings()).action, 'approve');
    // and the same for a vault write that would land inside the vault through the link
    const vaultLink = path.join(tmp, 'vlink');
    try {
      if (process.platform === 'win32') execFileSync('cmd', ['/c', 'mklink', '/J', vaultLink, vault], { stdio: 'ignore' });
      else fs.symlinkSync(vault, vaultLink, 'dir');
    } catch { return; }
    assert.equal(evaluate('write', { path: path.join(vaultLink, 'New.md'), content: '<script>x</script>' }, settings()).action, 'block');
  });
});

describe('active content', () => {
  test('true positives', () => {
    const bad = ['<script>x</script>', '<img src=x onerror=alert(1)>', '[x](javascript:alert(1))', '[x](&#106;avascript:alert(1))',
      '<iframe src=x>', '<a href="data:text/html;base64,x">', 'text `a` [[link]] `<script>`', '```\n<script>', '<div\nonclick=1>', '<A HREF="VBSCRIPT:x">'];
    for (const t of bad) assert.ok(findActiveContent(t).length, JSON.stringify(t));
  });
  test('true negatives (code spans, fences, callouts, math, frontmatter, entities)', () => {
    const good = ['`<script>`', '```\n<script>\n```', '> [!note] `<iframe>`', '- [ ] `<iframe>`', '---\ntitle: x\n---\n# ok',
      '&lt;script&gt;', 'plain <b>bold</b> and <a href="https://x">link</a>', 'onclick=1 outside a tag', '~~~\n<script>\n~~~'];
    for (const t of good) assert.deepEqual(findActiveContent(t), [], JSON.stringify(t));
  });
  test('HTML comments and math blocks are scanned, not masked', () => {
    assert.deepEqual(findActiveContent('<!-- <script> -->'), ['<script> tag']);
    assert.deepEqual(findActiveContent('$$\n<script>\n$$'), ['<script> tag']);
  });
  test('an unclosed fence is scanned; an indented fence too', () => {
    assert.ok(findActiveContent('```\n<script>').length);
    assert.ok(findActiveContent('  ```\n<script>\n  ```').length);
  });
  test('only newly introduced findings count for a patch', () => {
    assert.deepEqual(newActiveContent('<script>a</script>', '<script>a</script>\nmore'), []);
    assert.deepEqual(newActiveContent('<script>a</script>', '<script>a</script><script>b</script>'), ['<script> tag']);
  });
  test('large documents are fast', () => {
    const big = ('para `code` text\n\n').repeat(60_000) + '<img onerror=1>';
    const t0 = Date.now();
    assert.ok(findActiveContent(big).length);
    assert.ok(Date.now() - t0 < 5000);
  });
  test('htmlUnescape handles numeric, named and legacy forms', () => {
    assert.equal(htmlUnescape('&#106;&#x61;&colon;&lt;&ltx&amp;#106;'), 'ja:<<x&#106;');
    assert.equal(htmlUnescape('&bogus;'), '&bogus;');
  });
});

describe('vault writes', () => {
  test('block an active note, allow a plain one, allow active content outside the vault', () => {
    const s = settings();
    assert.equal(evaluate('write', { path: path.join(vault, 'A.md'), content: '<script>x</script>' }, s).action, 'block');
    assert.equal(evaluate('write', { path: path.join(vault, 'A.md'), content: '# fine\n`<script>`' }, s), null);
    assert.equal(evaluate('write', { path: path.join(tmp, 'A.md'), content: '<script>x</script>' }, s), null);
  });
  test('blocked extensions', () => {
    for (const name of ['x.html', 'x.HTM', 'x.svg', 'x.js', 'x.mjs', 'x.xml', 'x.xhtml']) {
      assert.equal(evaluate('write', { path: path.join(vault, name), content: 'x' }, settings()).action, 'block', name);
    }
    assert.equal(evaluate('write', { path: path.join(vault, 'x.png'), content: 'x' }, settings()), null);
  });
  test('blockActiveContent: false switches the rule off (protection stays)', () => {
    const s = settings({ blockActiveContent: false });
    assert.equal(evaluate('write', { path: path.join(vault, 'A.md'), content: '<script>x</script>' }, s), null);
    assert.equal(evaluate('write', { path: path.join(vault, 'SOUL.md'), content: 'x' }, s).action, 'approve');
  });
  test('edit: the resulting file is checked, a spliced tag is caught, existing HTML untouched passes', () => {
    const existing = path.join(vault, 'Existing.md');
    assert.equal(evaluate('edit', { path: existing, edits: [{ oldText: 'plain', newText: '<scr' }, { oldText: 'bold</b>', newText: 'ipt>x</script>' }] }, settings()).action, 'block');
    assert.equal(evaluate('edit', { path: existing, edits: [{ oldText: 'plain', newText: 'simple' }] }, settings()), null);
    const hasScript = path.join(vault, 'HasScript.md');
    assert.equal(evaluate('edit', { path: hasScript, edits: [{ oldText: '# Has', newText: '# Still has' }] }, settings()), null);
    assert.equal(evaluate('edit', { path: hasScript, edits: [{ oldText: '# Has', newText: '# Has <iframe>' }] }, settings()).action, 'block');
    // oldText not found: the fragments are checked on their own
    assert.equal(evaluate('edit', { path: existing, edits: [{ oldText: 'nope', newText: '<script>' }] }, settings()).action, 'block');
  });
  test('edit: a payload split across edits is caught even when the simulation cannot run', () => {
    const existing = path.join(vault, 'Existing.md');
    // A decoy oldText that is not in the file used to send every newText through the per-fragment check,
    // where "<scr" and "ipt>..." are each clean on their own.
    const split = evaluate('edit', {
      path: existing,
      edits: [{ oldText: 'plain', newText: '<scr' }, { oldText: 'bold</b>', newText: 'ipt>evil()</script>' }, { oldText: 'NOT_IN_FILE', newText: '' }],
    }, settings());
    assert.equal(split.action, 'block');
    // The same when one oldText is consumed twice (the second replacement would be a no-op).
    const twice = evaluate('edit', {
      path: existing,
      edits: [{ oldText: 'plain', newText: 'clean' }, { oldText: 'plain', newText: '<script>evil()</script>' }],
    }, settings());
    assert.equal(twice.action, 'block');
    // Genuinely clean multi-edit calls still pass.
    assert.equal(evaluate('edit', { path: existing, edits: [{ oldText: 'plain', newText: 'simple' }, { oldText: 'NOT_IN_FILE', newText: 'also fine' }] }, settings()), null);
  });
  test('apply_patch: added lines are checked per file, deletes pass', () => {
    const add = `*** Begin Patch\n*** Add File: ${path.join(vault, 'New.md')}\n+# New\n+<img src=x onerror=1>\n*** End Patch`;
    assert.equal(evaluate('apply_patch', { input: add }, settings()).action, 'block');
    const del = `*** Begin Patch\n*** Delete File: ${path.join(vault, 'Existing.md')}\n*** End Patch`;
    assert.equal(evaluate('apply_patch', { input: del }, settings()), null);
    const ok = `*** Begin Patch\n*** Add File: ${path.join(vault, 'New.md')}\n+# New\n+plain\n*** End Patch`;
    assert.equal(evaluate('apply_patch', { input: ok }, settings()), null);
  });
  test('parsePatch and writtenPaths', () => {
    const input = '*** Begin Patch\n*** Add File: a.md\n+one\n+two\n*** Update File: b.md\n*** Move to: c.md\n@@\n-x\n+y\n*** Delete File: d.md\n*** End Patch';
    const ops = parsePatch(input);
    assert.deepEqual(ops.map(o => [o.op, o.path, o.newPath, o.added]), [['add', 'a.md', null, 'one\ntwo'], ['update', 'b.md', 'c.md', 'y'], ['delete', 'd.md', null, '']]);
    assert.deepEqual(writtenPaths('apply_patch', { input }), ['a.md', 'c.md']);
    assert.deepEqual(writtenPaths('write', { path: 'x.md', content: '' }), ['x.md']);
    assert.deepEqual(writtenPaths('edit', { path: 'x.md', edits: [] }), ['x.md']);
    assert.deepEqual(writtenPaths('exec', { command: 'x' }), []);
    assert.deepEqual(writtenPaths('write', null), []);
  });
});

describe('shell commands (exec)', () => {
  test('redirect near a protected file, sed into the vault, cp with forward slashes, workdir inside the vault', () => {
    const s = settings();
    assert.equal(checkShellCommand('echo x > SOUL.md', s).action, 'approve');
    assert.equal(checkShellCommand(`sed -i s/a/b/ ${path.join(vault, 'x.md')}`, s).action, 'approve');
    assert.equal(checkShellCommand(`cp a.md ${vault.replace(/\\/g, '/')}/b.md`, s).action, 'approve');
    assert.equal(evaluate('exec', { command: 'echo x > y.md', workdir: vault }, s).action, 'approve');
  });
  test('read-only commands and writes elsewhere pass; block mode blocks', () => {
    const s = settings();
    assert.equal(checkShellCommand(`cat ${path.join(vault, 'x.md')}`, s), null);
    assert.equal(checkShellCommand('echo x > /tmp/other.txt', s), null);
    assert.equal(checkShellCommand('echo x > SOUL.md', settings({ protectMode: 'block' })).action, 'block');
  });
});

describe('settings', () => {
  test('from plugin config and the Gateway config', () => {
    const s = settingsFromConfig(
      { vaults: [{ path: vault, edit: true }], protect: ['X.md'], protectMode: 'block', appendLinks: false, ui: { port: 9000, publicBase: 'https://g.example/oc' } },
      { agents: { defaults: { workspace: workspace } }, gateway: { port: 18789 } },
      { OPENCLAW_STATE_DIR: state },
    );
    assert.deepEqual(s.protect, ['X.md']);
    assert.equal(s.protectMode, 'block');
    assert.equal(s.appendLinks, false);
    assert.equal(s.ui.port, 9000);
    assert.equal(s.vaults[0].url, 'https://g.example/oc/plugins/websidian/w/vault/');
    assert.equal(s.vaults[0].edit, true);
    assert.ok(s.roots.some(r => r.toLowerCase() === path.resolve(state).toLowerCase()));
    assert.ok(s.roots.some(r => r.toLowerCase() === path.resolve(workspace).toLowerCase()));
  });
  test('defaults', () => {
    const s = settingsFromConfig({}, {}, { OPENCLAW_STATE_DIR: state });
    assert.equal(s.protectMode, 'approve');
    assert.equal(s.blockActiveContent, true);
    assert.equal(s.protect.length, 9);
    assert.equal(s.ui.publicBase, 'http://127.0.0.1:18789');
    assert.equal(s.ui.enabled, true);
    assert.deepEqual(s.vaults, []);
  });
  test('unknown tools and malformed params fail open', () => {
    assert.equal(evaluate('read', { path: path.join(vault, 'SOUL.md') }, settings()), null);
    assert.equal(evaluate('write', 'not an object', settings()), null);
    assert.equal(evaluate('write', { content: 'x' }, settings()), null);
  });
});
