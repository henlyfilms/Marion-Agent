import { db, now } from '../db.js';
import { hub } from '../lib/hub.js';
import { getBotRow } from '../store.js';
import type { MarionSession, RelayKind, RelayProvider, RelayStatus, RowBody } from '../types.js';
import { sessionTitle, summarizeReply, type SessionFinish, type SessionTrack } from './life-outbox.js';
import './schema.js';

/**
 * Sessions Marion Agent can show on its own screen (not only in Marion Life):
 *
 *  - relayed agent sessions: every run sent to Claude, Codex or Gemini (ask_subscription, subscription-backed bots,
 *    orchestrate, team_delegate / team_discuss), recorded when it starts and again when it ends, in table agent_sessions;
 *  - bot chat sessions: each conversation of a bot (one per "generation"), read straight from the chat rows.
 */

const KEEP_MS = 180 * 24 * 3600_000;
const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

interface AgentSessionRow {
  id: string; user_id: string; bot_id: string; provider: RelayProvider; kind: RelayKind; title: string; summary: string; request: string;
  cloud_url: string | null; status: RelayStatus; error: string | null; chat_generation: number | null; folder_path: string | null; folder_label: string | null;
  model: string | null; model_label: string | null; effort: string | null; tokens_in: number | null; tokens_out: number | null;
  started_at: number; ended_at: number | null; duration_ms: number; calls: number; active_calls: number;
  role: string | null; agent: string | null; group_id: string | null; rotated: string | null; updated_at: number;
}

const ownerOf = (track: SessionTrack) => track.userId || (getBotRow(track.botId)?.user_id as string | undefined) || '';

const notifyChange = (userId: string, botId: string) => { if (userId) hub.emit(userId, { type: 'sessions', botId }); };

/** A run is about to start: it shows up as Running at once. Never throws (recording must not break the run). */
export function beginAgentSession(track: SessionTrack, provider: RelayProvider, startedAt = Date.now()) {
  try {
    const userId = ownerOf(track);
    const bot = getBotRow(track.botId);
    if (!userId || !bot) return;
    db.prepare(`INSERT INTO agent_sessions(id,user_id,bot_id,provider,kind,title,request,status,chat_generation,folder_path,folder_label,
        started_at,active_calls,role,agent,group_id,rotated,updated_at)
      VALUES (?,?,?,?,?,?,?,'running',?,?,?,?,1,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status='running', active_calls=active_calls+1, ended_at=NULL, updated_at=excluded.updated_at,
        error=CASE WHEN agent_sessions.status='waiting' THEN NULL ELSE agent_sessions.error END,
        folder_path=COALESCE(excluded.folder_path, agent_sessions.folder_path), folder_label=COALESCE(excluded.folder_label, agent_sessions.folder_label),
        rotated=COALESCE(agent_sessions.rotated, excluded.rotated)`)
      .run(`${track.id}`, userId, track.botId, provider, track.kind, sessionTitle(track.request, track.title), oneLine(track.request, 1500),
        bot.generation ?? null, track.folder?.path ?? null, track.folder?.label ?? null, startedAt,
        track.role ?? null, track.agent ?? null, track.groupId ?? null, track.rotated ?? null, now());
    notifyChange(userId, track.botId);
  } catch (error) {
    console.warn('[agent-sessions] could not record a session start', (error as Error).message);
  }
}

/**
 * A Cloud request that is waiting on an in-app card (repository, sign-in, access) shows up in Sessions right away as
 * Waiting, instead of only once Claude Cloud starts. Launching later continues this same record (beginAgentSession).
 */
export function recordCloudRequest(track: SessionTrack, note: string, at = Date.now()) {
  try {
    const userId = ownerOf(track);
    const bot = getBotRow(track.botId);
    if (!userId || !bot) return;
    db.prepare(`INSERT INTO agent_sessions(id,user_id,bot_id,provider,kind,title,request,status,error,chat_generation,folder_path,folder_label,
        started_at,active_calls,updated_at)
      VALUES (?,?,?,'claude','cloud',?,?,'waiting',?,?,?,?,?,0,?)
      ON CONFLICT(id) DO UPDATE SET error=excluded.error, updated_at=excluded.updated_at WHERE agent_sessions.status='waiting'`)
      .run(track.id, userId, track.botId, sessionTitle(track.request, track.title), oneLine(track.request, 1500), oneLine(note, 300) || null,
        bot.generation ?? null, track.folder?.path ?? null, track.folder?.label ?? null, at, now());
    notifyChange(userId, track.botId);
  } catch (error) {
    console.warn('[agent-sessions] could not record a Cloud request', (error as Error).message);
  }
}

