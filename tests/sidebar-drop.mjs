// Dropping screenshots or files on a chat in the sidebar: they land in *that* bot's draft (never the chat that was
// open), the chat opens afterwards, the 30-file limit holds, and problems show in the target chat's box.
// No browser, no server. Usage: node tests/sidebar-drop.mjs
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// The web app imports '@shared/*' (Vite alias for server/src); point Node at the same TypeScript files.
const shared = new URL('../server/src/', import.meta.url);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@shared/')) return next(new URL(`${specifier.slice('@shared/'.length)}.ts`, shared).href, context);
    return next(specifier, context);
  },
});

const drafts = await import('../web/src/lib/fileDrafts.ts');
const { MAX_ATTACHMENTS, TOO_MANY_ATTACHMENTS } = await import('../server/src/attachment-limits.ts');
const png = (name) => new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], name, { type: 'image/png' });

// Only drags that carry files light a chat up (text, links and in-app reordering do not).
assert.equal(drafts.carriesFiles({ types: ['Files'] }), true);
assert.equal(drafts.carriesFiles({ types: ['text/plain', 'text/uri-list'] }), false);
assert.equal(drafts.carriesFiles(null), false);

// Routing: chat A is open with its own attachment; screenshots dropped on chat B go to B, then B opens.
const opened = [];
const seen = [];
const stop = drafts.subscribeFileDrafts(() => seen.push(drafts.getFileDraft('bot-b').length));
drafts.setFileDraft('bot-a', [png('a.png')]);
const openChat = (id) => { opened.push({ id, filesThen: drafts.getFileDraft(id).map(file => file.name) }); };
assert.equal(drafts.dropFilesOnChat('bot-b', [png('Screenshot 1.png'), png('Screenshot 2.png')], openChat), true);
assert.deepEqual(drafts.getFileDraft('bot-a').map(file => file.name), ['a.png'], 'the open chat keeps only its own files');
assert.deepEqual(drafts.getFileDraft('bot-b').map(file => file.name), ['Screenshot 1.png', 'Screenshot 2.png']);
assert.deepEqual(opened, [{ id: 'bot-b', filesThen: ['Screenshot 1.png', 'Screenshot 2.png'] }], 'files are in place before the chat opens');
assert.ok(seen.includes(2), 'a mounted chat box hears about the new files');
assert.equal(drafts.takeFileDraftProblem('bot-b'), undefined);

// A second drop adds to the same draft; the draft array is stable between changes (useSyncExternalStore).
const before = drafts.getFileDraft('bot-b');
assert.equal(drafts.getFileDraft('bot-b'), before);
drafts.dropFilesOnChat('bot-b', [png('Screenshot 3.png')], openChat);
assert.equal(drafts.getFileDraft('bot-b').length, 3);
assert.notEqual(drafts.getFileDraft('bot-b'), before);

// The 30-file limit: a drop that would go over adds nothing, still opens the chat, and says why there.
drafts.setFileDraft('bot-c', Array.from({ length: MAX_ATTACHMENTS - 1 }, (_, i) => png(`c${i}.png`)));
assert.equal(drafts.dropFilesOnChat('bot-c', [png('x.png'), png('y.png')], openChat), false);
assert.equal(drafts.getFileDraft('bot-c').length, MAX_ATTACHMENTS - 1);
assert.equal(opened.at(-1).id, 'bot-c');
assert.equal(drafts.takeFileDraftProblem('bot-c'), TOO_MANY_ATTACHMENTS);
assert.equal(drafts.takeFileDraftProblem('bot-c'), undefined, 'the problem shows once');
assert.equal(drafts.dropFilesOnChat('bot-c', [png('last.png')], openChat), true, 'exactly 30 fits');
assert.equal(drafts.getFileDraft('bot-c').length, MAX_ATTACHMENTS);

// Same rules as the chat box: unsupported and empty files are refused with a clear reason.
assert.match(drafts.attachmentProblem([], [new File(['%PDF'], 'doc.pdf', { type: 'application/pdf' })]), /PDFs can’t be read/);
assert.equal(drafts.attachmentProblem([], [new File([], 'empty.png', { type: 'image/png' })]), 'Choose a file with content.');
assert.equal(drafts.attachmentProblem([], [new File(['x'], 'notes.md', { type: '' })]), null);
assert.equal(drafts.dropFilesOnChat('bot-d', [], openChat), false, 'an empty drop does nothing');
assert.equal(opened.at(-1).id, 'bot-c');

// Sending clears the draft; clearing an already empty draft is a no-op.
drafts.setFileDraft('bot-b', []);
assert.equal(drafts.getFileDraft('bot-b').length, 0);
const count = seen.length;
drafts.setFileDraft('bot-b', []);
assert.equal(seen.length, count);
stop();

console.log('PASS: files dropped on a sidebar chat go to that chat’s draft before it opens, within the 30-file limit.');
