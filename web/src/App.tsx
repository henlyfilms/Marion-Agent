import { useEffect, useState } from 'react';
import type { Bot } from '@shared/types';
import { api, isConnectedMessage } from './lib/api';
import { startEvents } from './lib/events';
import { displayName, useStore } from './store';
import { ChatView } from './components/ChatView';
import { ComputerViewer } from './components/ComputerViewer';
import { FieldDictation } from './components/FieldDictation';
import { DetailsPanel } from './components/DetailsPanel';
import { Icon } from './components/Icon';
import { Sidebar } from './components/Sidebar';
import { SignIn } from './components/SignIn';
import { UsageDashboard } from './components/modals/UsageDashboard';
import { ConnectAppsModal } from './components/modals/ConnectAppsModal';
import { CreateBotModal } from './components/modals/CreateBotModal';
import { CreateGroupModal } from './components/modals/CreateGroupModal';
import { SearchModal } from './components/modals/SearchModal';
import { ConfigLayer } from './components/config/ConfigLayer';
import { TasksView } from './components/config/TasksView';
import { ContextMenuProvider } from './components/ContextMenu';
import { useConfigUI } from './configStore';
import { setDetailsOpen, useCompactLayout, useDetailsOpen } from './lib/layout';

function CompletionNotice() {
  const [message, setMessage] = useState('');
  useEffect(() => {
    let timer: number;
    const notify = (event: Event) => {
      const bot = (event as CustomEvent<Bot>).detail;
      setMessage(`${displayName(bot)} finished`);
      clearTimeout(timer);
      timer = window.setTimeout(() => setMessage(''), 3600);
    };
    window.addEventListener('marion-agent:completion', notify);
    return () => { clearTimeout(timer); window.removeEventListener('marion-agent:completion', notify); };
  }, []);
  return <div className="completion-notice" data-visible={Boolean(message)} role="status">{message}</div>;
}

function Shell() {
  const detailsOpen = useDetailsOpen();
  const compact = useCompactLayout();
  const modal = useStore((s) => s.modal);
  const viewerOpen = useStore((s) => s.viewerOpen);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const hasBot = useStore((s) => !!s.selectedBotId);
  const mobileChatOpen = useStore((s) => s.mobileChatOpen);
  const view = useConfigUI((s) => s.view);

  useEffect(() => {
    const st = useStore.getState();
    st.loadBots().catch(console.error);
    st.loadComputer().catch(console.error);
    const stop = startEvents();
    const usage = new AbortController();
    const warmUsage = st.localWorkspace && !st.mobilePaired
      ? window.setTimeout(() => void api.subscriptionUsage(false, usage.signal).catch(() => {}), 1200)
      : undefined;
    // OAuth popups post back here; refresh connection-dependent views and the open transcript.
    const onMsg = (e: MessageEvent) => {
      if (!isConnectedMessage(e)) return;
      const s = useStore.getState();
      s.set({ connectionsVersion: s.connectionsVersion + 1 });
      if (s.selectedBotId) s.loadRows(s.selectedBotId).catch(() => {});
    };
    window.addEventListener('message', onMsg);
    return () => {
      clearTimeout(warmUsage);
      usage.abort();
      stop();
      window.removeEventListener('message', onMsg);
    };
  }, []);

  // Global shortcuts: ⌘K search, ⌘B sidebar, ⇧⌘, details, ⌘N new bot.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const st = useStore.getState();
      const key = e.key.toLowerCase();
      if (key === 'k') { e.preventDefault(); st.setModal(st.modal === 'search' ? null : 'search'); }
      else if (key === 'b') {
        e.preventDefault();
        if (compact) { useConfigUI.getState().setView('chat'); st.set({ mobileChatOpen: !st.mobileChatOpen, mobileDetailsOpen: false }); }
        else st.set({ sidebarCollapsed: !st.sidebarCollapsed });
      }
      else if (e.shiftKey && (key === ',' || key === '<')) { e.preventDefault(); setDetailsOpen(!(compact ? st.mobileDetailsOpen : st.detailsOpen)); }
      else if (key === ',') { e.preventDefault(); useConfigUI.getState().openAppSettings(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [compact]);

  const hasDetails = hasBot && view === 'chat' && (!compact || mobileChatOpen);
  return (
    <div className={`app${collapsed ? ' is-sidebar-collapsed' : ''}${mobileChatOpen || view === 'tasks' ? ' has-mobile-chat' : ''}${detailsOpen && hasDetails ? ' has-details' : ''}`}>
      <Sidebar />
      {view === 'tasks' ? <TasksView /> : <ChatView />}
      {hasDetails && !compact && (
        <button type="button" className="icon-btn icon-btn--bordered details-toggle" onClick={() => setDetailsOpen(!detailsOpen)}
          aria-label={detailsOpen ? 'Close details' : 'Show details'} aria-expanded={detailsOpen}
          aria-controls="conversation-details" title={detailsOpen ? 'Close details' : 'Show details'}>
          <Icon name="sidebar" opacity={0.66} style={{ transform: 'scaleX(-1)' }} />
        </button>
      )}
      {hasDetails && (
        <div className="details-slot" aria-hidden={!detailsOpen} ref={node => { if (node) node.inert = !detailsOpen; }}>
          <DetailsPanel open={detailsOpen} compact={compact} />
        </div>
      )}
      {modal === 'create' && <CreateBotModal />}
      {modal === 'group' && <CreateGroupModal />}
      {modal === 'search' && <SearchModal />}
      {modal === 'apps' && <ConnectAppsModal />}
      {modal === 'usage' && <UsageDashboard />}
      {viewerOpen && <ComputerViewer />}
      <ConfigLayer />
      <FieldDictation />
      <CompletionNotice />
    </div>
  );
}

export function App() {
  useEffect(() => {
    const refresh = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        window.location.reload();
      }
    };
    window.addEventListener('keydown', refresh);
    return () => window.removeEventListener('keydown', refresh);
  }, []);
  const authChecked = useStore((s) => s.authChecked);
  const user = useStore((s) => s.user);
  useEffect(() => { useStore.getState().checkAuth(); }, []);
  if (!authChecked) return <div className="boot" />;
  return user ? <ContextMenuProvider><Shell /></ContextMenuProvider> : <SignIn />;
}
