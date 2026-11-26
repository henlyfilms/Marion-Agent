import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { db, now } from '../db.js';
import { env } from '../env.js';
import { newId } from '../lib/ids.js';
import { agentSettings } from './agent-settings.js';

/**
 * Teach-by-recording history. Every recording is saved as soon as it stops (key frames + narration),
 * so closing the window by accident loses nothing. Kept for Settings → General → "Keep recordings"
 * days (7 by default), then removed.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS teach_recordings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  narration TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  seconds INTEGER NOT NULL DEFAULT 0,
  frames TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'screen',
  created_at INTEGER NOT NULL
);
`);

const root = () => join(dirname(env.dbPath), 'recordings');
export interface RecordingFrame { name: string; at: number }
export interface Recording { id: string; botId: string; title: string; narration: string; notes: string; seconds: number; frames: RecordingFrame[]; source: 'screen' | 'upload'; createdAt: number; expiresAt: number }

const toRecording = (row: any, keepDays: number): Recording => ({
  id: row.id, botId: row.bot_id, title: row.title, narration: row.narration, notes: row.notes, seconds: row.seconds,
  frames: JSON.parse(row.frames), source: row.source === 'upload' ? 'upload' : 'screen', createdAt: row.created_at, expiresAt: row.created_at + keepDays * 86_400_000,
});

export async function saveRecording(userId: string, botId: string, input: { title: string; narration: string; notes: string; seconds: number; source: string; frames: { data: Buffer; at: number; ext: string }[]; id?: string }) {
  const existing = input.id ? db.prepare('SELECT id FROM teach_recordings WHERE id=? AND user_id=?').get(input.id, userId) as { id: string } | undefined : undefined;
  const id = existing?.id ?? newId('rec');
  const folder = join(root(), id);
  let frames: RecordingFrame[] = existing ? JSON.parse((db.prepare('SELECT frames FROM teach_recordings WHERE id=?').get(id) as any).frames) : [];
  if (input.frames.length) {
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { recursive: true, mode: 0o700 });
    frames = [];
    for (const [index, frame] of input.frames.entries()) {
      const name = `${index + 1}.${frame.ext}`;
      await writeFile(join(folder, name), frame.data, { mode: 0o600 });
      frames.push({ name, at: frame.at });
    }
  }
  db.prepare(`INSERT INTO teach_recordings(id,user_id,bot_id,title,narration,notes,seconds,frames,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, narration=excluded.narration, notes=excluded.notes, frames=excluded.frames`)
    .run(id, userId, botId, input.title, input.narration, input.notes, input.seconds, JSON.stringify(frames), input.source === 'upload' ? 'upload' : 'screen', now());
  return id;
}

export async function listRecordings(userId: string, botId?: string) {
  await purgeRecordings(userId);
  const keep = agentSettings(userId).recordingDays;
  const rows = botId
    ? db.prepare('SELECT * FROM teach_recordings WHERE user_id=? AND bot_id=? ORDER BY created_at DESC LIMIT 50').all(userId, botId)
    : db.prepare('SELECT * FROM teach_recordings WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(userId);
  return (rows as any[]).map(row => toRecording(row, keep));
}

export async function recordingFrame(userId: string, id: string, name: string) {
  if (!/^\d{1,2}\.(jpg|png)$/.test(name)) return null;
  const row = db.prepare('SELECT id FROM teach_recordings WHERE id=? AND user_id=?').get(id, userId);
  if (!row) return null;
  return readFile(join(root(), id, name)).catch(() => null);
}

export async function deleteRecording(userId: string, id: string) {
  const row = db.prepare('SELECT id FROM teach_recordings WHERE id=? AND user_id=?').get(id, userId) as { id: string } | undefined;
  if (!row) return false;
  db.prepare('DELETE FROM teach_recordings WHERE id=?').run(row.id);
  await rm(join(root(), row.id), { recursive: true, force: true });
  return true;
}

export async function clearRecordings(userId: string) {
  const rows = db.prepare('SELECT id FROM teach_recordings WHERE user_id=?').all(userId) as { id: string }[];
  for (const row of rows) await deleteRecording(userId, row.id);
  return rows.length;
}

export async function purgeRecordings(userId: string) {
  const cutoff = now() - agentSettings(userId).recordingDays * 86_400_000;
  const old = db.prepare('SELECT id FROM teach_recordings WHERE user_id=? AND created_at<?').all(userId, cutoff) as { id: string }[];
  for (const row of old) await deleteRecording(userId, row.id);
}
