---
title: Obsidian syntax support
tags: [websidian, reference]
updated: 2026-09-16
order: 2
description: What renders on the site, and what does not
---
# Obsidian syntax support

What the **public site** renders. The editor parses the same syntax — see [[Editing in the browser]].

| Syntax | Result |
|---|---|
| `[[Note]]`, `[[Note\|alias]]`, `[[Note#Heading]]`, `[[folder/Note]]` | Resolved like Obsidian: by name, same folder first, then shortest path. Unresolved links shown dashed |
| `![[image.png]]`, `![[image.png\|300]]`, `![[image.png\|300x200]]` | Images from anywhere in the vault |
| `![[Note]]`, `![[Note#Section]]`, `![[Note#^id]]` | Transclusion, 3 levels deep; the page re-renders when the embedded note changes |
| `![[file.pdf]]`, audio, video | Inline viewer or player |
| `> [!tip] Title`, `> [!faq]- folded`, `> [!note]+ open`, nested | Callouts with Obsidian's colours and aliases |
| ```` ```mermaid ```` | Diagrams, theme-aware |
| `==highlight==`, `%%comment%%`, `- [ ]`, `- [x]` | Mark, hidden, checkboxes |
| `^block-id` | Block anchors for links and embeds |
| `[^1]`, `^[inline]`, `$x$`, `$$…$$` | Footnotes and KaTeX math |
| `#tag`, `#nested/tag` | Tags |
| `![[Drawing.excalidraw]]`, `![[Drawing.excalidraw\|500]]`, `[[Drawing.excalidraw]]` | The live Excalidraw viewer (pan, zoom, images, links, dark mode); the link opens the drawing as a page — [[Excalidraw drawings]] |
| `Something.base` | Obsidian Bases table views |
| Frontmatter `title`, `lang`, `status`, `tags`, `description`, `cssclasses` | Title, direction, chips, meta tag, classes. Without `lang`, the page direction is detected from the note's letters |
| `translation:` / `translations:` | Language switch |
| Tables, code, raw HTML, `[text](Other Note.md)` | As in Obsidian's reading view |

Not supported: Dataview, Canvas, Bases card views, LaTeX inside Excalidraw drawings. In `untrusted` sites raw HTML is not rendered.
