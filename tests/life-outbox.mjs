// Marion Life contract: Claude session summaries and deleted chats/bots reach Life through the outbox, wait safely
// while Life is missing a tool, and are archived locally either way. Uses a fake Marion Life server and a temporary database.
// Usage: node --import tsx tests/life-outbox.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'marion-life-outbox-'));
process.env.DB_PATH = join(work, 'marion.db');
process.env.MARION_NO_SCHEDULER = '1';

const calls = [];
let acceptNew = false;
// A stand-in for Marion Life: fetch to its address is answered here (no network, no open port needed).
const endpoint = 'http://127.0.0.1:8/api/mcp';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) !== endpoint) return realFetch(url, init);
  const rpc = JSON.parse(init.body);
  const { name, arguments: args } = rpc.params;
  const answer = (body) => new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, ...body }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (name === 'whoami') return answer({ result: { structuredContent: { ok: true, email: 'owner@example.com' } } });
  if (name === 'save_agent_chats') return answer({ result: { structuredContent: { ok: true, saved: args.chats.length } } });
  if (!acceptNew) return answer({ error: { code: -32601, message: 'unknown tool' } });
  calls.push({ name, args });
  return answer({ result: { structuredContent: { ok: true } } });
};

const { db, now } = await import('../server/src/db.ts');
await import('../server/src/features/schema.ts');
const { initSubagents } = await import('../server/src/agent/subagents.ts');
const { initRooms } = await import('../server/src/agent/rooms.ts');
initSubagents(); initRooms();
const { appendRow } = await import('../server/src/store.ts');
const { connectLife } = await import('../server/src/features/life-link.ts');
const outbox = await import('../server/src/features/life-outbox.ts');
const { deletedRoot } = await import('../server/src/features/deleted-archive.ts');

