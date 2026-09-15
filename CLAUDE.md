# Websidian (md2html)

Obsidian vaults served as a website, with a browser editor. Read `README.md` for usage and `docs/` for the full reference.

## Keep the docs vault current
`docs/` is an Obsidian vault and the project's living reference. With every change you make in a session, update it in the same session:

- `docs/04 Planning/Work log.md` — add a dated entry (newest first): what changed, what was learned, what is next.
- `docs/02 Reference/Feature status.md` — move rows between ⬜ / 🚧 / 🟡 / ✅.
- The guide note for the feature (`docs/01 Guide/…`) — how to use it, hotkeys, config keys.
- `docs/02 Reference/Known issues.md` — add limits you found; remove fixed ones.
- `docs/04 Planning/Improvements backlog.md` — add suggestions; remove shipped items.
- `docs/03 Internals/Decisions.md` — any decision the user confirms.
- Bump `updated:` in the frontmatter of notes you touch.

Write Obsidian Flavored Markdown (wikilinks by note name, callouts, frontmatter with `tags`). Every `[[link]]` must point at an existing note. Mark features honestly: "done" means tested in a browser on real content.

## Working rules
- `npm test` must pass. Editor changes: also check in a browser on a copy of a real vault (see `docs/03 Internals/Testing.md`).
- One Node process, no database, no build step. Editor HTML/CSS uses Obsidian's class names.
- Public site and editor stay separate surfaces; editor features are opt-in.
