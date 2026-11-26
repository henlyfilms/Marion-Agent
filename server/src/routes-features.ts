import { basename } from 'node:path';
import { env } from './env.js';
import { continueHandoff, validateFallback } from './features/handoffs.js';
import { startCloudSession } from './features/cloud-sessions.js';
import { createGitHubRepo } from './features/github-repos.js';
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
import { TEMPLATES, templateById, type BotTemplate } from './features/templates.js';
import { DEFAULT_STEM_COLOR } from './avatarShapes.js';
import { notificationSettings, notify, notifyMacBlocked, pushToDevices, saveNotificationSettings } from './features/notify.js';
import { MacPermissionError, macBlock } from './lib/macPermissions.js';
import { vapidPublicKey } from './features/webpush.js';
import { connectLife, disconnectLife, hasLifeKey, lifeLinkSettings, syncLife } from './features/life-link.js';
import { drainLifeOutbox, outboxStatus } from './features/life-outbox.js';
import { reflectBot } from './features/improve.js';
import { chatSessionMessages, listSessions } from './features/agent-sessions.js';
import { computeStats, parseStatsRange } from './features/stats.js';
import { codingSessionMessages, listCodingSessions, type SessionProvider } from './features/sessions.js';
import { setAutoUpdate, startUpdate, updateSettings, updateStatus } from './features/app-update.js';
import { remoteAccessFor } from './lib/auth.js';
import { clearRecordings, deleteRecording, listRecordings, recordingFrame, saveRecording } from './features/recordings.js';
import { agentSettings, RECORDING_DAY_OPTIONS, saveAgentSettings } from './features/agent-settings.js';
import { listScreenshots, screenshotImage } from './features/screenshots.js';
import { isDesktop } from './lib/desktop-access.js';
import { addBotFolder, checkFolder, hasFullAccess, storedFolders, pickFolder, removeBotFolder, screenshotFolder, updateBotFolder } from './features/folders.js';

/** Templates, bot profiles, context and compaction, computer sleep, teaching, notifications and the Marion Life link. */
export const featuresApi = new Hono<AuthVars>();
// Scope the auth check to these paths only: a '*' here would also run for sign-in routes mounted after it.
for (const path of ['/templates', '/templates/*', '/bots/*', '/notifications', '/notifications/*', '/life-link', '/life-link/*', '/sessions', '/sessions/*', '/stats', '/app/update', '/app/update/*', '/recordings', '/recordings/*', '/agent-settings', '/github/repos', '/screenshots', '/screenshots/*']) featuresApi.use(path, requireUser);

const ownBot = (userId: string, botId: string) =>
  db.prepare('SELECT * FROM bots WHERE id=? AND user_id=?').get(botId, userId) as any;

const parseList = (value: string | null) => { try { return value ? JSON.parse(value) as string[] : []; } catch { return []; } };

// ---------- templates and profiles ----------

/** Templates the user saved from their own bots. Ids start with "user:" so they never clash with built-ins. */
function userTemplates(userId: string, author: string): BotTemplate[] {
  const rows = db.prepare('SELECT id, spec FROM user_templates WHERE user_id=? ORDER BY created_at DESC').all(userId) as { id: string; spec: string }[];
  return rows.flatMap(row => {
    try { return [{ ...JSON.parse(row.spec), id: `user:${row.id}`, author, custom: true } as BotTemplate]; } catch { return []; }
  });
}

featuresApi.get('/templates', (c) => {
  const user = c.get('user');
  return c.json({
    templates: [...userTemplates(user.id, user.name), ...TEMPLATES].map(t => ({
      id: t.id, name: t.name, author: t.author, label: t.label ?? '', tagline: t.tagline, description: t.description ?? '',
      instructions: t.instructions ?? '', avatarShape: t.avatarShape, avatarColor: t.avatarColor,
      avatarStemColor: t.avatarStemColor === undefined ? DEFAULT_STEM_COLOR : t.avatarStemColor, avatarGlow: !!t.avatarGlow, role: t.role ?? null,
      memories: t.memories ?? [], skills: (t.skills ?? []).map(s => ({ name: s.name, description: s.description ?? '', body: s.body })),
      routines: (t.routines ?? []).map(r => ({ name: r.name, prompt: r.prompt, schedule: r.schedule, enabled: r.enabled !== false })),
      integrations: t.integrations ?? [], custom: !!(t as { custom?: boolean }).custom,
    })),
  });
});

