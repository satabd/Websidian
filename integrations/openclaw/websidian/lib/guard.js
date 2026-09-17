// Write-time guard for the websidian OpenClaw plugin. Pure logic, standard library only, no OpenClaw imports:
// the plugin's `before_tool_call` hook calls evaluate().
//
// Two rules:
//
// 1. Protected files. Writes to agent instruction files (SKILL.md, SOUL.md, AGENTS.md ..., matched by basename,
//    case-insensitively) anywhere under the OpenClaw state dir, an agent workspace or a configured vault need a
//    human: an `approve` directive (or `block` when protectMode is "block").
// 2. Active content. Writes into a configured vault must be plain Markdown: raw <script>, <iframe>, event-handler
//    attributes, javascript: URLs and friends are blocked, and so are .html/.svg/.js... files. Code inside fenced
//    code blocks and inline code spans is ignored, but only where Markdown really renders it as code.
//
// Tools covered: `write` ({path, content}), `edit` ({path, edits: [{oldText, newText}]}), `apply_patch` ({input}:
// *** Add File / Update File / Move to / Delete File) and, best-effort, `exec` ({command, workdir}). A shell command
// that both writes and names a protected file or a vault needs approval. This is a guard rail against mistakes and
// prompt-injected content, not a security boundary.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PROTECT, normalizeVaults, resolveLinks, resolveStateDir, uiSettings, workspaceDirs, expandHome } from './sites.js';
import { absolutize, realpathSafe } from './links.js';

// Files a vault must never gain: the browser would run them (Websidian serves attachments from the vault).
export const BLOCKED_EXTENSIONS = Object.freeze(['.html', '.htm', '.shtml', '.xhtml', '.xht', '.svg', '.xml', '.js', '.mjs']);

export const FILE_TOOLS = Object.freeze(['write', 'edit', 'apply_patch']);
export const SHELL_TOOLS = Object.freeze(['exec']);
export const GUARDED_TOOLS = Object.freeze([...FILE_TOOLS, ...SHELL_TOOLS]);
// Tools whose successful calls write files the plugin can turn into links (after_tool_call).
export const TRACKED_TOOLS = FILE_TOOLS;

const MAX_SCAN_CHARS = 2_000_000;

// --------------------------------------------------------------------------------------------------
// Settings
// --------------------------------------------------------------------------------------------------

export class Settings {
  constructor({ vaults = [], protect, protectMode = 'approve', blockActiveContent = true, appendLinks = true, roots, ui } = {}) {
    this.ui = ui || uiSettings({}, {});
    this.vaults = resolveLinks(normalizeVaults(vaults), this.ui).map(v => ({ ...v, root: real(v.path) }));
    this.protect = (protect === undefined || protect === null ? DEFAULT_PROTECT : protect).map(String).filter(p => p.trim());
    const mode = String(protectMode || 'approve').trim().toLowerCase();
    this.protectMode = mode === 'block' ? 'block' : 'approve';
    this.blockActiveContent = !!blockActiveContent;
    this.appendLinks = !!appendLinks;
    // Folders whose instruction files are protected besides the vaults: the state dir and the agent workspaces.
    this.roots = [...new Set((roots || []).filter(Boolean).map(r => real(r)))].sort();
  }
}

// Settings from the plugin config (plugins.entries.websidian.config), the Gateway config and the environment.
export function settingsFromConfig(pluginConfig, cfg = {}, env = process.env) {
  const c = pluginConfig && typeof pluginConfig === 'object' ? pluginConfig : {};
  return new Settings({
    vaults: Array.isArray(c.vaults) ? c.vaults : [],
    protect: Array.isArray(c.protect) ? c.protect : undefined,
    protectMode: c.protectMode,
    blockActiveContent: c.blockActiveContent === undefined ? true : !!c.blockActiveContent,
    appendLinks: c.appendLinks === undefined ? true : !!c.appendLinks,
    roots: [resolveStateDir(env), ...workspaceDirs(cfg, env)],
    ui: uiSettings(c.ui, cfg, env),
  });
}

