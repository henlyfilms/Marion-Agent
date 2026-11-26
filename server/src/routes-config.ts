import { canManageComposio, composioStatus, updateComposioKey } from './composio.js';
import { Hono } from 'hono';
import { totalmem } from 'node:os';
import { availableLocalModels, localEfforts, saveLocalModel, selectedLocalModel } from './agent/models.js';
import { getChatProvider, saveChatProvider, subscriptionAvailability, subscriptionModels, subscriptionSelection } from './agent/subscriptions.js';
import { chatModelForBot } from './agent/chat-model.js';
import { orchestrationFor, saveOrchestration, TeamSettingsError, validateTeamSettings } from './agent/orchestration-settings.js';
import { desktopAccessHeader, hasDesktopAccess, isDesktop } from './lib/desktop-access.js';
import { env } from './env.js';
import { db, now } from './db.js';
import './db-config.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { browserSessionChoices, browserSessionHours, requireUser, saveBrowserSessionHours, type AuthVars } from './lib/auth.js';
import { emitBot, getBot, getBotRow, listRoutines, listTasks } from './store.js';
import { BOX_ROOT, computerState, screenFor, stopDesktop } from './computer.js';
import { desktop } from './desktop.js';
import { runInBotQueue } from './agent/loop.js';
import { consolidateBot, historySize, maybeCompact, memoryConfig } from './agent/memory.js';
import { idleConfig, viewerCount } from './idle.js';
import { loadHistory } from './store.js';
import { deleteUniversalSkill, listUniversalSkills, universalNames, updateUniversalSkill, upsertUniversalSkill } from './features/universal-skills.js';
import { chatProviders, type ChatModel, type ChatModelSettings, type ChatProvider, type ChatModelSelection, type LibraryFile, type Memory, type Skill } from './types.js';

/**
 * Bot settings, skills, library, computer controls and memory maintenance.
 * Mounted next to routes.ts in index.ts; every path here needs a signed-in user.
 */
export const configApi = new Hono<AuthVars>();

for (const p of ['/bots/*', '/skills/*', '/computer/*', '/settings/*', '/orchestration/*']) configApi.use(p, requireUser);

for (const [kind, access] of [['mobile', env.mobileAccess], ['browser', env.browserAccess]] as const) {
  configApi.get(`/settings/${kind}-access`, (c) => {
    if (!isDesktop || !hasDesktopAccess(c.req.header(desktopAccessHeader))) return c.json({ error: 'Open Settings on your Mac.' }, 403);
    c.header('Cache-Control', 'no-store');
    return c.json({
      origin: access?.origin ?? null,
      passphrase: c.req.query('reveal') === '1' ? access?.passphrase ?? null : null,
      ...(kind === 'browser' ? { sessionHours: browserSessionHours(), sessionChoices: browserSessionChoices } : {}),
    });
  });
}

configApi.put('/settings/browser-session', async (c) => {
  const origin = c.req.header('origin');
  if (!isDesktop || !hasDesktopAccess(c.req.header(desktopAccessHeader)) || !origin || !env.trustedOrigins.includes(origin)) {
    return c.json({ error: 'Open Settings on your Mac.' }, 403);
  }
  const body = await c.req.json<{ hours?: unknown }>().catch(() => null);
  const hours = browserSessionChoices.find((choice) => choice === body?.hours);
  if (!hours) return c.json({ error: 'Choose how long browsers stay signed in.' }, 400);
  saveBrowserSessionHours(hours);
  return c.json({ sessionHours: hours });
});

configApi.get('/settings/chat-provider', (c) => {
  if (!isDesktop) return c.json({ error: 'Open the Mac app to use subscription chat' }, 403);
  return c.json({ provider: getChatProvider(c.get('user').id), installed: subscriptionAvailability() });
});

configApi.put('/settings/chat-provider', async (c) => {
  const origin = c.req.header('origin');
  if (!isDesktop || !origin || !env.trustedOrigins.includes(origin)) {
    return c.json({ error: 'Open the Mac app to use subscription chat' }, 403);
  }
  const body = await c.req.json<{ provider?: unknown }>().catch(() => null);
  const provider = chatProviders.find(option => option === body?.provider);
  if (!provider) return c.json({ error: 'Select a chat provider' }, 400);
  const installed = subscriptionAvailability();
  if (provider !== 'local' && !installed[provider]) return c.json({ error: 'Install the provider’s CLI first' }, 400);
  const userId = c.get('user').id;
  saveChatProvider(userId, provider);
  hub.emit(userId, { type: 'model-settings' });
  return c.json({ provider, installed });
});

