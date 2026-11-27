// Server-renders the real Tasks → Waiting on You section and the Tasks/Sessions badges for tests/waiting-on-you.mjs.
import { renderToStaticMarkup } from 'react-dom/server';
import type { Bot, WaitingItem } from '@shared/types';
import { TasksIsland, WaitingBadge, WaitingSection, seedWaiting } from '../../web/src/components/config/TasksView';
import { useConfigUI } from '../../web/src/configStore';

type Sync = (subscribe: unknown, get: () => unknown, server?: () => unknown) => unknown;
declare const require: (id: string) => unknown;
const react = require('react') as { useSyncExternalStore: Sync };
const clientSync = react.useSyncExternalStore;
react.useSyncExternalStore = (subscribe, get) => clientSync(subscribe, get, get);

export const badge = (count: number) => renderToStaticMarkup(<WaitingBadge count={count} />);
export function island(items: WaitingItem[] | null) { seedWaiting(items); return renderToStaticMarkup(<TasksIsland />); }
export const section = (items: WaitingItem[] | null, bots: Bot[] = []) =>
  renderToStaticMarkup(<WaitingSection items={items} byId={new Map(bots.map(b => [b.id, b]))} />);
export const waitingVersion = () => useConfigUI.getState().versions.waiting ?? 0;
