#!/usr/bin/env node
// Build the self-contained OpenClaw plugin package: the plugin *and* the Websidian runtime in one npm-pack
// tarball, so `openclaw plugins install` alone is a complete install — no checkout, no installer script.
//
//   node integrations/openclaw/websidian/deploy/pack.mjs [--out DIR] [--keep]
//   npm run pack:openclaw
//
// The package:
//   index.js, lib/, dist/, skills/, openclaw.plugin.json, README.md   the plugin, as in the repository
//   runtime/src, runtime/public                                        Websidian, as in the repository
//   runtime/package.json, runtime/package-lock.json                    its dependencies, locked (CommonJS)
//   package.json                                                       the plugin's (no dependencies)
//   websidian.version, runtime/websidian.version                       the same stamp in both
//
// The runtime is not installed by OpenClaw: OpenClaw forces some dependency versions on every plugin
// (path-to-regexp 8 breaks Express 4) and loads plugins from a rebuilt copy. On first start the plugin copies
// runtime/ to <state dir>/plugin-data/websidian/app and runs `npm ci --omit=dev --ignore-scripts` there with
// Websidian's own lock file (lib/supervisor.js, provision). Nothing is compiled: files are copied as they are.
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');
const REPO = path.resolve(PLUGIN, '..', '..', '..');
const PLUGIN_FILES = ['index.js', 'lib', 'dist', 'skills', 'openclaw.plugin.json', 'README.md'];
const RUNTIME_FILES = ['src', 'public'];

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
if (args.includes('-h') || args.includes('--help')) {
  console.log('Usage: node deploy/pack.mjs [--out DIR] [--keep]\n  --out DIR  where the .tgz goes (default <repo>/.release)\n  --keep     keep the staging folder and print its path');
  process.exit(0);
}
const OUT = path.resolve(opt('--out', path.join(REPO, '.release')));
const KEEP = args.includes('--keep');

if (!fs.existsSync(path.join(REPO, 'src', 'server.js'))) {
  console.error(`src/server.js not found under ${REPO} (is this the Websidian checkout?)`);
  process.exit(1);
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const git = (...a) => { try { return execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8' }).trim(); } catch { return ''; } };

const rootPkg = readJson(path.join(REPO, 'package.json'));
const pluginPkg = readJson(path.join(PLUGIN, 'package.json'));
const manifest = readJson(path.join(PLUGIN, 'openclaw.plugin.json'));
if (manifest.version !== pluginPkg.version) {
  console.error(`openclaw.plugin.json version ${manifest.version} and package.json version ${pluginPkg.version} differ`);
  process.exit(1);
}

const revision = (git('rev-parse', '--short', 'HEAD') || 'unknown') + (git('status', '--porcelain', '--', 'src', 'public', 'integrations/openclaw/websidian') ? '-dirty' : '');
const packedAt = new Date().toISOString();
const stamp = (component) => ({ revision, installed_at: packedAt, source: `package ${pluginPkg.name}@${pluginPkg.version}`, component });

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'websidian-pack-'));
const root = path.join(stage, 'package');
fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });

for (const f of PLUGIN_FILES) fs.cpSync(path.join(PLUGIN, f), path.join(root, f), { recursive: true });
for (const f of RUNTIME_FILES) fs.cpSync(path.join(REPO, f), path.join(root, 'runtime', f), { recursive: true });

// runtime/package.json: Websidian's own, without scripts, marked CommonJS explicitly (the plugin's package.json
// says "type": "module"). The lock file makes the first-start `npm ci` install exactly what the tests ran on.
const runtimePkg = { ...rootPkg, private: true, type: 'commonjs' };
delete runtimePkg.scripts;
delete runtimePkg.devDependencies;
writeJson(path.join(root, 'runtime', 'package.json'), runtimePkg);
fs.copyFileSync(path.join(REPO, 'package-lock.json'), path.join(root, 'runtime', 'package-lock.json'));

const pkg = {
  ...pluginPkg,
  files: [...PLUGIN_FILES, 'runtime', 'websidian.version'],
  // npm 7+ installs peer dependencies; the Gateway already is OpenClaw, so never pull a second copy.
  peerDependenciesMeta: { ...(pluginPkg.peerDependenciesMeta || {}), openclaw: { optional: true } },
};
delete pkg.scripts;
delete pkg.devDependencies;
writeJson(path.join(root, 'package.json'), pkg);
writeJson(path.join(root, 'websidian.version'), stamp('plugin'));
writeJson(path.join(root, 'runtime', 'websidian.version'), stamp('runtime'));

fs.mkdirSync(OUT, { recursive: true });
const out = execSync(`npm pack --json --pack-destination ${JSON.stringify(OUT)}`, { cwd: root, encoding: 'utf8' });
const info = JSON.parse(out)[0];
const tgz = path.join(OUT, info.filename);

console.log(`Packed ${pkg.name}@${pkg.version} (${revision}): ${info.entryCount} files, ${(info.size / 1024).toFixed(0)} kB`);
console.log(tgz);
console.log('\nInstall it on the OpenClaw host:');
console.log(`  openclaw plugins install npm-pack:${tgz}`);
console.log('  openclaw plugins enable websidian --accept-capabilities');
console.log('  openclaw gateway restart');
if (KEEP) console.log(`\nStaging folder kept: ${root}`);
else fs.rmSync(stage, { recursive: true, force: true });
