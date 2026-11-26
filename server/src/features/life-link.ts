import { db, now } from '../db.js';
import { hub } from '../lib/hub.js';
import { getLive } from '../store.js';
import { getSecret, getSetting, setSecret, setSetting } from './schema.js';

/**
 * Marion Life link: copies every Marion Agent chat into Marion Life (table public.life_agent_chats),
 * so Life's Second Brain can search them. One row per chat (bot + "Start fresh" generation), updated
 * whenever the chat changes and the bot is idle.
 *
 * It goes through Marion Life's own door (POST https://marionberry.app/api/mcp, JSON-RPC tools) with
 * a Marion Life key (starts "mb_", made in Life → Settings → Connections → Marion Agent, revocable
 * there). The key can only reach this one account's planner tools and chat copies: no database keys
 * live on this Mac. The key is stored in Marion's local secret store and is never sent to a model.
 */
export interface LifeLinkSettings {
  enabled: boolean;
  /** Copy changed chats automatically every minute. Off: only "Sync now" copies. */
  autoSync: boolean;
  endpoint: string;
  lifeEmail: string;
  lastSyncAt: number | null;
  lastError: string | null;
  syncedChats: number;
  /** Bots that may NOT use the Marion Life planner tools. Empty = every bot (the default). */
  blockedBots: string[];
}

const DEFAULT_ENDPOINT = 'https://marionberry.app/api/mcp';
const DEFAULTS: LifeLinkSettings = { enabled: false, autoSync: true, endpoint: DEFAULT_ENDPOINT, lifeEmail: '', lastSyncAt: null, lastError: null, syncedChats: 0, blockedBots: [] };
const keyName = (userId: string) => `life_link_key:${userId}`;
const legacyKeyName = (userId: string) => `life_service_key:${userId}`;
/** Life's limits: a batch of chats must fit in 64 KB; a single chat may be up to 640 KB. */
const MAX_BATCH = 60_000;
const MAX_SINGLE = 600_000;
const MAX_TRANSCRIPT = 500_000;

export const lifeLinkSettings = (userId: string) => {
  const saved = getSetting<LifeLinkSettings & { supabaseUrl?: string; lifeUserId?: string }>(userId, 'life-link', DEFAULTS);
  // Links made with the old Supabase service key are switched off until a Life key is added.
  const legacy = Boolean(saved.supabaseUrl) || Boolean(getSecret(legacyKeyName(userId)));
  if (legacy) {
    setSecret(legacyKeyName(userId), null);
    const next: LifeLinkSettings = { ...DEFAULTS, lastError: 'Marion Life now uses its own key. Paste a Marion Life key to reconnect.' };
    setSetting(userId, 'life-link', next);
    return next;
  }
  return { ...DEFAULTS, ...saved, endpoint: saved.endpoint || DEFAULT_ENDPOINT };
};
export const hasLifeKey = (userId: string) => Boolean(getSecret(keyName(userId)));

/** True when the saved Life connection is on and this bot (if given) is allowed to use it. */
export function lifeToolsEnabled(userId: string, botId?: string) {
  const settings = lifeLinkSettings(userId);
  if (!settings.enabled || !hasLifeKey(userId)) return false;
  return !botId || !(settings.blockedBots ?? []).includes(botId);
}

/** Marion Life planner tools every allowed bot gets as marion_life_* (Life resolves project and divider names itself). */
export const lifePlannerTools = {
  get_today: { description: 'Get today’s local date, time zone, tasks and events.' },
  list_tasks: {
    description: 'List tasks by date, date range or project (ID or name). With a project and no dates, list all its tasks. Set include_done to include completed tasks.',
    fields: { date: 'string', from: 'string', to: 'string', project: 'string', include_done: 'boolean' },
  },
  list_projects: { description: 'List projects with their IDs, names, status and dividers. Only needed when add_task reports that a project name did not match.' },
  list_events: {
    description: 'List calendar events between two local dates (YYYY-MM-DD).',
    fields: { from: 'string', to: 'string' }, required: ['from', 'to'],
  },
  search: {
    description: 'Search tasks, projects and events.',
    fields: { query: 'string' }, required: ['query'],
  },
  add_task: {
    description: 'Add a task. Pass the project and divider by name as the user said them (Life matches names); leave project out for the Planner. Date defaults to today and can be YYYY-MM-DD or "none". Notes are for Planner tasks. Call this directly: no need to list projects first.',
    fields: { title: 'string', project: 'string', divider: 'string', date: 'string', notes: 'string' }, required: ['title'],
    write: true,
  },
  update_task: {
    description: 'Update a task by ID. Use YYYY-MM-DD or "none" for date. Planner tasks support notes and low, normal or high priority. Use project to move a project task.',
    fields: { id: 'string', title: 'string', date: 'string', notes: 'string', priority: 'string', project: 'string' }, required: ['id'],
    write: true,
  },
  complete_task: {
    description: 'Mark a task done by ID, or reopen it with done: false.',
    fields: { id: 'string', done: 'boolean' }, required: ['id'],
    write: true,
  },
  add_event: {
    description: 'Add a calendar event. Start and optional end use local YYYY-MM-DDTHH:MM, or YYYY-MM-DD for an all-day event.',
    fields: { title: 'string', start: 'string', end: 'string', all_day: 'boolean' }, required: ['title', 'start'],
    write: true,
  },
} satisfies Record<string, { description: string; fields?: Record<string, string>; required?: string[]; write?: boolean }>;

