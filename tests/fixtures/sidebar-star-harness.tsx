// Mounts the real <Sidebar /> with a seeded store so tests/sidebar-star.mjs can measure it in Chromium.
// Bundled on the fly by that test (esbuild); never part of the app build.
import { createRoot } from 'react-dom/client';
import type { Bot } from '@shared/types';
import { Sidebar } from '../../web/src/components/Sidebar';
import { useStore } from '../../web/src/store';

const base = {
  label: '', description: '', instructions: '', avatarStemColor: null, mode: 'personal', isPrimary: false, kind: 'agent',
  effort: 'medium', voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto', generation: 0, createdAt: 0, sortPosition: null,
} as const;
const now = Date.now();
const bots = (window as unknown as { __BOTS__: Partial<Bot>[] }).__BOTS__
  .map((bot, i) => ({ ...base, avatarShape: 'berry', avatarColor: 'purple', unread: 0, lastPreview: 'Hello there', lastActivityAt: now - i * 60_000, ...bot }) as Bot);
const selected = (window as unknown as { __SELECTED__?: string }).__SELECTED__ ?? null;
useStore.setState({ bots, selectedBotId: selected, mobileChatOpen: !!selected, live: {} });
createRoot(document.getElementById('root')!).render(<Sidebar />);
