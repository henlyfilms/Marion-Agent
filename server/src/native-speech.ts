import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isExpectedAbort } from './lib/abort.js';

const run = promisify(execFile);
const helper = process.env.MARION_NATIVE_TRANSCRIBER;

/**
 * Dictation engines on the Mac, best first for the FINAL pass (after the user stops talking):
 *  1. whisper.cpp (`whisper-cli` + a ggml model), if one is installed. Whisper is clearly more accurate than the system
 *     recogniser on names, jargon and mumbled words. Found automatically (see whisperSetup) or set with
 *     MARION_WHISPER_CLI / MARION_WHISPER_MODEL. It is optional; nothing is downloaded behind the owner's back.
 *  2. Apple's on-device SpeechAnalyzer (macOS 26), bundled helper. Instant, so it also drives the live preview.
 * Each engine falls back to the other if it fails, so dictation keeps working out of the box.
 */
const exists = (path: string | undefined): path is string => Boolean(path) && existsSync(path!);

function findWhisper() {
  const home = homedir();
  const cli = [process.env.MARION_WHISPER_CLI, '/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli', '/opt/homebrew/bin/whisper-cpp'].find(exists);
  if (!cli) return undefined;
  const dirs = [process.env.MARION_WHISPER_MODEL_DIR, join(home, 'Library/Application Support/Marion Agent/models'), join(home, '.cache/whisper'),
    join(home, '.cache/whisper.cpp'), '/opt/homebrew/share/whisper-cpp', '/opt/homebrew/share/whisper-cpp/models', '/usr/local/share/whisper-cpp']
    .filter((dir): dir is string => Boolean(dir));
  // Larger and multilingual models first; the English-only ones only if nothing else is there.
  const wanted = ['large-v3-turbo', 'large-v3', 'large-v2', 'medium', 'small', 'base', 'medium.en', 'small.en', 'base.en'];
  const models = [process.env.MARION_WHISPER_MODEL, ...dirs.flatMap(dir => wanted.flatMap(name => [join(dir, `ggml-${name}.bin`), join(dir, `ggml-${name}-q5_0.bin`)]))];
  const model = models.find(exists);
  return model ? { cli, model } : undefined;
}

let whisperCache: { at: number; value: ReturnType<typeof findWhisper> } | undefined;
/** The whisper.cpp install, re-checked at most every 30 s so installing a model takes effect without a restart. */
export const whisperSetup = () => {
  if (!whisperCache || Date.now() - whisperCache.at > 30_000) whisperCache = { at: Date.now(), value: process.platform === 'darwin' ? findWhisper() : undefined };
  return whisperCache.value;
};

export const nativeTranscription = process.platform === 'darwin' && (Boolean(helper) || Boolean(whisperSetup()));
export const nativePlayback = process.platform === 'darwin' && Boolean(process.env.MARION_DESKTOP_TOKEN);

/** Names and product words dictation often gets wrong, plus words from what the user is writing. One hint per entry. */
const BASE_HINTS = ['Marion Agent', 'Marion', 'Claude', 'Claude Code', 'Codex', 'Gemini', 'Grok', 'OpenAI', 'Anthropic', 'GPT', 'Docker', 'Electron', 'TypeScript', 'JavaScript', 'GitHub', 'npm', 'API', 'subagent', 'repo'];

