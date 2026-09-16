'use strict';
// Excalidraw drawings on the site.
//
// The Obsidian Excalidraw plugin stores a drawing as a Markdown note
// (`Sketch.excalidraw.md`) whose `## Drawing` section holds the scene as a
// ```json or ```compressed-json (LZ-String, base64) fence, and whose
// `## Embedded Files` section maps image ids to vault files. Plain
// `.excalidraw` files (from excalidraw.com) are the same JSON on its own.
//
// The server parses that into a small, safe JSON document for the browser
// (`/site/_drawing/<path>`), and the browser mounts the real Excalidraw
// component in view mode — served from node_modules like mermaid and KaTeX.
// The viewer is Excalidraw 0.17.6: the last release with a browser build that
// needs no bundler. Newer drawings still open; see `mapFont` for what is approximated.

const path = require('path');
const { parseFrontmatter } = require('./vault');

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------------------
// LZ-String, decompressFromBase64 only (pieroxy/lz-string, MIT). The plugin
// inserts newlines into the base64 every 80 characters; they are ignored.
// ---------------------------------------------------------------------------
const KEY64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const REV64 = new Map([...KEY64].map((c, i) => [c, i]));

function decompressFromBase64(input) {
  const s = String(input || '').replace(/[^A-Za-z0-9+/=]/g, '');
  if (!s) return '';
  return lzDecompress(s.length, 32, i => REV64.get(s.charAt(i)));
}

function lzDecompress(length, resetValue, getNextValue) {
  const dictionary = [0, 1, 2];
  let enlargeIn = 4, dictSize = 4, numBits = 3, entry = '', w, c;
  const result = [];
  const data = { val: getNextValue(0), position: resetValue, index: 1 };
  const readBits = n => {
    let bits = 0, power = 1;
    const maxpower = 2 ** n;
    while (power !== maxpower) {
      const resb = data.val & data.position;
      data.position >>= 1;
      if (data.position === 0) { data.position = resetValue; data.val = getNextValue(data.index++); }
      bits |= (resb > 0 ? 1 : 0) * power;
      power <<= 1;
    }
    return bits;
  };
  switch (readBits(2)) {
    case 0: c = String.fromCharCode(readBits(8)); break;
    case 1: c = String.fromCharCode(readBits(16)); break;
    default: return '';
  }
  dictionary[3] = c; w = c; result.push(c);
  for (;;) {
    if (data.index > length) return '';
    c = readBits(numBits);
    switch (c) {
      case 0: dictionary[dictSize++] = String.fromCharCode(readBits(8)); c = dictSize - 1; enlargeIn--; break;
      case 1: dictionary[dictSize++] = String.fromCharCode(readBits(16)); c = dictSize - 1; enlargeIn--; break;
      case 2: return result.join('');
    }
    if (enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits++; }
    if (dictionary[c]) entry = dictionary[c];
    else if (c === dictSize) entry = w + w.charAt(0);
    else return null;
    result.push(entry);
    dictionary[dictSize++] = w + entry.charAt(0);
    enlargeIn--;
    w = entry;
    if (enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits++; }
  }
}

// ---------------------------------------------------------------------------
// File format
// ---------------------------------------------------------------------------