configApi.get('/settings/subscription-model/:provider', async (c) => {
  const provider = chatProviders.find(option => option !== 'local' && option === c.req.param('provider'));
  if (!provider || provider === 'local' || !isDesktop) return c.json({ error: 'Choose a subscription provider in the Mac workspace.' }, 400);
  const saved = subscriptionSelection(c.get('user').id, provider);
  try {
    const { models, defaultModel } = await subscriptionModels(provider);
    const fallback = models.find(option => option.id === defaultModel);
    const selection = saved.model ? saved
      : { provider, model: defaultModel ?? '', effort: fallback?.defaultEffort ?? null };
    return c.json({ selection, models });
  } catch (error) {
    return c.json({ selection: saved, models: [], error: (error as Error).message });
  }
});

configApi.put('/settings/subscription-model/:provider', async (c) => {
  const provider = chatProviders.find(option => option !== 'local' && option === c.req.param('provider'));
  const origin = c.req.header('origin');
  if (!provider || provider === 'local' || !isDesktop || !origin || !env.trustedOrigins.includes(origin)) {
    return c.json({ error: 'Choose a subscription provider in the Mac workspace.' }, 403);
  }
  const body = await c.req.json<Partial<ChatModelSelection>>().catch(() => null);
  const catalog = await subscriptionModels(provider).catch(() => null);
  if (!catalog) return c.json({ error: 'The provider model list is unavailable. Check its CLI and sign-in.' }, 503);
  const option = catalog.models.find(entry => entry.id === body?.model);
  const effort = body?.effort;
  if (!option || (effort === null ? option.efforts.length > 0 : typeof effort !== 'string' || !option.efforts.includes(effort))) {
    return c.json({ error: 'Choose a supported model and effort.' }, 400);
  }
  const userId = c.get('user').id;
  db.prepare(`INSERT INTO subscription_model_preferences(user_id,provider,model,effort) VALUES (?,?,?,?)
    ON CONFLICT(user_id,provider) DO UPDATE SET model=excluded.model,effort=excluded.effort`).run(userId, provider, option.id, effort);
  hub.emit(userId, { type: 'model-settings' });
  return c.json({ selection: { provider, model: option.id, effort }, models: catalog.models });
});

configApi.get('/settings/models', async (c) => {
  const selected = selectedLocalModel(c.get('user').id);
  try {
    return c.json({ selected, defaultModel: env.localModelName, models: await availableLocalModels(), reachable: true });
  } catch {
    return c.json({ selected, defaultModel: env.localModelName, models: [], reachable: false });
  }
});

configApi.get('/settings/local-memory', (c) => {
  const host = URL.parse(env.localModelUrl)?.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') return c.json({ memory: null });
  const total = totalmem();
  return c.json({ memory: { available: Math.min(process.availableMemory(), total), total } }, 200, { 'Cache-Control': 'no-store' });
});

configApi.put('/settings/models', async (c) => {
  const body = await c.req.json<{ model?: unknown }>().catch(() => null);
  const model = body?.model;
  if (typeof model !== 'string' || model.length > 200) return c.json({ error: 'Select a model' }, 400);
  if (model) {
    try {
      if (!(await availableLocalModels()).includes(model)) return c.json({ error: 'That model is not available on your local server' }, 400);
    } catch {
      return c.json({ error: 'Start your local model server and refresh the list' }, 503);
    }
  }
  const userId = c.get('user').id;
  saveLocalModel(userId, model);
  hub.emit(userId, { type: 'model-settings' });
  return c.json({ selected: selectedLocalModel(userId) });
});

configApi.get('/settings/composio', (c) => c.json(composioStatus()));

