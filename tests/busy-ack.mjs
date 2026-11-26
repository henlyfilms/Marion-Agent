// Texting a busy bot: every new message is answered right away in parallel with the running job (nothing queues or
// merges), nothing is dropped, and two relayed sessions never share a project folder at the same time.
// Offline and in-process: a stubbed model endpoint stands in for the model, no ports. Needs `npm run build` first.
// Usage: node tests/busy-ack.mjs
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(tmpdir(), `marion-busy-ack-${process.pid}.db`);
process.env.MARION_NO_SCHEDULER = '1';
process.env.DEV_LOGIN = '1';
process.env.HOST = '127.0.0.1';
process.env.SERVER_URL = 'http://127.0.0.1:8797';
process.env.APP_URL = 'http://127.0.0.1:8797';
process.env.XAI_API_KEY = '';
process.env.MARION_LOCAL_MODEL_URL = 'http://127.0.0.1:9/v1';
process.env.MARION_LOCAL_MODEL_API_KEY = '';
process.env.MARION_LOCAL_MODEL = 'fake';

// ---- (b) folder serialization ----
const { acquireFolder, withFolder } = await import('../server/dist/agent/folder-lock.js');
const scratch = await mkdtemp(join(tmpdir(), 'marion-busy-ack-'));
const projectA = join(scratch, 'project-a');
const projectB = join(scratch, 'project-b');
await mkdir(join(projectA, 'sub'), { recursive: true });
await mkdir(projectB, { recursive: true });
{
  const log = [];
  let running = 0;
  let overlapSeen = false;
  const session = (name, folder, ms) => withFolder({ path: folder, write: true }, undefined, () => log.push(`${name} waits`), async () => {
    running++;
    if (folder !== projectB && running > 1) overlapSeen = true;
    log.push(`${name} start`);
    await new Promise(resolve => setTimeout(resolve, ms));
    log.push(`${name} end`);
    running--;
  });
  // Same folder, a folder inside it, and an unrelated folder; started together.
  await Promise.all([session('one', projectA, 80), session('two', projectA, 10), session('three', join(projectA, 'sub'), 10)]);
  assert.ok(!overlapSeen, `two sessions shared a folder: ${log.join(', ')}`);
  assert.deepEqual(log.filter(line => line.endsWith('start') || line.endsWith('end')),
    ['one start', 'one end', 'two start', 'two end', 'three start', 'three end'], 'sessions must run first come, first served');
  assert.deepEqual(log.filter(line => line.endsWith('waits')), ['two waits', 'three waits']);
  // A different folder does not wait.
  const release = await acquireFolder(projectA);
  let waited = false;
  const other = await acquireFolder(projectB, undefined, () => { waited = true; });
  assert.equal(waited, false, 'an unrelated folder must not wait');
  other();
  // A stopped waiter leaves the line without blocking the next one.
  const stop = new AbortController();
  const stopped = acquireFolder(projectA, stop.signal).then(() => 'got it', () => 'stopped');
  stop.abort(new Error('Stopped.'));
  assert.equal(await stopped, 'stopped');
  const next = acquireFolder(projectA).then(done => done);
  release();
  (await next)();
  // Read-only tasks never wait.
  assert.equal(await withFolder({ path: projectA, write: false }, undefined, undefined, async () => 'ok'), 'ok');
}

// ---- (a) busy bot, through the real message route ----
const texts = (body) => (body.input ?? []).filter(item => item.role === 'user')
  .map(item => typeof item.content === 'string' ? item.content : (item.content ?? []).map(part => part.text ?? '').join(''));