// The scene JSON of a drawing note or a plain .excalidraw file, or null when
// there is none. `embeds` lists the `## Embedded Files` section: id -> target
// (a [[vault file]], a URL, or something else the plugin knows and we skip).
function parseDrawing(src, { plainJson = false } = {}) {
  const text = String(src || '');
  let json = null;
  if (plainJson || /^\s*\{/.test(text)) json = text;
  else {
    const m = text.match(/^##\s+Drawing[ \t]*\r?\n```(compressed-json|json)[^\n]*\r?\n([\s\S]*?)\r?\n```/m);
    if (!m) return null;
    json = m[1] === 'compressed-json' ? decompressFromBase64(m[2]) : m[2];
  }
  let scene;
  try { scene = JSON.parse(json); } catch { return null; }
  if (!scene || typeof scene !== 'object' || !Array.isArray(scene.elements)) return null;
  const embeds = new Map();
  const sec = text.match(/^##\s+Embedded Files[ \t]*\r?\n([\s\S]*?)(?=^##\s|^%%|(?![\s\S]))/m);
  if (sec) for (const line of sec[1].split(/\r?\n/)) {
    const lm = line.match(/^([A-Za-z0-9_-]+):\s*(.+?)\s*$/);
    if (lm) embeds.set(lm[1], lm[2]);
  }
  return { scene, embeds };
}

// Excalidraw 0.17.6 knows four fonts. Later ones (Excalifont, Nunito, Lilita
// One, Comic Shanns…) are drawn with the closest of those: the layout survives
// because every text element carries its measured width and height.
function mapFont(id) {
  const n = Number(id);
  if (n === 1 || n === 2 || n === 3 || n === 4) return n;
  if (n === 6 || n === 7) return 2;   // Nunito, Lilita One -> Helvetica
  if (n === 8) return 3;              // Comic Shanns -> Cascadia (monospace)
  return 1;                           // Excalifont and anything unknown -> Virgil
}

// `[[Note|alias]]` -> alias, `[[Note]]` -> Note, `[alias](url)` -> alias, as the
// plugin shows them in the drawing.
function displayText(s) {
  return String(s).replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2').replace(/\[\[([^\]]*)\]\]/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif', '.ico': 'image/x-icon' };
const COLOR_RE = /^(#[0-9a-f]{3,8}|transparent|[a-z]{3,20})$/i;

// The document the browser gets: only the fields the viewer needs, nothing
// that could run or leak. Links are resolved like wikilinks; images that live
// in the vault come as URLs the browser fetches itself.
function toViewerScene(parsed, vault, fromRel) {
  const { scene, embeds } = parsed;
  const untrusted = !!vault.untrusted;
  const elements = [];
  for (const el of scene.elements) {
    if (!el || typeof el !== 'object' || el.isDeleted) continue;
    if (untrusted && (el.type === 'embeddable' || el.type === 'iframe' || el.type === 'magicframe')) continue;
    const out = { ...el };
    if (out.type === 'text') {
      out.fontFamily = mapFont(out.fontFamily);
      if (typeof out.text === 'string' && out.text.includes('[')) { out.text = displayText(out.text); out.originalText = displayText(out.originalText != null ? out.originalText : out.text); }
      delete out.rawText;
    }
    out.link = resolveLink(out.link, vault, fromRel);
    delete out.customData;
    elements.push(out);
  }
  const files = {};
  if (scene.files && typeof scene.files === 'object') {
    for (const [id, f] of Object.entries(scene.files)) {
      if (f && typeof f.dataURL === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(f.dataURL)) files[id] = { id, mimeType: String(f.mimeType || f.dataURL.slice(5, f.dataURL.indexOf(';'))), dataURL: f.dataURL, created: Number(f.created) || 0 };
    }
  }
  const images = {};
  for (const [id, target] of embeds) {
    if (files[id]) continue;
    const img = resolveEmbed(target, vault, fromRel, untrusted);
    if (img) images[id] = img;
  }
  const app = scene.appState && typeof scene.appState === 'object' ? scene.appState : {};
  const appState = {};
  if (typeof app.viewBackgroundColor === 'string' && COLOR_RE.test(app.viewBackgroundColor)) appState.viewBackgroundColor = app.viewBackgroundColor;
  // Old files: gridSize null means no grid. New files: gridSize is always set and gridModeEnabled says.
  const grid = app.gridModeEnabled === undefined ? Number.isFinite(app.gridSize) && app.gridSize > 0 : app.gridModeEnabled === true;
  if (grid) appState.gridSize = Number.isFinite(app.gridSize) && app.gridSize > 0 ? app.gridSize : 20;
  return { elements, appState, files, images, grid };
}

function resolveLink(link, vault, fromRel) {
  if (typeof link !== 'string' || !link.trim()) return null;
  const s = link.trim();
  const wl = s.match(/^\[\[([^\]|#]+)(?:#([^\]|]*))?(?:\|[^\]]*)?\]\]$/);
  if (wl) {
    const r = vault.resolve(wl[1].trim(), fromRel);
    if (!r) return null;
    const frag = wl[2] ? '#' + encodeURIComponent(wl[2].trim()) : '';
    return r.kind === 'note' ? vault.noteUrl(r.rel) + frag : vault.fileUrl(r.rel);
  }
  if (/^(https?:|mailto:)/i.test(s)) return s;
  const r = vault.resolve(s, fromRel);   // "Note" or "folder/Note" written without brackets
  return r ? (r.kind === 'note' ? vault.noteUrl(r.rel) : vault.fileUrl(r.rel)) : null;
}

// An `## Embedded Files` target -> { url, mimeType } or null.
function resolveEmbed(target, vault, fromRel, untrusted) {
  const t = String(target).trim();
  const wl = t.match(/^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/);
  if (wl) {
    const name = wl[1].trim();
    // A drawing inside a drawing: only its exported image can be shown.
    if (/\.excalidraw(\.md)?$/i.test(name)) {
      const stem = name.replace(/\.excalidraw(\.md)?$/i, '.excalidraw');
      const exp = vault.resolveFile(stem + '.svg', fromRel) || vault.resolveFile(stem + '.png', fromRel);
      return exp ? { url: vault.fileUrl(exp), mimeType: MIME[path.posix.extname(exp).toLowerCase()] } : null;
    }
    const f = vault.resolveFile(name, fromRel);
    if (!f) return null;
    const mime = MIME[path.posix.extname(f).toLowerCase()];
    return mime ? { url: vault.fileUrl(f), mimeType: mime } : null;
  }
  if (!untrusted && /^https?:\/\//i.test(t)) return { url: t, mimeType: MIME[path.posix.extname(t.split(/[?#]/)[0]).toLowerCase()] || 'image/png' };
  return null;   // LaTeX ($$…$$), unknown syntax
}

// Everything the server needs for one drawing: reads and parses the file.
async function loadDrawing(vault, rel) {
  const fsp = require('fs/promises');
  const abs = path.join(vault.root, rel);
  const text = await fsp.readFile(abs, 'utf8');
  const parsed = parseDrawing(/\.md$/i.test(rel) ? parseFrontmatter(text).body : text, { plainJson: !/\.md$/i.test(rel) });
  if (!parsed) return null;
  return toViewerScene(parsed, vault, rel);
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

// The markup for `![[Sketch.excalidraw]]` and for a drawing's own page. The
// exported image (if the plugin made one) sits inside as the no-script
// fallback and the og:image; the browser swaps in the live viewer.
function viewerHtml({ vault, drawing, exportRel, title, width, height, page = false }) {
  const name = title.replace(/\.excalidraw$/i, '');
  const fallback = exportRel
    ? `<img class="excalidraw" src="${vault.fileUrl(exportRel)}" alt="${escapeHtml(name)}" loading="lazy">`
    : `<span class="excalidraw-missing">✎ Drawing: ${escapeHtml(name)}</span>`;
  const style = page ? '' : [width ? `max-width:${width}px` : '', height ? `height:${height}px` : ''].filter(Boolean).join(';');
  return `<div class="excalidraw-view${page ? ' excalidraw-page' : ''}" data-drawing="${vault.drawingUrl(drawing)}"${page ? '' : ` data-page="${vault.noteUrl(drawing)}"`} data-title="${escapeHtml(name)}"${style ? ` style="${style}"` : ''}>${fallback}</div>`;
}

module.exports = { decompressFromBase64, parseDrawing, toViewerScene, loadDrawing, viewerHtml, mapFont, displayText, MIME };
