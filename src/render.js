'use strict';
// Obsidian-flavoured Markdown -> HTML.
//
// Everything Obsidian adds on top of CommonMark/GFM is handled here:
//   [[wikilinks]] / [[Note#Heading|alias]]      -> resolved links
//   ![[image.png|300]] / ![[Note#Section]]      -> <img> / transclusion
//   > [!type]+- Title  callouts (nested, foldable)
//   ==highlight==, %%comments%%, - [ ] tasks, ```mermaid fences
//   frontmatter (YAML) parsed, not rendered
// Rendering is pure: given the same file (and the same vault file list) it
// yields the same HTML, which is what makes the result cacheable.

const fsp = require('fs/promises');
const MarkdownIt = require('markdown-it');
const { parseFrontmatter } = require('./vault');
const { viewerHtml } = require('./excalidraw');

// Bump when the renderer's output changes, so stale cache entries are dropped.
const RENDER_VERSION = 7;   // 7: Excalidraw embeds become live viewers
const MAX_EMBED_DEPTH = 3;
const EXCALIDRAW_RE = /\.excalidraw(\.md)?$/i;

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Heading ids: keep letters/digits of any script, spaces -> '-', lower-case.
// Used for both heading ids and [[Note#Heading]] fragments so they always agree.
function slugify(text) {
  return String(text).trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-') || 'section';
}

function isExternal(href) { return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href); }

const CALLOUT_ALIASES = {
  summary: 'abstract', tldr: 'abstract', hint: 'tip', important: 'tip', check: 'success', done: 'success',
  help: 'question', faq: 'question', caution: 'warning', attention: 'warning', fail: 'failure', missing: 'failure',
  error: 'danger', cite: 'quote',
};

// ---------------------------------------------------------------------------
// markdown-it plugins
// ---------------------------------------------------------------------------

