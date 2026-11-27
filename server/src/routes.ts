import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { forModel } from './video-frames.js';

/** Seams the tests replace (attachment preparation can fail; the question card must survive it). */
export const routeHooks = { forModel };
import { attachmentBodyLimit, getAttachment, getAttachmentInfo, getAttachmentSlice, parseByteRange, readAttachments, type UploadedAttachment } from './attachments.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { streamSSE } from 'hono/streaming';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { db, now, STARTER_AGENT } from './db.js';
import { env } from './env.js';
import { isDesktop } from './lib/desktop-access.js';
import { newId, token } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { archiveExists } from './features/deleted-archive.js';
import { archiveDeletedBot, noteRestoredBot } from './features/life-outbox.js';
import { createSession, destroySession, remoteAccessFor, remoteWorkspaceUser, requireUser, userFromCookieHeader, type AuthVars } from './lib/auth.js';
import { allLive, appendRow, chatTranscript, clearConversation, emitBot, findClientMessage, getBot, getBotRow, getLive, toBot, getRow, listBots, listRoutines, listRows, listTasks, pendingQuestion, setLive, toRoutine, toTask, updateRow } from './store.js';
import { enqueue, interrupt, isBotBusy, preemptWith, resolveApproval, runInBotQueue, stopBot } from './agent/loop.js';
import { classifyIntent } from './agent/chat-intent.js';
import { planLabels, planOptions, readProvider, savePlanLabels, subscriptionUsage, usageProviders, withPlanLabel } from './agent/subscription-usage.js';
import { chatModelForBot } from './agent/chat-model.js';
import { subscriptionModels } from './agent/subscriptions.js';
import { availableLocalModels } from './agent/models.js';
import { localEfforts } from './agent/models.js';
import { computerState, ensureComputer, refreshComputer, screenFor, stopDesktop, suspendComputer } from './computer.js';
import { desktop } from './desktop.js';
import { catalog, connectedToolkits, connectionsDetail, deleteConnection, disconnect, googleProfile, startConnect, startGoogleLogin } from './composio.js';
import { runRoutine, scheduleRoutine, unscheduleRoutine } from './routines.js';
import { deleteEventTrigger } from './triggers.js';
import { dispatchRoomMessage } from './agent/rooms.js';
import { voiceApi } from './voice.js';
import { chatProviders, chatSortOptions, type ChatModelSelection, type ChatSort, type MessageBody, type Row, type Toolkit } from './types.js';
import { orderChats, tier } from './chat-order.js';
import { AVATAR_SHAPE_IDS, isAvatarColor, isStemColor, isWorkFxChoice, normalizeAvatarShape } from './avatarShapes.js';
import { createBotRecord, type BotSpec } from './features/bots.js';
import { listWaiting, ownerReplied } from './features/waiting.js';

export const api = new Hono<AuthVars>();

