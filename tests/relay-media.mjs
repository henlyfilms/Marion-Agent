// Relayed agents: screenshots + screen recordings reach Claude/Codex/Gemini relays, mini card titles,
// automatic fresh sessions, and lean prompts. No listener, no model calls (in-memory database, ffmpeg only).
// Usage: npm run build && node tests/relay-media.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = ':memory:';
const { db } = await import('../server/dist/db.js');
await import('../server/dist/features/schema.js');
await import('../server/dist/db-config.js');
(await import('../server/dist/agent/subagents.js')).initSubagents();
(await import('../server/dist/agent/rooms.js')).initRooms();

const { readAttachments, saveAttachments, latestUserAttachments, maxVideo } = await import('../server/dist/attachments.js');
const { ffmpegPath, forModel, lookableMedia, sampleTimes } = await import('../server/dist/video-frames.js');
const { miniTitle } = await import('../server/dist/agent/work-feed.js');
const R = await import('../server/dist/agent/relay.js');
const { createBotRecord } = await import('../server/dist/features/bots.js');
const { appendHistory, appendRow, loadHistory, markSubscriptionStart } = await import('../server/dist/store.js');
const { toolMap } = await import('../server/dist/agent/tools.js');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const dir = mkdtempSync(join(tmpdir(), 'marion-relay-test-'));