configApi.put('/settings/composio', async (c) => {
  if (!canManageComposio) return c.json({ error: 'Set COMPOSIO_API_KEY on the server' }, 403);
  const origin = c.req.header('origin');
  if (!origin || !env.trustedOrigins.includes(origin)) return c.json({ error: 'Open local Marion Agent settings to change the key' }, 403);
  const body = await c.req.json<{ key?: unknown }>().catch(() => null);
  const key = typeof body?.key === 'string' ? body.key.trim() : null;
  if (key === null || key.length > 512 || (key && !/^[A-Za-z0-9._-]{8,512}$/.test(key))) return c.json({ error: 'Enter a valid Composio project key' }, 400);
  try {
    return c.json(await updateComposioKey(key));
  } catch (error) {
    const message = (error as NodeJS.ErrnoException).code ? 'Could not save the key on this machine' : (error as Error).message;
    return c.json({ error: message }, 502);
  }
});

const ownBot = (userId: string, id: string) => {
  const b = getBotRow(id);
  return b && b.user_id === userId ? b : null;
};

async function modelSettings(userId: string, bot: ReturnType<typeof getBotRow>, discover: boolean): Promise<ChatModelSettings> {
  const selection = chatModelForBot(bot);
  const { provider } = selection;
  const local = selectedLocalModel(userId);
  const unavailable: ChatModelSettings['unavailable'] = {};
  const localModels = new Set([local, env.localModelName]);
  if (provider === 'local') localModels.add(selection.model);
  const loadLocal = async () => {
    localModels.clear();
    try {
      for (const model of await availableLocalModels()) localModels.add(model);
      if (!localModels.size) unavailable.local = 'Load a model on your local model server.';
      else if (provider === 'local' && !localModels.has(selection.model)) {
        unavailable.local = `${selection.model} isn’t loaded. Choose an available model.`;
      }
    } catch { unavailable.local = 'Start Ollama or your configured local model server.'; }
  };
  const installed = subscriptionAvailability();
  const native: Exclude<ChatProvider, 'local'>[] = ['codex', 'gemini', 'claude'];
  const loadProvider = async (option: Exclude<ChatProvider, 'local'>): Promise<ChatModel[]> => {
    if (!isDesktop || !installed[option]) {
      unavailable[option] = isDesktop ? 'Install the provider CLI on the host.' : 'Available in the Mac workspace.';
      return [];
    }
    if (!discover && option !== provider) return [];
    try {
      const { models, defaultModel } = await subscriptionModels(option);
      if (option === provider && !selection.model) {
        selection.model = defaultModel ?? '';
        selection.effort = models.find(model => model.id === defaultModel)?.defaultEffort ?? null;
      }
      return models;
    } catch (error) {
      unavailable[option] = (error as Error).message;
      return [];
    }
  };
  const [subscriptionCatalog] = await Promise.all([
    Promise.all(native.map(loadProvider)),
    discover ? loadLocal() : undefined,
  ]);
  const models: ChatModel[] = [...localModels].map(id => ({ provider: 'local', id, label: id, efforts: [...localEfforts], defaultEffort: 'medium' }));
  return { selection, models: [...models, ...subscriptionCatalog.flat()], unavailable };
}

configApi.get('/bots/:id/chat-model', async (c) => {
  const userId = c.get('user').id;
  const bot = ownBot(userId, c.req.param('id'));
  if (!bot) return c.json({ error: 'not found' }, 404);
  return c.json(await modelSettings(userId, bot, c.req.query('discover') === '1'));
});

