// Statistics: streak math (current, longest, gaps), per-bot message/chat/token totals, provider breakdown, timeframe
// filtering, the streak's "alive until midnight" rule and empty-database handling. Temporary database; no network, no CLIs.
// Usage: node --import tsx tests/stats.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'marion-stats-'));
process.env.DB_PATH = join(work, 'marion.db');
process.env.MARION_NO_SCHEDULER = '1';

const { db, now } = await import('../server/src/db.ts');
await import('../server/src/features/schema.ts');
const { initSubagents } = await import('../server/src/agent/subagents.ts');
const { initRooms } = await import('../server/src/agent/rooms.ts');
initSubagents(); initRooms();
const { computeStats, parseStatsRange, streaks } = await import('../server/src/features/stats.ts');

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 25, 15, 30); // Wed 25 Nov 2026, 15:30 UTC
const TZ = 0;
const at = (daysAgo, hour = 10) => Date.UTC(2026, 10, 25 - daysAgo, hour, 0);

const userId = 'user_test';
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(userId, 'owner@example.com', 'Owner', now());
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('user_other', 'other@example.com', 'Other', now());
const addBot = (id, name, owner = userId, color = 'blue') => db.prepare(
  'INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_color,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
).run(id, owner, name, 'Helper', '', '', color, now(), now());
let seq = 0;
const addRow = (botId, generation, createdAt, body) => db.prepare(
  'INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)',
).run(botId, generation, ++seq, seq, 'message', JSON.stringify({ type: 'message', ...body }), createdAt);
const user = (botId, generation, createdAt, extra = {}) => addRow(botId, generation, createdAt, { role: 'user', text: 'hi', ...extra });
const reply = (botId, generation, createdAt, usage) => addRow(botId, generation, createdAt, { role: 'assistant', text: 'ok', ...(usage ? { usage } : {}) });
let runs = 0;
const run = (botId, provider, kind, status, startedAt, extra = {}) => db.prepare(`INSERT INTO agent_sessions(id,user_id,bot_id,provider,kind,title,status,folder_path,folder_label,model,model_label,
    tokens_in,tokens_out,started_at,ended_at,duration_ms,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  `run${++runs}`, extra.userId ?? userId, botId, provider, kind, 'Task', status, extra.folder ?? null, extra.folderLabel ?? null, extra.model ?? null,
  extra.modelLabel ?? null, extra.tokensIn ?? null, extra.tokensOut ?? null, startedAt, startedAt + (extra.duration ?? 60_000), extra.duration ?? 60_000, startedAt);
const stats = (range = '30d', owner = userId, atTime = NOW) => computeStats(owner, { range, now: atTime, tzOffset: TZ });

// ---- 1. empty database: zeros, no crash
{
  const empty = stats('30d');
  assert.equal(empty.streak.current, 0);
  assert.equal(empty.streak.longest, 0);
  assert.equal(empty.streak.lastActiveDate, null);
  assert.equal(empty.totals.userMessages, 0);
  assert.equal(empty.totals.tokens.total, 0);
  assert.equal(empty.totals.chats, 0);
  assert.deepEqual(empty.bots, []);
  assert.equal(empty.mostWorkedBot, null);
  assert.deepEqual(empty.providers, []);
  assert.equal(empty.insights.busiestWeekday, null);
  assert.equal(empty.insights.peakHour, null);
  assert.equal(empty.insights.avgMessagesPerActiveDay, 0);
  assert.equal(empty.insights.agentSuccessRate, null);
  assert.equal(empty.days.length, 30);
  assert.ok(empty.days.every(day => day.messages === 0 && day.runs === 0 && day.tokens === 0));
  assert.equal(stats('all').days.length, 7, 'an empty all-time chart still draws a week');
  assert.equal(computeStats('nobody', { range: 'all', now: NOW, tzOffset: TZ }).totals.relayedRuns, 0);
}

// ---- 2. pure streak math
{
  const d = (n) => n; // day numbers are plain integers
  assert.deepEqual(streaks([], 100), { current: 0, longest: 0, activeDays: 0, activeToday: false, lastActiveDay: null });
  const today = streaks([98, 99, 100], 100);
  assert.equal(today.current, 3); assert.equal(today.longest, 3); assert.equal(today.activeToday, true);
  const alive = streaks([97, 98, 99], 100); // nothing yet today: still alive until midnight
  assert.equal(alive.current, 3); assert.equal(alive.activeToday, false);
  const broken = streaks([96, 97, 98], 100); // yesterday missed: streak is over
  assert.equal(broken.current, 0); assert.equal(broken.longest, 3);
  const gaps = streaks([d(1), d(2), d(3), d(4), d(5), d(10), d(11), d(99), d(100)], 100);
  assert.equal(gaps.current, 2); assert.equal(gaps.longest, 5); assert.equal(gaps.activeDays, 9);
  const dupes = streaks([5, 5, 5, 6, 6], 6);
  assert.equal(dupes.current, 2); assert.equal(dupes.activeDays, 2);
}

// ---- seed: Quinn is a busy chat bot, Rowan a smaller one that relays to Codex, Sage is idle history only
addBot('bot_quinn', 'Quinn', userId, 'red');
addBot('bot_rowan', 'Rowan', userId, 'green');
addBot('bot_old', 'Old', userId);
addBot('bot_gone', 'Gone');
addBot('bot_other', 'Elsewhere', 'user_other');
db.prepare("UPDATE bots SET deleted_at=? WHERE id='bot_gone'").run(NOW);
addBot('bot_sub', 'Quinn · helper');
db.prepare("UPDATE bots SET hidden=1 WHERE id='bot_sub'").run();

// Quinn, generation 1: today, yesterday, 2 days ago (a 3-day run), then a gap, then 6..10 days ago (a 5-day run)
const quinnDays = [0, 1, 2, 6, 7, 8, 9, 10];
for (const daysAgo of quinnDays) {
  user('bot_quinn', 1, at(daysAgo, 9));
  reply('bot_quinn', 1, at(daysAgo, 9), [{ provider: 'local', model: 'qwen', label: 'Qwen', input: 100, output: 50, estimated: false }]);
}
// Quinn, generation 2 (a new conversation after clearing): two messages today at 22:00
user('bot_quinn', 2, at(0, 22));
user('bot_quinn', 2, at(0, 22));
reply('bot_quinn', 2, at(0, 22)); // no usage footer: must count as 0 tokens, not crash
// messages that are not "sent by the user": a routine and another bot talking
user('bot_quinn', 2, at(0, 23), { from: { kind: 'routine', id: 'r', name: 'Daily' } });
user('bot_quinn', 2, at(0, 23), { from: { kind: 'bot', id: 'b', name: 'Rowan' } });
// a broken usage footer
db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)')
  .run('bot_quinn', 2, ++seq, seq, 'message', '{"type":"message","role":"assistant","text":"x","usage":"nope"}', at(0, 23));

// Rowan: a Claude-subscription chat reply (footer) mirrored by a subscription_bot run, plus relayed Codex/Gemini work
user('bot_rowan', 1, at(3, 14));
reply('bot_rowan', 1, at(3, 14), [{ provider: 'claude', model: 'claude-opus', label: 'Claude Opus', input: 1000, output: 200, estimated: false }]);
run('bot_rowan', 'claude', 'subscription_bot', 'completed', at(3, 14), { tokensIn: 1000, tokensOut: 200, model: 'claude-opus', modelLabel: 'Claude Opus', folder: '/Users/x/Marion', folderLabel: 'Marion', duration: 120_000 });
run('bot_rowan', 'codex', 'ask_subscription', 'completed', at(1, 14), { tokensIn: 400, tokensOut: 100, model: 'gpt-x', modelLabel: 'GPT X', folder: '/Users/x/Marion', folderLabel: 'Marion', duration: 30_000 });
run('bot_rowan', 'codex', 'ask_subscription', 'failed', at(1, 15), { tokensIn: null, tokensOut: null, model: 'gpt-x', modelLabel: 'GPT X', folder: '/Users/x/Other', duration: 10_000 });
run('bot_rowan', 'gemini', 'ask_subscription', 'stopped', at(5, 8), { tokensIn: 50, tokensOut: 25, model: 'gemini-pro', modelLabel: 'Gemini Pro', folder: '/Users/x/Marion', folderLabel: 'Marion', duration: 5_000 });
// Old: a conversation 40 days ago only
user('bot_old', 1, at(40, 11));
reply('bot_old', 1, at(40, 11), [{ provider: 'local', model: 'qwen', label: 'Qwen', input: 10, output: 5, estimated: true }]);
// Rows that must be ignored: another user's bot, a deleted chat, a hidden sub-agent
user('bot_other', 1, at(0, 9)); user('bot_gone', 1, at(0, 9)); user('bot_sub', 1, at(0, 9));
run('bot_sub', 'claude', 'ask_subscription', 'completed', at(0, 9), { tokensIn: 999, tokensOut: 999 });
run('bot_other', 'claude', 'ask_subscription', 'completed', at(0, 9), { userId: 'user_other', tokensIn: 777, tokensOut: 777 });

// ---- 3. streak over the whole history (range must not change it)
for (const range of ['7d', '30d', 'all']) {
  const s = stats(range);
  // active days: today(0),1,2 (Quinn) + 1 (Rowan) + 3 (Rowan) + 5 (Gemini run) + 6..10 (Quinn) + 40 (Old)
  assert.equal(s.streak.current, 4, `current streak counts days 0..-3 (${range})`);
  assert.equal(s.streak.longest, 6, 'longest run is days 5..10 ago');
  assert.equal(s.streak.activeDays, 4 + 6 + 1);
  assert.equal(s.streak.activeToday, true);
  assert.equal(s.streak.lastActiveDate, '2026-11-25');
}
// a quiet today keeps yesterday's streak alive, a quiet yesterday ends it
assert.equal(stats('30d', userId, NOW + 1 * DAY).streak.current, 4, 'tomorrow morning: streak ended yesterday, still alive');
assert.equal(stats('30d', userId, NOW + 1 * DAY).streak.activeToday, false);
assert.equal(stats('30d', userId, NOW + 2 * DAY).streak.current, 0, 'two quiet days: streak is over');

// ---- 4. 30-day window: totals, per-bot, tokens, providers
{
  const s = stats('30d');
  assert.equal(s.from, '2026-10-27'); assert.equal(s.to, '2026-11-25'); assert.equal(s.days.length, 30);
  const quinn = s.bots.find(b => b.id === 'bot_quinn');
  const rowan = s.bots.find(b => b.id === 'bot_rowan');
  assert.deepEqual(s.bots.map(b => b.id), ['bot_quinn', 'bot_rowan'], 'Old is outside 30 days; other users, deleted and hidden chats are left out');
  assert.equal(s.mostWorkedBot.id, 'bot_quinn');
  assert.equal(quinn.chats, 2, 'two conversations (generations)');
  assert.equal(quinn.messages, 8 + 2, 'user messages: 8 days + 2 today; routine/bot messages are not "sent"');
  assert.equal(quinn.totalMessages, 8 + 8 + 2 + 1 + 2 + 1, 'every message of the chat');
  assert.deepEqual(quinn.tokens, { input: 800, output: 400, total: 1200 });
  assert.equal(quinn.relayedRuns, 0);
  assert.equal(quinn.avatarColor, 'red');
  assert.equal(rowan.chats, 1); assert.equal(rowan.messages, 1); assert.equal(rowan.relayedRuns, 4);
  // footer 1000+200 (Claude chat) + codex 400+100 + gemini 50+25; the mirrored subscription_bot run isn't added twice
  assert.deepEqual(rowan.tokens, { input: 1450, output: 325, total: 1775 });
  assert.equal(rowan.lastActiveAt, at(1, 15) + 10_000);
  assert.equal(s.totals.userMessages, 11);
  assert.equal(s.totals.chats, 3);
  assert.equal(s.totals.relayedRuns, 4);
  assert.equal(s.totals.completedRuns, 2);
  assert.deepEqual(s.totals.tokens, { input: 2250, output: 725, total: 2975 });
  assert.equal(s.totals.agentTimeMs, 120_000 + 30_000 + 10_000 + 5_000);
  assert.equal(s.totals.activeBots, 2);
  assert.equal(s.totals.activeDays, 10);
  assert.equal(s.insights.avgMessagesPerActiveDay, 1.1);

  const byProvider = Object.fromEntries(s.providers.map(p => [p.provider, p]));
  assert.deepEqual(s.providers.map(p => p.provider), ['claude', 'codex', 'gemini', 'local']);
  assert.equal(byProvider.claude.runs, 1); assert.equal(byProvider.claude.completionRate, 1);
  assert.equal(byProvider.codex.runs, 2); assert.equal(byProvider.codex.completed, 1); assert.equal(byProvider.codex.failed, 1);
  assert.equal(byProvider.codex.completionRate, 0.5);
  assert.deepEqual(byProvider.codex.tokens, { input: 400, output: 100, total: 500 }, 'a missing token count is 0');
  assert.equal(byProvider.gemini.stopped, 1); assert.equal(byProvider.gemini.completionRate, 0);
  assert.equal(byProvider.local.runs, 8); assert.equal(byProvider.local.completionRate, null);
  assert.deepEqual(byProvider.local.tokens, { input: 800, output: 400, total: 1200 });
  assert.equal(s.insights.agentSuccessRate, 0.5);
  assert.ok(s.models.some(m => m.provider === 'codex' && m.label === 'GPT X' && m.runs === 2));

  assert.deepEqual(s.insights.topFolders.map(f => [f.name, f.runs]), [['Marion', 3], ['Other', 1]]);
  assert.equal(s.insights.weekdayCounts.reduce((a, b) => a + b, 0), 11 + 4, 'sent messages + relayed runs');
  assert.equal(s.insights.hourCounts.length, 24);

  // daily series: filled with zeros, tooltips need date + messages + tokens
  const today = s.days.at(-1);
  assert.deepEqual(today, { date: '2026-11-25', messages: 3, runs: 0, tokens: 150 });
  assert.deepEqual(s.days.find(d => d.date === '2026-11-24'), { date: '2026-11-24', messages: 1, runs: 2, tokens: 150 + 500 });
  assert.equal(s.days.find(d => d.date === '2026-11-20').messages, 0);
}

// ---- 5. timeframe filtering
{
  const week = stats('7d');
  assert.equal(week.days.length, 7); assert.equal(week.from, '2026-11-19');
  // inside 7 days: Quinn days 0,1,2,6; Rowan day 3 (+ runs on 1, 3, 5)
  assert.equal(week.bots.find(b => b.id === 'bot_quinn').messages, 4 + 2);
  assert.equal(week.totals.userMessages, 4 + 2 + 1);
  assert.equal(week.totals.relayedRuns, 4);
  assert.equal(week.totals.activeDays, 6, 'days 0,1,2,3,5 and 6 ago');
  assert.equal(week.totals.tokens.total, 150 * 4 + 1200 + 500 + 75, 'Quinn days 0,1,2,6 + Rowan claude chat + codex + gemini');
  assert.deepEqual(week.bots.map(b => b.id), ['bot_quinn', 'bot_rowan']);

  // 'all' reaches back to the 40-day-old chat and draws up to 365 days
  const all = stats('all');
  assert.deepEqual(all.bots.map(b => b.id), ['bot_quinn', 'bot_rowan', 'bot_old']);
  assert.equal(all.totals.userMessages, 12);
  assert.equal(all.days.length, 41, 'from the first active day (40 days ago) to today');
  assert.equal(all.bots.find(b => b.id === 'bot_old').tokens.total, 15, 'estimated counts are still counted');
  assert.equal(all.totals.tokens.total, 2975 + 15);
  assert.ok(week.totals.userMessages < stats('30d').totals.userMessages && stats('30d').totals.userMessages < all.totals.userMessages);

  // the same data from a time zone 10 hours behind UTC: the 09:00 UTC message is 23:00 the evening before
  const west = computeStats(userId, { range: '7d', now: NOW, tzOffset: 600 });
  assert.equal(west.to, '2026-11-25');
  assert.equal(west.days.at(-1).messages, 2, 'only the two 22:00 UTC messages are still today');
  assert.equal(west.days.at(-2).messages, 1, 'the 09:00 UTC message from today now sits on yesterday evening');
}

// ---- 6. range parsing and robustness
{
  assert.equal(parseStatsRange('7d'), '7d'); assert.equal(parseStatsRange('all'), 'all');
  assert.equal(parseStatsRange('nonsense'), '30d'); assert.equal(parseStatsRange(undefined), '30d');
  // a running relayed run counts its time so far
  run('bot_rowan', 'claude', 'ask_subscription', 'running', NOW - 90_000, { duration: 0 });
  db.prepare("UPDATE agent_sessions SET ended_at=NULL, duration_ms=0 WHERE status='running'").run();
  const live = stats('7d');
  assert.equal(live.totals.agentTimeMs, 165_000 + 90_000);
  assert.equal(live.totals.relayedRuns, 5);
}

rmSync(work, { recursive: true, force: true });
console.log('stats: ok');
