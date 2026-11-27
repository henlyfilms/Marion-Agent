// A busy bot still answers other bots right away: a question from another bot runs in parallel with the bot's long task
// (relayed agent / orchestration / user turn), the bot stays "working" until ALL runs finish, then goes idle, and the answer
// reaches the asker. Subagent reports and replies to the bot's own questions never wait either. Safety: stop aborts every run.
// Offline and in-process: a stubbed model endpoint stands in for the model, no ports. Needs `npm run build` first.
// Usage: node tests/bot-concurrency.mjs
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

process.env.DB_PATH = join(tmpdir(), `marion-bot-concurrency-${process.pid}.db`);
process.env.MARION_NO_SCHEDULER = '1';
process.env.DEV_LOGIN = '1';
process.env.HOST = '127.0.0.1';
process.env.SERVER_URL = 'http://127.0.0.1:8799';
process.env.APP_URL = 'http://127.0.0.1:8799';
process.env.XAI_API_KEY = '';
process.env.MARION_LOCAL_MODEL_URL = 'http://127.0.0.1:9/v1';
process.env.MARION_LOCAL_MODEL_API_KEY = '';
process.env.MARION_LOCAL_MODEL = 'fake';

const texts = (body) => (body.input ?? []).filter(item => item.role === 'user')
  .map(item => typeof item.content === 'string' ? item.content : (item.content ?? []).map(part => part.text ?? '').join(''));
