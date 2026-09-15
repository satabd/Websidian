// Obsidian Flavored Markdown for @lezer/markdown: the syntax Obsidian adds on
// top of CommonMark + GFM becomes real syntax-tree nodes, so highlighting,
// live preview and autocomplete all work from the same parse.
//
//   [[Note#Heading|Alias]]   WikiLink  (WikiMark WikiTarget WikiPipe WikiAlias WikiMark)
//   ![[image.png|300]]       Embed     (same children)
//   ==highlight==            Highlight (HighlightMark)
//   %%comment%%  / %% block  ObsComment / ObsCommentBlock (ObsCommentMark)
//   $x$  $$x$$  / $$ block   InlineMath / DisplayMath / MathBlock (MathMark)
//   #tag  #nested/tag        Hashtag   (HashtagMark)
//   ^block-id at line end    BlockId
//   [^1]  ^[inline note]     FootnoteRef / InlineFootnote
//   - [?] any task char      Task (TaskMarker), like GFM but any status character
import { tags as t, Tag } from '@lezer/highlight';
import { Table, Strikethrough, Autolink } from '@lezer/markdown';

// Highlight tags of our own, mapped to Obsidian's class names in editor.js.
export const obsTags = {
  highlight: Tag.define(),
  internalLink: Tag.define(t.link),
  embed: Tag.define(t.link),
  hashtag: Tag.define(),
  math: Tag.define(),
  blockId: Tag.define(),
  footnote: Tag.define(),
};

const BANG = 33, LBRACK = 91, RBRACK = 93, EQ = 61, PCT = 37, DOLLAR = 36, HASH = 35, CARET = 94, NL = 10, BACKSLASH = 92;
const isSpace = c => c === 32 || c === 9 || c === NL || c === 13 || c === -1;

// ---- [[wikilinks]] and ![[embeds]] ---------------------------------------------------
function parseWiki(cx, next, pos) {
  const start = pos; let embed = false;
  if (next === BANG) { if (cx.char(pos + 1) !== LBRACK || cx.char(pos + 2) !== LBRACK) return -1; embed = true; pos++; }
  else if (next !== LBRACK || cx.char(pos + 1) !== LBRACK) return -1;
  const open = pos + 2;
  let close = -1;
  for (let i = open; i < cx.end - 1; i++) {
    const c = cx.char(i);
    if (c === NL) break;
    if (c === RBRACK && cx.char(i + 1) === RBRACK) { close = i; break; }
    if (c === LBRACK && cx.char(i + 1) === LBRACK) break;
  }
  if (close <= open) return -1;
  const inner = cx.slice(open, close);
  const children = [cx.elt('WikiMark', start, open)];
  // "|" separates the alias; inside tables it is written "\|".
  const m = /\\?\|/.exec(inner);
  if (m) {
    const targetEnd = open + m.index, aliasStart = targetEnd + m[0].length;
    if (targetEnd > open) children.push(cx.elt('WikiTarget', open, targetEnd));
    children.push(cx.elt('WikiPipe', targetEnd, aliasStart));
    if (close > aliasStart) children.push(cx.elt('WikiAlias', aliasStart, close));
  } else {
    children.push(cx.elt('WikiTarget', open, close));
  }
  children.push(cx.elt('WikiMark', close, close + 2));
  return cx.addElement(cx.elt(embed ? 'Embed' : 'WikiLink', start, close + 2, children));
}

export const WikiLinks = {
  defineNodes: [
    { name: 'WikiLink', style: { 'WikiLink/...': obsTags.internalLink } },
    { name: 'Embed', style: { 'Embed/...': obsTags.embed } },
    { name: 'WikiMark', style: t.processingInstruction },
    { name: 'WikiPipe', style: t.processingInstruction },
    'WikiTarget', 'WikiAlias',
  ],
  parseInline: [
    { name: 'Embed', parse: (cx, next, pos) => (next === BANG ? parseWiki(cx, next, pos) : -1), before: 'Image' },
    { name: 'WikiLink', parse: (cx, next, pos) => (next === LBRACK ? parseWiki(cx, next, pos) : -1), before: 'Link' },
  ],
};