function pluginWikilinks(md) {
  md.inline.ruler.before('link', 'wikilink', (state, silent) => {
    const src = state.src; let pos = state.pos; let embed = false;
    if (src.charCodeAt(pos) === 0x21 /* ! */ && src.startsWith('[[', pos + 1)) { embed = true; pos += 1; }
    else if (!src.startsWith('[[', pos)) return false;
    const end = src.indexOf(']]', pos + 2);
    if (end < 0) return false;
    const inner = src.slice(pos + 2, end);
    if (!inner.trim() || inner.includes('[[') || inner.includes('\n')) return false;
    if (!silent) {
      const t = state.push(embed ? 'obsidian_embed' : 'wikilink', '', 0);
      t.content = inner;
    }
    state.pos = end + 2;
    return true;
  });

  md.renderer.rules.wikilink = (tokens, idx, opts, env) => {
    const inner = tokens[idx].content;
    const bar = inner.indexOf('|');
    const targetPart = bar >= 0 ? inner.slice(0, bar) : inner;
    const alias = bar >= 0 ? inner.slice(bar + 1) : null;
    const hash = targetPart.indexOf('#');
    const target = (hash >= 0 ? targetPart.slice(0, hash) : targetPart).trim();
    const fragment = hash >= 0 ? targetPart.slice(hash + 1).trim() : '';
    const label = alias != null ? alias : (target ? (fragment ? `${target} › ${fragment}` : target) : fragment);
    const frag = fragment ? '#' + (fragment.startsWith('^') ? encodeURIComponent(fragment) : slugify(fragment)) : '';
    if (!target) return `<a href="${frag}" class="internal-link">${escapeHtml(label)}</a>`;
    const r = env.vault.resolve(target, env.rel);
    if (!r) return `<span class="internal-link unresolved" title="No note called “${escapeHtml(target)}”">${escapeHtml(label)}</span>`;
    const href = r.kind === 'note' ? env.vault.noteUrl(r.rel) + frag : env.vault.fileUrl(r.rel);
    return `<a href="${href}" class="internal-link">${escapeHtml(label)}</a>`;
  };

  md.renderer.rules.obsidian_embed = (tokens, idx, opts, env) => {
    const inner = tokens[idx].content;
    const bar = inner.indexOf('|');
    const targetPart = bar >= 0 ? inner.slice(0, bar) : inner;
    const extra = bar >= 0 ? inner.slice(bar + 1).trim() : '';
    const hash = targetPart.indexOf('#');
    const target = (hash >= 0 ? targetPart.slice(0, hash) : targetPart).trim();
    const fragment = hash >= 0 ? targetPart.slice(hash + 1).trim() : '';

    // Excalidraw drawings: the live viewer when the drawing itself is in the
    // vault (src/excalidraw.js), else the plugin's auto-exported .svg/.png.
    if (EXCALIDRAW_RE.test(target)) {
      const stem = target.replace(EXCALIDRAW_RE, '.excalidraw');
      const exp = env.vault.resolveFile(stem + '.svg', env.rel) || env.vault.resolveFile(stem + '.png', env.rel);
      const m = extra.match(/^(\d+)(?:x(\d+))?/);
      const drawing = env.vault.resolveDrawing(target, env.rel);
      if (drawing) {
        env.deps.add(drawing);   // re-render when the drawing is edited or unpublished
        return viewerHtml({ vault: env.vault, drawing, exportRel: exp, title: stem.replace(/^.*\//, ''), width: m ? Number(m[1]) : 0, height: m && m[2] ? Number(m[2]) : 0 });
      }
      if (exp) return `<img class="excalidraw" src="${env.vault.fileUrl(exp)}" alt="${escapeHtml(target)}" loading="lazy"${m ? ` width="${m[1]}"` : ''}>`;
      const note = env.vault.resolveNote(target, env.rel) || env.vault.resolveNote(stem + '.md', env.rel);
      return `<span class="embed excalidraw-missing" title="Enable auto-export to SVG/PNG in the Excalidraw plugin to show this drawing on the web">✎ Drawing: ${escapeHtml(note ? note.replace(/\.md$/, '') : target)}</span>`;
    }

    const r = env.vault.resolve(target, env.rel);
    if (!r) return `<span class="embed unresolved">Missing: ${escapeHtml(target)}</span>`;

    if (r.kind === 'file') {
      const url = env.vault.fileUrl(r.rel);
      const ext = r.rel.slice(r.rel.lastIndexOf('.') + 1).toLowerCase();
      if (r.isImage) {
        let size = '', alt = target;
        const m = extra.match(/^(\d+)(?:x(\d+))?$/);
        if (m) size = ` width="${m[1]}"` + (m[2] ? ` height="${m[2]}"` : ''); else if (extra) alt = extra;
        return `<img src="${url}" alt="${escapeHtml(alt)}" loading="lazy"${size}>`;
      }
      if (ext === 'pdf') return `<iframe class="embed-pdf" src="${url}${fragment ? '#' + escapeHtml(fragment) : ''}" title="${escapeHtml(target)}"></iframe>`;
      if (['mp4', 'webm', 'ogv', 'mov'].includes(ext)) return `<video controls src="${url}"></video>`;
      if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'webm', '3gp'].includes(ext)) return `<audio controls src="${url}"></audio>`;
      return `<a class="embed-file" href="${url}">${escapeHtml(extra || target)}</a>`;
    }

    // Note transclusion (whole note or one section), depth-limited.
    if ((env.depth || 0) >= MAX_EMBED_DEPTH) return `<a class="internal-link" href="${env.vault.noteUrl(r.rel)}">${escapeHtml(target)}</a>`;
    const sub = env.renderSync(r.rel, fragment, (env.depth || 0) + 1);
    env.deps.add(r.rel); for (const d of sub.deps) env.deps.add(d);
    const title = fragment.startsWith('^') ? (env.vault.note(r.rel)?.title || target) : (fragment || env.vault.note(r.rel)?.title || target);
    const anchor = fragment ? '#' + (fragment.startsWith('^') ? encodeURIComponent(fragment) : slugify(fragment)) : '';
    return `<div class="embed-note${fragment.startsWith('^') ? ' embed-block' : ''}"><div class="embed-title"><a href="${env.vault.noteUrl(r.rel)}${anchor}">${escapeHtml(title)}</a></div>${sub.html}</div>`;
  };
}

// Block identifiers: a paragraph (or list item, quote, table) ending in " ^id"
// gets id="^id" so [[Note#^id]] can point at it. A line holding only "^id"
// labels the block just before it, as Obsidian does for tables and lists.
function pluginBlockIds(md) {
  md.core.ruler.after('block', 'obsidian_block_ids', state => {
    const t = state.tokens;
    for (let i = 0; i < t.length; i++) {
      if (t[i].type !== 'inline') continue;
      const alone = t[i].content.match(/^\s*\^([\w-]+)\s*$/);
      if (alone && t[i - 1] && t[i - 1].type === 'paragraph_open') {
        // Find the block that closed just before this paragraph and label its opener.
        let j = i - 2, depth = 0;
        for (; j >= 0; j--) { if (t[j].nesting === -1) depth++; else if (t[j].nesting === 1 && --depth === 0) break; }
        if (j >= 0) { t[j].attrSet('id', '^' + alone[1]); t.splice(i - 1, 3); i -= 2; }
        continue;
      }
      const m = t[i].content.match(/^([\s\S]*?)[ \t]+\^([\w-]+)[ \t]*$/);
      if (!m) continue;
      t[i].content = m[1];
      const opener = t[i - 1] && t[i - 1].type === 'paragraph_open' ? t[i - 1] : null;
      if (!opener) continue;
      // Inside a list item, the item is the block; otherwise the paragraph.
      const holder = t[i - 2] && t[i - 2].type === 'list_item_open' ? t[i - 2] : opener;
      holder.attrSet('id', '^' + m[2]);
    }
  });
}

// LaTeX math: $inline$ and $$display$$, emitted as escaped source for KaTeX
// (rendered in the browser). Same rules as Obsidian: no space just inside the
// dollars, and "$5 and $6" is not math.
function pluginMath(md) {
  md.inline.ruler.before('escape', 'math_inline', (state, silent) => {
    const src = state.src, pos = state.pos;
    if (src.charCodeAt(pos) !== 0x24 /* $ */) return false;
    const display = src.startsWith('$$', pos);
    const open = display ? 2 : 1;
    if (!display && (src[pos + 1] === ' ' || src[pos + 1] === undefined)) return false;
    const close = src.indexOf(display ? '$$' : '$', pos + open);
    if (close < 0) return false;
    const inner = src.slice(pos + open, close);
    if (!inner.trim() || (!display && (inner.includes('\n') || inner.endsWith(' ') || /^\d/.test(src.slice(close + 1))))) return false;
    if (!silent) { const tok = state.push(display ? 'math_block' : 'math_inline', '', 0); tok.content = inner; }
    state.pos = close + open;
    return true;
  });
  md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine], max = state.eMarks[startLine];
    if (!state.src.startsWith('$$', start)) return false;
    let line = startLine, found = false;
    const firstRest = state.src.slice(start + 2, max);
    if (firstRest.trimEnd().endsWith('$$') && firstRest.trim().length > 2) { found = true; }
    else { for (line = startLine + 1; line < endLine; line++) { const s = state.bMarks[line] + state.tShift[line], e = state.eMarks[line]; if (state.src.slice(s, e).trimEnd().endsWith('$$')) { found = true; break; } } }
    if (!found) return false;
    if (silent) return true;
    let content = state.getLines(startLine, line + 1, state.tShift[startLine], true).trim();
    content = content.replace(/^\$\$/, '').replace(/\$\$$/, '').trim();
    const tok = state.push('math_block', '', 0); tok.content = content; tok.block = true; tok.map = [startLine, line + 1];
    state.line = line + 1;
    return true;
  });
  md.renderer.rules.math_inline = (tokens, idx) => `<span class="math math-inline">${escapeHtml(tokens[idx].content)}</span>`;
  md.renderer.rules.math_block = (tokens, idx) => `<div class="math math-block">${escapeHtml(tokens[idx].content)}</div>\n`;
}

