import { db, now } from '../db.js';
import { hub } from '../lib/hub.js';
import { newId } from '../lib/ids.js';
import { getBotRow } from '../store.js';
import { backgroundText, parseJsonObject } from '../agent/background-model.js';
import { similar } from '../agent/memory.js';
import { notify } from './notify.js';

export const LESSONS_SKILL = 'Lessons learned';
const MAX_LESSONS = 30;

/** Create or update (same name, case-insensitive) one of a bot's skills. */
export function saveLearnedSkill(botId: string, name: string, description: string, body: string) {
  const cleanName = name.replace(/\s+/g, ' ').trim().slice(0, 80);
  const cleanBody = body.trim().slice(0, 12_000);
  if (!cleanName || !cleanBody) return { ok: false, message: 'A skill needs a name and steps.' };
  const bot = getBotRow(botId);
  if (!bot) return { ok: false, message: 'Bot not found.' };
  const existing = db.prepare('SELECT id FROM skills WHERE bot_id=? AND lower(name)=lower(?)').get(botId, cleanName) as { id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE skills SET body=?, description=?, updated_at=? WHERE id=?').run(cleanBody, description.trim().slice(0, 300), now(), existing.id);
  } else {
    const count = (db.prepare('SELECT COUNT(*) n FROM skills WHERE bot_id=?').get(botId) as { n: number }).n;
    if (count >= 60) return { ok: false, message: 'This Bot already has 60 skills. Update an existing one instead.' };
    db.prepare('INSERT INTO skills(id,bot_id,name,body,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(newId('skl'), botId, cleanName, cleanBody, description.trim().slice(0, 300), now(), now());
  }
  hub.emit(bot.user_id, { type: 'memories', botId });
  return { ok: true, message: `${existing ? 'Updated' : 'Saved'} skill "${cleanName}".` };
}

/** Merge new lessons into the bot's "Lessons learned" skill, skipping near-duplicates. Returns how many were added. */
export function addLessons(botId: string, lessons: string[]) {
  const row = db.prepare('SELECT body FROM skills WHERE bot_id=? AND name=?').get(botId, LESSONS_SKILL) as { body: string } | undefined;
  const current = (row?.body ?? '').split('\n').map(line => line.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
  const added: string[] = [];
  for (const raw of lessons) {
    const lesson = raw.replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!lesson || [...current, ...added].some(existing => similar(existing, lesson))) continue;
    added.push(lesson);
  }
  if (!added.length) return 0;
  const merged = [...current, ...added].slice(-MAX_LESSONS);
  saveLearnedSkill(botId, LESSONS_SKILL, 'What this Bot learned from past chats. It follows these automatically.', merged.map(line => `- ${line}`).join('\n'));
  return added.length;
}

const REFLECT_PROMPT = `You help an AI assistant ("Bot") improve itself from its recent work.
Read the conversation and the Bot's current skills. Find:
1. lessons: concrete, reusable rules the Bot should follow next time, learned from user corrections, complaints, repeated requests, failures, or things that worked well. Each under 200 characters, written as an instruction ("Always...", "When X, do Y"). Skip one-off facts about the user (memory handles those) and anything already covered by the skills.
2. skills: only when the conversation shows a multi-step process the Bot will clearly repeat (or the user taught one), a playbook of 3-12 numbered steps. Reuse an existing skill's exact name to improve it.
Return JSON only: {"lessons": ["..."], "skills": [{"name": "...", "description": "...", "body": "..."}]}. Return empty lists when nothing qualifies. At most 4 lessons and 2 skills.`;

const reflecting = new Set<string>();

/** Learn from user messages newer than the last reflection. Needs at least 3 of them. */
export async function reflectBot(botId: string, opts: { force?: boolean } = {}) {
  const bot = getBotRow(botId);
  if (!bot || bot.kind === 'room' || bot.hidden || reflecting.has(botId)) return { lessons: 0, skills: 0 };
  const since = bot.last_reflected_at ?? 0;
  const rows = (db.prepare("SELECT body, created_at FROM rows WHERE bot_id=? AND kind='message' AND created_at>? ORDER BY created_at DESC LIMIT 80").all(botId, since) as any[]).reverse();
  const messages = rows.map(row => ({ ...JSON.parse(row.body), at: row.created_at })).filter(body => body.text && !body.streaming);
  const userMessages = messages.filter(body => body.role === 'user' && !body.from).length;
  if (!opts.force && userMessages < 3) return { lessons: 0, skills: 0 };
  if (!messages.length) return { lessons: 0, skills: 0 };
  reflecting.add(botId);
  try {
    let transcript = messages.map(m => `${m.role === 'user' ? (m.from ? `${m.from.name}` : 'User') : bot.name}: ${String(m.text).slice(0, 1500)}`).join('\n');
    if (transcript.length > 20_000) transcript = transcript.slice(-20_000);
    const skills = (db.prepare('SELECT name, body FROM skills WHERE bot_id=?').all(botId) as any[]).map(s => `### ${s.name}\n${String(s.body).slice(0, 1500)}`).join('\n\n');
    const reply = await backgroundText(botId, REFLECT_PROMPT, `CURRENT SKILLS:\n${skills || '(none)'}\n\nRECENT CONVERSATION:\n${transcript}`);
    const parsed = parseJsonObject<{ lessons?: unknown[]; skills?: { name?: string; description?: string; body?: string }[] }>(reply) ?? {};
    const lessons = addLessons(botId, (parsed.lessons ?? []).map(String).slice(0, 4));
    let skillCount = 0;
    for (const skill of (parsed.skills ?? []).slice(0, 2)) {
      if (skill?.name && skill.body && skill.name.toLowerCase() !== LESSONS_SKILL.toLowerCase()) {
        if (saveLearnedSkill(botId, skill.name, skill.description ?? '', skill.body).ok) skillCount++;
      }
    }
    db.prepare('UPDATE bots SET last_reflected_at=? WHERE id=?').run(messages[messages.length - 1].at, botId);
    if (lessons || skillCount) {
      console.log(`[improve] ${bot.name}: +${lessons} lessons, ${skillCount} skills`);
      notify(bot.user_id, { kind: 'learned', botId, title: `${bot.name} improved itself`, body: [lessons ? `${lessons} new lesson${lessons === 1 ? '' : 's'}` : '', skillCount ? `${skillCount} skill${skillCount === 1 ? '' : 's'} updated` : ''].filter(Boolean).join(', ') });
    }
    return { lessons, skills: skillCount };
  } finally {
    reflecting.delete(botId);
  }
}
