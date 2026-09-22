// The Memory model: which notes in an agent workspace are its memory, and how they are grouped for the
// Memory page in OpenClaw's Control UI. Standard library only, so it unit-tests anywhere.
//
// OpenClaw's workspace stays the only source of truth. Nothing is copied, cached or indexed here: every
// call reads the directory again. Only vault-relative paths ever leave this module — the browser never
// sees a filesystem path, and nothing outside the configured vault root is ever walked.
import fs from 'node:fs';
import path from 'node:path';
import { isNoteRel, noteRelToUrlPath } from './links.js';
import { expandHome } from './sites.js';

// The named memory files an OpenClaw agent keeps at the root of its workspace, in reading order.
export const MEMORY_SECTIONS = Object.freeze([
  { id: 'long-term', file: 'MEMORY.md', label: 'Long-term memory', note: 'What the agent chose to keep.' },
  { id: 'user', file: 'USER.md', label: 'User memory', note: 'What it learned about you.' },
  { id: 'dreams', file: 'DREAMS.md', label: 'Dreams and consolidation', note: 'Reflection between runs.' },
]);
// Folders whose notes are dated memory entries rather than documents.
export const MEMORY_FOLDERS = Object.freeze(['memory']);
const MAX_RECENT = 40;
const MAX_WALK_ENTRIES = 5000;
// A preview needs the top of a note, not all of it: memory files grow for as long as the agent runs.
const PREVIEW_BYTES = 16 * 1024;
const EXCERPT_CHARS = 220;

// {heading, excerpt, words} from the top of a note, as plain text. Everything the page shows is set with
// textContent in the Control UI document, so this only has to read well — it is never trusted as markup.
export function previewOf(text) {
  let body = String(text || '').replace(/^﻿/, '');
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(body);
  if (fm) body = body.slice(fm[0].length);
  body = body.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/%%[\s\S]*?%%/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  let heading = '';
  const lines = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) { if (!heading && /^#\s/.test(line)) heading = inline(h[1]); continue; }
    if (/^(\||-{3,}|\*{3,}|>\s*\[!)/.test(line)) continue; // tables, rules, callout titles
    // Bullets, numbers, task boxes, quotes, and the § that separates entries in an agent's memory file.
    lines.push(inline(line.replace(/^([-*+§]|\d+[.)])\s+(\[.\]\s+)?/, '').replace(/^>\s?/, '')));
  }
  const flat = lines.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const words = flat ? flat.split(' ').length : 0;
  const excerpt = flat.length > EXCERPT_CHARS ? flat.slice(0, EXCERPT_CHARS).replace(/\s+\S*$/, '') + '…' : flat;
  return { heading, excerpt, words };
}

