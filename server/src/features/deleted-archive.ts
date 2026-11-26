import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { env } from '../env.js';

/**
 * The "Deleted" archive. When a chat or bot is deleted, everything about it is written to
 * <app data>/Deleted/<bot id>-<deleted at>/ (archive.json plus its attachment files) BEFORE anything else can go
 * wrong. That local copy is the fallback: it exists whether or not Marion Life is linked or reachable, and it is
 * never removed when Marion Agent's own 30-day recovery window ends. life-outbox.ts then sends it to Marion Life
 * (tool archive_deleted_item, see docs/MARION-LIFE-CONTRACT.md) so Life can show it in a "Deleted" folder.
 */

export const ARCHIVE_SCHEMA = 'marion-agent.deleted-item.v1';
const RESTORE_WINDOW_MS = 30 * 24 * 3600_000;
/** Life accepts up to 640 KB per call; stay under it. */
const MAX_PART = 560_000;

export const deletedRoot = () => path.join(path.dirname(env.dbPath), 'Deleted');
export const archiveId = (botId: string, deletedAt: number) => `${botId}:${deletedAt}`;
const dirFor = (id: string) => path.join(deletedRoot(), id.replace(/[^\w.-]+/g, '-'));
export const archiveExists = (id: string) => fs.existsSync(path.join(dirFor(id), 'archive.json'));

const safeName = (name: string) => name.replace(/[^\w.() -]+/g, '_').slice(0, 80) || 'file';
const rowsOf = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as Record<string, any>[];
const parse = (text: string) => { try { return JSON.parse(text); } catch { return null; } };

export interface ArchiveResult { id: string; dir: string; created: boolean }