/** A waiting Cloud request was cancelled or dropped before it started. */
export function settleCloudRequest(userId: string, id: string, note: string) {
  const at = now();
  const row = db.prepare("SELECT bot_id, started_at FROM agent_sessions WHERE id=? AND user_id=? AND status='waiting'").get(id, userId) as { bot_id: string; started_at: number } | undefined;
  if (!row) return;
  db.prepare("UPDATE agent_sessions SET status='stopped', error=?, ended_at=?, duration_ms=?, updated_at=? WHERE id=?")
    .run(oneLine(note, 300), at, Math.max(0, at - row.started_at), at, id);
  notifyChange(userId, row.bot_id);
}

export function linkCloudSession(track: SessionTrack, url: string) {
  const result = db.prepare("UPDATE agent_sessions SET cloud_url=?, updated_at=? WHERE id=? AND kind='cloud' AND user_id=?")
    .run(url, now(), track.id, track.userId);
  if (result.changes) notifyChange(track.userId, track.botId);
}

/** A run ended (any outcome). Calls of one session (an orchestration's plan, tasks and reviews) merge into one record. */
export function finishAgentSession(track: SessionTrack, provider: RelayProvider, finish: SessionFinish) {
  try {
    const userId = ownerOf(track);
    if (!userId || !getBotRow(track.botId)) return;
    if (!db.prepare('SELECT 1 FROM agent_sessions WHERE id=?').get(track.id)) beginAgentSession(track, provider, finish.startedAt);
    const row = db.prepare('SELECT * FROM agent_sessions WHERE id=?').get(track.id) as AgentSessionRow | undefined;
    if (!row) return;
    const waiting = Math.max(0, row.active_calls - 1);
    const summary = finish.reply ? summarizeReply(finish.reply) : row.summary;
    const status: RelayStatus = waiting > 0 ? 'running' : finish.status;
    const failure = finish.status === 'completed' ? null : oneLine(finish.error ?? '', 300) || null;
    db.prepare(`UPDATE agent_sessions SET status=?, active_calls=?, calls=calls+1, summary=?, error=?, model=COALESCE(?,model),
        model_label=COALESCE(?,model_label), effort=COALESCE(?,effort), tokens_in=?, tokens_out=?, ended_at=?, duration_ms=?, updated_at=? WHERE id=?`)
      .run(status, waiting, finish.status === 'completed' || summary ? summary : oneLine(finish.error ?? 'No reply.', 300), failure,
        finish.model?.id ?? null, finish.model?.label ?? null, finish.model?.effort ?? null,
        finish.tokens ? (row.tokens_in ?? 0) + (finish.tokens.input ?? 0) : row.tokens_in,
        finish.tokens ? (row.tokens_out ?? 0) + (finish.tokens.output ?? 0) : row.tokens_out,
        waiting > 0 ? null : finish.endedAt, Math.max(0, finish.endedAt - row.started_at), now(), track.id);
    notifyChange(userId, track.botId);
  } catch (error) {
    console.warn('[agent-sessions] could not record a session end', (error as Error).message);
  }
}

/** Runs are children of this server: any still "running" when it starts again were cut off. */
export function recoverAgentSessions() {
  const rows = db.prepare("SELECT id, user_id, bot_id, started_at FROM agent_sessions WHERE status='running'").all() as Pick<AgentSessionRow, 'id' | 'user_id' | 'bot_id' | 'started_at'>[];
  const at = now();
  for (const row of rows) {
    db.prepare("UPDATE agent_sessions SET status='stopped', active_calls=0, ended_at=?, duration_ms=?, error=COALESCE(error,CASE WHEN kind='cloud' THEN 'Marion disconnected on restart; check Claude for the current status.' ELSE 'Marion Agent restarted before this finished.' END), updated_at=? WHERE id=?")
      .run(at, Math.max(0, at - row.started_at), at, row.id);
  }
  // Cloud requests nobody answered for a week are closed (their card is long out of sight).
  db.prepare("UPDATE agent_sessions SET status='stopped', ended_at=?, error=COALESCE(error,'Never started.'), updated_at=? WHERE status='waiting' AND updated_at < ?")
    .run(at, at, at - 7 * 24 * 3600_000);
  db.prepare('DELETE FROM agent_sessions WHERE status != ? AND updated_at < ?').run('running', at - KEEP_MS);
  return rows.length;
}

