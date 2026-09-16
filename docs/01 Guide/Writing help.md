---
title: Writing help
tags: [websidian, guide, editor, ai]
updated: 2026-09-16
order: 5
description: Claude in the editor, for rewriting rather than writing for you
---
# Writing help

Optional. When it is configured, the command palette gains a set of **Writing help** actions that rewrite the selected text — improve it, shorten it, expand it, summarise it, translate it, turn it into a list, or suggest a title or description.

![[editor-assist.png]]

It is off unless you turn it on, and it stays off unless the API key is actually present. A vault that does not want this has no route for it at all.

## Turning it on

```json
"assist": {
  "apiKeyEnv": "ANTHROPIC_API_KEY",
  "model": "claude-opus-5",
  "effort": "low",
  "maxChars": 24000,
  "languages": ["Arabic", "English", "French"]
}
```

Then start the server with the key in its environment:

```bash
ANTHROPIC_API_KEY=... npm start
```

| Key | Meaning |
|---|---|
| `apiKeyEnv` | The **environment variable** holding the key. Default `ANTHROPIC_API_KEY`. The key itself is never written in the config file |
| `model` | Default `claude-opus-5` |
| `effort` | `low` (default), `medium`, `high`, `xhigh`, `max`. Rewriting a paragraph does not need much; raise it if you want more care and will pay for it |
| `maxChars` | Refuse anything longer, before a request is made. Default 24000 |
| `languages` | Offered in the translate prompt. You can still type any language |
| `actions` | Your own actions — see below |

If `assist` is present but the environment variable is empty, the server warns at start and the feature stays off. That is deliberate: a missing key should not look like a broken editor.

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
  "apiKeyEnv": "ANTHROPIC_API_KEY",
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

> [!info] The key never reaches the browser
> The browser sends an **action id** and some text. It cannot send a prompt. Every instruction, the system prompt and the key stay on the server, so the editor cannot be turned into a general-purpose proxy for your API key — by a bug, an extension, or anyone who gets a session.

- The route is `POST /<site>/_api/assist`, behind the editor's own login, IP allowlist and `X-Requested-With` check, exactly like saving ([[Editing in the browser]]).
- It is rate limited separately, at `rateLimit.assist` (default 20 a minute per address), because each call costs money.
- Input longer than `maxChars`, an unknown action, or a language that does not look like a language are all refused **before** a request is made, so a mistake is not billed.
- A provider error is written to the server log in full and summarised to the browser. Provider messages can carry request detail, and their status codes mean something else on this API.
- If Claude declines a request, the editor says so rather than pretending the note came back unchanged.

See also: [[Editing in the browser]], [[Editor hotkeys and commands]], [[Configuration]].
