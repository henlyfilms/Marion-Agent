// Mac dictation engines: the lossless WAV builder, vocabulary hints, and engine choice / fallback (Whisper for the final pass,
// Apple for live previews, each falling back to the other). Offline: stub "helper" and "whisper-cli" scripts stand in for the
// real engines. Needs `npm run build` first. Usage: node tests/dictation-engine.mjs
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'marion-dictation-engine-'));
const script = async (name, body) => { const path = join(dir, name); await writeFile(path, `#!/bin/bash\n${body}\n`); await chmod(path, 0o755); return path; };

// Apple stub: prints the hints it was given so the test can see them (args: audio locale --context file).
process.env.MARION_NATIVE_TRANSCRIBER = await script('apple.sh', 'if [ "$3" = "--context" ]; then echo "apple[$2]: $(tr "\\n" "," < "$4")"; else echo "apple-nohints"; fi');
const whisperMode = join(dir, 'whisper-mode');
await writeFile(whisperMode, 'ok');
process.env.MARION_WHISPER_CLI = await script('whisper-cli.sh', `case "$(cat '${whisperMode}')" in ok) echo " Hello [BLANK_AUDIO] there (music) friend ";; empty) echo "[BLANK_AUDIO]";; fail) echo boom >&2; exit 1;; esac; echo "$@" > '${join(dir, 'whisper-args')}'`);
process.env.MARION_WHISPER_MODEL = join(dir, 'ggml-small.bin');
await writeFile(process.env.MARION_WHISPER_MODEL, 'model');

const speech = await import('../server/dist/native-speech.js');
const { samplesToWav } = await import('../web/src/voice/pcmRecorder.ts');

try {
  // ---- WAV builder ----
  const quiet = new Float32Array(16_000).fill(0.1); // one second at 10% level
  const wav = Buffer.from(await samplesToWav([quiet], 16_000).arrayBuffer());
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(wav.readUInt32LE(24), 16_000, 'sample rate in the header');
  assert.equal(wav.readUInt16LE(34), 16, '16-bit samples');
  const samples = (wav.length - 44) / 2;
  assert.equal(samples, 16_000 + Math.round(16_000 * 0.45), 'a silent tail is appended so the last word is not cut');
  assert.ok(wav.readInt16LE(44) > 0.8 * 32767, 'quiet speech is brought up to a healthy level');
  const faint = Buffer.from(await samplesToWav([new Float32Array(1600).fill(0.01)], 16_000, 0).arrayBuffer());
  assert.ok(faint.readInt16LE(44) <= 0.17 * 32767, 'gain is capped (24 dB) so a near-silent room is not blown up');
  assert.equal(wav.readInt16LE(wav.length - 2), 0, 'the tail is silent');
  const silence = Buffer.from(await samplesToWav([new Float32Array(1600)], 16_000, 0).arrayBuffer());
  assert.equal(silence.readInt16LE(44), 0, 'pure silence is never amplified');
  const loud = Buffer.from(await samplesToWav([new Float32Array([1, -1, 0.5])], 16_000, 0).arrayBuffer());
  assert.ok(Math.abs(loud.readInt16LE(44)) <= 0.9 * 32767 + 1, 'loud audio is not boosted into clipping');

  // ---- hints ----
  const hints = speech.dictationHints(['Atlas', 'Research Bot'], 'please ask Atlas about the PostgreSQL migration, then iPhone support and the a b cd');
  for (const word of ['Marion Agent', 'Gemini', 'Atlas', 'Research Bot', 'PostgreSQL', 'migration', 'iPhone']) assert.ok(hints.includes(word), `hint "${word}" missing`);
  assert.ok(!hints.includes('cd') && !hints.includes('a'), 'tiny lowercase words are not useful hints');
  assert.ok(hints.length <= 121);
  assert.equal(speech.cleanWhisper(' Hello [BLANK_AUDIO] (music)  world '), 'Hello world');

  // ---- engine choice ----
  const file = new File([Buffer.alloc(400)], 'dictation.wav', { type: 'audio/wav' });
  const ask = (final) => speech.transcribeOnMac(file, { language: 'en-US', final, hints: ['Atlas', 'Gemini'] }, new AbortController().signal);
  assert.ok(speech.nativeTranscription, 'dictation should be available when an engine is installed');
  assert.ok(speech.whisperSetup(), 'whisper-cli + model should be detected');

  const preview = await ask(false);
  assert.match(preview, /^apple\[en-US\]: Atlas,Gemini,?$/, `a live preview must use the instant engine with hints (got ${preview})`);
  assert.equal(await ask(true), 'Hello there friend', 'the final pass must use Whisper and drop its non-speech tags');
  const args = (await import('node:fs')).readFileSync(join(dir, 'whisper-args'), 'utf8');
  assert.ok(args.includes('--prompt') && args.includes('Gemini') && args.includes('-l en'), `whisper must get the language and a vocabulary prompt (${args.trim()})`);

  await writeFile(whisperMode, 'fail');
  assert.match(await ask(true), /^apple\[/, 'a failing Whisper falls back to Apple');
  await writeFile(whisperMode, 'empty');
  assert.match(await ask(true), /^apple\[/, 'a Whisper pass that hears nothing is double-checked with Apple');
  await writeFile(whisperMode, 'ok');

  const stopper = new AbortController();
  stopper.abort();
  await assert.rejects(speech.transcribeOnMac(file, { language: '', final: true, hints: [] }, stopper.signal), 'an aborted request stays aborted');
  console.log('PASS: lossless WAV with tail + level, vocabulary hints, Whisper final / Apple preview, fallbacks both ways.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
