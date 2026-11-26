import { execFile } from 'node:child_process';
import { mkdir, readdir, realpath, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { db } from '../db.js';
import { isDesktop } from '../lib/desktop-access.js';

/**
 * Folders on this Mac that the owner lets one bot use. The bot can list and tidy them itself, and can
 * hand one to Claude Code, Codex or Gemini (ask_subscription with `folder`), which then works inside it.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS bot_folders (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  label TEXT NOT NULL,
  write INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, path)
);
`);

export interface BotFolder { path: string; label: string; write: boolean }

const MAX_FOLDERS = 20;
const home = homedir();
/** Folders a bot may never be given: the whole home folder, system areas and app data. */
const forbidden = [home, join(home, 'Library'), join(home, '.ssh'), join(home, '.claude'), join(home, '.codex'), join(home, '.gemini')];

export function botFolders(botId: string): BotFolder[] {
  return (db.prepare('SELECT path, label, write FROM bot_folders WHERE bot_id=? ORDER BY created_at').all(botId) as any[])
    .map(row => ({ path: row.path, label: row.label, write: Boolean(row.write) }));
}

async function checkFolder(input: string) {
  if (!isDesktop) throw new Error('Folder access works in the Mac app.');
  const raw = input.trim().replace(/^~(?=$|\/)/, home);
  if (!raw || !isAbsolute(raw)) throw new Error('Choose a full folder path, like ~/Desktop/Screenshots.');
  const path = await realpath(raw).catch(() => { throw new Error('That folder doesn’t exist.'); });
  if (!(await stat(path)).isDirectory()) throw new Error('Choose a folder, not a file.');
  if (!path.startsWith(home + sep)) throw new Error('Choose a folder inside your home folder.');
  if (forbidden.some(blocked => path === blocked || (blocked !== home && path.startsWith(blocked + sep)))) {
    throw new Error('That folder holds app or system data. Choose a more specific folder.');
  }
  return path;
}

export async function addBotFolder(botId: string, input: string, label?: string, write = true): Promise<BotFolder[]> {
  const path = await checkFolder(input);
  const existing = botFolders(botId);
  if (!existing.some(folder => folder.path === path) && existing.length >= MAX_FOLDERS) throw new Error(`A bot can have up to ${MAX_FOLDERS} folders.`);
  const name = (label?.trim() || basename(path)).slice(0, 60);
  db.prepare(`INSERT INTO bot_folders(bot_id,path,label,write,created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(bot_id,path) DO UPDATE SET label=excluded.label, write=excluded.write`).run(botId, path, name, write ? 1 : 0, Date.now());
  return botFolders(botId);
}

export function updateBotFolder(botId: string, path: string, patch: { label?: string; write?: boolean }): BotFolder[] {
  const current = botFolders(botId).find(folder => folder.path === path);
  if (!current) throw new Error('That folder isn’t shared with this bot.');
  db.prepare('UPDATE bot_folders SET label=?, write=? WHERE bot_id=? AND path=?')
    .run((patch.label?.trim() || current.label).slice(0, 60), (patch.write ?? current.write) ? 1 : 0, botId, path);
  return botFolders(botId);
}

export function removeBotFolder(botId: string, path: string): BotFolder[] {
  db.prepare('DELETE FROM bot_folders WHERE bot_id=? AND path=?').run(botId, path);
  return botFolders(botId);
}

const runFile = promisify(execFile);
/** Shows the Mac's own folder picker (the app runs on this Mac). Returns null when cancelled. */
export async function pickFolder(): Promise<string | null> {
  if (!isDesktop || process.platform !== 'darwin') throw new Error('Type the folder path instead.');
  try {
    const { stdout } = await runFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a folder for this bot")'], { timeout: 300_000 });
    return stdout.trim().replace(/\/$/, '') || null;
  } catch { return null; }
}

/** The Mac's screenshot folder (Screenshot app setting, else the Desktop), for a one-tap suggestion. */
export async function screenshotFolder(): Promise<string> {
  const saved = await runFile('defaults', ['read', 'com.apple.screencapture', 'location'], { timeout: 3000 })
    .then(r => r.stdout.trim()).catch(() => '');
  return (saved || join(home, 'Desktop')).replace(/^~(?=$|\/)/, home);
}

/** Finds a shared folder by its label or path (case-insensitive label match). */
export function resolveBotFolder(botId: string, name: unknown): BotFolder {
  const folders = botFolders(botId);
  if (!folders.length) throw new Error('No folders are shared with you. The owner can add them in Bot settings → Access.');
  const wanted = String(name ?? '').trim();
  const match = folders.find(folder => folder.path === wanted || folder.path === resolve(wanted.replace(/^~(?=$|\/)/, home)))
    ?? folders.find(folder => folder.label.toLowerCase() === wanted.toLowerCase())
    ?? (folders.length === 1 && !wanted ? folders[0] : undefined);
  if (!match) throw new Error(`No shared folder called "${wanted}". Shared: ${folders.map(folder => folder.label).join(', ')}.`);
  return match;
}

/** Resolves a path inside a shared folder and refuses anything that escapes it (.., symlinks). */
async function inside(folder: BotFolder, sub: unknown, mustExist = true) {
  const root = await realpath(folder.path);
  const target = resolve(root, String(sub ?? '').replace(/^\/+/, ''));
  const real = mustExist ? await realpath(target).catch(() => { throw new Error(`Not found: ${sub}`); })
    : join(await realpath(dirname(target)).catch(() => dirname(target)), basename(target));
  if (real !== root && !real.startsWith(root + sep)) throw new Error('That path is outside the shared folder.');
  return real;
}

export async function listFolder(botId: string, args: { folder?: string; path?: string; match?: string; limit?: number }) {
  const folder = resolveBotFolder(botId, args.folder);
  const dir = await inside(folder, args.path ?? '');
  const pattern = args.match ? new RegExp(args.match.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'), 'i') : null;
  const limit = Math.min(Math.max(Number(args.limit) || 200, 1), 1000);
  const entries = (await readdir(dir, { withFileTypes: true })).filter(entry => !entry.name.startsWith('.') && (!pattern || pattern.test(entry.name)));
  const items = await Promise.all(entries.slice(0, limit).map(async entry => {
    const info = await stat(join(dir, entry.name)).catch(() => null);
    return entry.isDirectory() ? `${entry.name}/` : `${entry.name}\t${info ? Math.round(info.size / 1024) + 'KB' : ''}\t${info ? info.mtime.toISOString().slice(0, 16) : ''}`;
  }));
  return { folder: folder.label, path: relative(await realpath(folder.path), dir) || '.', total: entries.length, items };
}

export async function moveInFolder(botId: string, args: { folder?: string; moves?: { from: string; to: string }[] }) {
  const folder = resolveBotFolder(botId, args.folder);
  if (!folder.write) throw new Error(`"${folder.label}" is shared read-only.`);
  const moves = Array.isArray(args.moves) ? args.moves.slice(0, 500) : [];
  if (!moves.length) throw new Error('List the moves as {from, to} paths inside the folder.');
  const done: string[] = [];
  const failed: string[] = [];
  for (const move of moves) {
    try {
      const from = await inside(folder, move.from);
      let to = String(move.to ?? '');
      if (to.endsWith('/')) to += basename(from);
      const targetDir = dirname(resolve(await realpath(folder.path), to.replace(/^\/+/, '')));
      await inside(folder, relative(await realpath(folder.path), targetDir), false);
      await mkdir(targetDir, { recursive: true });
      const target = await inside(folder, to, false);
      if (await stat(target).then(() => true, () => false)) throw new Error('a file with that name already exists');
      await rename(from, target);
      done.push(`${move.from} → ${relative(await realpath(folder.path), target)}`);
    } catch (error) { failed.push(`${move.from}: ${(error as Error).message}`); }
  }
  return { moved: done.length, failed, done: done.slice(0, 50) };
}

/** One prompt line so the bot knows which folders it has and how to use or relay them. */
export function foldersPromptLine(botId: string) {
  const folders = botFolders(botId);
  if (!folders.length) return '';
  return `Folders on the owner's Mac shared with you: ${folders.map(folder => `"${folder.label}" (${folder.path}, ${folder.write ? 'read and write' : 'read only'})`).join('; ')}. Use folder_list and folder_move for them yourself. For work that needs looking inside files (sorting screenshots by what they show, editing documents), call ask_subscription with that folder: Claude Code, Codex or Gemini then works directly inside it. Tell them the full task; they know nothing else about it.`;
}
