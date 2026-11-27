import { useStore } from '../../store';
import { CloudSessionModal } from '../modals/ProjectActions';
import type { Bot } from '@shared/types';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { MarionSessionList, isBuilder, useMarionSessions } from './MarionSessions';

type Tab = 'all' | 'builders' | 'chat' | 'relay';
const TABS: { id: Tab; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'builders', label: 'Builders' }, { id: 'chat', label: 'Chats' }, { id: 'relay', label: 'Agents' }];
const inTab = (tab: Tab, s: Parameters<typeof isBuilder>[0]) => tab === 'all' || (tab === 'builders' ? isBuilder(s) : s.type === tab);

/** Header button of a bot's chat: opens the Sessions panel; shows how many relayed agents are running for this bot. */
export function BotSessionsButton({ bot, open, onToggle }: { bot: Pick<Bot, 'id' | 'name'>; open: boolean; onToggle: () => void }) {
  const running = useMarionSessions({ botId: bot.id, type: 'relay', status: 'running' }, 15_000)?.length ?? 0;
  return (
    <button type="button" className={`chat__sessions${open ? ' is-open' : ''}`} aria-expanded={open} aria-controls="bot-sessions"
      title={`${bot.name}’s sessions`} onClick={onToggle}>
      <Icon name="clock" size={15} />
      <span className="chat__sessions-label">Sessions</span>
      {running > 0 && <span className="chat__sessions-live" aria-label={`${running} running`}>{running}</span>}
    </button>
  );
}

/**
 * A bot's sessions: its conversations (current and earlier) and every Claude, Codex or Gemini run it started,
 * running ones first. Reloads by itself when a run starts, ends or rotates.
 */
export function BotSessionsPanel({ bot, onClose, closing = false }: { bot: Pick<Bot, 'id' | 'name'>; onClose: () => void; closing?: boolean }) {
  const local = useStore(s => s.localWorkspace && !s.mobilePaired);
  const room = useStore(s => s.bots.find(b => b.id === bot.id)?.kind === 'room');
  const [cloud, setCloud] = useState(false);
  const [tab, setTab] = useState<Tab>('all');
  // Each tab asks the server for its own rows, so Builders (and Cloud runs) aren't crowded out by chat-model replies.
  const all = useMarionSessions({ botId: bot.id, limit: 200 });
  const filtered = useMarionSessions(tab === 'all' ? { botId: bot.id, limit: 200 } : { botId: bot.id, type: tab, limit: 200 });
  const sessions = tab === 'all' ? all : filtered;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (closing || cloud) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onCloseRef.current(); } };
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [closing, cloud]);
  const counts = useMemo(() => {
    const c = { all: 0, builders: 0, chat: 0, relay: 0 };
    for (const s of all ?? []) { c.all++; c[s.type]++; if (isBuilder(s)) c.builders++; }
    return c;
  }, [all]);
  const shown = (sessions ?? []).filter(s => inTab(tab, s));
  const running = (all ?? []).filter(s => s.status === 'running').length;
  return (
    <aside className={`bot-sessions${closing ? ' is-closing' : ''}`} id="bot-sessions" aria-label={`${bot.name}’s sessions`}>
      <header className="bot-sessions__head">
        <div className="bot-sessions__title">
          <strong>Sessions</strong>
          <span>{bot.name}{running > 0 ? ` · ${running} running` : ''}</span>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close sessions" title="Close (Esc)"><Icon name="close" size={18} /></button>
      </header>
      <div className="bot-sessions__tabs" role="tablist" aria-label="Filter sessions">
        {TABS.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}{counts[t.id] > 0 && <small>{counts[t.id]}</small>}
          </button>
        ))}
      </div>
      {local && !room && <div className="utility-cloud-action"><button type="button" className="btn btn--secondary btn--sm" onClick={() => setCloud(true)}>Start Claude Cloud…</button></div>}
      {cloud && <CloudSessionModal botId={bot.id} onClose={() => setCloud(false)} />}
      <div className="bot-sessions__body">
        {sessions === null ? <div className="session-skeleton" aria-hidden>{[0, 1, 2, 3].map(i => <span key={i} />)}</div>
          : shown.length === 0 ? (
            <div className="tasks-empty">
              <div className="tasks-empty__title">No {tab === 'builders' ? 'builder ' : tab === 'relay' ? 'agent ' : tab === 'chat' ? 'chat ' : ''}sessions yet</div>
              <div className="tasks-empty__sub">Conversations with {bot.name} and the Claude, Codex or Gemini runs it starts show up here.</div>
            </div>
          ) : <MarionSessionList key={tab} sessions={shown} showBot={false} onPick={s => { if (s.type === 'chat' && s.status === 'active') { onClose(); return true; } return false; }} />}
      </div>
    </aside>
  );
}

const EXIT_MS = 320;

/**
 * Sessions drawer: slides in and out, closes with the header button, its own × button, Esc or a click outside.
 * It stays mounted while it slides away so closing never snaps.
 */
export function BotSessionsDrawer({ bot, open, onClose }: { bot: Pick<Bot, 'id' | 'name'>; open: boolean; onClose: () => void }) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) { setMounted(true); return; }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setMounted(false); return; }
    const timer = window.setTimeout(() => setMounted(false), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open]);
  if (!mounted) return null;
  return (
    <>
      <div className={`bot-sessions-scrim${open ? '' : ' is-closing'}`} onPointerDown={event => { event.preventDefault(); onClose(); }} aria-hidden />
      <BotSessionsPanel key={bot.id} bot={bot} onClose={onClose} closing={!open} />
    </>
  );
}
