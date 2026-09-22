---
title: Editor hotkeys and commands
tags: [websidian, guide, editor, cheatsheet]
aliases: [Hotkeys, Shortcuts]
updated: 2026-09-23
order: 4
description: The cheat sheet
---
# Editor hotkeys and commands

`Ctrl` is `Cmd` on a Mac. Every command is also in the command palette (`Ctrl+P` or `Ctrl+Shift+P`).

## Page
| Keys | Action |
|---|---|
| `Ctrl+S` | Save |
| `Ctrl+O` | Quick switcher (`Shift+Enter` creates the typed note, `Ctrl+Enter` opens in a new tab) |
| `Ctrl+P` | Command palette (recently used first) |
| `Ctrl+Shift+P` | Command palette — the same thing, for when `Ctrl+P` is taken |
| `Ctrl+E` | Toggle reading view |
| `Ctrl+Alt+N` | New note |
| `Alt+W` | Writing help menu — only when the site has it ([[Writing help]]) |
| `Alt+A` | Agent panel — only when the server has `agents` ([[Agents in the editor]]) |
| Right-click in the editor | Writing help, Undo, Redo, Select all — only when the site has writing help; otherwise the browser's own menu |

> [!note] `Ctrl+P` and the print dialog
> In a browser `Ctrl+P` normally prints. The editor page cancels it while it has focus, so the palette opens instead. It cannot do that when the editor sits in an `<iframe>` and the **outer** page has focus — inside the Hermes dashboard, for example. `Ctrl+Shift+P` is the binding to reach for there, and the **✦ Writing help ▾** button always works.

## Formatting
| Keys | Action |
|---|---|
| `Ctrl+B` / `Ctrl+I` | Bold / italic (selection, or the word under the cursor; press again to remove) |
| `Ctrl+K` | Markdown link `[text](…)` |
| `Ctrl+/` | `%%comment%%` |
| Type `*` `_` `=` `~` `` ` `` `$` `%` over a selection | Wraps it |
| Paste a URL over a selection | Makes it a link |

## Lists and structure
| Keys | Action |
|---|---|
| `Enter` in a list | Continues the list; on an empty item, ends it |
| `Tab` / `Shift+Tab` | Indent / unindent list items |
| `Ctrl+]` / `Ctrl+[` | Indent / unindent |
| `Ctrl+L` | Plain line → `- [ ]` → `- [x]` → `- [ ]` |
| `Ctrl+D` | Delete paragraph (line) |
| `Ctrl+Shift+[` / `]` | Fold / unfold |

## Links and navigation
| Keys | Action |
|---|---|
| `Alt+Enter` | Follow link under cursor |
| `Ctrl+Enter` | Open link under cursor in a new tab; on a task line, toggle it |
| `Ctrl`+click | Follow link |
| `Alt`+click | Add a cursor |

## Search
| Keys | Action |
|---|---|
| `Ctrl+F` | Find in note |
| `Ctrl+H` | Find and replace |

## Command palette only
Toggle strikethrough, highlight, inline code, inline math · bullet / numbered list · blockquote · headings 1–6 / remove heading · insert callout (note, tip, info, warning, danger, example, question, todo, quote) · table · code / math / mermaid block · horizontal rule · date · time · footnote · fold / unfold all · Live Preview/Source · split view · editor only · autosave · sidebar · theme · delete file · open published page · graph view · reload with plain text editor.

## Slash commands
Type `/` at the start of a line (or after a space) and a few letters: `/table`, `/callout`, `/tip`, `/h2`, `/code`, `/math`, `/mermaid`, `/date`, `/todo`…