/** JSON that is safe to embed inside an inline <script>: `<` can't close the tag and line separators can't break the statement. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function createBot(userId: string, b: BotSpec) {
  return createBotRecord(userId, { ...b, role: b.role === 'executive' ? 'executive' : null });
}

function mayCreateAccount(email: string) {
  const e = email.trim().toLowerCase();
  if (!env.allowedEmails.length) return env.openSignup;
  return env.allowedEmails.some((a) => (a.startsWith('@') ? e.endsWith(a) : e === a));
}

function insertUser(id: string, email: string, name: string) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, email, name, now());
  createBot(id, STARTER_AGENT);
}

function findOrCreateUser(email: string, name?: string, preferId?: string) {
  const existing = db.prepare('SELECT id FROM users WHERE lower(email)=lower(?)').get(email) as { id: string } | undefined;
  if (existing) return { id: existing.id, isNew: false };
  if (!mayCreateAccount(email)) return null;
  const id = preferId ?? newId('usr');
  insertUser(id, email, name ?? email.split('@')[0]);
  return { id, isNew: true };
}

// ---------- auth ----------

const workspaceUserId = db.transaction((signedInId?: string) => {
  const pinned = db.prepare('SELECT user_id FROM desktop_workspace WHERE slot=1').get() as { user_id: string } | undefined;
  if (pinned) return pinned.user_id;
  const existing = db.prepare('SELECT id FROM users LIMIT 2').all() as { id: string }[];
  const id = signedInId ?? (existing.length === 1 ? existing[0].id : newId('usr'));
  if (!signedInId && existing.length !== 1) insertUser(id, `${id}@marion.invalid`, 'Local workspace');
  db.prepare('INSERT INTO desktop_workspace(slot,user_id) VALUES (1,?)').run(id);
  return id;
});

api.get('/auth/me', (c) => {
  c.header('Cache-Control', 'no-store');
  const access = remoteAccessFor(c);
  if (access) {
    const paired = remoteWorkspaceUser(c.req.header('cookie'), access);
    const user = paired ? { id: paired.id, email: '', name: 'Local workspace', avatarUrl: null } : null;
    return c.json({ user, devLogin: false, googleLogin: false, localWorkspace: !!user, mobileLogin: true });
  }
  const user = userFromCookieHeader(c.req.header('cookie'));
  if (isDesktop) {
    const id = workspaceUserId(user?.id);
    if (user?.id !== id) createSession(c, id);
    return c.json({ user: { id, email: '', name: 'Local workspace', avatarUrl: null }, devLogin: false, googleLogin: false, localWorkspace: true });
  }
  return c.json({ user, devLogin: env.devLogin, googleLogin: Boolean(env.composioKey), localWorkspace: false });
});

const pairDigest = (text: string) => createHash('sha256').update(text).digest();
const pairLimits = {
  mobile: { count: 0, expiresAt: 0 },
  browser: { count: 0, expiresAt: 0 },
};
api.post('/auth/mobile', async (c) => {
  const access = remoteAccessFor(c);
  if (!access || c.req.header('origin') !== access.origin) {
    return c.json({ error: 'Pairing is available through the configured HTTPS address.' }, 403);
  }
  const limit = pairLimits[access.kind];
  if (now() >= limit.expiresAt) {
    limit.count = 0;
    limit.expiresAt = now() + 5 * 60_000;
  }
  if (limit.count >= 8) return c.json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);
  const body = await c.req.json<{ passphrase?: unknown }>().catch(() => null);
  const passphrase = body?.passphrase;
  if (limit.count >= 8) return c.json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);
  if (typeof passphrase !== 'string' || passphrase.length > 256 || !timingSafeEqual(pairDigest(passphrase), pairDigest(access.passphrase))) {
    limit.count++;
    return c.json({ error: 'Check the workspace passphrase.' }, 401);
  }
  limit.count = 0;
  createSession(c, workspaceUserId(undefined), access);
  return c.json({ ok: true });
});

api.use('/auth/*', async (c, next) => {
  const remoteLogout = c.req.path === '/api/auth/logout' && remoteAccessFor(c);
  if (isDesktop && !remoteLogout && c.req.path !== '/api/auth/me') return c.json({ error: 'Use the local workspace' }, 403);
  return next();
});

// Sign-in attempts are bound to the browser that started them (a short-lived cookie), so a callback URL
// can't be replayed in someone else's browser, and they expire after LOGIN_TTL_MS.
const LOGIN_COOKIE = 'login_attempt';
const LOGIN_TTL_MS = 15 * 60_000;

api.get('/auth/google/start', async (c) => {
  if (!env.composioKey) return c.json({ error: 'Configure COMPOSIO_API_KEY for Google sign-in' }, 503);
  db.prepare('DELETE FROM login_attempts WHERE created_at < ?').run(now() - LOGIN_TTL_MS);
  const attemptId = newId('login');
  const provisional = newId('usr');
  const cb = `${env.serverUrl}/api/auth/google/callback?attempt=${attemptId}`;
  const { redirectUrl, connectedAccountId } = await startGoogleLogin(provisional, cb);
  if (!connectedAccountId) return c.redirect(`${env.appUrl}/?login=failed`);
  db.prepare('INSERT INTO login_attempts(id,provisional_user_id,connected_account_id,created_at) VALUES (?,?,?,?)').run(attemptId, provisional, connectedAccountId, now());
  setCookie(c, LOGIN_COOKIE, attemptId, { httpOnly: true, secure: env.secureCookies, sameSite: 'Lax', path: '/api/auth/google', maxAge: LOGIN_TTL_MS / 1000 });
  return c.redirect(redirectUrl);
});

api.get('/auth/google/callback', async (c) => {
  const attemptId = c.req.query('attempt') ?? '';
  const boundTo = getCookie(c, LOGIN_COOKIE);
  deleteCookie(c, LOGIN_COOKIE, { path: '/api/auth/google' });
  const attempt = boundTo === attemptId ? (db.prepare('SELECT * FROM login_attempts WHERE id=?').get(attemptId) as any) : null;
  // Only trust the connected account recorded when this attempt started, never one from the query string.
  const caId: string | undefined = attempt?.connected_account_id ?? undefined;
  const fresh = attempt && now() - attempt.created_at < LOGIN_TTL_MS;
  if (!attempt || !fresh || c.req.query('status') === 'failed' || !caId) return c.redirect(`${env.appUrl}/?login=failed`);
  const returned = c.req.query('connected_account_id');
  if (returned && returned !== caId) return c.redirect(`${env.appUrl}/?login=failed`);
  db.prepare('DELETE FROM login_attempts WHERE id=?').run(attempt.id);
  try {
    const profile = await googleProfile(caId);
    const found = findOrCreateUser(profile.email, profile.name, attempt.provisional_user_id);
    if (!found) {
      console.warn('[auth] sign-up refused (not in ALLOWED_EMAILS)');
      await deleteConnection(caId);
      return c.redirect(`${env.appUrl}/?login=failed`);
    }
    const { id, isNew } = found;
    // Existing user: the Gmail connection made for sign-in belongs to a throwaway id; remove it.
    if (!isNew && id !== attempt.provisional_user_id) await deleteConnection(caId);
    createSession(c, id);
    return c.redirect(`${env.appUrl}/`);
  } catch (e: any) {
    console.error('[auth] google callback', e);
    return c.redirect(`${env.appUrl}/?login=failed`);
  }
});

api.post('/auth/dev', async (c) => {
  if (!env.devLogin) return c.json({ error: 'disabled' }, 403);
  const { email, name } = await c.req.json<{ email: string; name?: string }>();
  if (!email?.includes('@')) return c.json({ error: 'email required' }, 400);
  const found = findOrCreateUser(email, name);
  if (!found) return c.json({ error: 'This email is not allowed to sign up (ALLOWED_EMAILS).' }, 403);
  createSession(c, found.id);
  return c.json({ ok: true });
});

api.post('/auth/logout', (c) => {
  destroySession(c, remoteAccessFor(c));
  return c.json({ ok: true });
});

// everything below requires a session
api.use('/*', async (c, next) => {
  if (c.req.path.startsWith('/api/auth/') || c.req.path.startsWith('/api/apps/callback') || c.req.path === '/api/health') return next();
  return requireUser(c, next);
});

api.get('/subscriptions/usage', async (c) => {
  c.header('Cache-Control', 'private, no-store');
  const desktop = isDesktop && !remoteAccessFor(c);
  const refresh = c.req.query('refresh') === '1';
  const provider = usageProviders.find(option => option === c.req.query('provider'));
  const userId = c.get('user').id;
  if (provider) return c.json({ subscriptions: [withPlanLabel(userId, await readProvider(provider, desktop, refresh))] });
  return c.json({ subscriptions: (await subscriptionUsage(desktop, refresh)).map(item => withPlanLabel(userId, item)) });
});

api.get('/subscriptions/plans', (c) => c.json({ plans: planLabels(c.get('user').id), options: planOptions }));

api.put('/subscriptions/plans', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: 'Choose a plan.' }, 400);
  try { return c.json({ plans: savePlanLabels(c.get('user').id, body) }); }
  catch (error) { return c.json({ error: (error as Error).message }, 400); }
});

// ---------- events (SSE) ----------

api.get('/events', (c) => {
  const user = c.get('user');
  return streamSSE(c, async (stream) => {
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    const unsub = hub.subscribe(user.id, (ev) => { queue.push(JSON.stringify(ev)); wake?.(); });
    stream.onAbort(() => { unsub(); wake?.(); });
    await stream.writeSSE({ data: JSON.stringify({ type: 'hello', serverTime: now() }) });
    while (!stream.aborted) {
      if (!queue.length) {
        await Promise.race([new Promise<void>((r) => (wake = r)), new Promise((r) => setTimeout(r, 20_000))]);
        wake = null;
        if (!queue.length) { await stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) }); continue; }
      }
      while (queue.length) await stream.writeSSE({ data: queue.shift()! });
    }
    unsub();
  });
});

// ---------- bots ----------

const ownBot = (userId: string, id: string) => {
  const b = getBotRow(id);
  return b && b.user_id === userId ? b : null;
};

const chatSortFor = (userId: string): ChatSort =>
  (db.prepare('SELECT sort FROM chat_sort_preferences WHERE user_id=?').get(userId) as { sort: ChatSort } | undefined)?.sort ?? 'recent';

api.get('/bots', (c) => {
  const { id } = c.get('user');
  return c.json({ bots: listBots(id), live: allLive(id), chatSort: chatSortFor(id) });
});

api.put('/bots/order', async (c) => {
  const { id: userId } = c.get('user');
  const body = await c.req.json<{ sort?: unknown; id?: unknown; targetId?: unknown; after?: unknown }>().catch(() => null);
  const sort = chatSortOptions.find(option => body?.sort === option);
  const move = typeof body?.id === 'string' && typeof body.targetId === 'string' && typeof body.after === 'boolean';
  if ((!sort && !move) || (sort && move)) return c.json({ error: 'Choose a sort or move a chat.' }, 400);

  const result = db.transaction(() => {
    const chatSort = sort ?? 'custom';
    const current = chatSortFor(userId);
    const positions: Record<string, number> = {};
    if (move || (chatSort === 'custom' && current !== 'custom')) {
      const bots = listBots(userId);
      const alreadyOrdered = bots.some(bot => bot.sortPosition != null);
      let ordered = orderChats(bots, move || !alreadyOrdered ? current : 'custom', false);
      if (move) {
        const source = bots.find(bot => bot.id === body.id);
        const target = bots.find(bot => bot.id === body.targetId);
        if (!source || !target || source.id === target.id || tier(source) !== tier(target)) return null;
        ordered = ordered.filter(bot => bot.id !== source.id);
        ordered.splice(ordered.indexOf(target) + Number(body.after), 0, source);
      }
      const setPosition = db.prepare('UPDATE bots SET sort_position=? WHERE id=? AND user_id=?');
      ordered.forEach((bot, index) => {
        positions[bot.id] = index;
        setPosition.run(index, bot.id, userId);
      });
    }
    db.prepare(`INSERT INTO chat_sort_preferences(user_id,sort) VALUES (?,?)
      ON CONFLICT(user_id) DO UPDATE SET sort=excluded.sort`).run(userId, chatSort);
    return { chatSort, positions };
  }).immediate();
  if (!result) return c.json({ error: 'Move the chat next to another chat in the same section.' }, 400);
  hub.emit(userId, { type: 'chat-order', ...result });
  return c.json(result);
});

api.post('/bots', async (c) => {
  const body = await c.req.json();
  return c.json({ bot: createBot(c.get('user').id, body) });
});

api.patch('/bots/:id', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const p = await c.req.json();
  if (p.avatarShape !== undefined) {
    // Current ids and ids saved by older versions are accepted; either way the row stores the current id.
    const shape = normalizeAvatarShape(p.avatarShape);
    if (!shape) return c.json({ error: `Choose a bot icon: ${AVATAR_SHAPE_IDS.join(', ')}.` }, 400);
    p.avatarShape = shape;
  }
  if (p.avatarColor !== undefined && !isAvatarColor(p.avatarColor)) return c.json({ error: 'Choose a bot color.' }, 400);
  if (p.avatarGlow !== undefined && typeof p.avatarGlow !== 'boolean') return c.json({ error: 'Choose whether the avatar glows.' }, 400);
  if (p.workFx !== undefined && !isWorkFxChoice(p.workFx)) return c.json({ error: 'Choose a working animation.' }, 400);
  if (p.avatarStemColor !== undefined && p.avatarStemColor !== null && !isStemColor(p.avatarStemColor)) {
    return c.json({ error: 'Choose a six-digit hex stem color.' }, 400);
  }
  if (p.effort !== undefined && !localEfforts.some(effort => effort === p.effort)) {
    return c.json({ error: 'Choose a supported local effort.' }, 400);
  }
  if (p.avatarImage !== undefined && p.avatarImage !== null
    && !(typeof p.avatarImage === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(p.avatarImage) && p.avatarImage.length <= 600_000)) {
    return c.json({ error: 'Choose a PNG, JPEG or WebP photo under 400 KB.' }, 400);
  }
  if (p.pinned !== undefined && typeof p.pinned !== 'boolean') return c.json({ error: 'Choose whether to star this chat.' }, 400);
  if (p.role !== undefined && p.role !== null && p.role !== 'executive') return c.json({ error: 'Choose executive or no role.' }, 400);
  if (p.compactAtTokens !== undefined && p.compactAtTokens !== null && !(Number.isInteger(p.compactAtTokens) && p.compactAtTokens >= 0 && p.compactAtTokens <= 1_000_000)) {
    return c.json({ error: 'Choose a compaction size between 0 and 1,000,000 tokens.' }, 400);
  }
  const cols: Record<string, string> = { role: 'role', compactAtTokens: 'compact_at_tokens', name: 'name', label: 'label', description: 'description', instructions: 'instructions', avatarShape: 'avatar_shape', avatarColor: 'avatar_color', avatarStemColor: 'avatar_stem_color', avatarGlow: 'avatar_glow', avatarImage: 'avatar_image', workFx: 'work_fx', mode: 'mode', effort: 'effort', pinned: 'pinned', voice: 'voice', voiceSpeed: 'voice_speed', voiceLanguage: 'voice_language' };
  const changes = Object.entries(cols).filter(([key]) => p[key] !== undefined);
  if (changes.length === 1 && changes[0][0] === 'pinned') {
    db.prepare('UPDATE bots SET pinned=? WHERE id=?').run(Number(p.pinned), b.id);
  } else if (changes.length) {
    const assignments = changes.map(([, column]) => `${column}=?`).join(', ');
    const values = changes.map(([key]) => typeof p[key] === 'boolean' ? Number(p[key]) : p[key]);
    db.prepare(`UPDATE bots SET ${assignments}, updated_at=? WHERE id=?`).run(...values, now(), b.id);
  }
  emitBot(b.id);
  return c.json({ bot: getBot(b.id) });
});

api.delete('/bots/:id', async (c) => {
  const userId = c.get('user').id;
  const b = ownBot(userId, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  interrupt(b.id);
  await runInBotQueue(b.id, async () => {
    if (!ownBot(userId, b.id)) return;
    await stopDesktop(userId, b.id);
    for (const r of listRoutines(b.id)) unscheduleRoutine(r.id);
    // Deleted chats are kept (hidden) so they can be restored; purgeDeletedChats removes them for good later.
    db.prepare('UPDATE bots SET hidden=1, deleted_at=?, is_primary=0, pinned=0 WHERE id=?').run(now(), b.id);
    // Keep a full copy in the local Deleted archive and queue it for Marion Life's Deleted folder (never blocks the delete).
    archiveDeletedBot(userId, b.id, 'sidebar');
    hub.emit(userId, { type: 'roster' });
  });
  return c.json({ ok: true });
});

/** Deleted chats stay restorable for 30 days. */
export const DELETED_KEEP_MS = 30 * 24 * 3600_000;

