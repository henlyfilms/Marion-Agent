// Texting a busy bot: "stop" aborts the run and clears the queue, "work on this first" preempts it (waiting messages stay
// behind it), plain follow-ups stay queued without interrupting and merge into one turn. Intent detection is checked too.
// Offline and in-process: a stubbed model endpoint stands in for the model, no ports. Needs `npm run build` first.
// Usage: node tests/chat-override.mjs
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

process.env.DB_PATH = join(tmpdir(), `marion-chat-override-${process.pid}.db`);
process.env.MARION_NO_SCHEDULER = '1';
process.env.DEV_LOGIN = '1';
process.env.HOST = '127.0.0.1';
process.env.SERVER_URL = 'http://127.0.0.1:8798';
process.env.APP_URL = 'http://127.0.0.1:8798';
process.env.XAI_API_KEY = '';
process.env.MARION_LOCAL_MODEL_URL = 'http://127.0.0.1:9/v1';
process.env.MARION_LOCAL_MODEL_API_KEY = '';
process.env.MARION_LOCAL_MODEL = 'fake';

// ---- intent detection and merging (pure) ----
const { classifyIntent, mergeQueuedUser } = await import('../server/dist/agent/chat-intent.js');
for (const t of ['stop', 'Stop!', 'cancel', 'abort', 'never mind', 'nevermind', 'stop that', 'halt', 'ok stop', 'please cancel that', 'Cancel it.'])
  assert.equal(classifyIntent(t), 'stop', `"${t}" should be a stop`);
for (const t of ['work on this first', 'Do this first: rename the button', 'handle this first please', 'prioritize this', 'actually do this instead', 'override', 'Override: use blue'])
  assert.equal(classifyIntent(t), 'override', `"${t}" should be an override`);
for (const t of ['please fix the login bug', 'and also rename the button', 'why did it stop working?', 'stop the music player from autoplaying when the page loads', 'add a cancel button to the dialog', 'thanks'])
  assert.equal(classifyIntent(t), 'additive', `"${t}" should be additive`);
assert.equal(classifyIntent('[The user is replying to: "x"]\nstop'), 'stop', 'reply notes must not hide a stop');
{
  const one = { text: 'a', queued: true };
  assert.equal(mergeQueuedUser([one]), one);
  const merged = mergeQueuedUser([{ text: 'a', attachments: [1], queued: true }, { text: 'b', attachments: [2], queued: true, tag: 'latest' }]);
  assert.ok(merged.text.includes('1. a\n2. b') && merged.tag === 'latest' && merged.attachments.length === 2 && merged.queued);
}

// ---- through the real message route ----
const texts = (body) => (body.input ?? []).filter(item => item.role === 'user')
  .map(item => typeof item.content === 'string' ? item.content : (item.content ?? []).map(part => part.text ?? '').join(''));