/** Save a bot (look, instructions, memories, skills, routines, apps) as a reusable template. */
featuresApi.post('/bots/:id/template', (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b || b.kind === 'room') return c.json({ error: 'not found' }, 404);
  const count = (db.prepare('SELECT COUNT(*) n FROM user_templates WHERE user_id=?').get(user.id) as { n: number }).n;
  if (count >= 100) return c.json({ error: 'You have 100 saved templates. Remove one first.' }, 400);
  const spec = {
    name: b.name, label: b.label, description: b.description, instructions: b.instructions,
    tagline: (b.description || b.label || `Starts like ${b.name}.`).split(/(?<=[.!?])\s/)[0].slice(0, 140),
    avatarShape: b.avatar_shape, avatarColor: b.avatar_color, avatarStemColor: b.avatar_stem_color, avatarGlow: !!b.avatar_glow,
    role: b.role, integrations: parseList(b.integrations),
    memories: (db.prepare('SELECT text FROM memories WHERE bot_id=? ORDER BY created_at').all(b.id) as any[]).map(m => m.text),
    skills: db.prepare('SELECT name, description, body FROM skills WHERE bot_id=? ORDER BY created_at').all(b.id),
    routines: (db.prepare('SELECT name, prompt, schedule, timezone FROM routines WHERE bot_id=? ORDER BY created_at').all(b.id) as any[])
      .filter(r => !String(r.schedule).startsWith('event:')).map(r => ({ ...r, enabled: false })),
  };
  const id = newId('tpl');
  db.prepare('INSERT INTO user_templates(id,user_id,spec,created_at) VALUES (?,?,?,?)').run(id, user.id, JSON.stringify(spec), Date.now());
  return c.json({ id: `user:${id}`, name: b.name });
});

featuresApi.delete('/templates/:id', (c) => {
  const id = c.req.param('id');
  if (!id.startsWith('user:')) return c.json({ error: 'Built-in templates can’t be removed.' }, 400);
  db.prepare('DELETE FROM user_templates WHERE id=? AND user_id=?').run(id.slice(5), c.get('user').id);
  return c.json({ ok: true });
});

featuresApi.post('/templates/:id/import', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const template = id.startsWith('user:') ? userTemplates(user.id, user.name).find(t => t.id === id) : templateById(id);
  if (!template) return c.json({ error: 'Template not found' }, 404);
  const userId = c.get('user').id;
  const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
  let name = String(body.name ?? template.name).trim().slice(0, 60) || template.name;
  const taken = (n: string) => db.prepare('SELECT 1 FROM bots WHERE user_id=? AND lower(name)=lower(?)').get(userId, n);
  for (let i = 2; taken(name) && i < 50; i++) name = `${template.name} ${i}`;
  const bot = createBotRecord(userId, { ...template, name, templateId: template.id.startsWith('user:') ? null : template.id });
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
    avatarShape: b.avatar_shape, avatarColor: b.avatar_color, avatarStemColor: b.avatar_stem_color, avatarGlow: !!b.avatar_glow, role: b.role,
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

// ---------- teach-by-recording history ----------

featuresApi.post('/bots/:id/recordings', bodyLimit({ maxSize: MAX_FRAMES * MAX_FRAME_BYTES + 256 * 1024, onError: c => c.json({ error: 'The recording is too large.' }, 413) }), async (c) => {
  const userId = c.get('user').id;
  const b = ownBot(userId, c.req.param('id'));
  if (!b || b.kind === 'room') return c.json({ error: 'not found' }, 404);
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'Send the recording as a form.' }, 400);
  const frames: { data: Buffer; at: number; ext: string }[] = [];
  const times = String(form.get('times') ?? '').split(',').map(Number);
  for (const file of form.getAll('frames').slice(0, MAX_FRAMES)) {
    if (typeof file === 'string' || !file.size || file.size > MAX_FRAME_BYTES) continue;
    const data = Buffer.from(await file.arrayBuffer());
    const jpeg = data[0] === 0xff && data[1] === 0xd8;
    const png = data.subarray(0, 4).toString('hex') === '89504e47';
    if (jpeg || png) frames.push({ data, at: Number.isFinite(times[frames.length]) ? times[frames.length] : 0, ext: jpeg ? 'jpg' : 'png' });
  }
  const id = await saveRecording(userId, b.id, {
    id: typeof form.get('id') === 'string' ? String(form.get('id')) : undefined,
    title: String(form.get('title') ?? '').trim().slice(0, 120), narration: String(form.get('narration') ?? '').slice(0, 20_000),
    notes: String(form.get('notes') ?? '').slice(0, 4000), seconds: Math.max(0, Math.min(3600, Number(form.get('seconds')) || 0)),
    source: String(form.get('source') ?? 'screen'), frames,
  });
  return c.json({ id });
});