export function purgeDeletedChats() {
  const old = db.prepare('SELECT id, user_id FROM bots WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(now() - DELETED_KEEP_MS) as { id: string; user_id: string }[];
  for (const { id, user_id } of old) {
    // Never remove the last copy: make sure the Deleted archive has it before it goes for good.
    archiveDeletedBot(user_id, id, 'startup_backfill');
    const row = db.prepare('SELECT deleted_at FROM bots WHERE id=?').get(id) as { deleted_at: number } | undefined;
    if (row && !archiveExists(`${id}:${row.deleted_at}`)) continue;
    db.transaction(() => {
      db.prepare('DELETE FROM screens WHERE bot_id=?').run(id);
      db.prepare('DELETE FROM bots WHERE id=?').run(id);
    })();
  }
}
setTimeout(() => { try { purgeDeletedChats(); } catch (e) { console.warn('[bots] purge failed', (e as Error).message); } }, 5000).unref();

api.get('/bots/deleted', (c) => {
  purgeDeletedChats();
  const rows = db.prepare('SELECT * FROM bots WHERE user_id=? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC').all(c.get('user').id) as any[];
  return c.json({ bots: rows.map(r => ({ ...toBot(r), deletedAt: r.deleted_at as number, purgeAt: r.deleted_at + DELETED_KEEP_MS })) });
});

api.post('/bots/:id/restore', (c) => {
  const userId = c.get('user').id;
  const b = ownBot(userId, c.req.param('id'));
  if (!b || b.deleted_at == null) return c.json({ error: 'That chat can no longer be restored.' }, 404);
  db.prepare('UPDATE bots SET hidden=0, deleted_at=NULL, updated_at=? WHERE id=?').run(now(), b.id);
  noteRestoredBot(userId, b.id, b.deleted_at);
  for (const r of listRoutines(b.id)) if (r.enabled) scheduleRoutine(r);
  hub.emit(userId, { type: 'roster' });
  return c.json({ bot: getBot(b.id) });
});

api.post('/bots/:id/primary', (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE bots SET is_primary = (id = ?) WHERE user_id=?').run(b.id, user.id);
  hub.emit(user.id, { type: 'roster' });
  return c.json({ ok: true });
});

/** Turn Primary off again (owner, Nov 25): no Bot is primary until another one is made primary. */
api.delete('/bots/:id/primary', (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE bots SET is_primary = 0 WHERE id=?').run(b.id);
  hub.emit(user.id, { type: 'roster' });
  return c.json({ ok: true });
});

api.post('/bots/:id/read', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE bots SET unread=0 WHERE id=?').run(b.id);
  emitBot(b.id);
  return c.json({ ok: true });
});

