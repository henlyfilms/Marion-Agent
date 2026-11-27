// Reliability plan §3.5, fixture Greek `rt_fzpoML-AEEjk`: a scheduled chat-runner run that failed before any tool call.
// The real logs don't say which flag caused it, so each cause is its own independent case:
//   greek-invalid-model         invalid model → blocked as runner settings (naming the model), no launch / no relaunch
//   greek-empty-effort          effort "" → treated as unset: no --effort at all (never --effort ""), one launch
//   greek-unchanged-settings    settings failure, then resume/routine triggers with unchanged settings → no relaunch,
//                               one card; a relaunch only once the settings change
//   greek-runner-vs-downstream  (a) the runner's own settings vs (b) the downstream Claude request failing: distinct text
// Purely synthetic: an in-memory DB, fake `agy` / `claude` CLIs that log every launch, no network, no listener, and no
// data from any real database. Real routine → runTurn → subscriptionReply → fake CLI path.
// Usage: npm run build && node tests/greek-runner-settings.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const bin = mkdtempSync(join(tmpdir(), 'marion-greek-'));
const log = join(bin, 'launches.jsonl');
const claudeMode = join(bin, 'claude-mode');
const agyMode = join(bin, 'agy-mode');
process.env.DB_PATH = ':memory:';
process.env.MARION_NO_SCHEDULER = '1';
process.env.MARION_DESKTOP_TOKEN = 'test-token';
process.env.HOST = '127.0.0.1';
process.env.SERVER_URL = 'http://127.0.0.1:8799';
process.env.APP_URL = 'http://127.0.0.1:8799';
process.env.XAI_API_KEY = '';
process.env.MARION_LOCAL_MODEL_URL = 'http://127.0.0.1:9/v1';
process.env.MARION_LOCAL_MODEL_API_KEY = '';
process.env.MARION_LOCAL_MODEL = 'fake';
process.env.PATH = bin + delimiter + process.env.PATH;

