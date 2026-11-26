import { db, now } from '../db.js';
import { getBotRow } from '../store.js';
import { archiveCalls, archiveExists, writeDeletedArchive } from './deleted-archive.js';
import { LifeToolMissing, hasLifeKey, lifeKey, lifeLinkSettings, lifeTool } from './life-link.js';

/**
 * What Marion Agent tells Marion Life besides chat copies, through the same revocable key and address:
 *
 *  - save_agent_sessions: a short record of every finished Claude run (title, summary, status, bot/chat/folder).
 *  - archive_deleted_item: every deleted chat or bot with its full data, for Life's "Deleted" folder.
 *
 * Both go through one local queue (table life_outbox). Nothing is lost when Life is off, unreachable, or has not
 * added the tool yet: rows wait and are retried with a back-off. The wire format is written down in
 * docs/MARION-LIFE-CONTRACT.md.
 */

export type SessionKind = import('../types.js').RelayKind;

/** What a caller knows about a Claude run it is about to start. */
export interface SessionTrack {
  /** Stable id: repeated finishes with the same id update one record (e.g. every step of one chat turn). */
  id: string;
  kind: SessionKind;
  userId: string;
  botId: string;
  /** The owner's request in plain words (not the long wrapped prompt). */
  request: string;
  title?: string;
  folder?: { path: string; label: string };
  /** Orchestration role or team member this run played. */
  role?: string;
  /** Narrower worker assignment, when the owner goal belongs to the entire team. */
  handoffTask?: string;
  agent?: string;
  groupId?: string;
  /** Why this run started a fresh provider session instead of continuing the last one (shown in Marion Agent's Sessions). */
  rotated?: string | null;
}

export interface SessionFinish {
  status: 'completed' | 'failed' | 'stopped';
  reply?: string;
  error?: string;
  startedAt: number;
  endedAt: number;
  model?: { id: string; label?: string; effort?: string | null };
  tokens?: { input?: number; output?: number };
}

