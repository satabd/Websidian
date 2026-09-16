'use strict';
// Writing help inside the editor, backed by Claude.
//
// Two rules shape this file:
//   1. The API key never leaves the server. The browser posts an action *id*
//      and some text; it never supplies a prompt. So a compromised or hostile
//      page cannot turn the editor into a general-purpose proxy for the key.
//   2. Nothing is saved. The result comes back as text, the editor applies it
//      as one undoable change, and the note is still only written by Ctrl+S.
//
// Off unless `assist` is in the config *and* the API key environment variable
// is set, so a vault that does not want this has no route at all.

// An error we wrote ourselves, and may therefore show to the person editing.
// Anything without this flag came from the provider and is not echoed.
function mine(message, status) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  return e;
}

const DEFAULT_MODEL = 'claude-opus-5';
const DEFAULT_MAX_CHARS = 24000;   // ~6k tokens of note; well inside the window
const MAX_TOKENS = 16000;

// Every action's instruction lives here, not in the browser.
const ACTIONS = {
  improve: {
    label: 'Improve the writing',
    instruction: 'Rewrite the text so it reads better: clearer sentences, less padding, active voice. Keep the author\'s voice, the meaning, and every fact exactly as they are. Do not add new claims. Keep the same Markdown structure.',
  },
  shorten: {
    label: 'Make it shorter',
    instruction: 'Cut the text down while keeping every fact and conclusion. Remove repetition and padding, not substance. Keep the same Markdown structure.',
  },
  expand: {
    label: 'Expand it',
    instruction: 'Develop the text: explain what is implied, add the detail a reader would need. Do not invent facts, names, numbers or sources — if something is unknown, leave it out rather than guessing.',
  },
  summarise: {
    label: 'Summarise',
    instruction: 'Replace the text with a short summary of it: a sentence of context, then the key points as a bulleted list. Facts only, nothing added.',
  },
  headings: {
    label: 'Add headings and structure',
    instruction: 'Add Markdown headings, lists and tables so the text is easy to scan. Keep every word of substance; you may reorder and split paragraphs. Do not add new content.',
  },
  bullets: {
    label: 'Turn into a list',
    instruction: 'Rewrite the text as a Markdown bulleted list, one idea per bullet, keeping the facts and their order.',
  },
  translate: {
    label: 'Translate',
    instruction: 'Translate the text. Keep all Markdown, wikilinks, code, and frontmatter keys exactly as they are — translate only prose. Keep the translation natural rather than literal.',
    needsTarget: true,
  },
  describe: {
    label: 'Suggest a description',
    instruction: 'Write a single short line — at most 12 words, no full stop — describing what this note is for, suitable for a `description:` frontmatter value. Reply with that line only.',
    replaces: false,
  },
  title: {
    label: 'Suggest a title',
    instruction: 'Suggest a short, plain title for this note — at most 8 words, no trailing punctuation. Reply with the title only.',
    replaces: false,
  },
};

const SYSTEM = [
  'You are helping someone edit a note in an Obsidian vault that is published as a website by Websidian.',
  '',
  'The text you are given is Obsidian Flavored Markdown. Preserve it exactly where it is not the thing being changed:',
  '- `[[wikilinks]]`, `![[embeds]]`, `#tags`, block ids (`^id`)',
  '- callouts (`> [!note]`), footnotes, `$math$`, mermaid and other code fences',
  '- YAML frontmatter between `---` fences, including its keys',
  '- Arabic and other right-to-left text, which may sit next to English',
  '',
  'Reply with the replacement text and nothing else. No preamble, no explanation, no apology,',
  'and do not wrap the whole reply in a code fence unless the original was itself a fenced block.',
  'If you cannot do what was asked, reply with the original text unchanged.',
].join('\n');

