import { ArrowDownToLine } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import type { Bot, ChatSort } from '@shared/types';
import { orderChats } from '@shared/chat-order';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { useConfigUI } from '../configStore';
import { api } from '../lib/api';
import { configApi } from '../lib/configApi';
import { clock } from '../lib/time';
import { useCompactLayout } from '../lib/layout';
import { displayName, useStore } from '../store';
import { TasksIsland } from './config/TasksView';
import { SessionsIsland } from './sessions/SessionsView';
import { MeterIcon } from './MeterIcon';
import { updateAvailable, updateBusy, useAppUpdate } from '../lib/appUpdate';
import { Icon } from './Icon';
import { Menu, type MenuItem } from './Menu';
import { useContextMenu } from './ContextMenu';
import { botMenuItems, openBotChat, toggleChatStar } from './botMenuItems';
import { Modal } from './modals/Modal';
import { useChatReorder, type ChatMove } from './useChatReorder';
import { formatTokens } from '../lib/featuresApi';
import { contextFraction, contextTone } from './features/ContextCard';

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

function activityTime(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return clock(ts);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function previewFor(bot: Bot, running: boolean, awaiting: string | null) {
  if (awaiting) return `Waiting for you: ${awaiting}`;
  if (running) return 'Working…';
  return bot.lastPreview ?? 'No messages yet';
}

type SwipeSide = 'star' | 'delete';
type Swipe = { botId: string; side: SwipeSide };
const ACTION_WIDTH = 80;

function SwipeChat({ bot, openSide, setSwipe, onDelete, onError, children }: {
  bot: Bot; openSide: SwipeSide | undefined; setSwipe: (swipe: Swipe | null) => void;
  onDelete: (id: string) => void; onError: (error: unknown) => void; children: (open: () => void) => ReactNode;
}) {
  const gesture = useRef<{ id: number; x: number; y: number; horizontal: boolean; start: number }>();
  const lastDrag = useRef(0);
  const [drag, setDrag] = useState<number | null>(null);
  const resting = openSide === 'star' ? ACTION_WIDTH : openSide === 'delete' ? -ACTION_WIDTH : 0;
  const offset = drag ?? resting;

  const begin = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch' || !event.isPrimary || (event.target as HTMLElement).closest('.chat-swipe__action')) return;
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, horizontal: false, start: resting };
    if (!openSide) setSwipe(null);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.horizontal) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { gesture.current = undefined; return; }
      if (Math.abs(dx) < 10 || Math.abs(dx) <= Math.abs(dy)) return;
      current.horizontal = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setDrag(Math.max(-ACTION_WIDTH, Math.min(ACTION_WIDTH, current.start + dx)));
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    gesture.current = undefined;
    setDrag(null);
    if (!current?.horizontal || current.id !== event.pointerId) return;
    lastDrag.current = Date.now();
    const dx = current.start + event.clientX - current.x;
    setSwipe(Math.abs(dx) < 36 ? null : { botId: bot.id, side: dx > 0 ? 'star' : 'delete' });
  };
  const open = () => {
    if (Date.now() - lastDrag.current < 250) return;
    if (openSide) { setSwipe(null); return; }
    openBotChat(bot.id);
  };
  const label = bot.pinned ? 'Unstar' : 'Star';
  return (
    <div className={`chat-swipe${drag !== null ? ' is-dragging' : ''}`} style={{ '--swipe-offset': `${offset}px` } as CSSProperties}
      onPointerDown={begin} onPointerMove={move} onPointerUp={end}
      onPointerCancel={() => { gesture.current = undefined; setDrag(null); }}>
      {(offset > 0 || openSide === 'star') && (
        <button type="button" className="chat-swipe__action is-star" aria-label={`${label} ${displayName(bot)}`}
          tabIndex={openSide === 'star' ? 0 : -1} aria-hidden={openSide !== 'star'}
          onClick={() => { setSwipe(null); void toggleChatStar(bot.id).catch(onError); }}>
          <Icon name="star" size={19} />{label}
        </button>
      )}
      {(offset < 0 || openSide === 'delete') && (
        <button type="button" className="chat-swipe__action is-delete" aria-label={`Delete ${displayName(bot)}`}
          tabIndex={openSide === 'delete' ? 0 : -1} aria-hidden={openSide !== 'delete'}
          onClick={() => { setSwipe(null); onDelete(bot.id); }}>
          <Icon name="trash" size={19} />Delete
        </button>
      )}
      <div className="chat-swipe__content">{children(open)}</div>
    </div>
  );
}

