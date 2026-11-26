// Screen recordings in the chat box: accepted by the server (MOV/MP4/WebM, sniffed by their bytes), a limit that fits
// real recordings, and byte-range reads so a long recording plays and seeks without loading all of it.
// No listener, no model calls (in-memory database).
// Usage: npm run build && node tests/screen-recording.mjs
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { db } = await import('../server/dist/db.js');
await import('../server/dist/features/schema.js');
await import('../server/dist/db-config.js');
(await import('../server/dist/agent/subagents.js')).initSubagents();
(await import('../server/dist/agent/rooms.js')).initRooms();
const { createBotRecord } = await import('../server/dist/features/bots.js');
const { appendRow } = await import('../server/dist/store.js');
const { attachmentBodyLimit, getAttachmentInfo, getAttachmentSlice, maxVideo, parseByteRange, readAttachments } = await import('../server/dist/attachments.js');

// A recording of a few minutes is accepted; two of them fit in one message.
assert.ok(maxVideo >= 256 * 1024 * 1024, 'recordings up to 256 MB');
assert.ok(attachmentBodyLimit >= 2 * maxVideo, 'two recordings fit in one request');

// MOV, MP4 and WebM are recognised by their bytes, whatever the browser called them.
const ftyp = (brand) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}`), Buffer.alloc(64, 7)]);
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 3)]);
const [mov, mp4, m4v, web] = await readAttachments([
  new File([ftyp('qt  ')], 'Screen Recording 2026-11-25.mov', { type: 'video/quicktime' }),
  new File([ftyp('isom')], 'demo.mp4', { type: 'video/mp4' }),
  new File([ftyp('M4V ')], 'clip.m4v', { type: '' }),
  new File([webm], 'capture.webm', { type: 'video/webm' }),
]);
assert.equal(mov.mime, 'video/quicktime');
assert.equal(mp4.mime, 'video/mp4');
assert.equal(m4v.mime, 'video/mp4');
assert.equal(web.mime, 'video/webm');
await assert.rejects(readAttachments([new File([Buffer.from('plain text pretending to be a video')], 'x.mov', { type: 'video/quicktime' })]), /could not be read/);
await assert.rejects(readAttachments([new File([Buffer.alloc(0)], 'empty.mov', { type: 'video/quicktime' })]), /content/);
console.log('PASS: MOV, MP4, M4V and WebM recordings are accepted and typed by their bytes.');

// Saved recordings: size without loading the bytes, and exact slices for Range requests.
const bytes = Buffer.from(Array.from({ length: 1000 }, (_, index) => index % 251));
const [saved] = await readAttachments([new File([Buffer.concat([ftyp('isom'), bytes])], 'long.mp4', { type: 'video/mp4' })]);
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'a@example.com', 'A', 1000);
const bot = createBotRecord('u1', { name: 'Recording bot' });
const botId = bot.id ?? bot;
const generation = db.prepare('SELECT generation FROM bots WHERE id=?').get(botId).generation;
// appendRow stores the message and its attachments together.
appendRow(botId, 'message', { type: 'message', role: 'user', text: 'Watch this', attachments: [{ id: saved.id, name: saved.name, mime: saved.mime, size: saved.size }] }, [saved]);
const info = getAttachmentInfo(botId, generation, saved.id);
assert.deepEqual([info.name, info.mime, info.size], ['long.mp4', 'video/mp4', saved.size]);
assert.equal(getAttachmentInfo(botId, generation + 1, saved.id), undefined, 'other generations stay hidden');
assert.ok(Buffer.from(getAttachmentSlice(botId, generation, saved.id, 100, 50)).equals(saved.data.subarray(100, 150)));
assert.ok(Buffer.from(getAttachmentSlice(botId, generation, saved.id, saved.size - 10, 10)).equals(saved.data.subarray(saved.size - 10)));
console.log('PASS: saved recordings are served by size and by exact byte slices.');

// Range header parsing (what a <video> element sends).
assert.deepEqual(parseByteRange('bytes=0-', 1000), { start: 0, end: 999 });
assert.deepEqual(parseByteRange('bytes=100-199', 1000), { start: 100, end: 199 });
assert.deepEqual(parseByteRange('bytes=900-5000', 1000), { start: 900, end: 999 });
assert.deepEqual(parseByteRange('bytes=-100', 1000), { start: 900, end: 999 });
assert.deepEqual(parseByteRange('bytes=-5000', 1000), { start: 0, end: 999 });
assert.equal(parseByteRange('bytes=1000-', 1000), 'unsatisfiable');
assert.equal(parseByteRange('bytes=500-100', 1000), 'unsatisfiable');
assert.equal(parseByteRange('bytes=-0', 1000), 'unsatisfiable');
assert.equal(parseByteRange(undefined, 1000), undefined);
assert.equal(parseByteRange('bytes=0-1,5-9', 1000), undefined, 'several ranges fall back to the whole file');
assert.equal(parseByteRange('items=0-5', 1000), undefined);
console.log('PASS: Range headers are parsed.');