// ---------- reading ----------

export interface SessionQuery {
  botId?: string;
  /**
   * 'chat' (bot conversations), 'relay' (every Claude/Codex/Gemini run) or 'builders' (relayed agents doing work:
   * everything except a subscription-backed bot answering in its own chat). Omit for chats and relays.
   */
  type?: 'chat' | 'relay' | 'builders';
  /** Relayed runs only: ask_subscription, subscription_bot, orchestration or team. */
  kind?: string;
  provider?: string;
  status?: string;
  limit?: number;
}

/** Relayed runs that are workers (asked directly, orchestrated, team, Cloud, handoff), not a bot's own chat model replying. */
export const isBuilderKind = (kind: string) => kind !== 'subscription_bot' && kind !== 'chat';

const toRelay = (row: AgentSessionRow, botName: string): MarionSession => ({
  id: `relay:${row.id}`,
  type: 'relay', kind: row.kind, ...(row.kind === 'cloud' ? { cloudUrl: row.cloud_url } : {}), provider: row.provider, status: row.status,
  title: row.title, summary: row.summary, request: row.request || null, error: row.error,
  botId: row.bot_id, botName, chatId: `${row.bot_id}:${row.chat_generation ?? 0}`, generation: row.chat_generation,
  folder: row.folder_path ? { name: row.folder_label || row.folder_path, path: row.folder_path } : null,
  model: row.model, modelLabel: row.model_label, effort: row.effort,
  tokens: row.tokens_in != null || row.tokens_out != null ? { input: row.tokens_in ?? 0, output: row.tokens_out ?? 0 } : null,
  startedAt: row.started_at, endedAt: row.ended_at, updatedAt: row.ended_at ?? row.updated_at,
  durationMs: row.status === 'running' || row.status === 'waiting' ? Math.max(0, Date.now() - row.started_at) : row.duration_ms,
  calls: row.calls, messageCount: null, role: row.role, agent: row.agent, groupId: row.group_id, rotated: row.rotated,
});

const messageText = (body: string) => { try { const parsed = JSON.parse(body) as RowBody; return parsed.type === 'message' ? parsed.text : ''; } catch { return ''; } };

function chatSessions(userId: string, query: SessionQuery, limit: number): MarionSession[] {
  const groups = db.prepare(`SELECT r.bot_id, r.generation, COUNT(*) n, MIN(r.created_at) first_at, MAX(r.created_at) last_at,
      b.name, b.generation current, b.created_at bot_created
    FROM rows r JOIN bots b ON b.id=r.bot_id
    WHERE b.user_id=? AND COALESCE(b.hidden,0)=0 AND b.deleted_at IS NULL AND r.kind='message' ${query.botId ? 'AND r.bot_id=?' : ''}
    GROUP BY r.bot_id, r.generation ORDER BY last_at DESC LIMIT ?`)
    .all(...(query.botId ? [userId, query.botId, limit] : [userId, limit])) as
    { bot_id: string; generation: number; n: number; first_at: number; last_at: number; name: string; current: number }[];
  const first = db.prepare(`SELECT body FROM rows WHERE bot_id=? AND generation=? AND kind='message' AND json_extract(body,'$.role')='user' ORDER BY seq LIMIT 1`);
  const last = db.prepare(`SELECT body FROM rows WHERE bot_id=? AND generation=? AND kind='message' AND json_extract(body,'$.role')='assistant' AND json_extract(body,'$.ack') IS NULL ORDER BY seq DESC LIMIT 1`);
  return groups.map(group => {
    const asked = oneLine(messageText((first.get(group.bot_id, group.generation) as { body: string } | undefined)?.body ?? ''), 200);
    const answered = oneLine(messageText((last.get(group.bot_id, group.generation) as { body: string } | undefined)?.body ?? ''), 400);
    const current = group.generation === group.current;
    return {
      id: `chat:${group.bot_id}:${group.generation}`,
      type: 'chat', kind: 'chat', provider: null, status: current ? 'active' : 'archived',
      title: asked || `Conversation ${group.generation}`, summary: answered, request: null, error: null,
      botId: group.bot_id, botName: group.name, chatId: `${group.bot_id}:${group.generation}`, generation: group.generation,
      folder: null, model: null, modelLabel: null, effort: null, tokens: null,
      startedAt: group.first_at, endedAt: current ? null : group.last_at, updatedAt: group.last_at,
      durationMs: Math.max(0, group.last_at - group.first_at), calls: 0, messageCount: group.n,
      role: null, agent: null, groupId: null, rotated: null,
    } satisfies MarionSession;
  });
}

