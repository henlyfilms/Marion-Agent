import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AvatarColor, AvatarShape, Bot, Memory, Routine, Skill, UniversalSkill } from '@shared/types';
import type { WorkFxChoice } from '@shared/avatarShapes';
import { BotAvatar, BotAvatarFor } from '../../avatar/BotAvatar';
import { BotShapePicker } from '../../avatar/BotShapePicker';
import { BotColorPicker } from '../../avatar/BotColorPicker';
import { BotStemPicker } from '../../avatar/BotStemPicker';
import { botVars } from '../../lib/colors';
import { configApi, type BotSettingsBundle } from '../../lib/configApi';
import { useConfigUI, useVersion, type BotSettingsTab } from '../../configStore';
import { useStore } from '../../store';
import { featuresApi, type BotFolder, type BotProfileData, type LifeLink } from '../../lib/featuresApi';
import { Folder, Share, ShieldAlert } from 'lucide-react';
import { ToolkitLogo } from '../ToolkitLogo';
import { Icon } from '../Icon';
import { openBotChat } from '../botMenuItems';
import { computerStatusText } from '../DetailsPanel';
import { Modal } from '../modals/Modal';
import { Glyph } from './glyphs';
import { ConfirmButton, Field, Segmented, Switch, nextRunLabel, shortDate } from './ui';

const EFFORTS: { value: Bot['effort']; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Max' },
];

const EFFORT_HINT: Record<Bot['effort'], string> = {
  low: 'Fastest replies. Good for quick lookups and chit-chat.',
  medium: 'A good balance for most work.',
  high: 'Thinks longer before acting. Better for tricky, multi-step work.',
  xhigh: 'Thinks the longest. Slowest, for the hardest problems.',
};

