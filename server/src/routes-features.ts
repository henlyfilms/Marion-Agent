import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { db, now } from './db.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { newId } from './lib/ids.js';
import { appendRow, listRoutines, loadHistory } from './store.js';
import { enqueue, runInBotQueue } from './agent/loop.js';
import { chatModelForBot } from './agent/chat-model.js';
import { estimateChars, maybeCompact, memoryConfig } from './agent/memory.js';
import { screenFor, stopDesktop } from './computer.js';
import { connectedToolkits } from './composio.js';
import type { UploadedAttachment } from './attachments.js';
import { createBotRecord } from './features/bots.js';
import { TEMPLATES, templateById } from './features/templates.js';
import { notificationSettings, notify, pushToDevices, saveNotificationSettings } from './features/notify.js';
import { vapidPublicKey } from './features/webpush.js';
import { connectLife, disconnectLife, hasLifeKey, lifeLinkSettings, syncLife } from './features/life-link.js';
import { reflectBot } from './features/improve.js';

/** Templates, bot profiles, context and compaction, computer sleep, teaching, notifications and the Marion Life link. */
export const featuresApi = new Hono<AuthVars>();
// Scope the auth check to these paths only: a '*' here would also run for sign-in routes mounted after it.
for (const path of ['/templates', '/templates/*', '/bots/*', '/notifications', '/notifications/*', '/life-link', '/life-link/*']) featuresApi.use(path, requireUser);

const ownBot = (userId: string, botId: string) =>
  db.prepare('SELECT * FROM bots WHERE id=? AND user_id=?').get(botId, userId) as any;

const parseList = (value: string | null) => { try { return value ? JSON.parse(value) as string[] : []; } catch { return []; } };

// ---------- templates and profiles ----------

featuresApi.get('/templates', (c) => c.json({
  templates: TEMPLATES.map(t => ({
    id: t.id, name: t.name, author: t.author, label: t.label ?? '', tagline: t.tagline, description: t.description ?? '',
    instructions: t.instructions ?? '', avatarShape: t.avatarShape, avatarColor: t.avatarColor, role: t.role ?? null,
    memories: t.memories ?? [], skills: (t.skills ?? []).map(s => ({ name: s.name, description: s.description ?? '', body: s.body })),
    routines: (t.routines ?? []).map(r => ({ name: r.name, prompt: r.prompt, schedule: r.schedule, enabled: r.enabled !== false })),
    integrations: t.integrations ?? [],
  })),
}));

featuresApi.post('/templates/:id/import', async (c) => {
  const template = templateById(c.req.param('id'));
  if (!template) return c.json({ error: 'Template not found' }, 404);
  const userId = c.get('user').id;
  const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
  let name = String(body.name ?? template.name).trim().slice(0, 60) || template.name;
  const taken = (n: string) => db.prepare('SELECT 1 FROM bots WHERE user_id=? AND lower(name)=lower(?)').get(userId, n);
  for (let i = 2; taken(name) && i < 50; i++) name = `${template.name} ${i}`;
  const bot = createBotRecord(userId, { ...template, name, templateId: template.id });
  return c.json({ bot });
});

/** Everything shown on a bot's profile, in the same shape as a template. */
featuresApi.get('/bots/:id/profile', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  let connected: string[] = [];
  try { connected = [...await connectedToolkits(user.id)]; } catch { /* Composio not configured */ }
  return c.json({
    profile: {
      id: b.id, name: b.name, author: user.name, label: b.label, description: b.description, instructions: b.instructions,
      role: b.role, templateId: b.template_id,
      memories: (db.prepare('SELECT text FROM memories WHERE bot_id=? ORDER BY created_at').all(b.id) as any[]).map(m => m.text),
      skills: (db.prepare('SELECT name, description, body FROM skills WHERE bot_id=? ORDER BY created_at').all(b.id) as any[]),
      routines: listRoutines(b.id).map(r => ({ name: r.name, prompt: r.prompt, schedule: r.description || r.schedule, enabled: r.enabled })),
      integrations: parseList(b.integrations),
      connected,
    },
  });
});

/** A portable copy of a bot (JSON file) that can be imported again as a new bot. */
featuresApi.get('/bots/:id/export', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const spec = {
    format: 'marion-agent-bot@1', name: b.name, label: b.label, description: b.description, instructions: b.instructions,
    avatarShape: b.avatar_shape, avatarColor: b.avatar_color, avatarStemColor: b.avatar_stem_color, role: b.role,
    integrations: parseList(b.integrations),
    memories: (db.prepare('SELECT text FROM memories WHERE bot_id=? ORDER BY created_at').all(b.id) as any[]).map(m => m.text),
    skills: db.prepare('SELECT name, description, body FROM skills WHERE bot_id=? ORDER BY created_at').all(b.id),
    routines: (db.prepare('SELECT name, prompt, schedule, timezone, enabled FROM routines WHERE bot_id=? ORDER BY created_at').all(b.id) as any[])
      .filter(r => !String(r.schedule).startsWith('event:')).map(r => ({ ...r, enabled: false })),
  };
  c.header('Content-Disposition', `attachment; filename="${b.name.replace(/[^\w .-]+/g, '').trim() || 'bot'}.marionbot.json"`);
  return c.json(spec);
});

