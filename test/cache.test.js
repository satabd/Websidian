'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RenderCache } = require('../src/cache');

test('memory cache: hit on same stamp, miss on changed stamp or dep', async () => {
  const c = new RenderCache({ enabled: false });
  await c.set('s', 'a.md', { stamp: '1', html: 'x', deps: [{ rel: 'b.md', stamp: '9' }] });
  const ok = async deps => deps.every(d => d.stamp === '9');
  const bad = async () => false;
  assert.equal((await c.get('s', 'a.md', '1', ok)).html, 'x');
  assert.equal(await c.get('s', 'a.md', '2', ok), null);
  assert.equal(await c.get('s', 'a.md', '1', bad), null);
  assert.deepEqual(c.stats, { hits: 1, diskHits: 0, misses: 2, renders: 1, evictions: 0 });
});

test('disk cache survives a new instance', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2html-cache-'));
  try {
    const c1 = new RenderCache({ dir });
    await c1.set('s', 'sub/a.md', { stamp: '1', html: 'persisted', deps: [] });
    const c2 = new RenderCache({ dir });
    const hit = await c2.get('s', 'sub/a.md', '1', async () => true);
    assert.equal(hit.html, 'persisted');
    assert.equal(c2.stats.diskHits, 1);
    assert.equal(c2.size(), 1, 'promoted to memory');
    assert.equal(await c2.get('s', 'sub/a.md', '2', async () => true), null, 'stale stamp is a miss');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
