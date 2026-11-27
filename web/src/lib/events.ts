import type { ServerEvent } from '@shared/types';
import { useStore } from '../store';
import { useConfigUI } from '../configStore';
import { createEventStream } from './eventStream';

/** What has to be reloaded after the event stream reconnects: anything could have changed while it was down. */
export function resyncAfterReconnect() {
  const st = useStore.getState();
  st.set({ modelSettingsVersion: st.modelSettingsVersion + 1 });
  st.loadBots().catch(() => {});
  st.loadComputer().catch(() => {});
  if (st.selectedBotId) { st.loadRows(st.selectedBotId).catch(() => {}); st.loadRoutines(st.selectedBotId).catch(() => {}); }
  // Task events sent while we were away are lost: every open Tasks list refetches.
  useConfigUI.getState().invalidateTasks();
}

/** One EventSource for the whole app, reconnecting with backoff and resyncing on reconnect (see eventStream). */
export function startEvents(): () => void {
  return createEventStream({
    connect: () => new EventSource('/api/events', { withCredentials: true }),
    closed: EventSource.CLOSED,
    onEvent: (data) => {
      try { useStore.getState().handleEvent(data as ServerEvent); } catch (e) { console.warn('bad event', e); }
    },
    setConnected: (sseConnected) => useStore.getState().set({ sseConnected }),
    resync: resyncAfterReconnect,
  });
}
