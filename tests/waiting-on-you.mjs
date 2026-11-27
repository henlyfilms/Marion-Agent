// Tasks → Waiting on You: one shared record (the chat's own card rows), answered from Tasks with the chat's own routes
// and rules, two-way sync without duplicates, persistence across a restart, stale/expired cards, and the Tasks badge.
// In-process only: a temporary SQLite file, Hono's app.request (no ports), no providers, no network. The "restart" is a
// second Node process that opens the same database file.
// Usage: npm run build && node tests/waiting-on-you.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'marion-waiting-'));
const dbPath = join(dir, 'marion.db');
const env = { DB_PATH: dbPath, MARION_DESKTOP_TOKEN: 'test-token', MARION_NO_SCHEDULER: '1', HOST: '127.0.0.1', SERVER_URL: 'http://127.0.0.1:8787' };
Object.assign(process.env, env);

const { db, now } = await import('../server/dist/db.js');
await import('../server/dist/features/schema.js');
await import('../server/dist/db-config.js');
(await import('../server/dist/agent/subagents.js')).initSubagents();
(await import('../server/dist/agent/rooms.js')).initRooms();
const { appendRow, getRow, updateRow, clearConversation } = await import('../server/dist/store.js');
const { hub } = await import('../server/dist/lib/hub.js');
const L = await import('../server/dist/agent/loop.js');
const W = await import('../server/dist/features/waiting.js');
const { showQuestionCard } = await import('../server/dist/agent/work-feed.js');
const { api } = await import('../server/dist/routes.js');

