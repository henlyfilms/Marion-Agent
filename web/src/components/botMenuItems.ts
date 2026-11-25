import type { Bot } from '@shared/types';
import { useConfigUI } from '../configStore';
import { configApi } from '../lib/configApi';
import { setDetailsOpen } from '../lib/layout';
import { useStore } from '../store';
import type { MenuItem } from './Menu';

export function openBotChat(id: string) {
  useConfigUI.getState().setView('chat');
  useStore.getState().selectBot(id);
  useStore.setState({ mobileChatOpen: true, mobileDetailsOpen: false });
}

export async function toggleChatStar(botId: string) {
  const bot = useStore.getState().bots.find(entry => entry.id === botId);
  if (!bot) return;
  const result = await configApi.updateBot(bot.id, { pinned: !bot.pinned });
  useStore.setState(s => ({ bots: s.bots.map(entry => entry.id === bot.id ? { ...entry, pinned: result.bot.pinned } : entry) }));
}

export function botMenuItems(bot: Bot, includeOpen = false): MenuItem[] {
  const { selectedBotId, detailsOpen, mobileDetailsOpen, set } = useStore.getState();
  const { view, openBotSettings } = useConfigUI.getState();
  const panelOpen = selectedBotId === bot.id && view === 'chat' && (window.matchMedia('(max-width: 700px)').matches ? mobileDetailsOpen : detailsOpen);
  return [
    ...(includeOpen ? [{ label: 'Open chat', onSelect: () => openBotChat(bot.id) }] : []),
    { label: panelOpen ? 'Hide side panel' : 'Show side panel', onSelect: () => {
      if (!panelOpen && (selectedBotId !== bot.id || view !== 'chat')) openBotChat(bot.id);
      setDetailsOpen(!panelOpen);
    } },
    ...(bot.kind === 'room' ? [] : [{ label: 'Open computer', onSelect: () => {
      if (selectedBotId !== bot.id || view !== 'chat') openBotChat(bot.id);
      set({ viewerOpen: true });
    } }]),
    { label: bot.pinned ? 'Unstar chat' : 'Star chat', separator: true, onSelect: () => toggleChatStar(bot.id) },
    { label: bot.kind === 'room' ? 'Group settings…' : 'Bot settings…', onSelect: () => openBotSettings(bot.id) },
  ];
}
