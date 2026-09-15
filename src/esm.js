'use strict';
// Browser ES modules straight from node_modules, without a bundler.
//
// The editor is built on CodeMirror 6, which ships as ES modules that import
// each other by bare name ("@codemirror/state"). Browsers resolve bare names
// through an import map, so instead of a build step the server:
//   1. walks the dependency graph from a few root packages (package.json only),
//   2. serves each package's single ESM entry file at /_vendor/esm/<name>@<version>.js
//      (versioned URL, so it can be cached as immutable),
//   3. emits the import map that points every bare name at that URL.
// Our own editor modules (public/cm/*.js) are added to the same map ("ws/<name>"
// and their own URL), versioned by file mtime so an edit is picked up without
// bumping LAYOUT_VERSION.
// Keeps decision E of the roadmap: one Node process, nothing to build.

const fs = require('fs');
const path = require('path');

const ROOTS = [
  '@codemirror/state', '@codemirror/view', '@codemirror/commands', '@codemirror/language',
  '@codemirror/lang-markdown', '@codemirror/autocomplete', '@codemirror/search',
  '@lezer/markdown', '@lezer/highlight', '@lezer/common',
  // Languages for fenced code blocks (loaded lazily by the editor).
  '@codemirror/lang-javascript', '@codemirror/lang-css', '@codemirror/lang-html', '@codemirror/lang-json',
  '@codemirror/lang-python', '@codemirror/lang-yaml', '@codemirror/lang-sql', '@codemirror/lang-xml',
];

function entryOf(pkg) {
  const exp = pkg.exports && (pkg.exports['.'] || pkg.exports);
  const pick = v => (typeof v === 'string' ? v : v && (v.import || v.default || v.browser));
  const e = pkg.module || (exp && (typeof exp === 'string' ? exp : pick(exp.import) || pick(exp.default) || pick(exp.browser))) || pkg.main;
  return typeof e === 'string' ? e : null;
}

// { name -> { version, file (absolute), url } } for ROOTS and all their dependencies.
function buildPackages(nodeModules, roots = ROOTS) {
  const out = new Map();
  const visit = (name) => {
    if (out.has(name)) return;
    const dir = path.join(nodeModules, ...name.split('/'));
    let pkg; try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return; }
    const entry = entryOf(pkg); if (!entry) return;
    const file = path.resolve(dir, entry);
    if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) return;
    out.set(name, { version: pkg.version, file });
    for (const dep of Object.keys(pkg.dependencies || {})) visit(dep);
  };
  for (const r of roots) visit(r);
  return out;
}

function createEsm({ root }) {
  const nodeModules = path.join(root, 'node_modules');
  const cmDir = path.join(root, 'public', 'cm');
  const packages = buildPackages(nodeModules);
  const byUrlName = new Map([...packages].map(([name, p]) => [`${name}@${p.version}.js`, p.file]));

  // Our own modules: "ws/<name>" -> _static/cm/<name>.js?v=<mtime>. Stat on each call
  // (a handful of files, editor page only) so edits never hide behind the 7-day cache.
  function ownModules() {
    let files = []; try { files = fs.readdirSync(cmDir).filter(f => f.endsWith('.js')); } catch { /* none */ }
    return files.map(f => { let v = 0; try { v = Math.floor(fs.statSync(path.join(cmDir, f)).mtimeMs); } catch { /* ignore */ } return [f.slice(0, -3), v.toString(36)]; });
  }

  function importMap(assets) {
    const imports = {};
    for (const [name, p] of packages) imports[name] = `${assets}/_vendor/esm/${name}@${p.version}.js`;
    // The modules import each other relatively ("./syntax.js"); import maps also remap such
    // URLs, which is how they get their ?v= without the code knowing about it (and Node,
    // which ignores the map, can import them as they are for the tests).
    for (const [name, v] of ownModules()) {
      const url = `${assets}/_static/cm/${name}.js`;
      imports[url] = imports[`ws/${name}`] = `${url}?v=${v}`;
    }
    return { imports };
  }

  // Express handler for /_vendor/esm/<name>@<version>.js; only the files in the map.
  function handler(req, res, next) {
    const key = decodeURIComponent(req.path.replace(/^\/+/, ''));
    const file = byUrlName.get(key);
    if (!file) return next();
    res.type('application/javascript');
    // `root` so the dotfile check covers only the file name: an install under e.g. ~/.hermes must still work.
    res.sendFile(path.basename(file), { root: path.dirname(file), maxAge: '365d', immutable: true, dotfiles: 'deny' }, err => { if (err) next(err); });
  }

  return { packages, importMap, handler };
}

module.exports = { createEsm, buildPackages, entryOf, ROOTS };
