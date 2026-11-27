// QA gate 2: malformed MARION_TOOL JSON recovery, replayed end to end on the candidate.
// A real chat message goes through the API → runTurn → callSubscriptionModel → resolveToolRequest → subscriptionReply,
// which launches a fake `agy` (Gemini) that answers from a script. Provider attempts (launches while resolving the
// tool request) and tool executions (the real dispatch in processCalls, counted on toolMap's `recall`) are asserted
// separately:
//   a) valid first reply           → attempts 1, executions 1, no correction prompt
//   b) malformed → valid           → attempts 2, executions 1, the 2nd attempt carries the correction
//   c) malformed → malformed       → attempts 2, executions 0, the turn ends with a clear error notice; no persisted row
//                                    contains MARION_TOOL
//   d–h) wrappers: ```tool / ~~~ fences dispatch like a bare request; a prose prefix ("Sure. MARION_TOOL: {…}") is
//        corrected once, and twice ends with a clean error — never shown as text, never leaking MARION_TOOL JSON
// No network, no listener, no real model calls.
// Usage: npm run build && node tests/marion-tool-json.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const bin = mkdtempSync(join(tmpdir(), 'marion-tool-json-'));
const log = join(bin, 'launches.jsonl');
const script = join(bin, 'script.json');
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

// Fake agy: every launch is logged (args + whether it carried a tool result or the correction). A launch whose prompt
// has a tool result ("resultFor") is the follow-up after a dispatch and answers "All done."; any other launch for the
// gate pops the next scripted reply.
writeFileSync(join(bin, 'agy'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'models') { for (const l of ['low', 'medium', 'high']) console.log('gemini-4-neon-' + l + '\\tGemini 4 Neon (' + l + ')'); process.exit(0); }
const input = fs.readFileSync(0, 'utf8');
const gate = [...input.matchAll(/GATE2-[a-z]/g)].at(-1)?.[0] ?? null;
const followUp = input.includes('resultFor');
const corrected = input.includes('invalid Marion tool request');
let response = 'ok';
if (gate && followUp) response = 'All done.';
else if (gate) { const queue = JSON.parse(fs.readFileSync(${JSON.stringify(script)}, 'utf8')); response = queue.shift() ?? 'ok'; fs.writeFileSync(${JSON.stringify(script)}, JSON.stringify(queue)); }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, gate, followUp, corrected }) + '\\n');
console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response } }));
`, { mode: 0o700 });

// Background work (titles, memories) may use the local model: answer it with an empty result.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url instanceof Request ? url.url : url);
  if (!href.startsWith('http://127.0.0.1:9/v1')) return realFetch(url, init);
  if (href.includes('/models')) return new Response(JSON.stringify({ data: [{ id: 'fake' }] }), { status: 200 });
  const item = { type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: '{"memories":[]}', annotations: [] }] };
  return new Response([{ type: 'response.output_item.done', item }, { type: 'response.completed', response: { output: [item] } }]
    .map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

const VALID = 'MARION_TOOL: {"name":"recall","arguments":{"query":"gate two"}}';
const MALFORMED = 'MARION_TOOL: {"name":"recall","arguments":{"query":"gate two"}';
const MALFORMED_2 = 'MARION_TOOL: {"name":"recall","arguments":';
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
  const { toolMap } = await import('../server/dist/agent/tools.js');

  // Count real dispatches of the tool the scripted replies ask for.
  const executions = [];
  toolMap.get('recall').impl = async (args, ctx) => { executions.push({ botId: ctx.botId, args }); return { output: '[]' }; };

  const origin = 'http://127.0.0.1:8799';
  // Desktop (Mac workspace) mode, like the app: the local workspace session comes from /auth/me.
  const login = await api.request(`${origin}/auth/me`);
  assert.equal(login.status, 200);
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json', origin };
  const call = (app, method, path, body) => app.request(`${origin}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const rows = async (id) => (await (await call(api, 'GET', `/bots/${id}/rows`)).json()).rows;
  const launches = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const waitIdle = async (id) => {
    for (const end = Date.now() + 15_000; Date.now() < end;) {
      await new Promise(r => setTimeout(r, 50));
      if (!isBotBusy(id)) { await settleSideRuns(); return; }
    }
    assert.fail('the bot never went idle');
  };

  const replay = async (letter, replies) => {
    const bot = (await (await call(api, 'POST', '/bots', { name: `Gate2${letter}`, job: 'Helps', description: 'Helps.', instructions: 'Help.' })).json()).bot;
    assert.ok(bot?.id, 'bot created');
    const set = await call(configApi, 'PUT', `/bots/${bot.id}/chat-model`, { provider: 'gemini', model: 'gemini-4-neon', effort: 'medium' });
    assert.equal(set.status, 200, await set.clone().text());
    writeFileSync(script, JSON.stringify(replies));
    const gate = `GATE2-${letter}`;
    const before = executions.length;
    assert.equal((await call(api, 'POST', `/bots/${bot.id}/messages`, { text: `${gate} please look it up` })).status, 200);
    await waitIdle(bot.id);
    const mine = launches().filter(l => l.gate === gate);
    return {
      attempts: mine.filter(l => !l.followUp),
      followUps: mine.filter(l => l.followUp),
      executions: executions.slice(before).filter(e => e.botId === bot.id),
      rows: await rows(bot.id),
    };
  };

  await test('a) valid first response → dispatches once without retry (provider attempts = 1, tool executions = 1)', async () => {
    const r = await replay('a', [VALID]);
    assert.equal(r.attempts.length, 1, 'provider attempts');
    assert.equal(r.executions.length, 1, 'tool executions');
    assert.deepEqual(r.executions[0].args, { query: 'gate two' });
    assert.equal(r.attempts[0].corrected, false, 'no correction prompt was needed');
    assert.equal(r.followUps.length, 1, 'one follow-up launch to read the tool result');
    assert.equal(r.rows.filter(x => x.body.type === 'tool-call' && x.body.name === 'recall').length, 1);
    assert.ok(!r.rows.some(x => x.body.type === 'notice' && x.body.tone === 'error'), 'no error');
  });

  await test('b) malformed → valid → dispatches once after one correction (provider attempts = 2, tool executions = 1)', async () => {
    const r = await replay('b', [MALFORMED, VALID]);
    assert.equal(r.attempts.length, 2, 'provider attempts');
    assert.equal(r.executions.length, 1, 'tool executions');
    assert.deepEqual(r.attempts.map(a => a.corrected), [false, true], 'the second attempt carries the correction');
    assert.equal(r.rows.filter(x => x.body.type === 'tool-call' && x.body.name === 'recall').length, 1);
    assert.ok(!r.rows.some(x => x.body.type === 'notice' && x.body.tone === 'error'), 'no error');
  });

  await test('c) malformed → malformed → dispatches zero times and ends with a clear error (provider attempts = 2, tool executions = 0)', async () => {
    const r = await replay('c', [MALFORMED, MALFORMED_2, VALID]);
    assert.equal(r.attempts.length, 2, 'provider attempts (no third try)');
    assert.equal(r.executions.length, 0, 'tool executions');
    assert.equal(r.followUps.length, 0);
    assert.equal(r.rows.filter(x => x.body.type === 'tool-call').length, 0, 'no tool-call row');
    const errors = r.rows.filter(x => x.body.type === 'notice' && x.body.tone === 'error');
    assert.equal(errors.length, 1, 'one error notice');
    assert.match(errors[0].body.text, /invalid Marion tool request twice/, errors[0].body.text);
    const leaked = r.rows.filter(x => JSON.stringify(x.body).includes('MARION_TOOL'));
    assert.equal(leaked.length, 0, `no persisted chat row contains MARION_TOOL: ${JSON.stringify(leaked.map(x => x.body))}`);
  });

  const noLeak = (r) => {
    const leaked = r.rows.filter(x => JSON.stringify(x.body).includes('MARION_TOOL'));
    assert.equal(leaked.length, 0, `no persisted chat row contains MARION_TOOL: ${JSON.stringify(leaked.map(x => x.body))}`);
  };
  const FENCED = (open, close) => `${open}\n${VALID}\n${close}`;

  await test('d) ```tool fence → dispatches once (attempts 1, executions 1), no MARION_TOOL row', async () => {
    const r = await replay('d', [FENCED('```tool', '```')]);
    assert.equal(r.attempts.length, 1, 'provider attempts');
    assert.equal(r.executions.length, 1, 'tool executions');
    assert.deepEqual(r.executions[0].args, { query: 'gate two' });
    assert.ok(!r.rows.some(x => x.body.type === 'notice' && x.body.tone === 'error'), 'no error');
    noLeak(r);
  });

  await test('e) ~~~ fence → dispatches once (attempts 1, executions 1), no MARION_TOOL row', async () => {
    const r = await replay('e', [FENCED('~~~', '~~~')]);
    assert.equal(r.attempts.length, 1, 'provider attempts');
    assert.equal(r.executions.length, 1, 'tool executions');
    noLeak(r);
  });

  await test('f) prose prefix → valid → corrected once, dispatches once (attempts 2, executions 1), never shown as text', async () => {
    const r = await replay('f', [`Sure. ${VALID}`, VALID]);
    assert.equal(r.attempts.length, 2, 'provider attempts');
    assert.deepEqual(r.attempts.map(a => a.corrected), [false, true]);
    assert.equal(r.executions.length, 1, 'tool executions');
    noLeak(r);
  });

  await test('g) prose prefix twice → zero executions and one clean error (attempts 2), no MARION_TOOL row', async () => {
    const r = await replay('g', [`Sure. ${VALID}`, `Okay, running it now: ${VALID}`, VALID]);
    assert.equal(r.attempts.length, 2, 'provider attempts (no third try)');
    assert.equal(r.executions.length, 0, 'tool executions');
    const errors = r.rows.filter(x => x.body.type === 'notice' && x.body.tone === 'error');
    assert.equal(errors.length, 1, 'one error notice');
    assert.match(errors[0].body.text, /invalid Marion tool request twice/);
    assert.ok(!r.rows.some(x => x.body.type === 'message' && x.body.role !== 'user'), 'no assistant text message was posted');
    noLeak(r);
  });

  await test('h) malformed inside a ```tool fence twice → clean error, no MARION_TOOL row', async () => {
    const r = await replay('h', [FENCED('```tool', '```').replace('}}', '}'), FENCED('~~~json', '~~~').replace('}}', '}')]);
    assert.equal(r.attempts.length, 2);
    assert.equal(r.executions.length, 0);
    assert.equal(r.rows.filter(x => x.body.type === 'notice' && x.body.tone === 'error').length, 1);
    noLeak(r);
  });

  console.log(`PASS marion-tool-json (${passed} tests)`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  rmSync(bin, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
