// Claude / Codex / Gemini relays: default models (Opus 5.5, 6.2 Sol, Gemini 4 Neon), medium effort by default,
// auto mode CLI args, fresh sessions, action cards for questions, the exact model on work cards, and the per-provider
// default model & effort from Settings used whenever a request names none (explicit model/effort win).
// Drives fake claude/codex/agy executables: no listener, no network, no model calls.
// Usage: npm run build && node tests/provider-defaults.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const bin = mkdtempSync(join(tmpdir(), 'marion-provider-defaults-'));
const log = (name) => join(bin, `${name}.jsonl`);
process.env.DB_PATH = ':memory:';
process.env.MARION_DESKTOP_TOKEN = 'test-token';
process.env.HOST = '127.0.0.1';
process.env.SERVER_URL = 'http://127.0.0.1:8787';
process.env.PATH = bin + delimiter + process.env.PATH;

const reply = (name) => readFileSync(join(bin, `${name}.reply`), 'utf8');
const script = (body) => `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\n${body}\n`;
writeFileSync(join(bin, 'claude'), script(`
if (args.includes('status')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' })); process.exit(0); }
fs.appendFileSync(${JSON.stringify(log('claude'))}, JSON.stringify(args) + '\\n');
fs.writeFileSync(${JSON.stringify(join(bin, 'claude.stdin'))}, fs.readFileSync(0, 'utf8'));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: fs.readFileSync(${JSON.stringify(join(bin, 'claude.reply'))}, 'utf8') }));
`), { mode: 0o700 });
writeFileSync(join(bin, 'agy'), script(`
if (args[0] === 'models') { for (const l of ['low', 'medium', 'high']) console.log('gemini-4-neon-' + l + '\\tGemini 4 Neon (' + l[0].toUpperCase() + l.slice(1) + ')'); console.log('gemini-3.8-flash-medium\\tGemini 3.8 Flash (Medium)'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(log('agy'))}, JSON.stringify(args) + '\\n');
console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Gemini reply' } }));
`), { mode: 0o700 });
writeFileSync(join(bin, 'codex'), script(`
const send = (m) => console.log(JSON.stringify(m));
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') send({ id, result: {} });
  if (method === 'account/read') send({ id, result: { account: { type: 'chatgpt' } } });
  if (method === 'model/list') send({ id, result: { data: [
    { model: 'gpt-6.2-astra', displayName: 'GPT-6.2-Astra', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: ['low', 'medium', 'high'].map((reasoningEffort) => ({ reasoningEffort })) },
    { model: 'gpt-6.2-sol', displayName: 'GPT-6.2-Sol', defaultReasoningEffort: 'low', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map((reasoningEffort) => ({ reasoningEffort })) },
  ] } });
  if (method === 'thread/start') { fs.appendFileSync(${JSON.stringify(log('codex'))}, JSON.stringify({ method, params }) + '\\n'); send({ id, result: { thread: { id: 't1' } } }); }
  if (method === 'turn/start') {
    fs.appendFileSync(${JSON.stringify(log('codex'))}, JSON.stringify({ method, params }) + '\\n');
    send({ method: 'item/completed', params: { threadId: 't1', item: { type: 'agentMessage', text: 'Codex reply' } } });
    send({ method: 'turn/completed', params: { threadId: 't1', turn: { status: 'completed' } } });
  }
});
`), { mode: 0o700 });
writeFileSync(join(bin, 'claude.reply'), 'Claude reply');

