// In-memory dictation retry: a recording whose transcription failed is kept ONLY in JavaScript memory so the owner can
// retry without speaking again, and it is dropped on success, discard/cancel, a new recording, or a deleted chat.
//  - createRetryHold: hold / retry success clears / retry failure keeps with the newer error / no double retry /
//    discard during a retry wins / clear is idempotent.
//  - Privacy: running the hold with tripwires on localStorage, sessionStorage, indexedDB, caches and node:fs writes
//    proves nothing is persisted; the voice sources never reference a storage API.
//  - Wiring: useDictation clears the hold on cancel and on a new recording; the composer clears it on start, discard
//    and when its chat is deleted; Retry/Discard buttons are shown only in the chat the recording belongs to.
// No microphone, no network, no listener.
// Usage: node --import tsx tests/dictation-retry.mjs
import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// ---- privacy tripwires: any persistence attempt fails the test ----
const touched = [];
for (const name of ['localStorage', 'sessionStorage', 'indexedDB', 'caches']) {
  Object.defineProperty(globalThis, name, { configurable: true, get() { touched.push(name); throw new Error(`${name} must not be used`); } });
}
const writes = [];
for (const [mod, names] of [[fs, ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream']], [fsp, ['writeFile', 'appendFile']]]) {
  for (const name of names) { const orig = mod[name]; mod[name] = (...args) => { writes.push(`${name}:${args[0]}`); return orig.apply(mod, args); }; }
}

const { createRetryHold, TranscriptionError, retryActions } = await import('../web/src/voice/dictationRetry.ts');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };
const audio = (n = 1) => new Blob([new Uint8Array(1000 * n)], { type: 'audio/wav' });
const recording = (extra = {}) => ({ audio: audio(), native: true, error: 'Transcription failed', retryable: true, ...extra });

await test('hold keeps the recording; changes are reported', async () => {
  const seen = [];
  const h = createRetryHold(v => seen.push(v));
  assert.equal(h.current(), undefined);
  const r = recording();
  h.hold(r);
  assert.equal(h.current(), r);
  assert.equal(seen.at(-1), r);
});

await test('a successful retry returns the words and drops the audio', async () => {
  const h = createRetryHold();
  const r = recording();
  h.hold(r);
  let given;
  const text = await h.retry(async held => { given = held; return 'hello world'; });
  assert.equal(text, 'hello world');
  assert.equal(given.audio, r.audio, 'the same in-memory blob is resent');
  assert.equal(h.current(), undefined, 'cleared on success');
});

await test('an empty transcript is still a success (clears)', async () => {
  const h = createRetryHold(); h.hold(recording());
  assert.equal(await h.retry(async () => ''), '');
  assert.equal(h.current(), undefined);
});

await test('NEGATIVE: a failed retry keeps the audio with the newer reason, code and retryable flag', async () => {
  const h = createRetryHold();
  const r = recording();
  h.hold(r);
  await assert.rejects(h.retry(async () => { throw new TranscriptionError('Mac dictation doesn\'t support French', 422, 'mac_dictation_unsupported_locale', false); }), /French/);
  const kept = h.current();
  assert.equal(kept.audio, r.audio);
  assert.equal(kept.error, "Mac dictation doesn't support French");
  assert.equal(kept.code, 'mac_dictation_unsupported_locale');
  assert.equal(kept.retryable, false);
  // and it can be retried again after the owner changes the language
  assert.equal(await h.retry(async () => 'bonjour'), 'bonjour');
  assert.equal(h.current(), undefined);
});

await test('NEGATIVE: retry with nothing held, or while one is running, does nothing', async () => {
  const h = createRetryHold();
  assert.equal(await h.retry(async () => 'x'), undefined);
  h.hold(recording());
  let calls = 0;
  let release;
  const first = h.retry(() => { calls++; return new Promise(r => { release = r; }); });
  assert.equal(h.busy(), true);
  assert.equal(await h.retry(async () => { calls++; return 'second'; }), undefined, 'double-click is ignored');
  release('once'); assert.equal(await first, 'once');
  assert.equal(calls, 1); assert.equal(h.busy(), false);
});

await test('discard (or a new recording) during a retry wins: the old audio never comes back', async () => {
  const h = createRetryHold();
  h.hold(recording());
  let fail;
  const p = h.retry(() => new Promise((_, reject) => { fail = reject; }));
  h.clear();
  fail(new Error('late failure'));
  await assert.rejects(p);
  assert.equal(h.current(), undefined, 'a failure after discard does not resurrect the recording');
  const next = recording({ audio: audio(2) });
  let finish;
  const q = (h.hold(recording()), h.retry(() => new Promise(r => { finish = r; })));
  h.hold(next);
  finish('old words');
  await q;
  assert.equal(h.current(), next, 'a success of the old one does not drop the newer recording');
});

await test('clear is idempotent and only notifies when something was held', async () => {
  let n = 0;
  const h = createRetryHold(() => n++);
  h.clear(); assert.equal(n, 0);
  h.hold(recording()); h.clear(); h.clear();
  assert.equal(n, 2);
});

await test('privacy: no storage API and no file write was touched by any of the above', async () => {
  assert.deepEqual(touched, []);
  assert.deepEqual(writes, []);
  for (const file of ['web/src/voice/dictationRetry.ts', 'web/src/voice/dictation.ts', 'web/src/voice/composerDictation.tsx']) {
    const code = read(file).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''); // ignore comments that name the APIs
    assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|caches\.|showSaveFilePicker|createObjectURL|FileSystem/, file);
  }
});

