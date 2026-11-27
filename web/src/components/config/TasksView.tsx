import { useEffect, useMemo, useState } from 'react';
import { copyText } from '../../lib/clipboard';
import { SegmentPill } from '../SegmentPill';
import type { Bot, Task, WaitingItem } from '@shared/types';
import { api } from '../../lib/api';
import { CardRow } from '../cards/Cards';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { configApi } from '../../lib/configApi';
import { relativeShort } from '../../lib/time';
import { useConfigUI, useVersion } from '../../configStore';
import { useStore } from '../../store';
import { useContextMenu } from '../ContextMenu';
import { openBotChat } from '../botMenuItems';
import { Icon } from '../Icon';
import { Glyph } from './glyphs';
import './ui';

type Filter = 'all' | 'open' | 'done';

const STATE_LABEL: Record<Task['state'], string> = { working: 'Working on it', needs_input: 'Waiting on you', done: 'Done' };

function when(t: Task): string {
  const r = relativeShort(t.updatedAt);
  const ago = r === 'now' ? 'just now' : r === 'Yesterday' ? 'yesterday' : `${r} ago`;
  return t.state === 'done' ? `Completed ${ago}` : t.state === 'needs_input' ? `Asked ${ago}` : `Updated ${ago}`;
}

function TaskRow({ t, bot, showBot }: { t: Task; bot?: Bot; showBot: boolean }) {
  const contextMenu = useContextMenu();
  const open = () => { if (bot) openBotChat(bot.id); };
  const setState = async () => {
    const { task } = await configApi.setTaskState(t.id, t.state === 'done' ? 'working' : 'done');
    const { bump } = useConfigUI.getState();
    bump('tasks');
    bump(`tasks:${task.botId}`);
  };
  return (
    <button type="button" className={`task-row is-${t.state}`} onClick={open} title={bot ? `Open ${bot.name}` : undefined}
      {...contextMenu(t.title, () => [
        ...(bot ? [{ label: 'Open Bot chat', onSelect: open }] : []),
        { label: t.state === 'done' ? 'Mark in progress' : 'Mark as done', onSelect: setState },
        { label: 'Copy task title', separator: true, onSelect: () => copyText(t.title) },
        ...(t.note ? [{ label: 'Copy task note', onSelect: () => copyText(t.note) }] : []),
      ])}>
      <span className={`task-row__check is-${t.state}`} aria-hidden>{t.state === 'done' ? <Glyph name="check_circle" size={18} /> : <span className="task-row__ring" />}</span>
      <span className="task-row__text">
        <span className="task-row__title">{t.title}</span>
        {t.note && <span className="task-row__note">{t.note}</span>}
        <span className="task-row__meta">
          {showBot && bot && <><BotAvatarFor bot={bot} size={14} /><span>{bot.name}</span><span aria-hidden>·</span></>}
          <span>{when(t)}</span>
        </span>
      </span>
      <span className={`task-chip is-${t.state}`}>{STATE_LABEL[t.state]}</span>
    </button>
  );
}

// Last list per scope, so reopening Tasks shows it instantly and refreshes quietly underneath.
const taskCache = new Map<string, Task[]>();

function useTasks(botId?: string): Task[] | null {
  const key = botId ? `tasks:${botId}` : 'tasks';
  const v = useVersion(key);
  const [tasks, setTasks] = useState<Task[] | null>(() => taskCache.get(key) ?? null);
  useEffect(() => {
    let alive = true;
    if (taskCache.has(key)) setTasks(taskCache.get(key)!);
    (botId ? configApi.botTasks(botId) : configApi.tasks()).then((r) => { taskCache.set(key, r.tasks); if (alive) setTasks(r.tasks); }).catch(() => { if (alive) setTasks((current) => current ?? []); });
    return () => { alive = false; };
  }, [botId, v]);
  return tasks;
}

// ---------- Waiting on You ----------

// One list for the section and the sidebar badge, so reopening Tasks shows it instantly.
let waitingCache: WaitingItem[] | null = null;
/** Tests (server-rendered fixtures): start from a known list, as a reopened Tasks view would. */
export function seedWaiting(items: WaitingItem[] | null) { waitingCache = items; }