const requests = [];
const aborted = [];
const gates = new Map(); // job name -> release fn
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url instanceof Request ? url.url : url);
  if (!href.startsWith('http://127.0.0.1:9/v1')) return realFetch(url, init);
  if (href.includes('/models')) return new Response(JSON.stringify({ data: [{ id: 'fake' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const last = texts(JSON.parse(String(init.body))).at(-1) ?? '';
  requests.push(last);
  const hold = /long job (\w+)/.exec(last);
  if (hold) {
    await new Promise((resolve, reject) => {
      gates.set(hold[1], resolve);
      init.signal?.addEventListener('abort', () => { aborted.push(hold[1]); reject(init.signal.reason ?? new Error('aborted')); });
    });
  }
  const reply = `Done with: ${last.split('\n').at(-1)}`;
  const item = { type: 'message', id: `msg_${requests.length}`, role: 'assistant', content: [{ type: 'output_text', text: reply, annotations: [] }] };
  const events = [{ type: 'response.output_text.delta', delta: reply }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { output: [item] } }];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

await import('../server/dist/features/schema.js');
const { initSubagents } = await import('../server/dist/agent/subagents.js');
const { initRooms } = await import('../server/dist/agent/rooms.js');
initSubagents(); initRooms();
const { api } = await import('../server/dist/routes.js');
const { isBotBusy } = await import('../server/dist/agent/loop.js');

const waitFor = async (check, message, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(message);
};

try {
  const origin = 'http://127.0.0.1:8798';
  const login = await api.request(`${origin}/auth/dev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'override@example.com' }) });
  assert.equal(login.status, 200);
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  const { bots: [bot] } = await (await api.request(`${origin}/bots`, { headers })).json();
  const rows = async () => (await (await api.request(`${origin}/bots/${bot.id}/rows`, { headers })).json()).rows;
  const send = (text) => api.request(`${origin}/bots/${bot.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text }) });
  const idle = () => waitFor(async () => !isBotBusy(bot.id), 'the bot never went idle');
  const startJob = async (name) => {
    const before = requests.length;
    assert.equal((await send(`long job ${name}`)).status, 200);
    await waitFor(() => requests.length > before && gates.has(name), `job ${name} never started`);
  };

  // 1. Additive messages stay queued without interrupting, then merge into one run.
  await startJob('A');
  await send('please fix the login bug');
  await send('and also rename the button');
  await send('and make the header blue');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(aborted.length, 0, 'additive messages must not interrupt the running work');
  assert.equal(requests.length, 1, 'additive messages must wait');
  gates.get('A')();
  await waitFor(() => requests.length === 2, 'the merged turn never ran');
  await idle();
  assert.equal(requests.length, 2, `three queued messages must run as ONE turn, got ${requests.length - 1} runs`);
  const m = requests[1];
  assert.ok(m.includes('sent 3 messages') && m.indexOf('1. please fix the login bug') < m.indexOf('2. and also rename the button') && m.indexOf('2. and also') < m.indexOf('3. and make the header blue'), 'merged turn is missing messages or order');

  // 2. Stop: aborts the active run, clears queued messages, acknowledges, runs nothing more.
  const baseline = requests.length;
  await startJob('B');
  await send('and add dark mode');
  await send('stop');
  await idle();
  assert.deepEqual(aborted, ['B'], 'the active run was not aborted');
  assert.equal(requests.length, baseline + 1, 'queued messages must be cleared by a stop');
  let all = await rows();
  assert.ok(all.some(r => r.body.ack && /^Stopped\. I also cleared 1 queued message/.test(r.body.text)), 'no concise stop acknowledgement');
  assert.ok(!all.some(r => r.body.type === 'notice' && r.body.tone === 'error'), 'a stop must not look like a failure');

  // 3. Override: interrupts the active run, runs the new message first, queued ones follow.
  const base3 = requests.length;
  await startJob('C');
  await send('please tidy the readme');
  await send('actually do this first: print hello');
  await waitFor(() => requests.length >= base3 + 3 && !isBotBusy(bot.id), 'the override and queued turns never finished');
  assert.deepEqual(aborted, ['B', 'C'], 'the override did not preempt the active run');
  const over = requests[base3 + 1], after = requests[base3 + 2];
  assert.ok(over.includes('print hello') && over.includes('work on this FIRST'), 'the override did not run first');
  assert.ok(after.includes('please tidy the readme'), 'the earlier queued message was lost');
  assert.equal(requests.length, base3 + 3);

  // 4. A stop arriving after additive messages wins over them immediately.
  const base4 = requests.length;
  await startJob('D');
  await send('and add tests');
  await send('and add docs');
  await send('Cancel');
  await idle();
  assert.deepEqual(aborted, ['B', 'C', 'D']);
  assert.equal(requests.length, base4 + 1, 'a later stop must clear the earlier queued messages');
  assert.ok((await rows()).some(r => r.body.ack && /cleared 2 queued messages/.test(r.body.text)));

  // 5. After a stop the bot works normally again.
  assert.equal((await send('hello again')).status, 200);
  await waitFor(() => requests.length === base4 + 2, 'the bot did not recover after a stop');
  await idle();
  console.log('PASS: stop aborts + clears the queue, override preempts, additive messages queue and merge into one turn.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const release of gates.values()) release();
  globalThis.fetch = realFetch;
  await rm(process.env.DB_PATH, { force: true });
  process.exit(process.exitCode ?? 0);
}
