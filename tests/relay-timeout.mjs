// A relayed Claude session is never killed by a wall-clock timeout while it keeps working ("Claude Code took too
// long to respond. Try again." after 15 minutes). Only total silence trips the watchdog, and real CLI errors keep
// their real message. Uses a fake `claude` program: no network, no real CLI, no listener.
// Usage: npm run build && node tests/relay-timeout.mjs
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'marion-relay-timeout-'));
const bin = join(work, 'bin');
mkdirSync(bin);

// The fake CLI behaves by the word in the prompt it receives on stdin.
writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('auth')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' })); process.exit(0); }
let input = '';
process.stdin.setEncoding('utf8').on('data', c => { input += c; }).on('end', () => {
  const out = o => console.log(JSON.stringify(o));
  out({ type: 'system', subtype: 'init' });
  if (input.includes('SILENT')) return setTimeout(() => {}, 60_000);
  if (input.includes('STDERRDIE')) { console.error('Error: usage limit reached, resets at 5pm'); process.exit(3); }
  if (input.includes('RESULTERR')) { out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Credit balance is too low' }); return process.exit(1); }
  let n = 0;
  const timer = setInterval(() => {
    n++;
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test ' + n } }] } });
    if (input.includes('STDERRBEAT')) console.error('still working ' + n);
    if (n >= 12) { clearInterval(timer); out({ type: 'result', subtype: 'success', is_error: false, result: 'All done after a long run', usage: { input_tokens: 5, output_tokens: 7 } }); }
  }, 100);
});
`);
chmodSync(join(bin, 'claude'), 0o755);

process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.MARION_DESKTOP_TOKEN = 'test-token';
process.env.MARION_RELAY_IDLE_MS = '500';
process.env.DB_PATH = ':memory:';
process.env.SERVER_URL = 'http://127.0.0.1:8787';
process.env.HOST = '127.0.0.1';

const { IdleGuard, relayIdleMs, silenceMessage } = await import('../server/dist/agent/idle-guard.js');
const { subscriptionReply, activeProviderRuns } = await import('../server/dist/agent/subscriptions.js');
const selection = { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', label: 'Claude' };
const folder = { path: work, label: 'Test folder', write: true };
const run = (prompt, signal = new AbortController().signal) => subscriptionReply(selection, prompt, signal, [], { folder });

try {
  // 1. The guard itself: touching keeps it alive, silence trips it, stop disarms it.
  const guard = new IdleGuard(150);
  for (let i = 0; i < 6; i++) { await new Promise(d => setTimeout(d, 60)); guard.touch(); }
  assert.equal(guard.tripped, false, 'steady signs of life keep the guard quiet well past its idle limit');
  await new Promise(d => setTimeout(d, 260));
  assert.equal(guard.tripped, true, 'total silence trips the guard');
  const stopped = new IdleGuard(80); stopped.stop(); await new Promise(d => setTimeout(d, 200));
  assert.equal(stopped.tripped, false, 'a finished run is never tripped later');
  assert.equal(relayIdleMs(true), 500, 'MARION_RELAY_IDLE_MS overrides the idle limit');
  delete process.env.MARION_RELAY_IDLE_MS;
  assert.ok(relayIdleMs(true) >= 20 * 60_000 && relayIdleMs(false) >= 5 * 60_000, 'default silence limits are long');
  process.env.MARION_RELAY_IDLE_MS = '500';

  // 2. An active session runs 3x longer than the idle limit and is not killed.
  const started = Date.now();
  const reply = await run('ACTIVE long job');
  assert.equal(reply, 'All done after a long run');
  assert.ok(Date.now() - started > 1000, 'the run really lasted longer than the idle limit');

  // 3. Output on stderr alone also counts as a sign of life.
  assert.equal(await run('STDERRBEAT job'), 'All done after a long run');

  // 4. A silent (hung) CLI is stopped, with a message that says why.
  const hung = await run('SILENT hang').then(() => null, error => error);
  assert.ok(hung, 'a silent CLI is stopped');
  assert.match(hung.message, /stopped responding: it sent no output for/);
  assert.doesNotMatch(hung.message, /took too long to respond/);

  // 5. Real CLI errors keep their real message, not a generic one.
  const quota = await run('STDERRDIE now').then(() => null, error => error);
  assert.match(quota.message, /exited with code 3/);
  assert.match(quota.message, /usage limit reached, resets at 5pm/);
  const credit = await run('RESULTERR now').then(() => null, error => error);
  assert.match(credit.message, /Credit balance is too low/);

  // 6. The owner can still stop a run by hand, and nothing is left running.
  const controller = new AbortController();
  const stoppedRun = run('ACTIVE long job', controller.signal).then(() => null, error => error);
  setTimeout(() => controller.abort(new Error('Stopped by you.')), 250);
  assert.equal((await stoppedRun).message, 'Stopped by you.');
  assert.equal(activeProviderRuns(), 0);
  assert.match(silenceMessage('Claude Code', 1_800_000, ''), /30 minutes/);

  // 7. No fixed 15-minute (or any wall-clock) cutoff is left in the relay code.
  for (const file of ['agent/subscriptions.ts', 'agent/orchestrate.ts', 'agent/tools.ts']) {
    const source = readFileSync(new URL(`../server/src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /took too long to respond/, `${file} has no generic "took too long" message`);
    assert.doesNotMatch(source, /AbortSignal\.timeout\((900_000|600_000|180_000|CALL_MS|60 \* 60_000)/, `${file} has no wall-clock relay timeout`);
  }
  console.log('relay-timeout: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