/**
 * What waits on the owner (action cards and needs-input tasks), straight from the server's single source (the chat's own
 * card rows). Reloads on every 'waiting' bump: a card appears, is answered here or in chat, expires, or a chat goes away.
 */
export function useWaiting(): WaitingItem[] | null {
  const v = useVersion('waiting');
  const [items, setItems] = useState<WaitingItem[] | null>(() => waitingCache);
  useEffect(() => {
    let alive = true;
    // A burst of card updates (an answer writes the card, then the reply) reloads once.
    const timer = setTimeout(() => {
      configApi.waiting()
        .then((r) => { waitingCache = r.items; if (alive) setItems(r.items); })
        .catch(() => { if (alive) setItems((current) => current ?? []); });
    }, v ? 120 : 0);
    return () => { alive = false; clearTimeout(timer); };
  }, [v]);
  return items;
}

/** A task a bot marked "needs input" with no card asking: reply here as you would in its chat. */
function TaskReply({ item, bot }: { item: Extract<WaitingItem, { kind: 'task' }>; bot?: Bot }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true); setError(null);
    try { await api.send(item.botId, text); setDraft(''); }
    catch (e) { setError((e as Error).message || 'Something went wrong'); }
    finally { setBusy(false); }
  };
  return (
    <div className="card question-card waiting-task">
      <div className="question-card__head">
        <div className="question-card__q">{item.task.title}</div>
        {item.task.note && <div className="question-card__hint">{item.task.note}</div>}
      </div>
      <form className="question-card__reply" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input className="question-card__input" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={busy}
          placeholder={`Reply to ${bot?.name ?? item.botName}`} aria-label={`Reply to ${item.botName} about: ${item.task.title}`} maxLength={4000} />
        <button type="submit" className="btn btn--primary" disabled={busy || !draft.trim()}>Reply</button>
      </form>
      {error && <div className="card__error">{error}</div>}
    </div>
  );
}

function WaitingEntry({ item, bot }: { item: WaitingItem; bot?: Bot }) {
  const r = relativeShort(item.at);
  return (
    <li className="waiting-item" data-kind={item.kind === 'card' ? item.card : 'task'}>
      <div className="waiting-item__meta">
        {bot && <BotAvatarFor bot={bot} size={14} />}
        <span className="waiting-item__bot">{item.botName}</span>
        <span aria-hidden>·</span>
        <span>{r === 'now' ? 'just now' : r === 'Yesterday' ? 'yesterday' : `${r} ago`}</span>
        {bot && <button type="button" className="link-btn link-btn--small waiting-item__open" onClick={() => openBotChat(bot.id)}>Open chat</button>}
      </div>
      {item.kind === 'card' ? <CardRow row={item.row} inTasks /> : <TaskReply item={item} bot={bot} />}
    </li>
  );
}

/** Tasks → Waiting on You: only what the owner has to answer or act on, answerable right here. */
export function WaitingSection({ items, byId }: { items: WaitingItem[] | null; byId: Map<string, Bot> }) {
  if (items === null) return null;
  return (
    <section className="waiting-section" aria-labelledby="waiting-title">
      <div className="waiting-section__head">
        <h2 id="waiting-title" className="waiting-section__title">Waiting on You</h2>
        {items.length > 0 && <span className="waiting-section__count">{items.length}</span>}
      </div>
      {items.length === 0
        ? <div className="waiting-section__empty">Nothing needs you right now.</div>
        : <ul className="waiting-list">{items.map((item) => <WaitingEntry key={item.key} item={item} bot={byId.get(item.botId)} />)}</ul>}
    </section>
  );
}

function sortTasks(list: Task[]) {
  const rank = { needs_input: 0, working: 1, done: 2 } as const;
  return [...list].sort((a, b) => rank[a.state] - rank[b.state] || b.updatedAt - a.updatedAt);
}

