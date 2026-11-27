// Offline prompt queue: prompts sent while offline are stored per chat (surviving a reload), sent in order once Marion
// is reachable, never twice (client ids deduped by the server), refused ones kept visible, and removable.
// No listener, no network: the outbox core runs against an in-memory localStorage, the server part against a
// temporary database through Hono's in-process request().
// Usage: npm run build && node tests/offline-queue.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const work = mkdtempSync(join(tmpdir(), 'marion-offline-queue-'));
process.env.DB_PATH = join(work, 'marion.db');
process.env.MARION_NO_SCHEDULER = '1';
process.env.MARION_DESKTOP_TOKEN = 'test-token';
process.env.HOST = '127.0.0.1';
process.env.PATH = work; // no claude/codex/agy: the queued turn can't start a real model

// The web module is TypeScript with no DOM dependencies: bundle it for Node.
const out = join(work, 'outbox.mjs');
await build({ entryPoints: [fileURLToPath(new URL('../web/src/lib/outbox.ts', import.meta.url))], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { createOutbox, isOfflineError, OUTBOX_PREFIX } = await import(out);

class MemoryStorage {
  map = new Map();
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
}
const offline = () => new TypeError('Failed to fetch');
const refused = (status, message) => Object.assign(new Error(message), { status });

try {
  // ---- 1. what counts as "offline" ----
  assert.equal(isOfflineError(offline()), true, 'fetch network failure');
  for (const status of [0, 502, 503, 504]) assert.equal(isOfflineError(refused(status, 'down')), true, `HTTP ${status}`);
  for (const status of [400, 401, 404, 413, 500]) assert.equal(isOfflineError(refused(status, 'no')), false, `HTTP ${status}`);
  assert.equal(isOfflineError(Object.assign(new Error('aborted'), { name: 'AbortError' })), false);

  // ---- 2. queue while offline: persisted per chat, in order, survives a reload ----
  const storage = new MemoryStorage();
  const sent = [];
  let up = false;
  let netOnline = false;
  const deps = {
    storage,
    reachable: async () => up,
    online: () => netOnline,
    send: async (item) => { if (!up) throw offline(); sent.push(item); },
  };
  let box = createOutbox(deps);
  const a1 = box.enqueue('botA', 'first');
  const b1 = box.enqueue('botB', 'other chat');
  const a2 = box.enqueue('botA', 'second', { replyTo: 7 });
  box.enqueue('botA', 'second again', { id: a2.id }); // same id: not added twice
  assert.deepEqual(box.list('botA').map(i => i.text), ['first', 'second']);
  assert.equal(box.list('botA')[1].replyTo, 7);
  assert.ok(storage.getItem(OUTBOX_PREFIX + 'botA') && storage.getItem(OUTBOX_PREFIX + 'botB'), 'stored under each chat');
  assert.equal(box.pending('botA'), true);
  await box.flush();
  assert.equal(sent.length, 0, 'navigator offline: nothing sent');
  netOnline = true;
  await box.flush();
  assert.equal(sent.length, 0, 'online but server unreachable: nothing sent, nothing lost');
  assert.equal(box.list('botA').length, 2);

  box = createOutbox(deps); // reload
  assert.deepEqual(box.list('botA').map(i => i.id), [a1.id, a2.id], 'order kept across reload');

  // ---- 3. remove a queued prompt ----
  const a3 = box.enqueue('botA', 'never mind');
  let changes = 0;
  const off = box.subscribe(() => changes++);
  box.remove('botA', a3.id);
  assert.equal(changes, 1, 'listeners hear about removals');
  off();
  assert.deepEqual(box.list('botA').map(i => i.text), ['first', 'second']);

  // ---- 4. back online: flushed in order, exactly once, even with overlapping flushes ----
  up = true;
  await Promise.all([box.flush(), box.flush(), box.flush()]);
  assert.deepEqual(sent.map(i => i.text), ['first', 'second', 'other chat'], 'sent oldest first, each chat in order');
  assert.deepEqual(sent.map(i => i.id), [a1.id, a2.id, b1.id], 'client ids travel with the prompt');
  assert.equal(box.list('botA').length + box.list('botB').length, 0);
  assert.equal(storage.length, 0, 'storage cleared once sent');
  await box.flush();
  assert.equal(sent.length, 3, 'a second flush sends nothing again');

  // ---- 5. connection drops mid-flush: stops, keeps the rest in order ----
  sent.length = 0;
  const c1 = box.enqueue('botC', 'one'); box.enqueue('botC', 'two');
  let calls = 0;
  const flaky = createOutbox({ ...deps, send: async (item) => { if (++calls === 2) throw offline(); sent.push(item); } });
  await flaky.flush();
  assert.deepEqual(sent.map(i => i.text), ['one']);
  assert.deepEqual(flaky.list('botC').map(i => i.text), ['two'], 'unsent prompt kept');
  assert.ok(!flaky.list('botC').some(i => i.id === c1.id));
  await flaky.flush();
  assert.deepEqual(sent.map(i => i.text), ['one', 'two']);

  // ---- 6. refused by the server: kept with the reason, later prompts still go, retry works ----
  sent.length = 0;
  let refuse = true;
  const strict = createOutbox({ ...deps, send: async (item) => { if (refuse && item.text === 'bad') throw refused(413, 'Too large'); sent.push(item); } });
  const bad = strict.enqueue('botD', 'bad'); strict.enqueue('botD', 'good');
  await strict.flush();
  assert.deepEqual(sent.map(i => i.text), ['good']);
  assert.equal(strict.list('botD')[0].error, 'Too large');
  assert.equal(strict.pending('botD'), false, 'a refused prompt is not "waiting"');
  refuse = false;
  await strict.retry('botD', bad.id);
  assert.deepEqual(sent.map(i => i.text), ['good', 'bad']);
  assert.equal(strict.list('botD').length, 0);

  // ---- 7. server dedup: the same client id never makes a second message ----
  const { db } = await import('../server/dist/db.js');
  await import('../server/dist/features/schema.js');
  await import('../server/dist/db-config.js');
  (await import('../server/dist/agent/subagents.js')).initSubagents();
  (await import('../server/dist/agent/rooms.js')).initRooms(); // bots.kind, as at startup
  const { createBotRecord } = await import('../server/dist/features/bots.js');
  const { findClientMessage, appendRow } = await import('../server/dist/store.js');
  const { api } = await import('../server/dist/routes.js');
  const { Hono } = await import('hono');
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'a@example.com', 'A', 1000);
  const bot = createBotRecord('u1', { name: 'Queue bot' });
  appendRow(bot.id, 'message', { type: 'message', role: 'user', text: 'old', clientId: 'client-old-1' });
  assert.equal(findClientMessage(bot.id, 'client-old-1').body.text, 'old');
  assert.equal(findClientMessage(bot.id, 'client-missing'), null);

  const { createSession } = await import('../server/dist/lib/auth.js');
  const app = new Hono();
  app.get('/login', (c) => { createSession(c, 'u1'); return c.text('ok'); });
  app.route('/api', api);
  const cookie = (await app.request('/login')).headers.get('set-cookie').split(';')[0];
  const post = (body) => app.request(`/api/bots/${bot.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });
  const messages = () => db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='message'").all(bot.id).map(r => JSON.parse(r.body)).filter(b => b.role === 'user');
  const before = messages().length;
  const first = await post({ text: 'queued while offline', clientId: 'q-1234567890' });
  assert.equal(first.status, 200);
  const firstRow = (await first.json()).row;
  const again = await post({ text: 'queued while offline', clientId: 'q-1234567890' });
  const againBody = await again.json();
  assert.equal(again.status, 200);
  assert.equal(againBody.duplicate, true);
  assert.equal(againBody.row.seq, firstRow.seq, 'retry answered with the original row');
  assert.equal(messages().length, before + 1, 'only one message stored');
  await post({ text: 'no id' }); await post({ text: 'no id' });
  assert.equal(messages().length, before + 3, 'messages without a client id are not deduped');
  await post({ text: 'bad id', clientId: 'x' });
  assert.equal(messages().at(-1).clientId, undefined, 'malformed client ids are ignored');

  console.log('PASS offline queue: per-chat persistence, reload, remove, ordered auto-flush, single send, mid-flush drop, refused + retry, server dedup');
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(0);
