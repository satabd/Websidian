// Suggestions, as in Obsidian:
//   [[        notes (titles, paths, aliases) and attachments; ![[ the same for embeds
//   [[note#   headings of that note ([[# = this note)      [[note#^  its block ids
//   #tag      tags used anywhere in the vault
//   frontmatter: property names at the start of a line, known values after "name: " / "- "
//   /         slash commands (the editor commands marked `slash`)
import { autocompletion, pickedCompletion } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { fuzzyFilter, fileKind } from './vault-index.js';

const CODE = /^(InlineCode|CodeText|FencedCode|CodeBlock|CodeMark|CodeInfo|InlineMath|DisplayMath|MathBlock|URL)$/;
function inCode(state, pos) {
  for (let n = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) if (CODE.test(n.name)) return true;
  return false;
}
function frontmatterEnd(state) {
  const doc = state.doc; if (doc.lines < 2 || !/^---\s*$/.test(doc.line(1).text)) return -1;
  for (let i = 2; i <= Math.min(doc.lines, 400); i++) if (/^(---|\.\.\.)\s*$/.test(doc.line(i).text)) return doc.line(i).from;
  return -1;
}

// Headings / block ids of the current note straight from the editor (unsaved text included).
function localAnchors(state) {
  const headings = [], blocks = [];
  syntaxTree(state).iterate({ enter: n => {
    const m = /^ATXHeading(\d)$/.exec(n.name);
    if (m) { const text = state.sliceDoc(n.from, n.to).replace(/^#+\s*/, '').replace(/\s+#+\s*$/, ''); if (text) headings.push({ level: +m[1], text }); return false; }
  } });
  const re = /\s\^([A-Za-z0-9-]+)\s*$/;
  for (let i = 1; i <= state.doc.lines; i++) { const t = state.doc.line(i).text; const b = re.exec(t); if (b) blocks.push({ id: b[1], text: t.replace(re, '').trim() }); }
  return { headings, blocks };
}

function closeAfter(state, pos) { return state.sliceDoc(pos, pos + 2) === ']]' ? 2 : 0; }

// Replace [from, to) (plus an auto-closed "]]" after the cursor) with text + "]]".
function applyLink(text, { markdown = null } = {}) {
  return (view, completion, from, to) => {
    const extra = closeAfter(view.state, to);
    if (markdown) {
      // [[ was typed but the vault uses Markdown links: replace "[[query" with [title](path).
      const open = view.state.sliceDoc(from - 3, from) === '![[' ? from - 3 : from - 2;
      const ins = (view.state.sliceDoc(open, open + 1) === '!' ? '!' : '') + markdown;
      view.dispatch({ changes: { from: open, to: to + extra, insert: ins }, selection: { anchor: open + ins.length }, annotations: pickedCompletion.of(completion), userEvent: 'input.complete' });
      return;
    }
    const ins = text + ']]';
    view.dispatch({ changes: { from, to: to + extra, insert: ins }, selection: { anchor: from + ins.length }, annotations: pickedCompletion.of(completion), userEvent: 'input.complete' });
  };
}

// The completion sources (exported on their own for the tests).
export function completionSources(ctx) {
  // ctx: { index, rel, settings, ready, load: { anchors(rel) }, tags(), properties(), commands() }
  const { index } = ctx;
  const anchorCache = new Map();

  async function wikiSource(context) {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const m = /(!?)\[\[([^[\]]*)$/.exec(before);
    if (!m || inCode(context.state, context.pos)) return null;
    const embed = !!m[1]; const q = m[2];
    if (/\\?\|/.test(q)) return null;
    const qFrom = context.pos - q.length;
    await ctx.ready;
    const hash = q.indexOf('#');
    if (hash >= 0) {
      const notePart = q.slice(0, hash); const rest = q.slice(hash + 1); const isBlock = rest.startsWith('^');
      const target = notePart ? index.resolveNote(notePart) : ctx.rel;
      if (!target) return null;
      let anchors;
      if (target === ctx.rel) anchors = localAnchors(context.state);
      else { if (!anchorCache.has(target)) anchorCache.set(target, ctx.load.anchors(target).catch(() => ({ headings: [], blocks: [] }))); anchors = await anchorCache.get(target); }
      const query = isBlock ? rest.slice(1) : rest;
      if (isBlock) {
        const opts = fuzzyFilter(query, anchors.blocks || [], [['id', 1], ['text', 0.8]]).map(b => ({ label: '^' + b.id, detail: b.text, apply: applyLink(q.slice(0, hash + 1) + '^' + b.id), type: 'block' }));
        return { from: qFrom + hash + 1, options: opts, filter: false };
      }
      const opts = fuzzyFilter(query, anchors.headings || [], [['text', 1]]).map(h => ({ label: h.text, detail: 'H' + h.level, apply: applyLink(q.slice(0, hash + 1) + h.text), type: 'heading', boost: -h.level }));
      return { from: qFrom + hash + 1, options: opts, filter: false };
    }

    const useMd = ctx.settings.useMarkdownLinks;
    const noteItems = index.notes.filter(n => n.rel !== ctx.rel).flatMap(n => [
      { kind: 'note', n, name: n.rel.replace(/^.*\//, '').replace(/\.md$/i, ''), title: n.title, rel: n.rel },
      ...(n.aliases || []).map(a => ({ kind: 'alias', n, name: a, title: a, rel: n.rel })),
    ]);
    const fileItems = index.files.filter(f => embed || fileKind(f.name) !== 'file').map(f => ({ kind: 'file', f, name: f.name, title: f.name, rel: f.rel }));
    const pool = embed ? [...fileItems, ...noteItems] : [...noteItems, ...fileItems];
    const hits = q ? fuzzyFilter(q, pool, [['name', 1], ['title', 0.95], ['rel', 0.7]], 60)
      : pool.slice().sort((a, b) => ((b.n && b.n.mtime) || 0) - ((a.n && a.n.mtime) || 0)).slice(0, 40);
    const options = hits.map(h => {
      const isFile = h.kind === 'file';
      const text = index.linkText(h.rel, { isFile });
      const label = h.kind === 'alias' ? h.name : isFile ? h.name : h.title !== h.name ? h.title : h.name;
      const folder = h.rel.includes('/') ? h.rel.slice(0, h.rel.lastIndexOf('/')) : '';
      const detail = h.kind === 'alias' ? '↳ ' + h.rel.replace(/\.md$/i, '') : folder;
      const mdPath = h.rel.split('/').map(encodeURIComponent).join('/');
      return {
        label, detail, type: h.kind === 'alias' ? 'alias' : isFile ? fileKind(h.name) : 'note',
        apply: useMd ? applyLink(null, { markdown: `[${isFile ? h.name : h.kind === 'alias' ? h.name : h.title}](${mdPath})` })
          : applyLink(h.kind === 'alias' ? `${text}|${h.name}` : text),
      };
    });
    if (q && !index.resolve(q) && !embed) options.push({ label: q, detail: 'Link to a new note', type: 'new', apply: applyLink(q) });
    return { from: qFrom, options, filter: false };
  }

  async function tagSource(context) {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const m = /(?:^|[\s(,;])#([\p{L}\p{N}_/\-]+)$/u.exec(before);
    if (!m || inCode(context.state, context.pos)) return null;
    const fmEnd = frontmatterEnd(context.state); if (fmEnd >= 0 && context.pos < fmEnd) return null;
    await ctx.ready;
    const tags = await ctx.tags();
    const hits = fuzzyFilter(m[1], tags, [['tag', 1]], 40);
    return { from: context.pos - m[1].length, options: hits.map(t => ({ label: t.tag, detail: String(t.count), type: 'tag', apply: t.tag + ' ' })), filter: false };
  }

  async function propertySource(context) {
    const fmEnd = frontmatterEnd(context.state);
    if (fmEnd < 0 || context.pos > fmEnd || context.state.doc.lineAt(context.pos).number === 1) return null;
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const props = await ctx.properties();
    let m;
    if ((m = /^([\p{L}\p{N}_-]*)$/u.exec(before))) {
      if (!m[1] && !context.explicit) return null;
      const hits = fuzzyFilter(m[1], props, [['name', 1]], 40);
      return { from: line.from, options: hits.map(p => ({ label: p.name, detail: p.type, type: 'property', apply: p.name + ': ' })), filter: false };
    }
    let key = null, q = null, from = context.pos;
    if ((m = /^([\p{L}\p{N}_-]+):\s*(?:\[)?(?:.*,\s*)?([^,\]]*)$/u.exec(before))) { key = m[1]; q = m[2]; }
    else if ((m = /^\s+-\s+(.*)$/.exec(before))) {
      q = m[1];
      for (let i = line.number - 1; i > 1; i--) { const k = /^([\p{L}\p{N}_-]+):/u.exec(context.state.doc.line(i).text); if (k) { key = k[1]; break; } }
    }
    if (!key) return null;
    q = q.replace(/^["']/, '');
    from = context.pos - q.length;
    let values = (props.find(p => p.name === key) || {}).values || [];
    if (key === 'tags' || key === 'tag') values = (await ctx.tags()).map(t => t.tag);
    if (!values.length) return null;
    const hits = fuzzyFilter(q, values.map(v => ({ v })), [['v', 1]], 40);
    return { from, options: hits.map(h => ({ label: h.v, type: 'value' })), filter: false };
  }

  function slashSource(context) {
    if (ctx.settings.slashCommands === false) return null;
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const m = /(?:^|\s)\/([\p{L}\p{N} ]{0,30})$/u.exec(before);
    if (!m || inCode(context.state, context.pos) || / {2}/.test(m[1])) return null;
    const fmEnd = frontmatterEnd(context.state); if (fmEnd >= 0 && context.pos <= fmEnd) return null;
    const cmds = ctx.commands().filter(c => c.slash);
    const hits = m[1] ? fuzzyFilter(m[1], cmds, [['name', 1]], 30) : cmds;
    if (!hits.length) return null;
    const from = context.pos - m[1].length - 1;
    return {
      from, filter: false,
      options: hits.map(c => ({
        label: c.name, type: 'command',
        apply: (view, completion, f, to) => { view.dispatch({ changes: { from: f, to }, annotations: pickedCompletion.of(completion) }); c.run(view); },
      })),
    };
  }

  return { wikiSource, tagSource, propertySource, slashSource };
}

export function obsidianCompletion(ctx) {
  const s = completionSources(ctx);
  return autocompletion({
    override: [s.wikiSource, s.tagSource, s.propertySource, s.slashSource],
    icons: false,
    maxRenderedOptions: 60,
    tooltipClass: () => 'suggestion-container',
    optionClass: () => 'suggestion-item',
  });
}
