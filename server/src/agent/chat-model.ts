import { db } from '../db.js';
import { selectedLocalModel } from './models.js';
import { getChatProvider, subscriptionSelection } from './subscriptions.js';
import { isDesktop } from '../lib/desktop-access.js';
import { localEfforts, type Bot, type ChatModelSelection, type ChatProvider } from '../types.js';

interface ChatSettingsRow {
  user_id: string;
  kind: string;
  effort: Bot['effort'];
  chat_provider: ChatProvider | null;
  chat_model: string | null;
  chat_model_label: string | null;
  chat_effort: string | null;
}

/** Reasoning-effort levels a chat on each provider can be set to (a model that lacks one falls back at run time). */
export const CHAT_EFFORTS: Record<ChatProvider, readonly string[]> = {
  local: localEfforts,
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
  gemini: ['low', 'medium', 'high'],
};

/**
 * Where a chat's effective effort comes from:
 * - bot_override: the bot's own chat effort (set with its chat model, or an effort-only override on an inherited model).
 * - chat_default: the chat-only default for the provider the bot inherits (chat_effort_defaults; never used by builder/team/Ask runs).
 * - provider_default: the provider's shared "Default model & effort" (Settings → Models), or the built-in Medium.
 * - local_bot_effort: the bot's legacy local effort column (local model, no override and no chat-only default).
 */
export type ChatEffortSource = 'bot_override' | 'chat_default' | 'provider_default' | 'local_bot_effort';

export interface ChatEffortInfo {
  selection: ChatModelSelection;
  effort: string | null;
  source: ChatEffortSource;
  /** True when the bot has no model override (it follows the app's chat provider/model). */
  inheritsModel: boolean;
  /** The bot's own chat effort, if any. */
  botOverride: string | null;
  /** The chat-only default for `selection.provider`, if one is saved. */
  chatDefault: string | null;
}

export function chatEffortDefault(userId: string, provider: ChatProvider): string | null {
  const row = db.prepare('SELECT effort FROM chat_effort_defaults WHERE user_id=? AND provider=?').get(userId, provider) as { effort: string } | undefined;
  return row?.effort ?? null;
}

/** Save (or clear with null) the chat-only default effort for one provider. Touches nothing else. */
export function saveChatEffortDefault(userId: string, provider: ChatProvider, effort: string | null) {
  if (effort === null) db.prepare('DELETE FROM chat_effort_defaults WHERE user_id=? AND provider=?').run(userId, provider);
  else db.prepare(`INSERT INTO chat_effort_defaults(user_id,provider,effort) VALUES (?,?,?)
    ON CONFLICT(user_id,provider) DO UPDATE SET effort=excluded.effort`).run(userId, provider, effort);
}

/** The chat provider a bot without a model override inherits (rooms and the web workspace always chat locally). */
export function inheritedChatProvider(bot: Pick<ChatSettingsRow, 'user_id' | 'kind'>): ChatProvider {
  return bot.kind !== 'room' && isDesktop ? getChatProvider(bot.user_id) : 'local';
}

const valid = (provider: ChatProvider, effort: string | null | undefined): effort is string => !!effort && CHAT_EFFORTS[provider].includes(effort);

export function chatEffortForBot(bot: ChatSettingsRow): ChatEffortInfo {
  const { user_id, chat_provider, chat_model, chat_model_label, chat_effort } = bot;
  const desktopChat = bot.kind !== 'room' && isDesktop;
  if (desktopChat && chat_provider && chat_provider !== 'local' && chat_model) {
    return { selection: { provider: chat_provider, model: chat_model, effort: chat_effort, label: chat_model_label ?? undefined },
      effort: chat_effort, source: 'bot_override', inheritsModel: false, botOverride: chat_effort, chatDefault: chatEffortDefault(user_id, chat_provider) };
  }
  const inherits = !chat_provider;
  const provider = inherits ? inheritedChatProvider(bot) : 'local';
  const chatDefault = chatEffortDefault(user_id, provider);
  if (provider !== 'local') {
    const shared = subscriptionSelection(user_id, provider);
    const [effort, source]: [string | null, ChatEffortSource] = valid(provider, chat_effort) ? [chat_effort, 'bot_override']
      : valid(provider, chatDefault) ? [chatDefault, 'chat_default'] : [shared.effort, 'provider_default'];
    return { selection: { ...shared, effort }, effort, source, inheritsModel: true, botOverride: chat_effort, chatDefault };
  }
  const model = chat_provider === 'local' && chat_model ? chat_model : selectedLocalModel(user_id);
  // A local model override keeps its effort in bots.effort (written together with chat_effort).
  const [effort, source]: [string, ChatEffortSource] = chat_provider === 'local' && chat_model ? [bot.effort, 'bot_override']
    : inherits && valid('local', chat_effort) ? [chat_effort, 'bot_override']
    : inherits && valid('local', chatDefault) ? [chatDefault, 'chat_default'] : [bot.effort, 'local_bot_effort'];
  return { selection: { provider: 'local', model, effort }, effort, source, inheritsModel: inherits, botOverride: chat_provider === 'local' ? bot.effort : chat_effort, chatDefault };
}

export function chatModelForBot(bot: ChatSettingsRow): ChatModelSelection {
  return chatEffortForBot(bot).selection;
}
