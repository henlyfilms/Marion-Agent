import { saveAttachments } from './attachments.js';
import { db, now } from './db.js';
import { hub } from './lib/hub.js';
import { Cron } from 'croner';
import { chatModelForBot } from './agent/chat-model.js';
// ---------- bots ----------
export function toBot(r) {
    const last = db
        .prepare("SELECT body, created_at FROM rows WHERE bot_id=? AND generation=? AND kind IN ('message','card','event') ORDER BY seq DESC LIMIT 1")
        .get(r.id, r.generation);
    let lastPreview = null;
    if (last) {
        const b = JSON.parse(last.body);
        lastPreview =
            b.type === 'message' ? b.text : b.type === 'card' ? (b.card === 'approval' ? `Waiting for you: ${b.title}` : b.card === 'question' ? b.question : b.card === 'connect' ? `Connect ${b.toolkitName}` : 'Draft') : b.type === 'event' ? b.text : null;
    }
    return {
        id: r.id,
        name: r.name,
        label: r.label,
        description: r.description,
        instructions: r.instructions,
        avatarShape: r.avatar_shape,
        avatarColor: r.avatar_color,
        avatarStemColor: r.avatar_stem_color,
        mode: r.mode,
        isPrimary: !!r.is_primary,
        kind: r.kind === 'room' ? 'room' : 'agent',
        pinned: !!r.pinned,
        sortPosition: r.sort_position,
        chatModel: chatModelForBot(r),
        effort: r.effort,
        voice: r.voice ?? 'luna',
        voiceSpeed: r.voice_speed ?? 1,
        voiceLanguage: r.voice_language ?? 'auto',
        generation: r.generation,
        unread: r.unread,
        lastPreview: lastPreview ? lastPreview.slice(0, 140) : null,
        lastActivityAt: last?.created_at ?? r.updated_at,
        completedAt: r.completed_at,
        createdAt: r.created_at,
        role: r.role === 'executive' ? 'executive' : null,
        templateId: r.template_id ?? null,
        contextTokens: r.context_tokens ?? null,
        compactAtTokens: r.compact_at_tokens ?? null,
        integrations: (() => { try {
            return r.integrations ? JSON.parse(r.integrations) : [];
        }
        catch {
            return [];
        } })(),
    };
}
export const getBotRow = (id) => db.prepare('SELECT * FROM bots WHERE id=?').get(id);
export const getBot = (id) => {
    const r = getBotRow(id);
    return r ? toBot(r) : null;
};
export const listBots = (userId) => db.prepare('SELECT * FROM bots WHERE user_id=? AND COALESCE(hidden,0)=0 ORDER BY is_primary DESC, created_at ASC').all(userId).map(toBot);
export function emitBot(botId) {
    const r = getBotRow(botId);
    if (r)
        hub.emit(r.user_id, { type: 'bot', bot: toBot(r) });
}
// ---------- rows ----------
function toRow(r) {
    return { botId: r.bot_id, generation: r.generation, seq: r.seq, updatedSeq: r.updated_seq, kind: r.kind, body: JSON.parse(r.body), createdAt: r.created_at };
}
function bumpRev(botId) {
    db.prepare('UPDATE bots SET rev = rev + 1, updated_at=? WHERE id=?').run(now(), botId);
    return db.prepare('SELECT rev FROM bots WHERE id=?').get(botId).rev;
}
/** Append a new row. Returns its seq. */
export function appendRow(botId, kind, body, attachments) {
    const tx = db.transaction(() => {
        const b = db.prepare('SELECT user_id, generation, next_seq FROM bots WHERE id=?').get(botId);
        const seq = b.next_seq;
        db.prepare('UPDATE bots SET next_seq = next_seq + 1 WHERE id=?').run(botId);
        const rev = bumpRev(botId);
        const t = now();
        db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)').run(botId, b.generation, seq, rev, kind, JSON.stringify(body), t);
        if (attachments?.length)
            saveAttachments(botId, b.generation, seq, attachments);
        return { userId: b.user_id, row: { botId, generation: b.generation, seq, updatedSeq: rev, kind, body, createdAt: t } };
    });
    const { userId, row } = tx();
    hub.emit(userId, { type: 'rows', botId, generation: row.generation, rows: [row] });
    return row;
}
/** Rewrite an existing row's body (e.g. streaming text, card status). */
export function updateRow(botId, seq, body) {
    const tx = db.transaction(() => {
        const b = db.prepare('SELECT user_id, generation FROM bots WHERE id=?').get(botId);
        const existing = db.prepare('SELECT * FROM rows WHERE bot_id=? AND generation=? AND seq=?').get(botId, b.generation, seq);
        if (!existing)
            return null;
        const rev = bumpRev(botId);
        db.prepare('UPDATE rows SET body=?, updated_seq=? WHERE bot_id=? AND generation=? AND seq=?').run(JSON.stringify(body), rev, botId, b.generation, seq);
        return { userId: b.user_id, row: { ...toRow(existing), body, updatedSeq: rev } };
    });
    const res = tx();
    if (!res)
        return null;
    hub.emit(res.userId, { type: 'rows', botId, generation: res.row.generation, rows: [res.row] });
    return res.row;
}
export function getRow(botId, seq) {
    const b = getBotRow(botId);
    const r = db.prepare('SELECT * FROM rows WHERE bot_id=? AND generation=? AND seq=?').get(botId, b.generation, seq);
    return r ? toRow(r) : null;
}
export function listRows(botId, opts = {}) {
    const b = getBotRow(botId);
    if (!b)
        return [];
    if (opts.afterRev !== undefined) {
        return db.prepare('SELECT * FROM rows WHERE bot_id=? AND generation=? AND updated_seq>? ORDER BY seq ASC').all(botId, b.generation, opts.afterRev).map(toRow);
    }
    const limit = Math.min(opts.limit ?? 200, 500);
    const rows = (opts.beforeSeq
        ? db.prepare('SELECT * FROM rows WHERE bot_id=? AND generation=? AND seq<? ORDER BY seq DESC LIMIT ?').all(botId, b.generation, opts.beforeSeq, limit)
        : db.prepare('SELECT * FROM rows WHERE bot_id=? AND generation=? ORDER BY seq DESC LIMIT ?').all(botId, b.generation, limit));
    return rows.reverse().map(toRow);
}
export function chatTranscript(botId, generation, title) {
    const messages = db.prepare(`SELECT body FROM rows WHERE bot_id=? AND generation=? AND kind='message' ORDER BY seq`)
        .iterate(botId, generation);
    const sections = [title];
    for (const row of messages) {
        const body = JSON.parse(row.body);
        if (body.type !== 'message' || body.streaming)
            continue;
        const who = body.from?.name ?? (body.role === 'assistant' ? title : 'You');
        const filenames = body.attachments?.map(file => file.name).join(', ');
        sections.push(`[${who}]\n${body.text}${filenames ? '\nAttachments: ' + filenames : ''}`);
    }
    return sections.join('\n\n') + '\n';
}
export function clearConversation(botId) {
    const b = getBotRow(botId);
    db.prepare('UPDATE bots SET generation = generation + 1, next_seq = 1, completed_at=NULL, context_tokens=NULL WHERE id=?').run(botId);
    db.prepare('DELETE FROM pending_turns WHERE bot_id=?').run(botId);
    hub.emit(b.user_id, { type: 'cleared', botId, generation: b.generation + 1 });
}
// ---------- LLM history (Responses API input items) ----------
export function loadHistory(botId) {
    const b = getBotRow(botId);
    return db.prepare('SELECT item FROM llm_items WHERE bot_id=? AND generation=? ORDER BY idx ASC').all(botId, b.generation).map((r) => JSON.parse(r.item));
}
export function appendHistory(botId, items) {
    if (!items.length)
        return;
    const b = getBotRow(botId);
    const start = (db.prepare('SELECT MAX(idx) m FROM llm_items WHERE bot_id=? AND generation=?').get(botId, b.generation).m ?? -1) + 1;
    const ins = db.prepare('INSERT INTO llm_items(bot_id,generation,idx,item) VALUES (?,?,?,?)');
    db.transaction(() => items.forEach((it, i) => ins.run(botId, b.generation, start + i, JSON.stringify(it))))();
}
// ---------- live state ----------
const live = new Map();
export function getLive(botId) {
    return live.get(botId) ?? { botId, isRunning: false, activity: null, awaiting: null, startedAt: null };
}
export function setLive(botId, patch) {
    const next = { ...getLive(botId), ...patch, botId };
    live.set(botId, next);
    const b = getBotRow(botId);
    if (b)
        hub.emit(b.user_id, { type: 'live', state: next });
}
export const allLive = (userId) => listBots(userId).map((b) => getLive(b.id));
// ---------- routines / tasks ----------
export function describeCron(expr) {
    const p = expr.trim().split(/\s+/);
    if (p.length !== 5)
        return expr;
    const [m, h, dom, mon, dow] = p;
    const time = /^\d+$/.test(m) && /^\d+$/.test(h) ? new Date(2000, 0, 1, +h, +m).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : null;
    if (time && dom === '*' && mon === '*' && dow === '*')
        return `Every day at ${time}`;
    if (time && dom === '*' && mon === '*' && dow === '1-5')
        return `Weekdays at ${time}`;
    if (time && dom === '*' && mon === '*' && /^[0-6]$/.test(dow))
        return `Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][+dow]} at ${time}`;
    if (m === '0' && h === '*')
        return 'Every hour';
    if (/^\*\/\d+$/.test(m) && h === '*' && dom === '*' && mon === '*' && dow === '*')
        return `Every ${m.slice(2)} minutes`;
    if (m === '0' && /^\*\/\d+$/.test(h) && dom === '*' && mon === '*' && dow === '*')
        return `Every ${h.slice(2)} hours`;
    return expr;
}
function describeEventSlug(schedule) {
    const words = schedule.slice(6).split('_');
    const app = words.shift() ?? '';
    return `When ${app.charAt(0) + app.slice(1).toLowerCase()}: ${words.join(' ').toLowerCase()}`;
}
export function toRoutine(r) {
    let nextRunAt = null;
    try {
        nextRunAt = r.enabled ? new Cron(r.schedule, { timezone: r.timezone, paused: true }).nextRun()?.getTime() ?? null : null;
    }
    catch { /* invalid cron */ }
    return {
        id: r.id, botId: r.bot_id, name: r.name, prompt: r.prompt, schedule: r.schedule, timezone: r.timezone,
        enabled: !!r.enabled, nextRunAt, lastRunAt: r.last_run_at, description: r.schedule.startsWith('event:') ? describeEventSlug(r.schedule) : describeCron(r.schedule),
    };
}
export const listRoutines = (botId) => db.prepare('SELECT * FROM routines WHERE bot_id=? ORDER BY created_at').all(botId).map(toRoutine);
export const toTask = (r) => ({ id: r.id, botId: r.bot_id, title: r.title, state: r.state, note: r.note, updatedAt: r.updated_at });
export const listTasks = (botId) => db.prepare('SELECT * FROM tasks WHERE bot_id=? ORDER BY updated_at DESC').all(botId).map(toTask);
//# sourceMappingURL=store.js.map