export function BotSettingsModal() {
  const target = useConfigUI((s) => s.botSettings);
  const close = useConfigUI((s) => s.closeBotSettings);
  const setTab = (tab: BotSettingsTab) => target && useConfigUI.setState({ botSettings: { ...target, tab } });
  const bot = useStore((s) => s.bots.find((b) => b.id === target?.botId));
  const routines = useStore((s) => (target ? s.routines[target.botId] : undefined));
  const memVersion = useVersion(`memories:${target?.botId ?? ''}`);
  const [data, setData] = useState<BotSettingsBundle | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const onClose = useCallback(() => close(), [close]);

  const reload = useCallback(() => {
    if (!target) return;
    configApi.settings(target.botId).then((d) => { setData(d); setLoadError(null); }).catch((e) => setLoadError(e.message));
  }, [target?.botId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { reload(); }, [reload, memVersion]);
  useEffect(() => { if (target) useStore.getState().loadRoutines(target.botId).catch(() => {}); }, [target?.botId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bot deleted while open (or bad id): close.
  useEffect(() => { if (target && !bot && useStore.getState().bots.length) close(); }, [bot, target, close]);
  if (!target || !bot) return null;

  const tabs: { id: BotSettingsTab; label: string; count?: number }[] = [
    { id: 'general', label: 'General' },
    { id: 'theme', label: 'Theme' },
    { id: 'skills', label: 'Skills', count: data ? data.skills.length + (data.universalSkills?.length ?? 0) : undefined },
    { id: 'memories', label: 'Memories', count: data?.memories.length },
    { id: 'routines', label: 'Routines', count: (routines ?? data?.routines)?.length },
    ...(bot.kind === 'room' ? [] : [{ id: 'access' as const, label: 'Access' }]),
  ];
  const exportBot = async () => {
    const response = await fetch(`/api/bots/${bot.id}/export`, { credentials: 'include' });
    if (!response.ok) { setLoadError('Could not export this Bot.'); return; }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = `${bot.name.replace(/[^\w .-]+/g, '').trim() || 'bot'}.marionbot.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <Modal onClose={onClose} className="bot-settings" label={`${bot.name} settings`}>
      <div className="modal__header">
        <div className="bot-settings__title">
          <BotAvatarFor bot={bot} size={24} />
          <span className="modal__title">{bot.name}</span>
        </div>
        <div className="bot-settings__actions">
          {bot.kind !== 'room' && <button type="button" className="icon-btn icon-btn--sm" onClick={() => void exportBot()} aria-label="Export Bot" title="Export as a file to share or back up"><Share size={15} /></button>}
          <button type="button" className="icon-btn icon-btn--sm" onClick={onClose} aria-label="Close" title="Close"><Icon name="close" size={14} opacity={0.68} /></button>
        </div>
      </div>
      <div className="bot-settings__body" style={botVars(bot.avatarColor)}>
        <nav className="cfg-nav" aria-label="Bot settings sections">
          {tabs.map((t) => (
            <button key={t.id} type="button" className={`cfg-nav__item${target.tab === t.id ? ' is-active' : ''}`} onClick={() => setTab(t.id)} aria-current={target.tab === t.id || undefined}>
              <span>{t.label}</span>
              {t.count ? <span className="cfg-nav__count">{t.count}</span> : null}
            </button>
          ))}
        </nav>
        <div className="cfg-content" key={target.tab}>
          {loadError && <div className="cfg-error">Couldn’t load settings: {loadError}</div>}
          {target.tab === 'general' && <GeneralTab key={bot.id} bot={bot} onClose={onClose} />}
          {target.tab === 'theme' && <ThemeTab key={bot.id} bot={bot} />}
          {target.tab === 'skills' && <SkillsTab bot={bot} skills={data?.skills} universal={data?.universalSkills} onChange={reload} />}
          {target.tab === 'memories' && <MemoriesTab bot={bot} data={data} onChange={reload} />}
          {target.tab === 'routines' && <RoutinesTab bot={bot} routines={routines ?? data?.routines} />}
          {target.tab === 'access' && <AccessTab bot={bot} />}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

type Draft = Pick<Bot, 'name' | 'label' | 'description' | 'instructions' | 'avatarShape' | 'avatarColor' | 'avatarStemColor' | 'effort' | 'mode'> & { avatarGlow: boolean };
const draftOf = (b: Bot): Draft => ({ name: b.name, label: b.label, description: b.description, instructions: b.instructions, avatarShape: b.avatarShape, avatarColor: b.avatarColor, avatarStemColor: b.avatarStemColor, avatarGlow: !!b.avatarGlow, effort: b.effort, mode: b.mode });

function GeneralTab({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(bot));
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);

  const base = draftOf(bot);
  const changed = (Object.keys(draft) as (keyof Draft)[]).filter((k) => draft[k] !== base[k]);
  const dirty = changed.length > 0;
  const nameOk = draft.name.trim().length > 0;
  const put = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const flash = (text: string, tone: 'ok' | 'error' = 'ok') => { setNote({ text, tone }); setTimeout(() => setNote(null), 2400); };

  const save = async () => {
    if (!dirty || !nameOk) return;
    setSaving(true);
    try {
      const patch: Partial<Draft> = {};
      for (const k of changed) (patch as Record<string, unknown>)[k] = k === 'name' ? draft.name.trim() : draft[k];
      const { bot: next } = await configApi.updateBot(bot.id, patch);
      useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === next.id ? next : b)) }));
      flash('Saved');
    } catch (e) {
      flash((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cfg-page">
      <section className="cfg-section">
        <div className="cfg-look">
          <BotAvatar shape={draft.avatarShape} color={draft.avatarColor} stemColor={draft.avatarStemColor} glow={draft.avatarGlow} image={bot.avatarImage} size={72} />
          <div className="cfg-look__text">
            <div className="cfg-look__name">{draft.name || 'New Bot'}</div>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => useConfigUI.setState({ botSettings: { botId: bot.id, tab: 'theme' } })}>
              Change look
            </button>
          </div>
        </div>
      </section>

      <section className="cfg-section cfg-grid">
        <Field label="Name" htmlFor="cfg-name">
          <input id="cfg-name" className="text-input" value={draft.name} maxLength={60} onChange={(e) => put('name', e.target.value)} aria-invalid={!nameOk} />
        </Field>
        <Field label="Label" htmlFor="cfg-label" hint="Shown next to the name, like “Research” or “Inbox”.">
          <input id="cfg-label" className="text-input" value={draft.label} maxLength={60} placeholder="Add a label" onChange={(e) => put('label', e.target.value)} />
        </Field>
      </section>

      <section className="cfg-section">
        <Field label="About" htmlFor="cfg-about">
          <textarea id="cfg-about" className="text-input cfg-textarea" rows={2} value={draft.description} maxLength={500} placeholder="What is this Bot for?" onChange={(e) => put('description', e.target.value)} />
        </Field>
        <Field label="Instructions" htmlFor="cfg-instructions" hint={`Standing guidance ${draft.name || 'this Bot'} always follows, like tone, priorities or things to avoid. It also learns from chat, skills and memories.`}>
          <textarea id="cfg-instructions" className="text-input cfg-textarea cfg-textarea--tall" rows={7} value={draft.instructions} maxLength={8000} placeholder="e.g. Keep updates to three bullets. Never email anyone outside the team without asking." onChange={(e) => put('instructions', e.target.value)} />
        </Field>
        <Field label="Thinking effort" hint={EFFORT_HINT[draft.effort]}>
          <Segmented label="Thinking effort" value={draft.effort} options={EFFORTS} onChange={(v) => put('effort', v)} />
        </Field>
        <Field label="Used as">
          <Segmented label="Bot type" value={draft.mode} options={[{ value: 'personal', label: 'Personal assistant' }, { value: 'teammate', label: 'Teammate' }]} onChange={(v) => put('mode', v)} />
        </Field>
        <ExecutiveField bot={bot} />
      </section>

      <div className={`cfg-savebar${dirty ? ' is-dirty' : ''}`}>
        <span className={`cfg-savebar__note${note?.tone === 'error' ? ' is-error' : ''}`} role="status">{note?.text ?? (dirty ? 'Unsaved changes' : '')}</span>
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!dirty || saving} onClick={() => setDraft(draftOf(bot))}>Discard</button>
        <button type="button" className="cfg-btn cfg-btn--primary" disabled={!dirty || saving || !nameOk} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>
      </div>

      <section className="cfg-section">
        <div className="cfg-section__label">Conversation</div>
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">New conversation</div>
              <div className="cfg-row__sub">Clears the chat. Memories, skills and routines stay.</div>
            </div>
            <ConfirmButton className="cfg-btn cfg-btn--secondary" confirmLabel="Start fresh" onConfirm={async () => { await configApi.fresh(bot.id); flash('Started a new conversation'); }}>
              Start new
            </ConfirmButton>
          </div>
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Primary</div>
              <div className="cfg-row__sub">Your go-to Bot. It reaches out first, keeps the others on track and sits at the top of your chats.</div>
            </div>
            <Switch on={bot.isPrimary} label="Primary" onChange={(on) => {
              // Shown at once; the roster event confirms it (owner, Nov 25: "turn it on and then you can't turn it off").
              useStore.setState((s) => ({ bots: s.bots.map((b) => ({ ...b, isPrimary: on ? b.id === bot.id : b.id === bot.id ? false : b.isPrimary })) }));
              (on ? configApi.makePrimary(bot.id) : configApi.clearPrimary(bot.id))
                .then(() => flash(on ? `${bot.name} is now your primary Bot` : `${bot.name} is no longer primary`))
                .catch((e) => { flash(e.message, 'error'); useStore.getState().loadBots().catch(() => {}); });
            }} />
          </div>
        </div>
      </section>

      {bot.kind !== 'room' && <ComputerSection bot={bot} flash={flash} />}

      <section className="cfg-section">
        <div className="cfg-section__label">Danger zone</div>
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Delete {bot.name}</div>
              <div className="cfg-row__sub">{bot.isPrimary ? 'Turn off Primary first.' : 'Removes its chat, memories, skills and routines for good.'}</div>
            </div>
            <ConfirmButton
              disabled={bot.isPrimary}
              confirmLabel={`Delete ${bot.name}`}
              onConfirm={async () => {
                try {
                  await configApi.deleteBot(bot.id);
                  onClose();
                  const st = useStore.getState();
                  st.set({ bots: st.bots.filter((b) => b.id !== bot.id) });
                  st.loadBots().catch(() => {});
                } catch (e) { flash((e as Error).message, 'error'); }
              }}
            >
              Delete…
            </ConfirmButton>
          </div>
        </div>
      </section>
    </div>
  );
}


/** Everything this Bot may reach: folders on this Mac, Marion Life, and connected apps. */
/** Every bot has its own computer; this turns it on (or puts it to sleep) even if the bot has never used it. */
function ComputerSection({ bot, flash }: { bot: Bot; flash: (text: string, tone?: 'ok' | 'error') => void }) {
  const computer = useStore((s) => s.computer);
  const [switching, setSwitching] = useState(false);
  const running = computer?.screens.some((screen) => screen.botId === bot.id && screen.running) ?? false;
  const busy = computer?.status === 'starting' || computer?.status === 'resuming' || computer?.status === 'creating';
  const toggle = (awake: boolean) => {
    if (switching) return;
    setSwitching(true);
    featuresApi.setComputerAwake(bot.id, awake)
      .then(() => flash(awake ? `${bot.name}'s computer is on` : `${bot.name}'s computer is asleep`))
      .catch((e) => flash((e as Error).message, 'error'))
      .finally(() => setSwitching(false));
  };
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Computer</div>
      <div className="cfg-card">
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">{switching ? 'Working…' : running ? 'Computer is on' : busy ? computerStatusText(computer) : 'Computer is off'}</div>
            <div className="cfg-row__sub">{bot.name}'s own Linux desktop. It starts by itself when {bot.name} needs it; turn it on here any time.</div>
          </div>
          <button type="button" className="cfg-btn cfg-btn--secondary" disabled={switching || busy} onClick={() => toggle(!running)}>
            {running ? 'Put to sleep' : 'Turn on computer'}
          </button>
        </div>
        {running && (
          <div className="cfg-row">
            <div className="cfg-row__text"><div className="cfg-row__title">Watch the screen</div></div>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => {
              useConfigUI.getState().closeBotSettings();
              openBotChat(bot.id);
              useStore.getState().set({ viewerOpen: true });
            }}>Open computer</button>
          </div>
        )}
      </div>
    </section>
  );
}

function AccessTab({ bot }: { bot: Bot }) {
  return (
    <div className="cfg-page">
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">Access</div>
          <div className="cfg-page__sub">What {bot.name} can reach. Anything shared here {bot.name} can also hand to Claude Code, Codex or Gemini when it asks them for help.</div>
        </div>
      </div>
      <FullAccessSection bot={bot} />
      <FoldersSection bot={bot} />
      <LifeAccessSection bot={bot} />
      <AppsSection bot={bot} />
    </div>
  );
}

/**
 * Full access, for this bot only: its CLIs (Claude Code, Codex, Gemini) may work anywhere in the home
 * folder and run without asking each time. Two steps to turn on: the switch, then a confirm after
 * ticking that you understand. Off again with one tap.
 */
function FullAccessSection({ bot }: { bot: Bot }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [asking, setAsking] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { featuresApi.folders(bot.id).then(r => setOn(Boolean(r.fullAccess))).catch(() => setOn(false)); }, [bot.id]);
  const set = async (enabled: boolean) => {
    setBusy(true); setError('');
    try {
      const r = await featuresApi.setFullAccess(bot.id, enabled, enabled ? `give ${bot.name} full access` : undefined);
      setOn(r.fullAccess); setAsking(false); setUnderstood(false);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  if (on === null) return null;
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Full access</div>
      <div className={`cfg-card full-access${on ? ' is-on' : ''}`}>
        <div className="cfg-row">
          <ShieldAlert size={16} strokeWidth={1.8} className="access-folder__icon" />
          <div className="cfg-row__text">
            <div className="cfg-row__title">Give {bot.name} access to everything</div>
            <div className="cfg-row__sub">{on ? `${bot.name} and the assistants it uses can work anywhere in your home folder and run commands on this Mac without asking first.` : `Only ${bot.name}. Lets it (and Claude Code, Codex or Gemini working for it) reach your whole home folder and run commands without asking each time.`}</div>
          </div>
          <Switch on={on || asking} disabled={busy} label={`Full access for ${bot.name}`} onChange={next => { if (!next) { setAsking(false); if (on) void set(false); } else setAsking(true); }} />
        </div>
        {asking && !on && (
          <div className="full-access__confirm" role="alertdialog" aria-label="Confirm full access">
            <p><b>Are you sure?</b> {bot.name} could read, change or delete any file in your home folder and run any command, and it won’t stop to ask. Other bots are not affected.</p>
            <label className="full-access__check">
              <input type="checkbox" checked={understood} onChange={event => setUnderstood(event.target.checked)} />
              I understand and want to give {bot.name} full access
            </label>
            <div className="full-access__actions">
              <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { setAsking(false); setUnderstood(false); }}>Cancel</button>
              <button type="button" className="cfg-btn cfg-btn--danger" disabled={!understood || busy} onClick={() => void set(true)}>{busy ? 'Turning on…' : 'Turn on full access'}</button>
            </div>
          </div>
        )}
      </div>
      {error && <div className="cfg-error">{error}</div>}
    </section>
  );
}

function FoldersSection({ bot }: { bot: Bot }) {
  const [folders, setFolders] = useState<BotFolder[] | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    featuresApi.folders(bot.id).then(r => { setFolders(r.folders); setSuggestion(r.suggestion); }).catch(e => setError((e as Error).message));
  }, [bot.id]);
  const run = async (job: () => Promise<{ folders: BotFolder[] }>) => {
    setBusy(true); setError('');
    try { setFolders((await job()).folders); return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  };
  const shared = folders ?? [];
  const showSuggestion = suggestion && !shared.some(f => f.path === suggestion);
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Folders on this Mac</div>
      <div className="cfg-card">
        {shared.map(folder => (
          <div key={folder.path} className="cfg-row">
            <Folder size={16} strokeWidth={1.8} className="access-folder__icon" />
            <div className="cfg-row__text">
              <div className="cfg-row__title">{folder.label}</div>
              <div className="cfg-row__sub" title={folder.path}>{folder.path}</div>
            </div>
            <Segmented label={`What ${bot.name} can do in ${folder.label}`} value={folder.write ? 'write' : 'read'} options={[{ value: 'read', label: 'Read' }, { value: 'write', label: 'Edit' }]}
              onChange={v => void run(() => featuresApi.updateFolder(bot.id, { path: folder.path, write: v === 'write' }))} />
            <ConfirmButton confirmLabel="Remove" title="Stop sharing this folder" onConfirm={() => run(() => featuresApi.removeFolder(bot.id, folder.path))}>
              <Icon name="close" size={12} />
            </ConfirmButton>
          </div>
        ))}
        {folders && !shared.length && <div className="cfg-empty cfg-empty--flat">No folders yet. Share one and {bot.name} can sort, rename and tidy it when you ask, or have Claude Code, Codex or Gemini work in it.</div>}
        <div className="cfg-row cfg-row--divided access-add">
          <input className="text-input" value={path} placeholder="~/Desktop/Screenshots" aria-label="Folder path"
            onChange={e => setPath(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && path.trim()) void run(() => featuresApi.addFolder(bot.id, { path })).then(ok => ok && setPath('')); }} />
          <button type="button" className="cfg-btn" disabled={busy || !path.trim()} onClick={() => void run(() => featuresApi.addFolder(bot.id, { path })).then(ok => ok && setPath(''))}>Add</button>
          <button type="button" className="cfg-btn cfg-btn--primary" disabled={busy} onClick={() => void run(() => featuresApi.addFolder(bot.id, { pick: true }))}>{busy ? 'Choosing…' : 'Choose folder…'}</button>
        </div>
        {showSuggestion && (
          <div className="cfg-row cfg-row--divided">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Screenshots</div>
              <div className="cfg-row__sub">{suggestion}</div>
            </div>
            <button type="button" className="cfg-btn" disabled={busy} onClick={() => void run(() => featuresApi.addFolder(bot.id, { path: suggestion!, label: 'Screenshots' }))}>Share</button>
          </div>
        )}
      </div>
      {error && <div className="cfg-error">{error}</div>}
      <div className="cfg-field__hint access-hint">Read lets {bot.name} look; Edit also lets it create, rename and move files. It can never go outside a shared folder.</div>
    </section>
  );
}

function LifeAccessSection({ bot }: { bot: Bot }) {
  const [link, setLink] = useState<LifeLink | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { featuresApi.lifeLink().then(setLink).catch(() => {}); }, []);
  if (!link?.settings.enabled) return null;
  const blocked = link.settings.blockedBots ?? [];
  const on = !blocked.includes(bot.id);
  const toggle = (next: boolean) => {
    const blockedBots = next ? blocked.filter(id => id !== bot.id) : [...blocked, bot.id];
    setLink({ ...link, settings: { ...link.settings, blockedBots } });
    featuresApi.saveLifeLink({ blockedBots }).then(setLink).catch(e => setError((e as Error).message));
  };
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Marion Life</div>
      <div className="cfg-card">
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Planner and calendar</div>
            <div className="cfg-row__sub">{on ? `${bot.name} can read and add tasks and events.` : `${bot.name} can’t use Marion Life.`}</div>
          </div>
          <Switch on={on} onChange={toggle} label={`Let ${bot.name} use Marion Life`} />
        </div>
      </div>
      {error && <div className="cfg-error">{error}</div>}
    </section>
  );
}

/** The apps this Bot can use (its integrations) and whether each is connected. */
function AppsSection({ bot }: { bot: Bot }) {
  const [profile, setProfile] = useState<BotProfileData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { featuresApi.profile(bot.id).then(r => setProfile(r.profile)).catch(e => setError((e as Error).message)); }, [bot.id]);
  if (error) return <div className="cfg-error">Couldn’t load apps: {error}</div>;
  if (!profile) return null;
  return (
    <>
      <section className="cfg-section">
        <div className="cfg-section__label">Apps it can use</div>
        {profile.integrations.length ? (
          <div className="cfg-card">
            {profile.integrations.map(slug => (
              <div key={slug} className="cfg-row">
                <ToolkitLogo name={slug} logo={`https://logos.composio.dev/api/${slug}`} size={20} radius={5} />
                <div className="cfg-row__text"><div className="cfg-row__title">{slug.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</div></div>
                {profile.connected && <span className={`bot-profile__app-state${profile.connected.includes(slug) ? ' is-on' : ''}`}>{profile.connected.includes(slug) ? 'Connected' : 'Not connected'}</span>}
              </div>
            ))}
          </div>
        ) : <div className="cfg-empty">Uses its own computer, browser and files. Connect apps in Settings → Connected apps when it needs them.</div>}
      </section>
    </>
  );
}

