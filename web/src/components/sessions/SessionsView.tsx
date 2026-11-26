import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { copyText } from '../../lib/clipboard';
import { useConfigUI } from '../../configStore';
import { featuresApi, type CodingSession, type SessionMessage, type SessionProvider } from '../../lib/featuresApi';
import { relativeShort } from '../../lib/time';
import { useStore } from '../../store';
import { useContextMenu } from '../ContextMenu';
import { Icon } from '../Icon';
import { Markdown } from '../Markdown';
import { ProviderLogo } from '../ProviderLogo';

type Filter = 'all' | SessionProvider;
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'claude', label: 'Claude' }, { id: 'gemini', label: 'Gemini' }, { id: 'codex', label: 'ChatGPT' },
];
const APP_NAMES: Record<SessionProvider, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' };
const FILTER_PREF = 'marion-agent:sessions-filter';

function readFilter(): Filter {
  try { const saved = localStorage.getItem(FILTER_PREF); return FILTERS.some(f => f.id === saved) ? saved as Filter : 'all'; }
  catch { return 'all'; }
}

const ago = (ts: number) => { const r = relativeShort(ts); return r === 'now' ? 'Just now' : /^\d/.test(r) ? `${r} ago` : r; };

/** Live list of coding sessions, refreshed while it is on screen. */
// Last list seen (the sidebar polls it), so opening Sessions shows rows at once instead of a loading state.
let lastSessions: CodingSession[] | null = null;

export function useCodingSessions(refreshMs = 8000) {
  const [sessions, setSessions] = useState<CodingSession[] | null>(lastSessions);
  useEffect(() => {
    let alive = true;
    const load = () => featuresApi.sessions().then(r => { lastSessions = r.sessions; if (alive) setSessions(r.sessions); }).catch(() => { if (alive) setSessions(current => current ?? []); });
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, refreshMs);
    return () => { alive = false; clearInterval(timer); };
  }, [refreshMs]);
  return sessions;
}

/** Segmented filter with a pill that slides between options. */
function FilterBar({ value, onChange, counts }: { value: Filter; onChange: (f: Filter) => void; counts: Record<Filter, number> }) {
  const bar = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const active = bar.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (active) setPill({ x: active.offsetLeft, w: active.offsetWidth });
  }, [value, counts]);
  return (
    <div className="session-filter" role="tablist" aria-label="Filter sessions" ref={bar}>
      {pill && <span className="session-filter__pill" style={{ transform: `translateX(${pill.x}px)`, width: pill.w }} aria-hidden />}
      {FILTERS.map(f => (
        <button key={f.id} type="button" role="tab" aria-selected={value === f.id} onClick={() => onChange(f.id)}>
          {f.id !== 'all' && <ProviderLogo provider={f.id} size={14} />}
          <span>{f.label}</span>
          {counts[f.id] > 0 && <small>{counts[f.id]}</small>}
        </button>
      ))}
    </div>
  );
}

function SessionRow({ s, index, selected, onOpen }: { s: CodingSession; index: number; selected: boolean; onOpen: () => void }) {
  const contextMenu = useContextMenu();
  return (
    <button type="button" className={`session-row${selected ? ' is-selected' : ''}`} onClick={onOpen} style={{ animationDelay: `${Math.min(index, 12) * 22}ms` }}
      {...contextMenu(s.title, () => [
        { label: 'Copy title', onSelect: () => copyText(s.title) },
        ...(s.path ? [{ label: 'Copy project path', onSelect: () => copyText(s.path) }] : []),
      ])}>
      <span className="session-row__logo"><ProviderLogo provider={s.provider} size={18} />{s.active && <span className="session-row__live" aria-label="Active now" />}</span>
      <span className="session-row__text">
        <span className="session-row__title">{s.title}</span>
        <span className="session-row__meta">{APP_NAMES[s.provider]}{s.project && <> · {s.project}</>}</span>
      </span>
      <span className="session-row__time">{s.active ? <span className="session-chip">Active</span> : ago(s.updatedAt)}</span>
    </button>
  );
}

