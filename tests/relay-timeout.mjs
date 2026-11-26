// A relayed Claude session is NEVER killed for taking long or going silent: no wall-clock, silence or idle timeout.
// Only the owner stopping the run (AbortSignal) ends it early, and real CLI errors keep their real message.
// Uses a fake `claude` program: no network, no real CLI, no listener.
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
  if (input.includes('SLEEPY')) return setTimeout(() => { out({ type: 'result', subtype: 'success', is_error: false, result: 'Finished after a long silence', usage: { input_tokens: 5, output_tokens: 7 } }); }, 1500);
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
process.env.MARION_RELAY_IDLE_MS = '300'; // the old silence override: must have no effect any more
process.env.DB_PATH = ':memory:';
process.env.SERVER_URL = 'http://127.0.0.1:8787';
process.env.HOST = '127.0.0.1';

const { subscriptionReply, activeProviderRuns } = await import('../server/dist/agent/subscriptions.js');
const selection = { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', label: 'Claude' };
const folder = { path: work, label: 'Test folder', write: true };
const run = (prompt, signal = new AbortController().signal) => subscriptionReply(selection, prompt, signal, [], { folder });

try {
  // 1. An active session runs well past the (ignored) old 300 ms silence override and is not killed.
  const started = Date.now();
  assert.equal(await run('ACTIVE long job'), 'All done after a long run');
  assert.ok(Date.now() - started > 1000, 'the run really lasted a long time');

  // 2. A session that is completely silent (no stdout, no stderr) for 5x the old limit is NOT killed.
  const quietStart = Date.now();
  assert.equal(await run('SLEEPY job'), 'Finished after a long silence');
  assert.ok(Date.now() - quietStart >= 1400, 'the run really was silent for a long time');

  // 3. Output on stderr alone is fine too.
  assert.equal(await run('STDERRBEAT job'), 'All done after a long run');

  // 4. A hung (silent forever) CLI is only ended by the owner, cleanly, and its process does not linger.
  const hungController = new AbortController();
  const hung = run('SILENT hang', hungController.signal).then(() => null, error => error);
  let settled = false; hung.then(() => { settled = true; });
  await new Promise(d => setTimeout(d, 1200));
  assert.equal(settled, false, 'a silent CLI is not stopped by any timer');
  assert.equal(activeProviderRuns(), 1);
  hungController.abort(new Error('Stopped by you.'));
  assert.equal((await hung).message, 'Stopped by you.');
  assert.equal(activeProviderRuns(), 0);

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

  // 7. No wall-clock, silence or idle cutoff is left in the relay code.
  for (const file of ['agent/subscriptions.ts', 'agent/orchestrate.ts', 'agent/tools.ts', 'agent/orchestration.ts']) {
    const source = readFileSync(new URL(`../server/src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /took too long to respond|stopped responding|IdleGuard|idle-guard|MARION_RELAY_IDLE_MS|silenceMessage/, `${file} has no timeout/silence watchdog`);
    assert.doesNotMatch(source, /AbortSignal\.timeout\((900_000|600_000|180_000|CALL_MS|60 \* 60_000)/, `${file} has no wall-clock relay timeout`);
  }
  console.log('relay-timeout: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
