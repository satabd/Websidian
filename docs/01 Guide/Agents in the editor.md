---
title: Agents in the editor
tags: [websidian, guide, editor, ai, agents]
updated: 2026-09-23
order: 5.5
description: Review or edit notes with Claude Code, Codex, Hermes or OpenClaw, in one continuing conversation
---
# Agents in the editor

Optional. When it is configured, the editor gains a **◈ Agents** button (`Alt+A`) that opens a panel beside the note. There you talk to an agent — **Claude Code**, **Codex**, **Hermes Agent** or **OpenClaw** — about the note you have open: ask it to review the note, check links, find related notes, or (if you allow it) change the note for you.

![[editor-agents.png]]

It is different from [[Writing help]]. Writing help rewrites a selection with a fixed instruction and never touches the disk. An agent reads the vault itself, follows links, uses the [Obsidian skills](https://github.com/kepano/obsidian-skills), and in **Edit** mode it writes files — every one of which comes back to you as a diff with a **Revert** button.

## One conversation, not one prompt per message

Each agent keeps **one conversation per note** (or per vault — see `sessionScope`). The conversation is a session of the agent's own CLI:

| Agent | Kept by |
|---|---|
| Claude Code | `claude -p --session-id …`, then `--resume <id>` |
| Codex | `codex exec`, then `codex exec resume <thread id>` |
| Hermes Agent | `hermes chat`, then `--resume <session id>` |
| OpenClaw | `openclaw agent --session-id <id>` — the Gateway keeps it |

So the **first** message carries the context — who you are, which vault, which note, which mode, the skills and where they are — and every later message carries **only what you typed**. The agent remembers the rest. Measured on 2026-09-23: a follow-up on a resumed Claude Code session cost $0.016 and was answered from memory, without reading the note again.

What changes between messages is added in one line: *"[Websidian: The open note is now …]"* when you moved to another note (vault scope), the new mode's rules when you switch between Review and Edit, and a line saying you have unsaved changes.

**⟲** in the panel's header starts a new conversation. The agent's CLI keeps its own copy of the old one.

## Review and Edit

| Mode | What the agent may do | Enforced by |
|---|---|---|
| **Review** (default) | Read the vault; answer in the chat, quoting lines and putting replacement text in fenced blocks | Claude Code: only `Read`, `Glob`, `Grep`, `Skill` exist, in `dontAsk` mode, with reads — and so `Grep` and `Glob` — limited to the vault and the skills folder. Codex: the `read-only` sandbox. **Hermes and OpenClaw: by instruction only** — they cannot be locked from the command line |
| **Edit** (opt-in per agent) | Change and create files in the vault | Claude Code: `Edit`/`Write` inside the vault only, never `.git/`, `.obsidian/`, `.trash/` or an agent instruction file. Codex: the `workspace-write` sandbox |

Whatever the mode, Websidian **snapshots the vault before the turn and compares it after**. Every file that changed is listed under the reply:

- **Diff** shows the change (open by default when there is one file, or when something looks wrong).
- **Revert** puts the file back the way it was before the turn — refused if it has changed again since, so a later edit is never thrown away. A file the agent **created** is moved to `.trash/`, like a delete.
- A change made in **Review** mode is flagged *"⚠ Changed in Review mode"* — that is how you would notice Hermes or OpenClaw writing when it was asked not to.
- An **agent instruction file** (`SOUL.md`, `AGENTS.md`, `MEMORY.md`… — the `edit.protect` list, or its defaults) is marked in red.

If the agent changed the note you have open, the editor reloads it in place — cursor, scroll and Properties stay where they were. If you had unsaved edits, it does not; the next save meets the usual conflict banner. In Edit mode the panel **saves your note first**, because the agent works on the file on disk.

> [!warning] Edit mode is a person with write access
> An agent in Edit mode can change any note in the vault, not just the open one. Review its diffs the way you would review a colleague's. The instruction files are denied to Claude Code and flagged for the others, but a note an agent writes can still say anything.

## Turning it on

```json
"agents": {
  "list": [
    { "id": "claude", "backend": "claude-cli", "model": "claude-opus-5", "effort": "medium", "modes": ["review", "edit"] },
    { "id": "codex",  "backend": "codex-cli",  "model": "gpt-5.5", "windowsSandbox": "unelevated", "modes": ["review", "edit"] },
    { "id": "hermes", "backend": "hermes-cli", "effort": "low" },
    { "id": "claw",   "backend": "openclaw-cli", "command": ["docker", "exec", "-i", "clawat02", "openclaw"],
      "agent": "main", "paths": { "docs": "/home/node/vaults/docs" } }
  ]
}
```

```bash
npm run skills
```

That fetches the Obsidian skills into `agent-skills/obsidian-skills` (a `git clone`, run it again to update). Every agent is signed in the way you already use it — `claude login`, `codex login`, `hermes setup`, OpenClaw's own — **as the user the server runs as**. No API key is involved.

At start the server runs each agent's `<command> --version`. One that does not answer is left out with a warning, and with none left there is no panel at all. On Windows, an npm-installed CLI that exists only as a `.cmd` shim (Codex) is run through its script with Node, so nothing is ever spawned through a shell.

### Every agent is configured on its own

| Key | Meaning |
|---|---|
| `id` | Short name, used in URLs and the session file. Default: the backend without `-cli` |
| `backend` | `claude-cli`, `codex-cli`, `hermes-cli` or `openclaw-cli` |
| `label` | Shown in the panel. Default: the product's name |
| `command` | The executable, or an argv array to wrap it — e.g. `["docker", "exec", "-i", "box", "openclaw"]`. Default `claude`, `codex`, `hermes`, `openclaw` |
| `model` | Passed as the CLI's model flag. Unset: the CLI's own default |
| `effort` | Claude `--effort`, Codex `model_reasoning_effort`, Hermes `--reasoning`, OpenClaw `--thinking` |
| `modes` | `["review"]` (default) or `["review", "edit"]`. Edit is never on unless listed |
| `sites`, `users` | Only these site slugs / editor user names see the agent |
| `timeoutMs` | Stop the agent after this long. Default `agents.timeoutMs`, 15 minutes |
| `args` | Extra arguments, appended as given |
| `env` | Extra environment variables for this agent only |
| `instructions` | A line added to this agent's first message |
| `skills` | `false` keeps the skills away from this agent |
| `paths` | `{ "<site slug>": "<path>" }` — the vault as the agent sees it, for an agent in a container. The agent is then started in the temp directory and told the path |
| `enabled`, `probe` | `false` to leave an agent configured but off; `probe: false` skips the `--version` check |
| `tools` | `claude-cli`: the tool list, instead of the mode's default |
| `sandbox` | `codex-cli`: `{ "review": "read-only", "edit": "workspace-write" }` |
| `windowsSandbox` | `codex-cli`: `"unelevated"` or `"elevated"`. See [[Known issues#Agents]] |
| `toolsets`, `provider`, `preloadSkills`, `ignoreRules` | `hermes-cli`: `-t`, `--provider`, `-s` (installed Hermes skills), and `ignoreRules: false` to let Hermes read its `AGENTS.md`/`SOUL.md`/memory (skipped by default) |
| `agent`, `local` | `openclaw-cli`: `--agent <id>`, and `--local` to run embedded instead of through the Gateway |

And for all of them:

| Key | Meaning |
|---|---|
| `agents.skills` | Folders of skills. Default: `agent-skills/obsidian-skills` when it exists. A folder with `.claude-plugin/` is also loaded into Claude Code as a plugin (`--plugin-dir`); every agent gets the list of skills with the path of each `SKILL.md` in its first message. `false` for none |
| `agents.sessionScope` | `note` (default): one conversation per note. `vault`: one per agent across the vault, told when you move to another note |
| `agents.instructions` | A line added to every agent's first message |
| `agents.timeoutMs` | Default time limit per turn, 900000 |
| `agents.stateFile` | Where the session ids and the panel's transcript live. Default `.websidian/agent-sessions.json` next to where the server starts |
| `rateLimit.agents` | Turns per minute per address, default 10 |
| `sites[].agents` | `false` turns the panel off for one site |

## Using it

| | |
|---|---|
| `Alt+A`, **◈ Agents**, or *Agents: Toggle the agent panel* in `Ctrl+P` | Open or close the panel |
| `Enter` / `Shift+Enter` | Send / new line |
| **Stop** | Kill the running turn |
| The agent menu, **Review / Edit** | Pick the agent and the mode; both are remembered per browser |
| A selection in the note | Sent with your message, marked *with selection* |

With an empty conversation the panel offers four starters: *Review this note*, *Check links and syntax*, *Find related notes* and, for an agent that may edit, *Tidy the frontmatter*.

A turn keeps running if you reload the page; the panel picks it up again. Replies are rendered like a note — `[[wikilinks]]` resolve and open in a new tab — but **never with raw HTML**, whatever the site allows: the agent may have read a note that told it to write some.

## How it is wired

- `GET /<site>/_api/agents` (the menu), `POST …/agents/<id>/turn` (starts a turn, answers `202` with a turn id), `GET …/agent-turns/<turn>` (poll), `…/cancel`, `…/revert`, `GET`/`DELETE …/agents/<id>/session`, `POST …/agents/render`. All behind the editor's sign-in, IP allowlist and `X-Requested-With` check — [[URLs and endpoints]].
- The CLI is spawned as an argv array with `shell: false`; your message goes to its **stdin**, never onto its command line.
- One turn at a time per conversation, and one **Edit** turn at a time per vault — two agents writing at once would each see the other's changes as their own.
- A failure is logged in full on the server and reaches the browser as one line. A session the CLI no longer knows is forgotten, so the next message starts a new one.
- What Revert needs — the text of each file before the turn — is kept in memory for the last 50 turns, not on disk.

See also: [[Writing help]], [[Editing in the browser]], [[Configuration]], [[Agent memory and second brain]].
