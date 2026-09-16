'use strict';
// Writing help inside the editor.
//
// Three rules shape this file:
//   1. The browser posts an action *id* and some text; it never supplies a
//      prompt. So a compromised or hostile page cannot turn the editor into a
//      general-purpose proxy for whatever account is paying for this.
//   2. Nothing is saved. The result comes back as text, the editor applies it
//      as one undoable change, and the note is still only written by Ctrl+S.
//   3. No API key by default. The work is handed to a CLI the person has
//      already signed in to — Claude Code or Hermes Agent — so it is billed to
//      the subscription they already have rather than to API tokens. The `api`
//      backend, with a key, stays available for anyone who wants it.
//
// Off unless `assist` is in the config, so a vault that does not want this has
// no route at all — and off again if the backend cannot work (no key for
// `api`, no executable on PATH for a CLI).

const os = require('os');
const { spawn, spawnSync } = require('child_process');

// An error we wrote ourselves, and may therefore show to the person editing.
// Anything without this flag came from the backend and is not echoed.
function mine(message, status) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  return e;
}

const DEFAULT_BACKEND = 'claude-cli';
const DEFAULT_MODEL = 'claude-opus-5';
const DEFAULT_MAX_CHARS = 24000;   // ~6k tokens of note; well inside the window
const MAX_TOKENS = 16000;
const DEFAULT_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 20_000;   // once, at startup, just `<command> --version`