// ---------- conversation ----------

api.get('/bots/:id/transcript.txt', (c) => {
  const bot = ownBot(c.get('user').id, c.req.param('id'));
  if (!bot) return c.json({ error: 'Chat not found.' }, 404);
  c.header('Cache-Control', 'no-store');
  c.header('Content-Disposition', 'attachment; filename="Marion transcript.txt"');
  return c.text(chatTranscript(bot.id, bot.generation, bot.label ? `${bot.name} · ${bot.label}` : bot.name));
});

api.get('/bots/:id/rows', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const beforeSeq = c.req.query('beforeSeq') ? Number(c.req.query('beforeSeq')) : undefined;
  return c.json({ generation: b.generation, rows: listRows(b.id, { beforeSeq, limit: Number(c.req.query('limit') ?? 200) }) });
});

api.get('/bots/:id/attachments/:fileId', (c) => {
  const bot = ownBot(c.get('user').id, c.req.param('id'));
  if (!bot) return c.notFound();
  const fileId = c.req.param('fileId');
  const info = getAttachmentInfo(bot.id, bot.generation, fileId);
  if (!info) return c.notFound();
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Content-Type', info.mime);
  if (info.mime === 'text/plain') {
    const filename = encodeURIComponent(Buffer.from(info.name).toString()).replace(/['()*]/g, ch => '%' + ch.charCodeAt(0).toString(16));
    c.header('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  }
  // Screen recordings play and seek in the chat: honour byte ranges and read only the slice asked for.
  if (info.mime.startsWith('video/')) {
    c.header('Accept-Ranges', 'bytes');
    const range = parseByteRange(c.req.header('range'), info.size);
    if (range === 'unsatisfiable') { c.header('Content-Range', `bytes */${info.size}`); return c.body(null, 416); }
    if (range) {
      const part = getAttachmentSlice(bot.id, bot.generation, fileId, range.start, range.end - range.start + 1);
      if (!part) return c.notFound();
      c.header('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`);
      c.header('Content-Length', String(part.length));
      return c.body(part, 206);
    }
  }
  const file = getAttachment(bot.id, bot.generation, fileId);
  if (!file) return c.notFound();
  return c.body(file.data);
});

api.post('/bots/:id/messages', bodyLimit({
  maxSize: attachmentBodyLimit,
  onError: c => c.json({ error: 'Attachments are too large.' }, 413),
}), async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  let text = '';
  let call: string | null = null;
  let override: unknown;
  let replySeq: unknown;
  let forwardedFrom: unknown;
  let clientIdRaw: unknown;
  let attachments: UploadedAttachment[] = [];
  if (c.req.header('content-type')?.startsWith('multipart/form-data')) {
    try {
      const form = await c.req.formData();
      const message = form.get('text');
      text = typeof message === 'string' ? message.trim() : '';
      attachments = await readAttachments(form.getAll('attachments'));
      const reply = form.get('replyTo');
      replySeq = typeof reply === 'string' ? Number(reply) : undefined;
      forwardedFrom = form.get('forwardedFrom');
      clientIdRaw = form.get('clientId');
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Could not read the attachments.' }, 400);
    }
  } else {
    const body = await c.req.json<{ text?: unknown; call?: unknown; model?: unknown; replyTo?: unknown; forwardedFrom?: unknown; clientId?: unknown }>().catch(() => null);
    replySeq = body?.replyTo;
    clientIdRaw = body?.clientId;
    forwardedFrom = body?.forwardedFrom;
    text = typeof body?.text === 'string' ? body.text.trim() : '';
    call = typeof body?.call === 'string' && /^[\w-]{1,80}$/.test(body.call) ? body.call : null;
    override = body?.model;
  }
  if (!text && !attachments.length) return c.json({ error: 'empty' }, 400);
  const current = ownBot(b.user_id, b.id);
  if (!current) return c.json({ error: 'not found' }, 404);
  // A voice call can talk to a different model than the chat (chosen on the call button).
  let selection: ChatModelSelection = chatModelForBot(current);
  if (call && override && current.kind !== 'room') {
    const chosen = await callModel(override).catch(() => null);
    if (!chosen) return c.json({ error: 'The call model is unavailable. Pick another one on the call button.' }, 400);
    selection = chosen;
  }
  const { provider, model, effort } = selection;
  const replyTo = typeof replySeq === 'number' && Number.isInteger(replySeq) ? replyQuote(b.id, replySeq, current.name) : null;
  const forwarded = typeof forwardedFrom === 'string' && forwardedFrom.trim() ? { name: forwardedFrom.trim().slice(0, 80) } : null;
  // The bot sees the quote or forward note in front of the message; the chat shows them as a quote or a label.
  const notes = (replyTo ? `[The user is replying to ${replyTo.role === 'user' ? 'their own earlier message' : `an earlier message from ${replyTo.name}`}: "${replyTo.text}"]\n` : '')
    + (forwarded ? `[The user forwarded this message from their chat with ${forwarded.name}.]\n` : '');
  // A prompt queued offline is retried until a reply arrives; the same client id is answered with the row it already made.
  const clientId = typeof clientIdRaw === 'string' && /^[\w-]{8,80}$/.test(clientIdRaw) ? clientIdRaw : null;
  const already = clientId ? findClientMessage(b.id, clientId) : null;
  if (already) return c.json({ row: already, duplicate: true });
  const row = appendRow(b.id, 'message', {
    type: 'message', role: 'user', text, ...(clientId ? { clientId } : {}),
    ...(replyTo ? { replyTo } : {}), ...(forwarded ? { forwarded } : {}),
    ...(call ? { from: { kind: 'voice' as const, id: call, name: 'Voice call' } } : {}),
    ...(attachments.length ? { attachments: attachments.map(({ id, name, mime, size }) => ({ id, name, mime, size })) } : {}),
  }, attachments);
  // A busy bot (a turn, a relayed session or an orchestration is running) still answers every new message right away, in
  // parallel with the running work (see runsConcurrently in the loop); nothing running is ever aborted by a normal message,
  // including "work on this first" (it only jumps the queue). Only an explicit stop / cancel / abort aborts running work.
  // Voice calls and groups keep their own flow.
  const busy = current.kind !== 'room' && !call && isBotBusy(b.id);
  const intent = busy ? classifyIntent(text) : 'additive';
  if (intent === 'stop') { stopBot(b.id); return c.json({ row }); }
  // A typed "stop" while idle is never an answer: the open question card stays pending and no turn starts.
  if (!busy && current.kind !== 'room' && !call && text && classifyIntent(text) === 'stop' && pendingQuestion(b.id)) {
    stopBot(b.id);
    return c.json({ row });
  }
  // Screen recordings reach the models as frames (the chat keeps the original file). Done before the question card is
  // claimed: if the attachments can't be prepared the card stays pending instead of answered with no turn queued.
  const media = await routeHooks.forModel(attachments);
  // "Pick an option or reply in your own words": a typed reply answers the question card this chat is waiting on, exactly
  // like an option click (one turn, the card resolves). Claimed after the last await, so it can only be answered once.
  // Only question cards: approval cards are never resolved by a message.
  const question = current.kind !== 'room' && !call && text ? pendingQuestion(b.id) : null;
  const answerNote = question ? answerQuestion(b.id, question, text) : '';
  // A reply in the chat is the answer to its other open question cards and the input its needs-input tasks waited for.
  if (current.kind !== 'room') ownerReplied(b.id, text || 'Sent an attachment', { questions: !call });
  const mediaNote = media.note ? `[${media.note}]\n` : '';
  // Group chats dispatch to their member Bots instead of running their own loop.
  if (current.kind === 'room') dispatchRoomMessage(b.id, text, enqueue, media.attachments, notes + mediaNote);
  else {
    const voice = call ? { call, seq: row.seq, fast: !override } : undefined;
    const turn = { type: 'user' as const, text: notes + mediaNote + answerNote + text, attachments: media.attachments, generation: row.generation, voice,
      allowSubscriptionTeam: isDesktop && !remoteAccessFor(c) };
    const full = provider === 'local'
      ? { ...turn, local: { model, label: selection.label, effort: voice?.fast ? 'low' : effort ?? 'medium' } }
      : { ...turn, subscription: { ...selection, provider } };
    if (intent === 'override') preemptWith(b.id, full); else enqueue(b.id, full);
  }
  return c.json({ row });
});

/** A short quote of message `seq` in this chat, for Reply. Taken here so the client can't invent what was said. */
function replyQuote(botId: string, seq: number, botName: string): NonNullable<MessageBody['replyTo']> | null {
  const target = getRow(botId, seq)?.body;
  if (target?.type !== 'message') return null;
  const text = target.text.replace(/\s+/g, ' ').trim().slice(0, 400) || (target.attachments?.length ? 'Attachment' : '');
  if (!text) return null;
  return { seq, role: target.role, name: target.role === 'user' ? 'You' : target.from?.name ?? botName, text };
}

/** Check a model picked for voice calls the same way the chat model picker does. */
async function callModel(raw: unknown): Promise<ChatModelSelection | null> {
  const value = raw as Partial<ChatModelSelection> | null;
  const provider = chatProviders.find(option => option === value?.provider);
  if (!provider || typeof value?.model !== 'string' || !value.model || value.model.length > 200) return null;
  if (provider === 'local') {
    const effort = localEfforts.find(option => option === value.effort) ?? 'medium';
    if (value.model !== env.localModelName && !(await availableLocalModels().catch((): string[] => [])).includes(value.model)) return null;
    return { provider, model: value.model, effort };
  }
  if (!isDesktop) return null;
  const option = (await subscriptionModels(provider)).models.find(entry => entry.id === value.model);
  if (!option) return null;
  const effort = typeof value.effort === 'string' && option.efforts.includes(value.effort) ? value.effort : option.defaultEffort;
  return { provider, model: option.id, effort, label: option.label };
}

api.post('/bots/:id/interrupt', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  interrupt(b.id);
  return c.json({ ok: true });
});

api.post('/bots/:id/fresh', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  interrupt(b.id);
  clearConversation(b.id);
  emitBot(b.id);
  return c.json({ ok: true });
});

api.post('/approvals/:id', async (c) => {
  const { decision } = await c.req.json<{ decision: 'allow' | 'always' | 'deny' }>();
  if (decision !== 'deny' && remoteAccessFor(c) &&
    db.prepare("SELECT 1 FROM approvals a JOIN bots b ON b.id=a.bot_id WHERE a.id=? AND b.user_id=? AND a.tool='github_create_repo'")
      .get(c.req.param('id'), c.get('user').id)) return c.json({ error: 'Approve GitHub repository creation on the Mac.' }, 403);
  if (decision !== 'allow' && decision !== 'always' && decision !== 'deny') return c.json({ error: 'Choose allow, always or deny.' }, 400);
  let first: boolean;
  try { first = resolveApproval(c.get('user').id, c.req.param('id'), decision); } catch { return c.json({ error: 'not found' }, 404); }
  // Already decided (in chat, in Tasks, or a second tap) or expired: nothing changes and the bot is not resumed twice.
  return first ? c.json({ ok: true }) : c.json({ error: 'This was already answered.' }, 409);
});

// Question and connect cards are answered from chat or from Tasks → Waiting on You through these same routes. The body is
// read before the card is checked so the check and the update run without an await in between: of two racing answers
// only the first is taken.
api.post('/bots/:id/cards/:seq/answer', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const raw = await c.req.json<{ answer?: unknown }>().catch(() => null);
  const answer = typeof raw?.answer === 'string' ? raw.answer.trim().slice(0, 4000) : '';
  // Read after the await: nothing can claim the card between this check and answerQuestion below.
  const row = getRow(b.id, Number(c.req.param('seq')));
  if (!row || row.body.type !== 'card' || row.body.card !== 'question') return c.json({ error: 'not a question' }, 400);
  if (row.body.status !== 'pending') return c.json({ error: 'This question was already answered.' }, 409);
  if (!answer) return c.json({ error: 'Write an answer first.' }, 400);
  const note = answerQuestion(b.id, row, answer);
  appendRow(b.id, 'message', { type: 'message', role: 'user', text: answer });
  ownerReplied(b.id, answer, { questions: false });
  enqueue(b.id, { type: 'user', text: note + answer });
  return c.json({ ok: true });
});

/** Mark a pending question card answered and return the note that tells the bot which question this reply answers. */
function answerQuestion(botId: string, row: Row, answer: string) {
  if (row.body.type !== 'card' || row.body.card !== 'question') return '';
  updateRow(botId, row.seq, { ...row.body, status: 'answered', answer });
  settleQuestionWait(botId);
  return `[Answer to "${row.body.question}"] `;
}

/** The bot stops showing "waiting for your answer" once no question card is left open. */
function settleQuestionWait(botId: string) {
  if (getLive(botId).awaiting?.reason === 'your answer' && !pendingQuestion(botId)) setLive(botId, { awaiting: null });
}

api.post('/bots/:id/cards/:seq/dismiss', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const row = getRow(b.id, Number(c.req.param('seq')));
  if (!row || row.body.type !== 'card') return c.json({ error: 'not a card' }, 400);
  if (row.body.card === 'question' && row.body.status !== 'pending') return c.json({ error: 'This question was already answered.' }, 409);
  if (row.body.card === 'connect' && row.body.status !== 'pending') return c.json({ error: 'This card is already done.' }, 409);
  const body: any = { ...row.body, status: row.body.card === 'connect' ? 'skipped' : 'dismissed' };
  updateRow(b.id, row.seq, body);
  if (row.body.card === 'question') settleQuestionWait(b.id);
  if (row.body.card === 'connect') enqueue(b.id, { type: 'system', text: `The user skipped connecting ${row.body.toolkitName}. Continue without it.` });
  return c.json({ ok: true });
});

