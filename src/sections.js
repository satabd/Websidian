'use strict';
// Section pages: what a folder's URL serves.
//
// A folder with a folder note (`Guide/Guide.md`) serves that note. A folder
// without one still deserves a page rather than a 404, so we generate an index
// from the navigation tree — the same order the sidebar uses. Either way the
// list of what is in the section is generated, so it cannot go stale.

const { escapeHtml } = require('./render');

// Notes carry `description:` or `summary:` in frontmatter often enough to be
// worth showing; nothing is invented when they do not.
// js-yaml turns `updated: 2026-09-16` into a Date, so a plain typeof check
// would drop every date in the vault.
function plain(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return typeof v === 'object' ? '' : String(v);
}

function noteMeta(vault, rel) {
  const n = rel ? vault.note(rel) : null;
  if (!n || !n.data) return {};
  return {
    description: plain(n.data.description != null ? n.data.description : n.data.summary),
    updated: plain(n.data.updated != null ? n.data.updated : n.data.date),
  };
}

function countNotes(node) {
  return node.notes.length + node.folders.reduce((sum, f) => sum + countNotes(f) + (f.rel ? 1 : 0), 0);
}

// One <li> per entry, with whatever description and date the note carries.
function entries(vault, node) {
  const rows = [];
  for (const f of node.folders) {
    const n = countNotes(f);
    rows.push({
      url: f.url || vault.folderUrl(f.path),
      title: f.title,
      isFolder: true,
      ...noteMeta(vault, f.rel),
      count: n,
    });
  }
  for (const n of node.notes) {
    rows.push({ url: n.url, title: n.title, isFolder: false, ...noteMeta(vault, n.rel) });
  }
  return rows;
}

function listHtml(vault, node) {
  const rows = entries(vault, node);
  if (!rows.length) return '<p class="muted">This section is empty.</p>';
  return `<ul class="section-index">${rows.map(r => {
    const meta = [];
    if (r.isFolder) meta.push(`${r.count} note${r.count === 1 ? '' : 's'}`);
    if (r.updated) meta.push(`updated ${escapeHtml(r.updated)}`);
    return `<li class="section-item${r.isFolder ? ' is-folder' : ''}">`
      + `<a class="section-link" href="${r.url}">${r.isFolder ? '▸ ' : ''}${escapeHtml(r.title)}</a>`
      + (r.description ? `<span class="section-desc">${escapeHtml(r.description)}</span>` : '')
      + (meta.length ? `<span class="section-meta">${meta.join(' · ')}</span>` : '')
      + `</li>`;
  }).join('')}</ul>`;
}

// The whole body for a folder that has no folder note.
function sectionPage(vault, node) {
  return `<h1>${escapeHtml(node.title)}</h1>`
    + `<p class="muted">Everything in this section, in navigation order.</p>`
    + listHtml(vault, node);
}

// Appended under a folder note's own content.
function sectionAppendix(vault, node) {
  const rows = entries(vault, node);
  if (!rows.length) return '';
  return `<section class="section-index-wrap"><h2 id="in-this-section">In this section</h2>${listHtml(vault, node)}</section>`;
}

module.exports = { sectionPage, sectionAppendix, listHtml, countNotes };
