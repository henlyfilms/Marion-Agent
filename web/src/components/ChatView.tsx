import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { botVars } from '../lib/colors';
import { displayName, sortedRows, useSelectedBot, useStore } from '../store';
import { Composer } from './Composer';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { useConfigUI } from '../configStore';
import { botMenuItems } from './botMenuItems';
import { BotSessionsButton, BotSessionsPanel } from './sessions/BotSessionsPanel';
import { Transcript } from './Transcript';
import { CallStage } from './CallStage';
import { VoiceCallBar } from './VoiceCallBar';
import { showChatList } from '../lib/layout';
import { ChatSearchBar } from './ChatSearchBar';
import { useChatSearchShortcuts } from '../lib/chatSearchKeys';
import { useChatSearch } from '../lib/chatSearchStore';

export function ChatView() {
  const bot = useSelectedBot();
  const transcript = useStore((s) => (bot ? s.transcripts[bot.id] : undefined));
  const live = useStore((s) => (bot ? s.live[bot.id] : undefined));
  const [menu, setMenu] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  useEffect(() => setSessionsOpen(false), [bot?.id]);
  const toastTimer = useRef<number>();
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const [toast, setToast] = useState<string | null>(null);
  const rows = useMemo(() => sortedRows(transcript), [transcript]);
  useChatSearchShortcuts();
  // Another chat (or leaving the chat view) starts with a closed, empty search, so old highlights never carry over.
  useLayoutEffect(() => () => useChatSearch.getState().reset(), [bot?.id]);

  if (!bot) {
    return (
      <main className="chat chat--empty">
        <div className="empty-chat"><div className="empty-chat__sub">No Bot selected.</div></div>
      </main>
    );
  }

  const flash = (message: string) => {
    clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = window.setTimeout(() => setToast(null), 2300);
  };

  return (
    <main className="chat" style={botVars(bot.avatarColor)}>
      <header className="chat__header">
        <button type="button" className="icon-btn sidebar-back" onClick={showChatList} aria-label="Back to chats">
          <Icon name="chev_left" size={23} />
        </button>
        <div className="chat__header-main">
          <span className="chat__pill-anchor">
          {/* Click opens the Bot's settings; right-click (or the menu key) opens the menu (owner, Nov 25). */}
          <button type="button" className="chat__pill" aria-haspopup="menu" aria-expanded={menu} title={`${displayName(bot)} settings · Right-click for more`}
            onClick={() => { setMenu(false); useConfigUI.getState().openBotSettings(bot.id); }}
            onContextMenu={(event) => { event.preventDefault(); setMenu(true); }}
            onKeyDown={(event) => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); setMenu(true); } }}>
            <BotAvatarFor bot={bot} size={26} working={!!live?.isRunning && !live?.awaiting} />
            <span className="chat__pill-name">{bot.name}</span>
          </button>
          {menu && (
            <Menu
              align="center"
              onClose={() => setMenu(false)}
              items={[
                ...botMenuItems(bot),
                { label: 'New conversation', separator: true, onSelect: () => api.fresh(bot.id).then(() => flash('Started a new conversation')).catch((e) => flash(e.message)) },
              ]}
            />
          )}
          </span>
          <BotSessionsButton bot={bot} open={sessionsOpen} onToggle={() => setSessionsOpen(open => !open)} />
        </div>
      </header>
      {sessionsOpen && <BotSessionsPanel key={bot.id} bot={bot} onClose={() => setSessionsOpen(false)} />}
      <CallStage bot={bot} />
      <ChatSearchBar />
      <Transcript bot={bot} rows={rows} live={live} loaded={!!transcript?.loaded} />
      <VoiceCallBar />
      <Composer key={bot.id} bot={bot} running={!!live?.isRunning} />
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