// --------------------------------------------------------------------------------------------------
// Paths
// --------------------------------------------------------------------------------------------------

// Absolute, ~-expanded, symlink-resolved path (relative paths resolve against `base` or cwd).
export function real(p, base) {
  return realpathSafe(path.normalize(absolutize(p, base)));
}

function key(p) {
  const s = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

// True when `p` is `root` or inside it (both already absolute).
export function isWithin(p, root) {
  const a = key(p);
  const r = key(root);
  return a === r || a.startsWith(r + '/');
}

// The normalized path and its realpath (a symlink must not escape either way).
export function candidates(p, base) {
  const normalized = path.normalize(absolutize(p, base));
  const resolved = realpathSafe(normalized);
  return key(normalized) === key(resolved) ? [normalized] : [normalized, resolved];
}

export function vaultFor(p, settings, base) {
  for (const cand of candidates(p, base)) {
    for (const v of settings.vaults) {
      if (isWithin(cand, v.root) || isWithin(cand, path.normalize(expandHome(v.path)))) return v;
    }
  }
  return null;
}

export function inRoots(p, settings, base) {
  return candidates(p, base).some(c => settings.roots.some(r => isWithin(c, r)));
}

function globToRegex(pattern, { pathSafe = false } = {}) {
  let out = '';
  for (const ch of pattern) {
    if (ch === '*') out += pathSafe ? "[^\\s/\\\\'\"]*" : '.*';
    else if (ch === '?') out += pathSafe ? "[^\\s/\\\\'\"]" : '.';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

function fnmatchCase(name, pattern) {
  return new RegExp('^' + globToRegex(pattern) + '$').test(name);
}

// The protect pattern `p` matches (by basename, case-insensitive) when it lies under a protected root or a
// vault, else null.
export function protectedName(p, settings, base) {
  if (!(inRoots(p, settings, base) || vaultFor(p, settings, base))) return null;
  for (const cand of candidates(p, base)) {
    const name = path.basename(cand).toLowerCase();
    for (const pattern of settings.protect) {
      if (fnmatchCase(name, pattern.toLowerCase())) return path.basename(cand);
    }
  }
  return null;
}

export function blockedExtension(p) {
  const ext = path.extname(String(p).replace(/[/\\ .]+$/, '')).toLowerCase();
  return BLOCKED_EXTENSIONS.includes(ext) ? ext : null;
}

// --------------------------------------------------------------------------------------------------
// Active content detection
// --------------------------------------------------------------------------------------------------

const SEP = '[\\s\\x00-\\x1f\\\\]*'; // whitespace / control chars / backslash escapes tolerated inside a scheme
const spaced = (word) => [...word].map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(SEP);
const SCHEME = '(?:' + ['javascript', 'vbscript', 'livescript'].map(spaced).join('|') + ')' + SEP + ':';
const DATA_HTML = spaced('data') + SEP + ':' + '[\\s\\x00-\\x1f]*' + '(?:text/html|application/xhtml|image/svg|text/xml|application/xml)';
// A URL-ish context: attribute value (=), Markdown link / image destination (](), reference definition ([x]: ),
// autolink (<), CSS url(, or any quote/paren.
const URL_CONTEXT = '(?:[=(<"\'`]|\\]\\s*:)' + '[\\s\\x00-\\x20]*';

// [reason, pattern, scan entity-decoded text too]
const RULES = [
  ['<script> tag', /<\s*\/?\s*script\b/gi, false],
  ['<iframe> tag', /<\s*i?frame(?:set)?\b/gi, false],
  ['<object> tag', /<\s*object\b/gi, false],
  ['<embed> tag', /<\s*embed\b/gi, false],
  ['<applet> tag', /<\s*applet\b/gi, false],
  ['<portal> tag', /<\s*portal\b/gi, false],
  ['<base> tag', /<\s*base\b/gi, false],
  ['<form> tag', /<\s*form\b/gi, false],
  ['<meta> tag', /<\s*meta\b/gi, false],
  ['javascript:/vbscript: URL', new RegExp(URL_CONTEXT + SCHEME, 'gi'), true],
  ['data:text/html URL', new RegExp(URL_CONTEXT + DATA_HTML, 'gi'), true],
];

function countMatches(rx, text) {
  rx.lastIndex = 0;
  let n = 0;
  while (rx.exec(text) !== null) { n++; if (rx.lastIndex === 0) break; }
  return n;
}

// --- HTML start-tag attributes, tokenized like a browser (WHATWG tokenizer, simplified) -------------------

const HTML_WS = '\t\n\f\r ';
const EVENT_ATTR = /^on[a-z]+$/;
const TAG_SCAN_CAP = 4096;         // chars one start tag may span before we give up (and flag it)
const TAG_SCAN_BUDGET = 4_000_000; // total chars scanned per document before we give up (and flag it)

// Tokenize the start tag at text[i] === "<": [tag name, attribute names, chars scanned, overlong].
// Attribute names are lowercased; a tag cut off by EOF still reports what it saw (patches can complete it).
function scanStartTag(text, i) {
  const n = text.length;
  const limit = Math.min(n, i + TAG_SCAN_CAP);
  let j = i + 1;
  while (j < limit && !HTML_WS.includes(text[j]) && !'/>'.includes(text[j])) j++;
  const name = text.slice(i + 1, j).toLowerCase();
  const attrs = [];
  while (j < limit) {
    const c = text[j];
    if (HTML_WS.includes(c) || c === '/') { j++; continue; }
    if (c === '>') return [name, attrs, j - i, false];
    const start = j; // attribute name (a leading "=" belongs to the name)
    j++;
    while (j < limit && !HTML_WS.includes(text[j]) && !'/>='.includes(text[j])) j++;
    attrs.push(text.slice(start, j).toLowerCase());
    while (j < limit && HTML_WS.includes(text[j])) j++;
    if (j < limit && text[j] === '=') {
      j++;
      while (j < limit && HTML_WS.includes(text[j])) j++;
      if (j < limit && (text[j] === '"' || text[j] === "'")) {
        const end = text.indexOf(text[j], j + 1);
        j = end >= 0 && end < limit ? end + 1 : limit;
      } else {
        while (j < limit && !HTML_WS.includes(text[j]) && text[j] !== '>') j++;
      }
    }
  }
  return [name, attrs, j - i, limit < n && j >= limit];
}

const LOOSE_EVENT_ATTR = /[\s/"'\x00]on[a-z]+[\s\x00]*=/gi;
const EVENT_REASON = 'event-handler attribute (on...=)';

function bisectLeft(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

function bisectRight(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (x < arr[mid]) hi = mid; else lo = mid + 1; }
  return lo;
}

// Count event-handler attributes in start tags. Every "<letter" is tokenized, including ones inside another
// tag's attribute value, because Markdown may not treat the outer "<" as a tag. Past the per-tag cap or the
// per-document budget, fall back to a quote-blind search of the rest of the text (stricter).
function tagFindings(text) {
  const loose = [];
  LOOSE_EVENT_ATTR.lastIndex = 0;
  for (let m; (m = LOOSE_EVENT_ATTR.exec(text)) !== null;) loose.push(m.index);
  const looseAfter = (pos) => bisectLeft(loose, pos) < loose.length;
  let count = 0;
  let budget = TAG_SCAN_BUDGET;
  const rx = /<[A-Za-z]/g;
  for (let m; (m = rx.exec(text)) !== null;) {
    if (budget < 0) { count += looseAfter(m.index) ? 1 : 0; break; }
    const [, attrs, used, overlong] = scanStartTag(text, m.index);
    budget -= used;
    count += attrs.filter(a => EVENT_ATTR.test(a)).length;
    if (overlong && looseAfter(m.index + used)) count += 1;
  }
  return { [EVENT_REASON]: count };
}

const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/; // column 0 only: an indented fence may belong to a list item
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/; // Websidian's parseFrontmatter
const CONTAINER_PREFIX = /^(?:\s*(?:>|[-+*]\s|\d{1,9}[.)]\s))*\s*/;
const HTML_RAW_TYPES = [ // CommonMark HTML block types 1-5: they end at a closer, not at a blank line
  [/^<(?:script|pre|style|textarea)(?:\s|>|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^<!--/, /-->/],
  [/^<\?/, /\?>/],
  [/^<![A-Za-z]/, />/],
  [/^<!\[CDATA\[/, /\]\]>/],
];
const HTML_BLOCK_START = /^<[A-Za-z/]/;
// Characters that start an inline construct able to swallow a backtick before the code-span rule sees it
// (HTML tags/autolinks, $math$, %%comments%%, ==highlight==, [[wikilinks]]/[links], escapes, table cells).
// "> [!note]" callout and "- [ ]" task markers: brackets that can never swallow a backtick.
const CALLOUT_MARKER = /^\s*(?:(?:>\s*)+\[![A-Za-z0-9_-]*\][+-]?|(?:>\s*)*(?:[-+*]|\d{1,9}[.)])\s+\[[^[\]`\\]\])/;
const INLINE_COMPETITORS = /[<$%=[\]|]/;
const BLOCK_SEARCH_BUDGET = 200_000; // line visits spent looking for fence / math closers before giving up

function splitLinesKeepEnds(text) {
  const lines = [];
  const rx = /[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g;
  for (let m; (m = rx.exec(text)) !== null;) { lines.push(m[0]); if (m[0].length === 0) break; }
  return lines;
}

function searchFrom(rx, s, from) {
  const r = new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : rx.flags + 'g');
  r.lastIndex = from;
  return r.exec(s) !== null;
}

// Character ranges Websidian's Markdown renderer certainly shows as code: closed column-0 fenced blocks outside
// HTML and math blocks, and inline code spans nothing else can claim first. Anything uncertain is left out, and
// therefore scanned. Runs in linear time; on pathological input it masks nothing.
function codeRanges(text) {
  const ranges = [];
  const lines = splitLinesKeepEnds(text);
  const offsets = [];
  let pos = 0;
  for (const line of lines) { offsets.push(pos); pos += line.length; }
  const stripped = lines.map(l => l.replace(/[\r\n]+$/, ''));
  const mathEnds = [];
  stripped.forEach((line, k) => { if (line.trimEnd().endsWith('$$')) mathEnds.push(k); });

  let i = 0;
  const fm = FRONTMATTER.exec(text);
  if (fm) { // frontmatter is YAML, never Markdown: skip it (scanned, never masked)
    const end = fm.index + fm[0].length;
    while (i < lines.length && offsets[i] < end) i++;
  }

  let budget = BLOCK_SEARCH_BUDGET;
  let htmlEnd = null;         // closer of the HTML block we are in
  let inHtmlBlank = false;    // in an HTML block that ends at a blank line
  let paraCompetitor = false; // the paragraph so far has a character that could swallow a backtick
  let poisoned = false;       // the paragraph has an unmatched/escaped backtick run: later spans are not trusted
  while (i < lines.length) {
    const line = stripped[i];
    if (htmlEnd !== null) {
      if (htmlEnd.test(line)) htmlEnd = null;
      i++;
      continue;
    }
    if (inHtmlBlank) {
      if (!line.trim()) inHtmlBlank = false;
      i++;
      continue;
    }
    if (!line.trim()) { paraCompetitor = poisoned = false; i++; continue; }
    const content = line.slice(CONTAINER_PREFIX.exec(line)[0].length);
    const raw = HTML_RAW_TYPES.find(([opener]) => opener.test(content));
    if (raw) {
      const closer = raw[1];
      htmlEnd = searchFrom(closer, content, 1) ? null : closer;
      paraCompetitor = poisoned = false;
      i++;
      continue;
    }
    if (HTML_BLOCK_START.test(content)) { inHtmlBlank = true; paraCompetitor = poisoned = false; i++; continue; }
    if (line.trimStart().startsWith('$$')) { // Websidian math block (a block rule that runs before fences)
      const rest = line.trimStart().slice(2);
      let j;
      if (rest.trimEnd().endsWith('$$') && rest.trim().length > 2) j = i;
      else { const k = bisectRight(mathEnds, i); j = k < mathEnds.length ? mathEnds[k] : null; }
      if (j !== null) { paraCompetitor = poisoned = false; i = j + 1; continue; }
    }
    const m = FENCE_OPEN.exec(line);
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      const fence = m[1];
      const close = new RegExp('^ {0,3}' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}[ \\t]*$');
      let j = i + 1;
      while (j < lines.length && !close.test(stripped[j])) j++;
      budget -= j - i;
      if (budget < 0) return []; // too expensive to reason about: trust nothing, scan everything
      paraCompetitor = poisoned = false;
      if (j < lines.length) { // closed fence: its body is code
        if (j > i + 1) ranges.push([offsets[i + 1], offsets[j]]);
        i = j + 1;
        continue;
      }
      i++; // unclosed fence: not trusted, scan it
      continue;
    }
    const scan = line.replace(CALLOUT_MARKER, mm => ' '.repeat(mm.length)); // "> [!note]" swallows nothing
    [paraCompetitor, poisoned] = inlineCodeRanges(scan, offsets[i], ranges, paraCompetitor, poisoned);
    i++;
  }
  return ranges;
}

// Append the trusted inline code spans of `line`. A span is trusted when its opener is not escaped, it closes on
// the same line, and nothing before it in the paragraph (outside trusted spans) could have claimed the backticks
// first. Returns the updated [competitor, poisoned] paragraph flags.
function inlineCodeRanges(line, base, out, competitor, poisoned) {
  const runs = [];
  const rx = /`+/g;
  for (let m; (m = rx.exec(line)) !== null;) runs.push([m.index, m[0].length]);
  const byLen = new Map();
  runs.forEach(([, length], idx) => { if (!byLen.has(length)) byLen.set(length, []); byLen.get(length).push(idx); });
  const competitorBetween = (from, to) => { const r = new RegExp(INLINE_COMPETITORS.source, 'g'); r.lastIndex = from; const m = r.exec(line); return m !== null && m.index < to; };
  let checked = 0; // line.slice(0, checked) has been searched for competitors (trusted span contents excluded)
  let idx = 0;
  while (idx < runs.length) {
    const [start, length] = runs[idx];
    if (!competitor && competitorBetween(checked, start)) competitor = true;
    checked = Math.max(checked, start);
    let b = start;
    while (b > 0 && line[b - 1] === '\\') b--;
    const same = byLen.get(length);
    const k = bisectRight(same, idx);
    if ((start - b) % 2 || k >= same.length) {
      poisoned = true; // escaped or unmatched on this line: Markdown may pair it differently
      idx++;
      continue;
    }
    const closeIdx = same[k];
    const closeStart = runs[closeIdx][0];
    if (!competitor && !poisoned) {
      out.push([base + start + length, base + closeStart]);
      checked = closeStart + length;
    }
    idx = closeIdx + 1;
  }
  if (!competitor && competitorBetween(checked, line.length)) competitor = true;
  return [competitor, poisoned];
}

function mask(text, ranges) {
  if (!ranges.length) return text;
  const units = text.split(''); // UTF-16 code units, which is what the offsets count
  for (const [start, end] of ranges) {
    for (let i = start; i < end; i++) if (units[i] !== '\r' && units[i] !== '\n') units[i] = ' ';
  }
  return units.join('');
}

// A subset of html.unescape: numeric references and the named entities that matter for obfuscated URLs and tags.
const NAMED_ENTITIES = {
  lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ', colon: ':', sol: '/', bsol: '\\', lpar: '(',
  rpar: ')', equals: '=', quest: '?', Tab: '\t', NewLine: '\n', excl: '!', num: '#', percnt: '%', period: '.',
  comma: ',', semi: ';', plus: '+', lowbar: '_', ast: '*', commat: '@', dollar: '$', lsqb: '[', rsqb: ']',
  lbrace: '{', rbrace: '}', verbar: '|', grave: '`', Hat: '^', tilde: '~', hyphen: '-', dash: '-', minus: '-',
  lbrack: '[', rbrack: ']', lcub: '{', rcub: '}', vert: '|', VerticalLine: '|', DiacriticalGrave: '`',
  Colon: ':', midast: '*', ZeroWidthSpace: '​', ensp: ' ', emsp: ' ', thinsp: ' ',
};
const LEGACY_NO_SEMI = ['lt', 'gt', 'amp', 'quot', 'nbsp'];

export function htmlUnescape(text) {
  return String(text).replace(/&(#[xX][0-9a-fA-F]{1,8};?|#[0-9]{1,8};?|[A-Za-z][A-Za-z0-9]{1,31};?)/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const digits = body.slice(hex ? 2 : 1).replace(/;$/, '');
      const cp = parseInt(digits, hex ? 16 : 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return m;
      return String.fromCodePoint(cp);
    }
    const hasSemi = body.endsWith(';');
    const name = hasSemi ? body.slice(0, -1) : body;
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) && (hasSemi || LEGACY_NO_SEMI.includes(name))) return NAMED_ENTITIES[name];
    if (!hasSemi) { // legacy "&ltx" forms
      for (const legacy of LEGACY_NO_SEMI) if (name.startsWith(legacy) && name.length > legacy.length) return NAMED_ENTITIES[legacy] + name.slice(legacy.length);
    }
    return m;
  });
}

function decodeEntities(text) {
  let prev = text;
  for (let n = 0; n < 3; n++) { // nested encodings like &amp;#106;
    const cur = htmlUnescape(prev);
    if (cur === prev) break;
    prev = cur;
  }
  return prev;
}

function countFindings(text) {
  const visible = mask(text, codeRanges(text));
  const decoded = decodeEntities(visible);
  const counts = {};
  for (const [reason, rx, check] of RULES) {
    counts[reason] = Math.max(countMatches(rx, visible), check ? countMatches(rx, decoded) : 0);
  }
  Object.assign(counts, tagFindings(visible));
  return counts;
}

// Reasons `text` contains active HTML (empty list = plain Markdown). Code blocks/spans are ignored.
export function findActiveContent(text) {
  if (typeof text !== 'string' || !text) return [];
  if (text.length > MAX_SCAN_CHARS) return ['content too large to scan'];
  return Object.entries(countFindings(text)).filter(([, count]) => count).map(([reason]) => reason);
}

// Findings present in `after` more often than in `before` (a patch must not introduce any).
export function newActiveContent(before, after) {
  if (after.length > MAX_SCAN_CHARS) return ['content too large to scan'];
  const b = countFindings(before);
  const a = countFindings(after);
  return Object.entries(a).filter(([reason, count]) => count > (b[reason] || 0)).map(([reason]) => reason);
}

// --------------------------------------------------------------------------------------------------
// apply_patch (OpenClaw's structured patch format)
// --------------------------------------------------------------------------------------------------

const PATCH_OPS = [
  ['update', /^\*\*\*\s*Update\s+File:\s*(.+)$/],
  ['add', /^\*\*\*\s*Add\s+File:\s*(.+)$/],
  ['delete', /^\*\*\*\s*Delete\s+File:\s*(.+)$/],
];
const PATCH_MOVE = /^\*\*\*\s*Move\s+to:\s*(.+)$/;

// [{op, path, newPath, added}] - the files a patch touches and the text its "+" lines add.
export function parsePatch(patchText) {
  const ops = [];
  let current = null;
  for (const raw of String(patchText || '').split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    let matched = null;
    for (const [kind, rx] of PATCH_OPS) { const m = rx.exec(line); if (m) { matched = [kind, m]; break; } }
    if (matched) {
      current = { op: matched[0], path: matched[1][1].trim(), newPath: null, added: [] };
      ops.push(current);
      continue;
    }
    const mv = current && current.op === 'update' ? PATCH_MOVE.exec(line) : null;
    if (mv) { current.newPath = mv[1].trim(); continue; }
    if (current && line.startsWith('+')) current.added.push(line.slice(1));
  }
  for (const op of ops) op.added = op.added.join('\n');
  return ops;
}

// --------------------------------------------------------------------------------------------------
// Tool-call evaluation
// --------------------------------------------------------------------------------------------------

function protectDirective(p, name, settings, toolName, base, detail = '') {
  const what = `${name} is an agent instruction file (${p})` + (detail ? `; ${detail}` : '');
  if (settings.protectMode === 'block') {
    return { action: 'block', message: `websidian: ${what}; writes to it are blocked. A human must make this change - ask the user to edit it themselves.` };
  }
  return { action: 'approve', message: `websidian: ${what}; a human must approve this write.`, ruleKey: `websidian:protect:${key(real(p, base))}`, file: p, tool: toolName };
}

function block(message) { return { action: 'block', message: 'websidian: ' + message }; }

const PLAIN_MD_HINT = 'Write plain Obsidian Markdown instead (headings, lists, [[wikilinks]], callouts, fenced code blocks for code samples); raw HTML with scripts, frames, forms, event handlers or javascript: URLs is not allowed in the vault.';

// Directive for writing `newText` to `p` (null = allow). With `beforeText` only content the write newly
// introduces counts (patches of files that already hold HTML).
export function checkFileWrite(p, newText, settings, { base, toolName = 'write', beforeText, createsFile = true } = {}) {
  if (typeof p !== 'string' || !p.trim()) return null;
  const name = protectedName(p, settings, base);
  if (name) return protectDirective(p, name, settings, toolName, base);
  const vault = vaultFor(p, settings, base);
  if (!vault || !settings.blockActiveContent) return null;
  const ext = blockedExtension(p);
  if (ext && createsFile) {
    return block(`refusing to write a ${ext} file into the vault (${p}); a browser would run it. Notes must be .md files. ` + PLAIN_MD_HINT);
  }
  if (newText) {
    const reasons = beforeText !== undefined && beforeText !== null ? newActiveContent(beforeText, newText) : findActiveContent(newText);
    if (reasons.length) return block(`the content for ${p} contains active HTML (${reasons.join(', ')}). ` + PLAIN_MD_HINT);
  }
  return null;
}

function readText(p, base) {
  try { return fs.readFileSync(real(p, base), 'utf8').slice(0, MAX_SCAN_CHARS + 1); } catch { return null; }
}

function checkPatch(params, settings, base) {
  const ops = parsePatch(params.input);
  for (const op of ops) {
    const targets = [op.path].concat(op.newPath ? [op.newPath] : []);
    for (const target of targets) {
      const name = protectedName(target, settings, base);
      if (name) return protectDirective(target, name, settings, 'apply_patch', base);
    }
    if (op.op === 'delete') continue;
    const dest = op.newPath || op.path;
    const directive = checkFileWrite(dest, op.added, settings, { base, toolName: 'apply_patch' });
    if (directive) return directive;
  }
  return null;
}

function checkEdit(params, settings, base) {
  const p = params.path;
  if (typeof p !== 'string') return null;
  const name = protectedName(p, settings, base);
  if (name) return protectDirective(p, name, settings, 'edit', base);
  if (!vaultFor(p, settings, base) || !settings.blockActiveContent) return null;
  const edits = Array.isArray(params.edits) ? params.edits.filter(e => e && typeof e === 'object') : [];
  const current = readText(p, base);
  // Editing an existing file: the result, not just the fragment, must stay free of active content
  // (old "<scr" + new "ipt>"). Simulate the replacements when every oldText is found.
  if (current !== null && edits.length && edits.every(e => typeof e.oldText === 'string' && e.oldText && current.includes(e.oldText))) {
    let after = current;
    for (const e of edits) after = after.replace(e.oldText, () => (typeof e.newText === 'string' ? e.newText : ''));
    return checkFileWrite(p, after, settings, { base, toolName: 'edit', beforeText: current, createsFile: false });
  }
  for (const e of edits) {
    const directive = checkFileWrite(p, typeof e.newText === 'string' ? e.newText : '', settings, { base, toolName: 'edit', createsFile: current === null });
    if (directive) return directive;
  }
  return null;
}

const SHELL_WRITE = new RegExp(
  '(?:>{1,2}|\\btee\\b|\\bsed\\b[^|;&]*\\s-[a-zA-Z]*i|\\bperl\\b[^|;&]*\\s-[a-zA-Z]*i|\\bcp\\b|\\bmv\\b|\\binstall\\b|' +
  '\\bln\\b|\\brsync\\b|\\bdd\\b|\\btruncate\\b|\\btouch\\b|\\bcurl\\b[^|;&]*\\s-o|\\bwget\\b|' +
  '\\bSet-Content\\b|\\bAdd-Content\\b|\\bOut-File\\b|\\bCopy-Item\\b|\\bMove-Item\\b|\\bNew-Item\\b|' +
  '\\bcopy\\b|\\bmove\\b|\\bren(?:ame)?\\b|\\bxcopy\\b|\\brobocopy\\b|open\\([^)]*[\'"][wa])',
  'i',
);

function pathSpellings(p) {
  const spellings = new Set([p, path.normalize(expandHome(p)), real(p)]);
  const home = os.homedir();
  const out = new Set();
  for (const s of spellings) {
    for (const variant of [s, s.replace(/\\/g, '/'), s.replace(/\//g, '\\')]) {
      out.add(variant.replace(/[/\\]+$/, ''));
      if (variant.toLowerCase().startsWith(home.toLowerCase())) out.add(('~' + variant.slice(home.length)).replace(/\\/g, '/'));
    }
  }
  return [...out].filter(s => s.length > 1);
}

function shellDirective(reason, settings) {
  const advice = 'Use write/edit for notes (they are checked for active content); shell writes into the vault or to instruction files cannot be inspected.';
  if (settings.protectMode === 'block') return block(`${reason}; blocked. ${advice}`);
  return { action: 'approve', message: `websidian: ${reason}; a human must approve it. ${advice}` };
}

// Best-effort: a command that both writes (redirect, tee, sed -i, cp, mv, ...) and names a protected file or a
// vault needs approval (or is blocked in block mode).
export function checkShellCommand(command, settings, { workdir, base } = {}) {
  if (typeof command !== 'string' || !command.trim()) return null;
  if (!SHELL_WRITE.test(command)) return null;
  const lowered = command.toLowerCase();
  for (const pattern of settings.protect) {
    if (new RegExp('(?<![\\w.-])' + globToRegex(pattern.toLowerCase(), { pathSafe: true }) + '(?![\\w.-])').test(lowered)) {
      return shellDirective(`the command writes near a protected agent instruction file (${pattern})`, settings);
    }
  }
  const wd = workdir ? real(workdir, base) : base ? real(base) : null;
  for (const v of settings.vaults) {
    if (wd && isWithin(wd, v.root)) return shellDirective(`the command runs inside the vault ${v.path} and writes files`, settings);
    for (const spelling of pathSpellings(v.path)) {
      if (lowered.replace(/\\\\/g, '\\').includes(spelling.toLowerCase())) return shellDirective(`the command writes into the vault ${v.path}`, settings);
    }
  }
  return null;
}

// before_tool_call decision for one tool call: null (allow), {action: "approve", message, ruleKey?} or
// {action: "block", message}.
export function evaluate(toolName, params, settings, { base } = {}) {
  if (!GUARDED_TOOLS.includes(toolName) || !params || typeof params !== 'object') return null;
  if (toolName === 'write') {
    return checkFileWrite(params.path, typeof params.content === 'string' ? params.content : '', settings, { base });
  }
  if (toolName === 'edit') return checkEdit(params, settings, base);
  if (toolName === 'apply_patch') return checkPatch(params, settings, base);
  if (SHELL_TOOLS.includes(toolName)) return checkShellCommand(params.command, settings, { workdir: params.workdir, base });
  return null;
}

// Paths a successful call wrote (used by after_tool_call to link the notes).
export function writtenPaths(toolName, params) {
  if (!params || typeof params !== 'object') return [];
  if (toolName === 'write' || toolName === 'edit') return typeof params.path === 'string' ? [params.path] : [];
  if (toolName === 'apply_patch') return parsePatch(params.input).filter(op => op.op !== 'delete').map(op => op.newPath || op.path);
  return [];
}
