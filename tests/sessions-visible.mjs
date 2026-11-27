// Sessions view: Claude sessions show up reliably and the Builders filter lists only relayed worker agents.
//  - This Mac: every session in the Claude app's own index shows (with its app title) even when newer CLI/headless
//    transcripts exceed the cap; sessions archived in the app stay hidden; Marion's temp relay folders never count.
//  - Marion Agent: Claude and Cloud runs are returned by the Claude/Builders queries even when hundreds of newer
//    chat-model (subscription_bot) turns would push them out of the "All" window.
// Temporary HOME and database; no network, no real CLIs.
// Usage: node --import tsx tests/sessions-visible.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'marion-sessions-visible-'));
const home = join(work, 'home');
process.env.MARION_SESSIONS_HOME = home;
process.env.DB_PATH = join(work, 'marion.db');
process.env.MARION_NO_SCHEDULER = '1';

try {
  // ---------- This Mac: Claude Code sessions ----------
  const { listCodingSessions, setClaudeProcessProbe } = await import('../server/src/features/sessions.ts');
  setClaudeProcessProbe(() => []);
  const transcript = (id, cwd, title, ageMs) => {
    const dir = join(home, '.claude', 'projects', cwd.replace(/[^\w]/g, '-'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: 'user', cwd, message: { content: title } }) + '\n');
    const at = new Date(Date.now() - ageMs);
    utimesSync(file, at, at);
  };
  const appDir = join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct', 'org');
  mkdirSync(appDir, { recursive: true });
  const appSession = (cliSessionId, title, cwd, ageMs, extra = {}) => writeFileSync(join(appDir, `local_${cliSessionId}.json`),
    JSON.stringify({ sessionId: `local_${cliSessionId}`, cliSessionId, cwd, title, lastActivityAt: Date.now() - ageMs, isArchived: false, ...extra }));

  // 80 newer headless runs (a night-builder loop) and 80 newer Marion relay transcripts.
  for (let i = 0; i < 80; i++) transcript(`loop-${i}`, '/work/loop', `Night builder pass ${i}`, 60_000 + i * 1000);
  for (let i = 0; i < 80; i++) transcript(`relay-${i}`, `/private/var/folders/x/T/marion-provider-${i}`, `Relay ${i}`, 1000 + i);
  // Your app sessions are older than all of them.
  transcript('hub', '/work/hub', 'first prompt of hub', 9 * 24 * 3600_000);
  appSession('hub', 'Hub', '/work/hub', 9 * 24 * 3600_000, { isStarred: true });
  transcript('old-app', '/work/site', 'make the site faster', 20 * 24 * 3600_000);
  appSession('old-app', '', '/work/site', 20 * 24 * 3600_000);
  transcript('gone', '/work/gone', 'archived work', 30_000);
  appSession('gone', 'Archived in app', '/work/gone', 30_000, { isArchived: true });

  const claude = listCodingSessions('claude');
  const titles = claude.map(s => s.title);
  assert.ok(titles.includes('Hub'), 'a Claude app session shows with its app title despite 80 newer headless runs');
  assert.ok(titles.includes('make the site faster'), 'an untitled app session falls back to its first prompt');
  assert.equal(claude.find(s => s.title === 'Hub').id, 'claude:hub', 'the id points at the CLI transcript, so its messages open');
  assert.ok(!titles.includes('archived work') && !titles.includes('Archived in app'), 'sessions archived in the Claude app stay hidden');
  assert.ok(!claude.some(s => /marion-provider/.test(s.path)), 'Marion relay transcripts never show');
  assert.equal(claude.filter(s => s.project === 'loop').length, 60, 'other transcripts still fill the usual cap');
  assert.ok(claude[0].updatedAt >= claude.at(-1).updatedAt, 'newest first');

  // ---------- Marion Agent: relayed Claude / Cloud runs and Builders ----------
  const { db, now } = await import('../server/src/db.ts');
  await import('../server/src/features/schema.ts');
  const { initSubagents } = await import('../server/src/agent/subagents.ts');
  const { initRooms } = await import('../server/src/agent/rooms.ts');
  initSubagents(); initRooms();
  const S = await import('../server/src/features/agent-sessions.ts');
  const userId = 'user_test';
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(userId, 'owner@example.com', 'Owner', now());
  db.prepare('INSERT INTO bots(id,user_id,name,label,description,instructions,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('bot_a', userId, 'Quinn', 'Helper', '', '', now(), now());
  const t0 = Date.now() - 3600_000;
  const run = (id, provider, kind, at) => {
    const track = { id, kind, userId, botId: 'bot_a', request: `${kind} ${id}` };
    S.beginAgentSession(track, provider, at);
    S.finishAgentSession(track, provider, { status: 'completed', reply: 'done', startedAt: at, endedAt: at + 1000 });
    db.prepare('UPDATE agent_sessions SET updated_at=? WHERE id=?').run(at + 1000, id);
  };
  run('claude-ask', 'claude', 'ask_subscription', t0);
  run('claude-cloud', 'claude', 'cloud', t0 + 1);
  run('codex-team', 'codex', 'team', t0 + 2);
  for (let i = 0; i < 250; i++) run(`gem-${i}`, 'gemini', 'subscription_bot', t0 + 10_000 + i);

  const everything = S.listSessions(userId, { limit: 200 });
  assert.ok(!everything.some(s => s.provider === 'claude'), 'precondition: chat-model turns crowd Claude out of the All window');
  const claudeRuns = S.listSessions(userId, { provider: 'claude', limit: 200 });
  assert.deepEqual(claudeRuns.map(s => s.id).sort(), ['relay:claude-ask', 'relay:claude-cloud'], 'the Claude tab gets its own rows, Cloud included');
  assert.equal(claudeRuns.find(s => s.id === 'relay:claude-cloud').kind, 'cloud');

  const builders = S.listSessions(userId, { type: 'builders', limit: 200 });
  assert.deepEqual(builders.map(s => s.id).sort(), ['relay:claude-ask', 'relay:claude-cloud', 'relay:codex-team'], 'Builders: relayed workers only');
  assert.ok(builders.every(s => s.type === 'relay' && s.kind !== 'subscription_bot'), 'no chats, no chat-model turns');
  assert.equal(S.listSessions(userId, { type: 'builders', botId: 'bot_a', limit: 200 }).length, 3, 'per-bot Builders');
  for (const kind of ['ask_subscription', 'orchestration', 'team', 'cloud', 'handoff']) assert.ok(S.isBuilderKind(kind), kind);
  assert.ok(!S.isBuilderKind('subscription_bot') && !S.isBuilderKind('chat'));

  // Running builders come first.
  S.beginAgentSession({ id: 'live', kind: 'orchestration', userId, botId: 'bot_a', request: 'build it' }, 'codex', t0 - 5000);
  assert.equal(S.listSessions(userId, { type: 'builders' })[0].id, 'relay:live');

  // Cloud runs a hidden subagent helper started (start_cloud_session from a helper) show under the parent bot.
  db.prepare('INSERT INTO bots(id,user_id,name,label,description,instructions,parent_bot_id,hidden,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)')
    .run('helper_1', userId, 'Scout', 'Helper', '', '', 'bot_a', now(), now());
  const helperTrack = { id: 'helper-cloud', kind: 'cloud', userId, botId: 'helper_1', request: 'Review octo/app in the cloud', folder: { path: 'https://github.com/octo/app', label: 'octo/app' } };
  S.beginAgentSession(helperTrack, 'claude', Date.now() - 1000);
  const helperRow = S.listSessions(userId, { type: 'builders' }).find(s => s.id === 'relay:helper-cloud');
  assert.ok(helperRow, 'a helper\'s Cloud run shows under Builders');
  assert.equal(helperRow.botId, 'bot_a', 'listed under the parent bot (its chat opens)');
  assert.equal(helperRow.botName, 'Quinn › Scout');
  assert.ok(S.listSessions(userId, { kind: 'cloud' }).some(s => s.id === 'relay:helper-cloud'), 'and under Cloud');
  assert.ok(S.listSessions(userId, { botId: 'bot_a', type: 'builders' }).some(s => s.id === 'relay:helper-cloud'), 'and in the parent bot\'s own list');
  // A deleted parent hides its helpers' runs with it.
  db.prepare('INSERT INTO bots(id,user_id,name,label,description,instructions,deleted_at,hidden,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)')
    .run('gone_bot', userId, 'Gone', 'x', '', '', now(), now(), now());
  db.prepare('INSERT INTO bots(id,user_id,name,label,description,instructions,parent_bot_id,hidden,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)')
    .run('gone_helper', userId, 'Old', 'x', '', '', 'gone_bot', now(), now());
  S.beginAgentSession({ id: 'gone-cloud', kind: 'cloud', userId, botId: 'gone_helper', request: 'x' }, 'claude');
  assert.ok(!S.listSessions(userId, { kind: 'cloud' }).some(s => s.id === 'relay:gone-cloud'));

  // A Cloud request waiting on a card is listed (as Waiting, live, on top) before it ever starts.
  S.recordCloudRequest({ id: 'cloud-wait', kind: 'cloud', userId, botId: 'bot_a', request: 'Port the CLI', folder: { path: 'https://github.com/octo/cli', label: 'octo/cli' } }, 'Waiting for you: pick a repository');
  const waitingCloud = S.listSessions(userId, { kind: 'cloud' }).find(s => s.id === 'relay:cloud-wait');
  assert.equal(waitingCloud.status, 'waiting'); assert.equal(waitingCloud.provider, 'claude'); assert.equal(waitingCloud.folder.name, 'octo/cli');
  assert.ok(['relay:cloud-wait', 'relay:helper-cloud', 'relay:live'].includes(S.listSessions(userId, { type: 'builders' })[0].id), 'live rows first');
  S.beginAgentSession({ id: 'cloud-wait', kind: 'cloud', userId, botId: 'bot_a', request: 'Port the CLI', folder: { path: 'https://github.com/octo/cli', label: 'octo/cli' } }, 'claude');
  const started = S.listSessions(userId, { kind: 'cloud' }).find(s => s.id === 'relay:cloud-wait');
  assert.equal(started.status, 'running'); assert.equal(started.error, null, 'the waiting note clears once it runs');

  console.log('sessions-visible: all checks passed');
} finally {
  rmSync(work, { recursive: true, force: true });
}