configApi.put('/bots/:id/chat-model', async (c) => {
  const userId = c.get('user').id;
  const bot = ownBot(userId, c.req.param('id'));
  if (!bot) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<{ provider?: unknown; model?: unknown; effort?: unknown }>().catch(() => null);
  const provider = chatProviders.find(option => option === body?.provider);
  const model = body?.model;
  const effort = body?.effort;
  if (!provider || typeof model !== 'string' || !model || model.length > 200 || (effort !== null && typeof effort !== 'string')) {
    return c.json({ error: 'Choose a model and effort.' }, 400);
  }
  let label = model;
  if (provider === 'local') {
    if (!localEfforts.some(option => option === effort)) return c.json({ error: 'Choose a supported local effort.' }, 400);
    const current = selectedLocalModel(userId);
    if (model !== current && model !== env.localModelName && !(bot.chat_provider === 'local' && bot.chat_model === model)) {
      const models = await availableLocalModels().catch((): string[] => []);
      if (!models.includes(model)) return c.json({ error: 'That model is not available on your local server.' }, 400);
    }
  } else {
    const origin = c.req.header('origin');
    if (!isDesktop || bot.kind === 'room' || !origin || !env.trustedOrigins.includes(origin)) {
      return c.json({ error: 'Subscription models are available for individual chats in the Mac workspace.' }, 403);
    }
    const catalog = await subscriptionModels(provider).catch(() => null);
    if (!catalog) return c.json({ error: 'The provider model list is unavailable. Check its CLI and sign-in.' }, 503);
    const option = catalog.models.find(entry => entry.id === model);
    if (!option || (effort === null ? option.efforts.length > 0 : !option.efforts.includes(effort))) {
      return c.json({ error: 'Choose a supported model and effort.' }, 400);
    }
    label = option.label;
  }
  const saved = db.prepare(`UPDATE bots SET chat_provider=?, chat_model=?, chat_model_label=?, chat_effort=?,
    effort=CASE WHEN ?='local' THEN ? ELSE effort END WHERE id=? AND user_id=?`)
    .run(provider, model, label, effort, provider, effort, bot.id, userId);
  if (!saved.changes) return c.json({ error: 'not found' }, 404);
  const updated = getBot(bot.id)!;
  emitBot(bot.id);
  return c.json({ selection: updated.chatModel, bot: updated });
});

// ---------- Team mode (multi-model orchestration) ----------

configApi.get('/bots/:id/orchestration', (c) => {
  const bot = ownBot(c.get('user').id, c.req.param('id'));
  if (!bot || bot.kind === 'room') return c.json({ error: 'not found' }, 404);
  return c.json({ settings: orchestrationFor(bot), orchestrator: chatModelForBot(bot) });
});

configApi.put('/bots/:id/orchestration', async (c) => {
  const userId = c.get('user').id;
  const bot = ownBot(userId, c.req.param('id'));
  if (!bot || bot.kind === 'room') return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<{ enabled?: unknown; members?: unknown; balanceUsage?: unknown }>().catch(() => null);
  if (!body) return c.json({ error: 'Send the team settings.' }, 400);
  const origin = c.req.header('origin');
  let settings;
  try {
    settings = await validateTeamSettings(body, isDesktop && Boolean(origin && env.trustedOrigins.includes(origin)));
  } catch (error) {
    return c.json({ error: (error as Error).message }, error instanceof TeamSettingsError ? error.status : 400);
  }
  saveOrchestration(bot.id, settings);
  emitBot(bot.id);
  return c.json({ settings, bot: getBot(bot.id) });
});

const toMemory = (m: any): Memory => ({ id: m.id, botId: m.bot_id, text: m.text, createdAt: m.created_at, source: m.source === 'learned' ? 'learned' : 'chat' });
const toSkill = (s: any): Skill => ({ id: s.id, botId: s.bot_id, name: s.name, description: s.description ?? '', body: s.body, createdAt: s.created_at, updatedAt: s.updated_at ?? s.created_at });
const listSkills = (botId: string) => (db.prepare('SELECT * FROM skills WHERE bot_id=? ORDER BY created_at ASC').all(botId) as any[]).map(toSkill);

// ---------- settings bundle ----------

configApi.get('/bots/:id/settings', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const memories = (db.prepare('SELECT * FROM memories WHERE bot_id=? ORDER BY created_at DESC').all(b.id) as any[]).map(toMemory);
  const job = db.prepare('SELECT last_consolidated_at, last_result FROM memory_jobs WHERE bot_id=?').get(b.id) as any;
  const lastCompaction = db.prepare('SELECT method, items_before, items_after, chars_before, chars_after, created_at FROM compactions WHERE bot_id=? ORDER BY id DESC LIMIT 1').get(b.id) as any;
  return c.json({
    memories,
    skills: listSkills(b.id),
    universalSkills: listUniversalSkills(b.user_id),
    routines: listRoutines(b.id),
    tasks: listTasks(b.id),
    memory: {
      lastConsolidatedAt: job?.last_consolidated_at ?? null,
      historyChars: historySize(b.id, loadHistory(b.id)),
      compactAtChars: memoryConfig.compactChars,
      lastCompaction: lastCompaction ?? null,
    },
  });
});

