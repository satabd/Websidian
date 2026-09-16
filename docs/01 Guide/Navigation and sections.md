---
title: Navigation and sections
tags: [websidian, guide]
updated: 2026-09-16
order: 6
description: Decide the reading order, and give each folder a page
---
# Navigation and sections

By default the sidebar is alphabetical, which is almost never the order you want people to read in. `Configuration` sorts above `Quick start`; a newcomer meets the reference material first.

Two pieces of frontmatter fix that, and neither needs a config file.

## `order:` decides the sidebar

Put a number in a note's frontmatter:

```yaml
---
title: Quick start
order: 1
---
```

- Notes **with** `order:` come first, ascending.
- Notes **without** it follow, in the natural sort they had before.
- Ties fall back to the natural sort, so you can give three notes `order: 1` and they still sort predictably.
- A non-numeric `order:` is ignored rather than guessed at.

This is exactly how these docs are ordered — [[Quick start]] first, [[Hermes plugin]] last — and it also drives the **Previous / Next** pager at the bottom of each page.

## A folder note makes the folder a page

Name a note after the folder that holds it and it becomes that folder's page:

```
01 Guide/
  01 Guide.md      ← the folder note
  Quick start.md
  Your first site.md
```

`Folder/index.md` works too, for vaults that came from a static site generator.

The folder note:

- is served at the **folder's URL** — `/site/01 Guide/`, not `/site/01 Guide/01 Guide`. The longer URL redirects (`301`) to the short one, so old links keep working.
- **names the folder** in the sidebar, with its `title:`. A `folderNames` entry in the config still wins ([[Configuration]]).
- **orders the folder** among its siblings, with its `order:`.
- is **not listed inside itself**, so it does not appear twice.
- has **no Previous / Next** — it is the section, not a step within it.

![[site-section-page.png]]

## Sections are listed for you

Under a folder note, Websidian appends **In this section**: every note and subfolder it contains, in navigation order, with each note's `description:` and `updated:` if it has them. You do not maintain that list, so it cannot fall out of step with the folder.

A folder **without** a folder note gets the whole page generated the same way, instead of a `404`. Visit `/site/02 Reference/` and you get a heading, a line of context and the list.

Give a note a `description:` and it shows up next to its title in these lists:

```yaml
---
title: Quick start
order: 1
description: Two commands and a browser
---
```

Turn the generated pages off for a site with:

```json
"sectionIndex": false
```

Then a folder without a folder note is a `404` again, and a folder note renders on its own with no appended list.

> [!note] Hidden notes stay hidden
> Drafts and unpublished notes are absent from these lists and from the counts, exactly as they are absent from the sidebar and search — [[Publishing and visibility]].

## Putting it together

For a vault you want read in a particular order:

1. Give each section a folder note with a `title:`, an `order:` and a sentence of introduction.
2. Give each note inside it an `order:`.
3. Add `description:` to the notes worth summarising.

The sidebar, the section pages, the Previous / Next pager and the breadcrumbs all follow from those three, and nothing has to be listed by hand.

See also: [[Configuration]], [[URLs and endpoints]], [[Publishing and visibility]].
