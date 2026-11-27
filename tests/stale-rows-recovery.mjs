// Orphaned `running` tool-call rows and work cards (QA: Chungoosey seq 8/9, Sift seq 14/15 still spinning with no live
// turn or session). Covers both recovery paths and what they must NOT touch:
//  - Startup (recoverStaleRows): every running tool call / work card from before the process start, any age or seq, on
//    every bot, including older/partial card shapes that used to throw (and stay running); idempotent.
//  - Turn end (recoverOrphanRows): a bot with no run left finalizes its orphaned rows without waiting for a restart.
//  - Negative: rows created after the cutoff, finished rows, other card kinds, older chat generations, queued calls of a
//    turn paused for approval (pending_turns: they continue after the owner answers, even across a restart), and work
//    cards whose relayed/Cloud session is still running or waiting.
//  - Wiring: startup runs row recovery on its own (not only inside session cleanup); the turn's finally runs the sweep
//    only once no run and no approval is left.
// No network, no listener, no model calls. Usage: npm run build && node tests/stale-rows-recovery.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DB_PATH = ':memory:';
process.env.MARION_DESKTOP_TOKEN = 'test-token';
process.env.MARION_NO_SCHEDULER = '1';
process.env.HOST = '127.0.0.1';

const { db, now } = await import('../server/dist/db.js');
await import('../server/dist/features/schema.js');
const { appendRow, getRow } = await import('../server/dist/store.js');
const S = await import('../server/dist/features/agent-sessions.js');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok - ${name}`); };
const userId = 'u1';
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(userId, 'a@example.com', 'A', now());
const addBot = (id, name) => db.prepare('INSERT INTO bots(id,user_id,name,label,description,instructions,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(id, userId, name, '', '', '', now(), now());
const tool = (botId, name = 'ask_subscription', extra = {}) => appendRow(botId, 'tool-call', { type: 'tool-call', callId: `c${Math.random()}`, name, label: 'Asking', status: 'running', ...extra }).seq;
const work = (botId, extra = {}) => appendRow(botId, 'card', {
  type: 'card', card: 'work', title: 'Build it', agents: [{ id: 'worker-0', label: 'Gemini', provider: 'gemini', model: 'm', role: 'worker', usage: { live: true } }],
  phases: [{ title: 'Plan', status: 'running' }], steps: [], live: true, status: 'running', startedAt: now(), ...extra,
}).seq;
const age = (botId, seqs, ms = 3_600_000) => { for (const seq of seqs) db.prepare('UPDATE rows SET created_at=? WHERE bot_id=? AND seq=?').run(now() - ms, botId, seq); };
const status = (botId, seq) => getRow(botId, seq).body.status;
const pad = (botId, n) => { for (let i = 0; i < n; i++) appendRow(botId, 'message', { type: 'message', role: 'user', text: `m${i}` }); };
const pend = (botId, rowSeqs) => db.prepare('INSERT OR REPLACE INTO pending_turns(bot_id,state) VALUES (?,?)')
  .run(botId, JSON.stringify({ calls: rowSeqs.map((rowSeq, i) => ({ call_id: `p${i}`, name: 'bash', arguments: '{}', rowSeq })), outputs: [], approvalId: 'apr_x', depth: 0 }));

// Two chats shaped like QA's: Chungoosey seq 8/9 and Sift seq 14/15, both from long ago.
addBot('chung', 'Chungoosey'); addBot('sift', 'Sift');
pad('chung', 7); const cTool = tool('chung'); const cCard = work('chung');
pad('sift', 13); const sTool = tool('sift'); const sCard = work('sift');
age('chung', [cTool, cCard], 3 * 86_400_000); age('sift', [sTool, sCard], 3 * 86_400_000);

test('fixture matches QA: Chungoosey 8/9 and Sift 14/15 are running', () => {
  assert.deepEqual([cTool, cCard, sTool, sCard], [8, 9, 14, 15]);
  for (const [b, s] of [['chung', 8], ['chung', 9], ['sift', 14], ['sift', 15]]) assert.equal(status(b, s), 'running');
});

// Startup-path fixtures (bot "startup").
addBot('startup', 'Startup');
const legacyCard = appendRow('startup', 'card', { type: 'card', card: 'work', title: 'Old shape', status: 'running', startedAt: 1 }).seq; // no agents/phases/steps
const typelessTool = appendRow('startup', 'tool-call', { callId: 'old', name: 'bash', label: 'Running', status: 'running' }).seq; // no body.type
const doneTool = appendRow('startup', 'tool-call', { type: 'tool-call', callId: 'd', name: 'bash', label: 'Ran', status: 'done', summary: 'ok' }).seq;
const approval = appendRow('startup', 'card', { type: 'card', card: 'approval', approvalId: 'apr_x', title: 'Allow?', tool: 'bash', args: {}, status: 'pending' }).seq;
const awaiting = tool('startup', 'bash', { status: 'awaiting-approval' });
const queued = tool('startup', 'bash'); // queued behind the approval: still owned by the paused turn
pend('startup', [awaiting, queued]);
age('startup', [legacyCard, typelessTool, doneTool, approval, awaiting, queued]);
// An older chat generation: not shown, never rewritten.
const oldGen = tool('startup'); age('startup', [oldGen]);
db.prepare('UPDATE rows SET generation = generation - 1 WHERE bot_id=? AND seq=?').run('startup', oldGen);
// Created after the cutoff (a turn resumed by this process): live.
const fresh = tool('startup'); const freshCard = work('startup');

const cutoff = now() - 60_000;
let fixedAtStartup;
test('startup recovery finalizes every orphaned row from before the process start (both bots, any seq, legacy shapes)', () => {
  fixedAtStartup = S.recoverStaleRows(cutoff);
  assert.equal(fixedAtStartup, 6, 'chung 8/9, sift 14/15, legacy card, type-less tool call');
  for (const [b, s] of [['chung', cTool], ['sift', sTool]]) {
    const body = getRow(b, s).body;
    assert.equal(body.status, 'error'); assert.match(body.summary, /restarted before this finished/);
  }
  for (const [b, s] of [['chung', cCard], ['sift', sCard]]) {
    const body = getRow(b, s).body;
    assert.equal(body.status, 'stopped'); assert.ok(body.endedAt > 0); assert.equal(body.stop, undefined);
    assert.deepEqual(body.phases.map((p) => p.status), ['failed']); assert.equal(body.agents[0].usage.live, false);
    assert.match(body.steps.at(-1).text, /restarted/);
  }
  const legacy = getRow('startup', legacyCard).body;
  assert.equal(legacy.status, 'stopped', 'a card without agents/phases/steps no longer throws and stays running');
  assert.deepEqual(legacy.agents, []); assert.deepEqual(legacy.phases, []); assert.equal(legacy.steps.length, 1);
  const typeless = getRow('startup', typelessTool).body;
  assert.equal(typeless.status, 'error'); assert.equal(typeless.type, 'tool-call');
});

test('negative (startup): live, finished, paused-for-approval, other-card and old-generation rows untouched', () => {
  assert.equal(status('startup', fresh), 'running', 'created after the cutoff');
  assert.equal(status('startup', freshCard), 'running', 'card created after the cutoff');
  assert.equal(status('startup', doneTool), 'done');
  assert.equal(getRow('startup', doneTool).body.summary, 'ok');
  assert.equal(status('startup', approval), 'pending', 'approval card is not a running row');
  assert.equal(status('startup', awaiting), 'awaiting-approval');
  assert.equal(status('startup', queued), 'running', 'queued call of a paused turn continues after the owner answers');
  const old = db.prepare('SELECT body FROM rows WHERE bot_id=? AND seq=?').get('startup', oldGen);
  assert.equal(JSON.parse(old.body).status, 'running', 'older chat generation not rewritten');
});

test('startup recovery is idempotent', () => assert.equal(S.recoverStaleRows(cutoff), 0));

test('recoverAgentSessions still finalizes stale rows (and survives a row failure)', () => {
  addBot('sess', 'Sess');
  const t = tool('sess'); age('sess', [t]);
  S.recoverAgentSessions();
  assert.equal(status('sess', t), 'error');
});

// Turn-end sweep (bot "live"): rows orphaned while this process kept running.
addBot('live', 'Live');
const orphanTool = tool('live');
const orphanCard = work('live');
test('turn end: orphaned tool call and work card are finalized without a restart', () => {
  assert.equal(S.recoverOrphanRows('live'), 2);
  const t = getRow('live', orphanTool).body;
  assert.equal(t.status, 'error'); assert.match(t.summary, /run ended before this finished/);
  const c = getRow('live', orphanCard).body;
  assert.equal(c.status, 'stopped'); assert.match(c.steps.at(-1).text, /run ended/);
  assert.equal(S.recoverOrphanRows('live'), 0, 'idempotent');
});

test('negative (turn end): live session card, paused-turn calls and other bots are left alone', () => {
  addBot('cloud', 'Cloud');
  const cloudCard = work('cloud', { stop: { kind: 'cloud', sessionId: 's1' } });
  const queuedCall = tool('cloud', 'bash');
  const strayCall = tool('cloud', 'bash');
  pend('cloud', [queuedCall]);
  db.prepare('INSERT INTO agent_sessions(id,user_id,bot_id,provider,kind,title,status,started_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('s1', userId, 'cloud', 'claude', 'cloud', 'Cloud', 'running', now(), now());
  const otherBot = tool('chung');
  assert.equal(S.recoverOrphanRows('cloud'), 1, 'only the stray tool call');
  assert.equal(status('cloud', cloudCard), 'running', 'the Cloud session still updates its card');
  assert.equal(status('cloud', queuedCall), 'running', 'owned by the turn paused for approval');
  assert.equal(status('cloud', strayCall), 'error');
  assert.equal(status('chung', otherBot), 'running', 'another bot is never swept');
  // The Cloud session ends: now its card is an orphan too.
  db.prepare("UPDATE agent_sessions SET status='stopped' WHERE id='s1'").run();
  assert.equal(S.recoverOrphanRows('cloud'), 1);
  assert.equal(status('cloud', cloudCard), 'stopped');
  // "waiting" sessions protect cards as well.
  const waitingCard = work('cloud');
  db.prepare("UPDATE agent_sessions SET status='waiting' WHERE id='s1'").run();
  assert.equal(S.recoverOrphanRows('cloud'), 0);
  assert.equal(status('cloud', waitingCard), 'running');
});

test('wiring: startup runs row recovery by itself; the turn sweep runs only with no run and no approval left', () => {
  const index = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8');
  assert.match(index, /try \{ const n = recoverStaleRows\(\);/);
  const loop = readFileSync(new URL('../server/src/agent/loop.ts', import.meta.url), 'utf8');
  assert.match(loop, /if \(!othersLeft && !stillPending && sameChat\) \{ try \{ recoverOrphanRows\(botId\); \}/);
});

console.log(`PASS stale-rows-recovery (${passed} tests): orphaned running tool calls/work cards finalized at startup and at turn end; active rows untouched`);
