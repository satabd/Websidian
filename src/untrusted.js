'use strict';
// Per-site `untrusted: true` mode, for folders whose Markdown is written by
// someone (or something, e.g. an AI agent) you do not fully trust:
//   - notes render without raw HTML (see render.js)
//   - only media/PDF attachments are served; SVG gets a sandboxing CSP
//   - every HTML page gets a Content-Security-Policy with a per-request nonce
//   - mermaid runs with securityLevel "strict" (flag on <html data-untrusted>)

const crypto = require('crypto');

// Attachments an untrusted site serves inline. Everything else is a 404: an
// agent's folder can hold .html (script on our origin), auth.json, state.db…
const SERVABLE = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico',
  '.pdf',
  '.mp3', '.m4a', '.ogg', '.oga', '.wav', '.flac',
  '.mp4', '.webm', '.mov', '.m4v',
  '.svg',
]);
function isServableAttachment(ext) {
  const e = String(ext || '').toLowerCase();
  return SERVABLE.has(e.startsWith('.') ? e : '.' + e);
}

// SVG is fine inside <img>; opened directly it must not run script.
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

function makeNonce() { return crypto.randomBytes(16).toString('base64'); }

// No frame-ancestors: embed mode (?embed=1) is meant for iframes on other sites.
function pageCsp(nonce) {
  return `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'`;
}

// ` nonce="…"` for a <script> tag, or '' (trusted sites render unchanged).
function nonceAttr(nonce) { return nonce ? ` nonce="${nonce}"` : ''; }

// Admin-configured HTML (brand.headHtml, e.g. analytics): give its <script> tags the nonce.
function withNonce(html, nonce) {
  if (!nonce || !html) return html;
  return String(html).replace(/<script\b(?![^>]*\snonce=)/gi, `<script nonce="${nonce}"`);
}

module.exports = { isServableAttachment, SVG_CSP, makeNonce, pageCsp, nonceAttr, withNonce, SERVABLE };
