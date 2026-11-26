import { create } from 'zustand';
import { featuresApi, type UpdateStatus } from './featuresApi';
import { prefGet } from './prefs';

/** "Check for updates" state shared by the sidebar pill, the workspace menu and Settings. */
interface UpdateUI {
  status: UpdateStatus | null;
  checking: boolean;
  error: string;
  check(): Promise<void>;
  install(): Promise<void>;
  /** Turn Auto-update on or off (saved on the server; on by default). */
  setAuto(on: boolean): Promise<void>;
}

export const BUILD = typeof __MARION_BUILD__ === 'string' ? __MARION_BUILD__ : 'dev';

let poll = 0;
let checking: Promise<void> | undefined;

export const useAppUpdate = create<UpdateUI>((set, get) => ({
  status: null,
  checking: false,
  error: '',
  check: () => checking ??= (async () => {
    // File access off: never look in the source folder on the Desktop, so macOS never asks.
    if (prefGet('fileAccess') === '0') {
      set({ error: '', status: { supported: false, current: BUILD, latest: null, behind: 0, changes: [], dirty: false, install: { state: 'idle', message: '', at: 0 }, reason: 'Turn on File access in Settings → General to check for updates.' } });
      return;
    }
    set({ checking: true, error: '' });
    try { set({ status: await featuresApi.updateStatus(BUILD) }); }
    catch (cause) { set({ status: null, error: (cause as Error).message }); }
    finally { set({ checking: false }); }
  })().finally(() => { checking = undefined; }),
  setAuto: async (on) => {
    const before = get().status;
    set({ error: '', status: before ? { ...before, autoUpdate: on } : before });
    try { await featuresApi.setAutoUpdate(on); }
    catch (cause) { set({ error: (cause as Error).message, status: get().status ? { ...get().status!, autoUpdate: before?.autoUpdate } : null }); }
  },
  install: async () => {
    set({ error: '' });
    try {
      await featuresApi.installUpdate();
      // A check started before the POST can still describe the old state.
      await checking;
      await get().check();
      // Follow the build until the app quits for the install.
      clearInterval(poll);
      poll = window.setInterval(() => {
        const state = get().status?.install.state;
        if (state !== 'building' && state !== 'installing') { clearInterval(poll); return; }
        void get().check();
      }, 4000);
    } catch (cause) {
      await checking;
      await get().check();
      set({ error: (cause as Error).message });
    }
  },
}));

export const updateAvailable = (status: UpdateStatus | null) => Boolean(status?.supported && status.behind > 0);
export const updateBusy = (status: UpdateStatus | null) => status?.install.state === 'building' || status?.install.state === 'installing';
