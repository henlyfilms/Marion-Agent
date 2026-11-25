import { useEffect, useRef, useState } from 'react';
import type { Bot, ComputerState, Routine } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { api, openPopup } from '../lib/api';
import { prefGet, prefSet } from '../lib/prefs';
import { botVars } from '../lib/colors';
import { displayName, useSelectedBot, useStore } from '../store';
import { Icon } from './Icon';
import { ToolkitLogo } from './ToolkitLogo';
import { VoiceSettings } from './VoiceSettings';
import { MembersCard } from './MembersCard';
import { useConfigUI } from '../configStore';
import { Glyph } from './config/glyphs';
import { LibraryTab } from './config/LibraryTab';
import { BotTasks } from './config/TasksView';
import { useContextMenu } from './ContextMenu';
import { SegmentPill } from './SegmentPill';
import { botMenuItems } from './botMenuItems';
import { setDetailsOpen } from '../lib/layout';
import { featuresApi, useFeatureUI } from '../lib/featuresApi';
import { ModelUsage } from './features/ModelUsage';
import { ContextCard } from './features/ContextCard';

export function computerStatusText(c: ComputerState | null): string {
  switch (c?.status) {
    case 'running': return 'Awake';
    case 'starting': case 'resuming': return 'Waking up…';
    case 'creating': return 'Setting up…';
    case 'suspending': return 'Going to sleep…';
    case 'error': return 'Unreachable';
    case 'suspended': case 'stopped': case 'absent': case undefined: return 'Asleep';
    default: return 'Asleep';
  }
}