const userId = 'user_owner';
const otherUser = 'user_other';
for (const [id, email] of [[userId, 'owner@example.com'], [otherUser, 'other@example.com']])
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, email, 'Owner', now());
const addBot = (id, name, owner = userId) => db.prepare('INSERT INTO bots(id,user_id,name,label,description,instructions,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(id, owner, name, 'Helper', '', '', now(), now());
addBot('bot_q', 'Quinn'); addBot('bot_a', 'Ada'); addBot('bot_t', 'Tess'); addBot('bot_h', 'Hidden'); addBot('bot_x', 'Xena', otherUser);
db.prepare('UPDATE bots SET hidden=1 WHERE id=?').run('bot_h');
db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run('owner-session', userId, now(), now() + 3_600_000);

const origin = 'http://127.0.0.1:8787';
const cookie = 'marion_agent_session=owner-session';
const call = (method, path, body, extra = {}) => api.request(`${origin}${path}`, {
  method, headers: { 'Content-Type': 'application/json', cookie, ...extra }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const waiting = async () => { const r = await call('GET', '/waiting'); assert.equal(r.status, 200); return r.json(); };

// Every trigger a resolution would start, instead of real turns.
const enqueued = [];
L.setEnqueueForTests((botId, trigger) => enqueued.push({ botId, type: trigger.type, text: trigger.text }));
// Every 'waiting' event the badge listens for.
const events = [];
hub.subscribe(userId, ev => { if (ev.type === 'waiting') events.push(ev); });

/** The approval card the loop writes when a tool needs the owner's OK (card + approvals row + paused turn). */
let apn = 0;
function approvalCard(botId, tool = 'GMAIL_SEND_EMAIL', { paused = true } = {}) {
  const approvalId = `apr_test_${++apn}`;
  const card = appendRow(botId, 'card', { type: 'card', card: 'approval', approvalId, title: `Allow ${tool}?`, detail: '', tool, args: {}, status: 'pending' });
  db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES (?,?,?,?,?,?,?)').run(approvalId, botId, card.seq, `call_${apn}`, tool, 'pending', now());
  if (paused) db.prepare('INSERT OR REPLACE INTO pending_turns(bot_id,state) VALUES (?,?)').run(botId, JSON.stringify({ approvalId }));
  return { approvalId, seq: card.seq };
}
const resetPaused = botId => db.prepare('DELETE FROM pending_turns WHERE bot_id=?').run(botId);

try {
  // ---------- badge counts: create ----------
  let w = await waiting();
  assert.deepEqual([w.count, w.items.length], [0, 0], 'nothing waiting at first');
  const ev0 = events.length;
  showQuestionCard('bot_q', userId, 'Which colour should the logo be?', ['Blue', 'Green']);
  const qSeq = getRow('bot_q', 1).seq;
  assert.ok(events.length > ev0, 'a new question card emits a waiting event (the badge reloads)');
  w = await waiting();
  assert.equal(w.count, 1);
  assert.equal(w.items[0].kind, 'card');
  assert.equal(w.items[0].card, 'question');
  assert.equal(w.items[0].row.seq, qSeq);
  assert.equal(w.items[0].botName, 'Quinn');
  console.log('PASS badge: a new question card counts 1 and emits a waiting event');

  // ---------- reply to a question from Tasks (partial input, double resolve, race) ----------
  let r = await call('POST', `/bots/bot_q/cards/${qSeq}/answer`, { answer: '   ' });
  assert.equal(r.status, 400, 'a blank answer is refused');
  r = await call('POST', `/bots/bot_q/cards/${qSeq}/answer`, {});
  assert.equal(r.status, 400, 'a missing answer is refused');
  r = await call('POST', `/bots/bot_q/cards/${qSeq}/answer`, { answer: 42 });
  assert.equal(r.status, 400, 'a non-text answer is refused');
  assert.equal(getRow('bot_q', qSeq).body.status, 'pending', 'partial input leaves the card pending');
  assert.equal(enqueued.length, 0, 'partial input starts nothing');
  assert.equal((await waiting()).count, 1);

  const [a1, a2] = await Promise.all([
    call('POST', `/bots/bot_q/cards/${qSeq}/answer`, { answer: 'Blue' }),
    call('POST', `/bots/bot_q/cards/${qSeq}/answer`, { answer: 'Green' }),
  ]);
  assert.deepEqual([a1.status, a2.status].sort(), [200, 409], 'of two racing answers exactly one wins');
  const answered = getRow('bot_q', qSeq).body;
  assert.equal(answered.status, 'answered');
  const winner = a1.status === 200 ? 'Blue' : 'Green';
  assert.equal(answered.answer, winner, 'the card keeps the winning answer');
  assert.equal(enqueued.filter(e => e.botId === 'bot_q').length, 1, 'the bot is resumed once');
  assert.match(enqueued[0].text, new RegExp(`\\[Answer to "Which colour should the logo be\\?"\\] ${winner}`));
  const userMsgs = db.prepare("SELECT COUNT(*) n FROM rows WHERE bot_id='bot_q' AND kind='message' AND json_extract(body,'$.role')='user'").get().n;
  assert.equal(userMsgs, 1, 'one reply message in the chat, no duplicate');
  assert.equal((await call('POST', `/bots/bot_q/cards/${qSeq}/answer`, { answer: 'Again' })).status, 409, 'answering again is refused');
  assert.equal((await call('POST', `/bots/bot_q/cards/${qSeq}/dismiss`)).status, 409, 'skipping an answered card is refused');
  assert.equal((await waiting()).count, 0, 'answered: it leaves Waiting on You');
  console.log('PASS reply from Tasks: blank/missing/non-text answers refused; racing answers → one wins, one resume, one message; then 409');

  // ---------- approve and decline from Tasks (same rules as chat) ----------
  enqueued.length = 0;
  const allow = approvalCard('bot_a');
  w = await waiting();
  assert.equal(w.count, 1);
  assert.equal(w.items[0].card, 'approval');
  assert.equal((await call('POST', `/approvals/${allow.approvalId}`, { decision: 'maybe' })).status, 400, 'an unknown decision is refused');
  assert.equal((await call('POST', `/approvals/${allow.approvalId}`, {})).status, 400, 'a missing decision is refused');
  assert.equal(db.prepare('SELECT status FROM approvals WHERE id=?').get(allow.approvalId).status, 'pending');
  r = await call('POST', `/approvals/${allow.approvalId}`, { decision: 'allow' });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT status FROM approvals WHERE id=?').get(allow.approvalId).status, 'allowed');
  assert.equal(getRow('bot_a', allow.seq).body.status, 'allowed', 'the chat card shows the decision');
  assert.deepEqual(enqueued.map(e => e.type), ['resume'], 'Allow resumes the paused turn once');
  assert.equal((await call('POST', `/approvals/${allow.approvalId}`, { decision: 'deny' })).status, 409, 'a second decision is refused');
  assert.equal(db.prepare('SELECT status FROM approvals WHERE id=?').get(allow.approvalId).status, 'allowed', 'and changes nothing');
  assert.equal(enqueued.length, 1);
  resetPaused('bot_a');

  enqueued.length = 0;
  const deny = approvalCard('bot_a');
  r = await call('POST', `/approvals/${deny.approvalId}`, { decision: 'deny' });
  assert.equal(r.status, 200);
  assert.equal(getRow('bot_a', deny.seq).body.status, 'denied');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM policies WHERE user_id=? AND tool='GMAIL_SEND_EMAIL'").get(userId).n, 0, 'declining sets no policy');
  assert.deepEqual(enqueued.map(e => e.type), ['resume'], 'Don\'t allow resumes the turn (it reports the decline)');
  resetPaused('bot_a');

  // Race between Allow and Don't allow: one decision, one resume.
  enqueued.length = 0;
  const race = approvalCard('bot_a');
  const [d1, d2] = await Promise.all([
    call('POST', `/approvals/${race.approvalId}`, { decision: 'allow' }),
    call('POST', `/approvals/${race.approvalId}`, { decision: 'deny' }),
  ]);
  assert.deepEqual([d1.status, d2.status].sort(), [200, 409]);
  const final = db.prepare('SELECT status FROM approvals WHERE id=?').get(race.approvalId).status;
  assert.equal(final, d1.status === 200 ? 'allowed' : 'denied', 'the first decision is the one kept');
  assert.equal(getRow('bot_a', race.seq).body.status, final, 'card and approval agree');
  assert.equal(enqueued.length, 1, 'one resume');
  resetPaused('bot_a');

  // "Always allow" writes the policy, except for tools that must always ask (same rule as chat).
  const always = approvalCard('bot_a', 'SLACK_SEND_MESSAGE');
  assert.equal((await call('POST', `/approvals/${always.approvalId}`, { decision: 'always' })).status, 200);
  assert.equal(getRow('bot_a', always.seq).body.status, 'always');
  assert.equal(db.prepare("SELECT mode FROM policies WHERE user_id=? AND tool='SLACK_SEND_MESSAGE'").get(userId).mode, 'always_allow');
  resetPaused('bot_a');
  const repo = approvalCard('bot_a', 'github_create_repo');
  assert.equal((await call('POST', `/approvals/${repo.approvalId}`, { decision: 'always' })).status, 200);
  assert.equal(getRow('bot_a', repo.seq).body.status, 'allowed', 'github_create_repo is never "always"');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM policies WHERE user_id=? AND tool='github_create_repo'").get(userId).n, 0);
  resetPaused('bot_a');
  // (The Mac-only rule for GitHub repository creation lives in this same /approvals route, so Tasks inherits it; it needs
  // desktop mode with a configured remote host to exercise and is covered by the existing desktop-access tests.)
  // Another user's approval is not found.
  addBot('bot_x2', 'Xavi', otherUser);
  const foreign = approvalCard('bot_x2');
  assert.equal((await call('POST', `/approvals/${foreign.approvalId}`, { decision: 'allow' })).status, 404, 'another owner\'s approval is not found');
  assert.equal(db.prepare('SELECT status FROM approvals WHERE id=?').get(foreign.approvalId).status, 'pending');
  console.log('PASS approve/decline from Tasks: allow, deny, always (+ never-always tools), racing decisions → one wins, one resume; bad/missing decisions and other owners refused');

  // ---------- chat ↔ Tasks two-way sync, no duplicates ----------
  enqueued.length = 0;
  db.prepare("INSERT INTO tasks(id,bot_id,title,state,note,created_at,updated_at) VALUES ('task_t','bot_t','Pick a venue','needs_input','Two options ready',?,?)").run(now(), now());
  db.prepare("INSERT INTO tasks(id,bot_id,title,state,note,created_at,updated_at) VALUES ('task_q','bot_q','Logo','needs_input','',?,?)").run(now(), now());
  showQuestionCard('bot_q', userId, 'Serif or sans?', ['Serif', 'Sans']);
  w = await waiting();
  const keys = w.items.map(i => i.key);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate keys');
  assert.equal(w.items.filter(i => i.botId === 'bot_q').length, 1, 'a bot with a waiting card is listed once (its needs-input task is not repeated)');
  assert.equal(w.items.find(i => i.botId === 'bot_q').card, 'question');
  assert.ok(w.items.some(i => i.kind === 'task' && i.task.id === 'task_t'), 'a needs-input task with no card is listed');
  assert.equal(w.count, 2);
  // Answered in chat (the composer): the card closes in both places and the task goes back to working.
  const ev1 = events.length;
  r = await call('POST', '/bots/bot_q/messages', { text: 'Sans, please' });
  assert.equal(r.status, 200);
  const serif = db.prepare("SELECT body FROM rows WHERE bot_id='bot_q' AND kind='card' ORDER BY seq DESC LIMIT 1").get();
  assert.equal(JSON.parse(serif.body).status, 'answered', 'a chat reply answers the open question card');
  assert.equal(JSON.parse(serif.body).answer, 'Sans, please');
  assert.equal(db.prepare("SELECT state FROM tasks WHERE id='task_q'").get().state, 'working', 'its needs-input task is working again');
  assert.ok(events.length > ev1, 'the chat reply emits a waiting event');
  w = await waiting();
  assert.deepEqual(w.items.map(i => i.key), ['task:task_t'], 'only the other bot\'s task is still waiting');
  // Replied from Tasks (same messages route): the task leaves Waiting on You and the bot gets the message once.
  enqueued.length = 0;
  r = await call('POST', '/bots/bot_t/messages', { text: 'The second venue', clientId: 'tasks-reply-0001' });
  assert.equal(r.status, 200);
  const again = await call('POST', '/bots/bot_t/messages', { text: 'The second venue', clientId: 'tasks-reply-0001' });
  assert.equal((await again.json()).duplicate, true, 'a retried reply is not posted twice');
  assert.equal(enqueued.filter(e => e.botId === 'bot_t').length, 1, 'the bot gets the reply once');
  assert.equal(db.prepare("SELECT state FROM tasks WHERE id='task_t'").get().state, 'working');
  assert.equal((await waiting()).count, 0);
  // A card answered from Tasks is the chat's own row (the same object, not a copy).
  const shared = approvalCard('bot_a');
  const inTasks = (await waiting()).items.find(i => i.kind === 'card' && i.card === 'approval');
  assert.deepEqual(inTasks.row, getRow('bot_a', shared.seq), 'Tasks shows the chat\'s own card row');
  await call('POST', `/approvals/${shared.approvalId}`, { decision: 'allow' });
  assert.equal(getRow('bot_a', shared.seq).body.status, 'allowed', 'resolved from Tasks → resolved in chat');
  assert.equal((await waiting()).count, 0);
  resetPaused('bot_a');
  console.log('PASS chat ↔ Tasks sync: one item per card, needs-input task deduped behind its card, chat replies close Tasks items, Tasks replies close chat cards, retries not duplicated');

  // ---------- non-actionable items never appear ----------
  appendRow('bot_t', 'card', { type: 'card', card: 'work', title: 'Team run', agents: [], phases: [], steps: [], live: false, status: 'needs-input', startedAt: now(), question: 'Q?' });
  appendRow('bot_t', 'card', { type: 'card', card: 'question', question: 'Old?', options: [], status: 'dismissed' });
  appendRow('bot_t', 'card', { type: 'card', card: 'connect', toolkit: 'gmail', toolkitName: 'Gmail', reason: 'x', status: 'connected' });
  appendRow('bot_t', 'card', { type: 'card', card: 'cloud', id: 'c_work', mode: 'setup', goal: 'g', query: 'q', generation: 0, problem: 'p', solution: 's', options: [], status: 'working' });
  appendRow('bot_t', 'card', { type: 'card', card: 'sign-in', id: 's_done', provider: 'gemini', providerName: 'Google', reason: 'r', command: 'c', status: 'signed-in' });
  appendRow('bot_t', 'notice', { type: 'notice', text: 'Something went wrong', tone: 'error' });
  appendRow('bot_t', 'message', { type: 'message', role: 'assistant', text: 'Do you want me to go on?' });
  showQuestionCard('bot_h', userId, 'Hidden bot question?', []);
  showQuestionCard('bot_x', otherUser, 'Another owner\'s question?', []);
  db.prepare("INSERT INTO tasks(id,bot_id,title,state,note,created_at,updated_at) VALUES ('task_w','bot_t','Working','working','',?,?),('task_d','bot_t','Done','done','',?,?)").run(now(), now(), now(), now());
  showQuestionCard('bot_t', userId, 'From the old conversation?', []);
  clearConversation('bot_t');
  assert.equal((await waiting()).count, 0, 'work cards, resolved cards, a Cloud card being worked on, notices, messages, hidden bots, other owners, working/done tasks and old conversations are not listed');
  // A deleted chat's cards leave too.
  showQuestionCard('bot_t', userId, 'Before delete?', []);
  assert.equal((await waiting()).count, 1);
  db.prepare('UPDATE bots SET deleted_at=? WHERE id=?').run(now(), 'bot_t');
  assert.equal((await waiting()).count, 0, 'a deleted chat\'s cards are not listed');
  db.prepare('UPDATE bots SET deleted_at=NULL WHERE id=?').run('bot_t');
  clearConversation('bot_t');
  console.log('PASS non-actionable: work/resolved/working cards, notices, messages, hidden/deleted/other-owner chats, done/working tasks and cleared conversations stay out');

  // ---------- stale / expired cards (and badge counts on expire) ----------
  enqueued.length = 0;
  const evExpire = events.length;
  const orphan = approvalCard('bot_a', 'GMAIL_SEND_EMAIL', { paused: false }); // no paused turn: Allow could resume nothing
  const decided = approvalCard('bot_a'); // decided elsewhere, card not updated
  db.prepare("UPDATE approvals SET status='denied' WHERE id=?").run(decided.approvalId);
  const perm = appendRow('bot_q', 'card', { type: 'card', card: 'cloud', id: 'perm_dead', mode: 'permission', goal: 'g', query: 'o/r', generation: 0,
    problem: 'Claude Cloud wants to use Bash', solution: 'Allow?', options: [{ id: 'allow', kind: 'retry', label: 'Allow' }, { id: 'deny', kind: 'cancel', label: "Don't allow" }], status: 'pending' });
  db.prepare("INSERT INTO agent_sessions(id,user_id,bot_id,provider,kind,title,status,started_at,updated_at) VALUES ('sess_closed',?,?,'claude','cloud','Cloud run','stopped',?,?)").run(userId, 'bot_q', now(), now());
  const setup = appendRow('bot_q', 'card', { type: 'card', card: 'cloud', id: 'setup_closed', mode: 'setup', goal: 'g', query: 'o/r', generation: 0, sessionId: 'sess_closed',
    problem: 'p', solution: 's', options: [{ id: 'cancel', kind: 'cancel', label: 'Cancel' }], status: 'pending' });
  const live = showQuestionCard('bot_q', userId, 'Still live?', []);
  w = await waiting();
  assert.deepEqual(w.items.map(i => i.card), ['question'], 'only the live question is listed; stale cards are not counted');
  assert.equal(getRow('bot_a', orphan.seq).body.status, 'expired', 'an approval with no paused turn expires');
  assert.equal(db.prepare('SELECT status FROM approvals WHERE id=?').get(orphan.approvalId).status, 'expired');
  assert.equal(getRow('bot_a', decided.seq).body.status, 'denied', 'a card decided elsewhere is synced, not re-asked');
  assert.equal(getRow('bot_q', perm.seq).body.status, 'expired', 'a Cloud permission with no waiting launch expires');
  assert.equal(getRow('bot_q', perm.seq).body.note, W.STALE_NOTES.restart);
  assert.equal(getRow('bot_q', setup.seq).body.status, 'expired', 'a Cloud setup card whose request was closed expires');
  assert.ok(events.length > evExpire, 'expiring emits waiting events (the badge drops live)');
  assert.equal(W.sweepStaleWaiting(userId), 0, 'expired cards are closed once, not again');
  // Expired cards can't be acted on afterwards.
  assert.equal((await call('POST', `/approvals/${orphan.approvalId}`, { decision: 'allow' })).status, 409, 'an expired approval can\'t be allowed');
  assert.equal(enqueued.filter(e => e.type === 'resume').length, 0, 'and resumes nothing');
  // A question superseded by a new chat message leaves the list.
  await call('POST', '/bots/bot_q/messages', { text: 'Never mind, do whatever' });
  assert.equal((await waiting()).count, 0, 'a superseded question is closed');
  void live;
  console.log('PASS stale/expired: orphan approvals expire, decided approvals sync, dead Cloud permissions and closed Cloud requests expire, superseded questions close; nothing stays stuck or counts');

  // ---------- badge counts through create → resolve → expire ----------
  const counts = [];
  const snap = async () => counts.push((await waiting()).count);
  await snap();
  showQuestionCard('bot_q', userId, 'One?', []); await snap();
  const b2 = approvalCard('bot_a'); await snap();
  await call('POST', `/approvals/${b2.approvalId}`, { decision: 'deny' }); await snap();
  resetPaused('bot_a');
  const b3 = approvalCard('bot_a'); await snap();
  resetPaused('bot_a'); await snap(); // its paused turn is gone → expires on the next read
  await call('POST', '/bots/bot_q/messages', { text: 'One.' }); await snap();
  assert.deepEqual(counts, [0, 1, 2, 1, 2, 1, 0], 'count follows create/resolve/expire and returns to 0');
  assert.equal(getRow('bot_a', b3.seq).body.status, 'expired');
  console.log('PASS badge counts: 0 → 1 → 2 → 1 (resolved) → 2 → 1 (expired) → 0');

  // ---------- persistence across restart (a second process on the same database file) ----------
  enqueued.length = 0;
  const pq = showQuestionCard('bot_q', userId, 'Ship it tonight?', ['Yes', 'No']);
  const pqSeq = db.prepare("SELECT MAX(seq) s FROM rows WHERE bot_id='bot_q'").get().s;
  const pa = approvalCard('bot_a');
  const pp = appendRow('bot_a', 'card', { type: 'card', card: 'cloud', id: 'perm_restart', mode: 'permission', goal: 'g', query: 'o/r', generation: 0,
    problem: 'p', solution: 's', options: [{ id: 'allow', kind: 'retry', label: 'Allow' }, { id: 'deny', kind: 'cancel', label: "Don't allow" }], status: 'pending' });
  void pq;
  const child = `
    const { db } = await import(${JSON.stringify(join(root, 'server/dist/db.js'))});
    await import(${JSON.stringify(join(root, 'server/dist/features/schema.js'))});
    (await import(${JSON.stringify(join(root, 'server/dist/agent/subagents.js'))})).initSubagents();
    (await import(${JSON.stringify(join(root, 'server/dist/agent/rooms.js'))})).initRooms();
    const W = await import(${JSON.stringify(join(root, 'server/dist/features/waiting.js'))});
    const L = await import(${JSON.stringify(join(root, 'server/dist/agent/loop.js'))});
    const { api } = await import(${JSON.stringify(join(root, 'server/dist/routes.js'))});
    const resumed = []; L.setEnqueueForTests((b, t) => resumed.push(t.type));
    const swept = W.sweepStaleWaiting();
    const before = W.listWaiting(${JSON.stringify(userId)}).map(i => i.card);
    const r = await api.request('http://127.0.0.1:8787/bots/bot_q/cards/${pqSeq}/answer', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: ${JSON.stringify(cookie)} }, body: JSON.stringify({ answer: 'Yes' }) });
    const after = W.listWaiting(${JSON.stringify(userId)}).map(i => i.card);
    console.log(JSON.stringify({ swept, before, status: r.status, after, resumed }));
    db.close();
    process.exit(0);
  `;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', child], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000 }).trim().split('\n').at(-1));
  assert.equal(out.swept, 1, 'after restart the dead Cloud permission card is swept');
  assert.deepEqual(out.before.sort(), ['approval', 'question'], 'after restart the question and the approval are still waiting');
  assert.equal(out.status, 200, 'answerable from Tasks after restart');
  assert.deepEqual(out.after, ['approval']);
  assert.deepEqual(out.resumed, ['user']);
  // Back in this process (the other surface): the same record shows the answer.
  assert.equal(getRow('bot_q', pqSeq).body.status, 'answered');
  assert.equal(getRow('bot_q', pqSeq).body.answer, 'Yes');
  assert.equal(getRow('bot_a', pp.seq).body.status, 'expired');
  assert.deepEqual((await waiting()).items.map(i => i.card), ['approval'], 'no duplicates after restart');
  assert.equal((await call('POST', `/approvals/${pa.approvalId}`, { decision: 'allow' })).status, 200, 'the approval survives restart and resolves');
  assert.equal((await waiting()).count, 0);
  resetPaused('bot_a');
  console.log('PASS persistence: cards survive a restart (second process, same DB), dead Cloud waits are swept, answers made after restart show on both surfaces');

  // ---------- the real UI: Waiting on You section and the Tasks badge (server-rendered) ----------
  const { build } = await import('esbuild');
  const out2 = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'waiting-ssr-'));
  await build({
    entryPoints: [join(root, 'tests/fixtures/waiting-ssr.tsx')], bundle: true, outdir: out2, format: 'cjs', platform: 'node', jsx: 'automatic',
    target: 'es2022', logLevel: 'error', alias: { '@shared': join(root, 'server/src') }, outExtension: { '.js': '.cjs' },
    define: { __MARION_BUILD__: '"test"', 'process.env.NODE_ENV': '"production"' }, loader: { '.svg': 'dataurl', '.png': 'dataurl' },
  });
  const media = { matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
  const saved = new Map();
  const listeners = new Map();
  const noop = () => {};
  globalThis.window = globalThis;
  Object.assign(globalThis, {
    matchMedia: () => media, removeEventListener: noop,
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    dispatchEvent: (ev) => { for (const fn of listeners.get(ev.type) ?? []) fn(ev); return true; },
    localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, String(value)), removeItem: key => saved.delete(key) },
    document: { documentElement: { dataset: {}, style: { setProperty: noop, removeProperty: noop }, setAttribute: noop, removeAttribute: noop, classList: { add: noop, remove: noop, toggle: noop } },
      addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, visibilityState: 'visible' },
  });
  const ui = createRequire(import.meta.url)(join(out2, 'waiting-ssr.cjs'));
  assert.equal(ui.badge(0), '', 'badge hidden at 0');
  assert.match(ui.badge(3), /^<span class="sidebar-island__count is-waiting" aria-label="3 waiting on you">3<\/span>$/, 'badge = the Sessions pill (sidebar-island__count) with the count');
  assert.doesNotMatch(ui.island([]), /sidebar-island__count/, 'Tasks entry shows no badge at 0');
  const qRow = { botId: 'bot_q', generation: 0, seq: 9, updatedSeq: 9, kind: 'card', createdAt: Date.now(), body: { type: 'card', card: 'question', question: 'Tea or coffee?', options: ['Tea', 'Coffee'], status: 'pending' } };
  const aRow = { botId: 'bot_a', generation: 0, seq: 3, updatedSeq: 3, kind: 'card', createdAt: Date.now(), body: { type: 'card', card: 'approval', approvalId: 'apr_x', title: 'Allow Ada to create a GitHub repository?', detail: '', tool: 'github_create_repo', args: {}, status: 'pending' } };
  const tItem = { key: 'task:t1', kind: 'task', botId: 'bot_t', botName: 'Tess', at: Date.now(), task: { id: 't1', botId: 'bot_t', title: 'Pick a venue', state: 'needs_input', note: '', updatedAt: Date.now() } };
  const items = [
    { key: 'card:bot_q:0:9', kind: 'card', card: 'question', botId: 'bot_q', botName: 'Quinn', at: Date.now(), row: qRow },
    { key: 'card:bot_a:0:3', kind: 'card', card: 'approval', botId: 'bot_a', botName: 'Ada', at: Date.now(), row: aRow },
    tItem,
  ];
  const island = ui.island(items);
  assert.match(island, /<span class="sidebar-island__count is-waiting" aria-label="3 waiting on you">3<\/span>/, 'Tasks entry shows 3');
  const html = ui.section(items);
  assert.match(html, /Waiting on You/);
  assert.equal((html.match(/class="waiting-item"/g) ?? []).length, 3, 'one entry per item');
  assert.match(html, /Tea or coffee\?/); assert.match(html, />Tea</); assert.match(html, />Coffee</);
  assert.match(html, /Or reply in your own words/, 'questions get a reply field in Tasks');
  assert.match(html, /<button type="submit" class="btn btn--primary" disabled="">Reply<\/button>/, 'Reply is disabled until something is typed');
  assert.match(html, /Don&#x27;t allow/); assert.match(html, />Allow</);
  assert.doesNotMatch(html, /Always allow/, 'same rule as chat: no "Always allow" for GitHub repository creation');
  assert.match(html, /Pick a venue/);
  assert.match(ui.section([]), /Nothing needs you right now/);
  // Live: every event that can change the list bumps the 'waiting' version (the section and badge reload).
  for (const type of ['waiting', 'tasks', 'cleared', 'roster']) {
    const before = ui.waitingVersion();
    globalThis.dispatchEvent({ type: 'marion-agent:event', detail: { type, botId: 'bot_q', generation: 1 } });
    assert.equal(ui.waitingVersion(), before + 1, `${type} reloads Waiting on You`);
  }
  const before = ui.waitingVersion();
  globalThis.dispatchEvent({ type: 'marion-agent:event', detail: { type: 'memories', botId: 'bot_q' } });
  assert.equal(ui.waitingVersion(), before, 'unrelated events do not');
  rmSync(out2, { recursive: true, force: true });
  console.log('PASS UI: real section renders the chat\'s own cards (+ reply field, same approval buttons), task replies, empty state; badge = Sessions pill, hidden at 0; live reload on waiting/tasks/cleared/roster events');
} finally {
  L.setEnqueueForTests(null);
  try { db.close(); } catch { /* closed */ }
  rmSync(dir, { recursive: true, force: true });
}
console.log('ALL PASS waiting-on-you');
process.exit(0); // server modules keep timers alive
