import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { getLive } from '../store.js';
import { stopDesktop } from '../computer.js';

/**
 * Subagents.
 * A subagent is a hidden child bot: same owner and look as its parent, its own context and
 * its own computer screen, hidden from the sidebar. It receives its goal as a bot-to-bot
 * message and reports back to the parent with send_to_bot when done.
 */

export function initSubagents() {
  for (const col of ['parent_bot_id TEXT', 'hidden INTEGER NOT NULL DEFAULT 0']) {
    try { db.exec(`ALTER TABLE bots ADD COLUMN ${col}`); } catch { /* exists */ }
  }
}

/**
 * Start a helper. There is no cap on how many helpers a Bot has or how many work at the same time: each one is its own
 * hidden bot row with a unique id (one synchronous INSERT, so helpers started together never collide), its own chat,
 * history and live status, and runs its own turns independently of its parent and its siblings.
 */
export function createSubagent(parentId: string, goal: string, label?: string) {
  const p = db.prepare('SELECT * FROM bots WHERE id=?').get(parentId) as any;
  if (!p) throw new Error('parent not found');
  const id = newId('sub');
  const name = `${p.name} · ${(label || goal).replace(/\s+/g, ' ').slice(0, 32)}`;
  const instructions =
    `You are a subagent of ${p.name}, working on one delegated goal:\n${goal}\n\n` +
    `Work independently with your own tools and computer. When you finish (or get blocked), call send_to_bot with bot_name "${p.name}" and a concise result, then stop. Do not message the user directly.` +
    (p.instructions ? `\n\nYour parent's standing instructions:\n${p.instructions}` : '');
  db.prepare(
    `INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,avatar_stem_color,mode,is_primary,effort,parent_bot_id,hidden,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,1,?,?)`,
  ).run(id, p.user_id, name, 'Subagent', `Subagent of ${p.name}`, instructions, p.avatar_shape, p.avatar_color, p.avatar_stem_color, p.mode, p.effort, parentId, now(), now());
  return { id, name, parentName: p.name as string, userId: p.user_id as string };
}

export function listSubagents(parentId: string) {
  return (db.prepare('SELECT id, name, created_at FROM bots WHERE parent_bot_id=? AND hidden=1 ORDER BY created_at').all(parentId) as any[]).map((s) => {
    const last = db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='message' ORDER BY seq DESC LIMIT 1").get(s.id) as any;
    const live = getLive(s.id);
    return {
      id: s.id,
      name: s.name,
      running: live.isRunning,
      activity: live.activity?.kind ?? null,
      lastMessage: last ? String(JSON.parse(last.body).text ?? '').slice(0, 300) : null,
      startedAt: s.created_at,
    };
  });
}

export async function deleteSubagent(parentId: string, subId: string) {
  const s = db.prepare('SELECT user_id FROM bots WHERE id=? AND parent_bot_id=?').get(subId, parentId) as any;
  if (!s) return false;
  await stopDesktop(s.user_id, subId);
  db.prepare('DELETE FROM screens WHERE bot_id=?').run(subId);
  db.prepare('DELETE FROM bots WHERE id=?').run(subId);
  return true;
}
