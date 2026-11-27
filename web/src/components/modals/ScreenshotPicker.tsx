import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronLeft, Clock, FolderOpen, X } from 'lucide-react';
import { useStore } from '../../store';
import { useConfigUI } from '../../configStore';
import { useCompactLayout } from '../../lib/layout';
import { dividerLabel } from '../../lib/time';
import {
  listedTotal, listScreenshots, moreInPastHour, pastHourQuery, recentQuery, SCREENSHOT_SHORTCUT_LABEL, screenshotFile, screenshotUrl,
  type ScreenshotEntry, type ScreenshotQuery,
} from '../../lib/screenshots';
import { addDraftFiles, getFileDraft, subscribeFileDrafts } from '../../lib/fileDrafts';
import { Modal } from './Modal';
import { MAX_ATTACHMENTS } from '@shared/attachment-limits';

const PAGE = 24;
type Mode = 'recent' | 'hour' | 'all';
const TITLES: Record<Mode, string> = { recent: 'Recent screenshots', hour: 'Past hour', all: 'All screenshots' };

/**
 * ⇧⌘S: the three newest screenshots from this Mac's Screenshot folder, one click (or 1, 2, 3) to attach.
 * "Past hour" lists the other screenshots from the last 60 minutes; from there "Browse all" opens the whole history.
 */
