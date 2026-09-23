'use strict';
// A stand-in for an agent CLI in the agents tests. Speaks Claude Code's `-p --output-format json`:
// records argv, cwd and stdin to $FAKE_AGENT_LOG, then answers. The message decides what it does:
//   WRITE   appends a line to Home.md in its working directory (the vault)
//   CREATE  writes Made by agent.md
//   HTML    answers with raw HTML in its Markdown
//   FAIL    exits 1
//   QUOTA   exits 1 with a provider's 429 on stdout; NOAUTH with a 401
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('0.0.0 (fake agent)'); process.exit(0); }
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { stdin += d; });
process.stdin.on('end', () => {
  if (process.env.FAKE_AGENT_LOG) fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ argv, cwd: process.cwd(), stdin }) + '\n');
  const at = flag => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const session = at('--resume') || at('--session-id');
  const last = stdin.trim().split('\n').pop();
  if (/FAIL/.test(last)) { process.stderr.write('something broke: token sk-secret-123\n'); process.exit(1); }
  // How Hermes reports its provider refusing, on stdout.
  if (/QUOTA/.test(last)) { process.stdout.write('Provider said: HTTP 429: The usage limit has been reached\n'); process.exit(1); }
  if (/NOAUTH/.test(last)) { process.stdout.write('HTTP 401: Missing Authentication header\n'); process.exit(1); }
  // How Codex reports a sign-in it cannot refresh.
  if (/EXPIRED/.test(last)) { process.stderr.write('Failed to refresh token: Your access token could not be refreshed. Please log out and sign in again.\n'); process.exit(1); }
  if (/WRITE/.test(last)) fs.appendFileSync(path.join(process.cwd(), 'Home.md'), '\nagent was here\n');
  if (/CREATE/.test(last)) fs.writeFileSync(path.join(process.cwd(), 'Made by agent.md'), '# Made by agent\n');
  const result = /HTML/.test(last) ? 'See [[Second]] <img src=x onerror="alert(1)"> **done**' : `Reply to: ${last}`;
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result, session_id: session, usage: { input_tokens: 5, output_tokens: 7 }, total_cost_usd: 0.001 }));
});