/** Full Tasks view in the main column (sidebar → Tasks). */
export function TasksView() {
  const bots = useStore((s) => s.bots);
  const tasks = useTasks();
  const waiting = useWaiting();
  const [filter, setFilter] = useState<Filter>('open');
  const byId = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);
  const counts = useMemo(() => ({ open: tasks?.filter((t) => t.state !== 'done').length ?? 0, done: tasks?.filter((t) => t.state === 'done').length ?? 0 }), [tasks]);
  const shown = useMemo(() => sortTasks((tasks ?? []).filter((t) => filter === 'all' || (filter === 'done' ? t.state === 'done' : t.state !== 'done'))), [tasks, filter]);

  return (
    <main className="chat tasks-view">
      <header className="tasks-view__header">
        <button type="button" className="icon-btn sidebar-back" aria-label="Back to chats"
          onClick={() => { useConfigUI.getState().setView('chat'); useStore.setState({ mobileChatOpen: false }); }}><Icon name="chev_left" size={23} /></button>
        <div className="tasks-view__title">Tasks</div>
        <div className="segmented" role="tablist" aria-label="Filter tasks">
          <SegmentPill active={filter} />
          {([['open', `In progress${counts.open ? ` ${counts.open}` : ''}`], ['done', 'Done'], ['all', 'All']] as [Filter, string][]).map(([f, label]) => (
            <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? 'is-active' : ''} onClick={() => setFilter(f)}>{label}</button>
          ))}
        </div>
      </header>
      <div className="tasks-view__scroll">
        <div className="tasks-view__inner">
          <WaitingSection items={waiting} byId={byId} />
          {tasks === null ? <div className="session-skeleton" aria-label="Loading tasks">{[0, 1, 2, 3].map(i => <span key={i} />)}</div> : shown.length === 0 ? (
            <div className="tasks-empty">
              <Glyph name="tasks" size={28} opacity={0.35} />
              <div className="tasks-empty__title">{filter === 'done' ? 'Nothing finished yet' : 'Nothing in progress'}</div>
              <div className="tasks-empty__sub">Give a Bot a multi-part request and every piece gets its own row here, so progress is easy to follow.</div>
            </div>
          ) : (
            <div className="task-list">{shown.map((t) => <TaskRow key={t.id} t={t} bot={byId.get(t.botId)} showBot />)}</div>
          )}
        </div>
      </div>
    </main>
  );
}

/** The Tasks badge: the same pill as the Sessions badge (`sidebar-island__count`), hidden at 0. */
export function WaitingBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return <span className="sidebar-island__count is-waiting" aria-label={`${count} waiting on you`}>{count}</span>;
}

/**
 * Sidebar entry for the Tasks view. Its badge (the same pill as Sessions) counts what waits on the owner in Waiting on
 * You, updates live, and is hidden at 0.
 */
export function TasksIsland() {
  const view = useConfigUI((s) => s.view);
  const waiting = useWaiting()?.length ?? 0;
  return (
    <button type="button" className={`sidebar-island${view === 'tasks' ? ' is-active' : ''}`} onClick={() => useConfigUI.getState().setView(view === 'tasks' ? 'chat' : 'tasks')} title="Tasks" aria-pressed={view === 'tasks'}>
      <span className="sidebar-island__icon"><Glyph name="tasks" size={18} /></span>
      <span className="sidebar-island__label">Tasks</span>
      <WaitingBadge count={waiting} />
    </button>
  );
}

/** Tasks for one bot (details panel → Tasks tab). */
export function BotTasks({ bot }: { bot: Bot }) {
  const tasks = useTasks(bot.id);
  const sorted = useMemo(() => sortTasks(tasks ?? []), [tasks]);
  return (
    <div className="details__sections">
      <section>
        <div className="section-label section-label--row">
          <span>Tasks</span>
          <button type="button" className="link-btn link-btn--small" onClick={() => useConfigUI.getState().setView('tasks')}>See all</button>
        </div>
        {tasks === null ? <div className="panel-card"><div className="panel-empty">Loading…</div></div> : sorted.length === 0 ? (
          <div className="panel-card"><div className="panel-empty">No tasks yet. Ask {bot.name} for a few things at once and they’ll be tracked here.</div></div>
        ) : (
          <div className="panel-card task-list task-list--compact">{sorted.map((t) => <TaskRow key={t.id} t={t} bot={bot} showBot={false} />)}</div>
        )}
      </section>
    </div>
  );
}