// ---------- routines / tasks / memories ----------

api.get('/bots/:id/routines', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ routines: listRoutines(b.id) }) : c.json({ error: 'not found' }, 404);
});

api.patch('/routines/:id', async (c) => {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as any;
  if (!r) return c.json({ error: 'not found' }, 404);
  const { enabled } = await c.req.json<{ enabled: boolean }>();
  db.prepare('UPDATE routines SET enabled=? WHERE id=?').run(enabled ? 1 : 0, r.id);
  const next = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(r.id));
  enabled ? scheduleRoutine(next) : unscheduleRoutine(r.id);
  hub.emit(c.get('user').id, { type: 'routines', botId: r.bot_id });
  return c.json({ routine: next });
});

api.post('/routines/:id/run', (c) => {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as any;
  if (!r) return c.json({ error: 'not found' }, 404);
  runRoutine(r.id);
  return c.json({ ok: true });
});

api.delete('/routines/:id', async (c) => {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as any;
  if (!r) return c.json({ error: 'not found' }, 404);
  unscheduleRoutine(r.id);
  await deleteEventTrigger(r.id);
  db.prepare('DELETE FROM routines WHERE id=?').run(r.id);
  hub.emit(c.get('user').id, { type: 'routines', botId: r.bot_id });
  return c.json({ ok: true });
});

