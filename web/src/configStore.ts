import { create } from 'zustand';
import { prefGet, prefSet } from './lib/prefs';
import { readCustomTheme, readTheme, saveCustomTheme, THEME_PREF, themeColors, themeStyle, type CustomTheme, type Theme } from './lib/themes';
import type { ServerEvent } from '@shared/types';
import { useStore } from './store';
import { readResume, trackResume } from './lib/resume';

/** UI state for bot settings, app settings, the Tasks view and the theme. Kept apart from store.ts on purpose. */

export type BotSettingsTab = 'general' | 'skills' | 'memories' | 'routines' | 'theme' | 'access';
export type AppSection = 'general' | 'models' | 'audio' | 'notifications' | 'shortcuts' | 'computer' | 'permissions' | 'apps' | 'life' | 'account' | 'updates';
/** 'home' is the grouped list on a phone; on a wider window it shows General next to that list. */
export type AppSettingsPage = AppSection | 'home';

interface ConfigUI {
  botSettings: { botId: string; tab: BotSettingsTab } | null;
  appSettings: AppSettingsPage | null;
  view: 'chat' | 'tasks' | 'sessions';
  theme: Theme;
  customTheme: CustomTheme;
  setCustomTheme(theme: CustomTheme): void;
  /** Show "in · out tokens" under each reply. */
  showTokenStats: boolean;
  setShowTokenStats(on: boolean): void;
  /** Let the app look in your folders (the source folder on the Desktop for updates). Off = macOS never asks. */
  fileAccess: boolean;
  setFileAccess(on: boolean): void;
  /** Bumped by server events (tasks, memories) so open views refetch. Keys: 'tasks', 'memories:<botId>'. */
  versions: Record<string, number>;
  openBotSettings(botId: string, tab?: BotSettingsTab): void;
  closeBotSettings(): void;
  openAppSettings(section?: AppSettingsPage): void;
  closeAppSettings(): void;
  setView(v: 'chat' | 'tasks' | 'sessions'): void;
  setTheme(t: Theme): void;
  bump(key: string): void;
}

const darkQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function applyTheme(t: Theme) {
  const resolved = t === 'system' ? (darkQuery?.matches ? 'dark' : 'light') : t;
  const root = document.documentElement;
  const { scheme, background } = themeColors(resolved);
  root.dataset.theme = resolved;
  root.dataset.colorScheme = scheme;
  for (const [name, value] of Object.entries(themeStyle(resolved))) {
    if (value) root.style.setProperty(name, value); else root.style.removeProperty(name);
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background);
}

// After an update restart or reload, reopen on the view and settings page that were open.
const resumed = readResume();

export const useConfigUI = create<ConfigUI>((set, get) => ({
  botSettings: resumed?.botSettings ? { botId: resumed.botSettings.botId, tab: resumed.botSettings.tab as BotSettingsTab } : null,
  appSettings: (resumed?.appSettings as AppSettingsPage | null | undefined) ?? null,
  view: resumed?.view ?? 'chat',
  theme: readTheme(),
  customTheme: readCustomTheme(),
  setCustomTheme: (customTheme) => {
    saveCustomTheme(customTheme);
    set({ customTheme });
    if (get().theme === 'custom') applyTheme('custom');
  },
  showTokenStats: prefGet('showTokenStats') !== '0',
  setShowTokenStats: (on) => { prefSet('showTokenStats', on ? '1' : '0'); set({ showTokenStats: on }); },
  fileAccess: prefGet('fileAccess') !== '0',
  setFileAccess: (on) => { prefSet('fileAccess', on ? '1' : '0'); set({ fileAccess: on }); },
  versions: {},
  openBotSettings: (botId, tab = 'general') => set({ botSettings: { botId, tab } }),
  closeBotSettings: () => set({ botSettings: null }),
  openAppSettings: (section = 'home') => set({ appSettings: section }),
  closeAppSettings: () => set({ appSettings: null }),
  setView: (view) => set({ view }),
  setTheme: (theme) => {
    prefSet(THEME_PREF, theme);
    applyTheme(theme);
    set({ theme });
  },
  bump: (key) => set({ versions: { ...get().versions, [key]: (get().versions[key] ?? 0) + 1 } }),
}));

// Apply the saved theme as early as possible, and follow the OS while on "system".
applyTheme(readTheme());
darkQuery?.addEventListener?.('change', () => { if (useConfigUI.getState().theme === 'system') applyTheme('system'); });

// store.ts forwards events it doesn't handle itself as a DOM event.
window.addEventListener('marion-agent:event', (e) => {
  const ev = (e as CustomEvent<ServerEvent>).detail;
  const { bump } = useConfigUI.getState();
  if (ev.type === 'tasks') { bump('tasks'); bump(`tasks:${ev.botId}`); }
  if (ev.type === 'memories') bump(`memories:${ev.botId}`);
  // A relayed agent started, finished or rotated, or a bot began a new conversation: Sessions views reload.
  if (ev.type === 'sessions' || ev.type === 'cleared') bump('sessions');
});

// Picking a bot anywhere (sidebar, search) goes back to its chat.
useStore.subscribe((s, prev) => {
  if (s.selectedBotId !== prev.selectedBotId && useConfigUI.getState().view !== 'chat') useConfigUI.getState().setView('chat');
});

trackResume(
  () => {
    const ui = useConfigUI.getState();
    return { view: ui.view, appSettings: ui.appSettings, botSettings: ui.botSettings, mobileChatOpen: useStore.getState().mobileChatOpen };
  },
  listener => { useConfigUI.subscribe(listener); useStore.subscribe((s, prev) => { if (s.mobileChatOpen !== prev.mobileChatOpen) listener(); }); },
);

export const useVersion =(key: string) => useConfigUI((s) => s.versions[key] ?? 0);
