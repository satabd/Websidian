// The browser-side Control UI plugin: the shape OpenClaw's loader checks for, what it registers, and
// the manifest rules the Gateway applies to the files it serves.
//
// The loader does exactly this (openclaw/dist/control-ui/assets/control-ui-loader-*.js):
//   const module = await import(entryUrl);
//   if (module.default?.id !== pluginId || typeof module.default.activate !== 'function') throw …
//   const disposer = await module.default.activate(host);
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import entry, { activate, PAGE_ID } from '../dist/control-ui/websidian.js';
import { shellUrl, themeFromColour } from '../dist/control-ui/memory-page.js';
import { MEMORY_PAGE_ID, MEMORY_PREFIX } from '../lib/sites.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, '..', 'openclaw.plugin.json'), 'utf8'));

// The Gateway's own rules, copied from dist/manifest-*.mjs (normalizeManifestControlUi) and
// dist/control-ui-assets-*.mjs (readPluginControlUiAssets).
const ENTRY_RE = /^dist\/(?:[\w-][\w.-]*\/)+[\w-][\w.-]*\.m?js$/u;
const ASSET_RE = /^(?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.(?:m?js|css)$/u;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_BUILD_BYTES = 8 * 1024 * 1024;

describe('the manifest declares assets the Gateway will serve', () => {
  test('the entry is a JavaScript file in a dedicated dist subdirectory', () => {
    assert.ok(manifest.controlUi, 'openclaw.plugin.json has a controlUi declaration');
    assert.match(manifest.controlUi.entry, ENTRY_RE);
    assert.ok(Array.isArray(manifest.controlUi.styles) && manifest.controlUi.styles.length <= 16);
  });

  test('the styles live under the entry directory', () => {
    const dir = path.posix.dirname(manifest.controlUi.entry);
    for (const style of manifest.controlUi.styles) {
      assert.ok(style.startsWith(dir + '/'), style);
      assert.match(style, /^(?:[\w-][\w.-]*\/)+[\w-][\w.-]*\.css$/u);
    }
  });

  test('every declared file is on disk, and the directory fits the byte limits', () => {
    const dir = path.posix.dirname(manifest.controlUi.entry);
    const abs = path.join(here, '..', ...dir.split('/'));
    let total = 0;
    const names = [];
    for (const name of fs.readdirSync(abs)) {
      const stat = fs.statSync(path.join(abs, name));
      if (!stat.isFile()) continue;
      // The Gateway serves exactly the .js/.mjs/.css files it finds here and ignores the rest.
      if (!ASSET_RE.test(name)) continue;
      names.push(name);
      total += stat.size;
      assert.ok(stat.size <= MAX_ASSET_BYTES, `${name} is over the 4 MiB per-asset limit`);
    }
    assert.ok(total <= MAX_BUILD_BYTES, 'the browser build is over the 8 MiB limit');
    for (const declared of [manifest.controlUi.entry, ...manifest.controlUi.styles]) {
      assert.ok(names.includes(path.posix.basename(declared)), `${declared} is declared but not served`);
    }
  });

  test('every JavaScript file the Gateway serves imports cleanly', async () => {
    const dir = path.join(here, '..', ...path.posix.dirname(manifest.controlUi.entry).split('/'));
    const names = fs.readdirSync(dir).filter(n => /\.m?js$/.test(n));
    assert.ok(names.length >= 2, 'the entry and the page');
    for (const name of names) {
      await assert.doesNotReject(() => import(pathToFileURL(path.join(dir, name)).href), name);
    }
  });
});

describe('the browser entry', () => {
  test('exports the shape the loader checks for, with the manifest id', () => {
    assert.equal(entry.id, manifest.id);
    assert.equal(typeof entry.activate, 'function');
  });

  test('registers the Memory page and navigation under the backend tab id', () => {
    const calls = { pages: [], navigation: [] };
    const disposed = [];
    const host = {
      ui: {
        registerPage(page) { calls.pages.push(page); return () => disposed.push('page'); },
        registerNavigation(item) { calls.navigation.push(item); return () => disposed.push('nav'); },
      },
    };
    const dispose = activate(host);
    assert.equal(calls.pages.length, 1);
    assert.equal(calls.pages[0].id, PAGE_ID);
    assert.equal(typeof calls.pages[0].mount, 'function');
    assert.equal(calls.navigation.length, 1);
    assert.deepEqual(calls.navigation[0].page, { id: PAGE_ID });
    assert.equal(calls.navigation[0].icon, 'brain');
    // The same id on both sides is what lets the native page take over the backend's sidebar tab.
    assert.equal(PAGE_ID, MEMORY_PAGE_ID);
    assert.equal(typeof dispose, 'function');
    dispose();
    assert.deepEqual(disposed, ['nav', 'page'], 'disposers run in reverse');
  });

  test('a host without registerNavigation still gets the page', () => {
    const pages = [];
    const dispose = activate({ ui: { registerPage(page) { pages.push(page); } } });
    assert.equal(pages.length, 1);
    assert.doesNotThrow(() => dispose(), 'a host that returns no disposer is fine');
  });

  test('the route it fetches is the one the backend registers', () => {
    const source = fs.readFileSync(path.join(here, '..', 'dist', 'control-ui', 'memory-page.js'), 'utf8');
    assert.ok(source.includes(`'${MEMORY_PREFIX}'`), 'the page and the route agree on the path');
  });
});

describe('page helpers', () => {
  test('notes always open in shell mode, with the host theme when there is one', () => {
    assert.equal(shellUrl('/w/x/Note', 'dark'), '/w/x/Note?shell=1&theme=dark');
    assert.equal(shellUrl('/w/x/Note', ''), '/w/x/Note?shell=1');
    assert.equal(shellUrl('/w/x/_graph?focus=a', 'light'), '/w/x/_graph?focus=a&shell=1&theme=light');
    assert.equal(shellUrl('', 'dark'), '');
  });

  test('the theme is read off the surface the host painted', () => {
    assert.equal(themeFromColour('rgb(13, 17, 23)'), 'dark');
    assert.equal(themeFromColour('rgb(255, 255, 255)'), 'light');
    assert.equal(themeFromColour('rgba(0, 0, 0, 0)'), '', 'transparent says nothing');
    assert.equal(themeFromColour('transparent'), '');
    assert.equal(themeFromColour(''), '');
  });
});