await test('wiring: the hold is cleared on cancel, new recording, discard and deleted chat; Retry only in its own chat', async () => {
  const dictation = read('web/src/voice/dictation.ts');
  assert.match(dictation, /if \(cancel\) retained\.clear\(\)/, 'cancel/discard clears');
  assert.match(dictation, /retained\.clear\(\); \/\/ a new recording replaces/, 'a new recording clears');
  assert.match(dictation, /retained\.hold\(\{ audio: recorded/, 'a failed final pass holds the audio');
  assert.match(dictation, /retained\.retry\(/);
  const composer = read('web/src/voice/composerDictation.tsx');
  assert.match(composer, /recorded\.clearRetry\(\); \/\/ a new recording \(either engine\)/);
  assert.match(composer, /discardRetry\(\) \{\s*recorded\.clearRetry\(\);/);
  assert.match(composer, /retryOwner && !current\.bots\.some\(bot => bot\.id === retryOwner\)\) controls\?\.discardRetry\(\)/);
  assert.match(composer, /if \(owner \|\| !recorded\.failed \|\| !recorded\.failed\.retryable \|\| retryOwner !== botId\) return;/, 'retry only into the chat it was recorded in');
  const ui = read('web/src/components/Composer.tsx');
  assert.match(ui, /s\.retry\?\.botId === bot\.id/);
  assert.match(ui, /composerDictation\.retry\(bot\.id\)/);
  assert.match(ui, /composerDictation\.discardRetry\(\)/);
});

await test('retryActions: retryable:true offers Retry and Discard (regression)', async () => {
  assert.deepEqual(retryActions({ retryable: true }, true), { kept: true, retry: true, discard: true });
});

await test('retryActions: retryable:false hides Retry, keeps Discard (negative)', async () => {
  assert.deepEqual(retryActions({ retryable: false }, true), { kept: true, retry: false, discard: true });
  assert.equal(retryActions({}, true).retry, false, 'a missing flag is not retryable');
  assert.equal(retryActions({ retryable: 'yes' }, true).retry, false, 'only a real true counts');
});

await test('retryActions: nothing offered while recording/transcribing or with nothing kept (negative)', async () => {
  assert.deepEqual(retryActions({ retryable: true }, false), { kept: false, retry: false, discard: false });
  assert.deepEqual(retryActions(undefined, true), { kept: false, retry: false, discard: false });
});

await test('wiring: the Composer gates Retry on retryable; the controller refuses a non-retryable retry', async () => {
  const ui = read('web/src/components/Composer.tsx');
  assert.match(ui, /const offer = retryActions\(retryHere, state === 'idle'\)/);
  assert.match(ui, /\{offer\.retry && <button[^>]*>[^]*?composerDictation\.retry\(bot\.id\)[^]*?>Retry<\/button>\}/);
  assert.match(ui, /\{offer\.discard && <button[^>]*>[^]*?composerDictation\.discardRetry\(\)[^]*?>Discard<\/button>\}/);
  assert.doesNotMatch(ui, /canRetry/, 'the old ungated flag is gone');
  const retryButtons = ui.match(/>Retry<\/button>/g) ?? [];
  const micRetry = ui.split('\n').filter(line => line.includes('composerDictation.retry(bot.id)'));
  assert.equal(micRetry.length, 1); assert.match(micRetry[0], /^\s*\{offer\.retry && /, 'every mic Retry button is gated');
  assert.ok(retryButtons.length >= 1);
  const composer = read('web/src/voice/composerDictation.tsx');
  assert.match(composer, /!recorded\.failed\.retryable/, 'retry() is a no-op when the failure is not retryable');
});

console.log(`PASS dictation-retry (${passed} tests)`);