function ChatAvatar({ bot, running, awaiting, size }: { bot: Bot; running: boolean; awaiting: string | null; size: number }) {
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    const remaining = 3200 - (Date.now() - (bot.completedAt ?? 0));
    if (remaining <= 0) { setCelebrate(false); return; }
    setCelebrate(true);
    const timer = setTimeout(() => setCelebrate(false), remaining);
    return () => clearTimeout(timer);
  }, [bot.completedAt]);
  const showCelebration = celebrate && !running && !awaiting;
  return (
    <span className={`bot-row__avatar${showCelebration ? ' is-complete' : ''}`}>
      <BotAvatarFor bot={bot} size={size} />
      {showCelebration && <span key={bot.completedAt} className="completion-mark" role="img" aria-label="Task completed"><Icon name="check" size={11} /></span>}
      {!showCelebration && (running || awaiting || bot.unread > 0) && (
        <span className={`status-dot ${awaiting ? 'is-attention' : running ? 'is-working' : 'is-unread'}`} aria-label={awaiting ? 'Needs attention' : running ? 'Working' : 'Unread activity'} />
      )}
    </span>
  );
}

interface BotButtonProps {
  bot: Bot; selected: boolean; running: boolean; awaiting: string | null;
  variant: 'row' | 'rail' | 'featured'; open: () => void; remove: () => void; moveItems: () => MenuItem[];
}

const BotButton = memo(function BotButton({ bot, selected, running, awaiting, variant, open, remove, moveItems }: BotButtonProps) {
  const contextMenu = useContextMenu();
  return (
    <button type="button" className={`bot-row bot-row--${variant}${selected ? ' is-selected' : ''}`} onClick={open}
      aria-label={displayName(bot)} aria-current={selected || undefined} title={variant === 'rail' ? displayName(bot) : undefined}
      {...contextMenu(displayName(bot), () => [...botMenuItems(bot, true), ...moveItems(), { label: 'Delete chat…', danger: true, separator: true, onSelect: remove }])}>
      <ChatAvatar bot={bot} running={running} awaiting={awaiting} size={variant === 'featured' ? 62 : 40} />
      <span className="bot-row__text">
        <span className="bot-row__name">{displayName(bot)}{bot.pinned && variant !== 'featured' && <Icon name="star" size={11} className="bot-row__star" />}</span>
        {variant !== 'featured' && <span className="bot-row__preview">{previewFor(bot, running, awaiting)}</span>}
      </span>
      {variant !== 'featured' && (!!bot.lastPreview || !!bot.contextTokens) && <span className="bot-row__meta">
        {bot.lastPreview && <time className="bot-row__time" dateTime={new Date(bot.lastActivityAt).toISOString()}>{activityTime(bot.lastActivityAt)}</time>}
        {bot.kind !== 'room' && bot.contextTokens ? <span className={`bot-row__context ${contextTone(bot.contextTokens)}`} title={`Context: ${bot.contextTokens.toLocaleString()} of 1,000,000 tokens`}
          aria-label={`Context ${formatTokens(bot.contextTokens)} tokens`}><span className="bot-row__context-bar"><span style={{ width: `${contextFraction(bot.contextTokens) * 100}%` }} /></span>{formatTokens(bot.contextTokens)}</span> : null}
      </span>}
    </button>
  );
});