featuresApi.get('/recordings', async (c) => c.json({ recordings: await listRecordings(c.get('user').id, c.req.query('botId') || undefined), keepDays: agentSettings(c.get('user').id).recordingDays }));
featuresApi.get('/recordings/:id/:frame', async (c) => {
  const data = await recordingFrame(c.get('user').id, c.req.param('id'), c.req.param('frame'));
  if (!data) return c.json({ error: 'not found' }, 404);
  return c.body(new Uint8Array(data), 200, { 'Content-Type': c.req.param('frame').endsWith('.png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
});
featuresApi.delete('/recordings/:id', async (c) => c.json({ ok: await deleteRecording(c.get('user').id, c.req.param('id')) }));
featuresApi.delete('/recordings', async (c) => c.json({ removed: await clearRecordings(c.get('user').id) }));

// ---------- how bots work (Settings → General → Bots) ----------

const localAction = (c: Parameters<typeof remoteAccessFor>[0]) =>
  isDesktop && !remoteAccessFor(c) && env.trustedOrigins.includes(c.req.header('origin') ?? '');

featuresApi.get('/agent-settings', (c) => c.json({ settings: agentSettings(c.get('user').id), recordingDayOptions: RECORDING_DAY_OPTIONS }));
featuresApi.put('/agent-settings', async (c) => {
  try {
    const patch = await c.req.json();
    if (patch?.autoHandoff !== undefined || patch?.handoffFallback !== undefined) {
      if (!localAction(c)) return c.json({ error: 'Change handoff settings on the Mac.' }, 403);
      if (patch.handoffFallback != null) patch.handoffFallback = await validateFallback(patch.handoffFallback);
    }
    return c.json({ settings: saveAgentSettings(c.get('user').id, patch) });
  } catch (error) { return c.json({ error: (error as Error).message }, 400); }
});

featuresApi.post('/bots/:id/handoffs/:handoff/continue', async (c) => {
  if (!localAction(c)) return c.json({ error: 'Continue handoffs on the Mac.' }, 403);
  try {
    const { selection, seq } = await c.req.json();
    await continueHandoff(c.get('user').id, c.req.param('id'), c.req.param('handoff'), selection, seq);
    return c.json({ ok: true }, 202);
  } catch (error) { return c.json({ error: (error as Error).message }, 400); }
});

featuresApi.post('/bots/:id/cloud-session', async (c) => {
  if (!localAction(c)) return c.json({ error: 'Start Cloud sessions on the Mac.' }, 403);
  const userId = c.get('user').id;
  const bot = ownBot(userId, c.req.param('id'));
  if (!bot || bot.deleted_at || bot.kind === 'room') return c.json({ error: 'Bot not found.' }, 404);
  try {
    const { goal, folder, allowLocalEdits } = await c.req.json();
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 20_000) throw new Error('Enter a Cloud task of up to 20,000 characters.');
    if (typeof folder !== 'string') throw new Error('Enter the path of your local project folder.');
    const path = await checkFolder(folder);
    const current = ownBot(userId, bot.id);
    if (!current || current.deleted_at || current.generation !== bot.generation) throw new Error('The conversation changed. Open the Cloud form again.');
    const id = startCloudSession(userId, bot.id, bot.generation, goal.trim(), { path, label: basename(path), write: allowLocalEdits === true });
    return c.json({ id }, 202);
  } catch (error) { return c.json({ error: (error as Error).message }, 400); }
});

featuresApi.post('/github/repos', async (c) => {
  if (!localAction(c)) return c.json({ error: 'Create GitHub repositories on the Mac.' }, 403);
  try { return c.json(await createGitHubRepo(await c.req.json()), 201); }
  catch (error) { return c.json({ error: (error as Error).message }, 400); }
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

// ---------- recent screenshots for the chat box picker (⇧⌘S) ----------

const localOnly = (c: Parameters<typeof remoteAccessFor>[0]) => isDesktop && !remoteAccessFor(c);
const MAC_ONLY = 'Screenshots are only available in the Marion Agent Mac app, on this Mac.';

featuresApi.get('/screenshots', async (c) => {
  if (!localOnly(c)) return c.json({ error: MAC_ONLY }, 403);
  try { return c.json(await listScreenshots(Number(c.req.query('limit') ?? 3), Number(c.req.query('offset') ?? 0))); }
  catch (error) {
    const block = macBlock(error, 'Read your Mac’s screenshots folder');
    if (block) { notifyMacBlocked(c.get('user').id, block); return c.json({ error: `${block.doing}: macOS blocked ${block.blocked}. To allow it: ${block.fix}.`, macBlock: block }, 403); }
    return c.json({ error: (error as Error).message || 'Could not read the screenshot folder.' }, 500);
  }
});

featuresApi.get('/screenshots/image', async (c) => {
  if (!localOnly(c)) return c.json({ error: MAC_ONLY }, 403);
  const image = await screenshotImage(c.req.query('name') ?? '', c.req.query('thumb') === '1').catch(() => null);
  if (!image) return c.json({ error: 'That screenshot is no longer there.' }, 404);
  return c.body(image.body, 200, { 'Content-Type': image.type, 'Cache-Control': 'private, max-age=600', 'X-Content-Type-Options': 'nosniff' });
});

// ---------- folders a bot may use (Bot settings → Access) ----------

featuresApi.get('/bots/:id/folders', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ folders: storedFolders(b.id), fullAccess: hasFullAccess(b.id), suggestion: await screenshotFolder().catch(() => null) });
});

/** Full access is per bot and only switched on from the Mac itself, after the owner confirms twice in the app. */
featuresApi.put('/bots/:id/full-access', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b || b.kind === 'room') return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.enabled !== 'boolean') return c.json({ error: 'Choose on or off.' }, 400);
  if (body.enabled && (remoteAccessFor(c) || body.confirm !== `give ${b.name} full access`)) return c.json({ error: 'Turn on full access on the Mac and confirm it.' }, 403);
  db.prepare('UPDATE bots SET full_access=? WHERE id=?').run(body.enabled ? 1 : 0, b.id);
  appendRow(b.id, 'event', { type: 'event', event: 'computer', text: body.enabled ? `Full access turned on for ${b.name}` : `Full access turned off for ${b.name}` });
  return c.json({ fullAccess: body.enabled });
});