export function dictationHints(botNames: string[], context: string | undefined) {
  const hints = new Set<string>(BASE_HINTS);
  for (const name of botNames) { const clean = name.replace(/\s+/g, ' ').trim(); if (clean && clean.length <= 60) hints.add(clean); }
  // Distinctive words from the draft (capitalised, mixed-case, numbers or long ones), most recent first.
  const words = (context ?? '').replace(/[^\p{L}\p{N}'’_.\-\s]/gu, ' ').split(/\s+/).filter(Boolean).reverse();
  for (const word of words) {
    if (hints.size >= 120) break;
    const w = word.replace(/^[.'’\-_]+|[.'’\-_]+$/g, '');
    if (w.length >= 5 || /^[A-Z]/.test(w) && w.length >= 3 || /\d|[a-z][A-Z]/.test(w)) hints.add(w);
  }
  return [...hints];
}

async function transcribeWithApple(audio: string, language: string, hints: string[], signal: AbortSignal) {
  if (!helper) throw new Error('Built-in dictation is unavailable.');
  const context = `${audio}.hints.txt`;
  await writeFile(context, hints.join('\n'), { mode: 0o600 });
  const { stdout } = await run(helper, [audio, language, '--context', context], { signal, timeout: 120_000 });
  return stdout.trim();
}

/** Whisper emits `[BLANK_AUDIO]`, `(music)` and the like for silence and noise; they are never speech. */
export const cleanWhisper = (text: string) => text.replace(/\[[A-Z_ ]+\]|\((?:music|silence|noise|applause|laughter)\)/gi, ' ').replace(/\s+/g, ' ').trim();

async function transcribeWithWhisper(audio: string, language: string, hints: string[], signal: AbortSignal) {
  const setup = whisperSetup();
  if (!setup) throw new Error('Whisper is not installed.');
  const lang = /^[a-z]{2}/i.test(language) ? language.slice(0, 2).toLowerCase() : 'auto';
  const english = /\.en(?:-|\.)/.test(setup.model);
  const args = ['-m', setup.model, '-f', audio, '-nt', '-np', '-l', english ? 'en' : lang, '-bs', '5', '-t', String(Math.max(2, Math.min(8, cpus().length - 2))),
    '--prompt', `Vocabulary: ${hints.slice(0, 40).join(', ')}.`];
  const { stdout } = await run(setup.cli, args, { signal, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  return cleanWhisper(stdout);
}

export interface DictationRequest { language: string; /** The pass after the user stopped (not a live preview). */ final: boolean; hints: string[] }

export async function transcribeOnMac(file: File, request: DictationRequest, signal: AbortSignal) {
  const directory = await mkdtemp(join(tmpdir(), 'marion-speech-'));
  try {
    const audio = join(directory, 'recording.wav');
    await writeFile(audio, Buffer.from(await file.arrayBuffer()), { mode: 0o600 });
    // Live previews want speed (Apple); the final pass wants accuracy (Whisper when installed). Either falls back to the other.
    const order = request.final && whisperSetup() ? ['whisper', 'apple'] as const : ['apple', 'whisper'] as const;
    let failure: unknown;
    for (const engine of order) {
      if (engine === 'apple' ? !helper : !whisperSetup()) continue;
      try {
        const text = engine === 'whisper' ? await transcribeWithWhisper(audio, request.language, request.hints, signal) : await transcribeWithApple(audio, request.language, request.hints, signal);
        // A whisper pass that hears nothing is trusted only if Apple is unavailable; otherwise ask Apple too.
        if (text || !request.final || order[order.length - 1] === engine) return text;
      } catch (error) {
        if (isExpectedAbort(error, signal)) throw error;
        failure = error;
        console.warn(`[voice] ${engine} dictation failed${order.length > 1 ? ', trying the other engine' : ''}:`, (error as { stderr?: string }).stderr?.trim() || (error as Error).message);
      }
    }
    throw failure ?? new Error('Built-in dictation is unavailable.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function speakOnMac(text: string, speed: number, signal: AbortSignal, voice?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'marion-voice-'));
  try {
    const source = join(directory, 'reply.txt');
    const audio = join(directory, 'reply.wav');
    await writeFile(source, text, { mode: 0o600 });
    await run('/usr/bin/say', [...(voice ? ['-v', voice] : []), '-f', source, '-o', audio, '--file-format=WAVE', '--data-format=LEI16@24000',
      '-r', String(Math.round(175 * speed))], { signal, timeout: 30_000 });
    return await readFile(audio);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
