import { isAvatarColor, isStemColor, AVATAR_SHAPE_IDS, NAMED_AVATAR_COLORS, normalizeAvatarShape } from '../avatarShapes.js';
import { db, now } from '../db.js';
import { hub } from '../lib/hub.js';
import { createBotRecord } from './bots.js';
import { agentSettings } from './agent-settings.js';
import { archiveDeletedBot, noteRestoredBot } from './life-outbox.js';
import { emitBot, getBot, toBot } from '../store.js';
import { matchModel } from '../agent/orchestrate.js';
import { preferredEffort, subscriptionModels } from '../agent/subscriptions.js';
import { availableLocalModels } from '../agent/models.js';
import { env } from '../env.js';
import { chatProviders, type ChatModel, type ChatProvider } from '../types.js';
import { CHAT_EFFORTS, chatEffortDefault, chatEffortForBot, inheritedChatProvider, saveChatEffortDefault } from '../agent/chat-model.js';

/**
 * marion_app: lets any bot change Marion Agent itself, the way the owner would in the app:
 * list, create, rename, recolor, reshape, re-describe, star, delete or restore bots, and set a bot's
 * chat model and chat reasoning effort (per bot, or the chat-only default). On for every bot by default; Settings → General → "Bots can change Marion Agent" turns it off.
 */

const EFFORT_WORDS = ['low', 'medium', 'high', 'xhigh', 'max', 'default'] as const;

export const appControlTool = {
  name: 'marion_app',
  description: 'Change the Marion Agent app itself when the owner asks: list_bots, create_bot, update_bot (name, job, description, instructions, color as a name or #hex, icon shape, glow, stem color, starred), delete_bot (recoverable 30 days), restore_bot, set_model (a bot\'s chat model, e.g. "Claude Opus", "Gemini 4 Neon"), get_chat_effort (each bot\'s effective chat reasoning effort, whether it is the bot\'s own override or an inherited default, plus the chat-only defaults; optional bot), set_chat_effort (bot + effort: that bot\'s chat effort only; its model stays), set_chat_default_effort (effort, optional provider: the chat-only default inherited by bots without their own override; builder/team/Ask defaults and models stay). Efforts: low, medium, high, xhigh, max (by provider); "default" clears a bot\'s effort-only override or the chat-only default. list_bots also shows chat_effort, chat_effort_source and chat_default_effort. "bot" is a bot\'s name; use "me" for yourself.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { type: 'string', enum: ['list_bots', 'create_bot', 'update_bot', 'delete_bot', 'restore_bot', 'set_model', 'get_chat_effort', 'set_chat_effort', 'set_chat_default_effort'] },
      bot: { type: 'string', description: 'Which bot (name, or "me")' },
      name: { type: 'string' }, job: { type: 'string' }, description: { type: 'string' }, instructions: { type: 'string' },
      color: { type: 'string', description: `${NAMED_AVATAR_COLORS.join(', ')} or #rrggbb` },
      shape: { type: 'string', enum: [...AVATAR_SHAPE_IDS], description: `Bot icon: ${AVATAR_SHAPE_IDS.join(', ')}` },
      glow: { type: 'boolean' }, stem_color: { type: 'string', description: '#rrggbb' }, starred: { type: 'boolean' },
      model: { type: 'string', description: 'For set_model: the model name' },
      effort: { type: 'string', enum: [...EFFORT_WORDS], description: 'For set_chat_effort / set_chat_default_effort: low, medium, high, xhigh or max (the provider must offer it); "default" removes the override/default' },
      provider: { type: 'string', enum: [...chatProviders], description: 'For set_chat_default_effort: which chat provider\'s default (omit for the one chats inherit now)' },
    },
  },
};

const COLOR_WORDS: Record<string, string> = { purple: 'violet', pink: 'magenta', grey: 'gray', teal: 'cyan', gold: 'yellow' };

function findBot(userId: string, selfId: string, query: unknown, deleted = false) {
  const wanted = String(query ?? '').trim().toLowerCase();
  if (!wanted || wanted === 'me' || wanted === 'yourself' || wanted === 'you') return db.prepare('SELECT * FROM bots WHERE id=?').get(selfId) as any;
  const rows = db.prepare(`SELECT * FROM bots WHERE user_id=? AND ${deleted ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL AND hidden=0'}`).all(userId) as any[];
  return rows.find(r => r.id === query) ?? rows.find(r => r.name.toLowerCase() === wanted)
    ?? rows.find(r => r.name.toLowerCase().startsWith(wanted)) ?? rows.find(r => `${r.name} ${r.label ?? ''}`.toLowerCase().includes(wanted));
}

