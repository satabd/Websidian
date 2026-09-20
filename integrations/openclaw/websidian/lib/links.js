// Websidian URL building and vault listing. Pure, standard library only.
//
// A note <vault>/Folder/My Note.md served at https://brain.example.com/hermes/ has
// view URL https://brain.example.com/hermes/Folder/My%20Note and
// edit URL https://brain.example.com/hermes/_edit/Folder/My%20Note (Websidian's vault.noteUrl:
// rel.replace(/\.md$/i, '').split('/').map(encodeURIComponent).join('/')).
import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from './sites.js';

function looksWindowsAbs(p) { return p.length > 2 && p[1] === ':' && (p[2] === '\\' || p[2] === '/'); }

// Python's os.path.realpath resolves every component that exists and leaves a missing leaf alone;
// fs.realpathSync throws unless the WHOLE path exists. A file about to be created never exists, so a
// plain try/catch would leave its parent symlinks unresolved and let a write escape the guard
// (verified 2026-09-20: a junction into a protected folder was allowed). Resolve the deepest existing
// ancestor instead and re-append the rest.
export function realpathSafe(p) {
  const input = String(p);
  try { return fs.realpathSync.native(input); } catch { /* the leaf (or more) does not exist yet */ }
  if (!path.isAbsolute(input) && !looksWindowsAbs(input)) return input;
  let cur = path.normalize(input);
  const tail = [];
  for (let depth = 0; depth < 64; depth++) {
    const parent = path.dirname(cur);
    if (parent === cur) break; // reached the root without finding anything that exists
    tail.unshift(path.basename(cur));
    cur = parent;
    try { return path.join(fs.realpathSync.native(cur), ...tail); } catch { /* keep walking up */ }
  }
  return input;
}

function norm(p) {
  const abs = path.normalize(realpathSafe(path.normalize(expandHome(String(p)))));
  const s = abs.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

export function absolutize(p, base) {
  const s = expandHome(String(p));
  if (path.isAbsolute(s) || looksWindowsAbs(s)) return s;
  return path.join(base || process.cwd(), s);
}

// Vault-relative path with forward slashes, or null when `p` is outside the vault.
// Accepts Windows backslash paths, ~ and paths relative to `base`. Keeps the caller's spelling (case) below the root.
export function relativeNotePath(p, vaultPath, base) {
  const full = absolutize(p, base);
  const rootNorm = norm(vaultPath);
  const fullNorm = norm(full);
  if (fullNorm === rootNorm || !(fullNorm + '/').startsWith(rootNorm + '/')) return null;
  const spelled = path.normalize(realpathSafe(path.normalize(full))).replace(/\\/g, '/');
  const rel = spelled.slice(spelled.length - (fullNorm.length - rootNorm.length)).replace(/^\/+/, '');
  return rel || null;
}

export function noteRelToUrlPath(rel) {
  let r = String(rel).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (/\.md$/i.test(r)) r = r.slice(0, -3);
  return r.split('/').map(encodeURIComponent).join('/');
}

export function viewUrl(baseUrl, rel) {
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  return base + noteRelToUrlPath(rel);
}

export function editUrl(baseUrl, rel) {
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  return base + '_edit/' + noteRelToUrlPath(rel);
}

// [view, edit] for `rel` in `vault` (see sites.resolveLinks): ["", ""] without a url.
export function noteLinks(vault, rel) {
  if (!vault.url) return ['', ''];
  const edit = vault.external || vault.edit ? editUrl(vault.url, rel) : '';
  return [viewUrl(vault.url, rel), edit];
}

// A .md note Websidian serves: not inside a dot-folder (.obsidian, .trash, .git).
export function isNoteRel(rel) {
  const parts = String(rel).replace(/\\/g, '/').split('/');
  return /\.md$/i.test(parts[parts.length - 1]) && !parts.some(part => part.startsWith('.'));
}

// {path, rel, title, vault, view, edit} for a note inside one of `vaults`, else null.
export function linksForPath(p, vaults, base) {
  for (const vault of vaults) {
    if (!vault.path) continue;
    const rel = relativeNotePath(p, vault.path, base);
    if (rel === null) continue;
    if (!isNoteRel(rel)) return null;
    const [view, edit] = noteLinks(vault, rel);
    return { path: String(p), rel, title: path.basename(rel).replace(/\.md$/i, ''), vault: String(vault.path), view, edit };
  }
  return null;
}

export function formatLinksBlock(entries, heading = 'Notes updated:') {
  const lines = [heading];
  for (const e of entries) {
    const name = /\.md$/i.test(e.rel) ? e.rel.slice(0, -3) : e.rel;
    if (e.view) lines.push(`- ${name}: ${e.view}` + (e.edit ? ` (edit: ${e.edit})` : ''));
    else lines.push(`- ${e.rel} (no url configured for this vault)`);
  }
  return lines.join('\n');
}

// Most recently modified .md notes across `vaults` (dot-folders skipped), optionally filtered by a
// case-insensitive filename substring.
export function recentNotes(vaults, { query = '', limit = 10 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const found = [];
  for (const vault of vaults) {
    if (!vault.path) continue;
    const root = expandHome(String(vault.path));
    let stat;
    try { stat = fs.statSync(root); } catch { continue; }
    if (!stat.isDirectory()) continue;
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
        if (q && !entry.name.toLowerCase().includes(q)) continue;
        let mtime;
        try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
        const rel = path.relative(root, full).replace(/\\/g, '/');
        const [view, edit] = noteLinks(vault, rel);
        found.push({ path: full, rel, mtime, view, edit });
      }
    };
    walk(root);
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, Math.max(0, parseInt(limit, 10) || 0));
}
