// QA gate 4: chat-effort controls. The saved setting, the effective selection the chat reports, and the flags the
// provider is really launched with must agree — including an inherited Medium (a chat with no override of its own
// takes the owner's provider default) — and correcting effort never changes the model.
// Gemini launches are asserted on flags AND launch count together: the strict fake agy logs every invocation
// (accepted or rejected) before answering, so a rejected first launch hidden by the "retry without --effort"
// fallback still fails the test (a passing retry is not a pass). A negative control proves the check catches it.
// Real chat API → runTurn → subscriptionReply → fake agy. No network, no listener, no real model calls.
// Usage: npm run build && node tests/chat-effort.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const bin = mkdtempSync(join(tmpdir(), 'marion-chat-effort-'));
const log = join(bin, 'launches.jsonl');
const refuse = join(bin, 'refuse-effort');
process.env.DB_PATH = ':memory:';
process.env.MARION_NO_SCHEDULER = '1';
process.env.MARION_DESKTOP_TOKEN = 'test-token';
process.env.HOST = '127.0.0.1';
process.env.SERVER_URL = 'http://127.0.0.1:8799';
process.env.APP_URL = 'http://127.0.0.1:8799';
process.env.XAI_API_KEY = '';
process.env.MARION_LOCAL_MODEL_URL = 'http://127.0.0.1:9/v1';
process.env.MARION_LOCAL_MODEL_API_KEY = '';
process.env.MARION_LOCAL_MODEL = 'fake';
process.env.PATH = bin + delimiter + process.env.PATH;

const FLAGS = { '--mode': 1, '--sandbox': 0, '--disable-slash-commands': 0, '--settings': 1, '--add-dir': 1,
  '--input-format': 1, '--output-format': 1, '--model': 1, '--effort': 1 };
