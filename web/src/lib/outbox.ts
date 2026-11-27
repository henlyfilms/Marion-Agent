/**
 * Offline prompt queue. A prompt sent while the browser is offline (or the server can't be reached) is kept in
 * storage under its chat, in order, and sent as soon as Marion is reachable again. Every prompt carries a client id
 * the server dedupes on, so a retry (after a lost response, another tab, a reload mid-send) never posts it twice.
 * No DOM or React here: `createOutbox` takes its storage, transport and reachability check, so tests run it in Node.
 */

export interface QueuedPrompt {
  /** Client id: also the server's dedup key. */
  id: string;
  botId: string;
  text: string;
  replyTo?: number;
  queuedAt: number;
  /** The server refused it (not a connection problem); kept so the user can see it and remove it. */
  error?: string;
}

export interface OutboxStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

export interface OutboxDeps {
  storage: OutboxStorage;
  send: (item: QueuedPrompt) => Promise<unknown>;
  /** Server answers (any HTTP response counts). */
  reachable: () => Promise<boolean>;
  /** navigator.onLine; a false here skips the network entirely. */
  online?: () => boolean;
  now?: () => number;
}

export const OUTBOX_PREFIX = 'marion.outbox.';
const keyFor = (botId: string) => OUTBOX_PREFIX + botId;

/** A failure that means "not reachable right now" (worth queueing and retrying), rather than "the server said no". */
export function isOfflineError(error: unknown): boolean {
  if (error instanceof TypeError) return true; // fetch: network down, DNS, connection refused
  if (error && typeof error === 'object' && 'name' in error && (error as { name?: string }).name === 'AbortError') return false;
  const status = (error as { status?: unknown } | null)?.status;
  return status === 0 || status === 502 || status === 503 || status === 504;
}

export const newClientId = () => {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
};

export function createOutbox(deps: OutboxDeps) {
  const now = deps.now ?? Date.now;
  const online = deps.online ?? (() => true);
  const listeners = new Set<() => void>();
  let flushing: Promise<void> | null = null;
  /** Bumped on every change so React can compare snapshots cheaply. */
  let version = 0;
  const sending = new Set<string>();

  const read = (botId: string): QueuedPrompt[] => {
    try {
      const raw = deps.storage.getItem(keyFor(botId));
      const list = raw ? JSON.parse(raw) as unknown : [];
      return Array.isArray(list) ? list.filter((item): item is QueuedPrompt =>
        !!item && typeof item.id === 'string' && typeof item.text === 'string') : [];
    } catch { return []; }
  };
  const write = (botId: string, list: QueuedPrompt[]) => {
    try {
      if (list.length) deps.storage.setItem(keyFor(botId), JSON.stringify(list));
      else deps.storage.removeItem(keyFor(botId));
    } catch { /* storage full or blocked: the in-flight send still happens */ }
    changed();
  };
  const changed = () => { version++; listeners.forEach(fn => fn()); };

  const bots = (): string[] => {
    const out: string[] = [];
    for (let i = 0; i < deps.storage.length; i++) {
      const key = deps.storage.key(i);
      if (key?.startsWith(OUTBOX_PREFIX)) out.push(key.slice(OUTBOX_PREFIX.length));
    }
    return out;
  };

  const outbox = {
    list: read,
    /** Prompts still waiting to go (refused ones excluded). */
    pending: (botId: string) => read(botId).some(item => !item.error),
    isSending: (id: string) => sending.has(id),
    version: () => version,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    /** Another tab changed storage. */
    notify: changed,

    enqueue(botId: string, text: string, extra: { replyTo?: number; id?: string } = {}): QueuedPrompt {
      const item: QueuedPrompt = { id: extra.id ?? newClientId(), botId, text, queuedAt: now(), ...(extra.replyTo !== undefined ? { replyTo: extra.replyTo } : {}) };
      const list = read(botId);
      if (!list.some(existing => existing.id === item.id)) write(botId, [...list, item]);
      return item;
    },

    remove(botId: string, id: string) {
      const list = read(botId);
      const next = list.filter(item => item.id !== id);
      if (next.length !== list.length) write(botId, next);
    },

    /** Try a refused prompt again (it keeps its place and its id). */
    retry(botId: string, id: string) {
      write(botId, read(botId).map(item => item.id === id ? { id: item.id, botId: item.botId, text: item.text, queuedAt: item.queuedAt, ...(item.replyTo !== undefined ? { replyTo: item.replyTo } : {}) } : item));
      return outbox.flush();
    },

    /** Send every waiting prompt, oldest first per chat; stops at the first connection failure. */
    flush(): Promise<void> {
      if (flushing) return flushing;
      flushing = (async () => {
        if (!online()) return;
        if (!bots().some(id => read(id).some(item => !item.error))) return;
        if (!await deps.reachable().catch(() => false)) return;
        for (const botId of bots()) {
          for (;;) {
            // Re-read each time: the user may have removed it, or another tab sent it, while the last one was going.
            const item = read(botId).find(entry => !entry.error);
            if (!item) break;
            sending.add(item.id); changed();
            try {
              await deps.send(item);
              outbox.remove(botId, item.id);
            } catch (error) {
              if (isOfflineError(error)) return;
              const message = error instanceof Error && error.message ? error.message : 'Message failed to send';
              write(botId, read(botId).map(entry => entry.id === item.id ? { ...entry, error: message } : entry));
            } finally {
              sending.delete(item.id); changed();
            }
          }
        }
      })().finally(() => { flushing = null; });
      return flushing;
    },
  };
  return outbox;
}

export type Outbox = ReturnType<typeof createOutbox>;
