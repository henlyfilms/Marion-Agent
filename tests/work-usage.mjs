// Builder work cards: task usage + session context parsed from Claude / Codex / Gemini output, kept live and on
// the finished card, and the blue → red usage color scale. Fake CLIs only: no listener, no network, no model calls.
// Usage: npm run build && node tests/work-usage.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const bin = mkdtempSync(join(tmpdir(), 'marion-work-usage-'));
process.env.DB_PATH = ':memory:';
process.env.MARION_DESKTOP_TOKEN = 'test-token';
process.env.HOST = '127.0.0.1';
process.env.SERVER_URL = 'http://127.0.0.1:8787';
process.env.PATH = bin + delimiter + process.env.PATH;

// ---- fake CLIs that print the usage shapes each real CLI emits ----
const script = (body) => `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\n${body}\n`;
const claudeLines = [
  { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.62, resetsAt: 1_900_000_000 } },
  { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }],
    usage: { input_tokens: 10, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 0, output_tokens: 300 } } },
  { type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'text', text: 'All tests pass now, wrapping up.' }],
    usage: { input_tokens: 5, cache_creation_input_tokens: 4_000, cache_read_input_tokens: 80_000, output_tokens: 1_000 } } },
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.7, resetsAt: 1_900_000_000 } },
  { type: 'result', subtype: 'success', is_error: false, result: 'Claude done', total_cost_usd: 1.234,
    usage: { input_tokens: 15, cache_creation_input_tokens: 24_000, cache_read_input_tokens: 80_000, output_tokens: 1_300 },
    modelUsage: { 'claude-opus-5-5': { inputTokens: 15, outputTokens: 1_300, cacheReadInputTokens: 80_000, cacheCreationInputTokens: 24_000, costUSD: 1.234, contextWindow: 200_000 } } },
];
writeFileSync(join(bin, 'claude'), script(`
if (args.includes('status')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' })); process.exit(0); }
fs.readFileSync(0, 'utf8');
for (const line of ${JSON.stringify(claudeLines)}) console.log(JSON.stringify(line));
`), { mode: 0o700 });
writeFileSync(join(bin, 'agy'), script(`
if (args[0] === 'models') { console.log('gemini-4-neon-high\\tGemini 4 Neon (High)'); process.exit(0); }
console.log(JSON.stringify({ update: { sessionUpdate: 'usage_update', used: 52_428, size: 1_048_576, cost: { amount: 0.05, currency: 'USD' } } }));
console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Gemini done',
  usageMetadata: { promptTokenCount: 50_000, cachedContentTokenCount: 30_000, candidatesTokenCount: 2_000, thoughtsTokenCount: 428, totalTokenCount: 52_428 } } }));
`), { mode: 0o700 });
writeFileSync(join(bin, 'codex'), script(`
const send = (m) => console.log(JSON.stringify(m));
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method } = JSON.parse(line);
  if (method === 'initialize') send({ id, result: {} });
  if (method === 'account/read') send({ id, result: { account: { type: 'chatgpt' } } });
  if (method === 'model/list') send({ id, result: { data: [{ model: 'gpt-6.2-sol', displayName: 'GPT-6.2-Sol', supportedReasoningEfforts: ['low', 'medium', 'high'].map((reasoningEffort) => ({ reasoningEffort })) }] } });
  if (method === 'thread/start') send({ id, result: { thread: { id: 't1' } } });
  if (method === 'turn/start') {
    send({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1900000000 }, secondary: { usedPercent: 10, windowDurationMins: 10080 } } } });
    send({ method: 'thread/tokenUsage/updated', params: { threadId: 't1', tokenUsage: {
      total: { totalTokens: 60000, inputTokens: 55000, cachedInputTokens: 40000, outputTokens: 5000, reasoningOutputTokens: 2000 },
      last: { totalTokens: 136000, inputTokens: 130000, cachedInputTokens: 100000, outputTokens: 6000, reasoningOutputTokens: 1000 }, modelContextWindow: 272000 } } });
    send({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 49, windowDurationMins: 300, resetsAt: 1900000000 }, secondary: { usedPercent: 11, windowDurationMins: 10080 } } } });
    send({ method: 'item/completed', params: { threadId: 't1', item: { type: 'agentMessage', text: 'Codex done' } } });
    send({ method: 'turn/completed', params: { threadId: 't1', turn: { status: 'completed' } } });
  }
});
`), { mode: 0o700 });

const { db } = await import('../server/dist/db.js');
await import('../server/dist/features/schema.js');
await import('../server/dist/db-config.js');
const S = await import('../server/dist/agent/subscriptions.js');
const U = await import('../server/dist/agent/task-usage.js');
const C = await import('../server/dist/usage-scale.js');
const { WorkCard } = await import('../server/dist/agent/work-feed.js');
const { createBotRecord } = await import('../server/dist/features/bots.js');
const { toolMap } = await import('../server/dist/agent/tools.js');
const settle = () => new Promise((done) => setTimeout(done, 450));
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

