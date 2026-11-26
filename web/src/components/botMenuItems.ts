import type { Bot } from '@shared/types';
import { useConfigUI } from '../configStore';
import { configApi } from '../lib/configApi';
import { setDetailsOpen } from '../lib/layout';
import { useStore } from '../store';
import type { MenuItem } from './Menu';
import { featuresApi } from '../lib/featuresApi';

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

const botBanner = (bot: Bot, status: string, body: string, error = false) => window.dispatchEvent(new CustomEvent('marion-agent:toast', { detail: {
  id: `bot-${bot.id}-${Date.now()}`, kind: error ? 'error' : 'learned', botId: bot.id, botName: bot.name, status, title: status, body, at: Date.now(),
} }));

/** Saves the bot as a template the user can start new bots from (Start from a template). */
export async function saveAsTemplate(bot: Bot) {
  const banner = (status: string, body: string, error = false) => botBanner(bot, status, body, error);
  try {
    await featuresApi.saveTemplate(bot.id);
    banner('Saved as a template', 'Find it under New Bot → Start from a template.');
  } catch (cause) {
    banner('Couldn’t save the template', (cause as Error).message, true);
  }
}

/** "Turn on computer" for a bot whose computer is off (even if it never used it), or "Put computer to sleep" when it is on. */
function computerPowerItem(bot: Bot): MenuItem {
  const computer = useStore.getState().computer;
  const running = computer?.screens.some(screen => screen.botId === bot.id && screen.running) ?? false;
  return {
    label: running ? 'Put computer to sleep' : 'Turn on computer',
    onSelect: () => {
      featuresApi.setComputerAwake(bot.id, !running).catch(cause => botBanner(bot, 'Couldn’t change the computer', (cause as Error).message, true));
    },
  };
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
    ...(bot.kind === 'room' ? [] : [computerPowerItem(bot)]),
    { label: bot.kind === 'room' ? 'Group settings…' : 'Bot settings…', separator: true, onSelect: () => openBotSettings(bot.id) },
    { label: bot.pinned ? 'Unstar chat' : 'Star chat', onSelect: () => toggleChatStar(bot.id) },
    ...(bot.kind === 'room' ? [] : [{ label: 'Save as template', onSelect: () => void saveAsTemplate(bot) }]),
  ];
}
