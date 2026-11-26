import { Cron } from 'croner';
import { DEFAULT_STEM_COLOR, isAvatarColor, isStemColor, resolveAvatarShape } from '../avatarShapes.js';
import { db, now } from '../db.js';
import { hub } from '../lib/hub.js';
import { newId } from '../lib/ids.js';
import { getBot, toRoutine } from '../store.js';
import { scheduleRoutine } from '../routines.js';
import { ensureUniversalSkills, universalNames } from './universal-skills.js';
import type { AvatarColor, Bot } from '../types.js';

export const BOT_COLORS: AvatarColor[] = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray'];

export interface BotSpec {
  name: string;
  label?: string;
  description?: string;
  instructions?: string;
  avatarShape?: string;
  avatarColor?: string;
  avatarStemColor?: string | null;
  avatarGlow?: boolean;
  mode?: string;
  isPrimary?: boolean;
  role?: 'executive' | null;
  templateId?: string | null;
  integrations?: string[];
  memories?: string[];
  skills?: { name: string; description?: string; body: string }[];
  routines?: { name: string; prompt: string; schedule: string; timezone?: string; enabled?: boolean }[];
}

const clean = (value: unknown, max: number) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);

function pick<T>(seed: string, list: T[]): T {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return list[hash % list.length];
}

/** Create a bot with everything a template or the Bot Builder can give it, in one transaction. */
export function createBotRecord(userId: string, spec: BotSpec): Bot {
  const id = newId('bot');
  const shape = resolveAvatarShape(spec.avatarShape);
  const stem = spec.avatarStemColor === null || isStemColor(spec.avatarStemColor) ? spec.avatarStemColor : DEFAULT_STEM_COLOR;
  const color = isAvatarColor(spec.avatarColor) ? spec.avatarColor.toLowerCase() : pick(id, BOT_COLORS.filter(c => c !== 'black'));
  const integrations = [...new Set((spec.integrations ?? []).map(slug => clean(slug, 40).toLowerCase()).filter(slug => /^[a-z0-9_-]+$/.test(slug)))].slice(0, 20);
  const routines: string[] = [];
  // Universal skills (Token optimizer, Marion Agent guide, ...) reach this Bot through the user's team, never as a per-Bot copy.
  ensureUniversalSkills(userId);
  const shared = universalNames(userId);
  db.transaction(() => {
    db.prepare(`INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,avatar_stem_color,avatar_glow,mode,is_primary,role,template_id,integrations,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, userId, clean(spec.name, 60) || 'New Bot', clean(spec.label, 80), clean(spec.description, 600), clean(spec.instructions, 20_000),
      shape, color, stem, spec.avatarGlow ? 1 : 0, spec.mode === 'teammate' ? 'teammate' : 'personal', spec.isPrimary ? 1 : 0,
      spec.role === 'executive' ? 'executive' : null, spec.templateId ?? null, integrations.length ? JSON.stringify(integrations) : null, now(), now(),
    );
    const memory = db.prepare("INSERT INTO memories(id,bot_id,text,created_at,source) VALUES (?,?,?,?,'chat')");
    for (const text of (spec.memories ?? []).slice(0, 40)) if (clean(text, 300)) memory.run(newId('mem'), id, clean(text, 300), now());
    const skill = db.prepare('INSERT INTO skills(id,bot_id,name,body,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
    for (const s of (spec.skills ?? []).slice(0, 30)) {
      if (clean(s.name, 80) && clean(s.body, 20_000) && !shared.has(clean(s.name, 80).replace(/\s+/g, ' ').toLowerCase())) skill.run(newId('skl'), id, clean(s.name, 80), clean(s.body, 20_000), clean(s.description, 300), now(), now());
    }
    const routine = db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES (?,?,?,?,?,?,?,?)');
    for (const r of (spec.routines ?? []).slice(0, 12)) {
      const timezone = clean(r.timezone, 60) || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      try { new Cron(r.schedule, { paused: true, timezone }); } catch { continue; }
      const routineId = newId('rt');
      routine.run(routineId, id, clean(r.name, 80) || 'Routine', clean(r.prompt, 4000), r.schedule, timezone, r.enabled === false ? 0 : 1, now());
      routines.push(routineId);
    }
  })();
  for (const routineId of routines) {
    const r = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(routineId));
    if (r.enabled) scheduleRoutine(r);
  }
  hub.emit(userId, { type: 'roster' });
  return getBot(id)!;
}