function LookPicker({ shape, color, stemColor, glow, onShape, onColor, onStem, onGlow }: {
  shape: AvatarShape;
  color: AvatarColor;
  stemColor: string | null;
  glow: boolean;
  onGlow: (on: boolean) => void;
  onShape: (shape: AvatarShape) => void;
  onColor: (color: AvatarColor) => void;
  onStem: (color: string | null) => void;
}) {
  return (
    <div className="cfg-picker">
      <BotShapePicker shape={shape} color={color} stemColor={stemColor} glow={glow} onShape={onShape} />
      <BotColorPicker color={color} onChange={onColor} />
      <BotStemPicker color={stemColor} onChange={onStem} glow={glow} onGlow={onGlow} />
    </div>
  );
}

// ---------------------------------------------------------------------------

type Look = Pick<Draft, 'avatarShape' | 'avatarColor' | 'avatarStemColor' | 'avatarGlow'> & { avatarImage: string | null; workFx: WorkFxChoice };
const WORK_FX_OPTIONS: { value: WorkFxChoice; label: string }[] = [
  { value: 'auto', label: 'Automatic' }, { value: 'halo', label: 'Halo' }, { value: 'orbit', label: 'Orbit' }, { value: 'comet', label: 'Comet' },
  { value: 'ripple', label: 'Ripple' }, { value: 'sparkle', label: 'Sparkle' }, { value: 'swirl', label: 'Swirl' },
];
const lookOf = (b: Bot): Look => ({ avatarShape: b.avatarShape, avatarColor: b.avatarColor, avatarStemColor: b.avatarStemColor, avatarGlow: !!b.avatarGlow, avatarImage: b.avatarImage ?? null, workFx: b.workFx ?? 'auto' });

