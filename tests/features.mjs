// End-to-end checks for templates, bot coordination, attachments, teaching, context and compaction,
// notifications, web push encryption and the Marion Life link. Runs the built server on a disposable
// database against a scripted fake model and a fake Marion Life API. Usage: npm run build && node tests/features.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
const pass = (name) => { results.push(name); console.log(`PASS ${name}`); };

// ---------- fake model ----------
const calls = [];
const text = (content) => typeof content === 'string' ? content : Array.isArray(content) ? content.map(p => p.text ?? '').join('\n') : '';
const lastUser = (input) => [...input].reverse().find(item => item.role === 'user');
function decide(request) {
  const system = text(request.input[0]?.content);
  const last = request.input.at(-1);
  const user = text(lastUser(request.input)?.content);
  const who = /^You are ([^,]+), a Bot/.exec(system)?.[1] ?? 'background';
  calls.push({ who, request });
  const say = (t) => ({ type: 'message', id: 'm' + calls.length, role: 'assistant', content: [{ type: 'output_text', text: t, annotations: [] }] });
  const call = (name, args) => ({ type: 'function_call', id: 'fc' + calls.length, call_id: 'call' + calls.length, name, arguments: JSON.stringify(args) });
  if (who === 'background') {
    if (system.includes('You compress')) return say('- Summary: the user and the bot talked about numbers.');
    if (system.includes('improve itself')) return say('{"lessons":["When the user asks for a number, answer with digits."],"skills":[]}');
    return say('{"memories":[]}');
  }
  if (who === 'Chief') {
    if (last.type === 'function_call_output') return say('Asked Worker, waiting for the answer.');
    if (user.includes('[Reply from Worker')) return say('Worker says the number is 42.');
    return call('send_to_bot', { bot_name: 'Worker', message: 'What is the number?' });
  }
  if (who === 'Worker') return say('The number is 42.');
  if (who === 'Boss') {
    if (last.type === 'function_call_output') return say('Asked Asker.');
    if (user.includes('[Reply from Asker')) return say('Asker is waiting on the user.');
    return call('send_to_bot', { bot_name: 'Asker', message: 'Which account should I use?' });
  }
  if (who === 'Asker') return call('ask_user', { question: 'Personal or work account?', options: ['Personal', 'Work'] });
  if (who === 'Builder') {
    if (last.type === 'function_call_output') return say('Created Helper.');
    return call('create_bot', { name: 'Helper', job: 'Helps', description: 'Helps.', instructions: 'Help.', avatar_color: 'green', avatar_shape: 'blueberry', executive: false, integrations: [], memories: [], skills: [], routines: [{ name: 'Hourly', prompt: 'ping', schedule: '0 * * * *', timezone: 'UTC', enabled: true }] });
  }
  if (who === 'Pinger' || who === 'Ponger') {
    if (last.type === 'function_call_output') return say('ok');
    return call('send_to_bot', { bot_name: who === 'Pinger' ? 'Ponger' : 'Pinger', message: `ping from ${who} #${calls.length}` });
  }
  if (who === 'Viewer') {
    const images = lastUser(request.input)?.content?.filter?.(p => p.type === 'input_image').length ?? 0;
    return say(`I see ${images} image(s). ${user.includes('teach-notes') ? 'Lesson noted.' : ''}${user.includes('hello-from-file') ? ' File read.' : ''}`);
  }
  return say('Hello.');
}
const fakeModel = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString());
  const item = decide(request);
  if (request.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (item.type === 'message') {
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: item.content[0].text })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'response.output_item.done', item })}\n\n`);
    }
    res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [item], usage: { input_tokens: 1234 } } })}\n\n`);
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'r', object: 'response', output: [item], output_text: item.content?.[0]?.text ?? '' }));
  }
});

// ---------- fake Marion Life API ----------
const lifeRows = new Map();
const LIFE_KEY = 'mb_test_marion_life_key';
const LIFE_EMAIL = 'owner@example.com';
const fakeLife = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (req.method !== 'POST' || req.url !== '/api/mcp') { res.writeHead(404).end(); return; }
  if (req.headers.authorization !== `Bearer ${LIFE_KEY}`) { res.writeHead(401).end('{}'); return; }

  const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString());
  const reply = { jsonrpc: '2.0', id };
  if (method === 'tools/call' && params.name === 'whoami') {
    reply.result = { structuredContent: { ok: true, email: LIFE_EMAIL } };
  } else if (method === 'tools/call' && params.name === 'save_agent_chats') {
    for (const chat of params.arguments.chats) lifeRows.set(chat.id, chat);
    reply.result = { structuredContent: { ok: true } };
  } else {
    reply.error = { code: -32601, message: 'Unknown tool' };
  }
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
});