const requests = [];      // last user text of every model request, in arrival order
const finished = [];      // job names that completed
const aborted = [];
const gates = new Map();  // "long job X" -> release fn
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url instanceof Request ? url.url : url);
  if (!href.startsWith('http://127.0.0.1:9/v1')) return realFetch(url, init);
  if (href.includes('/models')) return new Response(JSON.stringify({ data: [{ id: 'fake' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const body = JSON.parse(String(init.body));
  const last = texts(body).at(-1) ?? '';
  requests.push(last);
  const hold = /long job (\w+)/.exec(last);
  if (hold) {
    await new Promise((resolve, reject) => {
      gates.set(hold[1], resolve);
      init.signal?.addEventListener('abort', () => { aborted.push(hold[1]); reject(init.signal.reason ?? new Error('aborted')); });
    });
    finished.push(hold[1]);
  }
  const reply = `Answer to: ${last.split('\n').at(-1).replace(/long job/g, 'job')}`;
  const item = { type: 'message', id: `msg_${requests.length}`, role: 'assistant', content: [{ type: 'output_text', text: reply, annotations: [] }] };
  const events = [{ type: 'response.output_text.delta', delta: reply }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { output: [item] } }];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

await import('../server/dist/features/schema.js');
const { initSubagents, createSubagent } = await import('../server/dist/agent/subagents.js');
const { initRooms } = await import('../server/dist/agent/rooms.js');
initSubagents(); initRooms();
const { api } = await import('../server/dist/routes.js');
const loop = await import('../server/dist/agent/loop.js');
const { getLive, loadHistory } = await import('../server/dist/store.js');

const waitFor = async (check, message, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail(message);
};

try {
  const origin = 'http://127.0.0.1:8799';
  const login = await api.request(`${origin}/auth/dev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'concurrency@example.com' }) });
  assert.equal(login.status, 200);
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  const { bots: [marion] } = await (await api.request(`${origin}/bots`, { headers })).json();
  const { bot: barry } = await (await api.request(`${origin}/bots`, { method: 'POST', headers, body: JSON.stringify({ name: 'Barry' }) })).json();
  const rows = async (id) => (await (await api.request(`${origin}/bots/${id}/rows`, { headers })).json()).rows;
  const send = (id, text) => api.request(`${origin}/bots/${id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text }) });
  const askFromBarry = (text, to = marion.id) => loop.enqueue(to, { type: 'bot', fromBotId: barry.id, fromName: 'Barry', text, depth: 0 });
  const idle = (id) => waitFor(async () => !loop.isBotBusy(id) && !getLive(id).isRunning, 'the bot never went idle');
  const startLong = async (name) => {
    const before = requests.length;
    assert.equal((await send(marion.id, `long job ${name}`)).status, 200);
    await waitFor(() => requests.length > before && gates.has(name), `job ${name} never started`);
  };

  // 1. Barry's question is answered while Marion's long task is still in flight.
  await startLong('A');
  assert.equal(getLive(marion.id).isRunning, true);
  askFromBarry('what is 2+2?');
  await waitFor(() => requests.some(r => r.includes('Message from Barry') && r.includes('what is 2+2?')), 'the question never reached the model while the long task ran');
  assert.deepEqual(finished, [], 'the long task must still be running');
  // The reply goes back to Barry as a message from Marion, before the long task finishes.
  await waitFor(async () => (await rows(barry.id)).some(r => r.body.from?.id === marion.id && /Answer to: .*what is 2\+2\?/.test(r.body.text)), 'Barry never got his answer back');
  assert.deepEqual(finished, [], 'the answer must arrive before the long task finishes');
  // Marion stays "working" after the quick side run finished, because the long task still runs.
  await waitFor(() => loop.activeRunCount(marion.id) === 1, 'the side run did not finish');
  assert.equal(getLive(marion.id).isRunning, true, 'bot flipped to idle while the main turn is still running');
  assert.deepEqual(aborted, [], 'the side run must not touch the main turn\'s abort controller');
  // The side question never entered Marion's stored chat history (no interleaving with the in-flight turn).
  assert.ok(!JSON.stringify(loadHistory(marion.id)).includes('what is 2+2?'), 'the side exchange leaked into the stored history mid-turn');

  // 2. Several questions at once overlap with each other and with the long task; status holds until the last finishes.
  askFromBarry('long job S1 please');
  askFromBarry('long job S2 please');
  await waitFor(() => gates.has('S1') && gates.has('S2'), 'two side runs did not overlap');
  assert.equal(loop.activeRunCount(marion.id), 3, 'main + 2 side runs should be active');
  gates.get('S1')();
  await waitFor(() => finished.includes('S1') && loop.activeRunCount(marion.id) === 2, 'S1 did not release its run');
  assert.equal(getLive(marion.id).isRunning, true, 'still working while S2 and the main turn run');
  gates.get('S2')();
  await waitFor(() => finished.includes('S2') && loop.activeRunCount(marion.id) === 1, 'S2 did not finish');
  assert.equal(getLive(marion.id).isRunning, true, 'still working while the main turn runs');
  // Finally the main turn finishes: the bot goes idle.
  gates.get('A')();
  await idle(marion.id);
  assert.equal(loop.activeRunCount(marion.id), 0);
  assert.equal(getLive(marion.id).isRunning, false);
  assert.ok(finished.indexOf('S1') < finished.indexOf('A') && finished.indexOf('S2') < finished.indexOf('A'), 'side runs must finish before the long task');
  assert.ok((await rows(marion.id)).some(r => r.body.text === 'Answer to: job A'), 'the main turn lost its reply');

  // 3. The next main turn remembers what was answered in parallel.
  await send(marion.id, 'recap please');
  await waitFor(() => requests.some(r => r.includes('recap please')), 'recap turn never ran');
  await idle(marion.id);
  assert.ok(JSON.stringify(loadHistory(marion.id)).includes('what is 2+2?'), 'the parallel answers were not added to the bot\'s memory');

  // 4. An idle bot still takes a bot message as a normal main turn (same as before).
  askFromBarry('hello idle bot');
  await waitFor(() => requests.some(r => r.includes('hello idle bot')), 'idle bot did not answer');
  await idle(marion.id);
  await idle(barry.id);

  // 5. A subagent's report to its parent no longer waits behind the parent's long turn: it is handled right away, in parallel.
  const sub = createSubagent(marion.id, 'research things');
  await startLong('B');
  loop.enqueue(marion.id, { type: 'bot', fromBotId: sub.id, fromName: sub.name, text: 'report from sub', depth: 1, autoReply: true });
  await waitFor(() => requests.some(r => r.includes('report from sub')), 'a subagent report must not wait for the parent\'s turn');
  // 6. Replies to the bot's own earlier question are handled right away too.
  loop.enqueue(marion.id, { type: 'bot', fromBotId: barry.id, fromName: 'Barry', text: 'reply for you', depth: 1, autoReply: true });
  await waitFor(() => requests.some(r => r.includes('reply for you')), 'an auto-reply must not wait for the turn');
  await waitFor(() => loop.activeRunCount(marion.id) === 1, 'the parallel report and reply did not finish');
  assert.ok(!finished.includes('B') && getLive(marion.id).isRunning, 'the long turn must still be running (and the bot working)');
  assert.deepEqual(aborted, [], 'parallel runs must not abort the main turn');

  // 7. Stop aborts the main turn and every side run, with a single "Stopped." acknowledgement.
  askFromBarry('long job S3 please');
  await waitFor(() => gates.has('S3'), 'S3 never started');
  assert.equal(loop.activeRunCount(marion.id), 2);
  loop.stopBot(marion.id);
  await waitFor(() => aborted.includes('B') && aborted.includes('S3'), 'stop did not abort all runs');
  await waitFor(() => loop.activeRunCount(marion.id) === 0, 'runs did not wind down after the stop');
  await idle(marion.id);
  const after = await rows(marion.id);
  assert.equal(after.filter(r => r.body.type === 'notice' && /^Stopped/.test(r.body.text)).length, 0, 'a stop must not add extra Stopped notices');

  console.log('PASS: bot-to-bot questions, subagent reports and replies run in parallel with a busy bot, status stays working until the last run ends, stop aborts all.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const release of gates.values()) release();
  globalThis.fetch = realFetch;
  await rm(process.env.DB_PATH, { force: true });
  process.exit(process.exitCode ?? 0);
}
