import { useEffect } from 'react';
import { useConfigUI } from '../configStore';
import { useStore } from '../store';
import { useMessageActions } from './messageActions';
import { closeChatSearch, openChatSearch, useChatSearch } from './chatSearchStore';

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
/** Shown in tooltips: ⌘F on a Mac, Ctrl+F elsewhere. */
export const searchShortcutLabel = isMac ? '⌘F' : 'Ctrl+F';

/** The chat is on screen and nothing (a dialog, settings, the picker) sits on top of it. */
function chatIsVisible() {
  const st = useStore.getState();
  const ui = useConfigUI.getState();
  const phone = window.matchMedia('(max-width: 700px)').matches;
  return Boolean(st.selectedBotId) && ui.view === 'chat' && !ui.appSettings && !ui.botSettings && !st.modal && !st.viewerOpen
    && !useMessageActions.getState().forward && (!phone || st.mobileChatOpen);
}

/**
 * Cmd+F (Mac) / Ctrl+F (Windows, Linux) opens the search bar instead of the browser's own find bar, and pressing it
 * again re-focuses and selects the text. While the bar is open: Cmd/Ctrl+G or F3 for the next match, with Shift
 * for the previous one, and Escape to close.
 */
export function useChatSearchShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && !e.altKey && !e.shiftKey && key === 'f') {
        if (!chatIsVisible()) return;
        e.preventDefault();
        openChatSearch();
        return;
      }
      const search = useChatSearch.getState();
      if (!search.open || !chatIsVisible()) return;
      if ((mod && !e.altKey && key === 'g') || (e.key === 'F3' && !e.altKey && !e.ctrlKey && !e.metaKey)) {
        e.preventDefault();
        search.step(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape' && !e.defaultPrevented) {
        // The box handles its own Escape; this covers focus resting on the chat itself.
        const target = e.target instanceof Element ? e.target : null;
        if (!target || target === document.body || target.closest('.transcript-wrap')) { e.preventDefault(); closeChatSearch(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
