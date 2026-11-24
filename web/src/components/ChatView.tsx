import { useEffect, useMemo, useRef, useState } from 'react';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { botVars } from '../lib/colors';
import { displayName, sortedRows, useSelectedBot, useStore } from '../store';
import { Composer } from './Composer';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { useContextMenu } from './ContextMenu';
import { botMenuItems } from './botMenuItems';
import { Transcript } from './Transcript';
import { LocalVoicePanel } from './LocalVoicePanel';
import { VoiceCallBar } from './VoiceCallBar';
import { setDetailsOpen, showChatList } from '../lib/layout';

export function ChatView() {
  const bot = useSelectedBot();
  const transcript = useStore((s) => (bot ? s.transcripts[bot.id] : undefined));
  const live = useStore((s) => (bot ? s.live[bot.id] : undefined));
  const localVoice = useStore(s => s.localVoiceBotId === bot?.id);
  const set = useStore((s) => s.set);
  const [menu, setMenu] = useState(false);
  const [share, setShare] = useState(false);
  const toastTimer = useRef<number>();
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const contextMenu = useContextMenu();
  const [toast, setToast] = useState<string | null>(null);
  const rows = useMemo(() => sortedRows(transcript), [transcript]);

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
  const transcriptUrl = `/api/bots/${encodeURIComponent(bot.id)}/transcript.txt`;
  const copyTranscript = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable.');
      const text = fetch(transcriptUrl).then(response => {
        if (!response.ok) throw new Error('Could not load this conversation.');
        return response.text();
      });
      if (navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then(value => new Blob([value], { type: 'text/plain' })) })]);
      } else await navigator.clipboard.writeText(await text);
      flash('Conversation copied');
    } catch {
      flash('Could not copy the conversation. Try downloading it.');
    }
  };
  const downloadTranscript = () => {
    const link = document.createElement('a');
    link.href = transcriptUrl;
    link.download = `${displayName(bot)} transcript.txt`;
    link.click();
  };

  return (
    <main className="chat" style={botVars(bot.avatarColor)}>
      <header className="chat__header">
        <button type="button" className="icon-btn sidebar-back" onClick={showChatList} aria-label="Back to chats">
          <Icon name="chev_left" size={23} />
        </button>
        <div className="chat__header-main">
          <span className="chat__pill-anchor">
          <button type="button" className="chat__pill" onClick={() => setMenu(!menu)} aria-expanded={menu}
            {...contextMenu(displayName(bot), () => { setMenu(false); return botMenuItems(bot); })}>
            <BotAvatarFor bot={bot} size={24} />
            <span className="chat__pill-name">{displayName(bot)}</span>
          </button>
          {menu && (
            <Menu
              onClose={() => setMenu(false)}
              items={[
                ...botMenuItems(bot),
                { label: 'New conversation', separator: true, onSelect: () => api.fresh(bot.id).then(() => flash('Started a new conversation')).catch((e) => flash(e.message)) },
              ]}
            />
          )}
          </span>
        </div>
        <div className="chat__header-right">
          <span className="chat__share">
            <button type="button" className="icon-btn icon-btn--bordered" aria-haspopup="menu" aria-expanded={share}
              aria-label="Share" title="Share" onClick={() => { setMenu(false); setShare(!share); }}><Icon name="share" /></button>
            {share && <Menu align="right" label="Share conversation" onClose={() => setShare(false)} items={[
              { label: 'Copy conversation', onSelect: copyTranscript },
              { label: 'Download transcript', onSelect: downloadTranscript },
            ]} />}
          </span>
          <button type="button" className="icon-btn icon-btn--bordered chat__details-mobile" onClick={() => setDetailsOpen(true)}
            aria-label="Show details" aria-controls="conversation-details" title="Show details">
            <Icon name="sidebar" opacity={0.66} style={{ transform: 'scaleX(-1)' }} />
          </button>
        </div>
      </header>
      <Transcript bot={bot} rows={rows} live={live} loaded={!!transcript?.loaded} />
      <VoiceCallBar />
      {localVoice && <LocalVoicePanel key={bot.id} bot={bot} close={() => set({ localVoiceBotId: null })} />}
      <Composer key={bot.id} bot={bot} running={!!live?.isRunning} />
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