api.get('/bots/:id/tasks', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ tasks: listTasks(b.id) }) : c.json({ error: 'not found' }, 404);
});

// Tasks → Waiting on You: action cards and needs-input tasks across all chats (the badge is items.length).
api.get('/waiting', (c) => {
  const items = listWaiting(c.get('user').id);
  return c.json({ items, count: items.length });
});

api.get('/tasks', (c) => {
  const rows = db.prepare('SELECT t.* FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE b.user_id=? ORDER BY t.updated_at DESC LIMIT 200').all(c.get('user').id) as any[];
  return c.json({ tasks: rows.map(toTask) });
});

api.patch('/tasks/:id', async (c) => {
  const userId = c.get('user').id;
  const body = await c.req.json().catch(() => null);
  const state = body?.state;
  if (state !== 'working' && state !== 'done') return c.json({ error: 'Invalid task state' }, 400);
  const row = db.prepare(`
    UPDATE tasks SET state = ?, updated_at = CASE WHEN state = ? THEN updated_at ELSE ? END
    WHERE id = ? AND bot_id IN (SELECT id FROM bots WHERE user_id = ?)
    RETURNING *
  `).get(state, state, now(), c.req.param('id'), userId);
  if (!row) return c.json({ error: 'Task not found' }, 404);
  const task = toTask(row);
  hub.emit(userId, { type: 'tasks', botId: task.botId });
  return c.json({ task });
});

