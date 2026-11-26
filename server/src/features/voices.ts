import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { env } from '../env.js';
import { newId } from '../lib/ids.js';
import { getSetting, setSetting } from './schema.js';

/**
 * Call voices on the Mac. Two kinds:
 * - Mac voices: every voice installed in macOS (System Settings → Accessibility → Spoken Content adds more).
 * - Your own voices: a speech model server you run (OpenAI-style /v1/audio/speech, e.g. Kokoro, F5-TTS,
 *   Chatterbox), optionally with an uploaded voice sample that voice-cloning servers use as the reference.
 * A bot's voice is saved as "mac:<Name>" or "custom:<id>".
 */

const run = promisify(execFile);
export interface CustomVoice { id: string; name: string; url: string; model: string; voice: string; sample: string | null; sampleName: string | null }
const samples = () => join(dirname(env.dbPath), 'voices');
let macCache: { at: number; voices: { name: string; language: string }[] } | null = null;

export async function macVoices() {
  if (process.platform !== 'darwin') return [];
  if (macCache && Date.now() - macCache.at < 10 * 60_000) return macCache.voices;
  const { stdout } = await run('/usr/bin/say', ['-v', '?'], { timeout: 8000 }).catch(() => ({ stdout: '' }));
  const voices = stdout.split('\n').map(line => /^(.+?)\s{2,}([a-z]{2}_[A-Z]{2}|[a-z]{2,3}_\d+)\s+#/.exec(line)).filter(Boolean)
    .map(match => ({ name: match![1].trim(), language: match![2] }));
  macCache = { at: Date.now(), voices };
  return voices;
}

export const customVoices = (userId: string) => getSetting<{ voices: CustomVoice[] }>(userId, 'custom-voices', { voices: [] }).voices;

export async function addCustomVoice(userId: string, input: { name?: unknown; url?: unknown; model?: unknown; voice?: unknown; sample?: File | null }) {
  const name = String(input.name ?? '').trim().slice(0, 40);
  if (!name) throw new Error('Name the voice.');
  const url = String(input.url ?? '').trim();
  if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('Enter the speech server address, like http://127.0.0.1:8880/v1/audio/speech.');
  if (!url && !input.sample) throw new Error('Add a voice file, a speech model server, or both.');
  const id = newId('voice');
  let sample: string | null = null;
  if (input.sample) {
    if (input.sample.size > 25 * 1024 * 1024) throw new Error('Keep the voice file under 25 MB.');
    const ext = (/\.(wav|mp3|m4a|aac|ogg|flac|webm)$/i.exec(input.sample.name)?.[1] ?? 'wav').toLowerCase();
    await mkdir(samples(), { recursive: true, mode: 0o700 });
    sample = `${id}.${ext}`;
    await writeFile(join(samples(), sample), Buffer.from(await input.sample.arrayBuffer()), { mode: 0o600 });
  }
  const voice: CustomVoice = { id, name, url, model: String(input.model ?? '').trim().slice(0, 120), voice: String(input.voice ?? '').trim().slice(0, 80), sample, sampleName: input.sample?.name.slice(0, 120) ?? null };
  setSetting(userId, 'custom-voices', { voices: [...customVoices(userId), voice].slice(-30) });
  return voice;
}

export async function removeCustomVoice(userId: string, id: string) {
  const voices = customVoices(userId);
  const gone = voices.find(voice => voice.id === id);
  if (gone?.sample) await rm(join(samples(), gone.sample), { force: true });
  setSetting(userId, 'custom-voices', { voices: voices.filter(voice => voice.id !== id) });
}

/** Speak with the bot's chosen voice. Returns null when the Mac's default voice should be used. */
export async function speakWithVoice(userId: string, voiceId: string | null | undefined, text: string, speed: number, signal: AbortSignal): Promise<{ audio: Buffer; type: string } | { macVoice: string } | null> {
  if (!voiceId) return null;
  if (voiceId.startsWith('mac:')) {
    const name = voiceId.slice(4);
    return (await macVoices()).some(voice => voice.name === name) ? { macVoice: name } : null;
  }
  if (!voiceId.startsWith('custom:')) return null;
  const custom = customVoices(userId).find(voice => voice.id === voiceId.slice(7));
  if (!custom) return null;
  if (!custom.url) throw new Error(`"${custom.name}" is only a voice file. Add a voice-cloning speech server for it in Settings → Audio → Voices.`);
  const reference = custom.sample ? (await readFile(join(samples(), custom.sample)).catch(() => null))?.toString('base64') : undefined;
  const response = await fetch(custom.url, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: custom.model || 'tts-1', input: text, voice: custom.voice || 'default', speed, response_format: 'wav', ...(reference ? { ref_audio: reference, reference_audio: reference } : {}) }),
  });
  if (!response.ok) throw new Error(`The speech server for "${custom.name}" answered ${response.status}.`);
  return { audio: Buffer.from(await response.arrayBuffer()), type: response.headers.get('content-type') || 'audio/wav' };
}