/** One prompt line so every bot knows whether it can reach Marion Life right now. */
export function lifePromptLine(userId: string, botId: string) {
  if (lifeToolsEnabled(userId, botId)) {
    return 'Marion Life (also spelled Marian Life) is connected for you: use the marion_life_* tools for its tasks, projects, dividers and calendar events. Pass project and divider names as the user said them; Life matches them, so you rarely need to list projects first. Confirm changes from the tool result.';
  }
  const settings = lifeLinkSettings(userId);
  if (settings.enabled && hasLifeKey(userId)) return 'Marion Life access is turned off for you in Settings → Marion Life. If asked to use Marion Life, say the owner can turn it on there.';
  return '';
}

export type LifePlannerTool = keyof typeof lifePlannerTools;

export async function runLifePlannerTool(userId: string, botId: string, name: LifePlannerTool, args: Record<string, unknown>, signal?: AbortSignal) {
  const settings = lifeLinkSettings(userId);
  const key = getSecret(keyName(userId));
  if (!settings.enabled || !key) throw new Error('Marion Life is paused or has no saved key in Settings → Marion Life.');
  if ((settings.blockedBots ?? []).includes(botId)) throw new Error('This bot’s Marion Life access is turned off in Settings → Marion Life.');
  const tool = lifePlannerTools[name];
  const input: Record<string, unknown> = {};
  for (const [field, type] of 'fields' in tool ? Object.entries(tool.fields) : []) {
    const value = args?.[field];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== type) throw new Error(`Marion Life requires ${field} to be a ${type}.`);
    input[field] = value;
  }
  for (const field of 'required' in tool ? tool.required : []) {
    if (typeof input[field] !== 'string' || !String(input[field]).trim()) throw new Error(`Marion Life requires ${field}.`);
  }
  try {
    const result = await lifeTool(settings.endpoint, key, name, input, signal);
    return JSON.stringify(result).replaceAll(key, '[redacted]').slice(0, 60_000);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof LifeToolMissing) throw new Error(`The connected Marion Life server does not provide ${name}.`);
    if (error instanceof LifeResponseUncertain && 'write' in tool) {
      throw new Error('Marion Life did not confirm the change. Check the task or calendar before retrying to avoid duplicates.');
    }
    throw error;
  }
}

function normalizeEndpoint(raw: string) {
  const url = new URL(raw.trim());
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (!local && (url.protocol !== 'https:' || !/(^|\.)marionberry\.app$/.test(url.hostname))) throw new Error('Use the Marion Life address (https://marionberry.app/api/mcp).');
  return `${url.origin}${url.pathname}`;
}

class LifeToolMissing extends Error {}
class LifeResponseUncertain extends Error {}
let rpcId = 0;

/** Call one Marion Life tool through the key door. */
async function lifeTool<T>(endpoint: string, key: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(20_000);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    signal?.throwIfAborted();
    throw new LifeResponseUncertain('Marion Life did not respond. Try again shortly.');
  }
  if (response.status >= 500) throw new LifeResponseUncertain(`Marion Life is temporarily unavailable (HTTP ${response.status}).`);
  if (response.status === 401 || response.status === 403) throw new Error('Marion Life refused the key. Make a new one in Life → Settings → Connections → Marion Agent.');
  if (response.status === 413) throw new Error('That chat is too big for Marion Life to accept.');
  if (response.status === 429) throw new Error('Marion Life is rate-limiting the link. It will retry in a minute.');
  const body = await response.json().catch(() => null) as any;
  if (!response.ok && !body) throw new Error(`Marion Life answered ${response.status}.`);
  if (body?.error) {
    if (body.error.code === -32601 || /unknown tool|not found|no such tool/i.test(String(body.error.message))) throw new LifeToolMissing(name);
    throw new Error(`Marion Life: ${String(body.error.message ?? 'request failed').slice(0, 200)}`);
  }
  const result = body?.result;
  let value: any = result?.structuredContent;
  if (value === undefined && Array.isArray(result?.content)) {
    const text = result.content.find((part: any) => part?.type === 'text')?.text;
    try { value = JSON.parse(text); } catch { value = text; }
  }
  if (result?.isError) {
    const message = typeof value === 'string' ? value : value?.error ?? value?.message ?? 'request failed';
    if (/doesn.t have that tool|there is no tool called|unknown tool|no such tool/i.test(String(message))) throw new LifeToolMissing(name);
    throw new Error(`Marion Life: ${String(message).slice(0, 200)}`);
  }
  return value as T;
}

