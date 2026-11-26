import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const helper = process.env.MARION_NATIVE_TRANSCRIBER;
export const nativeTranscription = process.platform === 'darwin' && Boolean(helper);
export const nativePlayback = process.platform === 'darwin' && Boolean(process.env.MARION_DESKTOP_TOKEN);

export async function transcribeOnMac(file: File, language: string, signal: AbortSignal) {
  if (!helper) throw new Error('Built-in dictation is unavailable.');
  const directory = await mkdtemp(join(tmpdir(), 'marion-speech-'));
  try {
    const audio = join(directory, 'recording.wav');
    await writeFile(audio, Buffer.from(await file.arrayBuffer()), { mode: 0o600 });
    const { stdout } = await run(helper, [audio, ...(language ? [language] : [])], { signal, timeout: 120_000 });
    return stdout.trim();
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
