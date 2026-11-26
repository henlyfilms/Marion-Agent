import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, Download, Share, X } from 'lucide-react';
import { BotAvatar, BotAvatarFor } from '../../avatar/BotAvatar';
import { DEFAULT_STEM_COLOR } from '@shared/avatarShapes';
import { useConfigUI } from '../../configStore';
import { featuresApi, useFeatureUI, type BotProfileData, type ProfileTarget } from '../../lib/featuresApi';
import { useStore } from '../../store';
import { openBotChat } from '../botMenuItems';
import { Modal } from '../modals/Modal';
import { ToolkitLogo } from '../ToolkitLogo';

type Section = 'instructions' | 'memories' | 'skills' | 'routines' | 'integrations';

const SECTIONS: { id: Section; title: string; sub: string }[] = [
  { id: 'instructions', title: 'Instructions', sub: 'How this Bot should work' },
  { id: 'memories', title: 'Memories', sub: 'Facts it already knows' },
  { id: 'skills', title: 'Skills', sub: 'Playbooks it can run' },
  { id: 'routines', title: 'Routines', sub: 'Jobs that run on their own' },
  { id: 'integrations', title: 'Integrations', sub: 'Tools it can use' },
];

const settingsTab: Partial<Record<Section, 'general' | 'skills' | 'memories' | 'routines'>> = {
  instructions: 'general', memories: 'memories', skills: 'skills', routines: 'routines',
};