const MAX_BATCH = 60_000;
const MAX_SESSIONS_PER_CALL = 20;
const SESSION_KEEP_MS = 90 * 24 * 3600_000;
const UNSENT_SESSION_KEEP_MS = 30 * 24 * 3600_000;

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** A short, readable summary of a reply: the opening plus the closing words (where CLIs put "what I did"). */
export function summarizeReply(reply: string, max = 700) {
  const text = reply.replace(/```[\s\S]*?```/g, ' [code] ').replace(/[#*_`>]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const head = text.slice(0, 240);
  const tail = text.slice(-(max - 245));
  return `${head.slice(0, head.lastIndexOf(' ') > 150 ? head.lastIndexOf(' ') : head.length)} … ${tail.slice(tail.indexOf(' ') + 1)}`;
}

export function sessionTitle(request: string, given?: string) {
  const line = (given?.trim() || request.split('\n').find(part => part.trim()) || 'Claude session').replace(/\s+/g, ' ').trim();
  return line.length > 90 ? `${line.slice(0, 89).trimEnd()}…` : line;
}

// ---------- queue ----------

interface OutboxRow { id: string; user_id: string; kind: string; payload: string; created_at: number; attempts: number; sent_at: number | null }

function enqueue(userId: string, id: string, kind: string, payload: unknown) {
  const at = now();
  db.prepare(`INSERT INTO life_outbox(id,user_id,kind,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at, sent_at=NULL, next_attempt_at=0, attempts=0, last_error=NULL`)
    .run(id, userId, kind, JSON.stringify(payload), at, at);
  scheduleDrain(userId);
}

const timers = new Map<string, NodeJS.Timeout>();
function scheduleDrain(userId: string) {
  if (timers.has(userId)) return;
  const timer = setTimeout(() => { timers.delete(userId); void drainLifeOutbox(userId).catch(() => {}); }, 3000);
  timer.unref?.();
  timers.set(userId, timer);
}

// ---------- Claude session summaries ----------

/** Record that a Claude run finished. Never throws: Marion Life is a copy, it must not break the run itself. */
export function recordSessionEnd(track: SessionTrack, finish: SessionFinish) {
  try {
    const bot = getBotRow(track.botId) as { name: string; label: string; generation: number; user_id: string } | undefined;
    const id = `session:${track.id}`;
    const previous = db.prepare('SELECT payload FROM life_outbox WHERE id=?').get(id) as { payload: string } | undefined;
    const before = previous ? JSON.parse(previous.payload) : null;
    const summary = finish.reply ? summarizeReply(finish.reply) : before?.summary ?? '';
    const record = {
      id: `marion-agent:${track.id}`,
      source: 'marion_agent',
      provider: 'claude',
      kind: track.kind,
      title: before?.title ?? sessionTitle(track.request, track.title),
      summary: finish.status === 'completed' ? summary : (summary || oneLine(finish.error ?? 'No reply.', 300)),
      request: before?.request ?? oneLine(track.request, 1500),
      status: finish.status,
      error: finish.status === 'completed' ? null : oneLine(finish.error ?? '', 300) || null,
      started_at: new Date(before ? Date.parse(before.started_at) : finish.startedAt).toISOString(),
      ended_at: new Date(finish.endedAt).toISOString(),
      duration_ms: Math.max(0, finish.endedAt - (before ? Date.parse(before.started_at) : finish.startedAt)),
      calls: (before?.calls ?? 0) + 1,
      model: finish.model?.id ?? before?.model ?? null,
      model_label: finish.model?.label ?? before?.model_label ?? null,
      effort: finish.model?.effort ?? before?.effort ?? null,
      tokens: finish.tokens ? { input: (before?.tokens?.input ?? 0) + (finish.tokens.input ?? 0), output: (before?.tokens?.output ?? 0) + (finish.tokens.output ?? 0) } : before?.tokens ?? null,
      marion_bot_id: track.botId,
      bot_name: bot?.name?.slice(0, 80) ?? null,
      ...(bot?.label ? { bot_job: bot.label.slice(0, 200) } : {}),
      chat_id: bot ? `${track.botId}:${bot.generation}` : null,
      chat_generation: bot?.generation ?? null,
      folder: track.folder ? { name: track.folder.label, path: track.folder.path } : null,
      role: track.role ?? null,
      agent: track.agent ?? null,
      group_id: track.groupId ?? null,
    };
    enqueue(track.userId, id, 'session', record);
  } catch (error) {
    console.warn('[life-outbox] could not record a session summary', (error as Error).message);
  }
}

// ---------- deleted chats and bots ----------

/** Archive a just-deleted chat/bot locally and queue it for Marion Life. Never throws. */
export function archiveDeletedBot(userId: string, botId: string, by: 'sidebar' | 'agent_tool' | 'api' | 'startup_backfill') {
  try {
    const result = writeDeletedArchive(botId, by);
    if (!result) return;
    // Already archived and queued (or sent) for this very deletion: never send it twice.
    if (db.prepare('SELECT 1 FROM life_outbox WHERE id=?').get(`deleted:${result.id}`)) return;
    enqueue(userId, `deleted:${result.id}`, 'deleted', { archive_id: result.id, next_part: 0 });
  } catch (error) {
    console.warn('[life-outbox] could not archive a deleted chat', (error as Error).message);
  }
}

/** The owner restored it in Marion Agent: tell Life so its Deleted folder can say so (the copy is kept). */
export function noteRestoredBot(userId: string, botId: string, deletedAt: number | null | undefined) {
  if (deletedAt == null) return;
  try {
    const id = `${botId}:${deletedAt}`;
    if (!archiveExists(id)) return;
    enqueue(userId, `restored:${id}`, 'restored', { archive_id: id, status: 'restored', restored_at: new Date().toISOString() });
  } catch (error) {
    console.warn('[life-outbox] could not note a restore', (error as Error).message);
  }
}

/** Deleted chats from before the archive existed (still in "Recently deleted") get archived once. */
export function backfillDeletedArchives() {
  const rows = db.prepare('SELECT id, user_id FROM bots WHERE deleted_at IS NOT NULL').all() as { id: string; user_id: string }[];
  for (const row of rows) archiveDeletedBot(row.user_id, row.id, 'startup_backfill');
}

// ---------- sending ----------

const draining = new Set<string>();

function retryLater(rows: OutboxRow[], error: unknown) {
  const missing = error instanceof LifeToolMissing;
  const message = missing ? 'Marion Life has not turned on this feature yet. It will be sent once it does.' : String((error as Error)?.message ?? error).slice(0, 300);
  for (const row of rows) {
    const wait = missing ? 30 * 60_000 : Math.min(60 * 60_000, 30_000 * 2 ** Math.min(row.attempts, 7));
    db.prepare('UPDATE life_outbox SET attempts=attempts+1, next_attempt_at=?, last_error=? WHERE id=?').run(now() + wait, message, row.id);
  }
}

const markSent = (ids: string[]) => {
  const stmt = db.prepare('UPDATE life_outbox SET sent_at=?, last_error=NULL WHERE id=?');
  for (const id of ids) stmt.run(now(), id);
};

/**
 * Send everything that is waiting. `manual` (Sync now) ignores back-off and the auto-sync switch; the timer respects both.
 * Stops at the first network/server failure (nothing else would get through either) but keeps going when only one
 * tool is missing on Life's side.
 */
export async function drainLifeOutbox(userId: string, opts: { manual?: boolean } = {}) {
  const settings = lifeLinkSettings(userId);
  const key = lifeKey(userId);
  if (!settings.enabled || !key || draining.has(userId) || (!opts.manual && !settings.autoSync)) return { sent: 0 };
  draining.add(userId);
  let sent = 0;
  try {
    prune();
    const rows = db.prepare(`SELECT * FROM life_outbox WHERE user_id=? AND sent_at IS NULL AND next_attempt_at<=? ORDER BY created_at LIMIT 300`)
      .all(userId, opts.manual ? Number.MAX_SAFE_INTEGER : now()) as OutboxRow[];

    // Claude session summaries: batched under Life's 64 KB request limit.
    const sessions = rows.filter(row => row.kind === 'session');
    for (let index = 0; index < sessions.length;) {
      const batch: OutboxRow[] = [];
      let size = 0;
      while (index < sessions.length && batch.length < MAX_SESSIONS_PER_CALL && (!batch.length || size + sessions[index].payload.length < MAX_BATCH)) {
        size += sessions[index].payload.length;
        batch.push(sessions[index++]);
      }
      try {
        await lifeTool(settings.endpoint, key, 'save_agent_sessions', { sessions: batch.map(row => JSON.parse(row.payload)) });
        markSent(batch.map(row => row.id));
        sent += batch.length;
      } catch (error) {
        retryLater(batch, error);
        if (error instanceof LifeToolMissing) break; // the same tool is missing for the rest of the sessions too
        return { sent };
      }
    }

    // Deleted chats and bots (part by part, remembering how far each one got), then restores.
    for (const row of rows.filter(item => item.kind === 'deleted')) {
      const state = JSON.parse(row.payload) as { archive_id: string; next_part: number };
      try {
        const calls = archiveCalls(state.archive_id);
        for (; state.next_part < calls.length; state.next_part++) {
          await lifeTool(settings.endpoint, key, 'archive_deleted_item', calls[state.next_part]);
          db.prepare('UPDATE life_outbox SET payload=? WHERE id=?').run(JSON.stringify(state), row.id);
        }
        markSent([row.id]);
        sent++;
      } catch (error) {
        db.prepare('UPDATE life_outbox SET payload=? WHERE id=?').run(JSON.stringify(state), row.id);
        retryLater([row], error);
        if (error instanceof LifeToolMissing) break;
        return { sent };
      }
    }
    for (const row of rows.filter(item => item.kind === 'restored')) {
      // A restore only means something after Life has the deletion.
      const archiveId = (JSON.parse(row.payload) as { archive_id: string }).archive_id;
      const waiting = db.prepare('SELECT 1 FROM life_outbox WHERE id=? AND sent_at IS NULL').get(`deleted:${archiveId}`);
      if (waiting) continue;
      try {
        await lifeTool(settings.endpoint, key, 'archive_deleted_item', JSON.parse(row.payload));
        markSent([row.id]);
        sent++;
      } catch (error) {
        retryLater([row], error);
        if (error instanceof LifeToolMissing) break;
        return { sent };
      }
    }
    return { sent };
  } finally {
    draining.delete(userId);
  }
}

function prune() {
  db.prepare('DELETE FROM life_outbox WHERE sent_at IS NOT NULL AND kind=? AND sent_at<?').run('session', now() - SESSION_KEEP_MS);
  db.prepare('DELETE FROM life_outbox WHERE sent_at IS NOT NULL AND kind=? AND sent_at<?').run('restored', now() - SESSION_KEEP_MS);
  db.prepare('DELETE FROM life_outbox WHERE sent_at IS NULL AND kind=? AND created_at<?').run('session', now() - UNSENT_SESSION_KEEP_MS);
}

/** For Settings → Marion Life: how much is waiting, and why. */
export function outboxStatus(userId: string) {
  const count = (where: string) => (db.prepare(`SELECT COUNT(*) n FROM life_outbox WHERE user_id=? AND ${where}`).get(userId) as { n: number }).n;
  const last = db.prepare('SELECT last_error FROM life_outbox WHERE user_id=? AND sent_at IS NULL AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1').get(userId) as { last_error: string } | undefined;
  return {
    pendingSessions: count("sent_at IS NULL AND kind='session'"),
    sentSessions: count("sent_at IS NOT NULL AND kind='session'"),
    pendingDeleted: count("sent_at IS NULL AND kind IN ('deleted','restored')"),
    sentDeleted: count("sent_at IS NOT NULL AND kind='deleted'"),
    lastError: last?.last_error ?? null,
  };
}

/** Every minute, retry what is waiting for each linked workspace. */
export function startLifeOutbox() {
  const timer = setInterval(() => {
    const users = db.prepare('SELECT DISTINCT user_id FROM life_outbox WHERE sent_at IS NULL').all() as { user_id: string }[];
    for (const { user_id } of users) if (hasLifeKey(user_id)) void drainLifeOutbox(user_id).catch(() => {});
  }, 60_000);
  timer.unref?.();
  setTimeout(() => { try { backfillDeletedArchives(); } catch (error) { console.warn('[life-outbox] backfill failed', (error as Error).message); } }, 6000).unref?.();
}