const missingSync = 'Connected, but Marion Life hasn’t turned on chat sync yet. Chats will copy over once it does.';

/** Save the key, check it with Life (whoami), and start copying chats. */
export async function connectLife(userId: string, input: { endpoint?: string; linkKey?: string; enabled?: boolean; autoSync?: boolean; blockedBots?: unknown }) {
  const current = lifeLinkSettings(userId);
  const next: LifeLinkSettings = { ...current };
  // Which bots may use Life is a local preference: no key check or network call needed.
  if (input.blockedBots !== undefined) {
    if (!Array.isArray(input.blockedBots) || input.blockedBots.some(id => typeof id !== 'string')) throw new Error('Pick bots by ID.');
    next.blockedBots = [...new Set(input.blockedBots as string[])].slice(0, 500);
    if (input.endpoint === undefined && !input.linkKey && input.enabled === undefined && input.autoSync === undefined) {
      setSetting(userId, 'life-link', next);
      return next;
    }
  }
  // Turning auto sync on or off is a local preference: no key check or network call needed.
  if (typeof input.autoSync === 'boolean' && input.endpoint === undefined && !input.linkKey && input.enabled === undefined) {
    next.autoSync = input.autoSync;
    setSetting(userId, 'life-link', next);
    if (next.autoSync && next.enabled) queueMicrotask(() => { void syncLife(userId).catch(() => {}); });
    return next;
  }
  if (typeof input.autoSync === 'boolean') next.autoSync = input.autoSync;
  if (input.endpoint !== undefined) next.endpoint = input.endpoint ? normalizeEndpoint(input.endpoint) : DEFAULT_ENDPOINT;
  if (input.linkKey) {
    const key = input.linkKey.trim();
    if (!/^mb_[A-Za-z0-9_-]{16,200}$/.test(key)) throw new Error('Paste the Marion Life key (it starts with mb_).');
    setSecret(keyName(userId), key);
  }
  const key = getSecret(keyName(userId));
  if (input.enabled === false) {
    next.enabled = false;
    setSetting(userId, 'life-link', next);
    return next;
  }
  if (!key) throw new Error('Paste your Marion Life key first.');
  try {
    const me = await lifeTool<{ ok?: boolean; email?: string }>(next.endpoint, key, 'whoami', {});
    next.lifeEmail = typeof me?.email === 'string' ? me.email : '';
    next.lastError = null;
  } catch (error) {
    if (!(error instanceof LifeToolMissing)) throw error;
    next.lifeEmail = '';
    next.lastError = missingSync;
  }
  next.enabled = true;
  setSetting(userId, 'life-link', next);
  queueMicrotask(() => { void syncLife(userId).catch(() => {}); });
  return next;
}

export function disconnectLife(userId: string) {
  setSecret(keyName(userId), null);
  setSecret(legacyKeyName(userId), null);
  setSetting(userId, 'life-link', DEFAULTS);
}

interface ChatRow { bot_id: string; generation: number; rev: number; first_at: number; last_at: number; count: number }

/** Chats changed since their last sync, for idle bots only (so half-finished replies aren't copied). */
function pendingChats(userId: string, force: boolean): ChatRow[] {
  const rows = db.prepare(`
    SELECT r.bot_id, r.generation, MAX(r.updated_seq) rev, MIN(r.created_at) first_at, MAX(r.created_at) last_at, COUNT(*) count
    FROM rows r JOIN bots b ON b.id=r.bot_id
    WHERE b.user_id=? AND COALESCE(b.hidden,0)=0 AND r.kind='message'
    GROUP BY r.bot_id, r.generation`).all(userId) as ChatRow[];
  return rows.filter(row => {
    if (getLive(row.bot_id).isRunning) return false;
    if (force) return true;
    const synced = db.prepare('SELECT synced_rev FROM life_sync WHERE bot_id=? AND generation=?').get(row.bot_id, row.generation) as { synced_rev: number } | undefined;
    return !synced || synced.synced_rev < row.rev;
  });
}