// Obsidian inline syntax to the words a reader sees.
function inline(t) {
  return String(t)
    .replace(/!\[\[[^\]]*\]\]/g, '')                                   // embeds
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')                        // [[target|label]]
    .replace(/\[\[([^\]#]*)(#([^\]]*))?\]\]/g, (m, a, b, c) => a || c || '') // [[target]], [[#heading]]
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')                          // [label](url), images
    .replace(/<[^>]+>/g, '')                                            // stray HTML
    .replace(/(\*\*|__|\*|~~|==|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function readHead(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(PREVIEW_BYTES);
    const n = fs.readSync(fd, buf, 0, PREVIEW_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

function withPreview(root, entry) {
  if (!entry) return entry;
  return { ...entry, ...previewOf(readHead(path.join(root, entry.rel))) };
}

// "2026-09-21" from a name like 2026-09-21.md or 2026-09-21-groceries.md; "" when there is no date in it.
export function dateFromName(name) {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(name));
  if (!m) return '';
  const [, y, mo, d] = m;
  const month = Number(mo), day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${y}-${mo}-${d}`;
}

export function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// "today" / "yesterday" / the ISO day, for a heading a person reads rather than a date they decode.
export function dayLabel(day, now = Date.now()) {
  if (!day) return 'undated';
  const today = isoDay(now);
  if (day === today) return 'today';
  if (day === isoDay(now - 86_400_000)) return 'yesterday';
  return day;
}

function statOf(abs) {
  try {
    const s = fs.statSync(abs);
    return s.isFile() ? s : null;
  } catch { return null; }
}

// {rel, title, mtime, bytes, day, url} for one note, or null when it is not there.
function entryFor(root, rel, base) {
  const abs = path.join(root, rel);
  const stat = statOf(abs);
  if (!stat) return null;
  return {
    rel,
    title: path.basename(rel).replace(/\.md$/i, ''),
    mtime: Math.round(stat.mtimeMs),
    bytes: stat.size,
    day: dateFromName(path.basename(rel)) || isoDay(stat.mtimeMs),
    // Whether `day` is the date the author put in the name. When it is not, the day is the modification
    // time's, and only the reader's browser knows which day that is in the reader's timezone.
    named: !!dateFromName(path.basename(rel)),
    url: base ? base + noteRelToUrlPath(rel) : '',
  };
}

// Every .md note under `dir` (vault-relative), newest first. Dot-folders are skipped by isNoteRel, and the
// walk is bounded so a surprising folder cannot hold the Gateway's event loop.
function walkNotes(root, dir, base) {
  const out = [];
  let budget = MAX_WALK_ENTRIES;
  const walk = (relDir) => {
    if (budget <= 0) return;
    let entries;
    try { entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (budget-- <= 0) return;
      if (e.name.startsWith('.')) continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(rel); continue; }
      if (!e.isFile() || !isNoteRel(rel)) continue;
      const entry = entryFor(root, rel, base);
      if (entry) out.push(entry);
    }
  };
  walk(dir);
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Group dated entries into days, newest day first.
export function groupByDay(entries, now = Date.now()) {
  const days = new Map();
  for (const e of entries) {
    if (!days.has(e.day)) days.set(e.day, []);
    days.get(e.day).push(e);
  }
  return [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([day, notes]) => ({ day, label: dayLabel(day, now), notes }));
}

// The whole Memory page model for one vault.
//
//   vault  — a normalized vault ({path, slug, title, ...}) from sites.normalizeVaults
//   base   — the URL prefix notes are read at (ends with "/"), or "" for paths only
//
// Returns {slug, title, sections, recent, timeline, counts, missing}. `missing` names the memory files
// the workspace does not have, so the page can say so instead of showing an empty card.
export function memoryModel(vault, { base = '', now = Date.now(), folders = MEMORY_FOLDERS, sections = MEMORY_SECTIONS } = {}) {
  const root = path.resolve(expandHome(String(vault && vault.path ? vault.path : '')));
  const found = [];
  const missing = [];
  for (const section of sections) {
    const entry = withPreview(root, entryFor(root, section.file, base));
    if (entry) found.push({ id: section.id, label: section.label, note: section.note, entry });
    else missing.push({ id: section.id, label: section.label, file: section.file });
  }
  const dated = [];
  for (const folder of folders) {
    const abs = path.join(root, folder);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.isDirectory()) dated.push(...walkNotes(root, folder, base));
  }
  dated.sort((a, b) => b.mtime - a.mtime);
  // Only the notes the page will show are opened; the rest of the walk is a stat each.
  const recent = dated.slice(0, MAX_RECENT).map(e => withPreview(root, e));
  const latest = [...found.map(x => x.entry.mtime), ...(recent[0] ? [recent[0].mtime] : [])];
  return {
    slug: vault.slug,
    title: vault.title,
    sections: found,
    missing,
    recent,
    timeline: groupByDay(recent, now),
    counts: { sections: found.length, dated: dated.length },
    updated: latest.length ? Math.max(...latest) : 0,
  };
}

// The vault the Memory page reads. `memory.vault` names a slug; otherwise the first vault this plugin
// serves itself (an external one is somebody else's Websidian and has no files here to read).
export function memoryVault(vaults, wanted = '') {
  const own = vaults.filter(v => !v.external && v.path);
  const slug = String(wanted || '').trim();
  if (slug) return own.find(v => v.slug === slug) || null;
  return own[0] || null;
}