function pluginHighlight(md) {
  md.inline.ruler.before('emphasis', 'obsidian_mark', (state, silent) => {
    const src = state.src, pos = state.pos;
    if (!src.startsWith('==', pos) || src.charCodeAt(pos + 2) === 0x3D) return false;
    const end = src.indexOf('==', pos + 2);
    if (end < 0) return false;
    const inner = src.slice(pos + 2, end);
    if (!inner.trim() || inner.includes('\n')) return false;
    if (!silent) {
      state.push('mark_open', 'mark', 1);
      const t = state.push('text', '', 0); t.content = inner;
      state.push('mark_close', 'mark', -1);
    }
    state.pos = end + 2;
    return true;
  });
}

function pluginComments(md) {
  // %% inline comments %% are Obsidian-only and never shown.
  md.inline.ruler.before('emphasis', 'obsidian_comment', (state, silent) => {
    const src = state.src, pos = state.pos;
    if (!src.startsWith('%%', pos)) return false;
    const end = src.indexOf('%%', pos + 2);
    if (end < 0) return false;
    if (!silent) { /* drop */ }
    state.pos = end + 2;
    return true;
  });
  // Block comments: whole paragraphs that start and end with %%.
  md.core.ruler.after('block', 'obsidian_block_comment', state => {
    const t = state.tokens;
    for (let i = 0; i < t.length; i++) {
      if (t[i].type === 'paragraph_open' && t[i + 1] && t[i + 1].type === 'inline') {
        const c = t[i + 1].content.trim();
        if (c.startsWith('%%') && c.endsWith('%%') && c.length >= 4) { t.splice(i, 3); i--; }
      }
    }
  });
}

