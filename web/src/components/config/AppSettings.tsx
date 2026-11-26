import { HandoffSettings } from '../HandoffControls';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowUpRight, Bell, ChevronLeft, ChevronRight, Cpu, History, Keyboard, LayoutGrid, Link2, Mic, Monitor, RefreshCw, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { BUILD, updateAvailable, updateBusy, useAppUpdate } from '../../lib/appUpdate';
import { useCompactLayout } from '../../lib/layout';
import { MeterIcon } from '../MeterIcon';
import { createPortal } from 'react-dom';
import type { Toolkit } from '@shared/types';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { configApi, type ComputerDetails } from '../../lib/configApi';
import { relativeShort } from '../../lib/time';
import { useConfigUI, type AppSection } from '../../configStore';
import { DEFAULT_CUSTOM_THEME, THEME_OPTIONS, themeColors, themeStyle, type CustomTheme, type ResolvedTheme, type Theme } from '../../lib/themes';
import { ColorPicker } from '../ColorPicker';
import { Reveal, useOnlyOneOpen } from '../Reveal';
import { openBotChat } from '../botMenuItems';
import { useStore } from '../../store';
import { computerStatusText } from '../DetailsPanel';
import { ToolkitLogo } from '../ToolkitLogo';
import { AudioSettings, ComposioSettings, LocalModelSettings, SubscriptionSettings } from './LocalSettings';
import { ConfirmButton, Switch } from './ui';
import { LifeLinkSection, NotificationsSection } from '../features/FeatureSettings';
import { featuresApi, type AgentSettings } from '../../lib/featuresApi';
import { DEFAULT_DICTATION_SHORTCUT, dictationShortcut, setDictationShortcut, shortcutFor, shortcutLabel } from '../../voice/shortcut';

type Row = { id: AppSection | 'usage' | 'sessions'; label: string; icon: ReactNode; value?: ReactNode };

