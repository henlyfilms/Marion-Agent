/**
 * Tasks → Waiting on You: everything that is waiting for the owner's answer or OK, across all their chats.
 *
 * There is no separate store. The single source of truth is what chat already uses:
 *  - action cards are the chat's own card rows (`rows`, current generation, visible bots), resolved through the same
 *    routes and rules as in chat, so a card answered in either place is answered in both;
 *  - approval and draft cards are also checked against their `approvals` row (and the bot's `pending_turns`);
 *  - a task a bot marked `needs_input` is listed only while no card from that bot is waiting (the card is the question).
 *
 * Reading the list also tidies cards that can no longer be answered (see `staleReason`), so they never stay stuck or
 * inflate the badge. The same sweep runs once at startup.
 */
import { db, now } from '../db.js';
import { emitWaiting, getRow, toTask, updateRow } from '../store.js';
import { hub } from '../lib/hub.js';
import { hasCloudPermissionWait } from './cloud-cards.js';
import { WAITING_CARD_TYPES, type CardBody, type Row, type RowBody, type WaitingCardType, type WaitingItem } from '../types.js';

type Card = Extract<RowBody, { type: 'card' }>;

/** Card statuses that still need the owner. A sign-in card in 'working' waits for "I've signed in". */
const OPEN: Record<WaitingCardType, readonly string[]> = {
  approval: ['pending'], question: ['pending'], connect: ['pending'], draft: ['pending'],
  cloud: ['pending'], 'sign-in': ['pending', 'working'], handoff: ['pending'],
};

/** Whether a card body (on its own) is one the owner still has to act on. */
export function isOpenCard(body: RowBody): body is Card & { card: WaitingCardType } {
  return body.type === 'card' && (WAITING_CARD_TYPES as readonly string[]).includes(body.card)
    && OPEN[body.card as WaitingCardType].includes((body as { status: string }).status);
}

/** Notes shown on cards this module closes. */
export const STALE_NOTES = {
  restart: 'Expired: Marion Agent restarted before this was answered.',
  sessionEnded: 'Expired: this Cloud request was closed.',
} as const;

type Stale = { body: CardBody; approval?: { id: string; status: string } } | null;

/**
 * Why an open card can no longer be answered, as the body it should get (null = still actionable).
 *  - approval/draft: its approval row was already decided (sync the card), is missing, or the bot has no paused turn to
 *    resume (nothing would happen on Allow) → expired.
 *  - cloud permission: its launch is no longer waiting in this process (it ended, or Marion restarted) → expired.
 *  - cloud setup: the Cloud request it belongs to was closed → expired.
 */
function staleReason(botId: string, body: Card): Stale {
  if (body.card === 'approval' || body.card === 'draft') {
    const ap = db.prepare('SELECT id, status FROM approvals WHERE id=?').get(body.approvalId) as { id: string; status: string } | undefined;
    if (ap && ap.status !== 'pending') {
      if (body.card === 'draft') return { body: { ...body, status: ap.status === 'denied' ? 'discarded' : ap.status === 'expired' ? 'discarded' : 'sent' } };
      return { body: { ...body, status: ap.status as 'allowed' | 'always' | 'denied' | 'expired' } };
    }
    // The bot's one paused batch must be waiting on this very approval (an older card of the same bot can't resume it).
    const paused = db.prepare("SELECT 1 FROM pending_turns WHERE bot_id=? AND json_extract(state,'$.approvalId')=?").get(botId, body.approvalId);
    if (!ap || !paused) {
      const expired: CardBody = body.card === 'draft' ? { ...body, status: 'discarded' } : { ...body, status: 'expired' };
      return { body: expired, ...(ap ? { approval: { id: ap.id, status: 'expired' } } : {}) };
    }
    return null;
  }
  if (body.card === 'cloud' && body.mode === 'permission' && !hasCloudPermissionWait(body.id)) {
    return { body: { ...body, status: 'expired', note: STALE_NOTES.restart } };
  }
  if (body.card === 'cloud' && body.mode === 'setup' && body.sessionId) {
    const s = db.prepare('SELECT status FROM agent_sessions WHERE id=?').get(body.sessionId) as { status: string } | undefined;
    if (s && s.status !== 'waiting' && s.status !== 'running') return { body: { ...body, status: 'expired', note: STALE_NOTES.sessionEnded } };
  }
  return null;
}

