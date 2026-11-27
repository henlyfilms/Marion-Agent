import { db, now } from '../db.js';

/**
 * Guard rails for bot-to-bot messages, so an executive bot can run a team without two bots
 * ping-ponging forever or a runaway chain burning a subscription.
 *  - A chain of hand-offs that started from one user request can be MAX_BOT_HOPS long.
 *  - Any pair of bots can exchange at most PAIR_LIMIT messages per PAIR_WINDOW.
 */
export const MAX_BOT_HOPS = 8;
const PAIR_LIMIT = 30;
const PAIR_WINDOW = 10 * 60_000;

/** Why a bot-to-bot message would be refused right now, or null. Read-only: nothing is logged (see allowBotMessage). */
export function botMessageBlock(fromBotId: string, toBotId: string, depth: number): string | null {
  if (fromBotId === toBotId) return 'A Bot cannot message itself';
  if (depth > MAX_BOT_HOPS) return `This request has already passed between Bots ${MAX_BOT_HOPS} times`;
  const target = db.prepare('SELECT id FROM bots WHERE id=?').get(toBotId);
  if (!target) return 'That Bot no longer exists';
  const recent = (db.prepare('SELECT COUNT(*) n FROM bot_messages_log WHERE from_bot_id=? AND to_bot_id=? AND created_at>?')
    .get(fromBotId, toBotId, now() - PAIR_WINDOW) as { n: number }).n;
  if (recent >= PAIR_LIMIT) return 'These two Bots have exchanged too many messages in the last 10 minutes';
  return null;
}

export function allowBotMessage(fromBotId: string, toBotId: string, depth: number): string | null {
  const blocked = botMessageBlock(fromBotId, toBotId, depth);
  if (blocked) return blocked;
  db.prepare('INSERT INTO bot_messages_log(from_bot_id,to_bot_id,created_at) VALUES (?,?,?)').run(fromBotId, toBotId, now());
  db.prepare('DELETE FROM bot_messages_log WHERE created_at<?').run(now() - 24 * 3600_000);
  return null;
}

type LiveLookup = (id: string) => { isRunning: boolean; awaiting: unknown };

/** The visible team (no groups, no hidden helpers), in roster order. Static facts only: safe for the system prompt. */
export function teamMembers(userId: string) {
  return db.prepare(`SELECT id, name, label, description, role, is_primary, chat_provider, chat_model_label
    FROM bots WHERE user_id=? AND COALESCE(kind,'agent')<>'room' AND COALESCE(hidden,0)=0 AND deleted_at IS NULL ORDER BY is_primary DESC, created_at`).all(userId) as any[];
}

/** One Bot's volatile status, read at call time (never baked into a prompt). */
export const liveStatus = (state: { isRunning: boolean; awaiting: unknown }) => state.awaiting ? 'waiting for the user' : state.isRunning ? 'working' : 'idle';

/** The visible team and its current status (list_team only: status is volatile, so the prompt leaves it out). */
export function liveTeam(userId: string, live: LiveLookup) {
  return teamMembers(userId).map(bot => ({ bot, status: liveStatus(live(bot.id)) }));
}

export const MESSAGE_EXCERPT_CHARS = 200;

export interface TeamRosterOptions {
  /** Names of Bots whose latest message excerpt to include (case-insensitive, leading @ ignored). Default: none. */
  messagesFrom?: unknown;
}

/**
 * The team as one bot sees it for list_team: live status plus the fields needed to route work (name for send_to_bot,
 * job, role, model, last activity). Message excerpts are opt-in per named Bot, so a routine roster check stays small.
 * Names in messagesFrom that match no visible Bot come back in `unknownNames`.
 */
export function teamRoster(userId: string, selfId: string, live: LiveLookup, options: TeamRosterOptions = {}) {
  const raw = Array.isArray(options.messagesFrom) ? options.messagesFrom : typeof options.messagesFrom === 'string' && options.messagesFrom ? [options.messagesFrom] : [];
  const wanted = new Set(raw.filter((n): n is string => typeof n === 'string').map(n => n.trim().replace(/^@/, '').toLowerCase()).filter(Boolean));
  const seen = new Set<string>();
  const lastRow = db.prepare("SELECT body, created_at FROM rows WHERE bot_id=? AND kind='message' ORDER BY seq DESC LIMIT 1");
  const team = liveTeam(userId, live).map(({ bot, status }) => {
    const last = lastRow.get(bot.id) as { body: string; created_at: number } | undefined;
    const key = String(bot.name).toLowerCase();
    const member: Record<string, unknown> = {
      name: bot.name,
      you: bot.id === selfId,
      job: bot.label || bot.description || '',
      role: bot.role === 'executive' ? 'executive' : bot.is_primary ? 'primary' : 'teammate',
      model: bot.chat_model_label || bot.chat_provider || 'default',
      status,
      lastActiveAt: last ? new Date(last.created_at).toISOString() : null,
    };
    if (wanted.has(key)) {
      seen.add(key);
      let lastMessage = '';
      try { lastMessage = last ? String(JSON.parse(last.body).text ?? '').slice(0, MESSAGE_EXCERPT_CHARS) : ''; } catch { /* unreadable row */ }
      member.lastMessage = lastMessage;
    }
    return member;
  });
  const unknownNames = [...wanted].filter(n => !seen.has(n));
  return { team, ...(unknownNames.length ? { unknownNames } : {}) };
}