api.get('/bots/:id/memories', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const rows = db.prepare('SELECT * FROM memories WHERE bot_id=? ORDER BY created_at DESC').all(b.id) as any[];
  return c.json({ memories: rows.map((m) => ({ id: m.id, botId: m.bot_id, text: m.text, createdAt: m.created_at })) });
});

api.delete('/memories/:id', (c) => {
  db.prepare('DELETE FROM memories WHERE id=? AND bot_id IN (SELECT id FROM bots WHERE user_id=?)').run(c.req.param('id'), c.get('user').id);
  return c.json({ ok: true });
});

// ---------- computer ----------

api.get('/computer', async (c) => c.json({ computer: await refreshComputer(c.get('user').id) }));

api.post('/computer/ensure', async (c) => {
  const userId = c.get('user').id;
  const { botId } = await c.req.json<{ botId?: string }>().catch(() => ({ botId: undefined }));
  const bot = botId ? ownBot(userId, botId) : null;
  if (botId && (!bot || bot.kind === 'room')) {
    return c.json({ error: 'Bot desktop not found' }, 404);
  }
  const opening = botId ? screenFor(userId, botId) : ensureComputer(userId);
  opening.catch((e) => console.warn('[computer] ensure failed', e.message));
  return c.json({ computer: computerState(userId) });
});

api.post('/computer/suspend', async (c) => {
  await suspendComputer(c.get('user').id);
  return c.json({ computer: computerState(c.get('user').id) });
});

api.get('/bots/:id/screenshot', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (!db.prepare('SELECT 1 FROM screens WHERE bot_id=? AND screen_id=bot_id').get(b.id)) return c.body(null, 204);
  try {
    if (!await desktop.running(b.id)) return c.body(null, 204);
    const s = await desktop.screenshot(b.id);
    const b64 = s.image.replace(/^data:[^,]+,/, '');
    return c.body(Buffer.from(b64, 'base64'), 200, { 'Content-Type': s.mime_type ?? 'image/jpeg', 'Cache-Control': 'no-store' });
  } catch {
    return c.body(null, 204);
  }
});

