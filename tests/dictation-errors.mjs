// Dictation failures are actionable instead of an opaque 502:
//  - Mac dictation: unsupported macOS (501), unsupported language/locale (422), no engine (503) are not retryable and say
//    what to do; unknown failures stay 502 and retryable. Permission blocks (Microphone / Speech Recognition) are 403.
//  - Speech server (xAI or local MARION_STT_URL): unreachable 503, bad key 503, rate limit 429, unreadable audio/language
//    422, real upstream faults 502; a 2xx without a transcript is a distinct code.
//  - Wiring: /stt uses these classifiers everywhere it used to return a bare 502, and the client keeps status/code/retryable.
// Pure functions + source checks: no microphone, no listener, no network.
// Usage: npm run build && node tests/dictation-errors.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const { classifyDictationError, classifySpeechServiceFailure, MAC_PERMISSION_FAILURE, BAD_RESPONSE_FAILURE } = await import('../server/dist/lib/dictationErrors.js');
const { macBlock } = await import('../server/dist/lib/macPermissions.js');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok - ${name}`); };
const err = (stderr, message = 'Command failed') => Object.assign(new Error(message), { stderr });

test('unsupported macOS → 501, not retryable, says how to fix', () => {
  const f = classifyDictationError(err('Built-in dictation requires macOS 26.'), 'en-US');
  assert.equal(f.status, 501); assert.equal(f.code, 'mac_dictation_unsupported_os'); assert.equal(f.retryable, false);
  assert.match(f.error, /macOS 26/); assert.match(f.error, /Settings → Audio|Whisper/);
});

test('unsupported locale → 422 naming the language; Mac default language has its own wording', () => {
  const f = classifyDictationError(err('On-device dictation is unavailable for this Mac or language.'), 'fr-FR');
  assert.equal(f.status, 422); assert.equal(f.code, 'mac_dictation_unsupported_locale'); assert.equal(f.retryable, false);
  assert.match(f.error, /French/); assert.match(f.error, /fr-FR/); assert.match(f.error, /dictation language/);
  const own = classifyDictationError(err('locale xx_YY not supported'), '');
  assert.equal(own.status, 422); assert.match(own.error, /this Mac's language/);
  // A nonsense locale tag never throws while building the message.
  assert.equal(classifyDictationError(err('unsupported locale'), '!!').status, 422);
});

test('no engine installed → 503 mac_dictation_unavailable', () => {
  for (const e of [new Error('Built-in dictation is unavailable.'), new Error('Whisper is not installed.'), Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' })]) {
    const f = classifyDictationError(e, '');
    assert.equal(f.status, 503, e.message); assert.equal(f.code, 'mac_dictation_unavailable'); assert.equal(f.retryable, false);
  }
});

test('NEGATIVE: unknown failures stay a retryable 502 (never mislabelled as OS/locale)', () => {
  for (const e of [err('Segmentation fault'), new Error(''), undefined, 'weird']) {
    const f = classifyDictationError(e, 'en');
    assert.equal(f.status, 502); assert.equal(f.code, 'transcription_failed'); assert.equal(f.retryable, true);
    assert.match(f.error, /recording is kept/);
  }
});

test('permission blocks (Microphone / Speech Recognition) are recognised and map to 403, not retryable', () => {
  assert.deepEqual(MAC_PERMISSION_FAILURE, { status: 403, code: 'mac_permission_denied', retryable: false });
  if (process.platform === 'darwin') {
    assert.match(macBlock(err('Speech recognition permission denied'), 'x').fix, /Speech Recognition/);
    assert.match(macBlock(err('Microphone access not authorized'), 'x').fix, /Microphone/);
    assert.equal(macBlock(err('On-device dictation is unavailable for this Mac or language.'), 'x'), undefined, 'a locale problem is not a permission block');
  }
});

test('speech service failures each get an accurate status, code and fix', () => {
  const cases = [
    [undefined, false, 503, 'speech_service_unreachable', true, /internet connection/],
    [undefined, true, 503, 'speech_service_unreachable', true, /MARION_STT_URL/],
    [401, false, 503, 'speech_service_auth', false, /Settings → Audio/],
    [403, true, 503, 'speech_service_auth', false, /MARION_STT_KEY/],
    [429, false, 429, 'speech_service_rate_limited', true, /rate limiting/],
    [400, false, 422, 'speech_service_rejected', false, /dictation language/],
    [415, true, 422, 'speech_service_rejected', false, /local speech server/],
    [500, false, 502, 'transcription_failed', true, /HTTP 500/],
    [503, false, 502, 'transcription_failed', true, /recording is kept/],
  ];
  for (const [upstream, local, status, code, retryable, pattern] of cases) {
    const f = classifySpeechServiceFailure(upstream, local);
    const label = `${upstream} local=${local}`;
    assert.equal(f.status, status, label); assert.equal(f.code, code, label); assert.equal(f.retryable, retryable, label);
    assert.match(f.error, pattern, label);
  }
  assert.equal(BAD_RESPONSE_FAILURE.code, 'speech_service_bad_response');
});

test('wiring: /stt has no bare 502 left, and the client keeps status/code/retryable and names network failures', () => {
  const voice = read('server/src/voice.ts');
  const stt = voice.slice(voice.indexOf("voiceApi.post('/stt'"), voice.indexOf('\n});', voice.indexOf("voiceApi.post('/stt'")));
  assert.ok(stt.length > 100);
  assert.doesNotMatch(stt, /, 502\)/, 'no hard-coded 502 in /stt');
  assert.match(stt, /classifyDictationError\(error, locale\)/);
  assert.match(stt, /classifySpeechServiceFailure\(r\?\.status, !!LOCAL_STT_URL\)/);
  assert.match(stt, /MAC_PERMISSION_FAILURE/);
  const api = read('web/src/voice/api.ts');
  assert.match(api, /new TranscriptionError\(body\.error \|\| 'Transcription failed', res\.status, body\.code/);
  assert.match(api, /'network_error'/);
  assert.match(api, /signal\?\.aborted/, 'a cancel is not turned into a network error');
});

console.log(`PASS dictation-errors (${passed} tests)`);