function chatDocument(row: ChatRow) {
  const bot = db.prepare('SELECT name, label FROM bots WHERE id=?').get(row.bot_id) as { name: string; label: string };
  const messages = (db.prepare("SELECT body, created_at FROM rows WHERE bot_id=? AND generation=? AND kind='message' ORDER BY seq").all(row.bot_id, row.generation) as any[])
    .map(r => ({ ...JSON.parse(r.body), at: r.created_at }))
    .filter(body => body.text && !body.streaming);
  const firstUser = messages.find(m => m.role === 'user' && (!m.from || m.from.kind === 'voice'));
  const transcript = messages.map(m => {
    const who = m.from?.kind === 'voice' ? 'You (call)' : m.from?.name ?? (m.role === 'assistant' ? bot.name : 'You');
    const files = m.attachments?.length ? `\nAttachments: ${m.attachments.map((a: any) => a.name).join(', ')}` : '';
    return `[${new Date(m.at).toISOString()}] ${who}:\n${m.text}${files}`;
  }).join('\n\n');
  return {
    id: `${row.bot_id}:${row.generation}`,
    marion_bot_id: row.bot_id,
    generation: row.generation,
    bot_name: bot.name.slice(0, 80),
    ...(bot.label ? { bot_job: bot.label.slice(0, 200) } : {}),
    title: (firstUser?.text ?? `Chat with ${bot.name}`).replace(/\s+/g, ' ').slice(0, 500),
    transcript: transcript.length > MAX_TRANSCRIPT ? transcript.slice(-MAX_TRANSCRIPT) : transcript,
    message_count: messages.length,
    started_at: new Date(row.first_at).toISOString(),
    last_message_at: new Date(row.last_at).toISOString(),
  };
}

const syncing = new Set<string>();

export async function syncLife(userId: string, opts: { force?: boolean; auto?: boolean } = {}) {
  const settings = lifeLinkSettings(userId);
  const key = getSecret(keyName(userId));
  if (!settings.enabled || !key || syncing.has(userId)) return { synced: 0 };
  if (opts.auto && !settings.autoSync) return { synced: 0 };
  syncing.add(userId);
  let synced = 0;
  const errorBefore = settings.lastError;
  const mark = db.prepare(`INSERT INTO life_sync(bot_id,generation,synced_rev,synced_at,error) VALUES (?,?,?,?,NULL)
    ON CONFLICT(bot_id,generation) DO UPDATE SET synced_rev=excluded.synced_rev, synced_at=excluded.synced_at, error=NULL`);
  try {
    const chats = pendingChats(userId, Boolean(opts.force)).map(row => ({ row, doc: chatDocument(row) }));
    // Small chats go 20 to a request under Life's 64 KB limit; big ones go alone (up to 640 KB, end kept).
    const batches: typeof chats[] = [];
    let batch: typeof chats = [];
    let size = 0;
    for (const chat of chats) {
      let length = Buffer.byteLength(JSON.stringify(chat.doc));
      if (length > MAX_BATCH) {
        while (length > MAX_SINGLE && chat.doc.transcript.length > 1000) {
          chat.doc.transcript = chat.doc.transcript.slice(-Math.floor(chat.doc.transcript.length * 0.8));
          length = Buffer.byteLength(JSON.stringify(chat.doc));
        }
        batches.push([chat]);
        continue;
      }
      if (batch.length && (size + length > MAX_BATCH || batch.length >= 20)) { batches.push(batch); batch = []; size = 0; }
      batch.push(chat);
      size += length;
    }
    if (batch.length) batches.push(batch);
    for (const group of batches) {
      await lifeTool(settings.endpoint, key, 'save_agent_chats', { chats: group.map(chat => chat.doc) });
      for (const { row } of group) mark.run(row.bot_id, row.generation, row.rev, now());
      synced += group.length;
    }
    const total = (db.prepare('SELECT COUNT(*) n FROM life_sync s JOIN bots b ON b.id=s.bot_id WHERE b.user_id=?').get(userId) as { n: number }).n;
    setSetting(userId, 'life-link', { ...lifeLinkSettings(userId), lastSyncAt: now(), lastError: null, syncedChats: total });
    return { synced };
  } catch (error) {
    const message = error instanceof LifeToolMissing ? missingSync : (error as Error).message.slice(0, 300);
    setSetting(userId, 'life-link', { ...lifeLinkSettings(userId), lastError: message });
    if (error instanceof LifeToolMissing) return { synced };
    throw error;
  } finally {
    syncing.delete(userId);
    // Only tell open windows when something visible changed (avoid a refetch every minute).
    if (synced || lifeLinkSettings(userId).lastError !== errorBefore) hub.emit(userId, { type: 'connections' });
  }
}

/** Every minute, copy changed chats of every linked workspace that has auto sync on. */
export function startLifeSync() {
  const timer = setInterval(() => {
    const users = db.prepare("SELECT user_id FROM user_settings WHERE key='life-link'").all() as { user_id: string }[];
    for (const { user_id } of users) void syncLife(user_id, { auto: true }).catch(() => {});
  }, 60_000);
  timer.unref?.();
}