/** Any photo → a 256px square, centre-cropped, small enough to keep with the Bot (WebP, or PNG where WebP can't be made). */
async function squarePhoto(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('That image could not be opened.'); });
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
  bitmap.close();
  const webp = canvas.toDataURL('image/webp', 0.9);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
}

/** The Bot's look: berry shape, colour, stem and glow, with a live preview and its own save bar. */
function ThemeTab({ bot }: { bot: Bot }) {
  const [look, setLook] = useState<Look>(() => lookOf(bot));
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const base = lookOf(bot);
  const changed = (Object.keys(look) as (keyof Look)[]).filter((k) => look[k] !== base[k]);
  const dirty = changed.length > 0;
  const put = <K extends keyof Look>(k: K, v: Look[K]) => setLook((d) => ({ ...d, [k]: v }));
  const save = async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      const patch = Object.fromEntries(changed.map((k) => [k, look[k]]));
      const { bot: next } = await configApi.updateBot(bot.id, patch);
      useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === next.id ? next : b)) }));
      setNote({ text: 'Saved', tone: 'ok' });
    } catch (e) {
      setNote({ text: (e as Error).message, tone: 'error' });
    } finally {
      setSaving(false);
      setTimeout(() => setNote(null), 2400);
    }
  };
  return (
    <div className="cfg-page">
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">Theme</div>
          <div className="cfg-page__sub">How {bot.name} looks in the sidebar, chats and menus.</div>
        </div>
      </div>
      <section className="cfg-section">
        <div className="cfg-look">
          <BotAvatar shape={look.avatarShape} color={look.avatarColor} stemColor={look.avatarStemColor} glow={look.avatarGlow} image={look.avatarImage} size={72} working={preview} fxSeed={bot.id} workFx={look.workFx} />
          <div className="cfg-look__text">
            <div className="cfg-look__name">{bot.name}</div>
            <div className="cfg-look__actions">
              <label className="cfg-btn cfg-btn--secondary cfg-upload">
                {look.avatarImage ? 'Change photo' : 'Upload photo'}
                <input type="file" accept="image/*" onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) squarePhoto(file).then((url) => put('avatarImage', url)).catch((err) => { setNote({ text: (err as Error).message, tone: 'error' }); setTimeout(() => setNote(null), 2400); });
                }} />
              </label>
              {look.avatarImage && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => put('avatarImage', null)}>Use a berry</button>}
            </div>
          </div>
        </div>
        <LookPicker shape={look.avatarShape} color={look.avatarColor} stemColor={look.avatarStemColor} glow={look.avatarGlow}
          onShape={(s) => setLook((d) => ({ ...d, avatarShape: s, avatarImage: null }))} onColor={(c) => put('avatarColor', c)} onStem={(c) => put('avatarStemColor', c)} onGlow={(on) => put('avatarGlow', on)} />
        <Field label="Working animation" hint={`Plays around ${bot.name} while it works, in the sidebar and at the top of the chat. Automatic gives each bot its own.`}>
          <Segmented label="Working animation" value={look.workFx} options={WORK_FX_OPTIONS} onChange={(v) => { put('workFx', v); setPreview(true); }} />
          <div className="cfg-look__actions">
            <button type="button" className="cfg-btn cfg-btn--secondary" aria-pressed={preview} onClick={() => setPreview((on) => !on)}>{preview ? 'Stop preview' : 'Preview'}</button>
          </div>
        </Field>
      </section>
      <div className={`cfg-savebar${dirty ? ' is-dirty' : ''}`}>
        <span className={`cfg-savebar__note${note?.tone === 'error' ? ' is-error' : ''}`} role="status">{note?.text ?? (dirty ? 'Unsaved changes' : '')}</span>
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!dirty || saving} onClick={() => setLook(lookOf(bot))}>Discard</button>
        <button type="button" className="cfg-btn cfg-btn--primary" disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** `scope` says where a skill lives: 'bot' = only this Bot, 'universal' = every Bot on the team (one shared copy). */