export function Sidebar() {
  const bots = useStore(s => s.bots);
  const sort = useStore(s => s.chatSort);
  const live = useStore(s => s.live);
  const storeSelectedBotId = useStore(s => s.selectedBotId);
  const inTasks = useConfigUI(s => s.view === 'tasks');
  const mobileChatOpen = useStore(s => s.mobileChatOpen);
  const user = useStore(s => s.user);
  const localWorkspace = useStore(s => s.localWorkspace);
  const mobilePaired = useStore(s => s.mobilePaired);
  const sidebarCollapsed = useStore(s => s.sidebarCollapsed);
  const compact = useCompactLayout();
  const collapsed = sidebarCollapsed && !compact;
  const selectedBotId = inTasks || (compact && !mobileChatOpen) ? null : storeSelectedBotId;
  const set = useStore(s => s.set);
  const setModal = useStore(s => s.setModal);
  const [accountMenu, setAccountMenu] = useState<'mobile' | 'desktop' | null>(null);
  const [swipe, setSwipe] = useState<Swipe | null>(null);
  const [sortMenu, setSortMenu] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const [pendingMove, setPendingMove] = useState<ChatMove>();
  const orderPending = useRef(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const previousPositions = useRef(new Map<string, number>());
  const contextMenu = useContextMenu();
  const report = (cause: unknown) => setError((cause as Error).message);
  const logout = async () => { await api.logout(); location.reload(); };
  const update = useAppUpdate(st => st.status);
  const isLocalMac = localWorkspace && !mobilePaired;
  const openSettings = () => useConfigUI.getState().openAppSettings();
  const checkUpdates = () => {
    const ui = useAppUpdate.getState();
    if (updateAvailable(ui.status)) useConfigUI.getState().openAppSettings('updates');
    else void ui.check().then(() => useConfigUI.getState().openAppSettings('updates'));
  };
  // Click opens Settings; right-click shows the shortcuts that used to live in this menu.
  const accountItems: MenuItem[] = [
    { label: 'Settings', hint: '⌘,', onSelect: openSettings },
    { label: 'Subscription usage', onSelect: () => setModal('usage') },
    { label: 'Connect apps', onSelect: () => setModal('apps') },
    { label: 'Sessions', onSelect: () => useConfigUI.getState().setView('sessions') },
    ...(isLocalMac ? [{
      label: updateBusy(update) ? 'Updating…' : updateAvailable(update) ? 'Install update…' : 'Check for updates…',
      separator: true, disabled: updateBusy(update), onSelect: checkUpdates,
    }] : []),
    ...(!localWorkspace || mobilePaired ? [{ label: 'Log out', danger: true, separator: true, onSelect: () => logout().catch(report) }] : []),
  ];
  useEffect(() => {
    if (!isLocalMac) return;
    const first = window.setTimeout(() => void useAppUpdate.getState().check(), 4000);
    const timer = window.setInterval(() => void useAppUpdate.getState().check(), 30 * 60_000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [isLocalMac]);

  const saveOrder = async (choice: { sort: ChatSort } | ChatMove) => {
    if (orderPending.current) return;
    orderPending.current = true;
    setOrdering(true);
    if ('id' in choice) setPendingMove(choice);
    setError('');
    try {
      const result = await api.orderChats(choice);
      useStore.getState().handleEvent({ type: 'chat-order', ...result });
    } catch (cause) { report(cause); }
    finally { orderPending.current = false; setOrdering(false); setPendingMove(undefined); }
  };
  const { list, dropPositions, dragging, handlers } = useChatReorder(move => void saveOrder(move), () => setSwipe(null), ordering);
  const sorted = useMemo(() => {
    const ordered = orderChats(bots, sort);
    if (!pendingMove) return ordered;
    const source = ordered.find(bot => bot.id === pendingMove.id);
    const target = ordered.find(bot => bot.id === pendingMove.targetId);
    if (!source || !target || source.pinned !== target.pinned) return ordered;
    const next = ordered.filter(bot => bot !== source);
    next.splice(next.indexOf(target) + Number(pendingMove.after), 0, source);
    return next;
  }, [bots, sort, pendingMove]);
  const featured = useMemo(() => {
    if (sort === 'custom' || pendingMove) return [];
    const primary = sorted.find(bot => bot.isPrimary);
    return [...(primary ? [primary] : []), ...sorted.filter(bot => !bot.isPrimary && bot.pinned)].slice(0, 3);
  }, [sorted, sort, pendingMove]);

  const moveItems = (bot: Bot): MenuItem[] => {
    const peers = sorted.filter(other => other.pinned === bot.pinned);
    const index = peers.indexOf(bot);
    const previous = peers[index - 1];
    const next = peers[index + 1];
    return [
      { label: 'Move up', disabled: ordering || !previous, onSelect: () => previous && saveOrder({ id: bot.id, targetId: previous.id, after: false }) },
      { label: 'Move down', disabled: ordering || !next, onSelect: () => next && saveOrder({ id: bot.id, targetId: next.id, after: true }) },
    ].filter(item => !item.disabled).map(item => ({ ...item, onSelect: () => { void item.onSelect(); } }));
  };
  const sortItems = ([
    ['recent', 'Recent activity'], ['name', 'Name'], ['custom', 'Custom order'],
  ] as const).map(([value, label]) => ({ label, checked: sort === value, onSelect: () => saveOrder({ sort: value }) }));

  useLayoutEffect(() => {
    if (!list.current) return;
    const positions = new Map<string, number>();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dropped = dropPositions.current;
    dropPositions.current = undefined;
    const listTop = list.current.getBoundingClientRect().top;
    for (const row of list.current.querySelectorAll<HTMLElement>('[data-chat-id]')) {
      const id = row.dataset.chatId!;
      if (!row.offsetHeight) continue;
      const y = row.offsetTop;
      positions.set(id, y);
      const previous = previousPositions.current.get(id) ?? y;
      const visualTop = dropped?.get(id);
      const shift = visualTop === undefined ? previous - y : visualTop - listTop - y;
      if (!reduced && !dragging && Math.abs(shift) > 0.5) {
        const offset = dropped ? 0 : new DOMMatrixReadOnly(getComputedStyle(row).transform).m42;
        row.getAnimations().forEach(animation => animation.cancel());
        row.animate([{ transform: `translateY(${shift + offset}px)` }, { transform: 'translateY(0)' }], {
          duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)',
        });
      }
    }
    previousPositions.current = positions;
  }, [list, sorted, compact, dragging, dropPositions]);

  const pendingDelete = bots.find(bot => bot.id === deleting);
  const closeDelete = useCallback(() => { if (!busy) setDeleting(null); }, [busy]);
  const remove = async () => {
    if (!pendingDelete || busy) return;
    setBusy(true);
    setError('');
    try {
      await configApi.deleteBot(pendingDelete.id);
      setDeleting(null);
      await useStore.getState().loadBots();
    } catch (cause) { report(cause); }
    finally { setBusy(false); }
  };
  const askDelete = (id: string) => { setError(''); setDeleting(id); };

  const account = (variant: 'mobile' | 'desktop') => (
    <div className={`account account--${variant}`}>
      <button type="button" className="account__btn" onClick={() => { setAccountMenu(null); openSettings(); }}
        aria-label="Settings" title={`Settings · right-click for more`}
        {...contextMenu(user?.name ?? 'Account', () => { setAccountMenu(null); return accountItems; })}>
        <span className="account__initials">{initials(user?.name ?? user?.email ?? '')}</span>
        {variant === 'desktop' && <span className="account__name">{user?.name ?? user?.email}</span>}
        {updateAvailable(update) && <span className="account__update-dot" aria-label="Update available" />}
      </button>
      {accountMenu === variant && (
        <Menu placement={variant === 'desktop' ? 'above' : 'below'} onClose={() => setAccountMenu(null)} items={accountItems}>
          {user?.email && <div className="menu__header">{user.email}</div>}
        </Menu>
      )}
    </div>
  );

  const renderChat = (bot: Bot, variant: BotButtonProps['variant']) => (
    <SwipeChat bot={bot} openSide={swipe?.botId === bot.id ? swipe.side : undefined} setSwipe={setSwipe} onDelete={askDelete} onError={report}>
      {open => <BotButton bot={bot} selected={selectedBotId === bot.id} running={!!live[bot.id]?.isRunning}
        awaiting={live[bot.id]?.awaiting?.reason ?? null} variant={variant} open={open} remove={() => askDelete(bot.id)} moveItems={() => moveItems(bot)} />}
    </SwipeChat>
  );

  return (
    <aside className={`sidebar${collapsed ? ' is-collapsed' : ''}`} aria-label="Chats">
      <div className="sidebar__titlebar">
        <button type="button" className="icon-btn icon-btn--plain sidebar-toggle" onClick={() => set({ sidebarCollapsed: !collapsed })}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!collapsed} title="Toggle sidebar (⌘B)">
          <Icon name="sidebar" size={21} opacity={0.78} />
        </button>
        <div className="sidebar__brand"><img src="/favicon.svg" width="28" height="28" alt="" /><span>Marion Agent</span></div>
        {account('mobile')}
        <div className="sidebar__controls">
          <button type="button" className="icon-btn sidebar__mobile-search" onClick={() => setModal('search')} aria-label="Search" title="Search (⌘K)"><Icon name="search" size={19} /></button>
          <span className="sidebar__sort">
            <button type="button" className="icon-btn sidebar__sort-trigger" onClick={() => setSortMenu(!sortMenu)} disabled={ordering}
              aria-label="Sort chats" aria-haspopup="menu" aria-expanded={sortMenu} title="Sort chats"><Icon name="sort" size={18} /></button>
            {sortMenu && <Menu align="right" items={sortItems} label="Sort chats" onClose={() => setSortMenu(false)} />}
          </span>
          <button type="button" className="icon-btn sidebar__create" onClick={() => setModal('create')} aria-label="New Bot" title="New Bot"><Icon name="plus" size={20} /></button>
        </div>
      </div>
      <div className="sidebar__search-slot"><div>
        <button type="button" className="sidebar__search" onClick={() => setModal('search')} tabIndex={collapsed ? -1 : undefined}
          aria-hidden={collapsed} aria-label="Search chats" title="Search (⌘K)">
          <Icon name="search" size={15} /><span>Search</span>
        </button>
      </div></div>
      <div className="sidebar__scroll" onScroll={() => setSwipe(null)}>
        {featured.length > 0 && <div className="sidebar__featured" aria-label="Favorite chats">
          {featured.map(bot => <div key={bot.id}>{renderChat(bot, 'featured')}</div>)}
        </div>}
        <div className="bot-list" ref={list} {...handlers}>
          {sorted.map(bot => (
            <div key={bot.id} data-chat-id={bot.id} data-starred={bot.pinned} className={featured.includes(bot) ? 'is-featured' : undefined}>
              {renderChat(bot, collapsed ? 'rail' : 'row')}
            </div>
          ))}
          {!bots.length && <button type="button" className="bot-list__empty" onClick={() => setModal('create')}>
            <span className="bot-list__empty-plus"><Icon name="plus" size={16} /></span>
            <span className="bot-row__name">Create a Bot</span>
          </button>}
        </div>
      </div>
      <div className="sidebar__bottom">
        <div className="sidebar__tools"><TasksIsland /><SessionsIsland /></div>
        {isLocalMac && (updateAvailable(update) || updateBusy(update)) && !collapsed && (
          <button type="button" className={`update-pill update-pill--sidebar${updateBusy(update) ? ' is-busy' : ''}`} onClick={() => useConfigUI.getState().openAppSettings('updates')}>
            {updateBusy(update) ? <span className="update-pill__spinner" aria-hidden /> : <ArrowDownToLine size={15} />}
            <span>{updateBusy(update) ? 'Updating…' : 'Update available'}</span>
            {!updateBusy(update) && <small>{update!.behind} new</small>}
          </button>
        )}
        <div className="sidebar__footer">
          {account('desktop')}
          <button type="button" className="icon-btn icon-btn--bordered" onClick={() => setModal('usage')} aria-label="Subscription usage" title="Subscription usage"><MeterIcon size={18} /></button>
        </div>
      </div>
      {pendingDelete && <Modal onClose={closeDelete} className="delete-chat" label="Delete chat">
        <h2>Delete {displayName(pendingDelete)}?</h2>
        <p>This permanently deletes this agent’s conversation and settings.</p>
        {error && <p role="alert">{error}</p>}
        <div className="delete-chat__actions">
          <button type="button" className="btn btn--secondary" onClick={closeDelete} disabled={busy}>Cancel</button>
          <button type="button" className="btn delete-chat__confirm" onClick={() => void remove()} disabled={busy}>{busy ? 'Deleting…' : 'Delete chat'}</button>
        </div>
      </Modal>}
      {error && !pendingDelete && <div className="toast context-menu-error" role="alert">{error} <button type="button" className="link-btn" onClick={() => setError('')}>Dismiss</button></div>}
    </aside>
  );
}