/** Write the full local archive for a deleted bot/chat. Idempotent for the same deletion. */
export function writeDeletedArchive(botId: string, by: string): ArchiveResult | null {
  const bot = db.prepare('SELECT * FROM bots WHERE id=?').get(botId) as Record<string, any> | undefined;
  if (!bot || bot.deleted_at == null) return null;
  const id = archiveId(botId, bot.deleted_at);
  const dir = dirFor(id);
  if (archiveExists(id)) return { id, dir, created: false };
  fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true, mode: 0o700 });

  const generations = rowsOf('SELECT DISTINCT generation FROM rows WHERE bot_id=? ORDER BY generation', botId).map(r => r.generation as number);
  const chats = generations.map(generation => {
    const rows = rowsOf('SELECT seq, kind, created_at, body FROM rows WHERE bot_id=? AND generation=? ORDER BY seq', botId, generation)
      .map(r => ({ seq: r.seq, kind: r.kind, created_at: r.created_at, body: parse(r.body) ?? r.body }));
    const attachments = rowsOf('SELECT id, seq, name, mime, data FROM message_attachments WHERE bot_id=? AND generation=?', botId, generation).map(a => {
      const file = `${a.id}-${safeName(a.name)}`;
      fs.writeFileSync(path.join(dir, 'attachments', file), a.data as Buffer, { mode: 0o600 });
      return { id: a.id, seq: a.seq, name: a.name, mime: a.mime, size: (a.data as Buffer).length, file: `attachments/${file}` };
    });
    return { generation, rows, attachments };
  });

  const archive = {
    schema: ARCHIVE_SCHEMA,
    archive_id: id,
    item_type: 'bot' as const,
    deleted_at: new Date(bot.deleted_at).toISOString(),
    deleted_by: by,
    restore_until: new Date(bot.deleted_at + RESTORE_WINDOW_MS).toISOString(),
    marion_bot_id: botId,
    bot,
    memories: rowsOf('SELECT * FROM memories WHERE bot_id=? ORDER BY created_at', botId),
    skills: rowsOf('SELECT * FROM skills WHERE bot_id=? ORDER BY created_at', botId),
    routines: rowsOf('SELECT * FROM routines WHERE bot_id=? ORDER BY created_at', botId),
    tasks: rowsOf('SELECT * FROM tasks WHERE bot_id=? ORDER BY created_at', botId),
    chats,
  };
  // Write to a temp file first so a crash never leaves a half-written archive that looks complete.
  const temp = path.join(dir, 'archive.json.tmp');
  fs.writeFileSync(temp, JSON.stringify(archive), { mode: 0o600 });
  fs.renameSync(temp, path.join(dir, 'archive.json'));
  return { id, dir, created: true };
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** The calls to send to Marion Life for one archive: part 0 is the bot, parts 1..n are its chats (one per generation). */
export function archiveCalls(id: string): Record<string, unknown>[] {
  const archive = parse(fs.readFileSync(path.join(dirFor(id), 'archive.json'), 'utf8'));
  if (!archive) throw new Error('The local archive could not be read.');
  const { bot } = archive;
  const chats = (archive.chats as any[]).filter(chat => chat.rows.some((row: any) => row.kind === 'message'));
  const parts = 1 + chats.length;

  const head: Record<string, unknown> = {
    archive_id: id, status: 'deleted', part: 0, parts,
    item_type: 'bot', deleted_at: archive.deleted_at, deleted_by: archive.deleted_by, restore_until: archive.restore_until,
    marion_bot_id: archive.marion_bot_id,
    name: bot.name, job: bot.label || null, description: bot.description || '', kind: bot.kind ?? 'agent',
    instructions: bot.instructions || '',
    profile: Object.fromEntries(Object.entries(bot).filter(([key]) => !['instructions', 'avatar_image'].includes(key))),
    avatar_image: bot.avatar_image ?? null,
    memories: archive.memories, skills: archive.skills, routines: archive.routines, tasks: archive.tasks,
    chat_count: chats.length,
    message_count: chats.reduce((sum, chat) => sum + chat.rows.filter((row: any) => row.kind === 'message').length, 0),
  };
  // A bot with a huge pile of memories or skills still fits in one call: keep the newest and say so.
  for (const key of ['memories', 'skills', 'routines', 'tasks']) {
    while (bytes(head) > MAX_PART && (head[key] as any[]).length > 1) {
      head[key] = (head[key] as any[]).slice(-Math.ceil((head[key] as any[]).length / 2));
      head.truncated = true;
    }
  }
  const calls: Record<string, unknown>[] = [head];

  chats.forEach((chat, index) => {
    const attachments = chat.attachments as { seq: number; name: string; mime: string; size: number }[];
    const messages = (chat.rows as any[]).filter(row => row.kind === 'message' && row.body?.text && !row.body.streaming).map(row => ({
      seq: row.seq,
      role: row.body.role,
      ...(row.body.from ? { from: row.body.from } : {}),
      text: String(row.body.text),
      at: new Date(row.created_at).toISOString(),
      attachments: attachments.filter(a => a.seq === row.seq).map(({ name, mime, size }) => ({ name, mime, size })),
    }));
    const firstUser = messages.find(m => m.role === 'user' && (!m.from || m.from.kind === 'voice'));
    const transcriptOf = (list: typeof messages) => list.map(m => {
      const who = m.from?.kind === 'voice' ? 'You (call)' : m.from?.name ?? (m.role === 'assistant' ? bot.name : 'You');
      const files = m.attachments.length ? `\nAttachments: ${m.attachments.map(a => a.name).join(', ')}` : '';
      return `[${m.at}] ${who}:\n${m.text}${files}`;
    }).join('\n\n');
    const part: Record<string, unknown> = {
      archive_id: id, status: 'deleted', part: index + 1, parts, item_type: 'bot', marion_bot_id: archive.marion_bot_id,
      chat: {
        id: `${archive.marion_bot_id}:${chat.generation}`, generation: chat.generation,
        title: (firstUser?.text ?? `Chat with ${bot.name}`).replace(/\s+/g, ' ').slice(0, 500),
        started_at: messages[0]?.at ?? null, last_message_at: messages.at(-1)?.at ?? null,
        message_count: messages.length, truncated: false,
        transcript: '', messages,
      },
    };
    const body = part.chat as { messages: typeof messages; transcript: string; truncated: boolean; message_count: number };
    // Oldest messages go first if a chat is too big for one call (the local archive always keeps everything).
    let kept = messages;
    body.transcript = transcriptOf(kept);
    while (bytes(part) > MAX_PART && kept.length > 1) {
      kept = kept.slice(Math.ceil(kept.length * 0.2));
      body.messages = kept;
      body.transcript = transcriptOf(kept);
      body.truncated = true;
    }
    calls.push(part);
  });
  return calls;
}
