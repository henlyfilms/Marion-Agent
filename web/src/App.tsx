import { useEffect, useRef, useState } from 'react';
import { BotProfile, TemplateGallery } from './components/features/BotProfile';
import { TeachRecorder } from './components/features/TeachRecorder';
import { featuresApi, useFeatureUI } from './lib/featuresApi';
import { registerServiceWorker, setNotificationSound } from './lib/notifications';
import { openBotChat } from './components/botMenuItems';
import { api, isConnectedMessage } from './lib/api';
import { startEvents } from './lib/events';
import { useStore } from './store';
import { ChatView } from './components/ChatView';
import { ComputerViewer } from './components/ComputerViewer';
import { FieldDictation } from './components/FieldDictation';
import { ComposerDictationHost } from './voice/composerDictation';
import { DetailsPanel } from './components/DetailsPanel';
import { ConversationActions } from './components/ConversationActions';
import { Sidebar } from './components/Sidebar';
import { SignIn } from './components/SignIn';
import { UsageDashboard } from './components/modals/UsageDashboard';
import { TeamModal } from './components/modals/TeamModal';
import { ConnectAppsModal } from './components/modals/ConnectAppsModal';
import { CreateBotModal } from './components/modals/CreateBotModal';
import { CreateGroupModal } from './components/modals/CreateGroupModal';
import { SearchModal } from './components/modals/SearchModal';
import { ScreenshotPicker } from './components/modals/ScreenshotPicker';
import { ForwardPicker } from './components/modals/ForwardPicker';
import { useMessageActions } from './lib/messageActions';
import { isScreenshotShortcut } from './lib/screenshots';
import { ConfigLayer } from './components/config/ConfigLayer';
import { TasksView } from './components/config/TasksView';
import { SessionsView } from './components/sessions/SessionsView';
import { NotificationBanners } from './components/NotificationBanners';
import { ContextMenuProvider } from './components/ContextMenu';
import { useConfigUI } from './configStore';
import { setDetailsOpen, useCompactLayout, useDetailsOpen } from './lib/layout';
import { useViewSwap } from './lib/viewSwap';

function FeatureLayer() {
  const gallery = useFeatureUI(s => s.gallery);
  const profile = useFeatureUI(s => s.profile);
  const teachBotId = useFeatureUI(s => s.teachBotId);
  return (
    <>
      {gallery && <TemplateGallery />}
      {profile && <BotProfile key={`${profile.kind}:${profile.id}`} target={profile} />}
      {teachBotId && <TeachRecorder botId={teachBotId} />}
      <NotificationBanners />
    </>
  );
}

function Shell() {
  const detailsOpen = useDetailsOpen();
  const compact = useCompactLayout();
  const modal = useStore((s) => s.modal);
  const forwarding = useMessageActions((s) => !!s.forward);
  const viewerOpen = useStore((s) => s.viewerOpen);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const selectedBotId = useStore(s => s.selectedBotId);
  const mobileChatOpen = useStore((s) => s.mobileChatOpen);
  const view = useConfigUI((s) => s.view);
  // Phone: when you go back to the chat list, slide it back in (the reverse of opening a chat).
  const showingChat = mobileChatOpen || view !== 'chat';
  const wasShowingChat = useRef(showingChat);
  const [popping, setPopping] = useState(false);
  useEffect(() => {
    if (wasShowingChat.current && !showingChat && compact) {
      setPopping(true);
      const timer = window.setTimeout(() => setPopping(false), 400);
      wasShowingChat.current = showingChat;
      return () => clearTimeout(timer);
    }
    wasShowingChat.current = showingChat;
  }, [showingChat, compact]);

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
    // Notification clicks and ?bot= links open that chat.
    const openBot = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (useStore.getState().bots.some(b => b.id === id)) openBotChat(id);
      else useStore.getState().loadBots().then(() => { if (useStore.getState().bots.some(b => b.id === id)) openBotChat(id); }).catch(() => {});
    };
    window.addEventListener('marion-agent:open-bot', openBot);
    void registerServiceWorker();
    const linked = new URLSearchParams(location.search).get('bot');
    if (linked) {
      history.replaceState(null, '', location.pathname);
      window.dispatchEvent(new CustomEvent('marion-agent:open-bot', { detail: linked }));
    }
    featuresApi.notifications().then(r => setNotificationSound(r.settings.sound)).catch(() => {});
    return () => {
      window.removeEventListener('marion-agent:open-bot', openBot);
      clearTimeout(warmUsage);
      usage.abort();
      stop();
      window.removeEventListener('message', onMsg);
    };
  }, []);

  // Global shortcuts: ⌘K search, ⌘B sidebar, ⇧⌘, details, ⇧⌘S recent screenshots (⇧⌘D dictation is in the chat box).
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
      else if (isScreenshotShortcut(e)) {
        if (e.repeat || e.isComposing) return;
        e.preventDefault();
        const ui = useConfigUI.getState();
        const chatVisible = Boolean(st.selectedBotId) && ui.view === 'chat' && !ui.appSettings && !ui.botSettings && (!compact || st.mobileChatOpen);
        if (st.modal === 'screenshots') st.setModal(null);
        else if (!st.modal && chatVisible) st.setModal('screenshots');
      }
      else if (e.shiftKey && (key === ',' || key === '<')) { e.preventDefault(); setDetailsOpen(!(compact ? st.mobileDetailsOpen : st.detailsOpen)); }
      else if (key === ',') { e.preventDefault(); useConfigUI.getState().openAppSettings(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [compact]);

  // Phone has its own push/back; on a wider window the main column glides between bots and views.
  useViewSwap(view, selectedBotId, !compact);

  const hasDetails = Boolean(selectedBotId) && view === 'chat' && (!compact || mobileChatOpen);
  return (
    <div className={`app${collapsed ? ' is-sidebar-collapsed' : ''}${showingChat ? ' has-mobile-chat' : ''}${popping ? ' is-popping' : ''}${detailsOpen && hasDetails ? ' has-details' : ''}`}>
      <Sidebar />
      {view === 'tasks' ? <TasksView /> : view === 'sessions' ? <SessionsView /> : <ChatView />}
      {hasDetails && (
        <div className="details-slot" aria-hidden={!detailsOpen} ref={node => { if (node) node.inert = !detailsOpen; }}>
          <DetailsPanel open={detailsOpen} />
        </div>
      )}
      {/* After the details panel on purpose: the Mac window applies drag strips in page order, so the panel's
          draggable top strip, coming later, swallowed clicks on Share and the side-panel button (owner, Nov 25). */}
      {hasDetails && <ConversationActions key={selectedBotId} detailsOpen={detailsOpen} />}
      {modal === 'create' && <CreateBotModal />}
      {modal === 'group' && <CreateGroupModal />}
      {modal === 'search' && <SearchModal />}
      {modal === 'screenshots' && <ScreenshotPicker />}
      {forwarding && <ForwardPicker />}
      {modal === 'apps' && <ConnectAppsModal />}
      {modal === 'usage' && <UsageDashboard />}
      {modal === 'team' && <TeamModal />}
      {viewerOpen && <ComputerViewer />}
      <ConfigLayer />
      <FieldDictation />
      <ComposerDictationHost />
      <FeatureLayer />
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