type SkillScope = 'bot' | 'universal';

function SkillsTab({ bot, skills, universal, onChange }: { bot: Bot; skills: Skill[] | undefined; universal: UniversalSkill[] | undefined; onChange: () => void }) {
  const [editing, setEditing] = useState<string | 'new-bot' | 'new-universal' | null>(null);
  const done = () => { setEditing(null); onChange(); };
  const shared = new Set((universal ?? []).map((s) => s.name.trim().toLowerCase()));
  return (
    <div className="cfg-page">
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">Universal skills</div>
          <div className="cfg-page__sub">Shared by <strong>every Bot</strong> on your team, including new ones. Edit one here and all Bots follow the new version.</div>
        </div>
        {editing !== 'new-universal' && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setEditing('new-universal')}><Icon name="plus" size={12} /> New universal skill</button>}
      </div>
      {editing === 'new-universal' && <SkillEditor scope="universal" botId={bot.id} onDone={done} />}
      {!universal ? <div className="cfg-empty">Loading…</div> : universal.length === 0 && editing !== 'new-universal' ? (
        <div className="cfg-empty">No universal skills. Add one for anything every Bot should follow.</div>
      ) : (
        <div className="cfg-list">
          {universal.map((s) => editing === s.id ? (
            <SkillEditor key={s.id} scope="universal" botId={bot.id} skill={s} onDone={done} />
          ) : (
            <SkillRow key={s.id} skill={s} scope="universal" onEdit={() => setEditing(s.id)} onDelete={async () => { await configApi.deleteUniversalSkill(s.id); onChange(); }} />
          ))}
        </div>
      )}

      <div className="cfg-page__head" style={{ marginTop: 20 }}>
        <div>
          <div className="cfg-page__title">Only {bot.name}</div>
          <div className="cfg-page__sub">Step-by-step how-tos only {bot.name} follows for specific jobs. Ask for one by name in chat.</div>
        </div>
        {editing !== 'new-bot' && <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => setEditing('new-bot')}><Icon name="plus" size={12} /> New skill</button>}
      </div>
      {editing === 'new-bot' && <SkillEditor scope="bot" botId={bot.id} onDone={done} />}
      {!skills ? <div className="cfg-empty">Loading…</div> : skills.length === 0 && editing !== 'new-bot' ? (
        <div className="cfg-empty">
          No Bot-only skills yet. Write down how you like something done, like “Prep for a sales call”, and {bot.name} will follow it every time.
        </div>
      ) : (
        <div className="cfg-list">
          {skills.map((s) => editing === s.id ? (
            <SkillEditor key={s.id} scope="bot" botId={bot.id} skill={s} onDone={done} />
          ) : (
            <SkillRow key={s.id} skill={s} scope="bot" replaced={shared.has(s.name.trim().toLowerCase())} onEdit={() => setEditing(s.id)} onDelete={async () => { await configApi.deleteSkill(s.id); onChange(); }} />
          ))}
        </div>
      )}
    </div>
  );
}

