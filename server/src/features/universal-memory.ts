import { db, now } from '../db.js';
import '../db-config.js';
import { hub } from '../lib/hub.js';
import { newId } from '../lib/ids.js';
import type { UniversalMemory } from '../types.js';

/**
 * Universal memory: durable facts that belong to the user's whole team instead of one Bot.
 * They are injected into every Bot's prompt (existing and future) next to its own memories.
 * There is one row per user and fact, never a copy per Bot.
 */

export const MAX_UNIVERSAL_MEMORIES = 50;
export const MAX_UNIVERSAL_MEMORY_TEXT = 600;
/** Characters of the prompt given to universal memories. */
export const UNIVERSAL_MEMORY_BUDGET = 3000;

/** Shipped universal memories. A new user gets them once; deleting one keeps it deleted. */
export const DEFAULT_UNIVERSAL_MEMORIES = [
  { key: 'claude-code-auto-mode', text: 'Claude Code is always launched in auto mode (never don\'t ask mode unless explicitly instructed by the user).' },
] as const;

const norm = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
const cleanText = (text: unknown) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_UNIVERSAL_MEMORY_TEXT);

export const toUniversalMemory = (r: any): UniversalMemory => ({
  id: r.id, text: r.text, createdAt: r.created_at, updatedAt: r.updated_at ?? r.created_at, universal: true,
});

const byText = (userId: string, text: string) =>
  (db.prepare('SELECT * FROM universal_memories WHERE user_id=?').all(userId) as any[]).find(r => norm(r.text) === norm(text));

/** Seed the shipped universal memories for a user. Idempotent: each one is handled once per user. */
export function ensureUniversalMemories(userId: string) {
  const seeded = new Set((db.prepare('SELECT key FROM universal_memory_seeds WHERE user_id=?').all(userId) as { key: string }[]).map(r => r.key));
  const pending = DEFAULT_UNIVERSAL_MEMORIES.filter(d => !seeded.has(d.key));
  if (!pending.length) return;
  db.transaction(() => {
    for (const d of pending) {
      if (!byText(userId, d.text)) {
        db.prepare('INSERT INTO universal_memories(id,user_id,text,created_at,updated_at) VALUES (?,?,?,?,?)').run(newId('umem'), userId, d.text, now(), now());
      }
      db.prepare('INSERT OR IGNORE INTO universal_memory_seeds(user_id,key) VALUES (?,?)').run(userId, d.key);
    }
  })();
}

/** Run the seeding for every existing user (called once at startup). */
export function migrateUniversalMemories() {
  for (const u of db.prepare('SELECT id FROM users').all() as { id: string }[]) ensureUniversalMemories(u.id);
}

export function listUniversalMemories(userId: string): UniversalMemory[] {
  ensureUniversalMemories(userId);
  return (db.prepare('SELECT * FROM universal_memories WHERE user_id=? ORDER BY created_at ASC, rowid ASC').all(userId) as any[]).map(toUniversalMemory);
}

export const getUniversalMemory = (userId: string, id: string) =>
  db.prepare('SELECT * FROM universal_memories WHERE id=? AND user_id=?').get(id, userId) as any | undefined;

/** Tell open settings screens that a shared memory changed. */
function announce(userId: string) {
  for (const b of db.prepare('SELECT id FROM bots WHERE user_id=?').all(userId) as { id: string }[]) hub.emit(userId, { type: 'memories', botId: b.id });
}

export type UniversalMemoryResult = { ok: true; memory: UniversalMemory; created: boolean } | { ok: false; message: string };

/** Add a universal memory; an identical one (ignoring case and spacing) is reused instead of duplicated. */
export function addUniversalMemory(userId: string, textInput: unknown): UniversalMemoryResult {
  ensureUniversalMemories(userId);
  const text = cleanText(textInput);
  if (!text) return { ok: false, message: 'Write the memory first.' };
  const existing = byText(userId, text);
  if (existing) return { ok: true, created: false, memory: toUniversalMemory(existing) };
  const count = (db.prepare('SELECT COUNT(*) n FROM universal_memories WHERE user_id=?').get(userId) as { n: number }).n;
  if (count >= MAX_UNIVERSAL_MEMORIES) return { ok: false, message: `You already have ${MAX_UNIVERSAL_MEMORIES} universal memories. Edit or delete one first.` };
  const id = newId('umem');
  db.prepare('INSERT INTO universal_memories(id,user_id,text,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, userId, text, now(), now());
  announce(userId);
  return { ok: true, created: true, memory: toUniversalMemory(db.prepare('SELECT * FROM universal_memories WHERE id=?').get(id)) };
}

export function updateUniversalMemory(userId: string, id: string, textInput: unknown): UniversalMemoryResult {
  const cur = getUniversalMemory(userId, id);
  if (!cur) return { ok: false, message: 'not found' };
  const text = cleanText(textInput);
  if (!text) return { ok: false, message: 'Write the memory first.' };
  const clash = byText(userId, text);
  if (clash && clash.id !== cur.id) return { ok: false, message: 'That universal memory already exists.' };
  db.prepare('UPDATE universal_memories SET text=?, updated_at=? WHERE id=?').run(text, now(), cur.id);
  announce(userId);
  return { ok: true, created: false, memory: toUniversalMemory(db.prepare('SELECT * FROM universal_memories WHERE id=?').get(cur.id)) };
}

export function deleteUniversalMemory(userId: string, id: string): boolean {
  const cur = getUniversalMemory(userId, id);
  if (!cur) return false;
  db.prepare('DELETE FROM universal_memories WHERE id=?').run(cur.id);
  announce(userId);
  return true;
}

/** Prompt lines for a user's universal memories, oldest first, within a character budget. */
export function universalMemoriesForPrompt(userId: string, budget = UNIVERSAL_MEMORY_BUDGET): { lines: string[]; omitted: number } {
  const all = listUniversalMemories(userId);
  const lines: string[] = [];
  let used = 0;
  for (const m of all) {
    if (used + m.text.length + 3 > budget) continue;
    lines.push(`- ${m.text}`);
    used += m.text.length + 3;
  }
  return { lines, omitted: all.length - lines.length };
}

/** Universal memories matching a recall query (all of them when the query has no usable words). */
export function searchUniversalMemories(userId: string, words: string[]): string[] {
  return listUniversalMemories(userId)
    .filter(m => !words.length || words.some(w => m.text.toLowerCase().includes(w)))
    .map(m => m.text);
}
