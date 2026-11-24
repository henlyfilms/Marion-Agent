import { useSyncExternalStore } from 'react';
import { useStore } from '../store';

const compact = window.matchMedia('(max-width: 700px)');
const subscribe = (listener: () => void) => {
  compact.addEventListener('change', listener);
  return () => compact.removeEventListener('change', listener);
};

export const useCompactLayout = () => useSyncExternalStore(subscribe, () => compact.matches);
export function useDetailsOpen() {
  const narrow = useCompactLayout();
  return useStore(state => narrow ? state.mobileDetailsOpen : state.detailsOpen);
}

export function setDetailsOpen(open: boolean) {
  useStore.getState().set(compact.matches ? { mobileDetailsOpen: open } : { detailsOpen: open });
}

export function showChatList() {
  useStore.setState({ mobileChatOpen: false, mobileDetailsOpen: false });
}