writeFileSync(join(bin, 'agy'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'models') { for (const l of ['low', 'medium', 'high']) console.log('gemini-4-neon-' + l + '\\tGemini 4 Neon (' + l + ')'); process.exit(0); }
const input = fs.readFileSync(0, 'utf8');
const gate = [...input.matchAll(/GATE4-[a-z0-9]+/g)].at(-1)?.[0] ?? null; // the current message (the newest marker)
const entry = (ok, why) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, gate, ok, why }) + '\\n');
const FLAGS = ${JSON.stringify(FLAGS)};
for (let i = 0; i < args.length; i++) {
  if (!(args[i] in FLAGS)) { entry(false, 'unknown flag ' + args[i]); console.error('Error: unknown flag ' + args[i]); process.exit(1); }
  i += FLAGS[args[i]];
}
const at = args.indexOf('--effort');
if (at >= 0 && fs.existsSync(${JSON.stringify(refuse)})) {
  entry(false, 'effort refused');
  console.error('Error: --effort is not supported for model "' + args[args.indexOf('--model') + 1] + '"');
  process.exit(1);
}
entry(true);
console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Gemini reply' } }));
`, { mode: 0o700 });

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url instanceof Request ? url.url : url);
  if (!href.startsWith('http://127.0.0.1:9/v1')) return realFetch(url, init);
  if (href.includes('/models')) return new Response(JSON.stringify({ data: [{ id: 'fake' }] }), { status: 200 });
  const item = { type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: '{"memories":[]}', annotations: [] }] };
  return new Response([{ type: 'response.output_item.done', item }, { type: 'response.completed', response: { output: [item] } }]
    .map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

const flag = (args, name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

try {
  await import('../server/dist/features/schema.js');
  const { initSubagents } = await import('../server/dist/agent/subagents.js');
  const { initRooms } = await import('../server/dist/agent/rooms.js');
  initSubagents(); initRooms();
  const { api } = await import('../server/dist/routes.js');
  const { configApi } = await import('../server/dist/routes-config.js');
  const { isBotBusy, settleSideRuns } = await import('../server/dist/agent/loop.js');
  const { db } = await import('../server/dist/db.js');

  const origin = 'http://127.0.0.1:8799';
  const login = await api.request(`${origin}/auth/me`); // the Mac workspace session, as in the app
  assert.equal(login.status, 200);
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json', origin };
  const call = (app, method, path, body) => app.request(`${origin}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const ok = async (res) => { assert.equal(res.status, 200, await res.clone().text()); return res.json(); };
  const launches = (gate) => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => l.gate === gate) : [];
  const waitIdle = async (id) => {
    for (const end = Date.now() + 15_000; Date.now() < end;) {
      await new Promise(r => setTimeout(r, 50));
      if (!isBotBusy(id)) { await settleSideRuns(); return; }
    }
    assert.fail('the bot never went idle');
  };
  let n = 0;
  /** Send one chat message and return every Gemini launch it caused (accepted and rejected). */
  const launch = async (botId) => {
    const gate = `GATE4-${++n}`;
    await ok(await call(api, 'POST', `/bots/${botId}/messages`, { text: `${gate} hello` }));
    await waitIdle(botId);
    return launches(gate);
  };
  /** Gemini: flags and launch count together — exactly one launch, accepted first time, with these flags. */
  const assertSingleLaunch = (runs, { model, effort }) => {
    assert.equal(runs.length, 1, `launch count must be 1 (a passing retry is not a pass): ${JSON.stringify(runs)}`);
    assert.equal(runs[0].ok, true, `the first launch was accepted: ${runs[0].why}`);
    assert.equal(flag(runs[0].args, '--model'), model, 'effective --model');
    assert.equal(flag(runs[0].args, '--effort'), effort, 'effective --effort');
  };
  const botRow = (id) => db.prepare('SELECT chat_provider, chat_model, chat_effort FROM bots WHERE id=?').get(id);

  await ok(await call(configApi, 'PUT', '/settings/chat-provider', { provider: 'gemini' }));
  const pref = await ok(await call(configApi, 'PUT', '/settings/subscription-model/gemini', { model: 'gemini-4-neon', effort: 'medium' }));
  assert.deepEqual(pref.selection, { provider: 'gemini', model: 'gemini-4-neon', effort: 'medium' });
  const bot = (await ok(await call(api, 'POST', '/bots', { name: 'Gate4', job: 'Helps', description: 'Helps.', instructions: 'Help.' }))).bot;

  await test('inherited Medium: no chat override → saved setting, reported selection and launch flags are all Medium', async () => {
    assert.deepEqual(botRow(bot.id), { chat_provider: null, chat_model: null, chat_effort: null }, 'the chat has no override: it inherits');
    const shown = await ok(await call(configApi, 'GET', `/bots/${bot.id}/chat-model`));
    assert.equal(shown.selection.provider, 'gemini');
    assert.equal(shown.selection.model, 'gemini-4-neon');
    assert.equal(shown.selection.effort, 'medium', 'the chat reports the inherited Medium');
    assertSingleLaunch(await launch(bot.id), { model: 'gemini-4-neon', effort: 'medium' });
  });

  await test('a chat on High is corrected to Medium without changing the model; flags + launch count verified after each step', async () => {
    // Pin this chat to the same model on High (as if someone had raised it).
    await ok(await call(configApi, 'PUT', `/bots/${bot.id}/chat-model`, { provider: 'gemini', model: 'gemini-4-neon', effort: 'high' }));
    assert.deepEqual(botRow(bot.id), { chat_provider: 'gemini', chat_model: 'gemini-4-neon', chat_effort: 'high' });
    assertSingleLaunch(await launch(bot.id), { model: 'gemini-4-neon', effort: 'high' });

    const fixed = await ok(await call(configApi, 'PUT', `/bots/${bot.id}/chat-model`, { provider: 'gemini', model: 'gemini-4-neon', effort: 'medium' }));
    assert.equal(fixed.selection.model, 'gemini-4-neon', 'model unchanged');
    assert.equal(fixed.selection.effort, 'medium');
    assert.deepEqual(botRow(bot.id), { chat_provider: 'gemini', chat_model: 'gemini-4-neon', chat_effort: 'medium' }, 'saved: same model, Medium');
    assertSingleLaunch(await launch(bot.id), { model: 'gemini-4-neon', effort: 'medium' });
    // The owner default was never touched by the per-chat correction.
    assert.deepEqual(db.prepare("SELECT model, effort FROM subscription_model_preferences WHERE provider='gemini'").get(), { model: 'gemini-4-neon', effort: 'medium' });
  });

  await test('scheduled path: a routine on an inheriting Gemini chat launches once, first time, on Medium (same model)', async () => {
    const { initRoutines, runRoutine } = await import('../server/dist/routines.js');
    const { enqueue } = await import('../server/dist/agent/loop.js');
    initRoutines(enqueue);
    const sched = (await ok(await call(api, 'POST', '/bots', { name: 'Gate4Routine', job: 'Helps', description: 'Helps.', instructions: 'Help.' }))).bot;
    assert.deepEqual(botRow(sched.id), { chat_provider: null, chat_model: null, chat_effort: null }, 'inherits the owner default');
    const gate = `GATE4-routine${++n}`;
    db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES (?,?,?,?,?,?,1,?)')
      .run('rt-gate4', sched.id, 'Gate 4 routine', `${gate} scheduled check-in`, '0 9 * * *', 'UTC', Date.now());
    runRoutine('rt-gate4');
    await new Promise(r => setTimeout(r, 100));
    await waitIdle(sched.id);
    assertSingleLaunch(launches(gate), { model: 'gemini-4-neon', effort: 'medium' });
  });

  await test('negative control: a refused first launch hidden by the --effort fallback is caught (2 launches ≠ pass)', async () => {
    writeFileSync(refuse, '1');
    try {
      const runs = await launch(bot.id);
      assert.equal(runs.length, 2, `the fallback retried: ${JSON.stringify(runs)}`);
      assert.equal(runs[0].ok, false, 'first launch rejected');
      assert.equal(runs[1].ok, true, 'the retry succeeded (and would have looked like a pass)');
      assert.equal(flag(runs[1].args, '--effort'), null, 'the retry dropped --effort');
      assert.throws(() => assertSingleLaunch(runs, { model: 'gemini-4-neon', effort: 'medium' }), /launch count must be 1/);
    } finally { unlinkSync(refuse); }
  });

  console.log(`PASS chat-effort (${passed} tests)`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  rmSync(bin, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
