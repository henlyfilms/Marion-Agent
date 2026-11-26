// Texting a busy bot: plain messages run at once in parallel (nothing queues), "stop" aborts EVERY running run and says so
// once, "work on this first" aborts nothing: it is answered at once in parallel while the running work continues.
// Intent detection is checked too, including dictation-style punctuation and capitalisation.
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
for (const t of ['stop', 'Stop!', 'cancel', 'abort', 'never mind', 'nevermind', 'stop that', 'halt', 'ok stop', 'please cancel that', 'Cancel it.',
  'Stop.', 'Stop,', 'STOP', 'stop, stop, stop', 'Stop. Stop.', 'Okay, never mind.', 'Hold on, stop.', 'Stop everything…', 'Never mind, forget it.', 'wait, stop that now', 'Cancel that, please.', 'stop what you\u2019re doing'])
  assert.equal(classifyIntent(t), 'stop', `"${t}" should be a stop`);
for (const t of ['work on this first', 'Do this first: rename the button', 'handle this first please', 'prioritize this', 'actually do this instead', 'override', 'Override: use blue',
  'Work on this first,', 'Work on this, first.', 'Actually, do this instead', 'Actually, do this first.', 'Do this first. Print hello.', 'Instead, check the logs', 'Actually, instead run the tests', 'Drop everything and check the build', 'Before anything else, call mom', 'This is a priority'])
  assert.equal(classifyIntent(t), 'override', `"${t}" should be an override`);
for (const t of ['please fix the login bug', 'and also rename the button', 'why did it stop working?', 'stop the music player from autoplaying when the page loads', 'add a cancel button to the dialog', 'thanks',
  'how do I set up Marion Agent on my phone?', 'Instead of blue, what about green?', 'I want to cancel my subscription to the newsletter feature', 'never mind the colors, just fix the layout bug on the settings page'])
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
  const hold = /long job (\w+)/.exec(last.split('\n').at(-1)); // only the user's own line holds a job, not a note about one
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
  assert.fail(typeof message === 'function' ? message() : message);
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

  const count = (re) => rows().then(all => all.filter(r => re.test(r.body.text ?? '')).length);

  // 1. Additive messages while a long job runs: each starts AT ONCE, in parallel, and is answered; the job is not touched.
  await startJob('A');
  await send('please fix the login bug');
  await send('and also rename the button');
  await send('and make the header blue');
  await waitFor(() => requests.length === 4, 'additive messages did not start in parallel with the running job');
  await waitFor(async () => (await count(/^Done with: (please fix|and also|and make)/)) === 3, 'parallel answers missing');
  assert.equal(aborted.length, 0, 'additive messages must not interrupt the running work');
  assert.equal(await count(/^Done with: long job A/), 0, 'the long job must still be running');
  assert.ok(requests.slice(1).every(r => !r.includes('while you were busy')), 'parallel messages must not be told they waited');
  gates.get('A')();
  await idle();
  assert.equal(requests.length, 4, 'every message is exactly one run (no merging)');
  assert.equal(await count(/^Done with: long job A/), 1);

  // 2. Stop: aborts EVERY run (the main job and a parallel one), says "Stopped." exactly once, runs nothing more.
  const baseline = requests.length;
  await startJob('B');
  await startJob('B2');
  assert.equal(requests.length, baseline + 2, 'the second long job must run in parallel with the first');
  await send('Stop.');
  await idle();
  assert.deepEqual([...aborted].sort(), ['B', 'B2'], 'every active run must be aborted by a stop');
  assert.equal(requests.length, baseline + 2, 'a stop must not start another run');
  let all = await rows();
  assert.equal(all.filter(r => /^Stopped\./.test(r.body.text ?? '')).length, 1, 'a stop is acknowledged exactly once');
  assert.ok(!all.some(r => r.body.type === 'notice' && r.body.tone === 'error'), 'a stop must not look like a failure');

  // 3. Override: interrupts every run and runs the new message first, naming what it interrupted.
  const base3 = requests.length;
  await startJob('C');
  await startJob('C2');
  await send('Actually, do this first: print hello');
  await waitFor(() => requests.length === base3 + 3, () => `the override turn never ran: ${JSON.stringify({ requests: requests.slice(base3), aborted })}`);
  assert.deepEqual([...aborted].sort(), ['B', 'B2'], 'an override must NOT abort any running work');
  const over = requests[base3 + 2];
  assert.ok(over.includes('print hello') && over.includes('handle this FIRST'), 'the override was not handled right away');
  await waitFor(async () => (await count(/^Done with: .*print hello/)) === 1, 'the override was never answered while the jobs still run');
  assert.equal(await count(/^Done with: long job C/), 0, 'the earlier jobs must still be running');
  gates.get('C')(); gates.get('C2')();
  await idle();
  assert.equal(await count(/^Done with: long job C2?$/), 2, 'the earlier jobs must finish normally after an override');
  all = await rows();
  assert.equal(all.filter(r => r.body.type === 'notice' && r.body.text === 'Stopped.').length, 0, 'an override never stops anything');
  assert.ok(!all.some(r => r.body.type === 'notice' && r.body.tone === 'error'));

  // 4. A stop after an override still works, and a stop with nothing running is just a message.
  const base4 = requests.length;
  await startJob('D');
  await send('cancel');
  await idle();
  assert.deepEqual([...aborted].sort(), ['B', 'B2', 'D']);
  assert.equal(requests.length, base4 + 1);
  assert.equal((await send('stop')).status, 200); // idle bot: no intent, answered normally
  await waitFor(() => requests.length === base4 + 2, 'a stop sent to an idle bot should be an ordinary message');
  await idle();

  // 5. After all that the bot works normally and its status settles to idle.
  assert.equal((await send('hello again')).status, 200);
  await waitFor(() => requests.length === base4 + 3, 'the bot did not recover');
  await idle();
  const live = await (await api.request(`${origin}/bots`, { headers })).json();
  assert.equal(live.bots[0].id, bot.id);
  console.log('PASS: additive messages run in parallel, stop aborts every run once, override never aborts anything (it runs in parallel), dictation variants recognised.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const release of gates.values()) release();
  globalThis.fetch = realFetch;
  await rm(process.env.DB_PATH, { force: true });
  process.exit(process.exitCode ?? 0);
}
