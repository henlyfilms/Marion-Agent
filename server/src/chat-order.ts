import type { Bot, ChatSort } from './types.js';

const nameFor = (bot: Bot) => bot.label ? `${bot.name} · ${bot.label}` : bot.name;
const activity = (bot: Bot) => Math.max(bot.lastActivityAt, bot.completedAt ?? 0);
/** 0 executive, 1 primary, 2 starred, 3 the rest. */
export const tier = (bot: Bot) => bot.role === 'executive' ? 0 : bot.isPrimary ? 1 : bot.pinned ? 2 : 3;
const names = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function orderChats(bots: Bot[], sort: ChatSort, starredFirst = true) {
  return [...bots].sort((a, b) => {
    // Executive Bots, then the primary Bot, sit above every other chat (owner, Nov 25), then starred chats.
    if (starredFirst && tier(a) !== tier(b)) return tier(a) - tier(b);
    const order = sort === 'custom' ? (a.sortPosition ?? Infinity) - (b.sortPosition ?? Infinity)
      : sort === 'name' ? names.compare(nameFor(a), nameFor(b)) : activity(b) - activity(a);
    return order || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
  });
}