featuresApi.post('/bots/:id/folders', async (c) => {
  if (remoteAccessFor(c)) return c.json({ error: 'Add folders on the Mac itself.' }, 403);
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  try {
    const path = body.pick ? await pickFolder() : String(body.path ?? '');
    if (!path) return c.json({ folders: storedFolders(b.id), cancelled: true });
    return c.json({ folders: await addBotFolder(b.id, path, typeof body.label === 'string' ? body.label : undefined, body.write !== false) });
  } catch (error) {
    if (error instanceof MacPermissionError) { notifyMacBlocked(c.get('user').id, error.block, b.id); return c.json({ error: error.message, macBlock: error.block }, 403); }
    return c.json({ error: (error as Error).message }, 400);
  }
});

featuresApi.patch('/bots/:id/folders', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (remoteAccessFor(c) && body.write === true) return c.json({ error: 'Allow changes on the Mac itself.' }, 403);
  try {
    return c.json({ folders: updateBotFolder(b.id, String(body.path ?? ''), { label: typeof body.label === 'string' ? body.label : undefined, write: typeof body.write === 'boolean' ? body.write : undefined }) });
  } catch (error) { return c.json({ error: (error as Error).message }, 400); }
});

featuresApi.delete('/bots/:id/folders', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  return c.json({ folders: removeBotFolder(b.id, String(body.path ?? '')) });
});

// ---------- Marion Life link ----------

featuresApi.get('/life-link', (c) => {
  const userId = c.get('user').id;
  return c.json({ settings: lifeLinkSettings(userId), hasKey: hasLifeKey(userId), outbox: outboxStatus(userId) });
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
    // Also send any waiting session summaries and deleted chats/bots.
    const queued = await drainLifeOutbox(userId, { manual: true }).catch(() => ({ sent: 0 }));
    return c.json({ ...result, queuedSent: queued.sent, outbox: outboxStatus(userId), settings: lifeLinkSettings(userId) });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 502);
  }
});