// ---------- skills ----------

function cleanSkill(p: any, partial = false): { name?: string; description?: string; body?: string } | string {
  const out: { name?: string; description?: string; body?: string } = {};
  if (p.name !== undefined || !partial) {
    const name = String(p.name ?? '').trim();
    if (!name) return 'Give the skill a name';
    out.name = name.slice(0, 80);
  }
  if (p.body !== undefined || !partial) {
    const body = String(p.body ?? '').trim();
    if (!body) return 'Write the steps for this skill';
    out.body = body.slice(0, 20_000);
  }
  if (p.description !== undefined) out.description = String(p.description).trim().slice(0, 300);
  return out;
}

configApi.get('/bots/:id/skills', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ skills: listSkills(b.id) }) : c.json({ error: 'not found' }, 404);
});

configApi.post('/bots/:id/skills', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const s = cleanSkill(await c.req.json().catch(() => ({})));
  if (typeof s === 'string') return c.json({ error: s }, 400);
  if (universalNames(b.user_id).has(String(s.name).replace(/\s+/g, ' ').toLowerCase())) return c.json({ error: `"${s.name}" is a universal skill. Edit it under Universal skills so every Bot gets the change.` }, 409);
  const id = newId('skl');
  db.prepare('INSERT INTO skills(id,bot_id,name,body,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, b.id, s.name, s.body, s.description ?? '', now(), now());
  return c.json({ skill: toSkill(db.prepare('SELECT * FROM skills WHERE id=?').get(id)) });
});

// Universal skills: one shared copy per user, injected into every Bot's prompt.
configApi.get('/skills/universal', (c) => c.json({ skills: listUniversalSkills(c.get('user').id) }));

configApi.post('/skills/universal', async (c) => {
  const s = cleanSkill(await c.req.json().catch(() => ({})));
  if (typeof s === 'string') return c.json({ error: s }, 400);
  const r = upsertUniversalSkill(c.get('user').id, s);
  return r.ok ? c.json({ skill: r.skill }) : c.json({ error: r.message }, 400);
});

configApi.patch('/skills/universal/:id', async (c) => {
  const s = cleanSkill(await c.req.json().catch(() => ({})), true);
  if (typeof s === 'string') return c.json({ error: s }, 400);
  const r = updateUniversalSkill(c.get('user').id, c.req.param('id'), s);
  if (r.ok) return c.json({ skill: r.skill });
  return c.json({ error: r.message }, r.message === 'not found' ? 404 : 400);
});

configApi.delete('/skills/universal/:id', (c) =>
  deleteUniversalSkill(c.get('user').id, c.req.param('id')) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404));

const ownSkill = (userId: string, id: string) =>
  db.prepare('SELECT s.* FROM skills s JOIN bots b ON b.id=s.bot_id WHERE s.id=? AND b.user_id=?').get(id, userId) as any;

configApi.patch('/skills/:id', async (c) => {
  const cur = ownSkill(c.get('user').id, c.req.param('id'));
  if (!cur) return c.json({ error: 'not found' }, 404);
  const s = cleanSkill(await c.req.json().catch(() => ({})), true);
  if (typeof s === 'string') return c.json({ error: s }, 400);
  if (s.name !== undefined && universalNames(c.get('user').id).has(s.name.replace(/\s+/g, ' ').toLowerCase())) return c.json({ error: `"${s.name}" is a universal skill name. Pick another name.` }, 409);
  db.prepare('UPDATE skills SET name=?, body=?, description=?, updated_at=? WHERE id=?').run(s.name ?? cur.name, s.body ?? cur.body, s.description ?? cur.description ?? '', now(), cur.id);
  return c.json({ skill: toSkill(db.prepare('SELECT * FROM skills WHERE id=?').get(cur.id)) });
});

configApi.delete('/skills/:id', (c) => {
  const cur = ownSkill(c.get('user').id, c.req.param('id'));
  if (!cur) return c.json({ error: 'not found' }, 404);
  db.prepare('DELETE FROM skills WHERE id=?').run(cur.id);
  return c.json({ ok: true });
});

