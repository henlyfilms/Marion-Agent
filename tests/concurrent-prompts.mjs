// Several prompts in ONE chat at the same time: a slow turn keeps running while a quick question (and more prompts) are
// answered right away, each run finishes on its own in any order, rows keep unique increasing seq numbers, the bot stays
// "working" until the LAST run ends (never flips idle early), and the replies never overwrite each other.
// Offline and in-process: a stubbed model endpoint stands in for the model, no ports. Needs `npm run build` first.
// Usage: node tests/concurrent-prompts.mjs
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

process.env.DB_PATH = join(tmpdir(), `marion-concurrent-prompts-${process.pid}.db`);
process.env.MARION_NO_SCHEDULER = '1';
process.env.DEV_LOGIN = '1';
process.env.HOST = '127.0.0.1';
process.env.SERVER_URL = 'http://127.0.0.1:8796';
process.env.APP_URL = 'http://127.0.0.1:8796';
process.env.XAI_API_KEY = '';
process.env.MARION_LOCAL_MODEL_URL = 'http://127.0.0.1:9/v1';
process.env.MARION_LOCAL_MODEL_API_KEY = '';
process.env.MARION_LOCAL_MODEL = 'fake';

const texts = (body) => (body.input ?? []).filter(item => item.role === 'user')
  .map(item => typeof item.content === 'string' ? item.content : (item.content ?? []).map(part => part.text ?? '').join(''));
