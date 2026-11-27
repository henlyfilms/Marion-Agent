import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { isVideoMime, type UploadedAttachment } from './attachments.js';
import { newId } from './lib/ids.js';

/**
 * No chat provider accepts a video file, so a dropped screen recording is sampled into a few still
 * frames (ffmpeg) that go to the model like screenshots. Claude gets them as images, Codex as local
 * images and Gemini as files in its working folder, the same way photos already travel.
 */

const run = promisify(execFile);
const MAX_FRAMES_TOTAL = 12;
const MIN_FRAMES = 3;
const FRAME_WIDTH = 1280;

export function ffmpegPath(name: 'ffmpeg' | 'ffprobe' = 'ffmpeg') {
  const folders = [...(process.env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')];
  for (const folder of new Set(folders.filter(folder => folder.startsWith('/')))) {
    const candidate = join(folder, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* try the next folder */ }
  }
}

/** Seconds at which to sample: evenly spread, away from the very first and last instant. */
export function sampleTimes(duration: number, count: number) {
  if (!(duration > 0) || count < 1) return [0];
  return Array.from({ length: count }, (_, index) => Math.round(duration * ((index + 0.5) / count) * 10) / 10);
}

const framesCache = new Map<string, Promise<VideoFrames>>();

export interface VideoFrames { frames: UploadedAttachment[]; seconds: number; times: number[]; error?: string }

async function sample(video: UploadedAttachment, count: number): Promise<VideoFrames> {
  const ffmpeg = ffmpegPath('ffmpeg');
  if (!ffmpeg) return { frames: [], seconds: 0, times: [], error: 'ffmpeg is not installed, so the recording could not be sampled (brew install ffmpeg).' };
  const dir = await mkdtemp(join(tmpdir(), 'marion-video-'));
  try {
    const source = join(dir, 'source' + (video.mime === 'video/webm' ? '.webm' : video.mime === 'video/quicktime' ? '.mov' : '.mp4'));
    await writeFile(source, video.data, { mode: 0o600 });
    const probe = ffmpegPath('ffprobe');
    let seconds = 0;
    if (probe) {
      const { stdout } = await run(probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', source], { timeout: 15_000 }).catch(() => ({ stdout: '' }));
      seconds = Number.parseFloat(String(stdout).trim()) || 0;
    }
    const times = sampleTimes(seconds, seconds > 0 ? count : 1);
    const frames: UploadedAttachment[] = [];
    const kept: number[] = [];
    for (const [index, at] of times.entries()) {
      const out = join(dir, `frame-${index + 1}.jpg`);
      await run(ffmpeg, ['-v', 'error', '-ss', String(at), '-i', source, '-frames:v', '1', '-vf', `scale='min(${FRAME_WIDTH},iw)':-2`, '-q:v', '4', '-y', out], { timeout: 30_000 }).catch(() => undefined);
      const data = await readFile(out).catch(() => null);
      if (!data?.length) continue;
      frames.push({ id: newId('img'), name: `${video.name.replace(/\.[^.]+$/, '')} frame ${frames.length + 1}.jpg`, mime: 'image/jpeg', size: data.length, data });
      kept.push(at);
    }
    if (!frames.length) {
      // Some short clips fail a seek: fall back to the first frame.
      const out = join(dir, 'first.jpg');
      await run(ffmpeg, ['-v', 'error', '-i', source, '-frames:v', '1', '-vf', `scale='min(${FRAME_WIDTH},iw)':-2`, '-q:v', '4', '-y', out], { timeout: 30_000 }).catch(() => undefined);
      const data = await readFile(out).catch(() => null);
      if (data?.length) { frames.push({ id: newId('img'), name: `${video.name} frame 1.jpg`, mime: 'image/jpeg', size: data.length, data }); kept.push(0); }
    }
    return frames.length ? { frames, seconds, times: kept } : { frames, seconds, times: [], error: 'The recording could not be decoded into frames.' };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Frames for one video, cached by file id so approvals, retries and relays don't decode it again. */
export function videoFrames(video: UploadedAttachment, count = 8): Promise<VideoFrames> {
  const key = `${video.id}:${count}`;
  let found = framesCache.get(key);
  if (!found) {
    found = sample(video, count).catch((error): VideoFrames => ({ frames: [], seconds: 0, times: [], error: String((error as Error).message ?? error).slice(0, 200) }));
    framesCache.set(key, found);
    if (framesCache.size > 8) framesCache.delete(framesCache.keys().next().value!);
  }
  return found;
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;

/**
 * Turn the screen recordings in `files` into frames. Returns the files a model can look at (photos plus
 * frames) and one line telling it what the frames are. Recordings themselves are not forwarded.
 */
export async function lookableMedia(files: UploadedAttachment[], limit = MAX_FRAMES_TOTAL): Promise<{ images: UploadedAttachment[]; note: string }> {
  const videos = files.filter(file => isVideoMime(file.mime));
  const stills = files.filter(file => file.mime.startsWith('image/'));
  const notes: string[] = [];
  const images: UploadedAttachment[] = [...stills];
  if (stills.length) notes.push(`${stills.length} screenshot${stills.length === 1 ? '' : 's'}`);
  const room = Math.max(0, limit - stills.length);
  const each = videos.length ? Math.max(MIN_FRAMES, Math.floor(room / videos.length)) : 0;
  for (const video of videos) {
    const result = await videoFrames(video, each);
    if (result.frames.length) {
      images.push(...result.frames);
      notes.push(`screen recording "${video.name}"${result.seconds ? ` (${clock(result.seconds)})` : ''} as ${result.frames.length} frame${result.frames.length === 1 ? '' : 's'} in order${result.times.length > 1 ? ` at ${result.times.map(clock).join(', ')}` : ''}`);
    } else {
      notes.push(`screen recording "${video.name}" (could not be turned into frames: ${result.error ?? 'unknown error'})`);
    }
  }
  // Every photo the user attached is kept (up to the per-message file limit); `limit` only budgets recording frames.
  return { images, note: notes.length ? `Attached by the user: ${notes.join('; ')}. The images are included with this request; look at them.` : '' };
}

/** What a chat model receives for an upload: recordings become frames (with a note saying so); everything else is unchanged. */
export async function forModel(attachments: UploadedAttachment[]): Promise<{ attachments: UploadedAttachment[]; note: string }> {
  if (!attachments.some(file => isVideoMime(file.mime))) return { attachments, note: '' };
  const { images, note } = await lookableMedia(attachments);
  return { attachments: [...attachments.filter(file => file.mime === 'text/plain'), ...images], note };
}
