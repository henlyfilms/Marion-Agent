/**
 * The reconnecting server-event stream, without any app state, so it can be driven by a fake EventSource in tests.
 * EventSource retries on its own, but a server restart can leave it CLOSED, so we also reconnect manually with
 * backoff. Every reconnect (not the first connect) calls `resync`: events sent while we were away are lost.
 */
export interface EventSourceLike {
  readyState: number;
  onopen: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  close(): void;
}

export interface EventStreamDeps {
  connect(): EventSourceLike;
  onEvent(data: unknown): void;
  setConnected(connected: boolean): void;
  resync(): void;
  /** EventSource.CLOSED. */
  closed?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export function createEventStream(deps: EventStreamDeps): () => void {
  const CLOSED = deps.closed ?? 2;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let es: EventSourceLike | null = null;
  let stopped = false;
  let retry = 1000;
  let timer: unknown;
  let everConnected = false;

  const open = () => {
    if (stopped) return;
    const source = deps.connect();
    es = source;
    source.onopen = () => {
      retry = 1000;
      deps.setConnected(true);
      if (everConnected) deps.resync();
      everConnected = true;
    };
    source.onmessage = (m) => {
      let data: unknown;
      try { data = JSON.parse(m.data); } catch (e) { console.warn('bad event', e); return; }
      deps.onEvent(data);
    };
    source.onerror = () => {
      deps.setConnected(false);
      if (source.readyState === CLOSED && es === source) {
        es = null;
        timer = setTimer(open, retry);
        retry = Math.min(retry * 2, 15_000);
      }
    };
  };
  open();
  return () => { stopped = true; clearTimer(timer); es?.close(); };
}

/** Bumped on every reconnect; every Tasks list (all tasks, or one Bot's) depends on it, so none can stay stale. */
export const TASKS_RESYNC_KEY = 'tasks-resync';

/** The version map after a reconnect: the all-tasks list, every per-Bot list already open, and the resync key move on. */
export function invalidateTaskVersions(versions: Record<string, number>): Record<string, number> {
  const next = { ...versions };
  for (const key of new Set(['tasks', TASKS_RESYNC_KEY, ...Object.keys(versions).filter(key => key.startsWith('tasks:'))])) next[key] = (next[key] ?? 0) + 1;
  return next;
}
