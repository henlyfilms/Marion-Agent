// Chat attachments: one message carries up to 30 files (server validation, request size, relays) and no more.
// No listener, no network (in-memory database). Usage: npm run build && node tests/attachment-limit.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DB_PATH = ':memory:';
await import('../server/dist/db.js');
await import('../server/dist/features/schema.js');
const { MAX_ATTACHMENTS, readAttachments, attachmentBodyLimit, maxVideo } = await import('../server/dist/attachments.js');
const limits = await import('../server/dist/attachment-limits.js');
const { lookableMedia } = await import('../server/dist/video-frames.js');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const files = (count) => Array.from({ length: count }, (_, i) => i % 3 === 2
  ? new File([`note ${i}`], `note-${i}.txt`, { type: 'text/plain' })
  : new File([png], `shot-${i}.png`, { type: 'image/png' }));

assert.equal(MAX_ATTACHMENTS, 30);
assert.equal(limits.MAX_ATTACHMENTS, 30, 'one shared limit for the app and the server');
assert.equal(limits.TOO_MANY_ATTACHMENTS, 'Add up to 30 attachments per message.');

// 30 files in one message are accepted, in order.
const thirty = await readAttachments(files(30));
assert.equal(thirty.length, 30);
assert.deepEqual(thirty.map((f) => f.name), files(30).map((f) => f.name));
assert.equal(thirty.filter((f) => f.mime === 'image/png').length, 20);
// 5 (the old limit + 1) and 29 work too; 31 is refused.
assert.equal((await readAttachments(files(5))).length, 5);
assert.equal((await readAttachments(files(29))).length, 29);
await assert.rejects(readAttachments(files(31)), /Add up to 30 attachments per message\./);

// The request size limit fits 30 full-size photos alongside two recordings.
assert.ok(attachmentBodyLimit >= 2 * maxVideo + 30 * 4 * 1024 * 1024, 'body limit covers 30 photos');

// Relayed builders get every attached screenshot (not just the first 12).
const shots = thirty.filter((f) => f.mime.startsWith('image/'));
const relayed = await lookableMedia(shots);
assert.equal(relayed.images.length, shots.length);
assert.match(relayed.note, /20 screenshots/);

// The app uses the same limit everywhere it adds files (picker, drag and drop, paste, screenshot picker).
const composer = readFileSync(new URL('../web/src/components/Composer.tsx', import.meta.url), 'utf8');
const fileDrafts = readFileSync(new URL('../web/src/lib/fileDrafts.ts', import.meta.url), 'utf8');
const picker = readFileSync(new URL('../web/src/components/modals/ScreenshotPicker.tsx', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../web/src/components/Sidebar.tsx', import.meta.url), 'utf8');
// One check for every way in: the chat box, the screenshot picker and drops on a sidebar chat.
assert.match(fileDrafts, /current\.length \+ added\.length > MAX_ATTACHMENTS\) return TOO_MANY_ATTACHMENTS/);
assert.match(composer, /addDraftFiles\(bot\.id, added\)/);
assert.match(picker, /addDraftFiles\(botId, \[file\]\)/);
assert.match(picker, /already has \{MAX_ATTACHMENTS\} attachments/);
assert.match(sidebar, /dropFilesOnChat\(botId, /);
for (const source of [composer, picker]) assert.doesNotMatch(source, /four attachments|length > 4\b/);
const css = readFileSync(new URL('../web/src/styles/chat.css', import.meta.url), 'utf8');
assert.match(css, /\.composer-files \{[^}]*overflow-y: auto/, 'many attachments scroll inside the strip');
console.log('PASS up to 30 attachments per message (31 refused), body limit, relays keep every screenshot, one shared UI limit');