function SkillRow({ skill, scope, replaced, onEdit, onDelete }: { skill: Skill | UniversalSkill; scope: SkillScope; replaced?: boolean; onEdit: () => void; onDelete: () => Promise<void> }) {
  const universal = scope === 'universal';
  return (
    <div className="cfg-item" data-skill-scope={scope}>
      <span className="cfg-item__icon"><Glyph name="spark" size={14} /></span>
      <div className="cfg-item__text">
        <div className="cfg-item__title">
          {skill.name}{' '}
          <span className={universal ? 'cfg-chip' : 'cfg-chip cfg-chip--muted'} title={universal ? 'Applies to every Bot on your team' : 'Only this Bot uses it'}>{universal ? 'Universal · all Bots' : 'This Bot only'}</span>
        </div>
        <div className="cfg-item__sub">{replaced ? 'Hidden from the prompt: a universal skill with this name is used instead. ' : ''}{skill.description || skill.body.split('\n')[0]}</div>
      </div>
      <div className="cfg-item__actions">
        <button type="button" className="cfg-icon-btn" onClick={onEdit} aria-label={`Edit ${skill.name}`} title={universal ? 'Edit for all Bots' : 'Edit'}><Icon name="edit" size={14} /></button>
        <ConfirmButton className="cfg-icon-btn" title={universal ? 'Delete for all Bots' : 'Delete'} onConfirm={onDelete}><Glyph name="trash" size={14} /></ConfirmButton>
      </div>
    </div>
  );
}