function pluginCallouts(md) {
  md.core.ruler.after('block', 'obsidian_callouts', state => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'blockquote_open') continue;
      const pOpen = tokens[i + 1], inline = tokens[i + 2];
      if (!pOpen || pOpen.type !== 'paragraph_open' || !inline || inline.type !== 'inline') continue;
      const m = inline.content.match(/^\[!([\w-]+)\]([+-]?)[ \t]*([^\n]*)(?:\n|$)/);
      if (!m) continue;
      let type = m[1].toLowerCase(); type = CALLOUT_ALIASES[type] || type;
      const fold = m[2], title = m[3].trim();
      const rest = inline.content.slice(m[0].length);

      let depth = 0, j = i;
      for (; j < tokens.length; j++) {
        if (tokens[j].type === 'blockquote_open') depth++;
        else if (tokens[j].type === 'blockquote_close' && --depth === 0) break;
      }
      const tag = fold ? 'details' : 'div';
      tokens[i].tag = tag; tokens[i].markup = '';
      tokens[i].attrs = [['class', `callout callout-${type}`], ['data-callout', type]];
      if (fold === '+') tokens[i].attrs.push(['open', '']);
      tokens[j].tag = tag; tokens[j].markup = '';

      const level = tokens[i].level + 1;
      const mk = (type_, content, tag_ = '') => { const t = new state.Token(type_, tag_, 0); t.content = content; t.level = level; t.block = true; return t; };
      const titleInline = mk('inline', title || type.charAt(0).toUpperCase() + type.slice(1)); titleInline.children = [];
      const head = [
        mk('html_block', `<${fold ? 'summary' : 'div'} class="callout-title"><span class="callout-icon" aria-hidden="true"></span><span class="callout-title-inner">`),
        titleInline,
        mk('html_block', `</span></${fold ? 'summary' : 'div'}>\n<div class="callout-content">`),
      ];
      const tail = mk('html_block', '</div>');
      // Body: remaining text of the first paragraph (if any) + the rest of the quote.
      if (rest.trim() === '') { tokens.splice(i + 1, 3, ...head); j += head.length - 3; }
      else { inline.content = rest.replace(/^\n/, ''); tokens.splice(i + 1, 0, ...head); j += head.length; }
      tokens.splice(j, 0, tail);
    }
  });
}

function pluginTasks(md) {
  md.core.ruler.after('inline', 'obsidian_tasks', state => {
    const t = state.tokens;
    for (let i = 2; i < t.length; i++) {
      if (t[i].type !== 'inline' || t[i - 1].type !== 'paragraph_open' || t[i - 2].type !== 'list_item_open') continue;
      const first = t[i].children && t[i].children[0];
      if (!first || first.type !== 'text') continue;
      const m = first.content.match(/^\[([ xX])\]\s+/);
      if (!m) continue;
      const done = m[1] !== ' ';
      first.content = first.content.slice(m[0].length);
      const box = new state.Token('html_inline', '', 0);
      box.content = `<input type="checkbox" disabled${done ? ' checked' : ''}> `;
      t[i].children.unshift(box);
      t[i - 2].attrJoin('class', 'task-list-item' + (done ? ' is-done' : ''));
    }
  });
}

function pluginHeadings(md) {
  md.core.ruler.after('inline', 'heading_ids', state => {
    const seen = new Map(); const t = state.tokens;
    for (let i = 0; i < t.length; i++) {
      if (t[i].type !== 'heading_open') continue;
      const text = t[i + 1].children.filter(c => c.type === 'text' || c.type === 'code_inline').map(c => c.content).join('').trim()
        || t[i + 1].content;
      let id = slugify(text); const n = seen.get(id) || 0; seen.set(id, n + 1); if (n) id += '-' + n;
      t[i].attrSet('id', id);
      if (state.env.headings) state.env.headings.push({ level: Number(t[i].tag.slice(1)), text, id });
    }
  });
}

