import type { Bot } from '@shared/types';
import { useConfigUI } from '../configStore';
import { configApi } from '../lib/configApi';
import { setDetailsOpen } from '../lib/layout';
import { useStore } from '../store';
import type { MenuItem } from './Menu';
import { useFeatureUI } from '../lib/featuresApi';

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
  const { view, openBotAppearance, openBotSettings } = useConfigUI.getState();
  const hideDetails = selectedBotId === bot.id && view === 'chat' && (window.matchMedia('(max-width: 700px)').matches ? mobileDetailsOpen : detailsOpen);
  return [
    ...(includeOpen ? [{ label: 'Open chat', onSelect: () => openBotChat(bot.id) }] : []),
    { label: hideDetails ? 'Hide details' : 'Show details', onSelect: () => {
      if (!hideDetails && (selectedBotId !== bot.id || view !== 'chat')) openBotChat(bot.id);
      setDetailsOpen(!hideDetails);
    } },
    ...(bot.kind === 'room' ? [] : [{ label: 'Open computer', onSelect: () => {
      if (selectedBotId !== bot.id || view !== 'chat') openBotChat(bot.id);
      set({ viewerOpen: true });
    } }]),
    ...(bot.kind === 'room' ? [] : [
      { label: 'View profile', onSelect: () => useFeatureUI.getState().set({ profile: { kind: 'bot', id: bot.id } }) },
      { label: 'Teach by screen recording…', onSelect: () => { if (selectedBotId !== bot.id || view !== 'chat') openBotChat(bot.id); useFeatureUI.getState().set({ teachBotId: bot.id }); } },
    ]),
    { label: 'Change icon…', separator: true, onSelect: () => openBotAppearance(bot.id) },
    { label: bot.pinned ? 'Unstar chat' : 'Star chat', onSelect: () => toggleChatStar(bot.id) },
    { label: bot.kind === 'room' ? 'Group settings…' : 'Bot settings…', onSelect: () => openBotSettings(bot.id) },
  ];
}
