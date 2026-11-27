// Unlimited concurrency, end to end, offline:
//  A. spawn_subagent has no cap: far more than the old limit of 6 helpers (25 here) are started at once, all of them work at
//     the same time, every report reaches the parent exactly once, and every bot ends idle with nothing left in flight.
//  B. Relayed / team work never serializes: an orchestrate run with 10 workers and a parallel team_delegate with 10
//     assignments run side by side (20 model calls in flight at once), plus a dozen relayed sessions in ONE folder; ids,
//     work cards and chat rows stay distinct.
//  C. One chat bot runs many turns at once: while a long user turn runs, a second user message, a question from another bot,
//     a reply to its own question, a routine, a system notice and a voice turn are all answered in parallel (none waits);
//     voice turns stay in order among themselves only; rows keep unique seqs, the bot stays "working" until the LAST run
//     ends, parallel answers reach its memory, and one stop aborts everything.
//  D. An idle bot's voice turn takes the MAIN lane (stored history, approvals, usage footer) instead of a side run; text sent
//     meanwhile still runs in parallel, a second voice turn waits for the first only, and busy counts stay accurate.
//  E. A burst of 25 subagent reports with long text, answered in parallel while a long turn runs, all reach the bot's memory
//     in full (old limits: 12 notes, 600/1200 chars, which silently dropped the oldest 13 and clipped every report).
//  F. No concurrency tool schema keeps a leftover maxItems cap (team_delegate had maxItems: 6).
// A stubbed model endpoint (no ports, no real CLIs) holds any request whose task starts with "HOLD-<key>" until released.
// Needs `npm run build` first. Usage: node tests/unlimited-concurrency.mjs
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

process.env.DB_PATH = join(tmpdir(), `marion-unlimited-concurrency-${process.pid}.db`);
process.env.MARION_NO_SCHEDULER = '1';
process.env.DEV_LOGIN = '1';
process.env.HOST = '127.0.0.1';
process.env.SERVER_URL = 'http://127.0.0.1:8794';
process.env.APP_URL = 'http://127.0.0.1:8794';
process.env.XAI_API_KEY = '';
process.env.MARION_LOCAL_MODEL_URL = 'http://127.0.0.1:9/v1';
process.env.MARION_LOCAL_MODEL_API_KEY = '';
process.env.MARION_LOCAL_MODEL = 'fake';

// ---------- the stub model ----------
const texts = (body) => (body.input ?? []).filter(item => item.role === 'user')
  .map(item => typeof item.content === 'string' ? item.content : (item.content ?? []).map(part => part.text ?? '').join(''));