const { db } = await import('../server/dist/db.js');
await import('../server/dist/features/schema.js');
await import('../server/dist/db-config.js');
const S = await import('../server/dist/agent/subscriptions.js');
const W = await import('../server/dist/agent/work-feed.js');
const R = await import('../server/dist/agent/relay.js');
const { createBotRecord } = await import('../server/dist/features/bots.js');
const { toolMap } = await import('../server/dist/agent/tools.js');
const lines = (name) => { try { return readFileSync(log(name), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const flag = (args, name) => args[args.indexOf(name) + 1];

try {
  // ---- 1. defaults: exact model IDs, medium effort ----
  assert.deepEqual({ ...S.DEFAULT_SUBSCRIPTION_MODELS }, { claude: 'claude-opus-5-5', codex: 'gpt-6.2-sol', gemini: 'gemini-4-neon' });
  assert.equal(S.DEFAULT_SUBSCRIPTION_EFFORT, 'medium');
  assert.equal(S.preferredEffort(['low', 'medium', 'high', 'xhigh']), 'medium');
  assert.equal(S.preferredEffort(['low', 'high']), 'low', 'closest step down when medium is missing');
  assert.equal(S.preferredEffort(['high', 'xhigh']), 'high', 'whatever it has when neither medium nor low is offered');
  assert.equal(S.preferredEffort([]), null);
  const user = 'u1';
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(user, 'a@example.com', 'A', 1000);
  for (const provider of ['claude', 'codex', 'gemini']) {
    assert.deepEqual(S.subscriptionSelection(user, provider), { provider, model: S.DEFAULT_SUBSCRIPTION_MODELS[provider], effort: 'medium' }, `${provider} default selection`);
  }
  const claudeCatalog = await S.subscriptionModels('claude');
  assert.equal(claudeCatalog.defaultModel, 'claude-opus-5-5');
  assert.ok(claudeCatalog.models.every((m) => m.defaultEffort === 'medium' && m.efforts.includes('medium') && m.efforts.includes('high')));
  const codexCatalog = await S.subscriptionModels('codex');
  assert.equal(codexCatalog.defaultModel, 'gpt-6.2-sol', '6.2 Sol wins over the account default');
  assert.equal(codexCatalog.models[0].id, 'gpt-6.2-sol', 'default listed first (so "codex" name match lands on it)');
  assert.ok(codexCatalog.models.every((m) => m.defaultEffort === 'medium'), 'medium replaces the catalog default of low');
  const geminiCatalog = await S.subscriptionModels('gemini');
  assert.equal(geminiCatalog.defaultModel, 'gemini-4-neon');
  const neon = geminiCatalog.models.find((m) => m.id === 'gemini-4-neon');
  assert.deepEqual(neon.efforts, ['low', 'medium', 'high']);
  assert.equal(neon.defaultEffort, 'medium');
  assert.equal(geminiCatalog.models.find((m) => m.id === 'gemini-3.8-flash').defaultEffort, 'medium', 'medium when that is the only level');

  // ---- 2. auto mode CLI args ----
  assert.equal(flag(S.claudeArgs, '--permission-mode'), 'auto');
  for (const write of [true, false]) assert.equal(flag(S.folderArgs('claude', { path: '/tmp/x', write }), '--permission-mode'), 'auto');
  assert.equal(S.GEMINI_AUTO_MODE, 'auto');
  assert.equal(flag(S.folderArgs('gemini', { path: '/tmp/x', write: true }), '--mode'), 'auto', 'Gemini works in auto mode in a writable folder');
  assert.equal(flag(S.folderArgs('gemini', { path: '/tmp/x', write: false }), '--mode'), 'plan', 'read-only folders stay read-only');
  assert.deepEqual(S.codexThreadPolicy({ write: true }), { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' });
  assert.deepEqual(S.codexThreadPolicy({ write: false }), { sandbox: 'read-only', approvalPolicy: 'never' });
  assert.deepEqual(S.codexThreadPolicy(), { sandbox: 'read-only', approvalPolicy: 'never' });

  // ---- 3. real launches: defaults + medium effort reach each CLI; auto mode in a folder ----
  const signal = new AbortController().signal;
  const seen = {};
  const folder = { path: bin, label: 'bin', write: true };
  for (const provider of ['claude', 'codex', 'gemini']) {
    const text = await S.subscriptionReply(S.subscriptionSelection(user, provider), 'hi', signal, [], { folder, onModel: (m) => { seen[provider] = m; } });
    assert.ok(text.length > 0, `${provider} replied`);
  }
  const claudeRun = lines('claude').at(-1);
  assert.equal(flag(claudeRun, '--model'), 'claude-opus-5-5');
  assert.equal(flag(claudeRun, '--effort'), 'medium');
  assert.equal(flag(claudeRun, '--permission-mode'), 'auto');
  assert.ok(!claudeRun.includes('dontAsk'));
  const agyRun = lines('agy').at(-1);
  assert.equal(flag(agyRun, '--model'), 'gemini-4-neon');
  assert.equal(flag(agyRun, '--effort'), 'medium');
  assert.equal(flag(agyRun, '--mode'), 'auto');
  const [thread, turn] = lines('codex').slice(-2);
  assert.equal(thread.params.model, 'gpt-6.2-sol');
  assert.equal(thread.params.sandbox, 'workspace-write');
  assert.equal(thread.params.approvalPolicy, 'on-request');
  assert.equal(thread.params.approvalsReviewer, 'auto_review');
  assert.equal(turn.params.effort, 'medium');
  assert.equal(seen.claude.label, 'Claude Opus 5.5');
  assert.equal(seen.codex.model, 'gpt-6.2-sol');
  assert.equal(seen.gemini.effort, 'medium');
  // A saved model with no effort (older bots) still runs on medium.
  await S.subscriptionReply({ provider: 'codex', model: 'gpt-6.2-sol', effort: null }, 'hi', signal, []);
  assert.equal(lines('codex').at(-1).params.effort, 'medium');
  await S.subscriptionReply({ provider: 'claude', model: 'claude-sonnet-5-5', effort: null }, 'hi', signal, []);
  assert.equal(flag(lines('claude').at(-1), '--effort'), 'medium');
  // A Gemini model missing from the cached catalog has unknown levels, so it is launched with no --effort at all (no blind high).
  await S.subscriptionReply({ provider: 'gemini', model: 'gemini-unlisted', effort: null }, 'hi', signal, []);
  assert.ok(!lines('agy').at(-1).includes('--effort'));
  // medium stays selectable everywhere.
  await S.subscriptionReply({ provider: 'gemini', model: 'gemini-4-neon', effort: 'medium' }, 'hi', signal, []);
  assert.equal(flag(lines('agy').at(-1), '--effort'), 'medium');
  // Plain chat (no folder) keeps its restricted, tool-less launch.
  await S.subscriptionReply(S.subscriptionSelection(user, 'codex'), 'hi', signal, []);
  assert.equal(lines('codex').at(-2).params.sandbox, 'read-only');

  // ---- 4. model labels for work cards ----
  assert.equal(S.modelLabel('claude', 'claude-opus-5-5'), 'Opus 5.5');
  assert.equal(S.modelLabel('claude', 'claude-opus-5-5', 'Claude Opus 5.5'), 'Opus 5.5');
  assert.equal(S.modelLabel('codex', 'gpt-6.2-sol'), '6.2 Sol');
  assert.equal(S.modelLabel('codex', 'gpt-6.2-sol', 'GPT-6.2-Sol'), '6.2 Sol');
  assert.equal(S.modelLabel('gemini', 'gemini-4-neon'), 'Gemini 4 Neon');
  assert.equal(S.modelLabel('gemini', 'gemini-4-neon', 'Gemini 4 Neon'), 'Gemini 4 Neon');

  // ---- 5. fresh sessions for every provider ----
  for (const provider of ['claude', 'codex', 'gemini']) {
    const first = R.planRelaySession({ botId: 'b', generation: 0, provider, prompt: 'Fix the login redirect bug in app.ts' });
    R.recordRelayTurn(first.session, 'Fix the login redirect bug in app.ts', 'Fixed it.');
    const followUp = R.planRelaySession({ botId: 'b', generation: 0, provider, prompt: 'also add a test for that' });
    assert.equal(followUp.rotated, null, `${provider} continues`);
    assert.match(followUp.carried, /Fixed it/);
    const fresh = R.planRelaySession({ botId: 'b', generation: 0, provider, prompt: 'also add a test for that', newSession: true });
    assert.equal(fresh.rotated, 'you asked for a new session', `${provider} new_session`);
    assert.equal(fresh.carried, '', `${provider} fresh session carries nothing`);
  }
  assert.ok(toolMap.get('ask_subscription').parameters.properties.new_session);

  // ---- 6. action cards: questions, choices and approvals ----
  assert.deepEqual(W.ownerRequest('Done with the scan.\n\nWhich database should I use?\nOptions: Postgres | SQLite | MySQL'),
    { question: 'Which database should I use?', options: ['Postgres', 'SQLite', 'MySQL'] });
  assert.deepEqual(W.ownerRequest('I found two fixes.\n\nWhich one should I apply?\n1. Patch the regex\n2. Rewrite the parser'),
    { question: 'Which one should I apply?', options: ['Patch the regex', 'Rewrite the parser'] });
  assert.deepEqual(W.ownerRequest('The migration drops a column.\n\nShould I go ahead and run it?'),
    { question: 'Should I go ahead and run it?', options: ['Approve', "Don't approve"] });
  assert.equal(W.ownerRequest('All tests pass. Committed as abc123.'), null);
  assert.equal(W.ownerRequest('- step one\n- step two'), null);
  assert.match(W.ASK_OWNER_LINE, /Options: first \| second/);

  // ---- 7. ask_subscription end to end: model on the work card + an action card ----
  const bot = createBotRecord(user, { name: 'Relay bot' });
  const cards = () => db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='card' ORDER BY seq").all(bot.id).map((r) => JSON.parse(r.body));
  const ctx = { userId: user, botId: bot.id, signal, allowSubscriptionTeam: true };
  writeFileSync(join(bin, 'claude.reply'), 'I checked the repo.\n\nWhich branch should I push to?\nOptions: main | release');
  const out = await toolMap.get('ask_subscription').impl({ provider: 'claude', prompt: 'Ship it', title: 'Ship Opus 5.5 default fix', new_session: true }, ctx);
  assert.match(out.output, /action card/);
  assert.ok(readFileSync(join(bin, 'claude.stdin'), 'utf8').includes('Options: first'), 'the relay is told how to ask');
  await new Promise((done) => setTimeout(done, 400));
  let [work, question] = cards();
  assert.equal(work.card, 'work');
  assert.equal(work.status, 'needs-input');
  assert.deepEqual(work.options, ['main', 'release']);
  assert.deepEqual(work.agents[0], { id: 'worker-0', label: 'Claude', provider: 'claude', model: 'claude-opus-5-5', role: 'worker', modelLabel: 'Opus 5.5', effort: 'medium' });
  assert.equal(question.card, 'question');
  assert.deepEqual(question.options, ['main', 'release']);
  for (const [provider, model, label] of [['codex', 'gpt-6.2-sol', '6.2 Sol'], ['gemini', 'gemini-4-neon', 'Gemini 4 Neon']]) {
    await toolMap.get('ask_subscription').impl({ provider, prompt: 'Say hi', title: `Hi from ${provider}` }, ctx);
    await new Promise((done) => setTimeout(done, 400));
    work = cards().filter((c) => c.card === 'work').at(-1);
    assert.equal(work.status, 'done');
    assert.equal(work.agents[0].model, model);
    assert.equal(work.agents[0].modelLabel, label, `${provider} card shows ${label}`);
    assert.equal(work.agents[0].effort, 'medium');
  }
  // ---- 8. Settings defaults per provider: used whenever a request names no model/effort; explicit ones win ----
  const savePref = (provider, model, effort) => db.prepare(`INSERT INTO subscription_model_preferences(user_id,provider,model,effort) VALUES (?,?,?,?)
    ON CONFLICT(user_id,provider) DO UPDATE SET model=excluded.model,effort=excluded.effort`).run(user, provider, model, effort);
  savePref('claude', 'claude-sonnet-5-5', 'medium');
  savePref('codex', 'gpt-6.2-astra', 'low');
  savePref('gemini', 'gemini-4-neon', 'medium');
  writeFileSync(join(bin, 'claude.reply'), 'Done.');
  await toolMap.get('ask_subscription').impl({ provider: 'claude', prompt: 'Use the default', new_session: true }, ctx);
  assert.equal(flag(lines('claude').at(-1), '--model'), 'claude-sonnet-5-5', 'Claude uses its Settings default model');
  assert.equal(flag(lines('claude').at(-1), '--effort'), 'medium', 'Claude uses its Settings default effort');
  await toolMap.get('ask_subscription').impl({ provider: 'codex', prompt: 'Use the default', new_session: true }, ctx);
  assert.equal(lines('codex').filter((l) => l.method === 'thread/start').at(-1).params.model, 'gpt-6.2-astra', 'Codex uses its Settings default model');
  assert.equal(lines('codex').at(-1).params.effort, 'low', 'Codex uses its Settings default effort');
  await toolMap.get('ask_subscription').impl({ provider: 'gemini', prompt: 'Use the default', new_session: true }, ctx);
  assert.equal(flag(lines('agy').at(-1), '--effort'), 'medium', 'Gemini uses its Settings default effort');
  // Only the effort named: the default model stays; only the model named: the default effort carries over when offered.
  await toolMap.get('ask_subscription').impl({ provider: 'claude', prompt: 'Think hard', effort: 'high', new_session: true }, ctx);
  assert.equal(flag(lines('claude').at(-1), '--model'), 'claude-sonnet-5-5');
  assert.equal(flag(lines('claude').at(-1), '--effort'), 'high', 'explicit effort wins');
  await toolMap.get('ask_subscription').impl({ provider: 'claude', prompt: 'Use Opus', model: 'Opus', new_session: true }, ctx);
  assert.equal(flag(lines('claude').at(-1), '--model'), 'claude-opus-5-5', 'explicit model wins (matched by name)');
  assert.equal(flag(lines('claude').at(-1), '--effort'), 'medium', 'default effort carries to the named model');
  await assert.rejects(toolMap.get('ask_subscription').impl({ provider: 'claude', prompt: 'x', model: 'nonexistent-zzz' }, ctx), /No Claude model matches/);
  assert.ok(toolMap.get('ask_subscription').parameters.properties.model && toolMap.get('ask_subscription').parameters.properties.effort);
  // orchestrate: a bare provider name means its Settings default, and every agent gets the provider's default effort.
  const O = await import('../server/dist/agent/provider-defaults.js');
  const team = [...claudeCatalog.models, ...codexCatalog.models];
  const defaults = { claude: S.subscriptionSelection(user, 'claude'), codex: S.subscriptionSelection(user, 'codex') };
  assert.equal(O.pickModel(team, 'claude', defaults).id, 'claude-sonnet-5-5');
  assert.equal(O.pickModel(team, 'codex', defaults).id, 'gpt-6.2-astra');
  assert.equal(O.pickModel(team, '6.2 Sol', defaults).id, 'gpt-6.2-sol', 'a named model is kept');
  assert.equal(O.defaultEffortFor(team.find((m) => m.id === 'gpt-6.2-sol'), defaults.codex), 'low');

  console.log('PASS default models (claude-opus-5-5, gpt-6.2-sol, gemini-4-neon) on medium, auto-mode args, fresh sessions, action cards, model on work cards, Settings defaults per provider');
} finally {
  rmSync(bin, { recursive: true, force: true });
}