function SkillEditor({ botId, skill, scope, onDone }: { botId: string; skill?: Skill | UniversalSkill; scope: SkillScope; onDone: () => void }) {
  const universal = scope === 'universal';
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [body, setBody] = useState(skill?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const can = name.trim() && body.trim() && !busy;
  const save = async () => {
    if (!can) return;
    setBusy(true); setError(null);
    try {
      if (universal) {
        if (skill) await configApi.updateUniversalSkill(skill.id, { name, description, body });
        else await configApi.createUniversalSkill({ name, description, body });
      } else if (skill) await configApi.updateSkill(skill.id, { name, description, body });
      else await configApi.createSkill(botId, { name, description, body });
      onDone();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <form className="cfg-editor" onSubmit={(e) => { e.preventDefault(); save(); }}>
      {universal && <div className="cfg-skill-hint">Universal skill: saving changes it for every Bot on your team.</div>}
      <input className="text-input" placeholder="Skill name, e.g. Weekly report" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus aria-label="Skill name" />
      <input className="text-input" placeholder="When to use it (optional)" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} aria-label="Skill description" />
      <textarea className="text-input cfg-textarea cfg-textarea--tall" rows={8} placeholder={'Write the steps to follow:\n1. …\n2. …'} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Skill steps" />
      {error && <div className="cfg-error">{error}</div>}
      <div className="cfg-editor__actions">
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={onDone}>Cancel</button>
        <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!can}>{busy ? 'Saving…' : skill ? (universal ? 'Save for all Bots' : 'Save skill') : (universal ? 'Add universal skill' : 'Add skill')}</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------

function MemoriesTab({ bot, data, onChange }: { bot: Bot; data: BotSettingsBundle | null; onChange: () => void }) {
  const [q, setQ] = useState('');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const memories = useMemo(() => (data?.memories ?? []).filter((m) => !hidden.has(m.id) && (!q || m.text.toLowerCase().includes(q.toLowerCase()))), [data, hidden, q]);
  const remove = async (m: Memory) => {
    setHidden((h) => new Set(h).add(m.id));
    try { await configApi.deleteMemory(m.id); onChange(); } catch { setHidden((h) => { const n = new Set(h); n.delete(m.id); return n; }); }
  };
  const fill = data ? Math.min(100, Math.round((data.memory.historyChars / data.memory.compactAtChars) * 100)) : 0;
  return (
    <div className="cfg-page">
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">Memories</div>
          <div className="cfg-page__sub">What {bot.name} remembers about you. It saves things when you share them, and picks up more on its own once a chat goes quiet.</div>
        </div>
      </div>
      {(data?.memories.length ?? 0) > 6 && (
        <input className="text-input" placeholder="Search memories" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search memories" />
      )}
      {!data ? <div className="cfg-empty">Loading…</div> : memories.length === 0 ? (
        <div className="cfg-empty">{q ? 'No memories match.' : `Nothing yet. Tell ${bot.name} about yourself, or just chat. It’ll pick things up.`}</div>
      ) : (
        <div className="cfg-list">
          {memories.map((m) => (
            <div key={m.id} className="cfg-item">
              <div className="cfg-item__text">
                <div className="cfg-item__body">{m.text}</div>
                <div className="cfg-item__meta">
                  {m.source === 'learned' ? <span className="cfg-chip">Picked up</span> : <span className="cfg-chip cfg-chip--muted">Saved in chat</span>}
                  <span>{shortDate(m.createdAt)}</span>
                </div>
              </div>
              <div className="cfg-item__actions">
                <button type="button" className="cfg-icon-btn" onClick={() => remove(m)} aria-label="Forget this" title="Forget"><Glyph name="trash" size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      {data && (
        <div className="cfg-meter" title="Older messages are summarized automatically when this fills up.">
          <div className="cfg-meter__label"><span>Conversation memory</span><span>{fill}% full</span></div>
          <div className="cfg-meter__track"><span style={{ width: `${Math.max(2, fill)}%` }} /></div>
          <div className="cfg-field__hint">
            When it fills up, older messages get summarized so {bot.name} can keep going.
            {data.memory.lastCompaction ? ` Last summarized ${shortDate(data.memory.lastCompaction.created_at)}.` : ''}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function RoutinesTab({ bot, routines }: { bot: Bot; routines: Routine[] | undefined }) {
  const [flash, setFlash] = useState<string | null>(null);
  const say = (t: string) => { setFlash(t); setTimeout(() => setFlash(null), 2200); };
  return (
    <div className="cfg-page">
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">Routines</div>
          <div className="cfg-page__sub">Recurring jobs {bot.name} runs on a schedule. To add or change one, ask in chat.</div>
        </div>
        {flash && <span className="cfg-savebar__note" role="status">{flash}</span>}
      </div>
      {!routines ? <div className="cfg-empty">Loading…</div> : routines.length === 0 ? (
        <div className="cfg-empty">No routines yet. Try asking {bot.name}: “every Friday at 4pm, recap my week”.</div>
      ) : (
        <div className="cfg-list">
          {routines.map((r) => <RoutineItem key={r.id} r={r} onFlash={say} />)}
        </div>
      )}
    </div>
  );
}

function RoutineItem({ r, onFlash }: { r: Routine; onFlash: (t: string) => void }) {
  const [enabled, setEnabled] = useState(r.enabled);
  useEffect(() => setEnabled(r.enabled), [r.enabled]);
  const toggle = async (v: boolean) => {
    setEnabled(v);
    try { await configApi.setRoutine(r.id, v); onFlash(v ? 'Resumed' : 'Paused'); } catch { setEnabled(!v); }
  };
  return (
    <div className="cfg-item cfg-item--routine">
      <span className="cfg-item__icon"><Icon name="clock" size={14} /></span>
      <div className="cfg-item__text">
        <div className="cfg-item__title">{r.name}</div>
        <div className="cfg-item__sub">{enabled ? [r.description || r.schedule, nextRunLabel(r.nextRunAt, r.timezone)].filter(Boolean).join(' · ') : 'Paused'}</div>
        <div className="cfg-item__prompt">{r.prompt}</div>
      </div>
      <div className="cfg-item__actions">
        <button type="button" className="cfg-icon-btn" title="Run now" aria-label={`Run ${r.name} now`} onClick={() => configApi.runRoutine(r.id).then(() => onFlash('Running now')).catch((e) => onFlash(e.message))}>
          <Glyph name="play" size={13} />
        </button>
        <ConfirmButton className="cfg-icon-btn" title="Delete" onConfirm={() => configApi.deleteRoutine(r.id).then(() => onFlash('Deleted'))}><Glyph name="trash" size={14} /></ConfirmButton>
        <Switch on={enabled} onChange={toggle} label={`${r.name} ${enabled ? 'on' : 'paused'}`} />
      </div>
    </div>
  );
}

/** Saved on its own (not part of the draft), like the star toggle. */
function ExecutiveField({ bot }: { bot: Bot }) {
  const [error, setError] = useState('');
  const on = bot.role === 'executive';
  const change = async (value: boolean) => {
    setError('');
    try {
      const { bot: updated } = await featuresApi.setBot(bot.id, { role: value ? 'executive' : null });
      useStore.setState(s => ({ bots: s.bots.map(b => b.id === updated.id ? updated : b) }));
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <Field label="Executive" hint={error || `${bot.name} coordinates the other Bots: hands them work, collects their replies and reports back to you.`}>
      <Switch on={on} label="Executive" onChange={v => void change(v)} />
    </Field>
  );
}