// Every launch is logged (tagged with the newest GREEK-n marker in its input) before the fake CLI answers.
const header = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const entry = (provider, input) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ provider, args, gate: [...input.matchAll(/GREEK-[a-z0-9]+/g)].at(-1)?.[0] ?? null }) + '\\n');
`;
writeFileSync(join(bin, 'agy'), `${header}
// reject-bare: like a real agy whose catalog can't be read, and which rejects bare model ids it doesn't know (wording of agy 1.5.x).
const agyMode = fs.existsSync(${JSON.stringify(agyMode)}) ? fs.readFileSync(${JSON.stringify(agyMode)}, 'utf8').trim() : 'ok';
if (agyMode === 'reject-bare' && args[0] === 'models') { console.error('Error: could not load models'); process.exit(1); }
if (agyMode === 'reject-bare') {
  const input = fs.readFileSync(0, 'utf8');
  entry('gemini', input);
  const model = args[args.indexOf('--model') + 1];
  const at = args.indexOf('--effort');
  if (!/^gemini-4-neon-(low|medium|high)$/.test(model)) {
    console.error('Error: invalid model selection (--model "' + model + '" --effort "' + (at >= 0 ? args[at + 1] : '') + '"): model ' + model + ' is not recognized as a known model or custom model in settings');
    process.exit(1);
  }
}
if (args[0] === 'models') { for (const l of ['low', 'medium', 'high']) console.log('gemini-4-neon-' + l + '\\tGemini 4 Neon (' + l + ')'); process.exit(0); }
const input = fs.readFileSync(0, 'utf8');
entry('gemini', input);
const at = args.indexOf('--effort');
if (at >= 0 && !['low', 'medium', 'high'].includes(args[at + 1])) { console.error('Error: invalid --effort "' + args[at + 1] + '"'); process.exit(1); }
console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Gemini reply' } }));
`, { mode: 0o700 });
writeFileSync(join(bin, 'claude'), `${header}
const mode = fs.existsSync(${JSON.stringify(claudeMode)}) ? fs.readFileSync(${JSON.stringify(claudeMode)}, 'utf8').trim() : 'ok';
if (args.includes('status')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' })); process.exit(0); }
const input = fs.readFileSync(0, 'utf8');
entry('claude', input);
const model = args[args.indexOf('--model') + 1];
if (!['claude-opus-5-5', 'claude-sonnet-5-5'].includes(model)) {
  console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: "There's an issue with the selected model (" + model + "). It may not exist or you may not have access to it." }));
  process.exit(1);
}
if (mode === 'overloaded') { console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' })); process.exit(1); }
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Claude reply' }));
`, { mode: 0o700 });

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url instanceof Request ? url.url : url);
  if (!href.startsWith('http://127.0.0.1:9/v1')) return realFetch(url, init);
  if (href.includes('/models')) return new Response(JSON.stringify({ data: [{ id: 'fake' }] }), { status: 200 });
  const item = { type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: '{"memories":[]}', annotations: [] }] };
  return new Response([{ type: 'response.output_item.done', item }, { type: 'response.completed', response: { output: [item] } }]
    .map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

const flag = (args, name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

try {
  await import('../server/dist/features/schema.js');
  const { initSubagents } = await import('../server/dist/agent/subagents.js');
  const { initRooms } = await import('../server/dist/agent/rooms.js');
  initSubagents(); initRooms();
  const { api } = await import('../server/dist/routes.js');
  const { isBotBusy, settleSideRuns, enqueue, resumeInterruptedTurns } = await import('../server/dist/agent/loop.js');
  const { initRoutines, runRoutine } = await import('../server/dist/routines.js');
  const { db } = await import('../server/dist/db.js');
  const RS = await import('../server/dist/agent/runner-settings.js');
  initRoutines(enqueue);

  const origin = 'http://127.0.0.1:8799';
  const login = await api.request(`${origin}/auth/me`);
  assert.equal(login.status, 200);
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json', origin };
  const ok = async (res) => { assert.equal(res.status, 200, await res.clone().text()); return res.json(); };

  const allLaunches = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const launchesFor = (prefix) => allLaunches().filter(l => l.gate?.startsWith(prefix));
  const waitIdle = async (id) => {
    for (const end = Date.now() + 15_000; Date.now() < end;) {
      await sleep(50);
      if (!isBotBusy(id)) { await settleSideRuns(); return; }
    }
    assert.fail('the bot never went idle');
  };
  const notices = (botId) => db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='notice' ORDER BY seq").all(botId).map(r => JSON.parse(r.body));
  const cards = (botId) => notices(botId).filter(n => n.blocker?.kind === 'runner_settings');

  let routines = 0;
  /** A synthetic stand-in for Greek's scheduled chat runner: a chat pinned to these settings, with one routine. */
  const greek = async (tag, { provider, model, effort }) => {
    const bot = (await ok(await api.request(`${origin}/bots`, { method: 'POST', headers,
      body: JSON.stringify({ name: `Greek ${tag}`, job: 'Scheduled runner', description: 'Synthetic fixture.', instructions: 'Help.' }) }))).bot;
    db.prepare('UPDATE bots SET chat_provider=?, chat_model=?, chat_effort=? WHERE id=?').run(provider, model, effort, bot.id);
    const routineId = `rt_greek-${tag}-${++routines}`;
    const prefix = `GREEK-${tag.replace(/[^a-z0-9]/g, '')}`;
    db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES (?,?,?,?,?,?,1,?)')
      .run(routineId, bot.id, `Greek ${tag}`, `${prefix}x scheduled check-in`, '0 9 * * *', 'UTC', Date.now());
    let n = 0;
    const fire = async () => {
      db.prepare('UPDATE routines SET prompt=? WHERE id=?').run(`${prefix}${++n} scheduled check-in`, routineId);
      runRoutine(routineId);
      await sleep(100);
      await waitIdle(bot.id);
    };
    return { bot, prefix, fire, launches: () => launchesFor(prefix) };
  };

  await test('greek-invalid-model: garbled Gemini model → runner-settings block naming it; 0 launches across polls and a restart', async () => {
    const g = await greek('invalidmodel', { provider: 'gemini', model: 'undefined', effort: 'medium' });
    await g.fire();
    assert.equal(g.launches().length, 0, 'nothing launched');
    const [card] = cards(g.bot.id);
    assert.ok(card, 'a runner-settings card');
    assert.match(card.text, /scheduled chat runner settings/);
    assert.match(card.text, /"undefined"/, 'the card names the model');
    assert.equal(card.blocker.setting, 'model');
    for (let poll = 0; poll < 3; poll++) await g.fire();
    await sleep(3500); // no auto-resume was scheduled for a settings block
    await waitIdle(g.bot.id);
    // Restart: the interrupted-run record comes back and is resumed by the startup path.
    db.prepare('INSERT INTO inflight_turns(id,bot_id,generation,label,started_at) VALUES (?,?,?,?,?)').run(`${g.bot.id}:restart`, g.bot.id, db.prepare('SELECT generation FROM bots WHERE id=?').get(g.bot.id).generation, 'Greek', Date.now());
    assert.equal(resumeInterruptedTurns(), 1);
    await sleep(1400);
    await waitIdle(g.bot.id);
    assert.equal(g.launches().length, 0, 'still 0 launches after polls and a restart');
    assert.equal(allLaunches().filter(l => l.gate === null).length, 0, 'no unmarked launch either');
    assert.equal(cards(g.bot.id).length, 1, 'exactly one card');
    assert.equal(notices(g.bot.id).filter(n => n.tone === 'error').length, 1, 'no extra error notices');

    // A model the CLI itself rejects (well-formed but unknown): 1 launch, classified the same way, never relaunched.
    const c = await greek('unknownmodel', { provider: 'claude', model: 'claude-bogus-9', effort: 'medium' });
    await c.fire();
    assert.equal(c.launches().length, 1, 'one launch');
    await sleep(3500);
    await c.fire();
    await waitIdle(c.bot.id);
    assert.equal(c.launches().length, 1, 'no retry, no relaunch with the same settings');
    assert.equal(cards(c.bot.id).length, 1);
    assert.match(cards(c.bot.id)[0].text, /scheduled chat runner settings.*claude-bogus-9/);
  });

  await test('greek-empty-effort: effort "" is unset → one launch with no --effort at all (never --effort "")', async () => {
    for (const provider of ['gemini', 'claude']) {
      const g = await greek(`emptyeffort${provider}`, { provider, model: provider === 'gemini' ? 'gemini-4-neon' : 'claude-opus-5-5', effort: '' });
      await g.fire();
      const runs = g.launches();
      assert.equal(runs.length, 1, `${provider}: launched once`);
      assert.equal(runs[0].args.indexOf('--effort'), -1, `${provider}: no --effort: ${JSON.stringify(runs[0].args)}`);
      assert.ok(!runs[0].args.some((arg, i) => /^--effort(=|$)/.test(arg) && (arg === '--effort=' || runs[0].args[i + 1] === '')), `${provider}: never --effort ""`);
      assert.equal(flag(runs[0].args, '--model'), provider === 'gemini' ? 'gemini-4-neon' : 'claude-opus-5-5', 'model unchanged');
      assert.equal(cards(g.bot.id).length, 0, 'no settings card');
      assert.equal(notices(g.bot.id).filter(n => n.tone === 'error').length, 0, 'no error');
    }
    for (const blank of ['', '  ', null, undefined]) assert.equal(RS.normalizeEffort(blank), null);
    assert.equal(RS.checkRunnerSettings({ provider: 'gemini', model: 'gemini-4-neon', effort: '' }), null, 'empty effort is not invalid');
  });

  await test('greek-unchanged-settings: after a settings failure, resume and routine triggers do not relaunch; a settings change does', async () => {
    const g = await greek('unchanged', { provider: 'claude', model: 'claude-bogus-9', effort: 'high' });
    await g.fire();
    assert.equal(g.launches().length, 1);
    const key = cards(g.bot.id)[0].blocker.key;
    // An auto-resume (as scheduleResume / a restart would send) and two more scheduled runs, settings unchanged.
    enqueue(g.bot.id, { type: 'system', text: `[Interrupted work] ${g.prefix}resume Your earlier work was cut off.` });
    await sleep(100); await waitIdle(g.bot.id);
    await g.fire(); await g.fire();
    assert.equal(g.launches().length, 1, 'no relaunch with unchanged settings');
    assert.equal(cards(g.bot.id).length, 1, 'the existing card stays, not duplicated');
    assert.equal(cards(g.bot.id)[0].blocker.key, key);
    // Same model, different effort: the hash changed, so a relaunch is allowed (and fails once more, with a new card).
    db.prepare('UPDATE bots SET chat_effort=? WHERE id=?').run('medium', g.bot.id);
    await g.fire();
    assert.equal(g.launches().length, 2, 'relaunched once after the settings changed');
    assert.equal(cards(g.bot.id).length, 2);
    // Fixed model: runs normally.
    db.prepare('UPDATE bots SET chat_model=? WHERE id=?').run('claude-opus-5-5', g.bot.id);
    await g.fire();
    assert.equal(g.launches().length, 3);
    assert.equal(flag(g.launches()[2].args, '--model'), 'claude-opus-5-5');
    assert.equal(cards(g.bot.id).length, 2, 'no new card for valid settings');
    assert.notEqual(RS.runnerSettingsKey({ provider: 'claude', model: 'x', effort: 'high' }), RS.runnerSettingsKey({ provider: 'claude', model: 'x', effort: 'medium' }));
    assert.equal(RS.runnerSettingsKey({ provider: 'claude', model: 'x', effort: '' }), RS.runnerSettingsKey({ provider: 'claude', model: 'x', effort: null }));
  });

  await test('greek-runner-vs-downstream: runner settings vs a failing downstream Claude request get distinct classes and text', async () => {
    // (a) The scheduled chat runner's own effort is invalid.
    const a = await greek('runner', { provider: 'gemini', model: 'gemini-4-neon', effort: 'turbo' });
    await a.fire();
    assert.equal(a.launches().length, 0);
    const [ca] = cards(a.bot.id);
    assert.ok(ca, 'runner-settings card');
    assert.match(ca.text, /scheduled chat runner settings/);
    assert.match(ca.text, /"turbo"/);
    assert.equal(ca.blocker.setting, 'effort');
    assert.doesNotMatch(ca.text, /Claude request|usage limit|sign-in/);

    // (b) Runner settings valid; the Claude request it makes fails (provider overloaded).
    writeFileSync(claudeMode, 'overloaded');
    try {
      const b = await greek('downstream', { provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' });
      await b.fire();
      assert.equal(b.launches().length, 1, 'launched once with valid settings');
      assert.equal(cards(b.bot.id).length, 0, 'not reported as runner settings');
      const errors = notices(b.bot.id).filter(n => n.tone === 'error');
      assert.equal(errors.length, 1, JSON.stringify(notices(b.bot.id)));
      assert.match(errors[0].text, /^Routine "Greek downstream": the Claude request failed: .*529/);
      assert.doesNotMatch(errors[0].text, /runner settings/);
    } finally { rmSync(claudeMode, { force: true }); }

    // Classifier units: runner-settings wording vs downstream classes.
    const sel = { provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' };
    assert.ok(RS.runnerSettingsFailure(new Error('Claude Code could not use claude-x with this account. Choose another model.'), sel));
    assert.ok(RS.runnerSettingsFailure(new Error('Codex model gpt-x is unavailable for this account. Choose another model.'), sel));
    for (const downstream of ['Claude Code reported an error: API Error: 529 Overloaded', 'Claude usage limit reached', 'Sign in to Claude Code in Terminal']) {
      assert.equal(RS.runnerSettingsFailure(new Error(downstream), sel), null, downstream);
    }
    // agy's "invalid model selection": the model itself is unknown → a runner-settings (model) failure, never an effort retry.
    for (const rejected of ['Gemini exited with code 1: invalid model selection (--model gemini-x --effort high)',
      'Gemini exited with code 1: invalid model selection (--model "gemini-4-neon" --effort ""): model gemini-4-neon is not recognized as a known model or custom model in settings']) {
      assert.equal(RS.runnerSettingsFailure(new Error(rejected), sel)?.setting, 'model', rejected);
    }
    assert.equal(RS.downstreamClass(new Error('Claude usage limit reached')), 'quota');
    assert.equal(RS.downstreamClass(new Error('Sign in to Claude Code in Terminal')), 'auth');
    assert.equal(RS.downstreamClass(new Error('API Error: 529 Overloaded')), 'provider');
    assert.match(RS.downstreamText(new Error('Claude usage limit reached'), 'claude', 'R'), /the Claude request hit a usage limit/);
  });

  await test('gate5-gemini-unrecognized-model: agy rejecting a bare unknown model id → exactly 1 launch, no --effort retry, runner-settings card (routine, chat, bot-to-bot)', async () => {
    const REAL = 'Gemini exited with code 1: invalid model selection (--model "gemini-4-neon" --effort ""): model gemini-4-neon is not recognized as a known model or custom model in settings';
    const SUB = await import('../server/dist/agent/subscriptions.js');
    const sel = { provider: 'gemini', model: 'gemini-4-neon', effort: 'medium' };
    const failures = [];
    const check = (ok, message) => { if (!ok) failures.push(message); };
    // Classifier units (the real agy wording).
    check(!SUB.effortUnsupported(new Error(REAL)), 'effortUnsupported(real agy unknown-model error) must be false');
    check(!SUB.effortUnsupported(new Error('invalid model selection (--model "gemini-x" --effort "high"): model gemini-x is not recognized as a known model or custom model in settings')), 'unknown model with --effort is still not an effort refusal');
    const classified = RS.runnerSettingsFailure(new Error(REAL), sel);
    check(classified?.setting === 'model', `runnerSettingsFailure(real agy wording) must be a model settings failure, got ${classified ? classified.setting : 'null'}`);
    // Genuine effort refusals still retry without --effort.
    check(SUB.effortUnsupported(new Error('--effort is not supported for model "gemini-4-flash"')), 'a real effort refusal is still an effort refusal');

    writeFileSync(agyMode, 'reject-bare');
    SUB.forgetGeminiCatalog();
    try {
      const expectFlags = ['--mode', '--sandbox', '--disable-slash-commands', '--settings', '--input-format', '--output-format', '--model'];
      const verify = (label, runs, botId) => {
        check(runs.length === 1, `${label}: expected exactly 1 agy launch, got ${runs.length}: ${JSON.stringify(runs.map(r => r.args.filter(a => a.startsWith('--'))))}`);
        if (runs[0]) {
          check(JSON.stringify(runs[0].args.filter(a => a.startsWith('--'))) === JSON.stringify(expectFlags), `${label}: exact flags ${JSON.stringify(runs[0].args.filter(a => a.startsWith('--')))}`);
          check(flag(runs[0].args, '--model') === 'gemini-4-neon', `${label}: --model gemini-4-neon`);
          check(runs[0].args.indexOf('--effort') === -1, `${label}: no --effort (catalog unknown)`);
        }
        const card = cards(botId);
        check(card.length === 1, `${label}: expected 1 runner-settings card, got ${card.length}: ${JSON.stringify(notices(botId).map(n => n.text))}`);
        if (card[0]) { check(card[0].blocker.setting === 'model', `${label}: card setting=model`); check(/gemini-4-neon/.test(card[0].text), `${label}: card names the model`); }
        check(notices(botId).filter(n => n.tone === 'error').length === 1, `${label}: one error notice (no double exit): ${JSON.stringify(notices(botId).map(n => n.text))}`);
      };
      // Scheduled routine.
      const g = await greek('neonroutine', { provider: 'gemini', model: 'gemini-4-neon', effort: 'medium' });
      await g.fire();
      verify('routine', g.launches(), g.bot.id);
      await g.fire();
      check(g.launches().length <= 1, `routine: no relaunch with unchanged settings (${g.launches().length})`);
      // Regular chat message.
      const c = await greek('neonchat', { provider: 'gemini', model: 'gemini-4-neon', effort: 'medium' });
      await ok(await api.request(`${origin}/bots/${c.bot.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text: `${c.prefix}1 hello` }) }));
      await sleep(100); await waitIdle(c.bot.id);
      verify('chat', c.launches(), c.bot.id);
      // Bot-to-bot message.
      const b = await greek('neonbot', { provider: 'gemini', model: 'gemini-4-neon', effort: 'medium' });
      enqueue(b.bot.id, { type: 'bot', fromBotId: c.bot.id, fromName: c.bot.name, text: `${b.prefix}1 from another bot`, depth: 1 });
      await sleep(100); await waitIdle(b.bot.id);
      verify('bot-to-bot', b.launches(), b.bot.id);
    } finally { rmSync(agyMode, { force: true }); SUB.forgetGeminiCatalog(); }
    if (failures.length) { console.error('GATE5 FAILURES:\n  ' + failures.join('\n  ')); assert.fail(`${failures.length} gate-5 check(s) failed`); }
  });

  console.log(`PASS greek-runner-settings (${passed} tests)`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  rmSync(bin, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