featuresApi.post('/bots/import', bodyLimit({ maxSize: 512 * 1024 }), async (c) => {
  const spec = await c.req.json<any>().catch(() => null);
  if (spec?.format !== 'marion-agent-bot@1' || typeof spec.name !== 'string') return c.json({ error: 'Choose a .marionbot.json file exported from Marion Agent.' }, 400);
  const bot = createBotRecord(c.get('user').id, { ...spec, isPrimary: false, templateId: null });
  return c.json({ bot });
});

// ---------- context and compaction ----------

const DEFAULT_COMPACT_TOKENS = Math.round(memoryConfig.compactChars / 4);

featuresApi.get('/bots/:id/context', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const history = loadHistory(b.id);
  const estimated = Math.round(estimateChars(history) / 4);
  const last = db.prepare('SELECT method, items_before, items_after, chars_before, chars_after, created_at FROM compactions WHERE bot_id=? ORDER BY id DESC LIMIT 1').get(b.id) as any;
  return c.json({
    tokens: b.context_tokens ?? estimated,
    historyTokens: estimated,
    items: history.length,
    limit: 1_000_000,
    compactAtTokens: b.compact_at_tokens ?? null,
    defaultCompactAtTokens: DEFAULT_COMPACT_TOKENS,
    provider: chatModelForBot(b).provider,
    lastCompaction: last ? { at: last.created_at, tokensBefore: Math.round(last.chars_before / 4), tokensAfter: Math.round(last.chars_after / 4) } : null,
  });
});

featuresApi.post('/bots/:id/context/compact', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const before = loadHistory(b.id).length;
  if (before < 4) return c.json({ error: 'This chat is too short to compact.' }, 400);
  try {
    const after = await runInBotQueue(b.id, async () => (await maybeCompact(b.id, loadHistory(b.id), { force: true })).length);
    if (after === before) return c.json({ error: 'Nothing was compacted. The summary model may be unavailable; try again in a moment.' }, 502);
    const tokens = Math.round(estimateChars(loadHistory(b.id)) / 4);
    appendRow(b.id, 'event', { type: 'event', event: 'bot-message', text: `Compacted: earlier messages were summarized (${before} → ${after} items, about ${tokens.toLocaleString('en-US')} tokens now)` });
    return c.json({ itemsBefore: before, itemsAfter: after, tokens });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});

featuresApi.post('/bots/:id/improve', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  try {
    const result = await reflectBot(b.id, { force: true });
    return c.json(result);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 502);
  }
});

// ---------- per-bot computer sleep ----------

featuresApi.post('/bots/:id/computer', async (c) => {
  const userId = c.get('user').id;
  const b = ownBot(userId, c.req.param('id'));
  if (!b || b.kind === 'room') return c.json({ error: 'not found' }, 404);
  const { awake } = await c.req.json<{ awake?: boolean }>().catch(() => ({ awake: undefined }));
  if (typeof awake !== 'boolean') return c.json({ error: 'Say whether the computer should be awake.' }, 400);
  try {
    if (awake) await screenFor(userId, b.id);
    else await stopDesktop(userId, b.id);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 502);
  }
  return c.json({ ok: true });
});

// ---------- teach by screen recording ----------

const MAX_FRAMES = 12;
const MAX_FRAME_BYTES = 1_500_000;