try {
  // ---- 1. blue → red color scale ----
  assert.equal(C.usageColor(0), '#3b82f6', '0% is blue');
  assert.equal(C.usageColor(20), '#3b82f6', 'low usage stays blue');
  assert.equal(C.usageColor(35), '#3b82f6');
  assert.equal(C.usageColor(80), '#ef4444', '80% is red');
  assert.equal(C.usageColor(95), '#ef4444', 'high usage is red');
  assert.equal(C.usageColor(150), '#ef4444', 'clamped above 100');
  assert.equal(C.usageColor(-5), '#3b82f6', 'clamped below 0');
  assert.equal(C.usageColor(Number.NaN), '#3b82f6');
  let previous = rgb(C.usageColor(35));
  for (let p = 40; p <= 80; p += 5) {
    const [r, , b] = rgb(C.usageColor(p));
    assert.ok(r >= previous[0], `red rises with usage (${p}%)`);
    if (p > 60) assert.ok(b <= previous[2], `blue fades toward red (${p}%)`);
    previous = [r, 0, b];
  }
  const mid = rgb(C.usageColor(60));
  assert.deepEqual(mid, rgb('#8b5cf6'), 'violet in the middle');
  assert.deepEqual([C.usageTone(10), C.usageTone(50), C.usageTone(90)], ['low', 'medium', 'high']);
  console.log('PASS usage color scale: blue (low) → violet → red (high)');

  // ---- 2. parsers, one per CLI ----
  const claude = new U.TaskUsageMeter('claude', 'claude-opus-5-5');
  assert.equal(claude.value(), undefined, 'nothing reported yet');
  for (const line of claudeLines.slice(0, 4)) claude.feed(line);
  let live = claude.value();
  assert.equal(live.live, true);
  assert.equal(live.tokens.total, 10 + 20_000 + 300 + 5 + 4_000 + 80_000 + 1_000, 'live totals sum each request once');
  assert.equal(live.context.tokens, 85_005, 'context = latest top-level request');
  assert.equal(live.context.window, 200_000);
  assert.equal(live.context.windowKnown, false, 'window estimated until the result');
  assert.equal(live.taskBasis, 'tokens', 'one limit reading: no delta yet');
  claude.feed(claudeLines[2]); // a repeated content block does not double count
  assert.equal(claude.value().tokens.total, live.tokens.total);
  claude.feed({ type: 'assistant', parent_tool_use_id: 'tool-1', message: { id: 'sub1', usage: { input_tokens: 100, output_tokens: 50 } } });
  assert.equal(claude.value().context.tokens, 85_005, 'a subagent request does not change the session context');
  for (const line of claudeLines.slice(4)) claude.feed(line);
  const done = claude.value(false);
  assert.deepEqual(done.tokens, { input: 15, cached: 80_000, cacheWrite: 24_000, output: 1_300, reasoning: 0, total: 105_315 });
  assert.equal(done.costUsd, 1.234);
  assert.equal(done.context.windowKnown, true);
  assert.equal(Math.round(done.context.percent), 43);
  assert.equal(done.taskBasis, 'limit');
  assert.equal(Math.round(done.taskPercent), 8, '62% → 70% of the 5-hour limit');
  assert.equal(done.limit.label, '5-hour limit');
  assert.equal(done.limit.resetsAt, 1_900_000_000_000);
  assert.equal(done.live, false);

  const codex = new U.TaskUsageMeter('codex', 'gpt-6.2-sol');
  codex.feed({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { totalTokens: 60000, inputTokens: 55000, cachedInputTokens: 40000, outputTokens: 5000, reasoningOutputTokens: 2000 }, last: { totalTokens: 136000, inputTokens: 130000, cachedInputTokens: 100000, outputTokens: 6000 }, modelContextWindow: 272000 } } });
  const cx = codex.value();
  assert.deepEqual(cx.tokens, { input: 15_000, cached: 40_000, cacheWrite: 0, output: 5_000, reasoning: 2_000, total: 60_000 }, 'Codex input includes cache reads');
  assert.equal(cx.context.percent, 50);
  assert.equal(codex.feed({ method: 'item/started', params: {} }), false, 'other events are ignored');

  const gemini = new U.TaskUsageMeter('gemini', 'gemini-4-neon');
  gemini.feed({ update: { sessionUpdate: 'usage_update', used: 262_144, size: 1_048_576, cost: { amount: 0.2, currency: 'USD' } } });
  assert.equal(gemini.value().context.percent, 25);
  assert.equal(gemini.value().costUsd, 0.2);
  gemini.feed({ event: 'result', result: { status: 'SUCCESS', usageMetadata: { promptTokenCount: 50_000, cachedContentTokenCount: 30_000, candidatesTokenCount: 2_000, thoughtsTokenCount: 428 } } });
  assert.deepEqual(gemini.value().tokens, { input: 20_000, cached: 30_000, cacheWrite: 0, output: 2_428, reasoning: 428, total: 52_428 }, 'Gemini thoughts count as output');

  // Token intensity: a tiny run is blue, a huge one red.
  assert.ok(U.tokenIntensity({ input: 2_000, cached: 50_000, cacheWrite: 10_000, output: 2_000, reasoning: 0, total: 64_000 }) < 35);
  assert.equal(U.tokenIntensity({ input: 1_000_000, cached: 0, cacheWrite: 0, output: 500_000, reasoning: 0, total: 1_500_000 }), 100);
  console.log('PASS task usage + session context parsed from Claude stream-json, Codex app-server and Gemini output');

  // ---- 3. a team card: task usage combined, fullest context shown ----
  const team = C.summarizeWorkUsage([
    { label: 'Claude', usage: done },
    { label: 'Codex', usage: { ...cx, live: true } },
    { label: 'Reporter' },
  ]);
  assert.equal(team.tokens.total, 105_315 + 60_000);
  assert.equal(team.context.agent, 'Codex', 'fullest session wins');
  assert.equal(team.live, true);
  assert.equal(team.taskBasis, 'tokens');
  assert.equal(C.summarizeWorkUsage([{ label: 'A' }]), undefined, 'no rings without usage');
  console.log('PASS team work cards combine task usage and show the fullest context');

  // ---- 4. end to end: live updates while running, kept on the finished card ----
  const user = 'u1';
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(user, 'a@example.com', 'A', 1000);
  const signal = new AbortController().signal;
  const updates = [];
  const text = await S.subscriptionReply(S.subscriptionSelection(user, 'claude'), 'hi', signal, [], { onTaskUsage: (u) => updates.push(u) });
  assert.equal(text, 'Claude done');
  assert.ok(updates.length >= 3, `live updates while running (${updates.length})`);
  assert.ok(updates[0].tokens.total < updates.at(-1).tokens.total, 'usage grows as the run goes');
  assert.equal(updates.at(-1).costUsd, 1.234);

  const bot = createBotRecord(user, { name: 'Usage bot' });
  const cards = () => db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='card' ORDER BY seq").all(bot.id).map((r) => JSON.parse(r.body)).filter((c) => c.card === 'work');
  const ctx = { userId: user, botId: bot.id, signal, allowSubscriptionTeam: true };
  for (const provider of ['claude', 'codex', 'gemini']) {
    await toolMap.get('ask_subscription').impl({ provider, prompt: `Build it with ${provider}`, title: `Build ${provider}`, new_session: true }, ctx);
    await settle();
    const usage = cards().at(-1).agents[0].usage;
    assert.ok(usage, `${provider} usage is kept on the card`);
    assert.equal(usage.live, false, `${provider} card is final`);
    assert.ok(usage.tokens.total > 0, `${provider} task tokens`);
    assert.ok(usage.context.percent > 0 && usage.context.percent <= 100, `${provider} context %`);
    if (provider === 'claude') assert.equal(usage.limit.usedPercent, 70);
    if (provider === 'codex') {
      assert.equal(usage.taskBasis, 'limit', 'Codex reported the 5-hour window twice');
      assert.equal(usage.taskPercent, 9, '40% → 49%');
      assert.equal(usage.limit.label, '5-hour limit');
      assert.equal(usage.context.tokens, 136_000);
      assert.equal(usage.context.window, 272_000);
    }
    if (provider === 'gemini') { assert.equal(Math.round(usage.context.percent), 5); assert.equal(usage.tokens.total, 52_428); }
  }

  // The WorkCard keeps the numbers through its batched writes.
  const card = new WorkCard(bot.id, user, { title: 'Manual', agents: [{ id: 'worker-0', label: 'Claude', provider: 'claude', model: 'claude-opus-5-5', role: 'worker' }] });
  card.usage('worker-0')(updates[0]);
  await settle();
  assert.equal(cards().at(-1).agents[0].usage.live, true, 'live usage reaches the chat while running');
  card.setUsage('missing', updates[0]);
  card.finish('done');
  assert.equal(cards().at(-1).agents[0].usage.live, false);
  console.log('PASS work cards carry live usage and keep the final task usage + context for Claude, Codex and Gemini');
} finally {
  rmSync(bin, { recursive: true, force: true });
}