/**
 * Relayed runs of visible bots, plus runs of their hidden subagent helpers (a helper that starts a Cloud session or asks
 * Codex still did that work for its parent): those are listed under the parent bot, named "Parent › Helper".
 */
function relaySessions(userId: string, query: SessionQuery, limit: number): MarionSession[] {
  const where = ['s.user_id=?', 'b.deleted_at IS NULL',
    '(COALESCE(b.hidden,0)=0 OR (b.parent_bot_id IS NOT NULL AND p.id IS NOT NULL AND COALESCE(p.hidden,0)=0 AND p.deleted_at IS NULL))'];
  const args: (string | number)[] = [userId];
  if (query.botId) { where.push('(s.bot_id=? OR (b.parent_bot_id=? AND COALESCE(b.hidden,0)=1))'); args.push(query.botId, query.botId); }
  if (query.type === 'builders') where.push("s.kind != 'subscription_bot'");
  if (query.kind) { where.push('s.kind=?'); args.push(query.kind); }
  if (query.provider) { where.push('s.provider=?'); args.push(query.provider); }
  if (query.status) { where.push('s.status=?'); args.push(query.status); }
  const rows = db.prepare(`SELECT s.*, b.name bot_name, COALESCE(b.hidden,0) helper, p.id parent_id, p.name parent_name
    FROM agent_sessions s JOIN bots b ON b.id=s.bot_id LEFT JOIN bots p ON p.id=b.parent_bot_id
    WHERE ${where.join(' AND ')} ORDER BY (s.status IN ('running','waiting')) DESC, s.updated_at DESC LIMIT ?`)
    .all(...args, limit) as (AgentSessionRow & { bot_name: string; helper: number; parent_id: string | null; parent_name: string | null })[];
  return rows.map(row => row.helper && row.parent_id
    ? { ...toRelay(row, `${row.parent_name} › ${row.bot_name}`), botId: row.parent_id }
    : toRelay(row, row.bot_name));
}

/**
 * Bot chat sessions and relayed agent sessions of one owner, running ones first, then newest. A provider, kind or status
 * filter only applies to relayed runs, so it leaves bot chats out.
 */
export function listSessions(userId: string, query: SessionQuery = {}): MarionSession[] {
  const limit = Math.min(Math.max(Math.floor(query.limit ?? 100), 1), 300);
  const relayOnly = Boolean(query.provider || query.kind || (query.status && query.status !== 'active' && query.status !== 'archived'));
  const chats = query.type === 'relay' || query.type === 'builders' || relayOnly ? [] : chatSessions(userId, query, limit)
    .filter(session => !query.status || session.status === query.status);
  const relays = query.type === 'chat' || query.status === 'active' || query.status === 'archived' ? [] : relaySessions(userId, query, limit);
  const live = (s: MarionSession) => Number(s.status === 'running' || s.status === 'waiting');
  return [...chats, ...relays]
    .sort((a, b) => live(b) - live(a) || b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

/** The messages of one bot conversation (any generation), oldest first, trimmed for a preview. */
export function chatSessionMessages(userId: string, botId: string, generation: number, limit = 40) {
  const bot = getBotRow(botId);
  if (!bot || bot.user_id !== userId) return null;
  const rows = db.prepare(`SELECT body, created_at FROM rows WHERE bot_id=? AND generation=? AND kind='message' ORDER BY seq DESC LIMIT ?`)
    .all(botId, generation, Math.min(Math.max(limit, 1), 100)) as { body: string; created_at: number }[];
  return rows.reverse().flatMap(row => {
    try {
      const body = JSON.parse(row.body) as RowBody;
      if (body.type !== 'message' || !body.text?.trim()) return [];
      return [{ role: body.role, text: body.text.slice(0, 1500), at: row.created_at }];
    } catch { return []; }
  });
}
