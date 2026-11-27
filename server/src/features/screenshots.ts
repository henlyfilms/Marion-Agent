import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { screenshotLocation } from './folders.js';

/**
 * The owner's own screenshots (the Mac's Screenshot app folder) for the quick picker in the chat box.
 * Only image files directly inside that one folder are ever listed or served, and only by bare file name.
 */
const runFile = promisify(execFile);

const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
/** The Desktop is the Screenshot app's default home and holds other pictures too, so there only screenshot-looking names count. */
const SCREENSHOT_NAME = /^(screenshot|screen shot|cleanshot|shottr|snip)/i;
const MAX_BYTES = 40 * 1024 * 1024;
const MAX_LIMIT = 60;
const HOUR = 60 * 60 * 1000;

export interface ScreenshotEntry { name: string; at: number; size: number }
/** `total` counts what the query matches; `pastHour` counts every screenshot from the last 60 minutes. */
export interface ScreenshotPage { folder: string; items: ScreenshotEntry[]; total: number; pastHour: number }

const isCandidate = (name: string, dedicated: boolean) =>
  !name.startsWith('.') && extname(name).toLowerCase() in TYPES && (dedicated || SCREENSHOT_NAME.test(name));

/** Newest first. `offset`/`limit` page through the whole history, or only screenshots taken at or after `since` (ms). */
export async function listScreenshots(limit: number, offset: number, since?: number, now = Date.now()): Promise<ScreenshotPage> {
  const { dir, dedicated } = await screenshotLocation();
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter(entry => entry.isFile() && isCandidate(entry.name, dedicated)).map(entry => entry.name);
  const dated = (await Promise.all(names.map(async name => {
    const info = await lstat(join(dir, name)).catch(() => null);
    return info?.isFile() && info.size > 0 && info.size <= MAX_BYTES ? { name, at: Math.round(info.mtimeMs), size: info.size } : null;
  }))).filter((entry): entry is ScreenshotEntry => entry !== null)
    .sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
  const pastHour = dated.filter(entry => entry.at >= now - HOUR).length;
  const matching = since !== undefined && Number.isFinite(since) ? dated.filter(entry => entry.at >= since) : dated;
  const start = Math.max(0, Math.floor(offset) || 0);
  const count = Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit) || 3));
  return { folder: basename(dir) || dir, items: matching.slice(start, start + count), total: matching.length, pastHour };
}

/** Resolves a bare file name inside the screenshot folder to a real path, or null for anything else. */
async function resolveScreenshot(name: string) {
  const { dir, dedicated } = await screenshotLocation();
  if (!name || name !== basename(name) || !isCandidate(name, dedicated)) return null;
  const folder = await realpath(dir).catch(() => null);
  if (!folder) return null;
  const file = join(folder, name);
  // Do not serve symlinks (including links to other files in the same folder).
  if (dirname(file) !== folder) return null;
  const info = await lstat(file).catch(() => null);
  return info?.isFile() && info.size > 0 && info.size <= MAX_BYTES ? { file, size: info.size, at: info.mtimeMs, type: TYPES[extname(name).toLowerCase()] } : null;
}

export interface ScreenshotImage { body: Buffer; type: string; at: number }

/** The picture itself, or a small JPEG preview (macOS `sips`) so a grid of retina screenshots stays light. */
export async function screenshotImage(name: string, thumbnail: boolean): Promise<ScreenshotImage | null> {
  const found = await resolveScreenshot(name);
  if (!found) return null;
  if (thumbnail && process.platform === 'darwin') {
    const cacheDir = join(tmpdir(), 'marion-screenshot-previews');
    const out = join(cacheDir, `${createHash('sha1').update(`${found.file}:${found.at}:${found.size}`).digest('hex')}.jpg`);
    try {
      await mkdir(cacheDir, { recursive: true });
      if (!(await stat(out).catch(() => null))) {
        await runFile('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '-Z', '560', found.file, '--out', out], { timeout: 15_000 });
      }
      return { body: await readFile(out), type: 'image/jpeg', at: found.at };
    } catch { /* Fall back to the original below. */ }
  }
  return { body: await readFile(found.file), type: found.type, at: found.at };
}
