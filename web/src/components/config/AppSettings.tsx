import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { Toolkit } from '@shared/types';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { configApi, type ComputerDetails } from '../../lib/configApi';
import { relativeShort } from '../../lib/time';
import { useConfigUI, type AppSection } from '../../configStore';
import { THEME_OPTIONS, THEME_PRESETS, themeStyle, type Theme } from '../../lib/themes';
import { useStore } from '../../store';
import { computerStatusText } from '../DetailsPanel';
import { Icon } from '../Icon';
import { ToolkitLogo } from '../ToolkitLogo';
import { Glyph } from './glyphs';
import { AudioSettings, ComposioSettings, LocalModelSettings, SubscriptionSettings } from './LocalSettings';
import { ConfirmButton } from './ui';
import { LifeLinkSection, NotificationsSection } from '../features/FeatureSettings';
import { DEFAULT_DICTATION_SHORTCUT, dictationShortcut, setDictationShortcut, shortcutFor, shortcutLabel } from '../../voice/shortcut';

const SECTIONS: { id: AppSection; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'models', label: 'Models' },
  { id: 'audio', label: 'Audio' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'computer', label: 'Computer' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'apps', label: 'Connected apps' },
  { id: 'life', label: 'Marion Life' },
  { id: 'account', label: 'Account' },
];

/** Full-window settings page, opened from the account menu. */
export function AppSettings() {
  const localWorkspace = useStore((s) => s.localWorkspace);
  const section = useConfigUI((s) => s.appSettings);
  const close = useConfigUI((s) => s.closeAppSettings);
  const open = useConfigUI((s) => s.openAppSettings);
  useEffect(() => {
    if (!section) return;
    const k = (e: KeyboardEvent) => { if (!e.defaultPrevented && e.key === 'Escape' && !document.querySelector('.modal-root')) { e.preventDefault(); close(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [close, section]);
  if (!section) return null;
  return createPortal(
    <div className="app-settings" role="dialog" aria-modal="true" aria-label="Settings">
      <aside className="app-settings__nav">
        <button type="button" className="app-settings__back" onClick={close}><Glyph name="arrow_left" size={14} /> Back to Bots</button>
        <div className="app-settings__heading">Marion Agent Settings</div>
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" className={`cfg-nav__item${section === s.id ? ' is-active' : ''}`} onClick={() => open(s.id)} aria-current={section === s.id || undefined}>
            {s.label}
          </button>
        ))}
      </aside>
      <div className="app-settings__main">
        <button type="button" className="app-settings__close icon-btn" onClick={close} aria-label="Close settings" title="Close (Esc)"><Icon name="close" opacity={0.8} /></button>
        <div className="app-settings__scroll" key={section}>
          <div className="app-settings__page">
            {section === 'general' && <GeneralSection />}
            {section === 'models' && <><PageHead title="Models" />{localWorkspace && <SubscriptionSettings />}<LocalModelSettings /></>}
            {section === 'audio' && <><PageHead title="Audio" /><AudioSettings /></>}
            {section === 'shortcuts' && <><PageHead title="Shortcuts" /><ShortcutsSection /></>}
            {section === 'computer' && <ComputerSection />}
            {section === 'permissions' && <PermissionsSection />}
            {section === 'apps' && <AppsSection />}
            {section === 'notifications' && <NotificationsSection />}
            {section === 'life' && <LifeLinkSection />}
            {section === 'account' && <AccountSection />}
          </div>
        </div>
      </div>
    </div>,
    document.body,
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

function ThemeSample({ preset }: { preset: Exclude<Theme, 'system'> }) {
  return (
    <span className={`theme-sample theme-sample--${preset}`} style={themeStyle(preset) as CSSProperties}>
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
      <span className="theme-tile__label">{value === 'system' ? 'System' : THEME_PRESETS[value].label}</span>
    </label>
  );
}

function GeneralSection() {
  const theme = useConfigUI((s) => s.theme);
  const setTheme = useConfigUI((s) => s.setTheme);
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
        <div className="cfg-field__hint">System follows your device’s light or dark setting.</div>
      </section>
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
  useEffect(() => {
    configApi.deviceAccess(kind).then(result => setOrigin(result.origin)).catch(() => {});
  }, [kind]);
  if (!origin) return null;
  const showPairing = async () => {
    if (passphrase) { setPassphrase(null); return; }
    setError('');
    try { setPassphrase((await configApi.deviceAccess(kind, true)).passphrase); }
    catch (cause) { setError((cause as Error).message); }
  };
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">{device} access</div>
      <p className="cfg-field__hint">{phone ? 'Open this private address in Safari to pair with your workspace.' : 'Open this address in an approved browser and sign in before pairing with your workspace.'}</p>
      <input className="text-input" value={origin} readOnly aria-label={`${device} Marion Agent address`} onFocus={event => event.target.select()} />
      <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void showPairing()}>{passphrase ? 'Hide passphrase' : 'Show pairing passphrase'}</button>
      {passphrase && <input className="text-input" value={passphrase} readOnly aria-label={`${device} pairing passphrase`} onFocus={event => event.target.select()} />}
      {error && <p role="alert" className="cfg-error">{error}</p>}
    </section>
  );
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