const userId = 'user_test';
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(userId, 'owner@example.com', 'Owner', now());
const botId = 'bot_test';
db.prepare(`INSERT INTO bots(id,user_id,name,label,description,instructions,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
  .run(botId, userId, 'Quinn', 'Researcher', 'Finds things', 'Always cite sources.', now(), now());
db.prepare('INSERT INTO memories(id,bot_id,text,created_at) VALUES (?,?,?,?)').run('mem1', botId, 'Owner likes short answers', now());
db.prepare('INSERT INTO skills(id,bot_id,name,body,created_at) VALUES (?,?,?,?,?)').run('skill1', botId, 'Summaries', 'Write two lines.', now());
appendRow(botId, 'message', { type: 'message', role: 'user', text: 'Please look into the login bug' }, [{ id: 'att1', name: 'screen.png', mime: 'image/png', data: Buffer.from('pngdata'), size: 7 }]);
appendRow(botId, 'message', { type: 'message', role: 'assistant', text: 'Found it: the redirect drops the query string.' });

await connectLife(userId, { endpoint, linkKey: 'mb_' + 'a'.repeat(32) });

// 1. A finished Claude run is summarised and queued (Life has no session tool yet: it waits).
const track = { id: 'ask:bot_test:1:1', kind: 'ask_subscription', userId, botId, request: 'Fix the login redirect\nPlease keep the query string.', folder: { path: '/Users/x/Marion Agent', label: 'Marion Agent' } };
const long = 'I traced the redirect. '.repeat(10) + 'Middle details. '.repeat(60) + 'Final: the redirect now keeps the query string and tests pass.';
outbox.recordSessionEnd(track, { status: 'completed', reply: long, startedAt: Date.now() - 5000, endedAt: Date.now(), model: { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', effort: 'medium' }, tokens: { input: 100, output: 20 } });
outbox.recordSessionEnd(track, { status: 'failed', error: 'Claude Code did not return a reply.', startedAt: Date.now(), endedAt: Date.now() });
let status = outbox.outboxStatus(userId);
assert.equal(status.pendingSessions, 1, 'one session record, updated by the second finish');
await outbox.drainLifeOutbox(userId, { manual: true });
status = outbox.outboxStatus(userId);
assert.equal(status.pendingSessions, 1, 'stays queued while Life lacks save_agent_sessions');
assert.match(status.lastError, /not turned on/);
console.log('PASS: session summaries wait in the outbox while Life has no session tool.');

// 2. Deleting a bot archives everything locally, even though Life cannot take it yet.
db.prepare('UPDATE bots SET hidden=1, deleted_at=? WHERE id=?').run(1_700_000_000_000, botId);
outbox.archiveDeletedBot(userId, botId, 'sidebar');
const dir = join(deletedRoot(), `${botId}-1700000000000`);
assert.ok(existsSync(join(dir, 'archive.json')), 'local archive written');
const archive = JSON.parse(readFileSync(join(dir, 'archive.json'), 'utf8'));
assert.equal(archive.archive_id, `${botId}:1700000000000`);
assert.equal(archive.bot.instructions, 'Always cite sources.');
assert.equal(archive.memories.length, 1);
assert.equal(archive.skills.length, 1);
assert.equal(archive.chats[0].rows.filter(r => r.kind === 'message').length, 2);
assert.equal(readdirSync(join(dir, 'attachments')).length, 1, 'attachment saved beside the archive');
outbox.archiveDeletedBot(userId, botId, 'startup_backfill');
assert.equal(db.prepare("SELECT COUNT(*) n FROM life_outbox WHERE kind='deleted'").get().n, 1, 'archiving twice queues once');
await outbox.drainLifeOutbox(userId, { manual: true });
assert.equal(outbox.outboxStatus(userId).pendingDeleted, 1);
console.log('PASS: deleted chat/bot is archived locally and queued; nothing lost while Life lacks the tool.');

// 3. Life turns the tools on: everything arrives, once.
acceptNew = true;
const result = await outbox.drainLifeOutbox(userId, { manual: true });
assert.ok(result.sent >= 2);
const sessions = calls.find(call => call.name === 'save_agent_sessions').args.sessions;
assert.equal(sessions.length, 1);
const session = sessions[0];
assert.equal(session.id, 'marion-agent:ask:bot_test:1:1');
assert.equal(session.provider, 'claude');
assert.equal(session.kind, 'ask_subscription');
assert.equal(session.title, 'Fix the login redirect');
assert.equal(session.status, 'failed', 'the latest finish decides the status');
assert.equal(session.calls, 2);
assert.equal(session.marion_bot_id, botId);
assert.equal(session.bot_name, 'Quinn');
assert.equal(session.chat_id, `${botId}:1`);
assert.deepEqual(session.folder, { name: 'Marion Agent', path: '/Users/x/Marion Agent' });
assert.ok(session.summary.includes('Final: the redirect now keeps the query string') && session.summary.length <= 720, 'summary keeps the opening and the closing words');
assert.ok(session.started_at && session.ended_at && session.duration_ms >= 0);
const parts = calls.filter(call => call.name === 'archive_deleted_item').map(call => call.args);
assert.deepEqual(parts.map(part => part.part), [0, 1]);
assert.equal(parts[0].archive_id, `${botId}:1700000000000`);
assert.equal(parts[0].parts, 2);
assert.equal(parts[0].instructions, 'Always cite sources.');
assert.equal(parts[0].name, 'Quinn');
assert.equal(parts[0].memories[0].text, 'Owner likes short answers');
assert.equal(parts[1].chat.id, `${botId}:1`);
assert.equal(parts[1].chat.message_count, 2);
assert.equal(parts[1].chat.messages[0].attachments[0].name, 'screen.png');
assert.match(parts[1].chat.transcript, /Found it: the redirect drops the query string\./);
status = outbox.outboxStatus(userId);
assert.deepEqual([status.pendingSessions, status.pendingDeleted], [0, 0]);
const before = calls.length;
await outbox.drainLifeOutbox(userId, { manual: true });
assert.equal(calls.length, before, 'nothing is sent twice');
console.log('PASS: session summary and both archive parts reached Life once the tools existed.');

// 4. Restoring in Marion Agent tells Life (its copy stays).
outbox.noteRestoredBot(userId, botId, 1_700_000_000_000);
await outbox.drainLifeOutbox(userId, { manual: true });
const restored = calls.at(-1);
assert.equal(restored.name, 'archive_deleted_item');
assert.equal(restored.args.status, 'restored');
assert.equal(restored.args.archive_id, `${botId}:1700000000000`);
console.log('PASS: a restore is reported; the archive stays.');

rmSync(work, { recursive: true, force: true });
process.exit(0);