featuresApi.post('/bots/:id/teach', bodyLimit({ maxSize: MAX_FRAMES * MAX_FRAME_BYTES + 256 * 1024, onError: c => c.json({ error: 'The recording is too large.' }, 413) }), async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b || b.kind === 'room') return c.json({ error: 'not found' }, 404);
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'Send the recording as a form.' }, 400);
  const title = String(form.get('title') ?? '').trim().slice(0, 120) || 'New skill';
  const narration = String(form.get('narration') ?? '').trim().slice(0, 20_000);
  const notes = String(form.get('notes') ?? '').trim().slice(0, 4000);
  const seconds = Math.max(0, Math.min(3600, Number(form.get('seconds')) || 0));
  const frames: UploadedAttachment[] = [];
  for (const file of form.getAll('frames').slice(0, MAX_FRAMES)) {
    if (typeof file === 'string' || !file.size || file.size > MAX_FRAME_BYTES) continue;
    const data = Buffer.from(await file.arrayBuffer());
    const jpeg = data[0] === 0xff && data[1] === 0xd8;
    const png = data.subarray(0, 4).toString('hex') === '89504e47';
    if (!jpeg && !png) continue;
    frames.push({ id: newId('att'), name: `step-${frames.length + 1}.${jpeg ? 'jpg' : 'png'}`, mime: jpeg ? 'image/jpeg' : 'image/png', size: data.length, data });
  }
  if (!frames.length) return c.json({ error: 'The recording had no frames. Record for a few seconds and try again.' }, 400);
  const text = [
    `🎬 Lesson: ${title}`,
    `I recorded my screen (${Math.round(seconds)}s, ${frames.length} key moments) to teach you how to do this.`,
    narration ? `What I said while recording:\n${narration}` : '',
    notes ? `Notes:\n${notes}` : '',
  ].filter(Boolean).join('\n\n');
  const row = appendRow(b.id, 'message', {
    type: 'message', role: 'user', text,
    attachments: frames.map(({ id: fileId, name, mime, size }) => ({ id: fileId, name, mime, size })),
  }, frames);
  const instruction = `${text}\n\n[Teaching session] The images are key moments from my screen recording, in order. Study them with the narration, then:
1. Describe the process back to me in numbered steps (what to click or type, in which app, and what to check).
2. Save it with save_skill, named "${title}", so you can do it yourself next time (on your own computer, or with a connected app if one fits better).
3. Ask me about anything you couldn't see clearly.`;
  const current = ownBot(b.user_id, b.id);
  const { provider, model, effort } = chatModelForBot(current);
  enqueue(b.id, provider === 'local'
    ? { type: 'user', text: instruction, attachments: frames, generation: row.generation, local: { model, effort: effort ?? 'medium' } }
    : { type: 'user', text: instruction, attachments: frames, generation: row.generation, subscription: { provider, model, effort } });
  return c.json({ row });
});

// ---------- notifications ----------

featuresApi.get('/notifications', (c) => {
  const userId = c.get('user').id;
  const devices = db.prepare('SELECT endpoint, label, created_at, last_ok_at FROM push_subscriptions WHERE user_id=? ORDER BY created_at').all(userId) as any[];
  return c.json({
    settings: notificationSettings(userId),
    publicKey: vapidPublicKey(),
    devices: devices.map(d => ({ id: Buffer.from(d.endpoint).toString('base64url').slice(-24), endpoint: d.endpoint, label: d.label, createdAt: d.created_at, lastOkAt: d.last_ok_at })),
  });
});

featuresApi.put('/notifications', async (c) => {
  const patch = await c.req.json().catch(() => ({}));
  return c.json({ settings: saveNotificationSettings(c.get('user').id, patch) });
});

featuresApi.post('/notifications/devices', async (c) => {
  const body = await c.req.json<{ endpoint?: string; keys?: { p256dh?: string; auth?: string }; label?: string }>().catch(() => null);
  const endpoint = body?.endpoint ?? '';
  try { if (new URL(endpoint).protocol !== 'https:') throw new Error(); } catch { return c.json({ error: 'This device returned an invalid push address.' }, 400); }
  if (!body?.keys?.p256dh || !body.keys.auth) return c.json({ error: 'This device returned no push keys.' }, 400);
  db.prepare(`INSERT INTO push_subscriptions(endpoint,user_id,p256dh,auth,label,created_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, label=excluded.label, failures=0`)
    .run(endpoint, c.get('user').id, body.keys.p256dh, body.keys.auth, String(body.label ?? '').slice(0, 60), now());
  return c.json({ ok: true });
});

featuresApi.delete('/notifications/devices', async (c) => {
  const { endpoint } = await c.req.json<{ endpoint?: string }>().catch(() => ({ endpoint: undefined }));
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?').run(String(endpoint ?? ''), c.get('user').id);
  return c.json({ ok: true });
});

featuresApi.post('/notifications/test', async (c) => {
  const userId = c.get('user').id;
  const notification = { id: newId('ntf'), kind: 'finished' as const, title: 'Marion Agent', body: 'Notifications are working.', at: now() };
  const result = await pushToDevices(userId, notification);
  notify(userId, { kind: 'finished', title: 'Marion Agent', body: `Test notification${result.devices ? ` · sent to ${result.delivered} of ${result.devices} device${result.devices === 1 ? '' : 's'}` : ''}` });
  return c.json(result);
});

// ---------- Marion Life link ----------

featuresApi.get('/life-link', (c) => {
  const userId = c.get('user').id;
  return c.json({ settings: lifeLinkSettings(userId), hasKey: hasLifeKey(userId) });
});

featuresApi.put('/life-link', async (c) => {
  const userId = c.get('user').id;
  const body = await c.req.json().catch(() => ({}));
  try {
    const settings = await connectLife(userId, body);
    return c.json({ settings, hasKey: hasLifeKey(userId) });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
});

featuresApi.delete('/life-link', (c) => {
  disconnectLife(c.get('user').id);
  return c.json({ ok: true });
});

featuresApi.post('/life-link/sync', async (c) => {
  const userId = c.get('user').id;
  try {
    const result = await syncLife(userId, { force: true });
    return c.json({ ...result, settings: lifeLinkSettings(userId) });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 502);
  }
});

