---
title: Writing help
tags: [websidian, guide, editor, ai]
updated: 2026-09-16
order: 5
description: An AI in the editor, for rewriting rather than writing for you
---
# Writing help

Optional. When it is configured, the command palette gains a set of **Writing help** actions that rewrite the selected text — improve it, shorten it, expand it, summarise it, translate it, turn it into a list, or suggest a title or description.

![[editor-assist.png]]

It is off unless you turn it on, and it stays off unless the backend can actually work. A vault that does not want this has no route for it at all.

## Turning it on

The work is done by a **command-line tool you have already signed in to**, not by an API key. That is the point: a CLI runs on the subscription you are already paying for, and costs no API tokens.

```json
"assist": {
  "backend": "claude-cli",
  "effort": "low",
  "maxChars": 24000,
  "languages": ["Arabic", "English", "French"]
}
```

Three backends:

| `backend` | What it runs | What pays for it |
|---|---|---|
| `claude-cli` (default) | `claude -p` — the Claude Code CLI, in print mode with every tool disabled | Your Claude subscription. Sign in once with `claude login`; the server never sees a key |
| `hermes-cli` | `hermes chat --query-file -` — the Hermes Agent CLI, reading one query from stdin | Whatever provider Hermes is configured to use (your own ChatGPT or Claude sign-in). It uses the model **you** set in Hermes unless you name one here |
| `api` | The Anthropic SDK, directly | An API key, in tokens. Needs `apiKeyEnv` |

Whichever you pick, the CLI is run with **no shell** (so nothing in a note is ever interpreted as a command), with every tool disabled where the CLI allows it, and in the temp directory — so no `CLAUDE.md`, `AGENTS.md` or memory file from your vault or your projects is picked up.

> [!warning] Not `--bare`
> Claude Code's `--bare` would keep your own hooks and plugins out of the run too, but under it the CLI reads **only** `ANTHROPIC_API_KEY` or an `apiKeyHelper` — never the OAuth sign-in. It would ask for exactly the API tokens this backend avoids, so Websidian does not pass it. `"bare": true` is there for the case where you are giving Claude Code a key anyway.

| Key | Meaning |
|---|---|
| `backend` | `claude-cli` (default), `hermes-cli` or `api` |
| `command` | The executable to run. Default `claude` or `hermes`. Give a full path if it is not on the server's `PATH` |
| `model` | Default `claude-opus-5`. For `hermes-cli`, **unset by default** — Hermes then uses your own configured model and provider |
| `effort` | `low` (default), `medium`, `high`, `xhigh`, `max`; Hermes also takes `none`, `minimal`, `ultra`. Rewriting a paragraph does not need much |
| `timeoutMs` | Kill the CLI if it has not answered. Default 120000 |
| `bare` | `claude-cli` only, **default `false`**. `--bare` skips hooks, plugins and auto-memory, but under it Claude Code reads only `ANTHROPIC_API_KEY` or an `apiKeyHelper` and never your OAuth sign-in — it would ignore the subscription this backend exists to use. Turn it on only if you are feeding Claude Code an API key anyway |
| `toolsets` | `hermes-cli` only. Hermes cannot be told to run with no tools at all, so it runs with the toolsets you enabled in `hermes tools`. Name a narrow one here — e.g. `"web"` — to pin it |
| `apiKeyEnv` | `api` only. The **environment variable** holding the key. Default `ANTHROPIC_API_KEY`. The key itself is never written in the config file |
| `maxChars` | Refuse anything longer, before a request is made. Default 24000 |
| `languages` | Offered in the translate prompt. You can still type any language |
| `actions` | Your own actions — see below |

At start the server runs `<command> --version` once. If that fails — not installed, wrong name, not on `PATH` — it warns and the feature stays off, the same way `api` stays off when its environment variable is empty. That is deliberate: a missing tool should not look like a broken editor.

> [!tip] Sign in first
> `claude login` for the Claude CLI, `hermes setup` / `hermes login` for Hermes — as the **user the server runs as**. A signed-out CLI answers "Not logged in"; Websidian treats that as a failure and never pastes it into your note.

For the API-key backend, start the server with the key in its environment:

```bash
ANTHROPIC_API_KEY=... npm start
```

## Using it

1. Select some text. With nothing selected, the action works on the **whole note**.
2. `Ctrl+P`, then type *writing help*.
3. Pick an action. Translate asks which language.

The result replaces what you selected as **one undoable change** — `Ctrl+Z` puts your text back. Nothing is written to disk: the note is still only saved by `Ctrl+S`, so you can always throw the result away by leaving without saving.

*Suggest a title* and *Suggest a description* do not replace anything; they show the suggestion in the status bar for you to copy.

## Your own actions

The wording of every action lives on the server. Add your own:

```json
"assist": {
  "backend": "claude-cli",
  "actions": [
    {
      "id": "house-style",
      "label": "Apply our house style",
      "instruction": "Rewrite in our house style: British spelling, no exclamation marks, no marketing adjectives, second person."
    }
  ]
}
```

`replaces: false` makes an action a suggestion instead of a replacement. `needsTarget: true` makes it ask for an argument, the way translate does.

## What it will not do

> [!warning] It rewrites; it does not research
> Every instruction tells the model to keep the facts as they are and not to invent names, numbers or sources. *Expand it* develops what is already there. Nothing checks the result — read it before you save.

Obsidian syntax is preserved on purpose: wikilinks, embeds, tags, block ids, callouts, math, code fences and the YAML frontmatter keys are all meant to survive a rewrite, and Arabic keeps its own direction next to English.

## How it is wired

> [!info] The prompt never comes from the browser
> The browser sends an **action id** and some text. It cannot send a prompt. Every instruction, the system prompt and any key stay on the server, so the editor cannot be turned into a general-purpose proxy for your subscription or your API key — by a bug, an extension, or anyone who gets a session.

- The route is `POST /<site>/_api/assist`, behind the editor's own login, IP allowlist and `X-Requested-With` check, exactly like saving ([[Editing in the browser]]).
- It is rate limited separately, at `rateLimit.assist` (default 20 a minute per address): each call spends a process and part of somebody's quota.
- Input longer than `maxChars`, an unknown action, or a language that does not look like a language are all refused **before** anything is run, so a mistake costs nothing.
- The CLI is spawned as an argv array with `shell: false`, and your note is written to its **stdin**, never onto a command line. A note full of backticks and `$(…)` is just text.
- A failure — a non-zero exit, a killed timeout, or an authentication message even on a clean exit — is written to the server log **in full** and comes back to the browser as one generic line. The CLI's own output can name a model, a config path or an account.
- With the `api` backend, a refusal is reported as one. A CLI reply carries no such signal, so only empty output can be told apart; read what comes back.

See also: [[Editing in the browser]], [[Editor hotkeys and commands]], [[Configuration]].