const requests = [];
let release = () => {};
const gate = new Promise(resolve => { release = resolve; });
const realFetch = globalThis.fetch;
// The model endpoint: answers each request with "Done with: <the last line the user sent>". The first job is held until released.
globalThis.fetch = async (url, init) => {
  const href = String(url instanceof Request ? url.url : url);
  if (!href.startsWith('http://127.0.0.1:9/v1')) return realFetch(url, init);
  if (href.includes('/models')) return new Response(JSON.stringify({ data: [{ id: 'fake' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const last = texts(JSON.parse(String(init.body))).at(-1) ?? '';
  requests.push(last);
  if (last.includes('first job')) await gate; // the long-running work
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

const waitFor = async (check, message, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(message);
};

try {
  const origin = 'http://127.0.0.1:8797';
  const login = await api.request(`${origin}/auth/dev`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'busy@example.com' }),
  });
  assert.equal(login.status, 200, `dev login failed (${login.status})`);
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  const { bots: [bot] } = await (await api.request(`${origin}/bots`, { headers })).json();
  const rows = async () => (await (await api.request(`${origin}/bots/${bot.id}/rows`, { headers })).json()).rows;
  const send = (text) => api.request(`${origin}/bots/${bot.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text }) });
  const acks = async () => (await rows()).filter(row => row.body.ack);

  // A quiet bot gets no acknowledgement.
  assert.equal((await send('first job: tidy the repo')).status, 200);
  await waitFor(() => requests.some(text => text.includes('first job')), 'the first job never reached the model');
  assert.equal((await acks()).length, 0, 'an idle bot must not acknowledge');

  // The bot is busy now. A new message is NOT queued behind the running job: it is answered right away, in parallel,
  // while the first job is still running, with no "Got it" line (there is nothing to wait for).
  assert.equal((await send('please fix the login bug')).status, 200);
  await waitFor(() => requests.length === 2, 'the new message was not started while the first job ran');
  await waitFor(async () => (await rows()).some(row => row.body.text === 'Done with: please fix the login bug'), 'the parallel answer never arrived');
  assert.equal((await acks()).length, 0, 'a message that runs at once needs no acknowledgement');
  assert.ok(!requests[1].includes('while you were busy'), 'the parallel message must not be told it waited');

  // A second and third message in the same burst also run at once, each answered separately.
  assert.equal((await send('and also rename the button')).status, 200);
  assert.equal((await send('what time zone is Tokyo in?')).status, 200);
  await waitFor(() => requests.length === 4, 'the burst did not start in parallel');
  await waitFor(async () => (await rows()).filter(row => /^Done with: (and also|what time)/.test(row.body.text ?? '')).length === 2, 'burst answers missing');
  assert.ok((await rows()).every(row => row.body.text !== 'Done with: first job: tidy the repo'), 'the first job must still be running');

  // Finish the running job; every message was answered once, nothing merged, nothing failed.
  release();
  await waitFor(async () => (await rows()).some(row => row.body.text === 'Done with: first job: tidy the repo'), 'the first job never finished');
  await waitFor(async () => !(await rows()).some(row => row.body.streaming), 'replies never finished streaming');
  assert.equal(requests.length, 4, `expected 4 model calls (one per message), got ${requests.length}`);
  const all = await rows();
  for (const reply of ['please fix the login bug', 'and also rename the button', 'what time zone is Tokyo in?'])
    assert.equal(all.filter(row => row.body.text === `Done with: ${reply}`).length, 1, `"${reply}" must be answered exactly once`);
  assert.ok(!all.some(row => row.body.type === 'notice' && row.body.tone === 'error'), 'a turn failed');
  assert.equal(all.filter(row => row.body.ack).length, 0);

  // Idle again.
  assert.equal((await send('thanks')).status, 200);
  await waitFor(() => requests.length >= 5, 'idle message never ran');
  await waitFor(async () => !(await rows()).some(row => row.body.streaming), 'idle reply never finished');
  assert.equal((await acks()).length, 0, 'an idle bot must not acknowledge');
  console.log('PASS: a busy bot answers new messages right away in parallel (no queue, no ack), and relayed sessions share no folder.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  release();
  globalThis.fetch = realFetch;
  await rm(scratch, { recursive: true, force: true });
  await rm(process.env.DB_PATH, { force: true });
  process.exit(process.exitCode ?? 0);
}