/** Open card rows in the current conversation of each visible chat (one user, or everyone for the startup sweep). */
function openCardRows(userId?: string): Array<{ row: Row; botName: string; userId: string }> {
  const rows = db.prepare(`SELECT r.*, b.name AS bot_name, b.user_id AS owner FROM rows r JOIN bots b ON b.id=r.bot_id AND r.generation=b.generation
    WHERE ${userId ? 'b.user_id=? AND ' : ''}COALESCE(b.hidden,0)=0 AND b.deleted_at IS NULL AND r.kind='card'
      AND json_extract(r.body,'$.status') IN ('pending','working') ORDER BY r.created_at DESC, r.seq DESC`)
    .all(...(userId ? [userId] : [])) as any[];
  return rows.map(r => ({
    row: { botId: r.bot_id, generation: r.generation, seq: r.seq, updatedSeq: r.updated_seq, kind: r.kind, body: JSON.parse(r.body), createdAt: r.created_at } as Row,
    botName: r.bot_name, userId: r.owner,
  }));
}

/** Close one stale card (and its approval). Returns true when this call closed it. */
function closeStale(row: Row, stale: NonNullable<Stale>): boolean {
  if (stale.approval) db.prepare("UPDATE approvals SET status=?, resolved_at=? WHERE id=? AND status='pending'").run(stale.approval.status, now(), stale.approval.id);
  const current = getRow(row.botId, row.seq);
  if (!current || !isOpenCard(current.body)) return false;
  return !!updateRow(row.botId, row.seq, stale.body);
}

/** Startup (and on-read) cleanup: closes every open card that can no longer be answered. Returns how many. */
export function sweepStaleWaiting(userId?: string): number {
  let closed = 0;
  for (const { row } of openCardRows(userId)) {
    if (!isOpenCard(row.body)) continue;
    const stale = staleReason(row.botId, row.body);
    if (stale && closeStale(row, stale)) closed++;
  }
  return closed;
}

/** Everything waiting on the owner, newest first. Cards that turned out stale are closed on the way, not listed. */
export function listWaiting(userId: string): WaitingItem[] {
  const items: WaitingItem[] = [];
  const botsWithCards = new Set<string>();
  for (const { row, botName } of openCardRows(userId)) {
    const body = row.body;
    if (!isOpenCard(body)) continue;
    const stale = staleReason(row.botId, body);
    if (stale) { closeStale(row, stale); continue; }
    botsWithCards.add(row.botId);
    items.push({ key: `card:${row.botId}:${row.generation}:${row.seq}`, kind: 'card', card: body.card, botId: row.botId, botName, at: row.createdAt, row });
  }
  const tasks = db.prepare(`SELECT t.*, b.name AS bot_name FROM tasks t JOIN bots b ON b.id=t.bot_id
    WHERE b.user_id=? AND t.state='needs_input' AND COALESCE(b.hidden,0)=0 AND b.deleted_at IS NULL ORDER BY t.updated_at DESC`).all(userId) as any[];
  for (const t of tasks) {
    if (botsWithCards.has(t.bot_id)) continue; // that bot's card already asks: one item, not two
    items.push({ key: `task:${t.id}`, kind: 'task', botId: t.bot_id, botName: t.bot_name, at: t.updated_at, task: toTask(t) });
  }
  return items.sort((a, b) => b.at - a.at);
}

export const waitingCount = (userId: string) => listWaiting(userId).length;

/**
 * The owner replied in this chat (typed a message, or answered one of its question cards): the bot has its input.
 *  - `questions`: open question cards in the chat are answered by this message (ask_user: "their answer arrives as their
 *    next message"), so they don't stay pending in chat or in Tasks. Off when a specific card was answered.
 *  - Tasks the bot marked needs_input go back to working.
 */
export function ownerReplied(botId: string, text: string, opts: { questions: boolean }) {
  const bot = db.prepare('SELECT user_id, generation FROM bots WHERE id=?').get(botId) as { user_id: string; generation: number } | undefined;
  if (!bot) return;
  let changed = false;
  if (opts.questions) {
    const open = db.prepare(`SELECT seq FROM rows WHERE bot_id=? AND generation=? AND kind='card' AND json_extract(body,'$.card')='question'
      AND json_extract(body,'$.status')='pending'`).all(botId, bot.generation) as { seq: number }[];
    for (const { seq } of open) {
      const row = getRow(botId, seq);
      if (row?.body.type === 'card' && row.body.card === 'question' && row.body.status === 'pending') {
        updateRow(botId, seq, { ...row.body, status: 'answered', answer: text.trim().slice(0, 2000) || 'Replied in chat' });
        changed = true;
      }
    }
  }
  const moved = db.prepare("UPDATE tasks SET state='working', updated_at=? WHERE bot_id=? AND state='needs_input'").run(now(), botId).changes;
  if (moved) { hub.emit(bot.user_id, { type: 'tasks', botId }); emitWaiting(bot.user_id, botId); }
  return changed || moved > 0;
}