/** Profile of a bot or a template: identity on top, then its instructions, memories, skills, routines and integrations. */
export function BotProfile({ target }: { target: ProfileTarget }) {
  const set = useFeatureUI(s => s.set);
  const bot = useStore(s => target.kind === 'bot' ? s.bots.find(b => b.id === target.id) : undefined);
  const [data, setData] = useState<BotProfileData | null>(null);
  const [section, setSection] = useState<Section>('instructions');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const close = () => set({ profile: null });

  useEffect(() => {
    setData(null);
    setError('');
    const load = target.kind === 'bot'
      ? featuresApi.profile(target.id).then(r => r.profile)
      : featuresApi.templates().then(r => {
        const found = r.templates.find(t => t.id === target.id);
        if (!found) throw new Error('Template not found');
        return found;
      });
    load.then(setData).catch(e => setError((e as Error).message));
  }, [target.kind, target.id, bot?.instructions, bot?.name]);

  const importTemplate = async () => {
    if (target.kind !== 'template' || busy) return;
    setBusy(true);
    setError('');
    try {
      const { bot: created } = await featuresApi.importTemplate(target.id);
      const st = useStore.getState();
      st.set({ bots: st.bots.some(b => b.id === created.id) ? st.bots : [...st.bots, created] });
      set({ profile: null, gallery: false });
      openBotChat(created.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const exportBot = async () => {
    if (target.kind !== 'bot') return;
    const response = await fetch(`/api/bots/${target.id}/export`, { credentials: 'include' });
    if (!response.ok) { setError('Could not export this Bot.'); return; }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(data?.name ?? 'bot').replace(/[^\w .-]+/g, '').trim() || 'bot'}.marionbot.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const edit = () => {
    if (target.kind !== 'bot') return;
    set({ profile: null });
    useConfigUI.getState().openBotSettings(target.id, settingsTab[section] ?? 'general');
  };

  const counts: Record<Section, number> = useMemo(() => ({
    instructions: 0,
    memories: data?.memories.length ?? 0,
    skills: data?.skills.length ?? 0,
    routines: data?.routines.length ?? 0,
    integrations: data?.integrations.length ?? 0,
  }), [data]);

  const avatar = target.kind === 'bot' && bot
    ? <BotAvatarFor bot={bot} size={92} />
    : <BotAvatar shape={data?.avatarShape ?? 'marionberry'} color={(data?.avatarColor ?? 'violet') as never} stemColor={data?.avatarStemColor === undefined ? DEFAULT_STEM_COLOR : data.avatarStemColor} glow={data?.avatarGlow} size={92} />;

  const removeTemplate = async () => {
    if (target.kind !== 'template' || busy) return;
    setBusy(true);
    try { await featuresApi.removeTemplate(target.id); set({ profile: null, gallery: true }); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <Modal onClose={close} className="bot-profile" label={data ? `${data.name} profile` : 'Bot profile'}>
      <div className="bot-profile__bar">
        {target.kind === 'template' && target.back
          ? <button type="button" className="icon-btn" onClick={() => set({ profile: null, gallery: true })} aria-label="Back to templates" title="Back to templates"><ChevronLeft size={20} /></button>
          : <span />}
        <div className="bot-profile__bar-actions">
          {target.kind === 'bot' && <button type="button" className="icon-btn" onClick={() => void exportBot()} aria-label="Export Bot" title="Export Bot as a file"><Share size={17} /></button>}
          <button type="button" className="icon-btn" onClick={close} aria-label="Close" title="Close"><X size={19} /></button>
        </div>
      </div>
      <div className="bot-profile__scroll">
        <header className="bot-profile__head">
          <div className="bot-profile__avatar">{avatar}</div>
          <div className="bot-profile__title-row">
            <div className="bot-profile__titles">
              <h2>{data?.name ?? bot?.name ?? ' '}</h2>
              <p className="bot-profile__by">By {data?.author ?? '…'}{data?.role === 'executive' ? ' · Executive' : ''}</p>
            </div>
            {target.kind === 'template'
              ? <div className="bot-profile__cta-group">
                {data?.custom && <button type="button" className="bot-profile__cta bot-profile__cta--quiet" onClick={() => void removeTemplate()} disabled={busy}>Remove template</button>}
                <button type="button" className="bot-profile__cta" onClick={() => void importTemplate()} disabled={!data || busy}>{busy ? 'Importing…' : 'Import Bot'}</button>
              </div>
              : <div className="bot-profile__cta-group">
                <button type="button" className="bot-profile__cta bot-profile__cta--quiet" onClick={edit}>Edit</button>
                <button type="button" className="bot-profile__cta" onClick={() => { close(); openBotChat(target.id); }}>Open chat</button>
              </div>}
          </div>
          {(data?.description || data?.tagline) && <p className="bot-profile__description">{data.description || data.tagline}</p>}
          {error && <p className="bot-profile__error" role="alert">{error}</p>}
        </header>
        <div className="bot-profile__divider" />
        <div className="bot-profile__body">
          <nav className="bot-profile__nav" aria-label="Profile sections">
            {SECTIONS.map(s => (
              <button key={s.id} type="button" className={`bot-profile__nav-item${section === s.id ? ' is-active' : ''}`}
                onClick={() => setSection(s.id)} aria-current={section === s.id || undefined}>
                <span className="bot-profile__nav-title">{s.title}{counts[s.id] ? <span className="bot-profile__count">{counts[s.id]}</span> : null}</span>
                <span className="bot-profile__nav-sub">{s.sub}</span>
              </button>
            ))}
          </nav>
          <section className="bot-profile__panel" aria-label={SECTIONS.find(s => s.id === section)?.title}>
            {!data ? <p className="bot-profile__empty">{error ? 'Couldn’t load this profile.' : 'Loading…'}</p> : <ProfileSection data={data} section={section} />}
          </section>
        </div>
      </div>
    </Modal>
  );
}

function ProfileSection({ data, section }: { data: BotProfileData; section: Section }) {
  switch (section) {
    case 'instructions':
      return data.instructions.trim()
        ? <p className="bot-profile__text">{data.instructions}</p>
        : <p className="bot-profile__empty">No instructions yet. It follows its job and your chat messages.</p>;
    case 'memories':
      return data.memories.length
        ? <ul className="bot-profile__list">{data.memories.map((m, i) => <li key={i}>{m}</li>)}</ul>
        : <p className="bot-profile__empty">No memories yet. It learns facts about you as you chat.</p>;
    case 'skills':
      return data.skills.length
        ? <div className="bot-profile__cards">{data.skills.map((s, i) => <Expandable key={i} title={s.name} sub={s.description} body={s.body} />)}</div>
        : <p className="bot-profile__empty">No skills yet. Teach it one by recording your screen, or correct it in chat and it saves what it learns.</p>;
    case 'routines':
      return data.routines.length
        ? <div className="bot-profile__cards">{data.routines.map((r, i) => <Expandable key={i} title={r.name} sub={`${r.schedule}${r.enabled ? '' : ' · paused'}`} body={r.prompt} />)}</div>
        : <p className="bot-profile__empty">Nothing runs on its own yet. Ask in chat, for example “every weekday at 8am, send me a summary”.</p>;
    case 'integrations':
      return data.integrations.length
        ? <ul className="bot-profile__apps">{data.integrations.map(slug => (
          <li key={slug}>
            <ToolkitLogo name={slug} logo={`https://logos.composio.dev/api/${slug}`} size={20} radius={5} />
            <span>{slug.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</span>
            {data.connected && <span className={`bot-profile__app-state${data.connected.includes(slug) ? ' is-on' : ''}`}>{data.connected.includes(slug) ? 'Connected' : 'Not connected'}</span>}
          </li>
        ))}</ul>
        : <p className="bot-profile__empty">Uses its own computer, browser and files. Connect apps in Settings → Connected apps when it needs them.</p>;
  }
}

function Expandable({ title, sub, body }: { title: string; sub?: string; body: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`bot-profile__card${open ? ' is-open' : ''}`}>
      <button type="button" className="bot-profile__card-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="bot-profile__card-title">{title}</span>
        {sub && <span className="bot-profile__card-sub">{sub}</span>}
      </button>
      {open && <pre className="bot-profile__card-body">{body}</pre>}
    </div>
  );
}

/** Templates to start a Bot from, plus importing a Bot exported from Marion Agent. */
export function TemplateGallery() {
  const set = useFeatureUI(s => s.set);
  const [templates, setTemplates] = useState<BotProfileData[] | null>(null);
  const [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { featuresApi.templates().then(r => setTemplates(r.templates)).catch(e => setError((e as Error).message)); }, []);
  const close = () => set({ gallery: false });
  const importFile = async (chosen: File | undefined) => {
    if (!chosen) return;
    setError('');
    try {
      const spec = JSON.parse(await chosen.text());
      const { bot } = await featuresApi.importBot(spec);
      const st = useStore.getState();
      st.set({ bots: st.bots.some(b => b.id === bot.id) ? st.bots : [...st.bots, bot] });
      close();
      openBotChat(bot.id);
    } catch (e) {
      setError(e instanceof SyntaxError ? 'That file isn’t a Marion Agent Bot.' : (e as Error).message);
    }
  };
  return (
    <Modal onClose={close} className="template-gallery" label="Bot templates">
      <div className="bot-profile__bar">
        <h2 className="template-gallery__title">Start from a template</h2>
        <div className="bot-profile__bar-actions">
          <input ref={file} type="file" accept=".json,application/json" hidden onChange={e => { void importFile(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => file.current?.click()}><Download size={14} /> Import file</button>
          <button type="button" className="icon-btn" onClick={close} aria-label="Close" title="Close"><X size={19} /></button>
        </div>
      </div>
      {error && <p className="bot-profile__error template-gallery__error" role="alert">{error}</p>}
      <div className="template-gallery__grid">
        {(templates ?? []).map(t => (
          <button key={t.id} type="button" className="template-card" onClick={() => set({ gallery: false, profile: { kind: 'template', id: t.id, back: true } })}>
            <BotAvatar shape={t.avatarShape ?? 'marionberry'} color={(t.avatarColor ?? 'violet') as never} stemColor={t.avatarStemColor === undefined ? DEFAULT_STEM_COLOR : t.avatarStemColor} glow={t.avatarGlow} size={48} />
            <span className="template-card__name">{t.name}</span>
            <span className="template-card__tagline">{t.tagline}</span>
            <span className="template-card__meta">{[t.skills.length && `${t.skills.length} skill${t.skills.length === 1 ? '' : 's'}`, t.routines.length && `${t.routines.length} routine${t.routines.length === 1 ? '' : 's'}`, t.role === 'executive' && 'Executive', t.custom && 'Saved by you'].filter(Boolean).join(' · ') || 'Ready to use'}</span>
          </button>
        ))}
        {!templates && !error && <p className="bot-profile__empty">Loading…</p>}
      </div>
    </Modal>
  );
}
