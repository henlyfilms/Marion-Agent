/** Per-user fan-out of server events to connected SSE clients. */
class Hub {
    listeners = new Map();
    subscribe(userId, fn) {
        let set = this.listeners.get(userId);
        if (!set)
            this.listeners.set(userId, (set = new Set()));
        set.add(fn);
        return () => {
            set.delete(fn);
            if (set.size === 0)
                this.listeners.delete(userId);
        };
    }
    emit(userId, ev) {
        const set = this.listeners.get(userId);
        if (!set)
            return;
        for (const fn of set) {
            try {
                fn(ev);
            }
            catch { /* ignore broken listener */ }
        }
    }
    isOnline(userId) {
        return (this.listeners.get(userId)?.size ?? 0) > 0;
    }
}
export const hub = new Hub();
//# sourceMappingURL=hub.js.map