// ---------- coding sessions (Claude Code, Codex, Gemini on this Mac) ----------

featuresApi.get('/sessions', (c) => {
  const provider = c.req.query('provider');
  const valid = provider === 'claude' || provider === 'codex' || provider === 'gemini' ? provider as SessionProvider : undefined;
  return c.json({ sessions: listCodingSessions(valid) });
});

// ---------- Marion Agent's own sessions: bot chats and relayed Claude / Codex / Gemini runs ----------

const sessionQuery = (c: { req: { query: (name: string) => string | undefined } }, botId?: string) => {
  const type = c.req.query('type');
  return {
    botId: botId ?? c.req.query('botId') ?? undefined,
    type: type === 'chat' || type === 'relay' ? type : undefined,
    kind: c.req.query('kind') || undefined,
    provider: c.req.query('provider') || undefined,
    status: c.req.query('status') || undefined,
    limit: Number(c.req.query('limit')) || undefined,
  } as const;
};

/** GET /api/sessions/marion?botId=&type=chat|relay&kind=&provider=claude|codex|gemini&status=&limit= */
featuresApi.get('/sessions/marion', (c) => {
  const sessions = listSessions(c.get('user').id, sessionQuery(c));
  return c.json({ sessions, running: sessions.filter(s => s.status === 'running').length });
});

/** GET /api/stats?range=7d|30d|all: streaks, totals, per-bot leaderboard, provider breakdown and highlights. */
featuresApi.get('/stats', (c) => c.json(computeStats(c.get('user').id, { range: parseStatsRange(c.req.query('range')) })));

/** One bot's conversations and the relayed agent runs it started. */
featuresApi.get('/bots/:id/sessions', (c) => {
  if (!ownBot(c.get('user').id, c.req.param('id'))) return c.json({ error: 'Not found' }, 404);
  const sessions = listSessions(c.get('user').id, sessionQuery(c, c.req.param('id')));
  return c.json({ sessions, running: sessions.filter(s => s.status === 'running').length });
});

/** Read-only look inside one conversation of a bot (any earlier one too). */
featuresApi.get('/bots/:id/sessions/:generation/messages', (c) => {
  const messages = chatSessionMessages(c.get('user').id, c.req.param('id'), Number(c.req.param('generation')) || 0);
  return messages ? c.json({ messages }) : c.json({ error: 'Not found' }, 404);
});

featuresApi.get('/sessions/:id/messages', (c) => c.json({ messages: codingSessionMessages(c.req.param('id')) }));

// ---------- app updates (Mac app only, never from a paired phone or browser) ----------

featuresApi.get('/app/update', async (c) => {
  if (remoteAccessFor(c)) return c.json({ supported: false, reason: 'Check for updates on the Mac.' });
  c.header('Cache-Control', 'no-store');
  return c.json({ ...await updateStatus(c.req.query('current') ?? null), autoUpdate: updateSettings(c.get('user').id).autoUpdate });
});

/** Settings → Updates → Auto-update (on by default). */
featuresApi.put('/app/update/settings', async (c) => {
  if (remoteAccessFor(c)) return c.json({ error: 'Change this on the Mac.' }, 403);
  const body = await c.req.json().catch(() => ({})) as { autoUpdate?: unknown };
  if (typeof body.autoUpdate !== 'boolean') return c.json({ error: 'Choose on or off.' }, 400);
  return c.json({ autoUpdate: setAutoUpdate(c.get('user').id, body.autoUpdate).autoUpdate });
});

featuresApi.post('/app/update', async (c) => {
  if (remoteAccessFor(c)) return c.json({ error: 'Install updates on the Mac.' }, 403);
  const status = await updateStatus(null);
  if (!status.supported) return c.json({ error: status.reason ?? 'Updates aren’t available here.' }, 400);
  if (status.behind === 0) return c.json({ error: 'Marion Agent is already up to date.' }, 409);
  if (status.dirty) return c.json({ error: 'The source folder has unsaved changes from another chat. Update once that work is committed.' }, 409);
  const result = startUpdate();
  return 'error' in result ? c.json(result, 409) : c.json(result);
});