function resolveAssist(config, warn = () => {}) {
  const cfg = config && config.assist;
  if (!cfg) return null;
  const keyEnv = cfg.apiKeyEnv || 'ANTHROPIC_API_KEY';
  const apiKey = process.env[keyEnv];
  if (!apiKey) {
    warn(`assist is configured but ${keyEnv} is not set — the editor's writing help stays off`);
    return null;
  }
  // Operator-defined extras. Still server-side: the browser only sends an id.
  const actions = { ...ACTIONS };
  for (const a of Array.isArray(cfg.actions) ? cfg.actions : []) {
    if (!a || !a.id || !a.instruction) continue;
    actions[String(a.id)] = {
      label: String(a.label || a.id),
      instruction: String(a.instruction),
      needsTarget: !!a.needsTarget,
      replaces: a.replaces !== false,
    };
  }
  return {
    apiKey,
    keyEnv,
    model: cfg.model || DEFAULT_MODEL,
    effort: cfg.effort || 'low',           // simple rewriting; raise it if you want more care
    maxChars: Number(cfg.maxChars) > 0 ? Number(cfg.maxChars) : DEFAULT_MAX_CHARS,
    languages: Array.isArray(cfg.languages) && cfg.languages.length ? cfg.languages.map(String) : ['Arabic', 'English'],
    actions,
    _client: null,
  };
}

// The SDK is loaded only when a site actually uses this, so an unconfigured
// vault pays nothing for it at startup.
function client(assist) {
  if (!assist._client) {
    const mod = require('@anthropic-ai/sdk');
    const Anthropic = mod.default || mod;
    assist._client = new Anthropic({ apiKey: assist.apiKey });
  }
  return assist._client;
}

// Models sometimes wrap a whole answer in a fence even when told not to.
// Unwrap only when the fence spans the entire reply and the original was not fenced.
function unfence(out, original) {
  const trimmed = out.trim();
  if (/^```/.test(original.trim())) return out;
  const m = /^```[a-zA-Z0-9-]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return m ? m[1] : out;
}

// The action list the editor shows. No prompts, no key — just ids and labels.
function menu(assist) {
  return {
    model: assist.model,
    languages: assist.languages,
    actions: Object.entries(assist.actions).map(([id, a]) => ({
      id,
      label: a.label,
      needsTarget: !!a.needsTarget,
      replaces: a.replaces !== false,
    })),
  };
}

async function run(assist, { action, text, target, title }) {
  const spec = assist.actions[action];
  if (!spec) throw mine(`Unknown action “${action}”`, 400);
  const src = String(text == null ? '' : text);
  if (!src.trim()) throw mine('Nothing to work on — select some text, or write something first.', 400);
  if (src.length > assist.maxChars) throw mine(`That is ${src.length} characters; the limit is ${assist.maxChars}. Select a smaller part.`, 413);

  let instruction = spec.instruction;
  if (spec.needsTarget) {
    const want = String(target || '').trim();
    if (!want) throw mine('This action needs a target language.', 400);
    if (!/^[\p{L}\p{N} ()'-]{1,40}$/u.test(want)) throw mine('That does not look like a language name.', 400);
    instruction += `\n\nTranslate into: ${want}.`;
  }

  const res = await client(assist).beta.messages.create({
    model: assist.model,
    max_tokens: MAX_TOKENS,
    // A policy decline is re-run on a fallback model inside the same call
    // rather than surfacing as a dead end in the editor.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: assist.effort },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `${instruction}\n\n${title ? `The note is called “${title}”.\n\n` : ''}Here is the text:\n\n${src}`,
    }],
  });

  // Always check the stop reason before reading content.
  if (res.stop_reason === 'refusal') {
    throw mine('Claude declined this request' + (res.stop_details && res.stop_details.category ? ` (${res.stop_details.category})` : '') + '.', 422);
  }

  const out = res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  if (!out) throw mine('Came back empty; nothing was changed.', 502);

  return {
    text: spec.replaces === false ? out : unfence(out, src),
    replaces: spec.replaces !== false,
    model: res.model,
    usage: { input: res.usage.input_tokens, output: res.usage.output_tokens },
  };
}

module.exports = { resolveAssist, run, menu, ACTIONS, SYSTEM, unfence, mine };
