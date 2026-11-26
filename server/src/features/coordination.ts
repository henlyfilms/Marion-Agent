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

export function allowBotMessage(fromBotId: string, toBotId: string, depth: number): string | null {
  if (fromBotId === toBotId) return 'A Bot cannot message itself';
  if (depth > MAX_BOT_HOPS) return `This request has already passed between Bots ${MAX_BOT_HOPS} times`;
  const target = db.prepare('SELECT id FROM bots WHERE id=?').get(toBotId);
  if (!target) return 'That Bot no longer exists';
  const recent = (db.prepare('SELECT COUNT(*) n FROM bot_messages_log WHERE from_bot_id=? AND to_bot_id=? AND created_at>?')
    .get(fromBotId, toBotId, now() - PAIR_WINDOW) as { n: number }).n;
  if (recent >= PAIR_LIMIT) return 'These two Bots have exchanged too many messages in the last 10 minutes';
  db.prepare('INSERT INTO bot_messages_log(from_bot_id,to_bot_id,created_at) VALUES (?,?,?)').run(fromBotId, toBotId, now());
  db.prepare('DELETE FROM bot_messages_log WHERE created_at<?').run(now() - 24 * 3600_000);
  return null;
}

/** The visible team and its current status, shared by the prompt and list_team. */
export function liveTeam(userId: string, live: (id: string) => { isRunning: boolean; awaiting: unknown }) {
  const bots = db.prepare(`SELECT id, name, label, description, role, is_primary, chat_provider, chat_model_label
    FROM bots WHERE user_id=? AND COALESCE(kind,'agent')<>'room' AND COALESCE(hidden,0)=0 ORDER BY is_primary DESC, created_at`).all(userId) as any[];
  return bots.map(bot => {
    const state = live(bot.id);
    return { bot, status: state.awaiting ? 'waiting for the user' : state.isRunning ? 'working' : 'idle' };
  });
}

/** The team as one bot sees it, including recent activity for list_team. */
export function teamRoster(userId: string, selfId: string, live: (id: string) => { isRunning: boolean; awaiting: unknown }) {
  return liveTeam(userId, live).map(({ bot, status }) => {
    const last = db.prepare("SELECT body, created_at FROM rows WHERE bot_id=? AND kind='message' ORDER BY seq DESC LIMIT 1").get(bot.id) as any;
    let lastMessage = '';
    try { lastMessage = last ? String(JSON.parse(last.body).text ?? '').slice(0, 200) : ''; } catch { /* unreadable row */ }
    return {
      name: bot.name,
      you: bot.id === selfId,
      job: bot.label || bot.description || '',
      role: bot.role === 'executive' ? 'executive' : bot.is_primary ? 'primary' : 'teammate',
      model: bot.chat_model_label || bot.chat_provider || 'default',
      status,
      lastMessage,
      lastActiveAt: last ? new Date(last.created_at).toISOString() : null,
    };
  });
}
