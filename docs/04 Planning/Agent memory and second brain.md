---
title: Agent memory and second brain
tags: [websidian, planning, agents]
aliases: [Hermes, OpenClaw]
updated: 2026-09-17
order: 4
description: A vault as an agent's second brain
---
# Agent memory and second brain

Using Websidian to read and edit what AI agents write: their memory, instructions, skills, and the notes they keep.

## What the agents keep (found 2026-09-11)
### Hermes (`hermes01` container)
- `~/.hermes/memories/MEMORY.md` and `USER.md` — entries separated by `§`, with character limits (2,200 and 1,375). Both were nearly full.
- `~/.hermes/skills/` — 182 `SKILL.md` files.
- `/root/Documents/Obsidian Vault` — an Obsidian vault the agent writes (`00 Inbox`, `50 Sources`).
- Sessions: JSON files and a 300 MB `state.db`. Not in git.
- Checkpoints: one shared git store in `~/.hermes/checkpoints/store`, a history per working folder, snapshot before each file write. **Memory files are not covered.**
- **No volumes**: all of the above lives only inside the container.

### OpenClaw (`openclaw-clawat02`)
- Data mounted from `D:\VibeProjects\OpenclawTools\.openclaw-tools\instances\clawat02\data`.
- `workspace/`: `AGENTS.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`, `TOOLS.md`, `HEARTBEAT.md`, daily notes in `memory/`.

## How Websidian helps
- See and edit both agents' memory in one browser, from any device.
- Conflict detection when the agent writes the file while you edit it.
- The Obsidian-like editor for `SOUL.md` and skills.

## Safety model
> [!danger] Editing an instruction file = instructing the agent
> Whatever `SOUL.md`, `MEMORY.md` or a `SKILL.md` says, the agent follows next session — including running commands. And a note written by an agent can contain prompt-injected HTML.

- Serve agent folders as **`"untrusted": true`** sites ✅: no raw HTML in notes, strict mermaid, only media/PDF/audio/video attachments (SVG sandboxed), a Content-Security-Policy with per-request nonces, CSS snippets off unless set.
- **`edit.protect`** ✅: opening a protected file shows a red notice; saving or deleting it asks for confirmation (the API answers `428` until the request carries `confirm: "instructions"`). Defaults on untrusted sites: `SKILL.md`, `SOUL.md`, `AGENTS.md`, `MEMORY.md`, `USER.md`, `TOOLS.md`, `IDENTITY.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`.
- **`edit.memoryLimits`** ✅: the confirmation lists a warning when `memories/MEMORY.md` or `USER.md` is over the agent's limit (defaults 2,200 / 1,375 characters).
- **Link-safe writes** ✅: the editor refuses to write through a symlink or Windows junction that leads outside the vault.
- **Sign-in rate limit** ✅: failed basic-auth logins are limited per IP (`rateLimit.login`).
- **Hermes plugin** ✅ installed in `hermes01` and tested with a real agent session (CLI, test vault): approval before the agent writes instruction files, blocks active HTML in vault notes, view/edit links for notes it writes, `/brain` command — [[Hermes plugin]].
- **Never** point a site root at `~/.hermes` or an OpenClaw data folder itself: it holds `auth.json`, `.env`, databases. Point only at `memories/`, `skills/`, `workspace/` or a vault folder.

Configuration keys: [[Configuration]].

## OpenClaw (2026-09-17)
The same protections exist for OpenClaw as an OpenClaw plugin — [[OpenClaw plugin]]: the guard runs in `before_tool_call` (approval through OpenClaw's plugin approvals), links in `message_sending`, and the vaults are served behind the Gateway at `/plugins/websidian/` with a sign-in by Gateway token. Deployed into `clawat02` on 2026-09-17 with the workspace as a read-only vault: `http://127.0.0.1:18794/plugins/websidian/` (sign in with the Gateway token). The first real chat turn through it waits for the OpenAI weekly quota ([[Improvements backlog#For agent memory|A9]]).

## Now (2026-09-13)
The second brain (206 notes), Hermes memories and skills (1,023) open in the **Websidian tab of the Hermes dashboard**, as untrusted, editable sites with protected instruction files — [[Hermes plugin#Dashboard tab]].

## Example site entries
```json
{ "slug": "openclaw", "title": "OpenClaw workspace", "untrusted": true,
  "root": "D:/VibeProjects/OpenclawTools/.openclaw-tools/instances/clawat02/data/workspace",
  "auth": { "users": { "sat": "…" } },
  "edit": { "users": { "sat": "…" }, "allowFrom": ["127.0.0.1", "::1"], "secret": "…" } }
```

## Open steps
See [[Improvements backlog#For agent memory|agent items A1–A4]]. A1 (mount Hermes folders) restarts the agent and needs a backup first — not done without approval.
