---
title: Editing in the browser
tags: [websidian, guide, editor]
updated: 2026-09-16
---
# Editing in the browser

Viewing is public; editing is a separate, opt-in surface. It exists only when `edit` is configured ([[Configuration]]), lives under `/<site>/_edit/…`, has its own login, and can be restricted to your network with `allowFrom`. Anonymous visitors never see an Edit button.

## The screen
- **Top bar** — path and save status, layout switch (**Edit** / **Split** / **Preview**), **+ New**, **Save**, **Delete** (moves to `.trash`), **View ↗** (the public page), theme, log out.
- **Left** — every note, drafts and unpublished ones included (shown in italics); filter box.
- **Middle** — the editor.
- **Right** (Split) — the page exactly as the site renders it.
- **Status bar** — backlinks, words, characters (of the selection too), **Live Preview / Source mode** switch.

![[editor-live-preview.png]]

## Live Preview and Source mode
Live Preview hides Markdown syntax except on the line you are editing and renders: links and wikilinks (`Note › Heading`), clickable checkboxes, bullets, callouts with icon and colour, images and `![[embeds]]` with sizes, inline and block math, mermaid diagrams, rules, and code blocks with highlighting. Source mode shows plain, highlighted Markdown. Switch with the status bar button or `Ctrl+P` → *Toggle Live Preview/Source mode*.

## Links
| Action | Result |
|---|---|
| Click a link | Cursor goes into it; its Markdown appears so you can edit it |
| `Ctrl`/`Cmd` + click | Follows it in the same tab (internal links open that note in the editor) |
| `Ctrl+Shift` + click, or middle click | New tab |
| `Alt+Enter` on a link | Follow the link under the cursor |
| Link to a note that does not exist | Following it opens a new note with that name |

Holding `Ctrl` shows links as clickable.

## Tables

![[editor-table.png]]

Tables at the top level of a note are edited as a grid.
- Click a cell: its Markdown appears with the caret where you clicked.
- `Tab` / `Shift+Tab` next / previous cell; `Enter` cell below; at the last row both add a new row.
- `Shift+Enter` inserts a line break (`<br>`); `Esc` leaves the table; `↑` / `↓` at the edges leave it too.
- `Ctrl+B` / `Ctrl+I` bold / italic inside a cell; `Ctrl+Z` undo works.
- Hover the table for the toolbar: **+ Row**, **− Row**, **+ Column**, **− Column**, align left / center / right, **</>** edit as Markdown.
- Only the edited cell changes in the file.

> [!note] Tables inside callouts or lists stay as Markdown source.

## Properties panel

![[editor-properties.png]]

The frontmatter shows as Obsidian's Properties panel instead of YAML.
- Text, dates (picker), date-times, numbers, checkboxes; lists as pills (`tags`, `aliases`, any list).
- Type a value in a list and press `Enter` or `,` to add a pill; `×` or `Backspace` removes one; suggestions come from values used elsewhere in the vault.
- Rename a property by editing its name; `×` at the row end removes it; **+ Add property** at the bottom.
- **</>** in the header edits the raw YAML; nested or multi-line values show as YAML and open the source when clicked.
- Types come from `.obsidian/types.json`, otherwise from the value (`true` → checkbox, `2026-09-06` → date…).
- Only the edited property changes in the file.

## Suggestions (autocomplete)

![[editor-command-palette.png]]

| Type | You get |
|---|---|
| `[[` | Notes, their aliases and attachments (fuzzy) plus "link to a new note" |
| `[[Note#` | That note's headings — `[[#` for this note |
| `[[Note#^` | That note's block ids |
| `![[` | Files first, then notes |
| `#` | Tags used in the vault, most used first |
| In frontmatter | Property names, and known values after `name: ` |
| `/` at a line start | Slash commands: callouts, table, code / math / mermaid block, headings, lists, date, time… |

## Arabic and English
Each line, table cell and property field takes its direction from its own text, so Arabic runs right to left next to English lines. Code blocks and math stay left to right.

## Saving and conflicts
- `Ctrl+S` saves. The public page, search and navigation update immediately.
- If the file changed on disk since you opened it (Obsidian on the desktop, git pull, sync, another editor), saving stops with a banner: **Discard mine & reload** or **Overwrite with mine**.
- **Autosave** (2 s after typing stops) is off by default because every save publishes; turn it on with `Ctrl+P` → *Toggle autosave* (remembered per browser).
- Leaving with unsaved changes asks first.
- **Delete** moves the note to the vault's `.trash`; nothing is destroyed. Line endings (CRLF) are preserved.

## Plain text fallback
Add `?textarea=1` to the URL, or use a browser without import maps, to get a plain text box with the same save, preview and `[[` suggestions.

See also: [[Editor hotkeys and commands]], [[Known issues]], [[Editor internals]].
