import { create } from 'zustand';
import { clampIndex, stepIndex } from './chatSearch';

/** State of the in-chat search bar. The bar, the shortcuts and the transcript (which paints the matches) share it. */
interface ChatSearchState {
  open: boolean;
  query: string;
  /** Index of the current match; `count` is how many the transcript found. */
  active: number;
  count: number;
  /** Bumped every time the box should take focus and select its text (open, or Cmd/Ctrl+F while already open). */
  focusTick: number;
  /** Bumped when the user steps to another match, so the transcript scrolls to it. */
  navTick: number;
  show(): void;
  hide(): void;
  setQuery(query: string): void;
  step(dir: 1 | -1): void;
  setResult(count: number, active: number): void;
  reset(): void;
}

export const useChatSearch = create<ChatSearchState>((set, get) => ({
  open: false,
  query: '',
  active: 0,
  count: 0,
  focusTick: 0,
  navTick: 0,
  show: () => set(s => ({ open: true, focusTick: s.focusTick + 1 })),
  hide: () => set({ open: false }),
  setQuery: query => set({ query, active: 0 }),
  step: dir => {
    const { count, active } = get();
    if (count > 0) set(s => ({ active: stepIndex(active, count, dir), navTick: s.navTick + 1 }));
  },
  setResult: (count, active) => {
    const s = get();
    const next = clampIndex(active, count);
    if (s.count !== count || s.active !== next) set({ count, active: next });
  },
  reset: () => set({ open: false, query: '', active: 0, count: 0 }),
}));

let returnFocus: HTMLElement | null = null;

/** Opens the bar (or re-focuses it when already open), remembering where focus was so Escape can give it back. */
export function openChatSearch() {
  const state = useChatSearch.getState();
  const el = typeof document === 'undefined' ? null : document.activeElement;
  if (!state.open && el instanceof HTMLElement && el !== document.body && !el.closest('.chat-search')) returnFocus = el;
  else if (!state.open) returnFocus = null;
  state.show();
}

/** Closes the bar and puts focus back where it was (or in the message box), so typing carries on without a click. */
export function closeChatSearch() {
  const state = useChatSearch.getState();
  if (!state.open) return;
  state.hide();
  const target = returnFocus?.isConnected ? returnFocus : document.querySelector<HTMLElement>('.composer__input');
  returnFocus = null;
  target?.focus({ preventScroll: true });
}
