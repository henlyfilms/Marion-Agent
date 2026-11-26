import { create } from 'zustand';
import { prefGet, prefSet } from './lib/prefs';
import { readResume } from './lib/resume';
import type { Bot, ChatModelSelection, ChatSort, ComputerState, LiveState, Routine, Row, ServerEvent, User } from '@shared/types';
import { api } from './lib/api';
import { configApi } from './lib/configApi';

import { showNotification } from './lib/notifications';

/** The chat on screen right now, if any (not the Tasks or Sessions view, not the phone's chat list). */
function viewingBotId() {
  const s = useStore.getState();
  if (document.querySelector('.tasks-view, .sessions-view')) return null;
  if (window.matchMedia('(max-width: 700px)').matches && !s.mobileChatOpen) return null;
  return s.selectedBotId;
}

export type ModalKind = 'create' | 'search' | 'apps' | 'usage' | 'stats' | 'group' | 'team' | 'screenshots' | null;

interface Transcript { generation: number; bySeq: Record<number, Row>; loaded: boolean }

interface State {
  user: User | null;
  devLogin: boolean;
  googleLogin: boolean;
  authChecked: boolean;
  localWorkspace: boolean;
  mobileLogin: boolean;
  mobilePaired: boolean;
  authError: boolean;

  bots: Bot[];
  chatSort: ChatSort;
  savingChatModels: Partial<Record<string, boolean>>;
  live: Record<string, LiveState>;
  selectedBotId: string | null;
  transcripts: Record<string, Transcript>;
  routines: Record<string, Routine[]>;
  computer: ComputerState | null;
  /** Bumped on every `connections` event so open views can refetch. */
  connectionsVersion: number;
  modelSettingsVersion: number;
  sseConnected: boolean;

  detailsOpen: boolean;
  sidebarCollapsed: boolean;
  mobileChatOpen: boolean;
  mobileDetailsOpen: boolean;
  modal: ModalKind;
  viewerOpen: boolean;
  localVoiceBotId: string | null;

  checkAuth(): Promise<void>;
  loadBots(): Promise<void>;
  saveChatModel(id: string, selection: ChatModelSelection): Promise<void>;
  selectBot(id: string): void;
  loadRows(id: string): Promise<void>;
  loadRoutines(id: string): Promise<void>;
  loadComputer(): Promise<void>;
  upsertRows(botId: string, generation: number, rows: Row[]): void;
  handleEvent(ev: ServerEvent): void;
  setModal(m: ModalKind): void;
  set(p: Partial<State>): void;
}

const LS_SELECTED = 'selectedBot';
const LS_DETAILS = 'detailsOpen';
const LS_SIDEBAR = 'sidebarCollapsed';
const lsGet = prefGet;
const lsSet = prefSet;