function pluginLinksAndImages(md) {
  const defaultLink = md.renderer.rules.link_open || ((tokens, idx, o, e, self) => self.renderToken(tokens, idx, o));
  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    const tok = tokens[idx]; const href = tok.attrGet('href') || '';
    if (isExternal(href)) { tok.attrSet('target', '_blank'); tok.attrSet('rel', 'noopener'); tok.attrJoin('class', 'external-link'); }
    else if (!href.startsWith('#')) tok.attrSet('href', resolveRelativeHref(href, env));
    return defaultLink(tokens, idx, opts, env, self);
  };
  const defaultImage = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const tok = tokens[idx]; const src = tok.attrGet('src') || '';
    if (!isExternal(src)) { const r = env.vault.resolveFile(decodeURIComponent(src), env.rel); if (r) tok.attrSet('src', env.vault.fileUrl(r)); }
    tok.attrSet('loading', 'lazy');
    return defaultImage(tokens, idx, opts, env, self);
  };
}

// Standard-markdown relative links: to another .md note, to an attachment, or
// (if configured) into the source repository next to the vault.
function resolveRelativeHref(href, env) {
  let [p, frag] = href.split('#'); frag = frag ? '#' + frag : '';
  let dec = p; try { dec = decodeURIComponent(p); } catch { /* keep raw */ }
  if (/\.md$/i.test(dec)) { const r = env.vault.resolveNote(dec, env.rel); if (r) return env.vault.noteUrl(r) + frag; }
  const f = env.vault.resolveFile(dec, env.rel);
  if (f) return env.vault.fileUrl(f) + frag;
  const cl = env.vault.codeLinks;
  if (cl && cl.base) {
    // e.g. ../../addons/x/y.py:221 from docs/40-reference/Note.md -> <base>/addons/x/y.py#L221
    const m = dec.match(/^(.*?)(?::(\d+))?$/);
    const fromDir = env.rel.slice(0, env.rel.lastIndexOf('/') + 1);
    const inRepo = require('path').posix.normalize((cl.vaultPathInRepo ? cl.vaultPathInRepo.replace(/\/$/, '') + '/' : '') + fromDir + m[1]);
    if (!inRepo.startsWith('..')) return cl.base.replace(/\/$/, '') + '/' + inRepo + (m[2] ? '#L' + m[2] : frag);
  }
  return href;
}

function pluginFencesAndTables(md) {
  md.renderer.rules.fence = (tokens, idx) => {
    const tok = tokens[idx]; const info = (tok.info || '').trim(); const lang = info.split(/\s+/)[0].toLowerCase();
    if (lang === 'mermaid') return `<pre class="mermaid">${escapeHtml(tok.content)}</pre>\n`;
    return `<pre><code class="hljs${lang ? ' language-' + escapeHtml(lang) : ''}">${escapeHtml(tok.content)}</code></pre>\n`;
  };
  md.renderer.rules.table_open = (tokens, idx, opts, env, self) => '<div class="table-wrap">' + self.renderToken(tokens, idx, opts);
  md.renderer.rules.table_close = () => '</table></div>';
}

// html: false for untrusted sites. Our own plugins emit html_block/html_inline
// tokens (callouts, task checkboxes), which markdown-it renders regardless.
function createMarkdown({ html = true } = {}) {
  const md = new MarkdownIt({ html, linkify: true, breaks: true, typographer: false });
  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false }); // only real URLs, like Obsidian
  md.use(require('markdown-it-footnote'));
  md.use(pluginWikilinks).use(pluginHighlight).use(pluginComments).use(pluginMath).use(pluginCallouts).use(pluginBlockIds)
    .use(pluginTasks).use(pluginHeadings).use(pluginLinksAndImages).use(pluginFencesAndTables);
  return md;
}

// ---------------------------------------------------------------------------
// Note rendering
// ---------------------------------------------------------------------------