// ---- ==highlight== (delimiters, like GFM strikethrough) -------------------------------
const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };
export const Highlight = {
  defineNodes: [
    { name: 'Highlight', style: { 'Highlight/...': obsTags.highlight } },
    { name: 'HighlightMark', style: t.processingInstruction },
  ],
  parseInline: [{
    name: 'Highlight',
    parse(cx, next, pos) {
      if (next !== EQ || cx.char(pos + 1) !== EQ || cx.char(pos + 2) === EQ) return -1;
      const before = cx.slice(pos - 1, pos), after = cx.slice(pos + 2, pos + 3);
      const sBefore = /\s|^$/.test(before), sAfter = /\s|^$/.test(after);
      return cx.addDelimiter(HighlightDelim, pos, pos + 2, !sAfter, !sBefore);
    },
    after: 'Emphasis',
  }],
};

// ---- fenced blocks of Obsidian's own: $$ math $$ and %% comments %% ----------------------
function fenceBlock(name, markName, fence) {
  const f0 = fence.charCodeAt(0);
  return {
    name,
    parse(cx, line) {
      if (line.next !== f0 || !line.text.startsWith(fence, line.pos)) return false;
      const start = cx.lineStart + line.pos;
      const rest = line.text.slice(line.pos + 2);
      const sameLine = rest.indexOf(fence);
      const marks = [cx.elt(markName, start, start + 2)];
      if (sameLine >= 0) {
        // "$$ x $$" / "%% x %%" on one line is only a block when nothing follows it.
        if (rest.slice(sameLine + 2).trim() !== '') return false;
        const c = start + 2 + sameLine;
        marks.push(cx.elt(markName, c, c + 2));
        cx.nextLine();
        cx.addElement(cx.elt(name, start, c + 2, marks));
        return true;
      }
      let end = cx.lineStart + line.text.length;
      while (cx.nextLine() && line.depth >= cx.stack.length) {
        for (const m of line.markers) marks.push(m);
        const i = line.text.indexOf(fence, line.pos);
        if (i >= 0) {
          marks.push(cx.elt(markName, cx.lineStart + i, cx.lineStart + i + 2));
          end = cx.lineStart + i + 2;
          cx.nextLine();
          cx.addElement(cx.elt(name, start, end, marks));
          return true;
        }
        end = cx.lineStart + line.text.length;
      }
      cx.addElement(cx.elt(name, start, end, marks)); // unclosed: runs to the end, as in Obsidian
      return true;
    },
    endLeaf: (cx, line) => line.text.startsWith(fence, line.pos) && line.text.slice(line.pos + 2).indexOf(fence) < 0,
    before: 'FencedCode',
  };
}

function parseInlineMath(cx, next, pos) {
  if (next !== DOLLAR) return -1;
  if (cx.char(pos + 1) === DOLLAR) {
    const close = cx.slice(pos + 2, cx.end).indexOf('$$');
    if (close <= 0) return -1;
    const c = pos + 2 + close;
    return cx.addElement(cx.elt('DisplayMath', pos, c + 2, [cx.elt('MathMark', pos, pos + 2), cx.elt('MathMark', c, c + 2)]));
  }
  // $x$: no space just inside the dollars, no digit right after the closing one ($5 and $10 is money).
  if (isSpace(cx.char(pos + 1))) return -1;
  for (let i = pos + 1; i < cx.end; i++) {
    const c = cx.char(i);
    if (c === NL) return -1;
    if (c === BACKSLASH) { i++; continue; }
    if (c === DOLLAR) {
      if (isSpace(cx.char(i - 1))) return -1;
      const n = cx.char(i + 1); if (n >= 48 && n <= 57) return -1;
      return cx.addElement(cx.elt('InlineMath', pos, i + 1, [cx.elt('MathMark', pos, pos + 1), cx.elt('MathMark', i, i + 1)]));
    }
  }
  return -1;
}

export const MathSyntax = {
  defineNodes: [
    { name: 'MathBlock', block: true, style: { 'MathBlock/...': obsTags.math } },
    { name: 'InlineMath', style: { 'InlineMath/...': obsTags.math } },
    { name: 'DisplayMath', style: { 'DisplayMath/...': obsTags.math } },
    { name: 'MathMark', style: t.processingInstruction },
  ],
  parseBlock: [fenceBlock('MathBlock', 'MathMark', '$$')],
  parseInline: [{ name: 'InlineMath', parse: parseInlineMath, before: 'Emphasis' }],
};