// ---------- apps (Composio marketplace) ----------

api.get('/apps', async (c) => {
  const user = c.get('user');
  const search = (c.req.query('search') ?? '').toLowerCase();
  const category = c.req.query('category') ?? '';
  let all: Awaited<ReturnType<typeof catalog>>;
  let connected: Set<string>;
  try { [all, connected] = await Promise.all([catalog(), connectedToolkits(user.id)]); }
  catch { return c.json({ error: 'Composio could not load the catalog or linked accounts. Check your project key and connection.' }, 502); }
  let items: Toolkit[] = all.map((t) => ({ ...t, connected: connected.has(t.slug) }));
  if (search) items = items.filter((t) => t.name.toLowerCase().includes(search) || t.slug.includes(search) || t.description?.toLowerCase().includes(search));
  if (category) items = items.filter((t) => t.categories.some((x) => x.toLowerCase() === category.toLowerCase()));
  const categories = [...new Set(all.flatMap((t) => t.categories))].sort();
  const connectedApps = all.filter((t) => connected.has(t.slug)).map((t) => ({ ...t, connected: true }));
  return c.json({ apps: items.slice(0, Number(c.req.query('limit') ?? 120)), connected: [...connected], connectedApps, categories, total: items.length, configured: Boolean(env.composioKey) });
});

api.post('/apps/:slug/connect', async (c) => {
  if (!env.composioKey) return c.json({ error: 'Configure COMPOSIO_API_KEY for connected apps' }, 503);
  const user = c.get('user');
  const slug = c.req.param('slug');
  if (!/^[a-z0-9_-]{1,64}$/i.test(slug)) return c.json({ error: 'Invalid toolkit' }, 400);
  const body = await c.req.json<{ botId?: string; seq?: number }>().catch(() => null);
  const botId = typeof body?.botId === 'string' && ownBot(user.id, body.botId) ? body.botId : null;
  const seq = typeof body?.seq === 'number' && Number.isSafeInteger(body.seq) ? body.seq : null;
  const flow = token();
  const callback = new URL(`${env.serverUrl}/api/apps/callback`);
  callback.searchParams.set('flow', flow);
  try {
    const link = await startConnect(user.id, slug, callback.toString());
    if (!link.connectedAccountId) return c.json({ error: 'Composio did not start a linked account' }, 502);
    db.prepare('DELETE FROM app_link_attempts WHERE created_at < ?').run(now() - LOGIN_TTL_MS);
    db.prepare('INSERT INTO app_link_attempts(id,user_id,toolkit,account_id,bot_id,row_seq,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(flow, user.id, slug, link.connectedAccountId, botId, seq ?? null, now());
    return c.json({ redirectUrl: link.redirectUrl });
  } catch {
    return c.json({ error: 'Could not open the authorization link. Check whether the toolkit requires a custom auth configuration in Composio.' }, 502);
  }
});

api.get('/apps/callback', async (c) => {
  const user = userFromCookieHeader(c.req.header('cookie'));
  const flow = c.req.query('flow') ?? '';
  const attempt = user && /^[A-Za-z0-9_-]{43}$/.test(flow)
    ? db.prepare('DELETE FROM app_link_attempts WHERE id=? AND user_id=? AND created_at>=? RETURNING toolkit,account_id,bot_id,row_seq')
      .get(flow, user.id, now() - LOGIN_TTL_MS) as { toolkit: string; account_id: string; bot_id?: string; row_seq?: number } | undefined
    : undefined;
  const slug = attempt?.toolkit ?? '';
  let ok = false;
  if (user && attempt && c.req.query('status') !== 'failed') {
    const accounts = await connectionsDetail(user.id).catch(() => []);
    ok = accounts.some(account => account.id === attempt.account_id && account.toolkit === slug && account.status === 'ACTIVE');
    if (ok) {
      hub.emit(user.id, { type: 'connections' });
      const botId = attempt.bot_id;
      const seq = attempt.row_seq;
      const row = botId && seq && ownBot(user.id, botId) ? getRow(botId, seq) : null;
      if (botId && row?.body.type === 'card' && row.body.card === 'connect' && row.body.status === 'pending' && row.body.toolkit === slug) {
        updateRow(botId, row.seq, { ...row.body, status: 'connected' });
        enqueue(botId, { type: 'system', text: `The user connected ${row.body.toolkitName}. Continue with what you were doing.` });
      }
    }
  }
  // Data embedded in an inline <script> must not be able to close the tag, so escape `<` (and U+2028/2029).
  const payload = jsonForScript({ type: 'marion-agent-connected', slug, ok });
  const target = jsonForScript(new URL(env.appUrl).origin);
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.html(`<!doctype html><meta charset="utf-8"><title>Connected</title><body style="font-family:system-ui;padding:40px;text-align:center">${ok ? 'Connected. You can close this window.' : 'Connection failed.'}<script>try{window.opener&&window.opener.postMessage(${payload},${target})}catch(e){};setTimeout(()=>window.close(),800)</script></body>`);
});

api.delete('/apps/:slug', async (c) => {
  await disconnect(c.get('user').id, c.req.param('slug'));
  hub.emit(c.get('user').id, { type: 'connections' });
  return c.json({ ok: true });
});

api.get('/policies', (c) => c.json({ policies: db.prepare('SELECT tool, mode FROM policies WHERE user_id=?').all(c.get('user').id) }));
api.delete('/policies/:tool', (c) => {
  db.prepare('DELETE FROM policies WHERE user_id=? AND tool=?').run(c.get('user').id, c.req.param('tool'));
  return c.json({ ok: true });
});

api.route('/voice', voiceApi);