const held = new Map();      // key -> release()
const inFlight = new Set();  // keys held right now
const started = [];
const aborted = [];
let peak = 0;
const lastLine = (body) => (texts(body).at(-1) ?? '').split('\n').at(-1).replace(/^\[[^\]]*\]\s*/, '');
const holdKey = (body) => typeof body.input === 'string'
  ? /Your task[^\n]*:\n(HOLD-\w+)/.exec(body.input)?.[1]
  : /^(HOLD-\w+)/.exec(lastLine(body))?.[1];
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url instanceof Request ? url.url : url);
  if (!href.startsWith('http://127.0.0.1:9/v1')) return realFetch(url, init);
  if (href.includes('/models')) return json({ data: [{ id: 'fake' }] });
  const body = JSON.parse(String(init.body));
  const key = holdKey(body);
  if (key) {
    started.push(key);
    inFlight.add(key);
    peak = Math.max(peak, inFlight.size);
    try {
      await new Promise((resolve, reject) => {
        held.set(key, resolve);
        init.signal?.addEventListener('abort', () => { aborted.push(key); reject(init.signal.reason ?? new Error('aborted')); });
      });
    } finally { inFlight.delete(key); held.delete(key); }
  }
  if (typeof body.input === 'string') {
    // Team members and the orchestrator (one-shot, non-streaming calls).
    const prompt = body.input;
    const text = prompt.includes('the ORCHESTRATOR of a team')
      ? JSON.stringify({ phases: [{ title: 'Build', tasks: Array.from({ length: 10 }, (_, n) => ({ worker: '?', task: `HOLD-orch${n} part ${n}` })) }], question: null })
      : prompt.includes("Review the subagents' work") ? JSON.stringify({ approved: true, note: 'ok', fixes: [] })
      : prompt.includes('Write the final report') ? 'Report: all ten parts are done.'
      : `Done: ${key ?? 'task'}`;
    return json({ id: `resp_${started.length}`, object: 'response', status: 'completed', output_text: text, usage: { input_tokens: 10, output_tokens: 5 },
      output: [{ type: 'message', id: `m_${started.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }] });
  }
  const reply = `Answer to: ${lastLine(body)}`;
  const item = { type: 'message', id: `msg_${Math.random().toString(36).slice(2)}`, role: 'assistant', content: [{ type: 'output_text', text: reply, annotations: [] }] };
  const events = [{ type: 'response.output_text.delta', delta: reply }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { output: [item] } }];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

await import('../server/dist/features/schema.js');
const { initSubagents, listSubagents } = await import('../server/dist/agent/subagents.js');
const { initRooms } = await import('../server/dist/agent/rooms.js');
initSubagents(); initRooms();
const { api } = await import('../server/dist/routes.js');
const loop = await import('../server/dist/agent/loop.js');
const { toolMap } = await import('../server/dist/agent/tools.js');
const { teamDelegate } = await import('../server/dist/agent/orchestration.js');
const { saveOrchestration } = await import('../server/dist/agent/orchestration-settings.js');
const { orchestrate } = await import('../server/dist/agent/orchestrate.js');
const { withFolder, folderInUse } = await import('../server/dist/agent/folder-lock.js');
const { runId } = await import('../server/dist/lib/ids.js');
const { db } = await import('../server/dist/db.js');
const { getBotRow, getLive, loadHistory } = await import('../server/dist/store.js');

const waitFor = async (check, message, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(typeof message === 'function' ? message() : message);
};
const release = (key) => { const go = held.get(key); assert.ok(go, `${key} is not being held`); go(); };
const allRows = (botId) => db.prepare('SELECT seq, kind, body FROM rows WHERE bot_id=? AND generation=? ORDER BY seq')
  .all(botId, getBotRow(botId).generation).map(row => ({ seq: row.seq, kind: row.kind, body: JSON.parse(row.body) }));
const assertSeqs = (botId) => {
  const seqs = allRows(botId).map(row => row.seq);
  assert.equal(new Set(seqs).size, seqs.length, 'row seqs must be unique');
  assert.ok(seqs.every((seq, n) => n === 0 || seq > seqs[n - 1]), 'row seqs must increase');
};
const idle = (id) => waitFor(() => !loop.isBotBusy(id) && !getLive(id).isRunning, () => `${getBotRow(id)?.name ?? id} never went idle (runs: ${loop.activeRunCount(id)}, held: ${[...inFlight]})`);

try {
  const origin = 'http://127.0.0.1:8794';
  const login = await api.request(`${origin}/auth/dev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'unlimited@example.com' }) });
  assert.equal(login.status, 200);
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  const { bots: [marion] } = await (await api.request(`${origin}/bots`, { headers })).json();
  const newBot = async (name) => (await (await api.request(`${origin}/bots`, { method: 'POST', headers, body: JSON.stringify({ name }) })).json()).bot;
  const barry = await newBot('Barry');
  const cleo = await newBot('Cleo');
  const userId = getBotRow(marion.id).user_id;
  let subagentIds = [];
  const send = (id, text) => api.request(`${origin}/bots/${id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text }) });

  // ---------- A. unlimited subagents ----------
  {
    const SPAWN = 24;
    const ctx = {
      userId, botId: marion.id, depth: 0, side: false, signal: new AbortController().signal, messaged: new Set(),
      enqueueBotMessage: (from, to, text, depth, opts) => loop.enqueue(to, loop.botMessageTrigger(from, getBotRow(from).name, to, text, depth, opts)),
    };
    const spawn = (n) => toolMap.get('spawn_subagent').impl({ goal: `HOLD-sub${n} research item ${n}`, label: `item ${n}` }, ctx);
    assert.doesNotMatch(toolMap.get('spawn_subagent').description, /up to \d|at most \d/i, 'the tool must not advertise a cap');
    const results = (await Promise.all(Array.from({ length: SPAWN }, (_, n) => spawn(n)))).map(r => JSON.parse(r.output));
    assert.ok(results.every(r => r.ok), `every spawn must succeed: ${JSON.stringify(results.find(r => !r.ok))}`);
    const ids = results.map(r => r.subagent_id);
    assert.equal(new Set(ids).size, SPAWN, 'subagent ids must be unique');
    // All of them work at the same time (4x the old cap of 6), and one more still starts while they all run.
    await waitFor(() => ids.every((_, n) => inFlight.has(`HOLD-sub${n}`)), () => `only ${[...inFlight].length} of ${SPAWN} subagents ran at once`);
    const extra = JSON.parse((await spawn(SPAWN)).output);
    assert.ok(extra.ok, `a ${SPAWN + 1}th helper must start while ${SPAWN} are busy: ${extra.output ?? JSON.stringify(extra)}`);
    ids.push(extra.subagent_id);
    await waitFor(() => inFlight.has(`HOLD-sub${SPAWN}`), 'the extra helper never started');
    assert.ok(peak >= SPAWN + 1, `peak concurrency ${peak}`);
    assert.equal(listSubagents(marion.id).filter(s => s.running).length, SPAWN + 1, 'every helper shows as working');
    // Each helper has its own live status: finishing one leaves the others working.
    release('HOLD-sub0');
    await idle(ids[0]);
    assert.ok(ids.slice(1).every(id => getLive(id).isRunning), 'one helper finishing flipped another to idle');
    for (let n = 1; n <= SPAWN; n++) release(`HOLD-sub${n}`);
    for (const id of ids) await idle(id);
    // Every report reached the parent exactly once; the parent handled them (in parallel) and is idle again.
    await waitFor(() => ids.every(id => allRows(marion.id).filter(r => r.body.from?.id === id).length === 1), 'not every report reached the parent');
    await idle(marion.id);
    for (const id of ids) assert.equal(allRows(marion.id).filter(r => r.body.from?.id === id).length, 1, `report from ${id} duplicated or lost`);
    assertSeqs(marion.id);
    assert.equal(loop.activeRunCount(marion.id), 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM bots WHERE parent_bot_id=? AND hidden=1').get(marion.id).n, SPAWN + 1);
    subagentIds = ids;
    console.log(`PASS A: ${SPAWN + 1} subagents ran at once (old cap 6), each reported exactly once, all idle.`);
  }

  // ---------- B. relayed / orchestrated / team sessions never serialize ----------
  {
    // Ids for runs started in the same millisecond never collide.
    const many = Array.from({ length: 5000 }, () => runId());
    assert.equal(new Set(many).size, many.length, 'run ids collided');

    // A dozen relayed sessions in one project folder all run at once.
    const folder = await mkdtemp(join(tmpdir(), 'marion-unlimited-'));
    let running = 0, most = 0;
    const notes = [];
    await Promise.all(Array.from({ length: 12 }, (_, n) => withFolder({ path: folder, write: true }, undefined, others => notes.push(others), async () => {
      running++; most = Math.max(most, running);
      await new Promise(resolve => setTimeout(resolve, 30));
      running--;
    })));
    assert.equal(most, 12, 'sessions in one folder must not wait for each other');
    assert.deepEqual(notes, Array.from({ length: 11 }, (_, n) => n + 1), 'each later session is told how many already share the folder');
    assert.equal(folderInUse(folder), false);
    await rm(folder, { recursive: true, force: true });

    // An orchestrated team of 10 workers (old cap 4) and a parallel team_delegate with 10 assignments (old cap 6), together.
    saveOrchestration(barry.id, { enabled: true, balanceUsage: false, members: [
      { id: 'tm_alpha1', provider: 'local', model: 'fake', effort: null, label: 'Fake A', role: '' },
      { id: 'tm_bravo2', provider: 'local', model: 'fake', effort: null, label: 'Fake B', role: '' },
    ] });
    const stop = new AbortController();
    const before = started.length;
    const orchestrated = orchestrate({ userId, botId: barry.id, signal: stop.signal, allowSubscriptionTeam: false },
      { goal: 'Build ten parts', orchestrator: 'fake', workers: ['fake'], worker_count: 10, title: 'Ten parts' });
    const delegated = teamDelegate(barry.id, { mode: 'parallel', assignments: Array.from({ length: 10 }, (_, n) => ({ member: 'auto', task: `HOLD-team${n} piece ${n}` })) }, stop.signal);
    const keys = [...Array.from({ length: 10 }, (_, n) => `HOLD-orch${n}`), ...Array.from({ length: 10 }, (_, n) => `HOLD-team${n}`)];
    await waitFor(() => keys.every(key => inFlight.has(key)), () => `only ${keys.filter(key => inFlight.has(key)).length} of 20 relayed calls ran at once`);
    assert.equal(started.length - before, 20, 'the 20 worker and member calls each started once');
    for (const key of keys) release(key);
    const [orch, team] = await Promise.all([orchestrated, delegated]);
    assert.match(orch.output, /Team report from fake \(orchestrator\)/);
    assert.match(orch.summary, /fake 11/, 'all ten workers took part');
    assert.equal((team.output.match(/^## Fake [AB] /gm) ?? []).length, 10, 'every assignment came back');
    assert.equal(team.summary, '10 of 10 team replies');
    const rows = allRows(barry.id);
    const card = rows.find(r => r.body.type === 'card' && r.body.card === 'work');
    assert.equal(card.body.status, 'done');
    assert.equal(card.body.agents.length, 11, 'orchestrator + 10 workers on one card');
    assert.equal(rows.filter(r => r.body.from?.kind === 'model').length, 10, 'each team reply is its own chat row');
    assertSeqs(barry.id);
    console.log('PASS B: 10-worker orchestration + 10 parallel team assignments ran together (20 in flight), 12 sessions shared one folder.');
  }

  // ---------- C. one bot, many concurrent turns ----------
  {
    const generation = getBotRow(cleo.id).generation;
    assert.equal((await send(cleo.id, 'HOLD-main long task')).status, 200);
    await waitFor(() => inFlight.has('HOLD-main'), 'the long turn never started');
    assert.equal((await send(cleo.id, 'HOLD-u2 second request')).status, 200);
    loop.enqueue(cleo.id, { type: 'bot', fromBotId: barry.id, fromName: 'Barry', text: 'HOLD-b1 question from Barry', depth: 0 });
    loop.enqueue(cleo.id, { type: 'bot', fromBotId: barry.id, fromName: 'Barry', text: 'HOLD-b2 reply to your question', depth: 1, autoReply: true });
    loop.enqueue(cleo.id, { type: 'routine', routineId: 'rt_test', name: 'Daily', prompt: 'HOLD-r1 routine work' });
    loop.enqueue(cleo.id, { type: 'system', text: 'HOLD-s1 system notice' });
    loop.enqueue(cleo.id, { type: 'user', text: 'HOLD-v1 voice one', generation, voice: { call: 'call_1', seq: 1, fast: true } });
    loop.enqueue(cleo.id, { type: 'user', text: 'HOLD-v2 voice two', generation, voice: { call: 'call_1', seq: 2, fast: true } });
    const parallel = ['HOLD-main', 'HOLD-u2', 'HOLD-b1', 'HOLD-b2', 'HOLD-r1', 'HOLD-s1', 'HOLD-v1'];
    await waitFor(() => parallel.every(key => inFlight.has(key)), () => `not all turns ran at once: ${parallel.filter(key => !inFlight.has(key))}`);
    assert.equal(loop.activeRunCount(cleo.id), 7, 'main turn + 6 concurrent runs');
    // Voice turns keep their order among themselves, but never wait for the text work.
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.ok(!started.includes('HOLD-v2'), 'the second voice turn must wait for the first one only');
    release('HOLD-v1');
    await waitFor(() => inFlight.has('HOLD-v2'), 'the second voice turn never started after the first');
    await waitFor(() => getLive(cleo.id).voiceReply?.text === 'Answer to: HOLD-v1 voice one', 'the voice turn answered in parallel was not spoken');
    assert.ok(inFlight.has('HOLD-main'), 'the long turn must still run');
    // Finishing side runs never flips the bot to idle while the long turn runs.
    for (const key of ['HOLD-v2', 'HOLD-u2', 'HOLD-b1', 'HOLD-b2', 'HOLD-r1', 'HOLD-s1']) {
      release(key);
      await waitFor(() => !inFlight.has(key), `${key} did not finish`);
    }
    await waitFor(() => loop.activeRunCount(cleo.id) === 1, () => `side runs did not wind down (${loop.activeRunCount(cleo.id)})`);
    assert.equal(getLive(cleo.id).isRunning, true, 'the bot flipped to idle while its long turn still runs');
    assert.ok(!JSON.stringify(loadHistory(cleo.id)).includes('HOLD-u2'), 'a parallel exchange leaked into the stored history mid-turn');
    release('HOLD-main');
    await idle(cleo.id);
    assert.equal(loop.activeRunCount(cleo.id), 0);
    // Every answer is its own row, exactly once; seqs stay unique; nothing is left in flight.
    const rows = allRows(cleo.id);
    for (const text of ['HOLD-main long task', 'HOLD-u2 second request', 'HOLD-b1 question from Barry', 'HOLD-b2 reply to your question', 'HOLD-r1 routine work', 'HOLD-s1 system notice', 'HOLD-v1 voice one', 'HOLD-v2 voice two']) {
      assert.equal(rows.filter(r => r.body.type === 'message' && r.body.role === 'assistant' && r.body.text === `Answer to: ${text}`).length, 1, `answer to "${text}" missing or duplicated`);
    }
    assert.equal(rows.filter(r => r.body.type === 'notice' && r.body.tone === 'error').length, 0, 'no run failed');
    assertSeqs(cleo.id);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM inflight_turns WHERE bot_id=?').get(cleo.id).n, 0, 'in-flight records were not cleared');
    // The question from Barry was answered back; the reply to Cleo's own question was not (no ping-pong).
    await waitFor(() => allRows(barry.id).some(r => r.body.from?.id === cleo.id && r.body.text === 'Answer to: HOLD-b1 question from Barry'), 'Barry never got his answer');
    assert.ok(!allRows(barry.id).some(r => r.body.from?.id === cleo.id && /HOLD-b2/.test(r.body.text)), 'an auto-reply was answered back');
    // What was answered in parallel is now in the bot's memory.
    const memory = JSON.stringify(loadHistory(cleo.id));
    for (const key of ['HOLD-u2', 'HOLD-b1', 'HOLD-r1', 'HOLD-s1']) assert.ok(memory.includes(key), `${key} never reached the bot's memory`);
    await idle(barry.id);

    // One stop aborts the main turn and every concurrent run, with a single "Stopped." row.
    assert.equal((await send(cleo.id, 'HOLD-x0 another long task')).status, 200);
    await waitFor(() => inFlight.has('HOLD-x0'), 'x0 never started');
    assert.equal((await send(cleo.id, 'HOLD-x1 more')).status, 200);
    loop.enqueue(cleo.id, { type: 'bot', fromBotId: barry.id, fromName: 'Barry', text: 'HOLD-x2 question', depth: 0 });
    loop.enqueue(cleo.id, { type: 'routine', routineId: 'rt_test', name: 'Daily', prompt: 'HOLD-x3 routine' });
    await waitFor(() => ['HOLD-x0', 'HOLD-x1', 'HOLD-x2', 'HOLD-x3'].every(key => inFlight.has(key)), 'the runs did not overlap');
    const stoppedBefore = allRows(cleo.id).filter(r => /^Stopped/.test(r.body.text ?? '')).length;
    loop.stopBot(cleo.id);
    await waitFor(() => ['HOLD-x0', 'HOLD-x1', 'HOLD-x2', 'HOLD-x3'].every(key => aborted.includes(key)), 'stop did not abort every run');
    await idle(cleo.id);
    assert.equal(allRows(cleo.id).filter(r => /^Stopped/.test(r.body.text ?? '')).length - stoppedBefore, 1, 'exactly one "Stopped." row');
    console.log('PASS C: user, bot, auto-reply, routine, system and voice turns ran in parallel with a long turn; status, rows, memory and stop stayed consistent.');
  }

  // ---------- D. an idle voice turn takes the main lane ----------
  {
    const dana = await newBot('Dana');
    const generation = getBotRow(dana.id).generation;
    assert.equal(loop.isBotBusy(dana.id), false);
    loop.enqueue(dana.id, { type: 'user', text: 'HOLD-iv1 idle voice', generation, voice: { call: 'call_d', seq: 1, fast: true } });
    assert.equal(loop.isBotBusy(dana.id), true, 'a queued voice turn must count as busy');
    await waitFor(() => inFlight.has('HOLD-iv1'), 'the idle voice turn never started');
    // Main lane: it writes straight into the stored history (a side run only would after it ends) and is the only run.
    assert.ok(JSON.stringify(loadHistory(dana.id)).includes('HOLD-iv1 idle voice'), 'an idle voice turn ran as a side run instead of on the main lane');
    assert.equal(loop.activeRunCount(dana.id), 1);
    assert.equal(loop.runsConcurrently(dana.id, { type: 'user', text: 'x' }), true, 'text sent during the voice turn must run in parallel');
    // Text sent during the voice turn runs right away, in parallel; a second voice turn waits for the first only.
    assert.equal((await send(dana.id, 'HOLD-it1 text during voice')).status, 200);
    loop.enqueue(dana.id, { type: 'user', text: 'HOLD-iv2 second voice', generation, voice: { call: 'call_d', seq: 2, fast: true } });
    await waitFor(() => inFlight.has('HOLD-it1'), 'a text turn waited behind the voice turn');
    assert.equal(loop.activeRunCount(dana.id), 2, 'voice main turn + parallel text turn');
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.ok(!started.includes('HOLD-iv2'), 'the second voice turn must wait for the first one');
    assert.ok(!JSON.stringify(loadHistory(dana.id)).includes('HOLD-it1'), 'the parallel text turn leaked into the stored history mid-turn');
    release('HOLD-iv1');
    await waitFor(() => inFlight.has('HOLD-iv2'), 'the second voice turn never started after the first');
    await waitFor(() => getLive(dana.id).voiceReply?.text === 'Answer to: HOLD-iv1 idle voice', 'the main-lane voice reply was not spoken');
    assert.ok(inFlight.has('HOLD-it1'), 'the text turn must still run');
    release('HOLD-iv2');
    await waitFor(() => getLive(dana.id).voiceReply?.text === 'Answer to: HOLD-iv2 second voice', 'the second voice reply was not spoken');
    assert.equal(loop.isBotBusy(dana.id), true, 'the bot must stay busy while the text turn runs');
    release('HOLD-it1');
    await idle(dana.id);
    assert.equal(loop.isBotBusy(dana.id), false);
    const memory = JSON.stringify(loadHistory(dana.id));
    for (const key of ['HOLD-iv1', 'HOLD-iv2', 'HOLD-it1']) assert.ok(memory.includes(key), `${key} never reached the bot's memory`);
    const rows = allRows(dana.id);
    for (const text of ['HOLD-iv1 idle voice', 'HOLD-iv2 second voice', 'HOLD-it1 text during voice']) {
      assert.equal(rows.filter(r => r.body.type === 'message' && r.body.role === 'assistant' && r.body.text === `Answer to: ${text}`).length, 1, `answer to "${text}" missing or duplicated`);
    }
    assertSeqs(dana.id);
    // A lone voice turn on an idle bot: main lane again, and the bot goes fully idle afterwards.
    loop.enqueue(dana.id, { type: 'user', text: 'HOLD-iv3 lone voice', generation, voice: { call: 'call_d', seq: 3, fast: true } });
    await waitFor(() => inFlight.has('HOLD-iv3'), 'the lone voice turn never started');
    assert.ok(JSON.stringify(loadHistory(dana.id)).includes('HOLD-iv3 lone voice'), 'a lone idle voice turn missed the main lane');
    release('HOLD-iv3');
    await idle(dana.id);
    assert.equal(loop.busyBotCount(), 0, 'busyBotCount must drop to 0 once every bot is idle');
    console.log('PASS D: idle voice turns took the main lane; text ran in parallel; voice turns stayed in order; busy counts accurate.');
  }

  // ---------- E. a big burst of long subagent reports all reach memory ----------
  {
    assert.ok(subagentIds.length >= 25);
    const longText = (n) => `REPORT-${n}-START ${'detail '.repeat(400).trim()} REPORT-${n}-END`;
    assert.equal((await send(marion.id, 'HOLD-main3 long task')).status, 200);
    await waitFor(() => inFlight.has('HOLD-main3'), 'the long turn never started');
    const BURST = 25;
    for (let n = 0; n < BURST; n++) {
      const from = subagentIds[n];
      loop.enqueue(marion.id, loop.botMessageTrigger(from, getBotRow(from).name, marion.id, longText(n), 1, { autoReply: true }));
    }
    const answered = () => allRows(marion.id).filter(r => r.body.role === 'assistant' && /^Answer to: REPORT-\d+-START/.test(r.body.text ?? '')).length;
    await waitFor(() => answered() === BURST && loop.activeRunCount(marion.id) === 1, () => `only ${answered()} of ${BURST} reports answered in parallel`);
    assert.ok(!JSON.stringify(loadHistory(marion.id)).includes('REPORT-0-START'), 'parallel reports leaked into the stored history mid-turn');
    release('HOLD-main3');
    await idle(marion.id);
    const memory = JSON.stringify(loadHistory(marion.id));
    for (let n = 0; n < BURST; n++) {
      // Once in what was asked, once in what was answered: both kept in full (start and end markers survive).
      assert.ok(memory.split(`REPORT-${n}-START`).length - 1 >= 2, `report ${n} (start) dropped from memory`);
      assert.ok(memory.split(`REPORT-${n}-END`).length - 1 >= 2, `report ${n} was clipped or dropped in memory`);
    }
    assert.doesNotMatch(memory, /left out to save memory/, 'no parallel exchange may be dropped in a 25-report burst');
    console.log(`PASS E: ${BURST} long subagent reports (${longText(0).length} chars each) answered in parallel all reached memory in full.`);
  }

  // ---------- F. no leftover maxItems caps on concurrency tools ----------
  {
    const assignments = toolMap.get('team_delegate').parameters.properties.assignments;
    assert.equal(assignments.type, 'array');
    assert.equal(assignments.maxItems, undefined, 'team_delegate must not cap assignments');
    const concurrencyTools = ['spawn_subagent', 'message_subagent', 'send_to_bot', 'ask_subscription', 'orchestrate', 'ask_grok', 'team_delegate', 'team_discuss'];
    for (const name of concurrencyTools.filter(name => toolMap.has(name))) {
      assert.doesNotMatch(JSON.stringify(toolMap.get(name).parameters), /maxItems/, `${name} keeps a maxItems cap`);
    }
    console.log('PASS F: team_delegate and every other concurrency tool schema have no maxItems cap.');
  }
  await loop.settleSideRuns();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const go of held.values()) go();
  globalThis.fetch = realFetch;
  await rm(process.env.DB_PATH, { force: true });
  process.exit(process.exitCode ?? 0);
}