function color(value: unknown) {
  if (value === undefined) return undefined;
  const raw = String(value).trim().toLowerCase();
  const named = COLOR_WORDS[raw] ?? raw;
  if (isAvatarColor(named)) return named;
  throw new Error(`"${value}" isn't a bot color. Use ${NAMED_AVATAR_COLORS.join(', ')} or a #rrggbb hex.`);
}

/** The chat provider bots without their own model inherit right now: its chat-only default is the "applicable" one. */
function applicableProvider(userId: string): ChatProvider {
  return inheritedChatProvider({ user_id: userId, kind: 'agent' });
}

function effortWord(value: unknown): typeof EFFORT_WORDS[number] | null {
  const word = String(value ?? '').trim().toLowerCase().replace(/^extra[\s-]?high$/, 'xhigh').replace(/^(inherit|none|clear|reset)$/, 'default');
  return EFFORT_WORDS.find(e => e === word) ?? null;
}

const badEffort = (value: unknown) => `"${value ?? ''}" isn't a reasoning effort. Use low, medium, high, xhigh, max, or "default".`;

/** A bot's effective chat effort and where it comes from, as marion_app reports it. */
function effortView(row: any) {
  const info = chatEffortForBot(row);
  return { chat_provider: info.selection.provider, chat_effort: info.effort, chat_effort_source: info.source,
    chat_effort_inherited: info.source !== 'bot_override', chat_default_effort: info.chatDefault };
}

