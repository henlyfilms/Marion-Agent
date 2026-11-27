// Server-renders the real <Sidebar /> for tests/sidebar-star.mjs, so its DOM checks run even where Chromium cannot.
import { renderToStaticMarkup } from 'react-dom/server';
import type { Bot } from '@shared/types';
import { Sidebar } from '../../web/src/components/Sidebar';
import { useStore } from '../../web/src/store';

// Render what the client would: some app hooks have no server snapshot, and zustand's is its *initial* state, which
// would ignore the seeded store. So every subscription reads the live client snapshot.
type Sync = (subscribe: unknown, get: () => unknown, server?: () => unknown) => unknown;
declare const require: (id: string) => unknown;
const react = require('react') as { useSyncExternalStore: Sync }; // the real exports object, not esbuild's read-only wrapper
const clientSync = react.useSyncExternalStore;
react.useSyncExternalStore = (subscribe, get) => clientSync(subscribe, get, get);

export function render(bots: Bot[], { selected = null, collapsed = false }: { selected?: string | null; collapsed?: boolean } = {}) {
  useStore.setState({ bots, selectedBotId: selected, mobileChatOpen: !!selected, live: {}, sidebarCollapsed: collapsed });
  return renderToStaticMarkup(<Sidebar />);
}
