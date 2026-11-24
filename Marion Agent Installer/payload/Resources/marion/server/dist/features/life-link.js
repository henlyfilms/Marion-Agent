import { db, now } from '../db.js';
import { hub } from '../lib/hub.js';
import { getLive } from '../store.js';
import { getSecret, getSetting, setSecret, setSetting } from './schema.js';
const DEFAULTS = { enabled: false, supabaseUrl: '', lifeEmail: '', lifeUserId: '', lastSyncAt: null, lastError: null, syncedChats: 0 };
const TABLE = 'life_agent_chats';
const keyName = (userId) => `life_service_key:${userId}`;
export const lifeLinkSettings = (userId) => getSetting(userId, 'life-link', DEFAULTS);
export const hasLifeKey = (userId) => Boolean(getSecret(keyName(userId)));
function normalizeUrl(raw) {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))
        throw new Error('Use your Supabase project URL (https://….supabase.co).');
    return url.origin;
}
async function supabase(settings, key, path, init = {}) {
    const response = await fetch(`${settings.supabaseUrl}${path}`, {
        ...init,
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (response.status === 404 || /42P01|does not exist|schema cache/.test(text)) {
            throw new Error(`The ${TABLE} table is missing. Run docs/marion-life-agent-chats.sql in Supabase → SQL Editor first.`);
        }
        if (response.status === 401 || response.status === 403)
            throw new Error('Supabase refused the key. Paste the service_role key from Project Settings → API.');
        throw new Error(`Supabase answered ${response.status}: ${text.slice(0, 200)}`);
    }
    return response;
}
/** Save the connection, find the Life account by email, and check the table exists. */
export async function connectLife(userId, input) {
    const current = lifeLinkSettings(userId);
    const next = { ...current };
    if (input.supabaseUrl !== undefined)
        next.supabaseUrl = input.supabaseUrl ? normalizeUrl(input.supabaseUrl) : '';
    if (input.lifeEmail !== undefined)
        next.lifeEmail = input.lifeEmail.trim().toLowerCase();
    if (input.serviceKey)
        setSecret(keyName(userId), input.serviceKey.trim());
    const key = getSecret(keyName(userId));
    if (input.enabled === false) {
        next.enabled = false;
        setSetting(userId, 'life-link', next);
        return next;
    }
    if (!next.supabaseUrl || !key || !next.lifeEmail)
        throw new Error('Add the Supabase URL, service key and your Marion Life email.');
    const users = await (await supabase(next, key, '/auth/v1/admin/users?per_page=1000')).json();
    const match = users.users?.find(user => user.email?.toLowerCase() === next.lifeEmail);
    if (!match)
        throw new Error(`No Marion Life account uses ${next.lifeEmail}.`);
    next.lifeUserId = match.id;
    await supabase(next, key, `/rest/v1/${TABLE}?select=id&limit=1`);
    next.enabled = true;
    next.lastError = null;
    setSetting(userId, 'life-link', next);
    queueMicrotask(() => { void syncLife(userId).catch(() => { }); });
    return next;
}
export function disconnectLife(userId) {
    setSecret(keyName(userId), null);
    setSetting(userId, 'life-link', DEFAULTS);
}
/** Chats changed since their last sync, for idle bots only (so half-finished replies aren't copied). */
function pendingChats(userId, force) {
    const rows = db.prepare(`
    SELECT r.bot_id, r.generation, MAX(r.updated_seq) rev, MIN(r.created_at) first_at, MAX(r.created_at) last_at, COUNT(*) count
    FROM rows r JOIN bots b ON b.id=r.bot_id
    WHERE b.user_id=? AND COALESCE(b.hidden,0)=0 AND r.kind='message'
    GROUP BY r.bot_id, r.generation`).all(userId);
    return rows.filter(row => {
        if (getLive(row.bot_id).isRunning)
            return false;
        if (force)
            return true;
        const synced = db.prepare('SELECT synced_rev FROM life_sync WHERE bot_id=? AND generation=?').get(row.bot_id, row.generation);
        return !synced || synced.synced_rev < row.rev;
    });
}
function chatDocument(row) {
    const bot = db.prepare('SELECT name, label FROM bots WHERE id=?').get(row.bot_id);
    const messages = db.prepare("SELECT body, created_at FROM rows WHERE bot_id=? AND generation=? AND kind='message' ORDER BY seq").all(row.bot_id, row.generation)
        .map(r => ({ ...JSON.parse(r.body), at: r.created_at }))
        .filter(body => body.text && !body.streaming);
    const firstUser = messages.find(m => m.role === 'user' && !m.from);
    const transcript = messages.map(m => {
        const who = m.from?.name ?? (m.role === 'assistant' ? bot.name : 'You');
        const files = m.attachments?.length ? `\nAttachments: ${m.attachments.map((a) => a.name).join(', ')}` : '';
        return `[${new Date(m.at).toISOString()}] ${who}:\n${m.text}${files}`;
    }).join('\n\n');
    return {
        title: (firstUser?.text ?? `Chat with ${bot.name}`).replace(/\s+/g, ' ').slice(0, 120),
        bot_name: bot.name,
        bot_job: bot.label || null,
        transcript: transcript.slice(0, 500_000),
        message_count: messages.length,
    };
}
const syncing = new Set();
export async function syncLife(userId, opts = {}) {
    const settings = lifeLinkSettings(userId);
    const key = getSecret(keyName(userId));
    if (!settings.enabled || !key || !settings.lifeUserId || syncing.has(userId))
        return { synced: 0 };
    syncing.add(userId);
    let synced = 0;
    const errorBefore = settings.lastError;
    try {
        const chats = pendingChats(userId, Boolean(opts.force));
        for (let i = 0; i < chats.length; i += 20) {
            const batch = chats.slice(i, i + 20);
            const payload = batch.map(row => ({
                id: `${row.bot_id}:${row.generation}`,
                user_id: settings.lifeUserId,
                marion_bot_id: row.bot_id,
                generation: row.generation,
                ...chatDocument(row),
                started_at: new Date(row.first_at).toISOString(),
                last_message_at: new Date(row.last_at).toISOString(),
                source: 'marion-agent',
            }));
            await supabase(settings, key, `/rest/v1/${TABLE}?on_conflict=id`, {
                method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(payload),
            });
            const mark = db.prepare(`INSERT INTO life_sync(bot_id,generation,synced_rev,synced_at,error) VALUES (?,?,?,?,NULL)
        ON CONFLICT(bot_id,generation) DO UPDATE SET synced_rev=excluded.synced_rev, synced_at=excluded.synced_at, error=NULL`);
            for (const row of batch)
                mark.run(row.bot_id, row.generation, row.rev, now());
            synced += batch.length;
        }
        const total = db.prepare('SELECT COUNT(*) n FROM life_sync s JOIN bots b ON b.id=s.bot_id WHERE b.user_id=?').get(userId).n;
        setSetting(userId, 'life-link', { ...lifeLinkSettings(userId), lastSyncAt: now(), lastError: null, syncedChats: total });
        return { synced };
    }
    catch (error) {
        setSetting(userId, 'life-link', { ...lifeLinkSettings(userId), lastError: error.message.slice(0, 300) });
        throw error;
    }
    finally {
        syncing.delete(userId);
        // Only tell open windows when something visible changed (avoid a refetch every minute).
        if (synced || lifeLinkSettings(userId).lastError !== errorBefore)
            hub.emit(userId, { type: 'connections' });
    }
}
/** Every minute, copy changed chats of every linked workspace. */
export function startLifeSync() {
    const timer = setInterval(() => {
        const users = db.prepare("SELECT user_id FROM user_settings WHERE key='life-link'").all();
        for (const { user_id } of users)
            void syncLife(user_id).catch(() => { });
    }, 60_000);
    timer.unref?.();
}
//# sourceMappingURL=life-link.js.map