// Extract "## Heading" ... up to the next heading of the same or higher level.
function extractSection(body, heading) {
  const lines = body.split(/\r?\n/); const want = slugify(heading);
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m && slugify(m[2]) === want) { start = i; level = m[1].length; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

// Extract the block labelled ^id: the paragraph/list item/table it ends, or,
// for a bare "^id" line, the block just above it. Marker removed.
function extractBlock(body, id) {
  const lines = body.split(/\r?\n/);
  const marker = new RegExp(`(?:^|[ \\t])\\^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`);
  const at = lines.findIndex(l => marker.test(l));
  if (at < 0) return null;
  const bare = /^\s*\^/.test(lines[at]);
  let end = bare ? at - 1 : at;
  while (end > 0 && lines[end].trim() === '') end--;
  let start = end;
  while (start > 0 && lines[start - 1].trim() !== '') start--;
  const out = lines.slice(start, end + 1);
  if (!bare) out[out.length - 1] = out[out.length - 1].replace(marker, '');
  return out.join('\n');
}

class Renderer {
  constructor() { this.md = createMarkdown(); this.mdSafe = createMarkdown({ html: false }); this.sourceCache = new Map(); }
  mdFor(vault) { return vault && vault.untrusted ? this.mdSafe : this.md; }

  // Read a note and its stamp. Also used by the server for cache validation.
  async read(vault, rel) {
    const abs = require('path').join(vault.root, rel);
    const st = await fsp.stat(abs);
    const stamp = `${st.mtimeMs}-${st.size}`;
    const text = await fsp.readFile(abs, 'utf8');
    return { text, stamp, mtimeMs: st.mtimeMs };
  }

  // Render a note. Transclusions are rendered synchronously from sources we
  // preload (so the markdown-it render stays synchronous).
  async render(vault, rel) {
    const { text, stamp, mtimeMs } = await this.read(vault, rel);
    return this.renderSource(vault, rel, text, { stamp, mtimeMs });
  }

  // Render Markdown source as if it were the note at `rel` (links, embeds and
  // images resolve relative to that path). Used for the editor's live preview
  // of unsaved text; the disk file, if any, is not read.
  async renderSource(vault, rel, text, { stamp = 'preview', mtimeMs = Date.now() } = {}) {
    const sources = new Map([[rel, text]]);
    // Preload every note this one might transclude (one level is enough to seed;
    // deeper levels are loaded on demand with a sync read, which is rare).
    for (const m of text.matchAll(/!\[\[([^\]|#]+)/g)) {
      const r = vault.resolve(m[1].trim(), rel);
      if (r && r.kind === 'note' && !sources.has(r.rel)) { try { sources.set(r.rel, await fsp.readFile(require('path').join(vault.root, r.rel), 'utf8')); } catch { /* skip */ } }
    }
    const deps = new Set(); const headings = [];
    const md = this.mdFor(vault);
    const env = {
      vault, rel, depth: 0, deps, headings,
      renderSync(subRel, fragment, depth) {
        let src = sources.get(subRel);
        if (src == null) { try { src = require('fs').readFileSync(require('path').join(vault.root, subRel), 'utf8'); } catch { src = ''; } }
        let body = parseFrontmatter(src).body;
        if (fragment) {
          const sec = fragment.startsWith('^') ? extractBlock(body, fragment.slice(1)) : extractSection(body, fragment);
          body = sec == null ? `> [!warning] “${fragment}” not found in ${subRel}` : sec;
        }
        const subDeps = new Set();
        const subEnv = { ...env, rel: subRel, depth, deps: subDeps, headings: [] };
        return { html: md.render(body, subEnv), deps: subDeps };
      },
    };
    const { data, body } = parseFrontmatter(text);
    const html = md.render(body, env);
    // Deps are recorded with their current stamps for later validation.
    const depList = [];
    for (const d of deps) { try { const st = await fsp.stat(require('path').join(vault.root, d)); depList.push({ rel: d, stamp: `${st.mtimeMs}-${st.size}` }); } catch { depList.push({ rel: d, stamp: 'missing' }); } }
    return { html, data, headings, stamp, mtimeMs, deps: depList, text: plainText(body), version: RENDER_VERSION };
  }
}

// Rough plain text for search indexing.
function plainText(body) {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[\[[^\]]*\]\]/g, ' ')
    .replace(/\[\[([^\]|]*)\|?([^\]]*)\]\]/g, (m, a, b) => b || a)
    .replace(/\[![\w-]+\][+-]?/g, ' ')      // callout markers
    .replace(/(?:^|\s)\^[\w-]+(?=\s|$)/g, ' ') // block ids
    .replace(/\[\^[^\]]+\]:?/g, ' ')          // footnote refs
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*_`|=-]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

module.exports = { Renderer, RENDER_VERSION, slugify, escapeHtml, extractSection, extractBlock };
