import { getAttachment, MAX_ATTACHMENTS, photos, type UploadedAttachment } from '../attachments.js';
import type { ChatAttachment } from '../types.js';
import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { hub } from '../lib/hub.js';
import { appendRow } from '../store.js';
import { chatModelForBot } from './chat-model.js';

/**
 * Group chats ("rooms").
 * A room is a bot row with kind='room' and a members list. It never runs its own agent loop:
 * a user message is dispatched to the members who should answer (@mentioned ones, else all,
 * capped), each member runs its normal loop with the group context and replies into the room
 * with post_to_group.
 */

const MAX_RESPONDERS = 3;

export function initRooms() {
  for (const col of ["kind TEXT NOT NULL DEFAULT 'agent'", 'members TEXT']) {
    try { db.exec(`ALTER TABLE bots ADD COLUMN ${col}`); } catch { /* exists */ }
  }
}


export function roomMembers(roomId: string): { id: string; name: string; effort: string }[] {
  const r = db.prepare('SELECT members FROM bots WHERE id=?').get(roomId) as any;
  const ids: string[] = r?.members ? JSON.parse(r.members) : [];
  return ids.map((id) => db.prepare('SELECT id, name, effort FROM bots WHERE id=?').get(id) as any).filter(Boolean);
}

export function createRoom(userId: string, name: string, memberIds: string[]) {
  const id = newId('room');
  db.prepare(
    `INSERT INTO bots(id,user_id,name,label,description,avatar_shape,avatar_color,kind,members,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'room',?,?,?)`,
  ).run(id, userId, name.slice(0, 60), 'Group', `Group chat with ${memberIds.length} Bots`, 'cloud', 'gray', JSON.stringify(memberIds), now(), now());
  hub.emit(userId, { type: 'roster' });
  return id;
}

/** Called instead of the agent loop when the user posts in a room. */
export function dispatchRoomMessage(roomId: string, text: string, enqueue: (botId: string, t: any) => void, attachments?: UploadedAttachment[], note?: string) {
  const room = db.prepare('SELECT * FROM bots WHERE id=?').get(roomId) as any;
  const members = roomMembers(roomId);
  if (!members.length) {
    appendRow(roomId, 'notice', { type: 'notice', text: 'This group has no Bots yet.', tone: 'warn' });
    return;
  }
  const lower = text.toLowerCase();
  const mentioned = members.filter((m) => lower.includes(`@${m.name.toLowerCase()}`));
  const responders = (mentioned.length ? mentioned : members).slice(0, MAX_RESPONDERS);
  const { model } = chatModelForBot(room);
  const recent = (db.prepare("SELECT body FROM rows WHERE bot_id=? AND generation=? AND kind='message' ORDER BY seq DESC LIMIT 12").all(roomId, room.generation) as any[])
    .reverse()
    .map((r) => {
      const b = JSON.parse(r.body);
      const files = (b.attachments ?? []).length;
      return `${b.from?.name ?? (b.role === 'user' ? 'User' : 'Bot')}: ${String(b.text).slice(0, 600)}${files ? ` [${files} attachment${files === 1 ? '' : 's'}]` : ''}`;
    })
    .join('\n');
  // Images Bots posted since the user's previous message ride along, so members can see what the others shared.
  const shared = [...(attachments ?? []), ...photos(botImagesSinceUser(roomId, room.generation))].slice(0, MAX_ATTACHMENTS);
  for (const m of responders) {
    enqueue(m.id, {
      type: 'system',
      attachments: shared.length ? shared : undefined,
      local: { model, effort: m.effort },
      text:
        `[Group chat "${room.name}"] Members: ${members.map((x) => x.name).join(', ')}. ` +
        `${mentioned.length ? 'You were @mentioned.' : 'The user addressed the whole group.'}\n` +
        `Recent group messages:\n${recent}\n\n` + (note ? `${note}\n` : '') +
        `Reply to the group by calling post_to_group with group_name "${room.name}" (use your tools first if the request needs real work). ` +
        `Keep it short and don't repeat what other Bots already said. If you have nothing to add, call stay_silent. Do not write a normal reply.`,
    });
  }
}

/** Files on Bot posts after the user's previous message in the room (the newest user message is the one being dispatched). */
export function botImagesSinceUser(roomId: string, generation: number): UploadedAttachment[] {
  const rows = db.prepare("SELECT body FROM rows WHERE bot_id=? AND generation=? AND kind='message' ORDER BY seq DESC LIMIT 40").all(roomId, generation) as { body: string }[];
  const found: UploadedAttachment[] = [];
  let users = 0;
  for (const { body } of rows) {
    const message = JSON.parse(body);
    if (message.role === 'user' && message.from?.kind !== 'bot' && ++users > 1) break;
    if (message.from?.kind !== 'bot') continue;
    const files = ((message.attachments ?? []) as ChatAttachment[]).flatMap(file => {
      const saved = getAttachment(roomId, generation, file.id);
      return saved ? [{ id: file.id, name: saved.name, mime: saved.mime, size: saved.data.length, data: saved.data }] : [];
    });
    found.unshift(...files);
  }
  return found;
}

/** The group chat `fromBotId` may post to under this name, or the reason it can't (checked before any images are collected). */
export function roomForPost(fromBotId: string, roomName: string): { id: string; name: string } | string {
  const from = db.prepare('SELECT id, user_id, name FROM bots WHERE id=?').get(fromBotId) as any;
  if (!from) return 'You no longer exist.';
  const room = db.prepare("SELECT * FROM bots WHERE user_id=? AND kind='room' AND lower(name)=lower(?)").get(from.user_id, roomName.trim()) as any;
  if (!room) return `No group named "${roomName}".`;
  const members: string[] = room.members ? JSON.parse(room.members) : [];
  if (!members.includes(fromBotId)) return `You're not a member of "${room.name}".`;
  return { id: room.id, name: room.name };
}

export function postToRoom(fromBotId: string, roomName: string, text: string, attachments: UploadedAttachment[] = []) {
  const target = roomForPost(fromBotId, roomName);
  if (typeof target === 'string') return target;
  const from = db.prepare('SELECT id, name FROM bots WHERE id=?').get(fromBotId) as any;
  appendRow(target.id, 'message', {
    type: 'message', role: 'assistant', text, from: { kind: 'bot', id: from.id, name: from.name },
    ...(attachments.length ? { attachments: attachments.map(({ data, ...meta }) => meta) } : {}),
  }, attachments);
  db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(target.id);
  return 'Posted to the group.';
}
