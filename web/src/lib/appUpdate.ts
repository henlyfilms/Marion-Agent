import { create } from 'zustand';
import { featuresApi, type UpdateStatus } from './featuresApi';

/** "Check for updates" state shared by the sidebar pill, the workspace menu and Settings. */
interface UpdateUI {
  status: UpdateStatus | null;
  checking: boolean;
  error: string;
  check(): Promise<void>;
  install(): Promise<void>;
}

export const BUILD = typeof __MARION_BUILD__ === 'string' ? __MARION_BUILD__ : 'dev';

let poll = 0;

export const useAppUpdate = create<UpdateUI>((set, get) => ({
  status: null,
  checking: false,
  error: '',
  check: async () => {
    if (get().checking) return;
    set({ checking: true, error: '' });
    try { set({ status: await featuresApi.updateStatus(BUILD) }); }
    catch (cause) { set({ error: (cause as Error).message }); }
    finally { set({ checking: false }); }
  },
  install: async () => {
    set({ error: '' });
    try {
      await featuresApi.installUpdate();
      await get().check();
      // Follow the build until the app quits for the install.
      clearInterval(poll);
      poll = window.setInterval(() => {
        const state = get().status?.install.state;
        if (state !== 'building' && state !== 'installing') { clearInterval(poll); return; }
        void get().check();
      }, 4000);
    } catch (cause) { set({ error: (cause as Error).message }); }
  },
}));

export const updateAvailable = (status: UpdateStatus | null) => Boolean(status?.supported && status.behind > 0);
export const updateBusy = (status: UpdateStatus | null) => status?.install.state === 'building' || status?.install.state === 'installing';