async function models(desktop: boolean): Promise<ChatModel[]> {
  const local = await availableLocalModels().catch((): string[] => []);
  const subs = desktop ? await Promise.all((['codex', 'gemini', 'claude'] as const).map(p => subscriptionModels(p).then(c => c.models).catch((): ChatModel[] => []))) : [];
  return [...[...new Set([env.localModelName, ...local])].map((id): ChatModel => ({ provider: 'local', id, label: id, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' })), ...subs.flat()];
}

export async function runAppControl(ctx: { userId: string; botId: string; allowSubscriptionTeam?: boolean }, a: any) {
  if (!agentSettings(ctx.userId).appControl) return { output: 'The owner turned off "Bots can change Marion Agent" in Settings → General. Tell them to turn it on to do this.' };
  const userId = ctx.userId;
  switch (a?.action) {
    case 'list_bots': {
      const rows = db.prepare('SELECT * FROM bots WHERE user_id=? AND deleted_at IS NULL AND hidden=0 ORDER BY name').all(userId) as any[];
      return { output: JSON.stringify(rows.map(r => { const b = toBot(r); return { name: b.name, job: b.label, color: b.avatarColor, shape: b.avatarShape, glow: b.avatarGlow, starred: b.pinned, model: b.chatModel?.label ?? b.chatModel?.model, ...effortView(r), you: r.id === ctx.botId }; })), summary: 'Listed the bots' };
    }
    case 'get_chat_effort': {
      const rows = a.bot ? [findBot(userId, ctx.botId, a.bot)].filter(Boolean)
        : db.prepare('SELECT * FROM bots WHERE user_id=? AND deleted_at IS NULL AND hidden=0 ORDER BY name').all(userId) as any[];
      if (!rows.length) return { output: `No bot matches "${a.bot}". Use list_bots to see names.` };
      const defaults = Object.fromEntries(chatProviders.map(p => [p, chatEffortDefault(userId, p)]));
      return { output: JSON.stringify({ chat_default_provider: applicableProvider(userId), chat_default_efforts: defaults,
        bots: rows.map(r => ({ name: r.name, model: toBot(r).chatModel?.label ?? toBot(r).chatModel?.model, ...effortView(r), you: r.id === ctx.botId })) }), summary: 'Read chat efforts' };
    }
    case 'set_chat_effort': {
      if (!a.bot) return { output: 'Say which bot (its name, or "me").' };
      const row = findBot(userId, ctx.botId, a.bot);
      if (!row) return { output: `No bot matches "${a.bot}". Use list_bots to see names.` };
      const effort = effortWord(a.effort);
      if (!effort) return { output: badEffort(a.effort) };
      const before = chatEffortForBot(row);
      const provider = before.selection.provider;
      const pinned = !before.inheritsModel;
      if (effort === 'default') {
        if (pinned) return { output: `${row.name} has its own chat model, so its effort can't inherit. Pick a level (${CHAT_EFFORTS[provider].join(', ')}).` };
        db.prepare('UPDATE bots SET chat_effort=NULL WHERE id=?').run(row.id);
      } else {
        if (!CHAT_EFFORTS[provider].includes(effort)) return { output: `${row.name} chats on ${provider}, which supports ${CHAT_EFFORTS[provider].join(', ')} effort.` };
        // Only the effort columns change: chat_provider/chat_model/chat_model_label (the model) stay as they are.
        // A local model override keeps chat_effort and effort together (like the model picker); a subscription model that
        // falls back to local here (web workspace) only changes the local effort, never its subscription effort.
        if (provider === 'local' && row.chat_provider === 'local') db.prepare('UPDATE bots SET chat_effort=?, effort=? WHERE id=?').run(effort, effort, row.id);
        else if (provider === 'local' && row.chat_provider) db.prepare('UPDATE bots SET effort=? WHERE id=?').run(effort, row.id);
        else db.prepare('UPDATE bots SET chat_effort=? WHERE id=?').run(effort, row.id);
      }
      emitBot(row.id);
      const after = effortView(db.prepare('SELECT * FROM bots WHERE id=?').get(row.id));
      return { output: `${row.name} now chats on ${after.chat_effort ?? 'no'} effort (${after.chat_effort_source}). Model unchanged. ${JSON.stringify(after)}`, summary: `Set ${row.name} chat effort to ${after.chat_effort}` };
    }
    case 'set_chat_default_effort': {
      const effort = effortWord(a.effort);
      if (!effort) return { output: badEffort(a.effort) };
      if (a.provider !== undefined && !chatProviders.includes(a.provider)) return { output: `Provider must be one of ${chatProviders.join(', ')}.` };
      const provider: ChatProvider = a.provider ?? applicableProvider(userId);
      if (effort !== 'default' && !CHAT_EFFORTS[provider].includes(effort)) return { output: `${provider} chats support ${CHAT_EFFORTS[provider].join(', ')} effort.` };
      saveChatEffortDefault(userId, provider, effort === 'default' ? null : effort);
      hub.emit(userId, { type: 'model-settings' });
      hub.emit(userId, { type: 'roster' });
      const rows = db.prepare('SELECT * FROM bots WHERE user_id=? AND deleted_at IS NULL AND hidden=0 ORDER BY name').all(userId) as any[];
      const affected = rows.map(r => ({ name: r.name, ...effortView(r) })).filter(v => v.chat_effort_source === 'chat_default');
      return { output: `Chat-only default effort for ${provider} is now ${effort === 'default' ? 'cleared' : effort}. Models, builder/team/Ask defaults unchanged. Bots on this default: ${JSON.stringify(affected)}`,
        summary: `Set ${provider} chat default effort to ${effort}` };
    }
    case 'create_bot': {
      const name = String(a.name ?? '').trim().slice(0, 60);
      if (!name) return { output: 'Give the new bot a name.' };
      const recent = (db.prepare('SELECT COUNT(*) n FROM bots WHERE user_id=? AND created_at>?').get(userId, now() - 3600_000) as any).n;
      if (recent >= 10) return { output: 'Too many bots were created in the last hour. Ask the owner first.' };
      const shape = a.shape === undefined ? undefined : normalizeAvatarShape(a.shape);
      if (a.shape !== undefined && !shape) return { output: `Pick a bot icon: ${AVATAR_SHAPE_IDS.join(', ')}.` };
      const bot = createBotRecord(userId, { name, label: a.job, description: a.description, instructions: a.instructions, avatarColor: color(a.color), avatarShape: shape ?? undefined, avatarGlow: a.glow === true });
      hub.emit(userId, { type: 'roster' });
      return { output: `Created "${bot.name}". It's in the chat list now.`, summary: `Created ${bot.name}` };
    }
    case 'update_bot': {
      const row = findBot(userId, ctx.botId, a.bot);
      if (!row) return { output: `No bot matches "${a.bot}". Use list_bots to see names.` };
      const sets: [string, unknown][] = [];
      if (a.name !== undefined) { const name = String(a.name).trim().slice(0, 60); if (name) sets.push(['name', name]); }
      if (a.job !== undefined) sets.push(['label', String(a.job).trim().slice(0, 80)]);
      if (a.description !== undefined) sets.push(['description', String(a.description).trim().slice(0, 600)]);
      if (a.instructions !== undefined) sets.push(['instructions', String(a.instructions).trim().slice(0, 20_000)]);
      if (a.color !== undefined) sets.push(['avatar_color', color(a.color)]);
      if (a.shape !== undefined) { const shape = normalizeAvatarShape(a.shape); if (!shape) return { output: `Pick a bot icon: ${AVATAR_SHAPE_IDS.join(', ')}.` }; sets.push(['avatar_shape', shape]); }
      if (a.glow !== undefined) sets.push(['avatar_glow', a.glow ? 1 : 0]);
      if (a.stem_color !== undefined) { if (!isStemColor(a.stem_color)) return { output: 'Stem color must be #rrggbb.' }; sets.push(['avatar_stem_color', a.stem_color]); }
      if (a.starred !== undefined) sets.push(['pinned', a.starred ? 1 : 0]);
      if (!sets.length) return { output: 'Say what to change.' };
      db.prepare(`UPDATE bots SET ${sets.map(([col]) => `${col}=?`).join(', ')}, updated_at=? WHERE id=?`).run(...sets.map(([, v]) => v), now(), row.id);
      emitBot(row.id);
      return { output: `Updated ${getBot(row.id)?.name}: ${sets.map(([col]) => col.replace('avatar_', '').replace('label', 'job')).join(', ')}.`, summary: `Updated ${row.name}` };
    }
    case 'delete_bot': {
      const row = findBot(userId, ctx.botId, a.bot);
      if (!row || !a.bot || row.id === ctx.botId) return { output: row?.id === ctx.botId ? 'A bot can\'t delete itself. Ask the owner.' : `No bot matches "${a.bot}".` };
      db.prepare('UPDATE bots SET hidden=1, deleted_at=?, is_primary=0, pinned=0 WHERE id=?').run(now(), row.id);
      archiveDeletedBot(userId, row.id, 'agent_tool');
      hub.emit(userId, { type: 'roster' });
      return { output: `Deleted ${row.name}. The owner can restore it for 30 days (Settings → General → Recently deleted).`, summary: `Deleted ${row.name}` };
    }
    case 'restore_bot': {
      const row = findBot(userId, ctx.botId, a.bot, true);
      if (!row) return { output: `No recently deleted bot matches "${a.bot}".` };
      db.prepare('UPDATE bots SET hidden=0, deleted_at=NULL, updated_at=? WHERE id=?').run(now(), row.id);
      noteRestoredBot(userId, row.id, row.deleted_at);
      hub.emit(userId, { type: 'roster' });
      return { output: `Restored ${row.name}.`, summary: `Restored ${row.name}` };
    }
    case 'set_model': {
      const row = findBot(userId, ctx.botId, a.bot);
      if (!row) return { output: `No bot matches "${a.bot}".` };
      const available = await models(ctx.allowSubscriptionTeam !== false && row.kind !== 'room');
      const model = matchModel(available, String(a.model ?? ''));
      if (!model) return { output: `No model matches "${a.model}". Available: ${available.map(m => m.label).join(', ')}.` };
      // Medium (the chat default) when the model offers it, never a silent High from the catalog's own default.
      const effort = preferredEffort(model.efforts) ?? model.defaultEffort ?? null;
      db.prepare(`UPDATE bots SET chat_provider=?, chat_model=?, chat_model_label=?, chat_effort=?, effort=CASE WHEN ?='local' THEN ? ELSE effort END WHERE id=?`)
        .run(model.provider, model.id, model.label, effort, model.provider, effort ?? 'medium', row.id);
      emitBot(row.id);
      return { output: `${row.name} now chats with ${model.label}.`, summary: `Set ${row.name} to ${model.label}` };
    }
    default:
      return { output: 'Choose an action: list_bots, create_bot, update_bot, delete_bot, restore_bot, set_model, get_chat_effort, set_chat_effort or set_chat_default_effort.' };
  }
}
