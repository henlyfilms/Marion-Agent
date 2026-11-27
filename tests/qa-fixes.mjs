// QA fixes: stale `running` tool calls / work cards finalized on restart, Gemini --effort only for models that take it
// (with one retry without it), one retry for a malformed MARION_TOOL request, the in-app Google sign-in card, a friendly
// "start Colima" message for a stopped Docker engine (never for errors of commands run inside the container), and quiet
// handling of expected voice AbortErrors (never timeouts).
// Fake agy/docker executables and an in-memory database: no network, no real CLIs, nothing opens on screen.
// Usage: npm run build && node tests/qa-fixes.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const bin = mkdtempSync(join(tmpdir(), 'marion-qa-fixes-'));
process.env.DB_PATH = ':memory:';
process.env.MARION_DESKTOP_TOKEN = 'test-token';
process.env.MARION_NO_SCHEDULER = '1';
process.env.HOST = '127.0.0.1';
process.env.SERVER_URL = 'http://127.0.0.1:8787';
process.env.PATH = bin + delimiter + process.env.PATH;

const agyLog = join(bin, 'agy.jsonl');
const signedOut = join(bin, 'signed-out');
const modelsDown = join(bin, 'models-down');
const noEffortFlag = join(bin, 'no-effort-flag');
const script = (body) => `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\n${body}\n`;
// Antigravity: "gemini-4-neon" has no effort levels on this account and refuses --effort (the QA crash); flash has medium.
writeFileSync(join(bin, 'agy'), script(`
const out = fs.existsSync(${JSON.stringify(signedOut)});
if (args[0] === 'models') {
  if (fs.existsSync(${JSON.stringify(modelsDown)})) { process.stderr.write('Error: could not reach the model service.\\n'); process.exit(1); }
  if (out) { process.stderr.write('Error: not authenticated. Please sign in.\\n'); process.exit(1); }
  console.log('gemini-4-neon\\tGemini 4 Neon'); console.log('gemini-3.8-flash-medium\\tGemini 3.8 Flash (Medium)'); process.exit(0);
}
fs.appendFileSync(${JSON.stringify(agyLog)}, JSON.stringify(args) + '\\n');
if (out) { process.stderr.write('Error: You are not authenticated. Please sign in with Google.\\n'); process.exit(1); }
const model = args[args.indexOf('--model') + 1];
// A build without the flag: Go's flag parser, exactly as agy 1.5.18 words an unknown flag (then its usage).
if (args.includes('--effort') && fs.existsSync(${JSON.stringify(noEffortFlag)})) { process.stderr.write('flags provided but not defined: -effort\\nUsage of agy:\\n  --model    Model for the current CLI session\\n'); process.exit(2); }
if (args.includes('--effort') && /neon/.test(model)) { process.stderr.write('--effort is not supported for model "' + model + '"\\n'); process.exit(1); }
console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Gemini reply' } }));
`), { mode: 0o700 });
// Docker CLI (v28 wording) with Colima stopped; \`docker exec\` stands for a running engine whose inner command fails.
writeFileSync(join(bin, 'docker'), script(`
if (args[0] === 'exec') { process.stderr.write('curl: (7) Failed to connect to localhost port 8080 after 0 ms: Connection refused\\ncannot connect to X server :1\\n'); process.exit(7); }
process.stderr.write('failed to connect to the docker API at unix:///Users/me/.colima/default/docker.sock; check if the path is correct and if the daemon is running: dial unix /Users/me/.colima/default/docker.sock: connect: no such file or directory\\n');
process.exit(1);
`), { mode: 0o700 });

const { db, now } = await import('../server/dist/db.js');
await import('../server/dist/features/schema.js');
await import('../server/dist/db-config.js');
(await import('../server/dist/agent/subagents.js')).initSubagents();
(await import('../server/dist/agent/rooms.js')).initRooms();
const { appendRow, getRow } = await import('../server/dist/store.js');
const sessions = await import('../server/dist/features/agent-sessions.js');
const S = await import('../server/dist/agent/subscriptions.js');
const L = await import('../server/dist/agent/loop.js');
const SignIn = await import('../server/dist/features/sign-in-cards.js');
const D = await import('../server/dist/desktop.js');
const { isExpectedAbort } = await import('../server/dist/lib/abort.js');
const { featuresApi } = await import('../server/dist/routes-features.js');

