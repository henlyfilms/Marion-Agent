import { Cron } from 'croner';
import { DEFAULT_BERRY, DEFAULT_STEM_COLOR, isBerryShape, isStemColor } from '../avatarShapes.js';
import { db, now } from '../db.js';
import { hub } from '../lib/hub.js';
import { newId } from '../lib/ids.js';
import { getBot, toRoutine } from '../store.js';
import { scheduleRoutine } from '../routines.js';
export const BOT_COLORS = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray'];
const clean = (value, max) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
function pick(seed, list) {
    let hash = 0;
    for (const char of seed)
        hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return list[hash % list.length];
}
/** Create a bot with everything a template or the Bot Builder can give it, in one transaction. */
export function createBotRecord(userId, spec) {
    const id = newId('bot');
    const shape = isBerryShape(spec.avatarShape) ? spec.avatarShape : DEFAULT_BERRY;
    const stem = spec.avatarStemColor === null || isStemColor(spec.avatarStemColor) ? spec.avatarStemColor : DEFAULT_STEM_COLOR;
    const color = BOT_COLORS.includes(spec.avatarColor) ? spec.avatarColor : pick(id, BOT_COLORS.filter(c => c !== 'black'));
    const integrations = [...new Set((spec.integrations ?? []).map(slug => clean(slug, 40).toLowerCase()).filter(slug => /^[a-z0-9_-]+$/.test(slug)))].slice(0, 20);
    const routines = [];
    db.transaction(() => {
        db.prepare(`INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,avatar_stem_color,mode,is_primary,role,template_id,integrations,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, userId, clean(spec.name, 60) || 'New Bot', clean(spec.label, 80), clean(spec.description, 600), clean(spec.instructions, 20_000), shape, color, stem, spec.mode === 'teammate' ? 'teammate' : 'personal', spec.isPrimary ? 1 : 0, spec.role === 'executive' ? 'executive' : null, spec.templateId ?? null, integrations.length ? JSON.stringify(integrations) : null, now(), now());
        const memory = db.prepare("INSERT INTO memories(id,bot_id,text,created_at,source) VALUES (?,?,?,?,'chat')");
        for (const text of (spec.memories ?? []).slice(0, 40))
            if (clean(text, 300))
                memory.run(newId('mem'), id, clean(text, 300), now());
        const skill = db.prepare('INSERT INTO skills(id,bot_id,name,body,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
        for (const s of (spec.skills ?? []).slice(0, 30)) {
            if (clean(s.name, 80) && clean(s.body, 20_000))
                skill.run(newId('skl'), id, clean(s.name, 80), clean(s.body, 20_000), clean(s.description, 300), now(), now());
        }
        const routine = db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES (?,?,?,?,?,?,?,?)');
        for (const r of (spec.routines ?? []).slice(0, 12)) {
            const timezone = clean(r.timezone, 60) || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
            try {
                new Cron(r.schedule, { paused: true, timezone });
            }
            catch {
                continue;
            }
            const routineId = newId('rt');
            routine.run(routineId, id, clean(r.name, 80) || 'Routine', clean(r.prompt, 4000), r.schedule, timezone, r.enabled === false ? 0 : 1, now());
            routines.push(routineId);
        }
    })();
    for (const routineId of routines) {
        const r = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(routineId));
        if (r.enabled)
            scheduleRoutine(r);
    }
    hub.emit(userId, { type: 'roster' });
    return getBot(id);
}
//# sourceMappingURL=bots.js.map