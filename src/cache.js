'use strict';
// Render cache. An entry is valid while the note's own stamp (mtime+size) and
// the stamps of every note it transcludes are unchanged, and the vault's file
// list hash (which affects wikilink resolution) is the same.
//
// Layer 1: in-memory Map with an LRU cap (sub-millisecond hits).
// Layer 2: JSON files on disk, so a restart does not re-render everything and
//          entries evicted from memory can come back without a re-render.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

class RenderCache {
  constructor({ dir, enabled = true, maxEntries = 2000 } = {}) {
    this.dir = dir; this.disk = enabled && !!dir;
    this.maxEntries = Math.max(1, maxEntries | 0);
    this.mem = new Map();
    this.stats = { hits: 0, diskHits: 0, misses: 0, renders: 0, evictions: 0 };
    if (this.disk) fs.mkdirSync(dir, { recursive: true });
  }

  _key(site, rel) { return site + ':' + rel; }
  _diskPath(site, rel) {
    return path.join(this.dir, site, crypto.createHash('sha1').update(rel).digest('hex') + '.json');
  }
  _touch(key, entry) {
    // Map keeps insertion order: delete + set moves the key to the "most recent" end.
    this.mem.delete(key); this.mem.set(key, entry);
    while (this.mem.size > this.maxEntries) { this.mem.delete(this.mem.keys().next().value); this.stats.evictions++; }
  }

  async get(site, rel, stamp, validateDeps) {
    const key = this._key(site, rel);
    let entry = this.mem.get(key);
    let fromDisk = false;
    if (!entry && this.disk) {
      try { entry = JSON.parse(await fsp.readFile(this._diskPath(site, rel), 'utf8')); fromDisk = true; } catch { entry = null; }
    }
    if (entry && entry.stamp === stamp && await validateDeps(entry.deps || [])) {
      this._touch(key, entry);
      if (fromDisk) this.stats.diskHits++; else this.stats.hits++;
      return entry;
    }
    this.stats.misses++;
    return null;
  }

  async set(site, rel, entry) {
    this.stats.renders++;
    this._touch(this._key(site, rel), entry);
    if (this.disk) {
      const p = this._diskPath(site, rel);
      try { await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, JSON.stringify(entry)); } catch (e) { console.warn('cache write failed:', e.message); }
    }
  }

  // Drop everything (memory and disk). Used by the purge endpoint.
  async clear(site) {
    for (const k of [...this.mem.keys()]) if (!site || k.startsWith(site + ':')) this.mem.delete(k);
    if (this.disk) {
      const target = site ? path.join(this.dir, site) : this.dir;
      await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
      await fsp.mkdir(this.dir, { recursive: true }).catch(() => {});
    }
  }

  size() { return this.mem.size; }
}

module.exports = { RenderCache };