// Each backend: what to run it with, what an effort level may say, and the
// default command. `api` is the SDK path and has no command.
const BACKENDS = {
  'claude-cli': { command: 'claude', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  // Hermes has its own scale; it is a superset of Claude's, so an `effort`
  // written for one backend still means something on the other.
  'hermes-cli': { command: 'hermes', efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  api: { command: null, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
};

// A CLI can fail while still exiting 0 — Claude Code prints this and (depending
// on version) exits 0, which would otherwise be pasted into the note as if it
// were the rewrite.
// Both strings were seen from `claude -p` on a machine whose sign-in had
// lapsed; the first came back on stdout with exit 0 on one run, so the exit
// code alone is not enough to trust the output.
const AUTH_FAILED = /Failed to authenticate|Not logged in/i;

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

// Is the executable there at all? Once, at start, so a typo or a CLI that was
// never installed reads as "writing help is off" rather than as a broken
// editor the first time someone presses Ctrl+P.
function reachable(command, warn) {
  const run = module.exports._spawnSync || spawnSync;
  let r;
  try {
    r = run(command, ['--version'], { cwd: os.tmpdir(), timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' });
  } catch (e) {
    r = { error: e };
  }
  if (r && !r.error && r.status === 0) return true;
  const why = r && r.error ? r.error.message : `exit ${r && r.status}`;
  warn(`assist is configured but \`${command} --version\` did not run (${why}) — the editor's writing help stays off`);
  return false;
}

function resolveAssist(config, warn = () => {}) {
  const cfg = config && config.assist;
  if (!cfg) return null;
  const backend = String(cfg.backend || DEFAULT_BACKEND);
  const spec = BACKENDS[backend];
  if (!spec) {
    warn(`assist.backend "${backend}" is not one of ${Object.keys(BACKENDS).join(', ')} — the editor's writing help stays off`);
    return null;
  }

  // Only the SDK backend needs a key. The CLIs use the sign-in the person
  // already has, which is the point of preferring them.
  let apiKey = null, keyEnv = null;
  if (backend === 'api') {
    keyEnv = cfg.apiKeyEnv || 'ANTHROPIC_API_KEY';
    apiKey = process.env[keyEnv];
    if (!apiKey) {
      warn(`assist is configured but ${keyEnv} is not set — the editor's writing help stays off`);
      return null;
    }
  }
  const command = backend === 'api' ? null : String(cfg.command || spec.command);
  if (command && !reachable(command, warn)) return null;

  // Wrong effort levels are a config typo, not a reason to be off.
  let effort = String(cfg.effort || 'low');
  if (!spec.efforts.includes(effort)) {
    warn(`assist.effort "${effort}" is not one of ${spec.efforts.join(', ')} for ${backend} — using "low"`);
    effort = 'low';
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
    backend,
    apiKey,
    keyEnv,
    command,
    // Hermes picks the model from the person's own Hermes config — their
    // subscription, their provider — so we pass one only when asked to.
    model: cfg.model ? String(cfg.model) : (backend === 'hermes-cli' ? null : DEFAULT_MODEL),
    toolsets: cfg.toolsets ? String(cfg.toolsets) : null,
    bare: cfg.bare === true,               // claude-cli only, opt-in; see claudeArgv
    effort,                                // simple rewriting; raise it if you want more care
    timeoutMs: Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : DEFAULT_TIMEOUT_MS,
    maxChars: Number(cfg.maxChars) > 0 ? Number(cfg.maxChars) : DEFAULT_MAX_CHARS,
    languages: Array.isArray(cfg.languages) && cfg.languages.length ? cfg.languages.map(String) : ['Arabic', 'English'],
    actions,
    warn,
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

// ---- the CLI backends ------------------------------------------------------
//
// Both are spawned with an argv array and no shell, so nothing in a note — a
// backtick, a `$(…)`, a quote — can ever be interpreted as a command. The text
// goes in on stdin for the same reason, and because a whole note would blow
// past the argv length limit on Windows. cwd is the temp dir so neither CLI
// picks up the vault's or the repo's CLAUDE.md, AGENTS.md, memory or hooks.

function claudeArgv(assist) {
  // `--tools ""` disables every tool: this is a rewriting call, it must not
  // touch the disk. `--system-prompt` replaces Claude Code's own system prompt
  // with ours, so the model is not being an agent, it is editing a note. cwd is
  // the temp dir, so there is no project CLAUDE.md to discover either way.
  //
  // `--bare` would also skip hooks, plugins and auto-memory, but `claude --help`
  // says that under it "Anthropic auth is strictly ANTHROPIC_API_KEY or
  // apiKeyHelper via --settings (OAuth and keychain are never read)" — it would
  // ignore the subscription sign-in this whole backend exists to use. So it is
  // off unless `"bare": true`, which only makes sense with an API key.
  const argv = [assist.command, '-p'];
  if (assist.bare) argv.push('--bare');
  return argv.concat([
    '--no-session-persistence',
    '--output-format', 'text',
    '--tools', '',
    '--model', assist.model,
    '--effort', assist.effort,
    '--system-prompt', SYSTEM,
  ]);
}

function hermesArgv(assist) {
  // `--query-file -` reads the whole query from stdin and is documented as safe
  // for arbitrary text; `-Q` prints the final answer and nothing else (the
  // session id goes to stderr); `--ignore-rules` keeps the person's AGENTS.md,
  // SOUL.md and memory out of a call that is only meant to rewrite a paragraph.
  // No `-m` unless one is configured: Hermes uses the provider the person set
  // up. Hermes has no way to disable its toolsets from the command line, so
  // `toolsets` is passed only when an operator names one.
  const argv = [
    assist.command, 'chat', '--query-file', '-', '-Q',
    '--no-restore-cwd', '--ignore-rules',
    '--reasoning', assist.effort,
  ];
  if (assist.model) argv.push('-m', assist.model);
  if (assist.toolsets) argv.push('-t', assist.toolsets);
  return argv;
}

// Run it, feed stdin, collect both streams, and never wait forever.
function runProcess(assist, argv, stdin) {
  const spawnFn = assist._spawn || module.exports._spawn || spawn;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(argv[0], argv.slice(1), {
        cwd: os.tmpdir(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) { return reject(e); }

    let out = '', err = '', settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(reject, new Error(`${argv[0]} did not answer within ${assist.timeoutMs}ms — killed`));
    }, assist.timeoutMs);
    if (timer.unref) timer.unref();

    // Decode as a stream, not chunk by chunk: an Arabic letter can straddle a
    // chunk boundary and would come back as two replacement characters.
    if (child.stdout.setEncoding) child.stdout.setEncoding('utf8');
    if (child.stderr.setEncoding) child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => finish(reject, e));
    child.on('close', code => finish(resolve, { code, out, err }));
    // A CLI that dies early closes its stdin; writing to it must not crash us.
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    }
  });
}

async function runCli(assist, prompt) {
  const argv = assist.backend === 'hermes-cli' ? hermesArgv(assist) : claudeArgv(assist);
  const r = await runProcess(assist, argv, prompt);
  const failed = r.code !== 0 || AUTH_FAILED.test(r.out) || AUTH_FAILED.test(r.err);
  if (failed) {
    // The full output is for the operator's log only. It can name a model, a
    // config path, an account or a token, so the browser gets the route's
    // generic line instead — this error is deliberately not `expose`d.
    const detail = `assist: ${argv[0]} failed (exit ${r.code})\n--- stdout ---\n${r.out}\n--- stderr ---\n${r.err}`;
    (assist.warn || (m => console.error(m)))(detail);
    throw new Error(`${argv[0]} exited ${r.code}: ${(r.err || r.out || '').trim().split('\n')[0] || 'no output'}`);
  }
  // Hermes on Windows prints CRLF; the editor stores LF only, and a CRLF reply
  // made CodeMirror's post-insert selection point past the end of the document.
  return r.out.replace(/\r\n?/g, '\n').trim();
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
    // Shown next to each action in the palette. Hermes without a configured
    // model has none to show, so it says which backend is answering instead.
    model: assist.model || assist.backend,
    backend: assist.backend,
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

  // The same words every backend sees, so a note rewritten through the CLI and
  // one rewritten through the API were asked for exactly the same thing.
  const message = `${instruction}\n\n${title ? `The note is called “${title}”.\n\n` : ''}Here is the text:\n\n${src}`;

  if (assist.backend !== 'api') {
    // Claude Code takes the system prompt as a flag; Hermes has no such flag,
    // so ours is prepended to the one query it reads from stdin.
    const prompt = assist.backend === 'hermes-cli' ? `${SYSTEM}\n\n${message}` : message;
    const out = await runCli(assist, prompt);
    // A CLI reply has no stop reason to read, so a refusal cannot be told from
    // a rewrite. Empty output is the one thing we can be sure went wrong.
    if (!out) throw mine('Came back empty; nothing was changed.', 502);
    return {
      text: spec.replaces === false ? out : unfence(out, src),
      replaces: spec.replaces !== false,
      model: assist.model || assist.backend,
      usage: { input: 0, output: 0 },      // the CLIs do not report token counts
    };
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
    messages: [{ role: 'user', content: message }],
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

module.exports = {
  resolveAssist, run, menu, ACTIONS, SYSTEM, unfence, mine, claudeArgv, hermesArgv, BACKENDS,
  // Injectable so tests never launch a real process: `_spawnSync` is the
  // startup probe (which runs before there is an assist object to hang a stub
  // on), `_spawn` the call itself — a single assist may also carry `_spawn`.
  _spawn: spawn,
  _spawnSync: spawnSync,
};