const requests = [];
const aborted = [];
const gates = new Map(); // "slow N" -> release fn
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url instanceof Request ? url.url : url);
  if (!href.startsWith('http://127.0.0.1:9/v1')) return realFetch(url, init);
  if (href.includes('/models')) return new Response(JSON.stringify({ data: [{ id: 'fake' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const last = (texts(JSON.parse(String(init.body))).at(-1) ?? '').split('\n').at(-1);
  requests.push(last);
  const hold = /^slow (\w+)/.exec(last);
  if (hold) {
    await new Promise((resolve, reject) => {
      gates.set(hold[1], resolve);
      init.signal?.addEventListener('abort', () => { aborted.push(hold[1]); reject(init.signal.reason ?? new Error('aborted')); });
    });
  }
  const reply = `Answer to: ${last}`;
  const item = { type: 'message', id: `msg_${requests.length}`, role: 'assistant', content: [{ type: 'output_text', text: reply, annotations: [] }] };
  const events = [{ type: 'response.output_text.delta', delta: reply }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { output: [item] } }];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

await import('../server/dist/features/schema.js');
const { initSubagents } = await import('../server/dist/agent/subagents.js');
const { initRooms } = await import('../server/dist/agent/rooms.js');
initSubagents(); initRooms();
const { api } = await import('../server/dist/routes.js');
const { isBotBusy, activeRunCount } = await import('../server/dist/agent/loop.js');
const { getLive } = await import('../server/dist/store.js');

const waitFor = async (check, message, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail(typeof message === 'function' ? message() : message);
};

try {
  const origin = 'http://127.0.0.1:8796';
  const login = await api.request(`${origin}/auth/dev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'concurrent@example.com' }) });
  assert.equal(login.status, 200);
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  const { bots: [bot] } = await (await api.request(`${origin}/bots`, { headers })).json();
  const rows = async () => (await (await api.request(`${origin}/bots/${bot.id}/rows`, { headers })).json()).rows;
  const send = (text) => api.request(`${origin}/bots/${bot.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text }) });
  const answered = async (text) => (await rows()).filter(r => r.body.text === `Answer to: ${text}`).length;
  const started = (name) => waitFor(() => gates.has(name), `slow ${name} never started`);

  // 1. A slow turn is running; a quick question arrives and is answered immediately, while the slow turn is untouched.
  assert.equal((await send('slow one')).status, 200);
  await started('one');
  assert.equal(isBotBusy(bot.id), true);
  const asked = Date.now();
  assert.equal((await send('how do I set up Marion Agent on my phone?')).status, 200);
  await waitFor(async () => (await answered('how do I set up Marion Agent on my phone?')) === 1, 'the quick question waited behind the slow turn');
  assert.ok(Date.now() - asked < 3000, 'the quick question was not answered promptly');
  assert.equal(await answered('slow one'), 0, 'the slow turn must still be running');
  assert.equal(getLive(bot.id).isRunning, true, 'the bot must stay "working" while the slow turn runs');

  // 2. Five more prompts at once, two of them slow: all start together; the quick ones finish first, in no particular order.
  const batch = ['slow two', 'quick a', 'slow three', 'quick b', 'quick c'];
  const before = requests.length;
  await Promise.all(batch.map(send));
  await waitFor(() => requests.length === before + 5, 'not every prompt started in parallel');
  await waitFor(async () => (await Promise.all(['quick a', 'quick b', 'quick c'].map(answered))).every(n => n === 1), 'quick prompts did not finish while slow ones ran');
  assert.equal(activeRunCount(bot.id), 3, 'the three slow runs must still be in flight');
  assert.equal(getLive(bot.id).isRunning, true);
  assert.ok(!(await rows()).some(r => r.body.type === 'notice'), 'nothing may fail or be stopped');

  // 3. Slow runs finish in a different order than they started; the bot only goes idle after the last one.
  gates.get('three')();
  await waitFor(async () => (await answered('slow three')) === 1, 'slow three never finished');
  assert.equal(activeRunCount(bot.id), 2);
  assert.equal(getLive(bot.id).isRunning, true, 'one finished run must not make a busy bot look idle');
  gates.get('one')();
  await waitFor(async () => (await answered('slow one')) === 1, 'slow one never finished');
  assert.equal(getLive(bot.id).isRunning, true, 'still one run left');
  gates.get('two')();
  await waitFor(async () => !isBotBusy(bot.id), 'the bot never went idle');
  assert.equal(getLive(bot.id).isRunning, false, 'the bot goes idle after the last run');
  assert.equal(getLive(bot.id).activity, null);
  assert.equal(activeRunCount(bot.id), 0);

  // 4. Transcript integrity: every prompt has exactly one reply, nothing is streaming, seq numbers are unique and ordered,
  // and no reply overwrote another.
  const all = await rows();
  const prompts = ['slow one', 'how do I set up Marion Agent on my phone?', ...batch];
  for (const prompt of prompts) assert.equal(await answered(prompt), 1, `"${prompt}" must have exactly one reply`);
  assert.equal(all.filter(r => r.body.role === 'user').length, prompts.length, 'every prompt is in the transcript once');
  assert.ok(!all.some(r => r.body.streaming), 'no reply is left streaming');
  const seqs = all.map(r => r.seq);
  assert.equal(new Set(seqs).size, seqs.length, 'row seq numbers must be unique');
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'rows must come back in order');
  assert.equal(aborted.length, 0);
  assert.ok(!all.some(r => r.body.type === 'notice'), 'no notices expected');

  // 5. A stop while several runs are in flight aborts them all and the bot ends idle with one acknowledgement.
  const base = requests.length;
  gates.clear();
  await send('slow x'); await started('x');
  await send('slow y'); await started('y');
  await send('slow z'); await started('z');
  assert.equal(activeRunCount(bot.id), 3);
  await send('Stop.');
  await waitFor(async () => !isBotBusy(bot.id), 'the bot never went idle after the stop');
  assert.deepEqual([...aborted].sort(), ['x', 'y', 'z']);
  assert.equal(requests.length, base + 3);
  assert.equal(getLive(bot.id).isRunning, false);
  assert.equal((await rows()).filter(r => /^Stopped\./.test(r.body.text ?? '')).length, 1, 'exactly one stop acknowledgement');
  console.log('PASS: many prompts in one chat run in parallel, finish independently, keep status/rows consistent, and one stop aborts them all.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const release of gates.values()) release();
  globalThis.fetch = realFetch;
  await rm(process.env.DB_PATH, { force: true });
  process.exit(process.exitCode ?? 0);
}