export const useStore = create<State>((set, get) => ({
  user: null,
  devLogin: false,
  googleLogin: false,
  authChecked: false,
  localWorkspace: false,
  mobileLogin: false,
  mobilePaired: false,
  authError: false,
  bots: [],
  chatSort: 'recent',
  savingChatModels: {},
  live: {},
  selectedBotId: lsGet(LS_SELECTED),
  transcripts: {},
  routines: {},
  computer: null,
  connectionsVersion: 0,
  modelSettingsVersion: 0,
  sseConnected: false,
  detailsOpen: lsGet(LS_DETAILS) !== '0',
  sidebarCollapsed: lsGet(LS_SIDEBAR) === '1',
  mobileChatOpen: readResume()?.mobileChatOpen ?? false,
  mobileDetailsOpen: false,
  modal: null,
  viewerOpen: false,
  localVoiceBotId: null,

  async checkAuth() {
    try {
      const { user, devLogin, googleLogin, localWorkspace, mobileLogin } = await api.me();
      set({ user, devLogin, googleLogin, localWorkspace, mobileLogin: !!mobileLogin, mobilePaired: !!user && !!mobileLogin, authChecked: true, authError: false });
    } catch {
      set({ user: null, authChecked: true, authError: true });
    }
  },

  async loadBots() {
    const { bots, live, chatSort } = await api.bots();
    const liveMap: Record<string, LiveState> = {};
    for (const l of live) liveMap[l.botId] = l;
    const sel = get().selectedBotId;
    const selectedBotId = sel && bots.some((b) => b.id === sel) ? sel : (bots.find((b) => b.isPrimary) ?? bots[0])?.id ?? null;
    set({ bots, live: liveMap, chatSort, ...(selectedBotId ? {} : { selectedBotId: null, mobileChatOpen: false }) });
    if (selectedBotId !== get().selectedBotId || !get().transcripts[selectedBotId ?? '']) {
      if (selectedBotId) get().selectBot(selectedBotId);
      if (sel && !bots.some(bot => bot.id === sel)) set({ mobileChatOpen: false, mobileDetailsOpen: false, localVoiceBotId: null, viewerOpen: false });
    }
  },

  async saveChatModel(id, selection) {
    if (get().savingChatModels[id]) return;
    set(s => ({ savingChatModels: { ...s.savingChatModels, [id]: true } }));
    try {
      const { bot } = await configApi.selectChatModel(id, selection);
      set(s => ({ bots: s.bots.map(b => b.id === id ? { ...b, chatModel: bot.chatModel, effort: bot.effort } : b) }));
    } finally {
      set(s => {
        const savingChatModels = { ...s.savingChatModels };
        delete savingChatModels[id];
        return { savingChatModels };
      });
    }
  },

  selectBot(id) {
    set({ selectedBotId: id });
    lsSet(LS_SELECTED, id);
    const t = get().transcripts[id];
    if (!t?.loaded) get().loadRows(id).catch(console.error);
    get().loadRoutines(id).catch(console.error);
    const bot = get().bots.find((b) => b.id === id);
    if (bot?.unread) api.markRead(id).catch(() => {});
  },

  async loadRows(id) {
    const { generation, rows } = await api.rows(id);
    const bySeq: Record<number, Row> = {};
    for (const r of rows) bySeq[r.seq] = r;
    // Merge with anything that streamed in while we were fetching.
    const prev = get().transcripts[id];
    if (prev && prev.generation === generation) {
      for (const r of Object.values(prev.bySeq)) if (!bySeq[r.seq] || bySeq[r.seq].updatedSeq < r.updatedSeq) bySeq[r.seq] = r;
    }
    set((s) => ({ transcripts: { ...s.transcripts, [id]: { generation, bySeq, loaded: true } } }));
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('fixtures')) {
      import('./dev/fixtures').then((m) => m.injectFixtures());
    }
  },

  async loadRoutines(id) {
    const { routines } = await api.routines(id);
    set((s) => ({ routines: { ...s.routines, [id]: routines } }));
  },

  async loadComputer() {
    const { computer } = await api.computer();
    set({ computer });
  },

  upsertRows(botId, generation, rows) {
    set((s) => {
      const prev = s.transcripts[botId];
      if (prev && generation < prev.generation) return {};
      const base: Transcript = !prev || generation > prev.generation ? { generation, bySeq: {}, loaded: prev?.loaded ?? false } : prev;
      const bySeq = { ...base.bySeq };
      for (const r of rows) {
        const cur = bySeq[r.seq];
        if (!cur || r.updatedSeq >= cur.updatedSeq) bySeq[r.seq] = r;
      }
      return { transcripts: { ...s.transcripts, [botId]: { ...base, generation, bySeq } } };
    });
  },

  handleEvent(ev) {
    const s = get();
    switch (ev.type) {
      case 'hello':
      case 'ping':
        return;
      case 'rows':
        s.upsertRows(ev.botId, ev.generation, ev.rows);
        return;
      case 'cleared':
        set((st) => ({ transcripts: { ...st.transcripts, [ev.botId]: { generation: ev.generation, bySeq: {}, loaded: true } } }));
        // A new conversation is a new chat session: Sessions views reload (see configStore.ts).
        window.dispatchEvent(new CustomEvent('marion-agent:event', { detail: ev }));
        return;
      case 'live':
        set((st) => ({ live: { ...st.live, [ev.state.botId]: ev.state } }));
        return;
      case 'roster':
        s.loadBots().catch(console.error);
        return;
      case 'chat-order':
        set(st => ({
          chatSort: ev.chatSort,
          bots: Object.keys(ev.positions).length
            ? st.bots.map(bot => ev.positions[bot.id] === undefined ? bot : { ...bot, sortPosition: ev.positions[bot.id] })
            : st.bots,
        }));
        return;
      case 'bot': {
        const previous = s.bots.find(b => b.id === ev.bot.id);
        // Opening a bot marks it read; keep the open bot at 0 unread.
        if (ev.bot.id === s.selectedBotId && ev.bot.unread > 0 && document.visibilityState === 'visible') api.markRead(ev.bot.id).catch(() => {});
        set((st) => ({ bots: previous ? st.bots.map((b) => (b.id === ev.bot.id ? ev.bot : b)) : [...st.bots, ev.bot] }));
        if (previous && ev.bot.completedAt && ev.bot.completedAt > (previous.completedAt ?? 0)
          && Date.now() - ev.bot.completedAt < 6000) {
          showNotification({
            id: `done:${ev.bot.id}:${ev.bot.completedAt}`, kind: 'finished', botId: ev.bot.id, botName: ev.bot.name,
            status: 'Finished', title: `${ev.bot.name} finished`, body: ev.bot.lastPreview ?? '', at: ev.bot.completedAt,
          }, viewingBotId());
        }
        return;
      }
      case 'computer':
        set({ computer: ev.state });
        return;
      case 'routines':
        if (s.routines[ev.botId] || ev.botId === s.selectedBotId) s.loadRoutines(ev.botId).catch(console.error);
        return;
      case 'tasks':
      case 'sessions':
      case 'memories':
        // Picked up by configStore.ts (Tasks view, Library/Tasks tabs, bot settings).
        window.dispatchEvent(new CustomEvent('marion-agent:event', { detail: ev }));
        return;
      case 'connections':
        set((st) => ({ connectionsVersion: st.connectionsVersion + 1 }));
        return;
      case 'notify':
        showNotification(ev.notification, viewingBotId());
        return;
      case 'model-settings':
        set((st) => ({ modelSettingsVersion: st.modelSettingsVersion + 1 }));
        s.loadBots().catch(console.error);
        return;
    }
  },

  setModal(modal) { set({ modal }); },

  set(p) {
    if (p.detailsOpen !== undefined) lsSet(LS_DETAILS, p.detailsOpen ? '1' : '0');
    if (p.sidebarCollapsed !== undefined) lsSet(LS_SIDEBAR, p.sidebarCollapsed ? '1' : '0');
    set(p);
  },
}));

/** Rows for a bot, ordered by seq. */
export function sortedRows(t: Transcript | undefined): Row[] {
  if (!t) return [];
  return Object.values(t.bySeq).sort((a, b) => a.seq - b.seq);
}

export const displayName = (b: Pick<Bot, 'name' | 'label'>) => (b.label ? `${b.name} · ${b.label}` : b.name);

export function useSelectedBot(): Bot | undefined {
  return useStore((s) => s.bots.find((b) => b.id === s.selectedBotId));
}
