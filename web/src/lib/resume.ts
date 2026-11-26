import { prefGet, prefSet } from './prefs';

/**
 * Where you were in the app, so an update restart (or a reload after the background server is swapped for a
 * new build, or an accidental quit) reopens on the same place. The selected chat, drafts, theme and layout are
 * already saved on their own; this adds the parts that were not: the open view, the Settings page, a bot's
 * settings tab, and the open chat on a phone-sized window.
 *
 * A snapshot is used only if the app was open a moment ago (a heartbeat keeps it fresh while a window is open),
 * so opening the app the next morning starts on the normal chat view instead of an old Settings page.
 */
export interface ResumeState {
  view: 'chat' | 'tasks' | 'sessions';
  appSettings: string | null;
  botSettings: { botId: string; tab: string } | null;
  mobileChatOpen: boolean;
}

const KEY = 'resume.v1';
const FRESH_MS = 30 * 60_000;
const VIEWS = ['chat', 'tasks', 'sessions'];
const SETTINGS_PAGES = ['home', 'general', 'models', 'audio', 'notifications', 'shortcuts', 'computer', 'permissions', 'apps', 'life', 'account', 'updates'];
const BOT_TABS = ['general', 'skills', 'memories', 'routines', 'theme', 'access'];

/** The saved place, if it is recent and well formed. Anything unexpected is ignored, never trusted. */
export function readResume(now = Date.now()): ResumeState | null {
  try {
    const saved = JSON.parse(prefGet(KEY) ?? 'null');
    if (!saved || typeof saved.at !== 'number' || now - saved.at > FRESH_MS || saved.at > now + 60_000) return null;
    return {
      view: VIEWS.includes(saved.view) ? saved.view : 'chat',
      appSettings: SETTINGS_PAGES.includes(saved.appSettings) ? saved.appSettings : null,
      botSettings: saved.botSettings && typeof saved.botSettings.botId === 'string' && BOT_TABS.includes(saved.botSettings.tab)
        ? { botId: saved.botSettings.botId, tab: saved.botSettings.tab } : null,
      mobileChatOpen: saved.mobileChatOpen === true,
    };
  } catch { return null; }
}

export function saveResume(state: ResumeState, now = Date.now()) {
  prefSet(KEY, JSON.stringify({ ...state, at: now }));
}

/** Save on every change, and every minute while the window is open so the snapshot stays fresh. */
export function trackResume(read: () => ResumeState, subscribe: (listener: () => void) => void) {
  const save = () => saveResume(read());
  subscribe(save);
  window.setInterval(save, 60_000);
  window.addEventListener('pagehide', save);
  save();
}