const agyRuns = () => existsSync(agyLog) ? readFileSync(agyLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const flag = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const userId = 'user_qa';
const botId = 'bot_qa';
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(userId, 'owner@example.com', 'Owner', now());
db.prepare('INSERT INTO bots(id,user_id,name,label,description,instructions,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(botId, userId, 'Quinn', 'Helper', '', '', now(), now());
const signal = new AbortController().signal;

try {
  // ---------- 1. stale running tool calls and work cards are finalized on startup ----------
  const staleCall = appendRow(botId, 'tool-call', { type: 'tool-call', callId: 'c1', name: 'open_browser', label: 'Opening the browser', status: 'running' }).seq;
  const staleCard = appendRow(botId, 'card', { type: 'card', card: 'work', title: 'Fix it', agents: [{ id: 'a', label: 'Claude', provider: 'claude', model: 'm', modelLabel: 'M', role: 'worker', usage: { live: true } }],
    phases: [{ title: 'Build', status: 'running' }, { title: 'Ship', status: 'pending' }], steps: [], live: true, status: 'running', startedAt: now() - 5000, stop: { kind: 'cloud', sessionId: 's1' } }).seq;
  const doneCall = appendRow(botId, 'tool-call', { type: 'tool-call', callId: 'c2', name: 'bash', label: 'Running', status: 'done' }).seq;
  db.prepare('UPDATE rows SET created_at=? WHERE bot_id=? AND seq IN (?,?,?)').run(now() - 60_000, botId, staleCall, staleCard, doneCall);
  const liveCall = appendRow(botId, 'tool-call', { type: 'tool-call', callId: 'c3', name: 'bash', label: 'Running', status: 'running' }).seq;
  assert.equal(sessions.recoverStaleRows(now() - 30_000), 2, 'only the two stale running rows');
  assert.equal(getRow(botId, staleCall).body.status, 'error');
  assert.match(getRow(botId, staleCall).body.summary, /restarted before this finished/);
  const card = getRow(botId, staleCard).body;
  assert.equal(card.status, 'stopped'); assert.ok(card.endedAt > 0); assert.equal(card.stop, undefined);
  assert.deepEqual(card.phases.map((p) => p.status), ['failed', 'pending']);
  assert.equal(card.agents[0].usage.live, false);
  assert.match(card.steps.at(-1).text, /restarted/);
  assert.equal(getRow(botId, doneCall).body.status, 'done', 'finished rows untouched');
  assert.equal(getRow(botId, liveCall).body.status, 'running', 'rows from this run (after the cutoff) untouched');
  sessions.recoverAgentSessions();
  assert.equal(getRow(botId, liveCall).body.status, 'running', 'startup recovery leaves rows created by this process alone');
  assert.equal(sessions.recoverStaleRows(now() + 1), 1, 'and finalizes anything older than the process start');
  console.log('PASS stale running tool calls / work cards finalized on restart (error / stopped), live and finished rows untouched');

  // ---------- 2. Gemini --effort only for models that take it ----------
  assert.equal(S.runEffort({ efforts: [] }, 'high'), null, 'no effort levels → no --effort');
  assert.equal(S.runEffort({ efforts: ['low', 'medium', 'high'] }, 'xhigh'), 'high', 'unsupported saved effort → preferred');
  assert.equal(S.runEffort({ efforts: ['low', 'medium', 'high'] }, 'medium'), 'medium');
  assert.equal(S.runEffort({ efforts: ['medium'] }, null), 'medium');
  assert.equal(S.runEffort({ efforts: ['low', 'high'] }, 'high', true), 'low', 'fast mode');
  assert.equal(S.runEffort({ efforts: [] }, 'high', true), null);
  assert.equal(S.runEffort(undefined, 'max'), 'max', 'unknown model keeps the saved effort');
  assert.equal(S.runEffort(undefined, null), 'high');
  assert.equal(S.runEffort({ efforts: ['high'] }, 'high', false, true), null, 'noEffort');
  assert.ok(S.effortUnsupported(new Error('Gemini exited with code 1: --effort is not supported for model "gemini-4-neon"')));
  assert.ok(!S.effortUnsupported(new Error('Gemini exited with code 1: quota')));
  // Real agy 1.5.18 wording: its Go flag parser (`agy --no-such-flag` → "flags provided but not defined: -no-such-flag") and
  // the effort errors in its binary; then the Go stdlib's singular form and common unknown-option / invalid-level wording.
  for (const refused of ['invalid --effort "ultra" (valid: low|medium|high|xhigh|max)', 'gemini-4-neon has no "high" effort (available: low, medium)',
    '--effort=high is not supported for model "gemini-4-neon"', '--effort is not supported for the current model', 'unrecognized effort "ultra" for thinking level',
    '--model gemini-4-neon conflicts with --effort=high', 'invalid model selection (--model "gemini-4-neon" --effort "high"): no such variant',
    'flags provided but not defined: -effort', 'flag provided but not defined: -effort', 'flag provided but not defined: --effort',
    'Error: invalid effort level "ultra" (want low|medium|high|xhigh|max)', 'invalid value "ultra" for flag -effort: unknown level',
    "error: unknown option '--effort'", 'Error: Unknown argument: effort --effort', 'effort level "max" is not supported for model gemini-x', 'Unsupported reasoning effort: max']) {
    assert.ok(S.effortUnsupported(new Error('Gemini exited with code 2: ' + refused)), refused);
  }
  for (const other of ['flags provided but not defined: -model', 'invalid model "gemini-x"', 'Error: You are not authenticated.', 'Connection refused'])
    assert.ok(!S.effortUnsupported(new Error('Gemini exited with code 1: ' + other)), other);
  assert.equal(S.runEffort(undefined, 'high', false, false, 'none'), null, 'unlisted Gemini model: no blind --effort');
  assert.equal(await S.subscriptionReply({ provider: 'gemini', model: 'gemini-4-neon', effort: 'high' }, 'hi', signal, []), 'Gemini reply');
  let runs = agyRuns();
  assert.equal(runs.length, 1, 'one launch, no crash');
  assert.equal(flag(runs[0], '--model'), 'gemini-4-neon'); assert.equal(flag(runs[0], '--effort'), undefined, 'saved effort not passed to a model without levels');
  await S.subscriptionReply({ provider: 'gemini', model: 'gemini-3.8-flash', effort: 'high' }, 'hi', signal, []);
  assert.equal(flag(agyRuns().at(-1), '--effort'), 'medium', 'saved high → the model\'s own medium');
  // A model missing from the catalog: its levels are unknown, so no --effort at all (it used to get a blind --effort high).
  let before = agyRuns().length;
  await S.subscriptionReply({ provider: 'gemini', model: 'gemini-neon-preview', effort: 'high' }, 'hi', signal, []);
  runs = agyRuns().slice(before);
  assert.equal(runs.length, 1, 'one run, no refusal'); assert.equal(flag(runs[0], '--model'), 'gemini-neon-preview'); assert.equal(flag(runs[0], '--effort'), undefined);
  // Regression (d302777): unlisted Gemini uses `unlisted: 'none'`, so even with no saved effort the flag is omitted entirely (not high).
  assert.equal(S.runEffort(undefined, null, false, false, 'none'), null, 'unlisted Gemini, no saved effort: no --effort');
  before = agyRuns().length;
  await S.subscriptionReply({ provider: 'gemini', model: 'gemini-neon-preview', effort: null }, 'hi', signal, []);
  runs = agyRuns().slice(before);
  assert.equal(runs.length, 1); assert.ok(!runs[0].includes('--effort'), 'unlisted Gemini model launched without --effort');
  // `agy models` fails: no catalog, so no --effort either (even for a model that normally has levels).
  writeFileSync(modelsDown, ''); S.forgetGeminiCatalog();
  before = agyRuns().length;
  assert.equal(await S.subscriptionReply({ provider: 'gemini', model: 'gemini-3.8-flash', effort: 'high' }, 'hi', signal, []), 'Gemini reply');
  runs = agyRuns().slice(before);
  assert.equal(runs.length, 1); assert.equal(flag(runs[0], '--effort'), undefined, 'catalog unavailable: no --effort high');
  unlinkSync(modelsDown); S.forgetGeminiCatalog();
  // The real "unknown flag" wording from agy's flag parser: retried once without --effort, and the reply comes back.
  writeFileSync(noEffortFlag, '');
  before = agyRuns().length;
  assert.equal(await S.subscriptionReply({ provider: 'gemini', model: 'gemini-3.8-flash', effort: 'high' }, 'hi', signal, []), 'Gemini reply');
  runs = agyRuns().slice(before);
  assert.equal(runs.length, 2); assert.equal(flag(runs[0], '--effort'), 'medium'); assert.equal(flag(runs[1], '--effort'), undefined);
  unlinkSync(noEffortFlag);
  console.log('PASS Gemini --effort guarded by the model\'s efforts (catalog refreshed at run time); no --effort when the catalog fails or misses the model; one retry without it on agy\'s real unknown-flag / invalid-effort wording');

  // ---------- 3. a malformed MARION_TOOL request is retried once ----------
  const names = ['open_browser', 'bash'];
  assert.deepEqual(L.parseToolRequest('Hello there', names), { kind: 'none' });
  assert.equal(L.parseToolRequest('MARION_TOOL: {"name":"bash","arguments":{"cmd":"ls"}}', names).kind, 'call');
  assert.equal(L.parseToolRequest('MARION_TOOL: {"name":"bash","arguments":{"cmd":"ls"}', names).kind, 'invalid');
  assert.match(L.parseToolRequest('MARION_TOOL: {"name":"nope","arguments":{}}', names).reason, /not one of the available tools/);
  assert.match(L.parseToolRequest('MARION_TOOL: {"name":"bash","arguments":[]}', names).reason, /must be a JSON object/);
  assert.equal(L.parseToolRequest('MARION_TOOL: open the browser', names).kind, 'invalid');
  const asks = [];
  const scripted = (...replies) => async (feedback) => { asks.push(feedback); return replies.shift(); };
  let got = await L.resolveToolRequest(scripted('MARION_TOOL: {"name":"bash","arguments":{"cmd":"ls"}', 'MARION_TOOL: {"name":"bash","arguments":{"cmd":"ls"}}'), names);
  assert.equal(got.call.name, 'bash'); assert.deepEqual(got.call.arguments, { cmd: 'ls' });
  assert.equal(asks.length, 2); assert.equal(asks[0], undefined); assert.match(asks[1], /invalid Marion tool request: the JSON after MARION_TOOL: did not parse/);
  asks.length = 0;
  got = await L.resolveToolRequest(scripted('MARION_TOOL: {bad', 'Sorry, here is the answer.'), names);
  assert.equal(got.call, undefined); assert.equal(got.reply, 'Sorry, here is the answer.', 'a plain answer on the retry is fine');
  asks.length = 0;
  await assert.rejects(L.resolveToolRequest(scripted('MARION_TOOL: {bad', 'MARION_TOOL: {"name":"nope","arguments":{}}'), names), /invalid Marion tool request twice/);
  assert.equal(asks.length, 2, 'exactly one retry');
  asks.length = 0;
  got = await L.resolveToolRequest(scripted('All done.'), names);
  assert.equal(got.reply, 'All done.'); assert.equal(asks.length, 1, 'valid answers are not retried');
  console.log('PASS malformed MARION_TOOL: one retry with corrective feedback, a second invalid request fails the turn');

  // ---------- 4. Google sign-in becomes an in-app sign-in card ----------
  writeFileSync(signedOut, '');
  const track = { id: 'turn:qa-1', kind: 'subscription_bot', userId, botId, request: 'hi' };
  await assert.rejects(S.subscriptionReply({ provider: 'gemini', model: 'gemini-4-neon', effort: null }, 'hi', signal, [], { session: track }),
    (error) => error instanceof S.GoogleSignInRequired && error.name === 'GoogleSignInRequired');
  const signInCards = () => db.prepare("SELECT seq, body FROM rows WHERE bot_id=? AND json_extract(body,'$.card')='sign-in'").all(botId).map((r) => ({ seq: r.seq, ...JSON.parse(r.body) }));
  assert.equal(signInCards().length, 1);
  const signInCard = signInCards()[0];
  assert.equal(signInCard.provider, 'gemini'); assert.equal(signInCard.status, 'pending');
  assert.equal(signInCard.command, join(bin, 'agy') + ' acp --login', 'Copy command copies the resolved agy path, not a bare agy');
  assert.match(signInCard.reason, /sign in with your personal Google account/);
  await assert.rejects(S.subscriptionReply({ provider: 'gemini', model: 'gemini-4-neon', effort: null }, 'hi', signal, [], { session: { ...track, id: 'turn:qa-2' } }));
  assert.equal(signInCards().length, 1, 'a pending card is reused, not repeated');
  await assert.rejects(SignIn.actOnSignInCard(botId, signInCard.seq, 'open', { local: false }), /on the Mac/);
  const opened = [];
  SignIn.setSignInDeps({ open: async (command) => { opened.push(command); } });
  assert.equal(await SignIn.actOnSignInCard(botId, signInCard.seq, 'open', { local: true }), 'working');
  assert.match(opened[0], /agy'? acp --login$/);
  assert.equal(getRow(botId, signInCard.seq).body.command, opened[0], 'the copied command is the one "Sign in with Google" runs');
  assert.equal(getRow(botId, signInCard.seq).body.status, 'working');
  SignIn.setSignInDeps({ open: async () => {} });
  let resumed = 0;
  await assert.rejects(SignIn.actOnSignInCard(botId, signInCard.seq, 'check', { local: true, resume: () => resumed++ }), /still not signed in/);
  assert.equal(getRow(botId, signInCard.seq).body.status, 'working', 'a failed check keeps "I\'ve signed in" (no new Sign in with Google)');
  assert.match(getRow(botId, signInCard.seq).body.note, /still not signed in/); assert.equal(resumed, 0);
  await assert.rejects(SignIn.actOnSignInCard(botId, signInCard.seq, 'check', { local: true, resume: () => resumed++ }), /still not signed in/, 'retryable directly');
  assert.equal(getRow(botId, signInCard.seq).body.status, 'working'); assert.equal(opened.length, 1, 'no second open needed');
  unlinkSync(signedOut);
  assert.equal(await SignIn.actOnSignInCard(botId, signInCard.seq, 'check', { local: true, resume: () => resumed++ }), 'signed-in');
  assert.equal(getRow(botId, signInCard.seq).body.status, 'signed-in'); assert.equal(resumed, 1, 'the bot carries on after sign-in');
  await assert.rejects(SignIn.actOnSignInCard(botId, signInCard.seq, 'check', { local: true }), /already done/);
  // Dismiss: from pending or working, closes the card for good (any later action is refused), also from another device.
  const generation = db.prepare('SELECT generation FROM bots WHERE id=?').get(botId).generation;
  const dismissSeq = SignIn.showSignInCard(userId, botId, generation, 'gemini');
  assert.notEqual(dismissSeq, signInCard.seq, 'a new card once the last one is done');
  assert.equal(await SignIn.actOnSignInCard(botId, dismissSeq, 'dismiss', { local: false }), 'pending');
  assert.equal(getRow(botId, dismissSeq).body.status, 'dismissed'); assert.equal(getRow(botId, dismissSeq).body.note, undefined);
  await assert.rejects(SignIn.actOnSignInCard(botId, dismissSeq, 'open', { local: true }), /already done/);
  await assert.rejects(SignIn.actOnSignInCard(botId, dismissSeq, 'dismiss', { local: true }), /already done/);
  const workingSeq = SignIn.showSignInCard(userId, botId, generation, 'gemini');
  await SignIn.actOnSignInCard(botId, workingSeq, 'open', { local: true });
  assert.equal(await SignIn.actOnSignInCard(botId, workingSeq, 'dismiss', { local: true }), 'working');
  assert.equal(getRow(botId, workingSeq).body.status, 'dismissed');
  await assert.rejects(SignIn.actOnSignInCard(botId, staleCall, 'dismiss', { local: true }), /Not a sign-in card/);
  const routeSeq = SignIn.showSignInCard(userId, botId, generation, 'gemini');
  await assert.rejects(SignIn.actOnSignInCard(botId, routeSeq, 'nope', { local: true }), /Unknown sign-in action/);
  SignIn.setSignInDeps();
  console.log('PASS Google sign-in: GoogleSignInRequired → one sign-in card; signed-in check resumes the bot; Copy command = resolved agy path; failed "I\'ve signed in" stays retryable; Dismiss closes the card for good');

  // ---------- 4b. the sign-in card route (POST /bots/:id/sign-in-cards/:seq) ----------
  const origin = 'http://127.0.0.1:8787';
  // The desktop app's own local session (dev login is off in desktop mode): a session row for the owner.
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run('qa-session', userId, now(), now() + 3_600_000);
  const cookie = 'marion_agent_session=qa-session';
  const post = (path, body, extra = {}) => featuresApi.request(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie, ...extra }, body: JSON.stringify(body) });
  const local = { origin };
  const cardPath = `/bots/${botId}/sign-in-cards/${routeSeq}`;
  assert.equal((await featuresApi.request(`${origin}${cardPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"dismiss"}' })).status, 401, 'signed-out: refused');
  assert.equal((await post(`/bots/bot_missing/sign-in-cards/${routeSeq}`, { action: 'dismiss' }, local)).status, 404);
  let response = await post(cardPath, {}, local);
  assert.equal(response.status, 400); assert.match((await response.json()).error, /Choose an action/);
  response = await post(cardPath, { action: 'open' });
  assert.equal(response.status, 400, 'no trusted origin: not a local action'); assert.match((await response.json()).error, /Sign in on the Mac/);
  const routeOpened = [];
  SignIn.setSignInDeps({ open: async (command) => { routeOpened.push(command); }, check: async () => { throw new Error('signed out'); } });
  response = await post(cardPath, { action: 'open' }, local);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, status: 'working' }); assert.equal(routeOpened.length, 1);
  response = await post(cardPath, { action: 'check' }, local);
  assert.equal(response.status, 400); assert.match((await response.json()).error, /still not signed in/);
  assert.equal(getRow(botId, routeSeq).body.status, 'working', 'route: a failed check stays retryable');
  response = await post(cardPath, { action: 'dismiss' });
  assert.equal(response.status, 200, 'dismiss works from any device'); assert.deepEqual(await response.json(), { ok: true, status: 'working' });
  assert.equal(getRow(botId, routeSeq).body.status, 'dismissed');
  response = await post(cardPath, { action: 'check' }, local);
  assert.equal(response.status, 400); assert.match((await response.json()).error, /already done/);
  response = await post(`/bots/${botId}/sign-in-cards/${staleCall}`, { action: 'dismiss' }, local);
  assert.equal(response.status, 400); assert.match((await response.json()).error, /Not a sign-in card/);
  SignIn.setSignInDeps();
  console.log('PASS sign-in card route: 401 signed out, 404 other bot, 400 no action / remote open / failed check (card stays working) / done card, 200 open + dismiss');

  // ---------- 5. Docker engine down → "start Colima", never the raw docker command ----------
  const v28 = Object.assign(new Error('Command failed: docker container inspect --format {{.State.Running}} marion-desktop-bot_x'), {
    stderr: Buffer.from('failed to connect to the docker API at unix:///Users/me/.colima/default/docker.sock; check if the path is correct and if the daemon is running: dial unix /Users/me/.colima/default/docker.sock: connect: no such file or directory') });
  const classic = Object.assign(new Error('Command failed'), { stderr: 'Cannot connect to the Docker daemon at unix:///Users/me/.colima/default/docker.sock. Is the docker daemon running?' });
  for (const failure of [v28, classic]) {
    const friendly = D.dockerFailure(failure);
    assert.ok(friendly instanceof D.DockerEngineDown); assert.match(friendly.message, /Start Colima/); assert.ok(D.isDockerEngineDown(friendly));
  }
  assert.match(D.dockerFailure(Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })).message, /Install Docker Desktop or Colima/);
  const other = Object.assign(new Error('Error: No such object: marion-desktop-bot_x'), { stderr: 'Error: No such object: marion-desktop-bot_x' });
  assert.equal(D.dockerFailure(other), other, 'other Docker errors pass through for the callers that read them');
  // Errors of commands run INSIDE the container (docker exec … curl) are never "Colima isn't running".
  for (const inner of ['curl: (7) Failed to connect to localhost port 8080 after 0 ms: Connection refused', 'cannot connect to X server :1',
    'psql: error: connection to server at "127.0.0.1", port 5432 failed: Connection refused', 'Error: connect ECONNREFUSED 127.0.0.1:3000']) {
    const failure = Object.assign(new Error('Command failed: docker exec -- marion-desktop-bot_x bash -c curl\n' + inner), { code: 7, stderr: Buffer.from(inner) });
    assert.equal(D.dockerFailure(failure), failure, inner); assert.ok(!D.isDockerEngineDown(D.dockerFailure(failure)));
  }
  for (const down of ['dial unix /Users/me/.colima/default/docker.sock: connect: connection refused',
    'error during connect: Get "http://%2F%2F.%2Fpipe%2Fdocker_engine/v1.47/info": open //./pipe/docker_engine: The system cannot find the file specified.'])
    assert.ok(D.dockerFailure(Object.assign(new Error('Command failed'), { stderr: down })) instanceof D.DockerEngineDown, down);
  const innerRun = await D.desktop.bash('bot_x', 'curl -sS http://localhost:8080');
  assert.equal(innerRun.exit_code, 7, 'the inner command\'s own exit code, not a Colima error'); assert.match(innerRun.output, /Connection refused/);
  await assert.rejects(D.desktop.running('bot_x'), (error) => /Colima isn’t running/.test(error.message) && /Start Colima/.test(error.message) && !/docker container inspect|docker\.sock/.test(error.message));
  console.log('PASS Docker/Colima down: friendly "start Colima" message instead of the raw docker container inspect error; inner docker exec errors (Connection refused) pass through');

  // ---------- 6. expected voice cancellations are not failures ----------
  const aborted = new AbortController(); aborted.abort();
  assert.ok(isExpectedAbort(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
  assert.ok(isExpectedAbort(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })));
  assert.ok(isExpectedAbort(new Error('helper exited 1'), aborted.signal), 'the request itself was cancelled');
  assert.ok(!isExpectedAbort(new Error('helper exited 1'), new AbortController().signal));
  assert.ok(!isExpectedAbort(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), 'timeouts are real failures');
  // An AbortError caused by AbortSignal.timeout() (cause: TimeoutError) is a timeout, not a cancellation.
  const timeout = AbortSignal.timeout(1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(timeout.reason.name, 'TimeoutError');
  assert.ok(!isExpectedAbort(Object.assign(new Error('This operation was aborted'), { name: 'AbortError', cause: timeout.reason })), 'AbortError with a TimeoutError cause');
  assert.ok(!isExpectedAbort(Object.assign(new Error('aborted'), { code: 'ABORT_ERR', cause: new DOMException('timed out', 'TimeoutError') })));
  assert.ok(!isExpectedAbort(new Error('helper exited 1'), timeout), 'a request signal that timed out is not an expected abort');
  let thrown; try { timeout.throwIfAborted(); } catch (error) { thrown = error; }
  assert.ok(thrown && !isExpectedAbort(thrown));
  const cancelled = new AbortController(); cancelled.abort();
  assert.ok(isExpectedAbort(Object.assign(new Error('aborted'), { name: 'AbortError', cause: cancelled.signal.reason })), 'a plain cancellation (cause AbortError) still is');
  const voiceSource = readFileSync(new URL('../server/src/voice.ts', import.meta.url), 'utf8');
  const macCatch = voiceSource.slice(voiceSource.indexOf('transcribeOnMac(file'), voiceSource.indexOf("console.warn('[voice] Mac dictation:'"));
  assert.match(macCatch, /if \(isExpectedAbort\(error, c\.req\.raw\.signal\)\) return/, 'Mac dictation returns before warning on an expected abort');
  console.log('PASS voice: AbortError / cancelled requests recognised as expected and returned before any warning; timeouts (AbortSignal.timeout) are not');
} finally {
  rmSync(bin, { recursive: true, force: true });
}
process.exit(0);