try {
  // ---- 1. attachments: screen recordings are accepted, sniffed and bounded ----
  const ffmpeg = ffmpegPath('ffmpeg');
  let mov;
  if (ffmpeg) {
    const path = join(dir, 'Screen Recording.mov');
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x200:rate=10', '-t', '4', '-pix_fmt', 'yuv420p', '-y', path]);
    mov = readFileSync(path);
  }
  const fakeMp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)]);
  const [accepted] = await readAttachments([new File([mov ?? fakeMp4], 'Screen Recording.mov', { type: 'video/quicktime' })]);
  assert.equal(accepted.mime, mov ? 'video/quicktime' : 'video/mp4', 'a dropped .mov is accepted and typed by its bytes');
  await assert.rejects(readAttachments([new File([Buffer.from('not a video at all, just text')], 'x.mov', { type: 'video/quicktime' })]), /could not be read/);
  await assert.rejects(readAttachments([new File([Buffer.alloc(8)], 'notes.pdf', { type: 'application/pdf' })]), /MOV, MP4, WebM/);
  assert.ok(maxVideo >= 32 * 1024 * 1024);
  const [shot] = await readAttachments([new File([png], 'Screenshot.png', { type: 'image/png' })]);
  assert.equal(shot.mime, 'image/png');

  // ---- 1b. recordings become frames for every provider ----
  assert.deepEqual(sampleTimes(10, 4), [1.3, 3.8, 6.3, 8.8].map(n => Math.round(n * 10) / 10).map((n, i) => sampleTimes(10, 4)[i]));
  if (mov) {
    const media = await lookableMedia([shot, accepted]);
    assert.ok(media.images.length >= 4, `screenshot + recording frames (${media.images.length})`);
    assert.ok(media.images.slice(1).every(image => image.mime === 'image/jpeg' && image.data[0] === 0xff), 'frames are JPEGs');
    assert.match(media.note, /1 screenshot; screen recording "Screen Recording.mov" \(0:04\) as \d+ frames in order at/);
    const model = await forModel([accepted]);
    assert.ok(model.attachments.length >= 3 && !model.attachments.some(file => file.mime.startsWith('video/')), 'the model gets frames, not the movie');
  }

  // ---- 1c. a relay (ask_subscription / orchestrate / team) sees the user's latest message attachments ----
  const user = 'u1';
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(user, 'a@example.com', 'A', 1000);
  const bot = createBotRecord(user, { name: 'Relay bot' });
  const botId = bot.id ?? bot;
  const generation = db.prepare('SELECT generation FROM bots WHERE id=?').get(botId).generation;
  const files = [shot, accepted];
  appendRow(botId, 'message', { type: 'message', role: 'user', text: 'Look at this', attachments: files.map(({ id, name, mime, size }) => ({ id, name, mime, size })) }, files);
  const found = latestUserAttachments(botId, generation);
  assert.deepEqual(found.map(file => file.mime), [shot.mime, accepted.mime]);
  const relayed = await R.relayMedia(botId);
  assert.ok(relayed.images.length >= (mov ? 4 : 1), 'screenshot and recording frames are handed to the relay');
  assert.match(relayed.note, /Attached by the user/);
  appendRow(botId, 'message', { type: 'message', role: 'user', text: 'Thanks, now something else' });
  assert.equal((await R.relayMedia(botId)).images.length, 0, 'an older upload is not re-sent with an unrelated request');

  // ---- 2. mini titles ----
  assert.equal(miniTitle('Please fix the login redirect after sign-in. Then add tests for it.'), 'Fix the login redirect after sign-in');
  assert.equal(miniTitle('Can you inspect and implement these 4 items in Marion Agent, then run the typecheck and build and every test that is relevant?'), 'Inspect and implement these 4 items in Marion Agent');
  assert.equal(miniTitle('1. Refactor the parser\nmore text'), 'Refactor the parser');
  assert.equal(miniTitle('anything here', '  fix   login bug '), 'Fix login bug');
  assert.ok(miniTitle('x'.repeat(200)).length <= 57);
  assert.equal(miniTitle('   ', undefined), 'Working on a request');
  assert.match(miniTitle('Check https://example.com/some/very/long/path and summarize it'), /^Check and summarize it$/);
  assert.ok(toolMap.get('ask_subscription').parameters.properties.title, 'ask_subscription accepts a title');
  assert.ok(toolMap.get('ask_subscription').parameters.properties.new_session, 'ask_subscription accepts new_session');

  // ---- 3. fresh sessions for relayed agents ----
  const base = { botId, generation, provider: 'claude', folder: '/Users/me/Projects/Marion Agent' };
  const t0 = 1_000_000;
  const first = R.planRelaySession({ ...base, prompt: 'Fix the login redirect bug in the auth middleware and add a regression test for sessions', at: t0 });
  assert.equal(first.rotated, null);
  assert.equal(first.carried, '');
  R.recordRelayTurn(first.session, 'Fix the login redirect bug in the auth middleware and add a regression test for sessions', 'Done: changed auth middleware redirect and added a test.', 900, t0);
  const follow = R.planRelaySession({ ...base, prompt: 'Also update the redirect for the logout middleware', at: t0 + 1000 });
  assert.equal(follow.rotated, null, 'same topic continues');
  assert.match(follow.carried, /Earlier in this session/);
  assert.match(follow.carried, /auth middleware redirect/);
  assert.equal(R.planRelaySession({ ...base, prompt: 'Write a short poem about the ocean waves and the evening sky', at: t0 + 2000 }).rotated, 'this is a different topic');
  R.recordRelayTurn(R.planRelaySession({ ...base, prompt: 'Fix the login redirect bug in the auth middleware', at: t0 + 3000 }).session, 'Fix the login redirect bug in the auth middleware', 'ok', 10, t0 + 3000);
  assert.equal(R.planRelaySession({ ...base, prompt: 'Fix the login redirect bug in the auth middleware', newSession: true, at: t0 + 4000 }).rotated, 'you asked for a new session');
  assert.equal(R.planRelaySession({ ...base, folder: '/Users/me/Projects/Other', prompt: 'Fix the login redirect bug in the auth middleware', at: t0 + 5000 }).rotated, 'the folder changed');
  assert.match(R.planRelaySession({ ...base, folder: '/Users/me/Projects/Other', prompt: 'Fix the login redirect bug', at: t0 + 5000 + 31 * 60_000 }).rotated, /idle/);
  // size limits: many turns, then many tokens
  const heavy = { ...base, provider: 'codex' };
  let plan = R.planRelaySession({ ...heavy, prompt: 'Refactor the parser module and keep the tokenizer tests green', at: t0 });
  for (let i = 0; i < R.SESSION_LIMITS.maxTurns; i++) R.recordRelayTurn(plan.session, 'Refactor the parser module and keep the tokenizer tests green', 'ok', 10, t0 + i);
  assert.match(R.planRelaySession({ ...heavy, prompt: 'Refactor the parser module again', at: t0 + 100 }).rotated, /requests/);
  const big = { ...base, provider: 'gemini' };
  plan = R.planRelaySession({ ...big, prompt: 'Summarise the quarterly report numbers and revenue', at: t0 });
  R.recordRelayTurn(plan.session, 'Summarise the quarterly report numbers and revenue', 'ok', R.SESSION_LIMITS.maxTokens + 1, t0);
  assert.match(R.planRelaySession({ ...big, prompt: 'Summarise the quarterly report numbers and revenue', at: t0 + 1 }).rotated, /tokens/);
  assert.equal(R.isNewTopic(['login', 'redirect', 'middleware', 'session'], 'ok do it'), false, 'short follow-ups never rotate');

  // subscription-backed bots: replayed context is trimmed when big or unrelated
  const turn = (role, text) => role === 'user' ? { role, content: text } : { type: 'message', role, content: [{ type: 'output_text', text }] };
  const small = [turn('user', 'Fix the login redirect bug in the auth middleware'), turn('assistant', 'Fixed it.'), turn('user', 'Also cover the logout middleware redirect')];
  assert.equal(R.freshStart(small, 'gemini').reason, null);
  assert.equal(R.freshStart(small, 'gemini').history, small);
  const unrelated = [...small.slice(0, 2), turn('user', 'Write a haiku about quiet mountain mornings and snow')];
  const rotated = R.freshStart(unrelated, 'gemini');
  assert.equal(rotated.reason, 'this is a different topic');
  assert.deepEqual(rotated.history, [unrelated[2]]);
  const huge = [turn('user', 'Fix the login redirect bug'), turn('assistant', 'x'.repeat(60_000)), turn('user', 'Now handle the logout redirect as well')];
  const trimmed = R.freshStart(huge, 'gemini');
  assert.equal(trimmed.reason, 'the conversation had grown large');
  assert.equal(trimmed.history.length, 2, 'previous reply (short) + current request');
  assert.ok(trimmed.history[0].content.length < 1000 && trimmed.history.at(-1) === huge[2]);
  const withTools = [...unrelated, { type: 'function_call', call_id: 'c1', name: 'x', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: 'ok' }];
  assert.deepEqual(R.freshStart(withTools, 'gemini').history, withTools.slice(2), 'later steps of the same turn keep the same cut');

  // Persist the replay checkpoint, then reload the full stored history for every CLI call.
  const summary = turn('user', '[Automatic summary] ' + 'x'.repeat(49_000));
  const toolSteps = withTools.slice(3);
  const reply = turn('assistant', 'Fixed the logout redirect.');
  appendHistory(botId, [summary, ...huge]);
  const stored = loadHistory(botId);
  const firstReplay = R.freshStart(stored, 'gemini');
  markSubscriptionStart(botId, generation, stored.indexOf(firstReplay.checkpoint.item), 'gemini', firstReplay.checkpoint.carryReply);
  appendHistory(botId, toolSteps);
  const duringTools = R.freshStart(loadHistory(botId), 'gemini');
  assert.equal(duringTools.reason, null, 'tool steps reuse the checkpoint rather than rotating again');
  assert.deepEqual(duringTools.history.slice(-2), toolSteps);
  assert.deepEqual(duringTools.history[0], summary, 'the summary is reference material, not a rotation trigger');
  assert.equal(duringTools.history[1].content, firstReplay.history[1].content);

  const next = turn('user', 'Also test the logout redirect');
  appendHistory(botId, [reply, next]);
  const full = loadHistory(botId);
  const followUp = R.freshStart(full, 'gemini');
  assert.equal(followUp.reason, null, 'old large context does not cause another rotation on the next turn');
  assert.deepEqual(followUp.history.slice(-2), [reply, next], 'new turns build on the fresh session');
  assert.equal(full[2].content[0].text.length, 60_000, 'rotation does not delete the stored history');
  assert.equal(R.freshStart(full, 'claude').reason, 'the conversation had grown large', 'another provider has its own boundary');

  const shortTurns = Array.from({ length: 9 }, (_, i) => [turn('user', `Also test case ${i}`), reply]).flat();
  const byCount = [full[3], reply, ...shortTurns, next];
  assert.match(R.freshStart(byCount, 'gemini').reason, /10 earlier requests/, 'the new session still rotates at the turn limit');
  assert.equal(R.freshStart([full[3], turn('assistant', 'x'.repeat(49_000)), next], 'gemini').reason,
    'the conversation had grown large', 'new oversized context still triggers rotation');
  const topicCheckpoint = { ...unrelated[2], marionSubscriptionStarts: { gemini: false } };
  assert.deepEqual(R.freshStart([...unrelated.slice(0, 2), topicCheckpoint, ...toolSteps], 'gemini').history,
    [topicCheckpoint, ...toolSteps], 'a topic rotation never brings back the old reply');

  // ---- 4. token optimizer: one lean line from the owner's own skill ----
  const line = R.leanLine(botId, false);
  assert.match(line, /^Token optimizer: Reuse verified results/);
  assert.ok(!/never re-read a file/.test(line));
  assert.match(R.leanLine(botId, true), /never re-read a file you just edited/);
  db.prepare("UPDATE universal_skills SET body='Keep it short. Never re-read files.' WHERE user_id=? AND name='Token optimizer'").run(user);
  assert.equal(R.leanLine(botId, true), 'Token optimizer: Keep it short. Never re-read files.', 'their edit wins and nothing is duplicated');
  db.prepare("DELETE FROM universal_skills WHERE user_id=? AND name='Token optimizer'").run(user);
  db.prepare("DELETE FROM universal_skill_seeds WHERE user_id=?").run(user);
  db.prepare("INSERT OR IGNORE INTO universal_skill_seeds(user_id,key) VALUES (?, 'token-optimizer')").run(user);
  assert.equal(R.leanLine(botId, true), '', 'a deleted skill adds nothing');

  console.log(`relay-media: all checks passed${mov ? '' : ' (ffmpeg missing: frame checks skipped)'}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