export const Comments = {
  defineNodes: [
    { name: 'ObsCommentBlock', block: true, style: { 'ObsCommentBlock/...': t.comment } },
    { name: 'ObsComment', style: { 'ObsComment/...': t.comment } },
    { name: 'ObsCommentMark', style: t.processingInstruction },
  ],
  parseBlock: [fenceBlock('ObsCommentBlock', 'ObsCommentMark', '%%')],
  parseInline: [{
    name: 'ObsComment',
    parse(cx, next, pos) {
      if (next !== PCT || cx.char(pos + 1) !== PCT) return -1;
      const close = cx.slice(pos + 2, cx.end).indexOf('%%');
      if (close < 0) return -1;
      const c = pos + 2 + close;
      return cx.addElement(cx.elt('ObsComment', pos, c + 2, [cx.elt('ObsCommentMark', pos, pos + 2), cx.elt('ObsCommentMark', c, c + 2)]));
    },
    before: 'Emphasis',
  }],
};

// ---- #tags -------------------------------------------------------------------------------
const TAG_BODY = /^[\p{L}\p{N}_/\-\p{Extended_Pictographic}]+/u;
export const Hashtags = {
  defineNodes: [
    { name: 'Hashtag', style: obsTags.hashtag },
    { name: 'HashtagMark', style: t.processingInstruction },
  ],
  parseInline: [{
    name: 'Hashtag',
    parse(cx, next, pos) {
      if (next !== HASH) return -1;
      if (pos > cx.offset && !/[\s(,;]/.test(cx.slice(pos - 1, pos))) return -1;
      const m = TAG_BODY.exec(cx.slice(pos + 1, Math.min(cx.end, pos + 200)));
      if (!m || /^[\d/]+$/.test(m[0])) return -1;          // needs a non-digit (#1984 is not a tag)
      return cx.addElement(cx.elt('Hashtag', pos, pos + 1 + m[0].length, [cx.elt('HashtagMark', pos, pos + 1)]));
    },
  }],
};

// ---- ^block-ids and footnotes ------------------------------------------------------------
export const BlockIds = {
  defineNodes: [{ name: 'BlockId', style: obsTags.blockId }],
  parseInline: [{
    name: 'BlockId',
    parse(cx, next, pos) {
      if (next !== CARET || !isSpace(cx.char(pos - 1)) && pos > cx.offset) return -1;
      const m = /^\^[A-Za-z0-9-]+[ \t]*(?=\n|$)/.exec(cx.slice(pos, cx.end));
      if (!m) return -1;
      return cx.addElement(cx.elt('BlockId', pos, pos + m[0].trimEnd().length));
    },
  }],
};

export const Footnotes = {
  defineNodes: [
    { name: 'FootnoteRef', style: obsTags.footnote },
    { name: 'InlineFootnote', style: obsTags.footnote },
  ],
  parseInline: [
    {
      name: 'FootnoteRef',
      parse(cx, next, pos) {
        if (next !== LBRACK || cx.char(pos + 1) !== CARET) return -1;
        const m = /^\[\^[^\]\s]+\]/.exec(cx.slice(pos, Math.min(cx.end, pos + 100)));
        return m ? cx.addElement(cx.elt('FootnoteRef', pos, pos + m[0].length)) : -1;
      },
      before: 'Link',
    },
    {
      name: 'InlineFootnote',
      parse(cx, next, pos) {
        if (next !== CARET || cx.char(pos + 1) !== LBRACK) return -1;
        let depth = 0;
        for (let i = pos + 1; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === LBRACK) depth++;
          else if (c === RBRACK && --depth === 0) return cx.addElement(cx.elt('InlineFootnote', pos, i + 1));
        }
        return -1;
      },
    },
  ],
};

// ---- tasks with any status character (- [ ] - [x] - [/] - [-] - [?] …) ------------------
class TaskParser {
  nextLine() { return false; }
  finish(cx, leaf) {
    cx.addLeafElement(leaf, cx.elt('Task', leaf.start, leaf.start + leaf.content.length, [
      cx.elt('TaskMarker', leaf.start, leaf.start + 3),
      ...cx.parser.parseInline(leaf.content.slice(3), leaf.start + 3),
    ]));
    return true;
  }
}
export const Tasks = {
  defineNodes: [
    { name: 'Task', block: true, style: t.list },
    { name: 'TaskMarker', style: t.atom },
  ],
  parseBlock: [{
    name: 'TaskList',
    leaf(cx, leaf) { return /^\[[^\]\n]\](?:[ \t]|$)/.test(leaf.content) && cx.parentType().name === 'ListItem' ? new TaskParser() : null; },
    after: 'SetextHeading',
  }],
};

// Everything Obsidian understands, on top of CommonMark.
export const obsidianMarkdown = [Table, Strikethrough, Autolink, Tasks, WikiLinks, Highlight, MathSyntax, Comments, Hashtags, Footnotes, BlockIds];
