// Bot-to-bot images: send_to_bot / post_to_group `attach` (user_images, screenshot, /workspace/files/<bot-id>/ paths),
// stored per receiving chat, delivered to the model as input_image, forwarded across hops, shared in group chats, and validated.
// Also: a real runTurn forwards the images of the message it is handling even when a later text-only message is newest.
// No listener, no Docker, no real model (in-memory database, stubbed desktop, stubbed local model endpoint).
// Usage: npm run build && node tests/bot-images.mjs
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.MARION_NO_SCHEDULER = '1';
process.env.XAI_API_KEY = '';
process.env.MARION_LOCAL_MODEL_URL = 'http://127.0.0.1:9/v1';
process.env.MARION_LOCAL_MODEL_API_KEY = '';
process.env.MARION_LOCAL_MODEL = 'fake';

// ---- a stubbed local model: `modelTurn` decides each reply (a function call or text) from the request body ----
let modelTurn = () => ({ text: 'ok' });
const toolOutputs = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url instanceof Request ? url.url : url);
  if (!href.startsWith('http://127.0.0.1:9/v1')) return realFetch(url, init);
  if (href.includes('/models')) return new Response(JSON.stringify({ data: [{ id: 'fake' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const body = JSON.parse(String(init.body));
  const input = body.input ?? [];
  const last = input.at(-1);
  if (last?.type === 'function_call_output') toolOutputs.push(String(typeof last.output === 'string' ? last.output : JSON.stringify(last.output)));
  const next = modelTurn(input);
  const item = next.call
    ? { type: 'function_call', id: `fc_${toolOutputs.length}_${Date.now()}`, call_id: `call_${Math.random().toString(36).slice(2)}`, name: next.call.name, arguments: JSON.stringify(next.call.arguments), status: 'completed' }
    : { type: 'message', id: `msg_${Date.now()}`, role: 'assistant', content: [{ type: 'output_text', text: next.text, annotations: [] }] };
  const events = [...(next.call ? [] : [{ type: 'response.output_text.delta', delta: next.text }]), { type: 'response.output_item.done', item }, { type: 'response.completed', response: { output: [item] } }];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};
const { db } = await import('../server/dist/db.js');
await import('../server/dist/features/schema.js');
await import('../server/dist/db-config.js');
(await import('../server/dist/agent/subagents.js')).initSubagents();
const rooms = await import('../server/dist/agent/rooms.js');
rooms.initRooms();

const { MAX_ATTACHMENTS, latestUserAttachments } = await import('../server/dist/attachments.js');
const { relayMedia } = await import('../server/dist/agent/relay.js');
const { createBotRecord } = await import('../server/dist/features/bots.js');
const { appendRow } = await import('../server/dist/store.js');
const { toolMap, collectBotAttachments, ATTACH_DESCRIPTION } = await import('../server/dist/agent/tools.js');
const loop = await import('../server/dist/agent/loop.js');
const { botMessageTrigger, triggerItem, compactTools, triggerAttachmentsOf } = loop;
const { desktop, DockerEngineDown } = await import('../server/dist/desktop.js');
const { attachPromptLine } = await import('../server/dist/agent/prompt.js');
const { DEFAULT_UNIVERSAL_SKILLS } = await import('../server/dist/features/universal-skills.js');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7)]);

// ---- a stubbed computer: every bot's desktop is awake, screenshots are a JPEG, files come from this map ----
const files = new Map();
const downloads = [];
let screenshots = 0;
desktop.running = async () => true;
desktop.screenshot = async () => { screenshots++; return { image: jpeg.toString('base64'), mime_type: 'image/jpeg', width: 1280, height: 800 }; };
/** What child_process.execFile rejects with when the copy script inside the container exits non-zero (a missing file). */
const missingFile = (path) => Object.assign(new Error(`Command failed: docker exec -- marion-desktop bash -c ... ${path}`), { code: 1, stderr: Buffer.from(`realpath: ${path}: No such file or directory\n`) });
const realDownload = async (id, path) => {
  downloads.push({ id, path });
  if (!path.startsWith(`/workspace/files/${id}/`) || !files.has(path)) throw missingFile(path);
  return files.get(path);
};
desktop.download = realDownload;

const user = 'u1';
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(user, 'a@example.com', 'A', 1000);
const idOf = (bot) => bot.id ?? bot;
const A = idOf(createBotRecord(user, { name: 'Alpha' }));
const B = idOf(createBotRecord(user, { name: 'Bravo' }));
const C = idOf(createBotRecord(user, { name: 'Charlie' }));
const generation = (botId) => db.prepare('SELECT generation FROM bots WHERE id=?').get(botId).generation;
const savedFor = (botId) => db.prepare('SELECT id, seq, name, mime, data FROM message_attachments WHERE bot_id=? ORDER BY rowid').all(botId);
const lastMessage = (botId) => JSON.parse(db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='message' ORDER BY seq DESC LIMIT 1").get(botId).body);
const lastSeq = (botId) => db.prepare("SELECT seq FROM rows WHERE bot_id=? AND kind='message' ORDER BY seq DESC LIMIT 1").get(botId).seq;

/** A ToolCtx whose enqueueBotMessage saves the message for real and keeps the trigger instead of running a model turn. */
const sent = [];
const ctxFor = (botId, extra = {}) => ({
  userId: user, botId, depth: 0, messaged: new Set(),
  enqueueBotMessage: (from, to, text, depth, opts = {}) => {
    const name = db.prepare('SELECT name FROM bots WHERE id=?').get(from).name;
    sent.push({ to, trigger: botMessageTrigger(from, name, to, text, depth, opts) });
  },
  ...extra,
});
const sendToBot = toolMap.get('send_to_bot');
const postToGroup = toolMap.get('post_to_group');

// ---- 0. the tools accept attach ----
for (const tool of [sendToBot, postToGroup]) {
  assert.equal(tool.parameters.properties.attach.type, 'array', `${tool.name} has attach`);
  assert.ok(!tool.parameters.required.includes('attach'), `${tool.name} attach is optional`);
  assert.match(tool.parameters.properties.attach.description, /user_images.*screenshot.*\/workspace\/files\/<bot-id>\//s);
  // Subscription-backed bots see argument descriptions cut at 160 characters: every option, including the path, must survive.
  assert.ok(tool.parameters.properties.attach.description.length <= 160, `${tool.name} attach description fits in 160 chars`);
  assert.match(compactTools([tool]), /attach\?: string\[\] \(Images to send: "user_images".*"screenshot".*\/workspace\/files\/<bot-id>\/.*max 4 MB\)\.\)/);
}
assert.equal(ATTACH_DESCRIPTION, sendToBot.parameters.properties.attach.description);
// The prompts (full system prompt and subscription prompt share this line) name the bot's own concrete folder.
assert.match(attachPromptLine(A), new RegExp(`"user_images".*"screenshot".*/workspace/files/${A}/ \\(PNG`));
const guide = DEFAULT_UNIVERSAL_SKILLS.find(skill => skill.key === 'marion-agent-guide').body;
assert.doesNotMatch(guide, /attach on to/);
assert.match(guide, /Share images by adding attach to send_to_bot or post_to_group/);

// ---- 1. A forwards the user's image + a screenshot + a saved file to B: stored in B's chat with fresh ids ----
const userPhoto = { id: 'att_user_photo', name: 'diagram.png', mime: 'image/png', size: png.length, data: png };
const userNote = { id: 'att_user_note', name: 'notes.txt', mime: 'text/plain', size: 5, data: Buffer.from('hello') };
appendRow(A, 'message', { type: 'message', role: 'user', text: 'Send this to Bravo', attachments: [userPhoto, userNote].map(({ data, ...m }) => m) }, [userPhoto, userNote]);
files.set(`/workspace/files/${A}/chart.png`, png);

const out = await sendToBot.impl({ bot_name: 'Bravo', message: 'Please review these', attach: ['user_images', 'screenshot', `/workspace/files/${A}/chart.png`] }, ctxFor(A));
assert.match(out.output, /^Sent to Bravo with 3 images\./, out.output);
assert.equal(sent.length, 1);
const toB = lastMessage(B);
assert.equal(toB.role, 'user');
assert.deepEqual(toB.from, { kind: 'bot', id: A, name: 'Alpha' });
assert.equal(toB.text, 'Please review these');
assert.deepEqual(toB.attachments.map(f => f.mime), ['image/png', 'image/jpeg', 'image/png'], 'only images, in order (the text file is not an image)');
assert.deepEqual(toB.attachments.map(f => f.name).filter(n => !n.startsWith('screenshot-')), ['diagram.png', 'chart.png']);
assert.ok(toB.attachments.every(f => !('data' in f) && f.size > 0), 'message metadata has no bytes');
const savedB = savedFor(B);
assert.equal(savedB.length, 3, 'three message_attachments rows for Bravo');
assert.ok(savedB.every(row => row.seq === lastSeq(B)), 'saved on the message row');
assert.deepEqual(savedB.map(row => row.id), toB.attachments.map(f => f.id));
assert.ok(savedB.every(row => row.id.startsWith('att') && row.id !== userPhoto.id), 'fresh ids, never the source id');
assert.equal(new Set(savedB.map(r => r.id)).size, 3);
assert.deepEqual(savedB[0].data, png);
assert.deepEqual(savedB[1].data, jpeg);
assert.equal(savedFor(A).length, 2, "Alpha's own upload is untouched");
assert.ok(downloads.some(d => d.id === A && d.path === `/workspace/files/${A}/chart.png`), "the file is read from Alpha's own computer");

// ---- 2. delivery: the bot trigger reaches the model as input_image content ----
const { trigger } = sent[0];
assert.equal(trigger.type, 'bot');
assert.equal(trigger.attachments.length, 3);
const item = triggerItem(trigger);
assert.equal(item.role, 'user');
assert.ok(Array.isArray(item.content));
assert.equal(item.content[0].type, 'input_text');
assert.match(item.content[0].text, /^\[Message from Alpha, another Bot on the team\..*\]\nPlease review these$/s);
const images = item.content.filter(part => part.type === 'input_image');
assert.equal(images.length, 3);
assert.equal(images[0].image_url, `data:image/png;base64,${png.toString('base64')}`);
assert.equal(images[1].image_url, `data:image/jpeg;base64,${jpeg.toString('base64')}`);
const reply = triggerItem({ ...trigger, autoReply: true });
assert.match(reply.content[0].text, /^\[Reply from Alpha/);
assert.equal(reply.content.filter(p => p.type === 'input_image').length, 3, 'auto-replies carry images too');
assert.equal(typeof triggerItem({ ...trigger, attachments: undefined }).content, 'string', 'text-only bot messages stay plain text');

// ---- 3. multi-hop: B forwards what A sent (user_images) to C, and C's relays see it ----
assert.equal(latestUserAttachments(B, generation(B)).length, 3, "Bravo's newest incoming message is found for relays");
const hop = await sendToBot.impl({ bot_name: 'Charlie', message: 'From Alpha, FYI', attach: ['user_images'] }, ctxFor(B, { depth: 1 }));
assert.match(hop.output, /^Sent to Charlie with 3 images\./);
const toC = lastMessage(C);
assert.deepEqual(toC.from, { kind: 'bot', id: B, name: 'Bravo' });
const savedC = savedFor(C);
assert.equal(savedC.length, 3);
assert.ok(savedC.every((row, i) => row.id !== savedB[i].id && row.data.equals(savedB[i].data)), 'same bytes, new ids');
assert.equal(sent.at(-1).trigger.depth, 2);
assert.equal(triggerItem(sent.at(-1).trigger).content.filter(p => p.type === 'input_image').length, 3);
assert.equal((await relayMedia(C)).images.length, 3, "Charlie's relayed agents (Claude/Codex/Gemini) get the images");
// ...and onward once more: C -> A
const back = await sendToBot.impl({ bot_name: 'Alpha', message: 'Round trip', attach: ['user_images'] }, ctxFor(C, { depth: 2 }));
assert.match(back.output, /with 3 images/);
assert.equal(savedFor(A).length, 5);

// ---- 4. group chats: post_to_group stores images on the room message; members see them on the next dispatch ----
const room = rooms.createRoom(user, 'Design crew', [A, B]);
appendRow(room, 'message', { type: 'message', role: 'user', text: 'Show us the screen' });
const posted = await postToGroup.impl({ group_name: 'design crew', text: 'Here it is', attach: ['screenshot'] }, ctxFor(A));
assert.equal(posted.output, 'Posted to the group.');
assert.equal(posted.endTurn, true);
const roomPost = lastMessage(room);
assert.equal(roomPost.role, 'assistant');
assert.deepEqual(roomPost.from, { kind: 'bot', id: A, name: 'Alpha' });
assert.equal(roomPost.attachments.length, 1);
assert.equal(roomPost.attachments[0].mime, 'image/jpeg');
const savedRoom = savedFor(room);
assert.equal(savedRoom.length, 1);
assert.equal(savedRoom[0].id, roomPost.attachments[0].id);
assert.equal(savedRoom[0].seq, lastSeq(room));
assert.equal((await postToGroup.impl({ group_name: 'Design crew', text: 'hi', attach: ['screenshot'] }, ctxFor(C))).output, `You're not a member of "Design crew".`);
assert.equal(savedFor(room).length, 1, 'nothing saved for a non-member');
const plain = await postToGroup.impl({ group_name: 'Design crew', text: 'No pictures' }, ctxFor(B));
assert.equal(plain.output, 'Posted to the group.');
assert.equal(lastMessage(room).attachments, undefined, 'no attach, no attachments key');

// The user replies with a photo; dispatch hands members the user's photo plus the screenshot Alpha posted since the last user message.
appendRow(room, 'message', { type: 'message', role: 'user', text: '@Bravo forward these to Charlie' });
const dispatched = [];
rooms.dispatchRoomMessage(room, '@Bravo forward these to Charlie', (botId, t) => dispatched.push({ botId, t }), [userPhoto]);
assert.deepEqual(dispatched.map(d => d.botId), [B]);
const groupTrigger = dispatched[0].t;
assert.deepEqual(groupTrigger.attachments.map(f => f.mime), ['image/png', 'image/jpeg']);
assert.match(groupTrigger.text, /Alpha: Here it is \[1 attachment\]/);
assert.equal(triggerItem(groupTrigger).content.filter(p => p.type === 'input_image').length, 2);
assert.equal(rooms.botImagesSinceUser(room, generation(room)).length, 1);
// A member forwards the group's images (from the dispatch, not its own chat) to another bot.
const fromGroup = await sendToBot.impl({ bot_name: 'Charlie', message: 'From the group', attach: ['user_images'] }, ctxFor(B, { triggerAttachments: groupTrigger.attachments }));
assert.match(fromGroup.output, /with 2 images/);
assert.deepEqual(lastMessage(C).attachments.map(f => f.mime), ['image/png', 'image/jpeg']);
// A group dispatch without images never falls back to an older upload in the member's own chat.
await assert.rejects(collectBotAttachments(ctxFor(B, { triggerAttachments: [] }), ['user_images']), /no images to forward/);

// ---- 5. validation: every bad reference fails cleanly and nothing is sent ----
const before = { sent: sent.length, rows: db.prepare('SELECT COUNT(*) n FROM message_attachments').get().n };
const refuse = async (attach, pattern, ctx = ctxFor(A)) => {
  const result = await sendToBot.impl({ bot_name: 'Bravo', message: 'x', attach }, ctx);
  assert.match(result.output, /^Not sent: /, `${JSON.stringify(attach)} is refused`);
  assert.match(result.output, pattern);
};
files.set(`/workspace/files/${A}/notes.txt`, Buffer.from('plain text, not an image'));
files.set(`/workspace/files/${A}/huge.png`, Buffer.concat([png.subarray(0, 8), Buffer.alloc(4 * 1024 * 1024)]));
files.set(`/workspace/files/${A}/empty.png`, Buffer.alloc(0));
await refuse([`/workspace/files/${A}/notes.txt`], /"notes\.txt" is not an image\. Attach a PNG, JPEG, WebP, or GIF\./);
await refuse([`/workspace/files/${A}/huge.png`], /"huge\.png" is larger than 4 MB/);
await refuse([`/workspace/files/${A}/empty.png`], /"empty\.png" is empty/);
await refuse([`/workspace/files/${A}/missing.png`], /Could not read .*missing\.png.*no such file/);
await refuse([`/workspace/files/${B}/x.png`], /outside your files folder/);
await refuse([`/workspace/files/${A}/../${B}/x.png`], /outside your files folder/);
await refuse(['/etc/passwd'], /outside your files folder/);
await refuse([`/workspace/files/${A}/`], /outside your files folder/);
await refuse(['photo.png'], /Unknown attach value "photo\.png"/);
await refuse([''], /An attach value is empty/);
await refuse('screenshot', /attach must be a list/);
appendRow(A, 'message', { type: 'message', role: 'user', text: 'No pictures here' });
await refuse(['user_images'], /no images to forward/);
// More than MAX_ATTACHMENTS in total.
const many = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => ({ id: `att_many_${i}`, name: `shot-${i}.png`, mime: 'image/png', size: png.length, data: png }));
appendRow(A, 'message', { type: 'message', role: 'user', text: 'Thirty', attachments: many.map(({ data, ...m }) => m) }, many);
assert.equal((await collectBotAttachments(ctxFor(A), ['user_images'])).length, MAX_ATTACHMENTS, 'exactly the limit is fine');
await refuse(['user_images', 'screenshot'], new RegExp(`Attach up to ${MAX_ATTACHMENTS} images per message`));
// Group posts are validated the same way.
const badPost = await postToGroup.impl({ group_name: 'Design crew', text: 'x', attach: [`/workspace/files/${A}/notes.txt`] }, ctxFor(A));
assert.match(badPost.output, /^Not posted: "notes\.txt" is not an image/);
assert.notEqual(badPost.endTurn, true);
assert.equal(sent.length, before.sent, 'nothing was enqueued for refused messages');
assert.equal(db.prepare('SELECT COUNT(*) n FROM message_attachments').get().n, before.rows + MAX_ATTACHMENTS, 'only the test upload was saved');
// Duplicate references collapse; no attach (or an empty list) sends text only.
assert.equal((await collectBotAttachments(ctxFor(A), ['screenshot', 'screenshot'])).length, 1);
assert.deepEqual(await collectBotAttachments(ctxFor(A), undefined), []);
assert.deepEqual(await collectBotAttachments(ctxFor(A), []), []);
const textOnly = await sendToBot.impl({ bot_name: 'Bravo', message: 'just text' }, ctxFor(A));
assert.match(textOnly.output, /^Sent to Bravo\. /);
assert.equal(lastMessage(B).attachments, undefined);

// ---- 6. validation order: a refused send never takes a screenshot or reads a file (no container start-up) ----
files.set(`/workspace/files/${A}/ok.png`, png);
const quiet = async (run, pattern, label) => {
  const shots = screenshots, reads = downloads.length, queued = sent.length;
  const result = await run();
  assert.match(result.output, pattern, label);
  assert.equal(screenshots, shots, `${label}: no screenshot`);
  assert.equal(downloads.length, reads, `${label}: no download`);
  assert.equal(sent.length, queued, `${label}: nothing sent`);
};
const both = ['screenshot', `/workspace/files/${A}/ok.png`];
await quiet(() => sendToBot.impl({ bot_name: 'Nobody', message: 'x', attach: both }, ctxFor(A)), /^No bot named "Nobody"/, 'unknown bot');
await quiet(() => sendToBot.impl({ bot_name: 'Alpha', message: 'x', attach: both }, ctxFor(A)), /^That is you\./, 'self');
await quiet(() => sendToBot.impl({ bot_name: 'Design crew', message: 'x', attach: both }, ctxFor(A)), /is a group chat/, 'room');
await quiet(() => sendToBot.impl({ bot_name: 'Bravo', message: 'x', attach: both }, ctxFor(A, { depth: 8 })), /^Not sent: This request has already passed between Bots 8 times/, 'hop limit');
await quiet(() => postToGroup.impl({ group_name: 'No such group', text: 'x', attach: both }, ctxFor(A)), /^No group named "No such group"\./, 'unknown group');
await quiet(() => postToGroup.impl({ group_name: 'Design crew', text: 'x', attach: both }, ctxFor(C)), /^You're not a member of "Design crew"\./, 'not a member');
// Every reference is checked before any is fetched: a bad one later in the list stops the screenshot too.
await quiet(() => sendToBot.impl({ bot_name: 'Bravo', message: 'x', attach: ['screenshot', 'photo.png'] }, ctxFor(A)), /^Not sent: Unknown attach value "photo\.png"\. Use "user_images", "screenshot", or an image path under \/workspace\/files\//, 'bad ref after screenshot');
await quiet(() => sendToBot.impl({ bot_name: 'Bravo', message: 'x', attach: ['screenshot', `/workspace/files/${B}/x.png`] }, ctxFor(A)), /outside your files folder/, 'outside path after screenshot');
assert.match(String(await collectBotAttachments(ctxFor(A), ['']).catch(e => e.message)), new RegExp(`/workspace/files/${A}/\\.$`), 'errors name the concrete folder');

// ---- 7. paths are normalized before deduplicating ----
{
  const reads = downloads.length;
  const same = [`/workspace/files/${A}/ok.png`, `/workspace/files/${A}/./ok.png`, `/workspace/files/${A}//ok.png`, ` /workspace/files/${A}/sub/../ok.png `];
  const got = await collectBotAttachments(ctxFor(A), same);
  assert.equal(got.length, 1, 'four spellings of one file attach once');
  assert.deepEqual(downloads.slice(reads).map(d => d.path), [`/workspace/files/${A}/ok.png`], 'read once, by its normalized path');
}

// ---- 8. a Docker / Colima failure while reading a file is reported as it is, not as "no such file" ----
try {
  desktop.download = async () => { throw new DockerEngineDown(); };
  const down = await sendToBot.impl({ bot_name: 'Bravo', message: 'x', attach: [`/workspace/files/${A}/ok.png`] }, ctxFor(A));
  assert.match(down.output, /^Not sent: Could not read ".*ok\.png": Colima isn’t running/);
  assert.doesNotMatch(down.output, /no such file/);
  desktop.download = async () => { throw Object.assign(new Error('Command failed: docker exec -- marion-desktop bash'), { code: 1, stderr: Buffer.from('Error response from daemon: container 1234 is not running\n') }); };
  const stopped = await sendToBot.impl({ bot_name: 'Bravo', message: 'x', attach: [`/workspace/files/${A}/ok.png`] }, ctxFor(A));
  assert.match(stopped.output, /the computer could not read it \(Error response from daemon: container 1234 is not running\)/);
  assert.doesNotMatch(stopped.output, /no such file/);
  desktop.download = async () => { throw new Error('Colima could not start. Check its status on the Mac and try again.'); };
  const noStart = await sendToBot.impl({ bot_name: 'Bravo', message: 'x', attach: [`/workspace/files/${A}/ok.png`] }, ctxFor(A));
  assert.match(noStart.output, /Colima could not start/);
  assert.doesNotMatch(noStart.output, /no such file/);
} finally { desktop.download = realDownload; }
await refuse([`/workspace/files/${A}/still-missing.png`], /Could not read .*still-missing\.png": no such file\./);

// ---- 9. race: runTurn forwards the images of the message it is handling, not the newest message in the chat ----
assert.deepEqual(triggerAttachmentsOf({ type: 'bot', fromBotId: A, fromName: 'Alpha', text: 'x', depth: 1 }), [], 'a text-only bot message has no images (no fallback)');
assert.deepEqual(triggerAttachmentsOf({ type: 'user', text: 'x' }), []);
assert.equal(triggerAttachmentsOf({ type: 'user', text: 'x', attachments: [userPhoto] })[0].id, userPhoto.id);
assert.equal(triggerAttachmentsOf({ type: 'routine', routineId: 'r', name: 'r', prompt: 'x' }), undefined);
assert.equal(triggerAttachmentsOf({ type: 'resume' }), undefined);
{
  const D = idOf(createBotRecord(user, { name: 'Delta' }));
  const E = idOf(createBotRecord(user, { name: 'Echo' }));
  // Alpha sends Delta an image; before Delta's turn runs, a text-only message lands in Delta's chat.
  const withImage = botMessageTrigger(A, 'Alpha', D, 'RACE: forward this picture to Echo', 1, { attachments: [{ ...userPhoto, id: 'att_race_photo', name: 'race.png' }] });
  appendRow(D, 'message', { type: 'message', role: 'user', text: 'Unrelated text-only message' });
  assert.equal(latestUserAttachments(D, generation(D)).length, 0, 'the newest message in the chat has no images (the race)');
  assert.equal((await relayMedia(D)).images.length, 0, 'relayMedia without the trigger sees the newer message');
  assert.equal((await relayMedia(D, triggerAttachmentsOf(withImage))).images.length, 1, "relayMedia with the turn's own files sees the image");
  const userText = (item) => item?.role === 'user' ? (typeof item.content === 'string' ? item.content : item.content.map(part => part.text ?? '').join('')) : '';
  modelTurn = (input) => {
    const lastUser = [...input].reverse().find(item => item.role === 'user');
    if (input.at(-1)?.role === 'user' && /RACE: forward this picture/.test(userText(lastUser)) && userText(input.at(-1)) === userText(lastUser)) {
      return { call: { name: 'send_to_bot', arguments: { bot_name: 'Echo', message: 'Picture from Alpha', attach: ['user_images'] } } };
    }
    return { text: 'Done.' };
  };
  const outputsBefore = toolOutputs.length;
  loop.enqueue(D, withImage);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !(db.prepare("SELECT 1 FROM rows WHERE bot_id=? AND kind='message' AND body LIKE '%Picture from Alpha%'").get(E) && ![A, D, E].some(loop.isBotBusy))) await new Promise(resolve => setTimeout(resolve, 20));
  await loop.settleSideRuns();
  const forwarded = toolOutputs.slice(outputsBefore).find(output => /Echo/.test(output)) ?? toolOutputs.slice(outputsBefore).join(' | ');
  assert.doesNotMatch(forwarded, /no images to forward/, 'the turn forwards its own message images despite the newer text-only message');
  assert.match(forwarded, /Sent to Echo with 1 image\./, forwarded);
  const toE = JSON.parse(db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='message' AND body LIKE '%Picture from Alpha%'").get(E).body);
  assert.deepEqual(toE.from, { kind: 'bot', id: D, name: 'Delta' });
  assert.equal(toE.attachments.length, 1);
  assert.equal(toE.attachments[0].name, 'race.png');
  assert.deepEqual(savedFor(E).at(-1).data, png);
  for (let i = 0; i < 200 && [A, D, E].some(loop.isBotBusy); i++) await new Promise(resolve => setTimeout(resolve, 20));
}

console.log('bot-images: ok');
process.exit(0);
