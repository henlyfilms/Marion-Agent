import { useEffect, useRef, useState, type RefObject } from 'react';
import { setDetailsOpen } from '../lib/layout';
import { displayName, useSelectedBot } from '../store';
import { Icon } from './Icon';
import { Menu } from './Menu';

export function ConversationActions({ detailsOpen }: { detailsOpen: boolean }) {
  const bot = useSelectedBot();
  const [share, setShare] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number>();
  const group = useRef<HTMLDivElement>(null);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  useOverContent(group);
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
      <div ref={group} className="conversation-actions" role="group" aria-label="Conversation actions">
        <span className="conversation-actions__share">
          <button type="button" className="icon-btn icon-btn--bordered" aria-haspopup="menu" aria-expanded={share}
            aria-label="Share" title="Share" onClick={() => setShare(!share)}><Icon name="share" size={16} fill={36} /></button>
          {share && <Menu align="right" label="Share conversation" onClose={() => setShare(false)} items={[
            { label: 'Copy conversation', onSelect: copyTranscript },
            { label: 'Download transcript', onSelect: downloadTranscript },
          ]} />}
        </span>
        <button type="button" className="icon-btn icon-btn--bordered details-toggle"
          onClick={() => { setShare(false); setDetailsOpen(!detailsOpen); }} aria-label={detailsLabel} aria-expanded={detailsOpen}
          aria-controls="conversation-details" title={detailsLabel}>
          {/* White like Share, and 18px so its outline sits level with Share's box (owner, Nov 25). */}
          <Icon name="sidebar" size={18} fill={36} style={{ transform: 'scaleX(-1)' }} />
        </button>
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}

/** Over message bubbles, images or code the buttons get a dark backing so they stay easy to see; over the plain
   chat background they look exactly as before (owner, Nov 25). Checked on scroll, resize and new messages. */
function useOverContent(group: RefObject<HTMLDivElement>) {
  useEffect(() => {
    let frame = 0;
    const check = () => {
      frame = 0;
      for (const button of group.current?.querySelectorAll<HTMLElement>('.icon-btn') ?? []) {
        const r = button.getBoundingClientRect();
        if (!r.width) continue;
        button.classList.toggle('is-over-content', overContent(r));
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(check); };
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const observer = new MutationObserver(schedule);
    observer.observe(document.querySelector('.app') ?? document.body, { childList: true, subtree: true });
    schedule();
    return () => { cancelAnimationFrame(frame); document.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); observer.disconnect(); };
  }, [group]);
}

const MEDIA = 'img, video, canvas, svg, pre, table, iframe';
/** True when a bubble, picture, code block or actual text (not just the empty part of a line) is under `r`. */
function overContent(r: DOMRect) {
  const hits = new Set<Element>();
  for (const [x, y] of [[0.5, 0.5], [0.15, 0.5], [0.85, 0.5], [0.5, 0.15], [0.5, 0.85]]) {
    for (const el of document.elementsFromPoint(r.left + r.width * x, r.top + r.height * y)) {
      if (el.closest('.conversation-actions')) continue;
      if (!el.closest('.transcript__col') || el.classList.contains('transcript__col')) continue;
      hits.add(el);
    }
  }
  for (const el of hits) {
    if (el.matches(MEDIA) || el.closest(MEDIA)) return true;
    const bg = getComputedStyle(el).backgroundColor;
    if (bg && bg !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(bg)) return true;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(), n = 0; node && n < 400; node = walker.nextNode(), n++) {
      if (!node.textContent?.trim()) continue;
      range.selectNodeContents(node);
      for (const t of range.getClientRects()) {
        if (t.right > r.left - 2 && t.left < r.right + 2 && t.bottom > r.top - 2 && t.top < r.bottom + 2) return true;
      }
    }
  }
  return false;
}