/** Turn a raw desktop error (often a long Docker socket message) into one short, readable line. */
export function friendlyComputerError(error: string | null | undefined): string {
  if (!error) return '';
  if (/docker (api|daemon)|docker\.sock|colima|cannot connect to the docker/i.test(error)) return 'Docker isn’t running. Start Colima or Docker Desktop.';
  if (/no such image|pull access|image.+not found/i.test(error)) return 'The desktop image is missing. Rebuild it in Settings.';
  const line = error.replace(/\s+/g, ' ').trim();
  return line.length > 90 ? `${line.slice(0, 88)}…` : line;
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle${on ? ' is-on' : ''}`} onClick={() => onChange(!on)}>
      <span className="toggle__knob" />
    </button>
  );
}

function RoutineRow({ r }: { r: Routine }) {
  const [enabled, setEnabled] = useState(r.enabled);
  const contextMenu = useContextMenu();
  useEffect(() => setEnabled(r.enabled), [r.enabled]);
  const toggle = async (v: boolean) => {
    setEnabled(v);
    try { await api.setRoutine(r.id, v); }
    catch (error) { setEnabled(!v); throw error; }
  };
  return (
    <div className="panel-row panel-row--routine" title={r.prompt} tabIndex={0}
      {...contextMenu(r.name, () => [
        { label: enabled ? 'Pause routine' : 'Resume routine', onSelect: () => toggle(!enabled) },
        { label: 'Manage routines…', onSelect: () => useConfigUI.getState().openBotSettings(r.botId, 'routines') },
      ])}>
      <span className="panel-row__icon"><Icon name="clock" opacity={0.52} /></span>
      <span className="panel-row__text">
        <span className="panel-row__title">{r.name}</span>
        <span className="panel-row__sub">{enabled ? r.description || r.schedule : 'Paused'}</span>
      </span>
      <Toggle on={enabled} onChange={(value) => toggle(value).catch(() => {})} label={`${r.name} ${enabled ? 'on' : 'off'}`} />
    </div>
  );
}

function ComputerCard({ bot, open }: { bot: Bot; open: boolean }) {
  const computer = useStore((s) => s.computer);
  const set = useStore((s) => s.set);
  const contextMenu = useContextMenu();
  const [shot, setShot] = useState<string | null>(null);
  const [switching, setSwitching] = useState<'wake' | 'sleep' | null>(null);
  const [switchError, setSwitchError] = useState('');
  const running = computer?.screens.some(screen => screen.botId === bot.id && screen.running) ?? false;

  // Refresh the thumbnail every ~4s while visible and awake. 204 = no screen yet.
  useEffect(() => {
    setShot(null);
    if (!running || !open) return;
    let alive = true;
    let url: string | null = null;
    const load = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch(`/api/bots/${bot.id}/screenshot`, { credentials: 'include', cache: 'no-store' });
        if (!alive) return;
        if (res.status === 204) { setShot(null); return; }
        if (res.status === 200) {
          const blob = await res.blob();
          if (!alive) return;
          const next = URL.createObjectURL(blob);
          setShot(next);
          if (url) URL.revokeObjectURL(url);
          url = next;
        }
      } catch { /* keep last frame */ }
    };
    load();
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); if (url) URL.revokeObjectURL(url); };
  }, [bot.id, running, open]);

  const busy = computer?.status === 'starting' || computer?.status === 'resuming' || computer?.status === 'creating';
  const computerMenu = contextMenu("Bot's computer", () => [
    { label: 'Open computer', onSelect: () => set({ viewerOpen: true }) },
    ...(!running && !busy ? [{ label: 'Wake computer', onSelect: () => featuresApi.setComputerAwake(bot.id, true) }] : []),
    ...(running ? [{ label: 'Put computer to sleep', onSelect: () => featuresApi.setComputerAwake(bot.id, false) }] : []),
  ]);
  return (
    <div className="panel-card">
      <div className="panel-row panel-row--computer" role="button" tabIndex={0} onClick={() => set({ viewerOpen: true })}
        {...computerMenu} onKeyDown={(e) => {
          computerMenu.onKeyDown(e);
          if (e.key === 'Enter') set({ viewerOpen: true });
        }}>
        <span className="panel-row__text">
          <span className="panel-row__title">Bot's computer</span>
          <span className="panel-row__meta" title={computer?.error && computer.status === 'error' ? computer.error : undefined}>{computerStatusText(computer)}{computer?.error && computer.status === 'error' ? ` · ${friendlyComputerError(computer.error)}` : ''}</span>
        </span>
        <span className={`computer-thumb${shot ? ' has-shot' : ''}`}>
          {shot ? <img src={shot} alt="Bot's screen" /> : running || busy ? (
            <span className="computer-thumb__awake"><span className={`status-dot ${busy ? 'is-attention' : 'is-working'}`} /></span>
          ) : (
            <>
              <span className="computer-thumb__face"><i /><i /></span>
              <span className="computer-thumb__z1">z</span>
              <span className="computer-thumb__z2">z</span>
            </>
          )}
        </span>
      </div>
      <div className="panel-row panel-row--switch">
        <Icon name="monitor" size={14} opacity={0.56} />
        <span className="panel-row__title" style={{ flex: 1 }}>{switching ? (switching === 'wake' ? 'Waking up…' : 'Going to sleep…') : running ? 'Computer awake' : 'Computer asleep'}</span>
        <Toggle on={switching ? switching === 'wake' : running || busy} label={running ? "Put the bot's computer to sleep" : "Wake the bot's computer"} onChange={(awake) => {
          if (switching) return;
          setSwitching(awake ? 'wake' : 'sleep');
          setSwitchError('');
          featuresApi.setComputerAwake(bot.id, awake).catch(e => setSwitchError((e as Error).message)).finally(() => setSwitching(null));
        }} />
      </div>
      {switchError && <p className="panel-row__error" role="alert" title={switchError}>{switchError}</p>}
    </div>
  );
}

export function DetailsPanel({ open }: { open: boolean }) {
  const bot = useSelectedBot();
  const routines = useStore((s) => (bot ? s.routines[bot.id] : undefined));
  const [tab, setTab] = useState<'activity' | 'tasks' | 'library'>('activity');
  // Which way the content slides when the tab changes (never on first paint or bot switch).
  const slide = useRef<{ tab: string; dir: '' | 'left' | 'right' }>({ tab, dir: '' });
  if (slide.current.tab !== tab) {
    const order = ['activity', 'tasks', 'library'];
    slide.current = { tab, dir: order.indexOf(tab) > order.indexOf(slide.current.tab) ? 'left' : 'right' };
  }
  const [hideSuggested, setHideSuggested] = useState(() => prefGet('hideSuggested') === '1');
  const contextMenu = useContextMenu();
  if (!bot) return null;

  const identityMenu = contextMenu(displayName(bot), () => botMenuItems(bot));
  const addSlack = async () => {
    const popup = openPopup('about:blank');
    try { const { redirectUrl } = await api.connect('slack'); if (popup) popup.location.href = redirectUrl; } catch { popup?.close(); }
  };

  return (
    <aside id="conversation-details" className="details" style={botVars(bot.avatarColor)} aria-label="Conversation details">
      <div className="details__top">
        <button type="button" className="icon-btn icon-btn--bordered details__gear" onClick={() => useConfigUI.getState().openBotSettings(bot.id)} aria-label="Bot settings" title="Bot settings">
          <Glyph name="gear" size={16} opacity={0.7} />
        </button>
        <button type="button" className="icon-btn icon-btn--bordered details__close" onClick={() => {
          setDetailsOpen(false);
          requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.details-toggle')?.focus());
        }} aria-label="Close details">
          <Icon name="close" opacity={0.92} />
        </button>
      </div>
      <div className="details__navigation">
        <div className="details__identity" tabIndex={0} role="button" title="View profile"
          onClick={() => bot.kind !== 'room' && useFeatureUI.getState().set({ profile: { kind: 'bot', id: bot.id } })}
          {...identityMenu}
          onKeyDown={(e) => { identityMenu.onKeyDown(e); if (e.key === 'Enter' && bot.kind !== 'room') useFeatureUI.getState().set({ profile: { kind: 'bot', id: bot.id } }); }}>
          <BotAvatarFor bot={bot} size={30} />
          <div className="details__name" title={displayName(bot)}>{displayName(bot)}</div>
        </div>
        <div className="details__tabs">
          <div className="segmented">
            <SegmentPill active={tab} />
            <button type="button" className={tab === 'activity' ? 'is-active' : ''} onClick={() => setTab('activity')} aria-pressed={tab === 'activity'}>Activity</button>
            <button type="button" className={tab === 'tasks' ? 'is-active' : ''} onClick={() => setTab('tasks')} aria-pressed={tab === 'tasks'}>Tasks</button>
            <button type="button" className={tab === 'library' ? 'is-active' : ''} onClick={() => setTab('library')} aria-pressed={tab === 'library'}>Library</button>
          </div>
        </div>
      </div>
      <div className={`details__scroll${slide.current.dir ? ` is-from-${slide.current.dir}` : ''}`} key={`${bot.id}:${tab}`}
        onAnimationEnd={(e) => { if (e.target === e.currentTarget) slide.current.dir = ''; }}>
        {tab === 'activity' ? (
          <div className="details__sections">
            {bot.kind !== 'room' && <>
              <section>
                <ContextCard key={bot.id} bot={bot} />
                <ModelUsage key={`usage-${bot.id}`} bot={bot} open={open} />
              </section>
              <section>
                <ComputerCard bot={bot} open={open} />
              </section>
            </>}
            <section>
              <div className="section-label section-label--row">
                <span>Routines</span>
                <button type="button" className="link-btn link-btn--small" onClick={() => useConfigUI.getState().openBotSettings(bot.id, 'routines')}>Manage</button>
              </div>
              <div className="panel-card">
                {routines?.length ? routines.map((r) => <RoutineRow key={r.id} r={r} />) : (
                  <div className="panel-empty">Nothing scheduled. Try asking in chat, for example “send me a summary every weekday at 8am”.</div>
                )}
              </div>
            </section>
            {bot.kind === 'room' && (
              <section>
                <div className="section-label">Members</div>
                <MembersCard room={bot} />
              </section>
            )}
            {bot.kind !== 'room' && !hideSuggested && (
              <section>
                <div className="section-label section-label--row">
                  <span>Suggested</span>
                  <button type="button" className="link-btn link-btn--small" onClick={() => { setHideSuggested(true); prefSet('hideSuggested', '1'); }}>Hide</button>
                </div>
                <div className="panel-card">
                  <button type="button" className="panel-row panel-row--link" onClick={addSlack}>
                    <span className="panel-row__glyph"><ToolkitLogo name="Slack" logo="https://logos.composio.dev/api/slack" size={16} radius={4} /></span>
                    <span className="panel-row__title" style={{ flex: 1 }}>Add to Slack</span>
                    <Icon name="chev_right" size={12} opacity={0.56} />
                  </button>
                </div>
              </section>
            )}
            {bot.kind !== 'room' && (
              <>
                <section>
                  <div className="section-label">Voice chat</div>
                  <VoiceSettings bot={bot} />
                </section>
              </>
            )}
          </div>
        ) : tab === 'tasks' ? <BotTasks bot={bot} /> : <LibraryTab bot={bot} />}
      </div>
    </aside>
  );
}
