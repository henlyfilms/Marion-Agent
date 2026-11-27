import { useSyncExternalStore } from 'react';
import { api } from './api';
import { createOutbox, type QueuedPrompt } from './outbox';

export { isOfflineError, newClientId } from './outbox';

const browserStorage = (() => {
  try { const s = window.localStorage; s.getItem('x'); return s; } catch { /* private mode: keep it for this page only */ }
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); },
    get length() { return map.size; }, key: (i: number) => [...map.keys()][i] ?? null,
  };
})();

/** Marion's health check answers: the server is back (sends that still fail get retried on the next round). */
const reachable = async () => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch('/api/health', { cache: 'no-store', signal: controller.signal });
    return res.ok;
  } catch { return false; } finally { window.clearTimeout(timer); }
};

export const outbox = createOutbox({
  storage: browserStorage,
  send: (item: QueuedPrompt) => api.send(item.botId, item.text, [], { ...(item.replyTo !== undefined ? { replyTo: item.replyTo } : {}), clientId: item.id }),
  reachable,
  online: () => navigator.onLine !== false,
});

let online = navigator.onLine !== false;
const onlineListeners = new Set<() => void>();
const setOnline = (value: boolean) => { if (online !== value) { online = value; onlineListeners.forEach(fn => fn()); } };
const flush = () => { void outbox.flush(); };
window.addEventListener('online', () => { setOnline(true); flush(); });
window.addEventListener('offline', () => setOnline(false));
window.addEventListener('focus', flush);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flush(); });
window.addEventListener('storage', event => { if (!event.key || event.key.startsWith('marion.outbox.')) outbox.notify(); });
// The server can come back while the browser never went "offline" (Mac asleep, Marion restarting): keep checking
// while something is waiting. flush() returns at once when nothing is.
window.setInterval(flush, 5000);
flush();

/** Prompts waiting for this chat, oldest first. */
export function useQueuedPrompts(botId: string): QueuedPrompt[] {
  useSyncExternalStore(outbox.subscribe, outbox.version);
  return outbox.list(botId);
}

export function useOnline(): boolean {
  return useSyncExternalStore(fn => { onlineListeners.add(fn); return () => { onlineListeners.delete(fn); }; }, () => online);
}
