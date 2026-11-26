// Sessions inside Marion Agent: bot chat sessions and relayed agent sessions (Claude, Codex, Gemini) are recorded locally
// and returned by the sessions query that backs GET /api/sessions/marion and GET /api/bots/:id/sessions.
// Uses a temporary database; no network, no real CLIs.
// Usage: node --import tsx tests/sessions.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'marion-sessions-'));
process.env.DB_PATH = join(work, 'marion.db');
process.env.MARION_NO_SCHEDULER = '1';

const { db, now } = await import('../server/src/db.ts');
await import('../server/src/features/schema.ts');
const { initSubagents } = await import('../server/src/agent/subagents.ts');
const { initRooms } = await import('../server/src/agent/rooms.ts');
initSubagents(); initRooms();
const { appendRow, clearConversation } = await import('../server/src/store.ts');
const { hub } = await import('../server/src/lib/hub.ts');
const sessions = await import('../server/src/features/agent-sessions.ts');

const userId = 'user_test';
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(userId, 'owner@example.com', 'Owner', now());
const addBot = (id, name) => db.prepare('INSERT INTO bots(id,user_id,name,label,description,instructions,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(id, userId, name, 'Helper', '', '', now(), now());
addBot('bot_a', 'Quinn');
addBot('bot_b', 'Rowan');

const events = [];
hub.subscribe(userId, event => { if (event.type === 'sessions') events.push(event); });

// ---- bot chat sessions: one per conversation (generation), with message counts, titles and the "active" one flagged.
appendRow('bot_a', 'message', { type: 'message', role: 'user', text: 'Please look into the login bug' });
appendRow('bot_a', 'message', { type: 'message', role: 'assistant', text: 'Found it: the redirect drops the query string.' });
clearConversation('bot_a'); // starts conversation 2
appendRow('bot_a', 'message', { type: 'message', role: 'user', text: 'Draft the release notes' });
appendRow('bot_b', 'message', { type: 'message', role: 'user', text: 'What is on my calendar?' });

const chats = sessions.listSessions(userId, { type: 'chat' });
assert.equal(chats.length, 3, 'two conversations of Quinn and one of Rowan');
const quinnOld = chats.find(s => s.botId === 'bot_a' && s.generation === 1);
const quinnNew = chats.find(s => s.botId === 'bot_a' && s.generation === 2);
assert.equal(quinnOld.status, 'archived');
assert.equal(quinnOld.messageCount, 2);
assert.equal(quinnOld.title, 'Please look into the login bug');
assert.match(quinnOld.summary, /redirect drops the query string/);
assert.equal(quinnNew.status, 'active');
assert.equal(quinnNew.messageCount, 1);
assert.equal(quinnNew.botName, 'Quinn');
assert.ok(chats.every(s => s.type === 'chat' && s.provider === null && s.startedAt > 0 && s.updatedAt >= s.startedAt));
assert.equal(sessions.listSessions(userId, { botId: 'bot_b', type: 'chat' }).length, 1, 'per-bot filter');
const peek = sessions.chatSessionMessages(userId, 'bot_a', 1);
assert.deepEqual(peek.map(m => m.role), ['user', 'assistant'], 'an earlier conversation can be read');
assert.equal(sessions.chatSessionMessages('someone_else', 'bot_a', 1), null, 'another owner cannot read it');
console.log('PASS: bot chat sessions list every conversation with counts, titles and the active one.');

// ---- relayed agent sessions: Claude, Codex and Gemini, by every route that relays.
const track = (id, kind, extra = {}) => ({ id, kind, userId, botId: 'bot_a', request: `Request for ${id}\nwith details`, ...extra });
const folder = { path: '/Users/x/Marion Agent', label: 'Marion Agent' };

const claude = track('ask:bot_a:2:1', 'ask_subscription', { title: 'Fix login redirect', folder, groupId: 'bot_a:2:claude:1', rotated: 'the folder changed' });
sessions.beginAgentSession(claude, 'claude', Date.now() - 4000);
let running = sessions.listSessions(userId, { type: 'relay' });
assert.equal(running.length, 1);
assert.equal(running[0].status, 'running', 'a started run shows as running before it ends');
assert.equal(running[0].provider, 'claude');
assert.ok(running[0].durationMs >= 3000, 'running duration is live');
sessions.finishAgentSession(claude, 'claude', {
  status: 'completed', reply: 'Final: the redirect now keeps the query string.', startedAt: Date.now() - 4000, endedAt: Date.now(),
  model: { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', effort: 'medium' }, tokens: { input: 100, output: 20 },
});

const codex = track('orchestrate:bot_a:r1:worker-0', 'orchestration', { role: 'worker', agent: 'Codex Worker', groupId: 'orchestrate:bot_a:r1' });
sessions.beginAgentSession(codex, 'codex', Date.now() - 2000);
sessions.beginAgentSession(codex, 'codex', Date.now() - 1900); // a second call of the same session runs in parallel
sessions.finishAgentSession(codex, 'codex', { status: 'completed', reply: 'Plan done.', startedAt: Date.now() - 2000, endedAt: Date.now(), model: { id: 'gpt-5' }, tokens: { input: 10, output: 5 } });
assert.equal(sessions.listSessions(userId, { provider: 'codex' })[0].status, 'running', 'still running while another call of it is open');
sessions.finishAgentSession(codex, 'codex', { status: 'completed', reply: 'Tasks done.', startedAt: Date.now() - 1900, endedAt: Date.now(), tokens: { input: 7, output: 3 } });

const gemini = track('team:bot_a:t1:gemini', 'team', { botId: 'bot_b', role: 'discussion', agent: 'Gemini Neon' });
sessions.beginAgentSession(gemini, 'gemini');
sessions.finishAgentSession(gemini, 'gemini', { status: 'failed', error: 'Gemini took too long to respond.', startedAt: Date.now(), endedAt: Date.now() });

const stoppedTrack = track('turn:bot_a:2:9', 'subscription_bot');
sessions.beginAgentSession(stoppedTrack, 'claude');
sessions.finishAgentSession(stoppedTrack, 'claude', { status: 'stopped', error: 'Stopped', startedAt: Date.now(), endedAt: Date.now() });

const live = track('ask:bot_a:2:99', 'ask_subscription');
sessions.beginAgentSession(live, 'gemini');

const relays = sessions.listSessions(userId, { type: 'relay' });
assert.equal(relays.length, 5);
assert.equal(relays[0].status, 'running', 'running sessions come first');
assert.equal(relays[0].provider, 'gemini');

const byId = id => relays.find(s => s.id === `relay:${id}`);
const c = byId(claude.id);
assert.equal(c.status, 'completed');
assert.equal(c.title, 'Fix login redirect');
assert.equal(c.kind, 'ask_subscription');
assert.match(c.summary, /keeps the query string/);
assert.deepEqual(c.folder, { name: 'Marion Agent', path: '/Users/x/Marion Agent' });
assert.equal(c.modelLabel, 'Claude Opus 5.5');
assert.equal(c.effort, 'medium');
assert.deepEqual(c.tokens, { input: 100, output: 20 });
assert.equal(c.botName, 'Quinn');
assert.equal(c.chatId, 'bot_a:2');
assert.equal(c.generation, 2);
assert.equal(c.groupId, 'bot_a:2:claude:1');
assert.equal(c.rotated, 'the folder changed', 'rotation reason is kept');
assert.equal(c.calls, 1);
assert.ok(c.endedAt >= c.startedAt && c.durationMs >= 3000);

const o = byId(codex.id);
assert.equal(o.status, 'completed');
assert.equal(o.provider, 'codex');
assert.equal(o.kind, 'orchestration');
assert.equal(o.calls, 2, 'two calls merged into one session');
assert.deepEqual(o.tokens, { input: 17, output: 8 });
assert.equal(o.agent, 'Codex Worker');

const g = byId(gemini.id);
assert.equal(g.status, 'failed');
assert.equal(g.provider, 'gemini');
assert.equal(g.botName, 'Rowan');
assert.match(g.error, /took too long/);
assert.match(g.summary, /took too long/);
assert.equal(byId(stoppedTrack.id).status, 'stopped');
console.log('PASS: Claude, Codex and Gemini sessions are recorded with status, folder, model, tokens, calls and rotation.');

// ---- filters
const ids = list => list.map(s => s.id).sort();
assert.deepEqual(ids(sessions.listSessions(userId, { provider: 'claude' })), ids([c, byId(stoppedTrack.id)]));
assert.equal(sessions.listSessions(userId, { provider: 'codex' }).length, 1);
assert.equal(sessions.listSessions(userId, { provider: 'gemini' }).length, 2);
assert.equal(sessions.listSessions(userId, { provider: 'gemini', status: 'running' }).length, 1);
assert.equal(sessions.listSessions(userId, { kind: 'team' }).length, 1);
assert.equal(sessions.listSessions(userId, { status: 'failed' }).length, 1);
assert.equal(sessions.listSessions(userId, { botId: 'bot_b' }).length, 2, 'Rowan: one chat and one Gemini run');
assert.equal(sessions.listSessions(userId, { botId: 'bot_a', type: 'relay' }).length, 4);
const all = sessions.listSessions(userId);
assert.equal(all.length, 8, 'chats and relays together');
assert.equal(all[0].status, 'running');
assert.equal(sessions.listSessions(userId, { limit: 3 }).length, 3);
assert.equal(sessions.listSessions('someone_else').length, 0, 'sessions are private to their owner');
console.log('PASS: filters by bot, type, kind, provider and status work; the combined list has both kinds.');

// ---- live updates: the UI is told when a session starts or ends
assert.ok(events.length >= 10 && events.every(e => e.botId), 'a sessions event fires for every start and finish');
console.log('PASS: starts and finishes emit live "sessions" events.');

// ---- a restart cuts off anything still running
assert.equal(sessions.recoverAgentSessions(), 1);
const cut = sessions.listSessions(userId, { type: 'relay' }).find(s => s.id === `relay:${live.id}`);
assert.equal(cut.status, 'stopped');
assert.match(cut.error, /restarted/);
console.log('PASS: runs left "running" by a restart are marked stopped.');

// ---- the real hook: subscriptionReply records the run for every provider, even when the run cannot start
const { subscriptionReply } = await import('../server/src/agent/subscriptions.ts');
const { isDesktop } = await import('../server/src/lib/desktop-access.ts');
if (isDesktop) console.log('SKIP: hook check (this run is the desktop app; it would start the real CLIs).');
else {
  for (const provider of ['claude', 'codex', 'gemini']) {
    const hook = track(`hook:${provider}`, 'ask_subscription', { title: `Hook ${provider}` });
    await assert.rejects(subscriptionReply({ provider, model: 'm', effort: null }, 'hi', new AbortController().signal, [], { session: hook }));
    const saved = sessions.listSessions(userId, { provider }).find(s => s.title === `Hook ${provider}`);
    assert.ok(saved, `${provider} run was recorded`);
    assert.equal(saved.status, 'failed');
    assert.ok(saved.error);
  }
  console.log('PASS: subscriptionReply records Claude, Codex and Gemini runs (failed ones too).');
}

rmSync(work, { recursive: true, force: true });
process.exit(0);
