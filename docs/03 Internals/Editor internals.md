---
title: Editor internals
tags: [websidian, internals, editor]
updated: 2026-09-13
order: 2
description: How the CodeMirror editor is put together
---
# Editor internals

## Loading without a bundler
The editor page includes an **import map**. `src/esm.js` walks the dependency graph of the CodeMirror packages in `node_modules`, serves each package's ES module at `/_vendor/esm/<name>@<version>.js` (cached forever), and maps bare names like `@codemirror/view` to those URLs. Our modules in `public/cm/` are mapped with an mtime `?v=` so edits show up after a reload. If loading fails, `public/editor.js` keeps the plain textarea.

## Modules in `public/cm/`
| File | Role |
|---|---|
| `editor.js` | `createEditor()`: assembles extensions, reads vault settings, token classes |
| `syntax.js` | Obsidian Markdown as Lezer parser extensions: `WikiLink`, `Embed`, `Highlight`, `MathBlock`, `ObsComment`, `Hashtag`, `BlockId`, footnotes, any-character tasks |
| `live-preview.js` | Layer 1: Obsidian class names on lines and tokens (always on). Layer 2: Live Preview decorations and widgets. Link clicks |
| `blocks.js` | Table grid widget and Properties panel widget |
| `blocks-model.js` | Pure text models for tables and YAML: parse, and compute the smallest edit (no DOM, tested in Node) |
| `commands.js` | Editing commands and Obsidian hotkeys |
| `complete.js` | Suggestion sources: `[[`, `#`, properties, `/` |
| `vault-index.js` | Client-side link resolution (Obsidian rules), link text format, fuzzy matching, word count |
| `obsidian.css` | Styles written against Obsidian's class names and CSS variables |

## Principles
- **The file is the truth.** Widgets never keep their own copy: each keystroke becomes the smallest text change, so undo, save, conflicts and git diffs stay clean.
- **Obsidian's DOM.** Class names such as `HyperMD-header-2`, `cm-hmd-internal-link`, `metadata-property`, `table-editor` let Obsidian themes and snippets apply.
- **Block widgets** (tables, properties, math, mermaid) come from a state field because they replace line breaks; inline decorations come from a view plugin over the visible range.
- **No vertical margins on block widgets** — CodeMirror's height map ignores margins and clicks below land on the wrong line (bug found and fixed 2026-09-11). Use padding.

## Page shell (`public/editor.js`)
Loads the note, creates the editor (or textarea), save / conflict / autosave, rendered preview via `POST /_api/preview`, quick switcher and command palette (Obsidian's `.prompt` DOM), status bar, sidebar filter.

See [[Editor API]], [[Testing]].