function SessionDetail({ session, onClose }: { session: CodingSession; onClose: () => void }) {
  const [messages, setMessages] = useState<SessionMessage[] | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    setMessages(null);
    const load = () => featuresApi.sessionMessages(session.id).then(r => { if (alive) setMessages(r.messages); }).catch(() => { if (alive) setMessages([]); });
    void load();
    const timer = session.active ? window.setInterval(load, 5000) : 0;
    return () => { alive = false; clearInterval(timer); };
  }, [session.id, session.active]);
  useLayoutEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }, [messages]);
  return (
    <aside className="session-detail" aria-label={session.title}>
      <header className="session-detail__head">
        <button type="button" className="icon-btn session-detail__back" onClick={onClose} aria-label="Back to sessions"><Icon name="chev_left" size={20} /></button>
        <ProviderLogo provider={session.provider} size={20} />
        <div className="session-detail__titles">
          <strong>{session.title}</strong>
          <span>{APP_NAMES[session.provider]}{session.project && ` · ${session.project}`} · {session.active ? 'Active now' : ago(session.updatedAt)}</span>
        </div>
      </header>
      <div className="session-detail__scroll" ref={scroll}>
        {messages === null ? <div className="session-detail__empty">Loading…</div>
          : messages.length === 0 ? <div className="session-detail__empty">{session.provider === 'gemini' ? 'Gemini keeps its conversation history inside Antigravity. Open it there to read this session.' : 'No messages to show yet.'}</div>
          : messages.map((m, i) => (
            <div key={i} className={`session-msg is-${m.role}`}>
              <div className="session-msg__bubble">{m.role === 'assistant' ? <Markdown text={m.text} /> : m.text}</div>
            </div>
          ))}
      </div>
      {session.path && <footer className="session-detail__foot"><Icon name="file" size={13} /><span title={session.path}>{session.path}</span></footer>}
    </aside>
  );
}

/** Every Claude Code, Codex and Gemini session on this Mac, newest first, with active ones on top. */
export function SessionsView() {
  const sessions = useCodingSessions();
  const [filter, setFilterState] = useState<Filter>(readFilter);
  const [openId, setOpenId] = useState<string | null>(null);
  const setFilter = (f: Filter) => { setFilterState(f); try { localStorage.setItem(FILTER_PREF, f); } catch { /* private mode */ } };
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, claude: 0, gemini: 0, codex: 0 };
    for (const s of sessions ?? []) if (s.active) { c.all++; c[s.provider]++; }
    return c;
  }, [sessions]);
  const shown = useMemo(() => (sessions ?? []).filter(s => filter === 'all' || s.provider === filter), [sessions, filter]);
  const open = sessions?.find(s => s.id === openId) ?? null;
  const back = () => { useConfigUI.getState().setView('chat'); useStore.setState({ mobileChatOpen: false }); };
  return (
    <main className={`chat sessions-view${open ? ' has-session' : ''}`}>
      <header className="sessions-view__header">
        <button type="button" className="icon-btn sidebar-back" aria-label="Back to chats" onClick={back}><Icon name="chev_left" size={23} /></button>
        <div className="sessions-view__title">Sessions{counts.all > 0 && <span className="session-chip">{counts.all} active</span>}</div>
        <FilterBar value={filter} onChange={setFilter} counts={counts} />
      </header>
      <div className="sessions-view__body">
        <div className="sessions-view__list">
          {sessions === null ? <div className="session-skeleton" aria-hidden>{[0, 1, 2, 3, 4].map(i => <span key={i} />)}</div>
            : shown.length === 0 ? (
              <div className="tasks-empty">
                <div className="tasks-empty__title">No {filter === 'all' ? '' : `${FILTERS.find(f => f.id === filter)!.label} `}sessions yet</div>
                <div className="tasks-empty__sub">Sessions from Claude Code, Codex and Gemini on this Mac show up here as you work.</div>
              </div>
            ) : (
              <div className="session-list" key={filter}>
                {shown.map((s, i) => <SessionRow key={s.id} s={s} index={i} selected={s.id === openId} onOpen={() => setOpenId(s.id === openId ? null : s.id)} />)}
              </div>
            )}
        </div>
        {open && <SessionDetail key={open.id} session={open} onClose={() => setOpenId(null)} />}
      </div>
    </main>
  );
}

/** Sidebar entry for Sessions, with a live count of sessions that are working right now. */
export function SessionsIsland() {
  const view = useConfigUI(s => s.view);
  const sessions = useCodingSessions(20000);
  const active = sessions?.filter(s => s.active).length ?? 0;
  return (
    <button type="button" className={`sidebar-island${view === 'sessions' ? ' is-active' : ''}`} title="Sessions" aria-pressed={view === 'sessions'}
      onClick={() => useConfigUI.getState().setView(view === 'sessions' ? 'chat' : 'sessions')}>
      <span className="sidebar-island__icon sidebar-island__logos" aria-hidden>
        {(['claude', 'gemini', 'codex'] as const).map(p => <span key={p}><ProviderLogo provider={p} size={10} /></span>)}
      </span>
      <span className="sidebar-island__label">Sessions</span>
      {active > 0 && <span className="sidebar-island__count is-live" aria-label={`${active} active`}>{active}</span>}
    </button>
  );
}