/** Full-window on a phone, a centered sheet on a Mac: grouped rows like the iOS Settings app. */
export function AppSettings() {
  const localWorkspace = useStore((s) => s.localWorkspace);
  const mobilePaired = useStore((s) => s.mobilePaired);
  const user = useStore((s) => s.user);
  const storePage = useConfigUI((s) => s.appSettings);
  const closeNow = useConfigUI((s) => s.closeAppSettings);
  // Keep showing the last page while the sheet animates away; reopening mid-exit cancels the exit.
  const [shownPage, setShownPage] = useState(storePage);
  const page = storePage ?? shownPage;
  const closing = !storePage && !!shownPage;
  const open = useConfigUI((s) => s.openAppSettings);
  const compact = useCompactLayout();
  const update = useAppUpdate((s) => s.status);
  const [drag, setDrag] = useState<number | null>(null);
  const gesture = useRef<{ id: number; y: number; t: number } | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const isLocalMac = localWorkspace && !mobilePaired;

  useEffect(() => {
    if (storePage) { setShownPage(storePage); setDrag(null); return; }
    const timer = window.setTimeout(() => setShownPage(null), 300);
    return () => clearTimeout(timer);
  }, [storePage]);
  const close = closeNow;

  useEffect(() => {
    if (!storePage) return;
    const k = (e: KeyboardEvent) => { if (!e.defaultPrevented && e.key === 'Escape' && !document.querySelector('.modal-root')) { e.preventDefault(); close(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [close, storePage]);
  useEffect(() => { if (storePage && isLocalMac) void useAppUpdate.getState().check(); }, [storePage === null, isLocalMac]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!page) return null;
  const section: AppSection | null = page === 'home' ? (compact ? null : 'general') : page;

  const groups: Row[][] = [
    [
      { id: 'general', label: 'General', icon: <SlidersHorizontal size={19} /> },
      { id: 'models', label: 'Models', icon: <Cpu size={19} /> },
      { id: 'audio', label: 'Audio', icon: <Mic size={19} /> },
      { id: 'notifications', label: 'Notifications', icon: <Bell size={19} /> },
      { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard size={19} /> },
    ],
    [
      { id: 'computer', label: 'Computer', icon: <Monitor size={19} /> },
      { id: 'permissions', label: 'Permissions', icon: <ShieldCheck size={19} /> },
      { id: 'apps', label: 'Connected apps', icon: <LayoutGrid size={19} /> },
      { id: 'life', label: 'Marion Life', icon: <Link2 size={19} /> },
    ],
    [
      { id: 'usage', label: 'Subscription usage', icon: <MeterIcon size={19} /> },
      { id: 'sessions', label: 'Sessions', icon: <History size={19} /> },
      ...(isLocalMac ? [{ id: 'updates' as const, label: 'Updates', icon: <ArrowDownToLine size={19} />,
        value: updateBusy(update) ? 'Updating…' : updateAvailable(update) ? <span className="sheet-badge">Update</span> : update?.supported ? 'Up to date' : undefined }] : []),
    ],
  ];
  const choose = (id: Row['id']) => {
    if (id === 'usage') { closeNow(); useStore.getState().setModal('usage'); return; }
    if (id === 'sessions') { closeNow(); useConfigUI.getState().setView('sessions'); return; }
    open(id);
  };
  const title = compact && section ? labelFor(section) : 'Settings';

  // Phone: drag the header down to dismiss, like an iOS sheet.
  const down = (e: React.PointerEvent) => {
    if (!compact || (e.target as HTMLElement).closest('button')) return;
    gesture.current = { id: e.pointerId, y: e.clientY, t: performance.now() };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    if (gesture.current?.id !== e.pointerId) return;
    const dy = e.clientY - gesture.current.y;
    setDrag(dy > 0 ? dy : dy / 6);
  };
  const up = (e: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const dy = e.clientY - g.y;
    const velocity = dy / Math.max(1, performance.now() - g.t);
    setDrag(null);
    if (dy > 140 || velocity > 0.6) close();
  };

  return createPortal(
    <div className={`sheet-root${closing ? ' is-closing' : ''}`} aria-hidden={closing || undefined} ref={node => { if (node) node.inert = closing; }}>
      <div className="sheet-scrim" onClick={close} style={drag !== null ? { opacity: Math.max(0, 1 - drag / 500) } : undefined} />
      <div ref={sheet} className={`sheet settings-sheet${drag !== null ? ' is-dragging' : ''}${section && compact ? ' is-pushed' : ''}`}
        role="dialog" aria-modal="true" aria-label="Settings" style={drag !== null ? { transform: `translateY(${drag}px)` } : undefined}>
        <header className="sheet__header" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <span className="sheet__grabber" aria-hidden />
          {compact && section && <button type="button" className="sheet-back" onClick={() => open('home')} aria-label="Back to Settings"><ChevronLeft size={22} /></button>}
          <h1 key={title}>{title}</h1>
          <button type="button" className="sheet-done" onClick={close}>Done</button>
        </header>
        <div className="settings-sheet__body">
          <nav className="settings-home" aria-label="Settings sections" aria-hidden={compact && !!section}>
            <button type="button" className={`sheet-account${section === 'account' ? ' is-active' : ''}`} onClick={() => open('account')}>
              <span className="account__initials">{(user?.name ?? '?').trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase()}</span>
              <span className="sheet-row__label"><strong>{user?.name ?? 'Account'}</strong><small>{user?.email || (isLocalMac ? 'This Mac' : 'Paired device')}</small></span>
              <ChevronRight size={18} className="sheet-row__chev" />
            </button>
            {groups.map((rows, i) => (
              <div className="sheet-group" key={i}>
                {rows.map(row => (
                  <button key={row.id} type="button" className={`sheet-row${section === row.id ? ' is-active' : ''}`} onClick={() => choose(row.id)}
                    aria-current={section === row.id || undefined}>
                    <span className="sheet-row__icon">{row.icon}</span>
                    <span className="sheet-row__label">{row.label}</span>
                    {row.value && <span className="sheet-row__value">{row.value}</span>}
                    {(row.id === 'usage' || row.id === 'sessions') ? <ArrowUpRight size={16} className="sheet-row__chev" /> : <ChevronRight size={18} className="sheet-row__chev" />}
                  </button>
                ))}
              </div>
            ))}
            <p className="sheet-version">Marion Agent · build {BUILD}</p>
          </nav>
          {section && (
            <div className="settings-page" key={section}>
              <div className="app-settings__page">
                {section === 'general' && <GeneralSection />}
                {section === 'models' && <><PageHead title="Models" />{localWorkspace && !mobilePaired && <HandoffSettings />}{localWorkspace && <SubscriptionSettings />}<LocalModelSettings /></>}
                {section === 'audio' && <><PageHead title="Audio" /><AudioSettings /></>}
                {section === 'shortcuts' && <><PageHead title="Shortcuts" /><ShortcutsSection /></>}
                {section === 'computer' && <ComputerSection />}
                {section === 'permissions' && <PermissionsSection />}
                {section === 'apps' && <AppsSection />}
                {section === 'notifications' && <NotificationsSection />}
                {section === 'life' && <LifeLinkSection />}
                {section === 'account' && <AccountSection />}
                {section === 'updates' && <UpdatesSection />}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

const LABELS: Record<AppSection, string> = {
  general: 'General', models: 'Models', audio: 'Audio', notifications: 'Notifications', shortcuts: 'Shortcuts', computer: 'Computer',
  permissions: 'Permissions', apps: 'Connected apps', life: 'Marion Life', account: 'Account', updates: 'Updates',
};
const labelFor = (section: AppSection) => LABELS[section];

function UpdatesSection() {
  const { status, checking, error, check, install, setAuto } = useAppUpdate();
  const autoUpdate = status?.autoUpdate !== false; // on by default
  const busy = updateBusy(status);
  const available = updateAvailable(status);
  return (
    <>
      <PageHead title="Updates" />
      <section className={`update-card${available ? ' is-available' : ''}${busy ? ' is-busy' : ''}`}>
        <img src="/favicon.svg" width="56" height="56" alt="" className="update-card__icon" />
        <div className="update-card__text">
          <strong>Marion Agent</strong>
          <span>Build {BUILD}{status?.latest && status.latest !== BUILD ? ` · latest ${status.latest}` : ''}</span>
          <span className="update-card__state" role="status">
            {busy ? status!.install.message
              : status?.install.state === 'failed' ? status.install.message
              : checking && !status ? 'Checking for updates…'
              : !status ? '' : !status.supported ? status.reason
              : available ? `${status.behind} new change${status.behind === 1 ? '' : 's'} ready to install`
              : 'You’re up to date'}
          </span>
        </div>
        {available || busy ? (
          <button type="button" className="update-pill is-primary" disabled={busy || checking || (!busy && status?.dirty)} onClick={() => void install()}>
            {busy ? <><span className="update-pill__spinner" aria-hidden />Updating</> : <><ArrowDownToLine size={15} />Update now</>}
          </button>
        ) : (
          <button type="button" className="update-pill" disabled={checking} onClick={() => void check()}>
            <RefreshCw size={14} className={checking ? 'is-spinning' : undefined} />{checking ? 'Checking' : 'Check now'}
          </button>
        )}
      </section>
      {error && <p role="alert" className="cfg-error">{error}</p>}
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Auto-update</div>
              <div className="cfg-row__sub">Install new versions by itself when nothing is running and you haven’t been chatting for a few minutes. Running bots and assistants keep going, and Marion Agent puts you back where you were.</div>
            </div>
            <Switch on={autoUpdate} onChange={(on) => void setAuto(on)} label="Auto-update" disabled={!status} />
          </div>
        </div>
      </section>
      {available && status!.changes.length > 0 && (
        <section className="cfg-section">
          <div className="cfg-section__label">What’s new</div>
          <ul className="update-changes">{status!.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </section>
      )}
      {available && status?.dirty && <p className="cfg-field__hint">Another chat has unsaved changes in the source folder. The update waits until that work is committed.</p>}
      <p className="cfg-field__hint">Updating builds the new version on this Mac while you keep working, then Marion Agent restarts by itself in a few seconds and reopens on the chat and view you were on. Bots and assistants that are working keep working through the restart; the new version takes over for them as soon as they finish. Your chats and settings stay as they are.</p>
    </>
  );
}

function PageHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="app-settings__head">
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ThemeSample({ preset }: { preset: ResolvedTheme }) {
  const custom = useConfigUI((s) => s.customTheme);
  return (
    <span className={`theme-sample theme-sample--${preset}`} style={themeStyle(preset, custom) as CSSProperties}>
      <span className="theme-sample__side"><i /><i /></span>
      <span className="theme-sample__pane"><i /><i /><b /></span>
    </span>
  );
}

function ThemeTile({ value, current, onPick }: { value: Theme; current: Theme; onPick: (theme: Theme) => void }) {
  return (
    <label className="theme-tile">
      <input type="radio" name="marion-theme" checked={current === value} onChange={() => onPick(value)} />
      <span className={`theme-tile__art${value === 'system' ? ' is-system' : ''}`} aria-hidden="true">
        {value === 'system' ? <><ThemeSample preset="light" /><ThemeSample preset="dark" /></> : <ThemeSample preset={value} />}
      </span>
      <span className="theme-tile__label">{value === 'system' ? 'System' : themeColors(value).label}</span>
    </label>
  );
}

const CUSTOM_ROWS: { key: keyof CustomTheme; label: string; sub: string }[] = [
  { key: 'background', label: 'Background', sub: 'The base every surface starts from' },
  { key: 'foreground', label: 'Text', sub: 'Words and icons' },
  { key: 'accent', label: 'Accent', sub: 'Buttons, switches and highlights' },
  { key: 'sidebar', label: 'Sidebar', sub: 'The chat list on the left' },
  { key: 'panel', label: 'Side panel', sub: 'The panel on the right and the window frame' },
  { key: 'chat', label: 'Chat', sub: 'Behind the conversation and cards' },
  { key: 'bubble', label: 'Your messages', sub: 'Your chat bubbles (instead of each bot’s color)' },
];
/** What an unset surface currently looks like, read from the live page. */
const surfaceNow = (key: keyof CustomTheme) => {
  const token = { sidebar: '--color-bg-sidebar', panel: '--color-bg-chrome', chat: '--color-bg-pane', bubble: '--color-bubble-user' }[key as 'sidebar'];
  const probe = document.createElement('span');
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  // Chrome reports color-mix() results as color(srgb 0–1 …), plain colors as rgb(0–255 …).
  const scale = color.startsWith('color(') ? 255 : 1;
  const rgb = (color.match(/-?\d*\.?\d+(e-?\d+)?/g) ?? []).slice(0, 3).map(n => Number(n) * scale);
  return `#${rgb.map(n => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
};

/** Three colors make a whole theme; every change shows straight away. */
function CustomThemeEditor() {
  const custom = useConfigUI((s) => s.customTheme);
  const setCustom = useConfigUI((s) => s.setCustomTheme);
  const [editing, setEditing] = useState<keyof CustomTheme | null>(null);
  useOnlyOneOpen(editing !== null, () => setEditing(null));
  const changed = CUSTOM_ROWS.some(({ key }) => custom[key] !== DEFAULT_CUSTOM_THEME[key]);
  const valueOf = (key: keyof CustomTheme) => custom[key] ?? surfaceNow(key);
  return (
    <div className="custom-theme" onKeyDown={event => { if (editing && event.key === 'Escape') { event.stopPropagation(); setEditing(null); } }}>
      {CUSTOM_ROWS.map(row => (
        <div key={row.key} className="custom-theme__item">
          <button type="button" className={`custom-theme__row${editing === row.key ? ' is-open' : ''}`} aria-expanded={editing === row.key}
            onClick={() => setEditing(current => current === row.key ? null : row.key)}>
            <span className="custom-theme__swatch" style={{ background: valueOf(row.key) }} aria-hidden="true" />
            <span className="custom-theme__text"><b>{row.label}</b><small>{row.sub}</small></span>
            <code>{custom[row.key] ? custom[row.key]!.toUpperCase() : 'Auto'}</code>
            <ChevronRight size={15} className="custom-theme__chevron" aria-hidden="true" />
          </button>
          <Reveal open={editing === row.key}>
            <div className="custom-theme__picker">
              <ColorPicker label={row.label} value={valueOf(row.key)} onChange={hex => setCustom({ ...useConfigUI.getState().customTheme, [row.key]: hex })} />
              {custom[row.key] && !(['background', 'foreground', 'accent'] as string[]).includes(row.key) && (
                <button type="button" className="link-btn link-btn--small" onClick={() => { const next = { ...useConfigUI.getState().customTheme }; delete next[row.key]; setCustom(next); }}>Use automatic color</button>
              )}
            </div>
          </Reveal>
        </div>
      ))}
      <div className="custom-theme__foot">
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!changed} onClick={() => { setEditing(null); setCustom(DEFAULT_CUSTOM_THEME); }}>Reset colors</button>
      </div>
    </div>
  );
}

/** Deleted chats wait here for 30 days before they are removed for good. */
function RecentlyDeleted() {
  const [list, setList] = useState<Awaited<ReturnType<typeof configApi.deletedBots>>['bots'] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const bots = useStore(s => s.bots.length);
  useEffect(() => { configApi.deletedBots().then(r => setList(r.bots)).catch(e => setError((e as Error).message)); }, [bots]);
  if (!list?.length && !error) return null;
  const restore = async (id: string) => {
    setBusy(id); setError('');
    try {
      await configApi.restoreBot(id);
      await useStore.getState().loadBots();
      setList(current => current?.filter(b => b.id !== id) ?? null);
      useConfigUI.getState().closeAppSettings();
      openBotChat(id);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Recently deleted</div>
      <div className="cfg-card">
        {(list ?? []).map(bot => {
          const days = Math.max(1, Math.ceil((bot.purgeAt - Date.now()) / 86_400_000));
          return (
            <div key={bot.id} className="cfg-row">
              <BotAvatarFor bot={bot} size={30} />
              <div className="cfg-row__text">
                <div className="cfg-row__title">{bot.name}</div>
                <div className="cfg-row__sub">Deleted {((r) => r === 'now' ? 'just now' : r === 'Yesterday' ? 'yesterday' : `${r} ago`)(relativeShort(bot.deletedAt))} · removed for good in {days} day{days === 1 ? '' : 's'}</div>
              </div>
              <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy === bot.id} onClick={() => void restore(bot.id)}>{busy === bot.id ? 'Restoring…' : 'Restore'}</button>
            </div>
          );
        })}
        {error && <div className="cfg-row"><div className="cfg-row__sub" role="alert">{error}</div></div>}
      </div>
    </section>
  );
}

/** How bots work: app control, live work steps, and how long teaching recordings are kept. */
function BotsSection() {
  const [state, setState] = useState<{ settings: AgentSettings; options: number[] } | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    featuresApi.agentSettings().then(r => setState({ settings: r.settings, options: r.recordingDayOptions })).catch(e => setError((e as Error).message));
    featuresApi.recordings().then(r => setCount(r.recordings.length)).catch(() => {});
  }, []);
  const save = async (patch: Partial<AgentSettings>) => {
    if (!state) return;
    const before = state.settings;
    setState({ ...state, settings: { ...before, ...patch } });
    setError('');
    try { const r = await featuresApi.saveAgentSettings(patch); setState(current => current && { ...current, settings: r.settings }); }
    catch (e) { setState(current => current && { ...current, settings: before }); setError((e as Error).message); }
  };
  if (!state) return error ? <p className="cfg-field__hint" role="alert">{error}</p> : null;
  const { settings, options } = state;
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Bots</div>
      <div className="cfg-card">
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Bots can change Marion Agent</div>
            <div className="cfg-row__sub">Any bot can rename, recolor, create, delete (recoverably) and switch the model of your bots when you ask it to.</div>
          </div>
          <Switch on={settings.appControl} onChange={appControl => void save({ appControl })} label="Bots can change Marion Agent" />
        </div>
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Live work steps</div>
            <div className="cfg-row__sub">Show each command and edit while Claude, Codex or Gemini work. Off shows only who is working and for how long. Uses no extra usage either way.</div>
          </div>
          <Switch on={settings.liveFeed} onChange={liveFeed => void save({ liveFeed })} label="Show live work steps" />
        </div>
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Keep screen recordings</div>
            <div className="cfg-row__sub">Teach-by-recording drafts stay in history, even if you close the window by accident.{count ? ` ${count} saved now.` : ''}</div>
          </div>
          <select className="text-input cfg-select" aria-label="Keep screen recordings for" value={settings.recordingDays} onChange={event => void save({ recordingDays: Number(event.target.value) })}>
            {options.map(days => <option key={days} value={days}>{days === 1 ? '1 day' : `${days} days`}</option>)}
          </select>
        </div>
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Recording history</div>
            <div className="cfg-row__sub">{count === null ? 'Checking…' : count ? `${count} recording${count === 1 ? '' : 's'} saved` : 'Nothing saved'}</div>
          </div>
          <ConfirmButton confirmLabel="Clear all" disabled={!count} onConfirm={async () => { await featuresApi.clearRecordings(); setCount(0); }}>Clear history</ConfirmButton>
        </div>
      </div>
      {error && <p className="cfg-field__hint" role="alert">{error}</p>}
    </section>
  );
}

function GeneralSection() {
  const theme = useConfigUI((s) => s.theme);
  const setTheme = useConfigUI((s) => s.setTheme);
  const showTokens = useConfigUI((s) => s.showTokenStats);
  const setShowTokens = useConfigUI((s) => s.setShowTokenStats);
  const fileAccess = useConfigUI((s) => s.fileAccess);
  const setFileAccess = useConfigUI((s) => s.setFileAccess);
  const localWorkspace = useStore(s => s.localWorkspace);
  const mobilePaired = useStore(s => s.mobilePaired);
  return (
    <>
      <PageHead title="General" />
      <section className="cfg-section">
        <div className="cfg-section__label">Theme</div>
        <div className="theme-tiles" role="radiogroup" aria-label="Theme">
          {THEME_OPTIONS.map((value) => <ThemeTile key={value} value={value} current={theme} onPick={setTheme} />)}
        </div>
        <Reveal open={theme === 'custom'}><CustomThemeEditor /></Reveal>
        <div className="cfg-field__hint">System follows your device’s light or dark setting. Custom uses the colors you pick.</div>
      </section>
      <BotsSection />
      <RecentlyDeleted />
      <section className="cfg-section">
        <div className="cfg-section__label">Chat</div>
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Show token counts</div>
              <div className="cfg-row__sub">Show the model and “in · out tokens” under each reply and on calls.</div>
            </div>
            <Switch on={showTokens} onChange={setShowTokens} label="Show token counts under replies" />
          </div>
        </div>
      </section>
      {localWorkspace && !mobilePaired && <section className="cfg-section">
        <div className="cfg-section__label">This Mac</div>
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">File access</div>
              <div className="cfg-row__sub">Lets Marion Agent use your folders, like the source folder it updates from. Turn off and macOS won’t ask about your files when the app opens.</div>
            </div>
            <Switch on={fileAccess} onChange={(on) => { setFileAccess(on); void useAppUpdate.getState().check(); }} label="Let Marion Agent use files on this Mac" />
          </div>
        </div>
      </section>}
      {localWorkspace && !mobilePaired && <>
        <DeviceAccessSection kind="mobile" />
        <DeviceAccessSection kind="browser" />
      </>}
    </>
  );
}

function DeviceAccessSection({ kind }: { kind: 'mobile' | 'browser' }) {
  const phone = kind === 'mobile';
  const device = phone ? 'iPhone' : 'Browser';
  const [origin, setOrigin] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [session, setSession] = useState<{ hours: number; choices: number[] } | null>(null);
  const [savingSession, setSavingSession] = useState(false);
  useEffect(() => {
    configApi.deviceAccess(kind).then(result => {
      setOrigin(result.origin);
      if (result.sessionHours && result.sessionChoices) setSession({ hours: result.sessionHours, choices: result.sessionChoices });
    }).catch(() => {});
  }, [kind]);
  if (!origin) return null;
  const showPairing = async () => {
    if (passphrase) { setPassphrase(null); return; }
    setError('');
    try { setPassphrase((await configApi.deviceAccess(kind, true)).passphrase); }
    catch (cause) { setError((cause as Error).message); }
  };
  const saveSession = async (hours: number) => {
    if (!session) return;
    const previous = session.hours;
    setSession({ ...session, hours });
    setSavingSession(true);
    setError('');
    try { await configApi.saveBrowserSession(hours); }
    catch (cause) { setSession({ ...session, hours: previous }); setError((cause as Error).message); }
    finally { setSavingSession(false); }
  };
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">{device} access</div>
      <p className="cfg-field__hint">{phone ? 'Open this private address in Safari to pair with your workspace.' : 'Open this address in an approved browser and sign in before pairing with your workspace.'}</p>
      <input className="text-input" value={origin} readOnly aria-label={`${device} Marion Agent address`} onFocus={event => event.target.select()} />
      <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void showPairing()}>{passphrase ? 'Hide passphrase' : 'Show pairing passphrase'}</button>
      {passphrase && <input className="text-input" value={passphrase} readOnly aria-label={`${device} pairing passphrase`} onFocus={event => event.target.select()} />}
      {session && <>
        <label htmlFor="browser-session-length" className="cfg-field__hint">Stay signed in for</label>
        <select id="browser-session-length" className="text-input" value={session.hours} disabled={savingSession} onChange={event => void saveSession(Number(event.target.value))}>
          {session.choices.map(hours => <option key={hours} value={hours}>{sessionLabel(hours)}</option>)}
        </select>
        <p className="cfg-field__hint">Shorter times apply right away. Longer times apply the next time a browser pairs. Sign out on shared computers.</p>
      </>}
      {error && <p role="alert" className="cfg-error">{error}</p>}
    </section>
  );
}

function sessionLabel(hours: number) {
  if (hours % (7 * 24) === 0) return hours === 7 * 24 ? '1 week' : `${hours / (7 * 24)} weeks`;
  if (hours >= 24 && hours % 24 === 0) return hours === 24 ? '1 day' : `${hours / 24} days`;
  return `${hours} hours`;
}

function ShortcutsSection() {
  const modifier = /Mac/.test(navigator.platform) ? 'Command' : 'Control';
  const [shortcut, setShortcut] = useState(dictationShortcut);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState('');
  const choose = (value: string) => {
    setDictationShortcut(value);
    setShortcut(value);
    setRecording(false);
    setError('');
  };
  return (
    <section className="cfg-section">
      <div className="local-settings__controls">
        <span>Start or stop dictation</span>
        <button type="button" className="cfg-btn cfg-btn--secondary" aria-label="Change dictation shortcut" onClick={() => { setRecording(true); setError(''); }}
          onKeyDown={e => {
            if (!recording) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') { setRecording(false); return; }
            const next = shortcutFor(e.nativeEvent);
            if (!next) return;
            if ((e.ctrlKey || e.metaKey) && ['KeyB', 'KeyI', 'KeyK', 'KeyR'].includes(e.code)) {
              setError('That combination is already used in Marion Agent.');
            } else choose(next);
          }}
          onBlur={() => setRecording(false)}>
          {recording ? 'Press new shortcut…' : shortcutLabel(shortcut)}
        </button>
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => choose(DEFAULT_DICTATION_SHORTCUT)} disabled={shortcut === DEFAULT_DICTATION_SHORTCUT && !recording}>Reset</button>
      </div>
      {error && <p role="alert" className="cfg-error">{error}</p>}
      <div className="cfg-card">
        {[
          ['Cancel dictation', 'Escape'],
          ['Find a chat', modifier + '+K'],
          ['Focus the chat composer', modifier + '+I'],
          ['Toggle the sidebar', modifier + '+B'],
          ['Toggle chat details', modifier + '+Shift+,'],
          ['Open settings', modifier + '+,'],
          ['Reload Marion Agent', modifier + '+R'],
        ].map(([label, keys]) => <div className="cfg-row" key={label}><span className="cfg-row__text">{label}</span><kbd>{keys}</kbd></div>)}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------


function ComputerSection() {
  const computer = useStore((s) => s.computer);
  const bots = useStore((s) => s.bots);
  const [details, setDetails] = useState<ComputerDetails | null>(null);
  const [busy, setBusy] = useState<'wake' | 'sleep' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => { configApi.computerDetails().then(setDetails).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load, computer?.status, computer?.screens.length]);

  const status = computer?.status ?? details?.computer.status;
  const running = status === 'running';
  const transitioning = status === 'starting' || status === 'resuming' || status === 'creating' || status === 'suspending';
  const act = async (kind: 'wake' | 'sleep') => {
    setBusy(kind); setNote(null);
    try { kind === 'wake' ? await configApi.wake() : await configApi.sleep(); }
    catch (e) { setNote((e as Error).message); }
    finally { setBusy(null); }
  };
  const byId = new Map(bots.map((b) => [b.id, b]));

  return (
    <>
      <PageHead title="Computers" sub="Each Bot has its own Linux desktop and workspace." />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <span className={`computer-status-dot is-${running ? 'on' : transitioning ? 'busy' : 'off'}`} aria-hidden />
            <div className="cfg-row__text">
              <div className="cfg-row__title">Bot desktops · {computerStatusText(computer ?? null)}</div>
              <div className="cfg-row__sub">
                {details ? `Desktops stop after ${details.hibernation.idleMinutes} idle minutes when nobody is watching. A Bot’s desktop starts again when it has work.` : 'Checking…'}
              </div>
            </div>
            {running || status === 'suspending' ? (
              <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!running || !!busy} onClick={() => act('sleep')}>{busy === 'sleep' || status === 'suspending' ? 'Going to sleep…' : 'Sleep'}</button>
            ) : (
              <button type="button" className="cfg-btn cfg-btn--primary" disabled={transitioning || !!busy} onClick={() => act('wake')}>{busy === 'wake' || transitioning ? 'Waking…' : 'Wake'}</button>
            )}
          </div>
          {computer?.error && status === 'error' && <div className="cfg-error cfg-error--inset">{computer.error}</div>}
          {note && <div className="cfg-error cfg-error--inset">{note}</div>}
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Desktop workspaces</div>
        <div className="cfg-card">
          {!details ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : details.screens.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">No Bot has opened a desktop yet.</div>
          ) : details.screens.map((s) => {
            const bot = byId.get(s.botId);
            return (
              <div key={s.botId} className="cfg-row">
                {bot ? <BotAvatarFor bot={bot} size={28} /> : <span className="cfg-row__ph" />}
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{bot?.name ?? 'Removed Bot'}</div>
                  <div className="cfg-row__sub">Last used {relativeShort(s.lastUsedAt) === 'now' ? 'just now' : `${relativeShort(s.lastUsedAt)}${/^\d/.test(relativeShort(s.lastUsedAt)) ? ' ago' : ''}`}</div>
                </div>
                <ConfirmButton
                  className="cfg-btn cfg-btn--secondary"
                  confirmLabel="Stop desktop"
                  disabled={!running}
                  title={running ? 'Closes open apps and keeps workspace files' : 'Wake a desktop first'}
                  onConfirm={async () => { try { await configApi.resetScreen(s.botId); setNote(null); load(); } catch (e) { setNote((e as Error).message); } }}
                >
                  Stop
                </ConfirmButton>
              </div>
            );
          })}
        </div>
        <div className="cfg-field__hint">Stopping a desktop closes its apps and keeps the bot’s browser profile and Library files.</div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

function humanizeTool(slug: string): { app: string; action: string } {
  const parts = slug.split(/[_:]/).filter(Boolean);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  if (parts.length < 2) return { app: cap(slug), action: '' };
  return { app: cap(parts[0]), action: cap(parts.slice(1).join(' ')) };
}

function PermissionsSection() {
  const [policies, setPolicies] = useState<{ tool: string; mode: string }[] | null>(null);
  const load = useCallback(() => { configApi.policies().then((r) => setPolicies(r.policies)).catch(() => setPolicies([])); }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <PageHead title="Permissions" sub="Actions your Bots can take without asking first. Remove one and they’ll ask again next time." />
      <section className="cfg-section">
        <div className="cfg-card">
          {policies === null ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : policies.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">Nothing here yet. When you choose “Always allow” on an approval, it shows up here.</div>
          ) : policies.map((p) => {
            const h = humanizeTool(p.tool);
            return (
              <div key={p.tool} className="cfg-row">
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{h.app}{h.action ? ` · ${h.action}` : ''}</div>
                  <div className="cfg-row__sub">{p.mode === 'always_allow' ? 'Always allowed' : p.mode === 'blocked' ? 'Never allowed' : 'Asks first'} · <code className="cfg-code">{p.tool}</code></div>
                </div>
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => configApi.deletePolicy(p.tool).then(load).catch(() => {})}>Ask again</button>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

function AppsSection() {
  const version = useStore((s) => s.connectionsVersion);
  const [apps, setApps] = useState<Toolkit[] | null>(null);
  useEffect(() => { configApi.connectedApps().then((r) => setApps(r.connectedApps ?? [])).catch(() => setApps([])); }, [version]);
  const openApps = () => { useConfigUI.getState().closeAppSettings(); useStore.getState().setModal('apps'); };
  return (
    <>
      <PageHead title="Connected apps" />
      <ComposioSettings onReady={openApps} />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">{apps === null ? 'Checking…' : apps.length ? `${apps.length} app${apps.length === 1 ? '' : 's'} connected` : 'No apps connected yet'}</div>
              <div className="cfg-row__sub">Bots ask before doing anything that changes data in an app.</div>
            </div>

          </div>
          {apps?.map((a) => (
            <div key={a.slug} className="cfg-row">
              <ToolkitLogo name={a.name} logo={a.logo} size={28} radius={7} />
              <div className="cfg-row__text">
                <div className="cfg-row__title">{a.name}</div>
                {a.description && <div className="cfg-row__sub">{a.description}</div>}
              </div>
              <span className="cfg-chip">Connected</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

function AccountSection() {
  const user = useStore((s) => s.user);
  const localWorkspace = useStore((s) => s.localWorkspace);
  const mobilePaired = useStore((s) => s.mobilePaired);
  const [busy, setBusy] = useState(false);
  const initials = (user?.name ?? user?.email ?? '?').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <>
      <PageHead title="Account" />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <span className="account__initials">{initials}</span>
            <div className="cfg-row__text">
              <div className="cfg-row__title">{user?.name}</div>
              <div className="cfg-row__sub">{user?.email}</div>
            </div>
            {(!localWorkspace || mobilePaired) && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={async () => { setBusy(true); await configApi.logout().catch(() => {}); location.reload(); }}>
              {busy ? 'Signing out…' : 'Sign out'}
            </button>}
          </div>
        </div>
      </section>
    </>
  );
}