// ---------- memory maintenance ----------

/** Run consolidation now instead of waiting for the idle window. */
configApi.post('/bots/:id/memories/consolidate', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  try {
    return c.json(await consolidateBot(b.id));
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 502);
  }
});

/** Compact the stored history now (inside the bot's queue). `force` compacts even under the threshold. */
configApi.post('/bots/:id/compact', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const force = c.req.query('force') === '1';
  const before = loadHistory(b.id).length;
  const after = await runInBotQueue(b.id, async () => (await maybeCompact(b.id, loadHistory(b.id), { force })).length);
  return c.json({ itemsBefore: before, itemsAfter: after, compacted: after !== before });
});

// ---------- library: files under BOX_ROOT/files/<botId> on the bot's computer ----------

const LIB_ROOT = `${BOX_ROOT}/files`;

function safeRel(p: unknown): string | null {
  if (p !== undefined && typeof p !== 'string') return null;
  const rel = (p ?? '').replace(/^\/+|\/+$/g, '');
  if (!rel) return '';
  if (rel.split('/').some((s) => !s || s === '.' || s === '..') || /[\0\n\r]/.test(rel)) return null;
  return rel;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Parse `ls -la --time-style=+%s` output. */
export function parseLs(out: string): LibraryFile[] {
  const files: LibraryFile[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^([-dlcbps])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    let name = m[4];
    if (m[1] === 'l') name = name.replace(/ -> .*$/, '');
    if (name === '.' || name === '..') continue;
    files.push({ name, size: Number(m[2]), modifiedAt: Number(m[3]) * 1000, isDir: m[1] === 'd' });
  }
  return files.sort((a, b) => Number(b.isDir) - Number(a.isDir) || b.modifiedAt - a.modifiedAt);
}

configApi.get('/bots/:id/files', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const rel = safeRel(c.req.query('path'));
  if (rel === null) return c.json({ error: 'bad path' }, 400);
  try {
    if (c.req.query('wake') === '1') await screenFor(user.id, b.id);
    else if (!db.prepare('SELECT 1 FROM screens WHERE bot_id=? AND screen_id=bot_id').get(b.id) || !await desktop.running(b.id)) {
      return c.json({ status: 'asleep', path: rel, files: [] });
    }
    const dir = `${LIB_ROOT}/${b.id}${rel ? `/${rel}` : ''}`;
    const r = await desktop.bash(b.id, `mkdir -p ${shq(`${LIB_ROOT}/${b.id}`)} && ls -la --time-style=+%s ${shq(dir)} 2>&1`, 30);
    if (r.exit_code !== 0) return c.json({ status: 'error', path: rel, files: [], error: (r.output ?? '').slice(0, 300) });
    return c.json({ status: 'ok', path: rel, files: parseLs(r.output ?? '') });
  } catch (e: any) {
    return c.json({ status: 'error', path: rel, files: [], error: String(e?.message ?? e).slice(0, 300) });
  }
});

configApi.post('/bots/:id/files/download', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const { path } = await c.req.json<{ path: string }>().catch(() => ({ path: '' }));
  const rel = safeRel(path);
  if (!rel) return c.json({ error: 'bad path' }, 400);
  try {
    await screenFor(user.id, b.id);
    const bytes = await desktop.download(b.id, `${LIB_ROOT}/${b.id}/${rel}`);
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment',
      'Cache-Control': 'no-store',
    });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 502);
  }
});

// ---------- computer: screens, reset, hibernation ----------

configApi.get('/computer/details', (c) => {
  const userId = c.get('user').id;
  const leases = db.prepare('SELECT bot_id, screen_id, last_used_at FROM screens WHERE user_id=? AND screen_id=bot_id ORDER BY last_used_at DESC').all(userId) as any[];
  return c.json({
    computer: computerState(userId),
    screens: leases.map((l) => ({ botId: l.bot_id, screenId: l.screen_id, lastUsedAt: l.last_used_at })),
    hibernation: { idleMinutes: idleConfig.idleMin, viewers: viewerCount(userId), dryRun: idleConfig.dryRun },
  });
});

configApi.post('/bots/:id/screen/reset', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  try {
    await stopDesktop(user.id, b.id);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 502);
  }
});
