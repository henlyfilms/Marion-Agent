const nameFor = (bot) => bot.label ? `${bot.name} · ${bot.label}` : bot.name;
const activity = (bot) => Math.max(bot.lastActivityAt, bot.completedAt ?? 0);
const names = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export function orderChats(bots, sort, starredFirst = true) {
    return [...bots].sort((a, b) => {
        if (starredFirst && a.pinned !== b.pinned)
            return Number(b.pinned) - Number(a.pinned);
        const order = sort === 'custom' ? (a.sortPosition ?? Infinity) - (b.sortPosition ?? Infinity)
            : sort === 'name' ? names.compare(nameFor(a), nameFor(b)) : activity(b) - activity(a);
        return order || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
    });
}
//# sourceMappingURL=chat-order.js.map