export function ScreenshotPicker() {
  const botId = useRef(useStore.getState().selectedBotId).current;
  const compact = useCompactLayout();
  const chatOpen = useStore(s => s.selectedBotId === botId && (!compact || s.mobileChatOpen));
  const chatView = useConfigUI(s => s.view === 'chat' && !s.appSettings && !s.botSettings);
  const setModal = useStore(s => s.setModal);
  const close = useCallback(() => setModal(null), [setModal]);
  const attached = useSyncExternalStore(subscribeFileDrafts, () => botId ? getFileDraft(botId).length : 0);
  const full = attached >= MAX_ATTACHMENTS;
  const [mode, setMode] = useState<Mode>('recent');
  const [items, setItems] = useState<ScreenshotEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [pastHour, setPastHour] = useState(0);
  const [folder, setFolder] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const requests = useRef<AbortController>();
  const attaching = useRef<AbortController>();
  /** The past-hour window is fixed when it opens, so "Show more" pages through the same list. */
  const hourStart = useRef(0);
  useLayoutEffect(() => () => attaching.current?.abort(), []);
  useLayoutEffect(() => {
    if (!chatOpen || !chatView) close();
  }, [chatOpen, chatView, close]);

  const load = useCallback((query: ScreenshotQuery, replace: boolean) => {
    requests.current?.abort();
    const controller = new AbortController();
    requests.current = controller;
    setLoading(true);
    setError('');
    listScreenshots(query, controller.signal).then(page => {
      if (controller.signal.aborted) return;
      setItems(current => replace ? page.items : [...current, ...page.items]);
      setTotal(page.total);
      setPastHour(page.pastHour);
      setFolder(page.folder);
    }).catch(cause => {
      if (!controller.signal.aborted) setError((cause as Error).message || 'Could not load screenshots.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
  }, []);
  const queryFor = useCallback((which: Mode, offset: number): ScreenshotQuery =>
    which === 'recent' ? recentQuery()
      : which === 'hour' ? pastHourQuery(hourStart.current, PAGE, offset)
      : { limit: PAGE, offset }, []);

  useEffect(() => {
    if (mode === 'hour') hourStart.current = Date.now();
    setItems([]);
    load(queryFor(mode, 0), true);
  }, [mode, load, queryFor]);
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
      const problem = addDraftFiles(botId, [file]);
      if (problem) throw new Error(problem);
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

  // 1, 2 and 3 pick the matching recent screenshot; H shows the rest of the past hour.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      if (mode !== 'recent') return;
      const index = ['1', '2', '3'].indexOf(event.key);
      if (index >= 0 && items[index] && !full) { event.preventDefault(); void choose(items[index]); }
      else if (event.key.toLowerCase() === 'h') { event.preventDefault(); setMode('hour'); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [mode, items, choose, full]);

  const more = moreInPastHour({ pastHour });
  const listed = listedTotal({ total }, mode === 'hour');
  const empty = !loading && !error && items.length === 0;
  const subtitle = error ? 'Something went wrong'
    : mode === 'recent' ? 'Choose one to attach to this chat'
    : mode === 'hour' ? (loading && !items.length ? 'Last 60 minutes' : `${listed} more from the last 60 minutes · newest first`)
    : `${listed} in ${folder || 'your screenshot folder'} · newest first`;
  return (
    <Modal onClose={close} className={`shots-modal${mode !== 'recent' ? ' is-browsing' : ''}`} label={TITLES[mode]}>
      <header className="shots__header">
        {mode !== 'recent' && <button type="button" className="icon-btn icon-btn--sm" onClick={() => setMode(mode === 'all' ? 'hour' : 'recent')}
          aria-label={mode === 'all' ? 'Back to past hour' : 'Back to recent screenshots'}><ChevronLeft size={19} /></button>}
        <div className="shots__title">
          <h1>{TITLES[mode]}</h1>
          <p>{subtitle}</p>
        </div>
        <kbd className="shots__kbd" title="Press again to close">{SCREENSHOT_SHORTCUT_LABEL}</kbd>
        <button type="button" className="icon-btn icon-btn--sm" onClick={close} aria-label="Close"><X size={19} /></button>
      </header>

      <div className="shots__body">
        {full && <div className="shots__message shots__message--inline" role="status">This message already has {MAX_ATTACHMENTS} attachments. Remove one to add a screenshot.</div>}
        {error && <div className="shots__message" role="alert">{error}</div>}
        {empty && (mode === 'hour'
          ? <div className="shots__message">No other screenshots in the past hour.</div>
          : <div className="shots__message">No screenshots found{folder ? ` in ${folder}` : ''}. Take one with ⇧⌘4 and it will show up here.</div>)}
        {loading && items.length === 0 && !error && <div className="shots__message" role="status">Loading screenshots…</div>}
        <ul className={`shots__grid${mode !== 'recent' ? ' is-all' : ''}`} aria-label="Screenshots">
          {items.map((entry, index) => (
            <li key={entry.name}>
              <button type="button" className="shot" onClick={() => void choose(entry)} disabled={!!busy || full}
                aria-label={`Attach ${entry.name}`} title={entry.name} data-busy={busy === entry.name}>
                <span className="shot__frame"><img src={screenshotUrl(entry, true)} alt="" loading="lazy" decoding="async" /></span>
                <span className="shot__meta">
                  {mode === 'recent' && <kbd>{index + 1}</kbd>}
                  <span className="shot__when">{dividerLabel(entry.at)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {mode !== 'recent' && items.length > 0 && items.length < listed && (
          <div className="shots__more">
            <button type="button" className="cfg-btn cfg-btn--secondary" disabled={loading} onClick={() => load(queryFor(mode, items.length), false)}>
              {loading ? 'Loading…' : `Show more (${listed - items.length} left)`}
            </button>
          </div>
        )}
      </div>

      {mode !== 'all' && (
        <footer className="shots__footer">
          {mode === 'recent'
            ? <span>Press <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> to attach · <kbd>H</kbd> past hour</span>
            : <span>Screenshots from the last 60 minutes</span>}
          {mode === 'recent'
            ? <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setMode('hour')}
                aria-label={more ? `Past hour: ${more} more screenshot${more === 1 ? '' : 's'}` : 'Past hour'}>
                <Clock size={15} aria-hidden="true" /> Past hour{more > 0 && <span className="shots__count">{more}</span>}
              </button>
            : <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setMode('all')}>
                <FolderOpen size={15} aria-hidden="true" /> Browse all
              </button>}
        </footer>
      )}
    </Modal>
  );
}
