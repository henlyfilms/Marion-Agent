// Work that is cut off WITHOUT the user asking to stop is picked up again instead of silently dropped:
//  1. a run that fails (model/network error) is continued automatically, and
//  2. a turn that was in flight when the server stopped is continued at the next start (resumeInterruptedTurns).
// A user stop is never resumed. Offline and in-process (stubbed model endpoint, no ports). Needs `npm run build` first.
// Usage: node tests/resume-interrupted.mjs
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

process.env.DB_PATH = join(tmpdir(), `marion-resume-${process.pid}.db`);
process.env.MARION_NO_SCHEDULER = '1';
process.env.DEV_LOGIN = '1';
process.env.HOST = '127.0.0.1';
process.env.SERVER_URL = 'http://127.0.0.1:8797';
process.env.APP_URL = 'http://127.0.0.1:8797';
process.env.XAI_API_KEY = '';
process.env.MARION_LOCAL_MODEL_URL = 'http://127.0.0.1:9/v1';
process.env.MARION_LOCAL_MODEL_API_KEY = '';
process.env.MARION_LOCAL_MODEL = 'fake';

const texts = (body) => (body.input ?? body.messages ?? []).flatMap(item => {
  const c = item.content;
  const parts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.map(p => p.text ?? '') : [];
  return item.role === 'user' ? parts : [];
});

const requests = [];
let failNext = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url instanceof Request ? url.url : url);
  if (!href.startsWith('http://127.0.0.1:9/v1')) return realFetch(url, init);
  if (href.includes('/models')) return new Response(JSON.stringify({ data: [{ id: 'fake' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const last = texts(JSON.parse(String(init.body))).at(-1) ?? '';
  requests.push(last);
  if (failNext > 0) { failNext--; return new Response('{"error":"upstream exploded"}', { status: 500, headers: { 'Content-Type': 'application/json' } }); }
  const reply = `Done with: ${last.split('\n').at(-1).slice(0, 80)}`;
  const item = { type: 'message', id: `msg_${requests.length}`, role: 'assistant', content: [{ type: 'output_text', text: reply, annotations: [] }] };
  const events = [{ type: 'response.output_text.delta', delta: reply }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { output: [item] } }];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

await import('../server/dist/features/schema.js');
const { initSubagents } = await import('../server/dist/agent/subagents.js');
const { initRooms } = await import('../server/dist/agent/rooms.js');
initSubagents(); initRooms();
const { api } = await import('../server/dist/routes.js');
const { isBotBusy, resumeInterruptedTurns } = await import('../server/dist/agent/loop.js');
const { db } = await import('../server/dist/db.js');

const waitFor = async (check, message, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(typeof message === 'function' ? message() : message);
};

try {
  const origin = 'http://127.0.0.1:8797';
  const login = await api.request(`${origin}/auth/dev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'resume@example.com' }) });
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  const { bots: [bot] } = await (await api.request(`${origin}/bots`, { headers })).json();
  const send = (text) => api.request(`${origin}/bots/${bot.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text }) });
  const idle = () => waitFor(async () => !isBotBusy(bot.id), 'the bot never went idle');
  const continued = () => requests.filter(r => r.includes('[Interrupted work]'));

  // 1. A failed run (not a stop) continues by itself, and finishes the job.
  failNext = 1;
  await send('build the report');
  await waitFor(() => continued().length === 1, () => `the failed run was never continued: ${JSON.stringify(requests)}`);
  assert.ok(continued()[0].includes('did NOT ask you to stop') && continued()[0].includes('build the report'), 'the bot is told what was cut off and that nobody stopped it');
  await idle();
  const rows = (await (await api.request(`${origin}/bots/${bot.id}/rows`, { headers })).json()).rows;
  assert.ok(rows.some(r => /^Done with: \[System notice\] \[Interrupted work\]/.test(r.body.text ?? '')), 'the continued run answered');

  // 2. Repeated failures stop after a couple of attempts (no endless loop).
  const before = continued().length;
  failNext = 99;
  await send('another job');
  await waitFor(() => continued().length >= before + 2, 'resume attempts did not happen');
  await new Promise(resolve => setTimeout(resolve, 9500));
  assert.equal(continued().length, before + 2, 'resuming must give up after two attempts');
  failNext = 0;
  await idle();

  // 3. A turn that was in flight when the server died is continued at the next start; a stopped one is not.
  const total = requests.length;
  db.prepare('INSERT INTO inflight_turns(id,bot_id,generation,label,started_at) VALUES (?,?,?,?,?)').run('x1', bot.id, bot.generation ?? 0, 'refactor the parser', Date.now());
  assert.equal(resumeInterruptedTurns(), 1);
  await waitFor(() => requests.length > total && continued().length > before + 2, 'the interrupted turn was not resumed at startup');
  assert.ok(continued().at(-1).includes('refactor the parser') && continued().at(-1).includes('Marion Agent restarted'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inflight_turns').get().n, 0, 'in-flight records are cleared once handled');
  await idle();

  console.log('PASS: failed runs continue automatically (max 2 tries), interrupted turns resume after a restart, nothing is left in flight.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  await rm(process.env.DB_PATH, { force: true });
  process.exit(process.exitCode ?? 0);
}
