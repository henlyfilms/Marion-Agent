import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, FolderOpen, X } from 'lucide-react';
import { useStore } from '../../store';
import { useConfigUI } from '../../configStore';
import { useCompactLayout } from '../../lib/layout';
import { dividerLabel } from '../../lib/time';
import {
  attachFiles, listScreenshots, SCREENSHOT_SHORTCUT_LABEL, screenshotFile, screenshotUrl, type ScreenshotEntry,
} from '../../lib/screenshots';
import { Modal } from './Modal';

const RECENT = 3;
const PAGE = 24;

/**
 * ⇧⌘S: the three newest screenshots from this Mac's Screenshot folder, one click (or 1, 2, 3) to attach.
 * "Browse all screenshots" opens the whole history in a scrolling grid.
 */
export function ScreenshotPicker() {
  const botId = useRef(useStore.getState().selectedBotId).current;
  const compact = useCompactLayout();
  const chatOpen = useStore(s => s.selectedBotId === botId && (!compact || s.mobileChatOpen));
  const chatView = useConfigUI(s => s.view === 'chat' && !s.appSettings && !s.botSettings);
  const setModal = useStore(s => s.setModal);
  const close = useCallback(() => setModal(null), [setModal]);
  const [browsing, setBrowsing] = useState(false);
  const [items, setItems] = useState<ScreenshotEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [folder, setFolder] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const requests = useRef<AbortController>();
  const attaching = useRef<AbortController>();
  useLayoutEffect(() => () => attaching.current?.abort(), []);
  useLayoutEffect(() => {
    if (!chatOpen || !chatView) close();
  }, [chatOpen, chatView, close]);

  const load = useCallback((offset: number, limit: number, replace: boolean) => {
    requests.current?.abort();
    const controller = new AbortController();
    requests.current = controller;
    setLoading(true);
    setError('');
    listScreenshots(limit, offset, controller.signal).then(page => {
      if (controller.signal.aborted) return;
      setItems(current => replace ? page.items : [...current, ...page.items]);
      setTotal(page.total);
      setFolder(page.folder);
    }).catch(cause => {
      if (!controller.signal.aborted) setError((cause as Error).message || 'Could not load screenshots.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
  }, []);

  useEffect(() => {
    setItems([]);
    load(0, browsing ? PAGE : RECENT, true);
  }, [browsing, load]);
  useEffect(() => () => requests.current?.abort(), []);

  const choose = useCallback(async (entry: ScreenshotEntry) => {
    if (!botId || attaching.current) return;
    const controller = new AbortController();
    attaching.current = controller;
    setBusy(entry.name);
    setError('');
    try {
      const file = await screenshotFile(entry, controller.signal);
      if (controller.signal.aborted) return;
      if (!attachFiles(botId, [file])) throw new Error('Could not add the screenshot to this draft. A message can have up to four attachments.');
      close();
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError((cause as Error).message || 'Could not attach that screenshot.');
        setBusy(null);
      }
    } finally {
      attaching.current = undefined;
    }
  }, [botId, close]);

  // 1, 2 and 3 pick the matching recent screenshot; B browses the whole history.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      if (browsing) return;
      const index = ['1', '2', '3'].indexOf(event.key);
      if (index >= 0 && items[index]) { event.preventDefault(); void choose(items[index]); }
      else if (event.key.toLowerCase() === 'b') { event.preventDefault(); setBrowsing(true); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [browsing, items, choose]);

  const empty = !loading && !error && items.length === 0;
  return (
    <Modal onClose={close} className={`shots-modal${browsing ? ' is-browsing' : ''}`} label={browsing ? 'All screenshots' : 'Recent screenshots'}>
      <header className="shots__header">
        {browsing && <button type="button" className="icon-btn icon-btn--sm" onClick={() => setBrowsing(false)} aria-label="Back to recent screenshots"><ChevronLeft size={19} /></button>}
        <div className="shots__title">
          <h1>{browsing ? 'All screenshots' : 'Recent screenshots'}</h1>
          <p>{error ? 'Something went wrong' : browsing
            ? `${total} in ${folder || 'your screenshot folder'} · newest first`
            : 'Choose one to attach to this chat'}</p>
        </div>
        <kbd className="shots__kbd" title="Press again to close">{SCREENSHOT_SHORTCUT_LABEL}</kbd>
        <button type="button" className="icon-btn icon-btn--sm" onClick={close} aria-label="Close"><X size={19} /></button>
      </header>

      <div className="shots__body">
        {error && <div className="shots__message" role="alert">{error}</div>}
        {empty && <div className="shots__message">No screenshots found{folder ? ` in ${folder}` : ''}. Take one with ⇧⌘4 and it will show up here.</div>}
        {loading && items.length === 0 && !error && <div className="shots__message" role="status">Loading screenshots…</div>}
        <ul className={`shots__grid${browsing ? ' is-all' : ''}`} aria-label="Screenshots">
          {items.map((entry, index) => (
            <li key={entry.name}>
              <button type="button" className="shot" onClick={() => void choose(entry)} disabled={!!busy}
                aria-label={`Attach ${entry.name}`} title={entry.name} data-busy={busy === entry.name}>
                <span className="shot__frame"><img src={screenshotUrl(entry, true)} alt="" loading="lazy" decoding="async" /></span>
                <span className="shot__meta">
                  {!browsing && <kbd>{index + 1}</kbd>}
                  <span className="shot__when">{dividerLabel(entry.at)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {browsing && items.length < total && (
          <div className="shots__more">
            <button type="button" className="cfg-btn cfg-btn--secondary" disabled={loading} onClick={() => load(items.length, PAGE, false)}>
              {loading ? 'Loading…' : `Show more (${total - items.length} left)`}
            </button>
          </div>
        )}
      </div>

      {!browsing && (
        <footer className="shots__footer">
          <span>Press <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> to attach · <kbd>Esc</kbd> to close</span>
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setBrowsing(true)}>
            <FolderOpen size={15} aria-hidden="true" /> Browse all screenshots
          </button>
        </footer>
      )}
    </Modal>
  );
}