await Promise.all([fakeModel, fakeLife].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
const workDir = await mkdtemp(join(tmpdir(), 'marion-features-'));
const port = process.env.MARION_TEST_PORT ?? '8796';
const app = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: new URL('../server/', import.meta.url),
  env: {
    ...process.env, DB_PATH: join(workDir, 'features.db'), PORT: port, HOST: '127.0.0.1', APP_URL: app, SERVER_URL: app,
    DEV_LOGIN: '1', MARION_NO_SCHEDULER: '1', XAI_API_KEY: '', COMPOSIO_API_KEY: '', MARION_DESKTOP_TOKEN: '',
    MARION_LOCAL_MODEL_URL: `http://127.0.0.1:${fakeModel.address().port}/v1`, MARION_LOCAL_MODEL: 'fake-model',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const stopped = once(child, 'exit');
const waitFor = async (check, message, tries = 100) => {
  for (let i = 0; i < tries; i++) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(message);
};

try {
  await waitFor(async () => (await fetch(app + '/api/health').catch(() => null))?.ok, 'server never started');
  const login = await fetch(app + '/api/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'features@example.com' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const json = { cookie, 'Content-Type': 'application/json' };
  const api = async (method, path, body) => {
    const response = await fetch(app + '/api' + path, { method, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, ...data };
  };
  const createBot = async (name, extra = {}) => (await api('POST', '/bots', { name, ...extra })).bot;
  const rows = async (id) => (await api('GET', `/bots/${id}/rows`)).rows;
  const messages = async (id) => (await rows(id)).filter(r => r.kind === 'message').map(r => r.body);
  const sendText = (id, t) => api('POST', `/bots/${id}/messages`, { text: t });

  // Sign-in routes stay public even though the feature routes require a user.
  assert.equal((await fetch(app + '/api/auth/me')).status, 200);
  assert.equal((await fetch(app + '/api/templates')).status, 401);
  pass('feature routes require sign-in without blocking the sign-in routes');

  // Templates: list, import (with skills, memories and paused routines), profile, export → import.
  const { templates } = await api('GET', '/templates');
  assert.ok(templates.some(t => t.id === 'bot-builder') && templates.some(t => t.id === 'executive'));
  const imported = await api('POST', '/templates/executive/import', {});
  assert.equal(imported.bot.role, 'executive');
  const profile = (await api('GET', `/bots/${imported.bot.id}/profile`)).profile;
  assert.ok(profile.skills.length >= 2 && profile.memories.length >= 1 && profile.routines.length === 1 && profile.routines[0].enabled === false);
  const second = await api('POST', '/templates/executive/import', {});
  assert.equal(second.bot.name, 'Executive 2');
  const exported = await fetch(`${app}/api/bots/${imported.bot.id}/export`, { headers: json }).then(r => r.json());
  assert.equal(exported.format, 'marion-agent-bot@1');
  const copy = await api('POST', '/bots/import', { ...exported, name: 'Exec copy' });
  assert.equal((await api('GET', `/bots/${copy.bot.id}/profile`)).profile.skills.length, profile.skills.length);
  assert.equal((await api('POST', '/bots/import', { name: 'x' })).status, 400);
  pass('templates import with skills, memories and paused routines; bots export and re-import');

  // Executive → worker delegation with an automatic reply back.
  const chief = await createBot('Chief', { role: 'executive' });
  assert.equal(chief.role, 'executive');
  const worker = await createBot('Worker');
  await sendText(chief.id, 'Find out the number from Worker.');
  await waitFor(async () => (await messages(chief.id)).some(m => m.text === 'Worker says the number is 42.'), 'executive never got the worker reply', 150);
  const workerInbox = (await messages(worker.id)).filter(m => m.role === 'user');
  assert.equal(workerInbox.length, 1, 'worker should get exactly one request');
  assert.equal(workerInbox[0].from?.name, 'Chief');
  const chiefSystem = calls.find(c => c.who === 'Chief').request.input[0].content;
  assert.match(chiefSystem, /You are the executive/);
  assert.ok(calls.find(c => c.who === 'Chief').request.tools.some(t => t.name === 'list_team'));
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(calls.filter(c => c.who === 'Worker').length, 1, 'the auto-reply must not trigger another worker turn');
  pass('executive delegates, the worker answers once and the reply routes back automatically');

  // A bot that answers another bot with a question for the user still tells the asker it is waiting.
  const boss = await createBot('Boss');
  await createBot('Asker');
  await sendText(boss.id, 'Get the account.');
  await waitFor(async () => (await messages(boss.id)).some(m => m.text === 'Asker is waiting on the user.'), 'asker never told the boss it was waiting');
  const note = (await messages(boss.id)).find(m => m.from?.name === 'Asker');
  assert.match(note.text, /Personal or work account\?/);
  pass('a delegated bot that needs the user tells the asking bot instead of going silent');

  // Bots created by a bot get paused routines.
  const builder = await createBot('Builder');
  await sendText(builder.id, 'Make me a helper.');
  const helper = await waitFor(async () => (await api('GET', '/bots')).bots.find(b => b.name === 'Helper'), 'create_bot did not create the bot');
  assert.equal((await api('GET', `/bots/${helper.id}/profile`)).profile.routines[0].enabled, false);
  pass('create_bot creates the bot with its routines paused');

  // Two bots that keep messaging each other must stop on their own.
  const pinger = await createBot('Pinger');
  await createBot('Ponger');
  const before = calls.length;
  await sendText(pinger.id, 'start');
  await new Promise(resolve => setTimeout(resolve, 4000));
  const loopCalls = calls.length - before;
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(calls.length - before, loopCalls, 'the bot loop kept running');
  assert.ok(loopCalls < 40, `too many model calls in a bot loop: ${loopCalls}`);
  pass(`a runaway two-bot loop stops by itself (${loopCalls} model calls)`);

  // Photos and text files reach the model.
  const viewer = await createBot('Viewer');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  const form = new FormData();
  form.append('text', 'What is attached?');
  form.append('attachments', new Blob([png], { type: 'image/png' }), 'dot.png');
  form.append('attachments', new Blob(['hello-from-file '.repeat(3000)], { type: 'text/plain' }), 'notes.txt');
  const sent = await fetch(`${app}/api/bots/${viewer.id}/messages`, { method: 'POST', headers: { cookie, origin: app }, body: form });
  assert.equal(sent.status, 200, await sent.clone().text());
  await waitFor(async () => (await messages(viewer.id)).some(m => m.role === 'assistant' && m.text.startsWith('I see 1 image(s).') && m.text.includes('File read.')), 'photo + 48 KB text file were not delivered');
  const bad = new FormData();
  bad.append('attachments', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'doc.pdf');
  assert.equal((await fetch(`${app}/api/bots/${viewer.id}/messages`, { method: 'POST', headers: { cookie, origin: app }, body: bad })).status, 400);
  pass('photos and text files over the old 32 KB limit reach the model; unsupported files are refused clearly');

  // Teach by screen recording: frames arrive as images with the narration.
  const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
  const lesson = new FormData();
  lesson.append('title', 'Export invoices');
  lesson.append('narration', 'teach-notes: open the billing page then click export');
  lesson.append('seconds', '42');
  for (let i = 0; i < 3; i++) lesson.append('frames', new Blob([jpeg], { type: 'image/jpeg' }), `f${i}.jpg`);
  const taught = await fetch(`${app}/api/bots/${viewer.id}/teach`, { method: 'POST', headers: { cookie, origin: app }, body: lesson });
  assert.equal(taught.status, 200, await taught.clone().text());
  await waitFor(async () => (await messages(viewer.id)).some(m => m.role === 'assistant' && m.text.includes('I see 3 image(s). Lesson noted.')), 'lesson frames were not delivered');
  const lessonRow = (await messages(viewer.id)).find(m => m.text.startsWith('🎬 Lesson: Export invoices'));
  assert.equal(lessonRow.attachments.length, 3);
  const teachPrompt = text(lastUser(calls.filter(c => c.who === 'Viewer').at(-1).request.input).content);
  assert.match(teachPrompt, /save_skill/);
  pass('screen-recording lessons send their key frames and narration and ask the bot to save a skill');

  // Context size is tracked per chat, and compaction shrinks it.
  const viewerBot = (await api('GET', '/bots')).bots.find(b => b.id === viewer.id);
  assert.ok(viewerBot.contextTokens > 0, 'context tokens were not recorded');
  for (let i = 0; i < 4; i++) {
    await sendText(viewer.id, `message ${i}`);
    await waitFor(async () => (await messages(viewer.id)).filter(m => m.role === 'assistant').length >= 3 + i, 'reply missing');
  }
  const context = await api('GET', `/bots/${viewer.id}/context`);
  assert.equal(context.limit, 1_000_000);
  const compacted = await api('POST', `/bots/${viewer.id}/context/compact`);
  assert.equal(compacted.status, 200, JSON.stringify(compacted));
  assert.ok(compacted.itemsAfter < compacted.itemsBefore);
  const setAuto = await api('PATCH', `/bots/${viewer.id}`, { compactAtTokens: 50_000 });
  assert.equal(setAuto.bot.compactAtTokens, 50_000);
  assert.equal((await api('PATCH', `/bots/${viewer.id}`, { compactAtTokens: -5 })).status, 400);
  await api('POST', `/bots/${worker.id}/fresh`);
  assert.equal((await api('GET', '/bots')).bots.find(b => b.id === worker.id).contextTokens, null, 'Start fresh must reset the context size');
  pass('context is tracked per chat (0–1M), manual compaction works, auto-compact size is saved and validated, Start fresh resets it');

  // Self-improvement: lessons land in the "Lessons learned" skill.
  const improved = await api('POST', `/bots/${viewer.id}/improve`);
  assert.equal(improved.lessons, 1, JSON.stringify(improved));
  const skills = (await api('GET', `/bots/${viewer.id}/profile`)).profile.skills;
  assert.ok(skills.some(s => s.name === 'Lessons learned' && s.body.includes('digits')));
  assert.equal((await api('POST', `/bots/${viewer.id}/improve`)).lessons, 0, 'duplicate lessons must be skipped');
  pass('self-improvement writes de-duplicated lessons into a skill');

  // Notifications: settings and devices.
  const notif = await api('GET', '/notifications');
  assert.ok(notif.publicKey.length > 80);
  const saved = await api('PUT', '/notifications', { events: { 'bot-message': true }, quietStart: '22:00', quietEnd: '07:00', previews: false });
  assert.equal(saved.settings.events['bot-message'], true);
  assert.equal(saved.settings.quietStart, '22:00');
  assert.equal((await api('PUT', '/notifications', { quietStart: '25:99' })).settings.quietStart, '22:00');
  assert.equal((await api('POST', '/notifications/devices', { endpoint: 'http://insecure.example/push', keys: { p256dh: 'x', auth: 'y' } })).status, 400);
  pass('notification settings save and validate; insecure push addresses are refused');

  // Web push payload encryption decrypts with the subscriber's keys (RFC 8291).
  const { encryptPayload } = await import('../server/dist/features/webpush.js');
  const client = createECDH('prime256v1');
  client.generateKeys();
  const authSecret = randomBytes(16);
  const body = encryptPayload(client.getPublicKey().toString('base64url'), authSecret.toString('base64url'), Buffer.from('{"title":"hi"}'));
  const salt = body.subarray(0, 16);
  const keyLength = body.readUInt8(20);
  const serverPublic = body.subarray(21, 21 + keyLength);
  const ciphertext = body.subarray(21 + keyLength);
  const shared = client.computeSecret(serverPublic);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), client.getPublicKey(), serverPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  assert.equal(plain.subarray(0, -1).toString(), '{"title":"hi"}');
  assert.equal(plain.at(-1), 2);
  pass('web push payloads decrypt with the device keys (iPhone push format)');

  // Marion Life checks the link key and copies completed chats.
  const endpoint = `http://127.0.0.1:${fakeLife.address().port}/api/mcp`;
  assert.equal((await api('PUT', '/life-link', { endpoint, linkKey: 'mb_invalid_test_link_key' })).status, 400);
  const linked = await api('PUT', '/life-link', { endpoint, linkKey: LIFE_KEY });
  assert.equal(linked.status, 200, JSON.stringify(linked));
  assert.equal(linked.settings.lifeEmail, LIFE_EMAIL);
  await waitFor(async () => (await api('GET', '/life-link')).settings.lastSyncAt, 'initial Marion Life sync');
  const synced = await api('POST', '/life-link/sync');
  assert.equal(synced.status, 200, JSON.stringify(synced));
  const chiefChat = lifeRows.get(`${chief.id}:1`);
  assert.ok(chiefChat, 'the executive chat was not copied');
  assert.equal(chiefChat.marion_bot_id, chief.id);
  assert.match(chiefChat.transcript, /Worker says the number is 42\./);
  assert.equal(chiefChat.title, 'Find out the number from Worker.');
  const linkState = await api('GET', '/life-link');
  assert.equal(linkState.hasKey, true);
  assert.equal(JSON.stringify(linkState).includes(LIFE_KEY), false, 'the Marion Life key must never be sent back');
  pass(`Marion Life link copies chats (${lifeRows.size}) and never returns the key`);

  console.log(`\n${results.length} feature checks passed.`);
} finally {
  child.kill();
  await stopped;
  await Promise.all([fakeModel, fakeLife].map(server => new Promise(resolve => server.close(resolve))));
  await rm(workDir, { recursive: true, force: true });
}
