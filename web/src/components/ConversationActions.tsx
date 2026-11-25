import { useEffect, useRef, useState } from 'react';
import { setDetailsOpen } from '../lib/layout';
import { displayName, useSelectedBot } from '../store';
import { Icon } from './Icon';
import { Menu } from './Menu';

export function ConversationActions({ detailsOpen }: { detailsOpen: boolean }) {
  const bot = useSelectedBot();
  const [share, setShare] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number>();
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  if (!bot) return null;

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

  const detailsLabel = detailsOpen ? 'Hide side panel' : 'Show side panel';
  return (
    <>
      <div className="conversation-actions" role="group" aria-label="Conversation actions">
        <span className="conversation-actions__share">
          <button type="button" className="icon-btn icon-btn--bordered" aria-haspopup="menu" aria-expanded={share}
            aria-label="Share" title="Share" onClick={() => setShare(!share)}><Icon name="share" /></button>
          {share && <Menu align="right" label="Share conversation" onClose={() => setShare(false)} items={[
            { label: 'Copy conversation', onSelect: copyTranscript },
            { label: 'Download transcript', onSelect: downloadTranscript },
          ]} />}
        </span>
        <button type="button" className="icon-btn icon-btn--bordered details-toggle"
          onClick={() => { setShare(false); setDetailsOpen(!detailsOpen); }} aria-label={detailsLabel} aria-expanded={detailsOpen}
          aria-controls="conversation-details" title={detailsLabel}>
          <Icon name="sidebar" opacity={0.66} style={{ transform: 'scaleX(-1)' }} />
        </button>
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}
