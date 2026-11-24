import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Crown, Plus, Trash2, Users, X } from 'lucide-react';
import type { ChatModel, ChatModelSelection, ChatProvider, TeamMember } from '@shared/types';
import { configApi } from '../../lib/configApi';
import { useSelectedBot, useStore } from '../../store';
import { Modal } from './Modal';

const providerNames: Record<ChatProvider, string> = { local: 'Local', codex: 'Codex', gemini: 'Gemini', claude: 'Claude' };
const icons: Record<ChatProvider, string> = { local: 'qwen-color', codex: 'codex', gemini: 'gemini-color', claude: 'claude-color' };
const roles = ['Coder', 'Reviewer', 'Researcher', 'Planner', 'Writer', 'Tester'];
const keyOf = (m: { provider: ChatProvider; model: string }) => `${m.provider}:${m.model}`;

type Draft = Omit<TeamMember, 'id'> & { id?: string };

function ProviderIcon({ provider }: { provider: ChatProvider }) {
  return <img className="team-row__icon" src={`/providers/${icons[provider]}.svg`} alt="" width="16" height="16" />;
}

/** Team mode: pick the orchestrator and the models it works with, for this chat. */
export function TeamModal() {
  const bot = useSelectedBot();
  const close = () => useStore.getState().setModal(null);
  const [models, setModels] = useState<ChatModel[]>([]);
  const [unavailable, setUnavailable] = useState<Partial<Record<ChatProvider, string>>>({});
  const [orchestrator, setOrchestrator] = useState<ChatModelSelection>();
  const [enabled, setEnabled] = useState(false);
  const [balance, setBalance] = useState(true);
  const [members, setMembers] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [backup, setBackup] = useState<{ installed: boolean; name?: string }>();

  useEffect(() => {
    if (!bot) return;
    let live = true;
    Promise.all([configApi.orchestration(bot.id), configApi.chatModels(bot.id, true)]).then(([team, catalog]) => {
      if (!live) return;
      setOrchestrator(team.orchestrator);
      setEnabled(team.settings.enabled);
      setBalance(team.settings.balanceUsage);
      setMembers(team.settings.members);
      setModels(catalog.models);
      setUnavailable(catalog.unavailable);
    }).catch(cause => live && setError((cause as Error).message)).finally(() => live && setLoading(false));
    configApi.orchestrationBackup().then(result => live && setBackup(result.t3Code)).catch(() => {});
    return () => { live = false; };
  }, [bot?.id]);

  const grouped = useMemo(() => (['local', 'codex', 'gemini', 'claude'] as ChatProvider[])
    .map(provider => ({ provider, models: models.filter(model => model.provider === provider) }))
    .filter(group => group.models.length), [models]);

  if (!bot) return null;
  const find = (key: string) => models.find(model => keyOf({ provider: model.provider, model: model.id }) === key);

  const modelSelect = (value: string, onChange: (model: ChatModel) => void, label: string) => (
    <select className="team-select" value={value} aria-label={label} disabled={loading} onChange={event => { const model = find(event.target.value); if (model) onChange(model); }}>
      {!find(value) && <option value={value}>{value.split(':').slice(1).join(':') || 'Choose a model'}</option>}
      {grouped.map(group => (
        <optgroup key={group.provider} label={providerNames[group.provider]}>
          {group.models.map(model => <option key={model.id} value={keyOf({ provider: model.provider, model: model.id })}>{model.label}</option>)}
        </optgroup>
      ))}
    </select>
  );

  const addMember = (preset?: ChatModel) => {
    const used = new Set(members.map(keyOf));
    const model = preset ?? models.find(option => !used.has(keyOf({ provider: option.provider, model: option.id })) && keyOf({ provider: option.provider, model: option.id }) !== (orchestrator && keyOf(orchestrator)))
      ?? models[0];
    if (!model) return;
    setMembers(current => [...current, {
      provider: model.provider, model: model.id, effort: model.defaultEffort ?? (model.provider === 'local' ? 'medium' : null),
      label: `${providerNames[model.provider]}${current.some(m => m.provider === model.provider) ? ` ${current.filter(m => m.provider === model.provider).length + 1}` : ''}`,
      role: roles[current.length % roles.length],
    }]);
  };
  const update = (index: number, patch: Partial<Draft>) => setMembers(current => current.map((member, i) => i === index ? { ...member, ...patch } : member));

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      if (orchestrator && (orchestrator.provider !== bot.chatModel?.provider || orchestrator.model !== bot.chatModel?.model || orchestrator.effort !== bot.chatModel?.effort)) {
        await useStore.getState().saveChatModel(bot.id, orchestrator);
      }
      await configApi.saveOrchestration(bot.id, { enabled: enabled && members.length > 0, members, balanceUsage: balance });
      close();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const orchestratorModel = orchestrator && find(keyOf(orchestrator));
  return (
    <Modal onClose={close} className="team-modal" label="Team mode">
      <header className="team-modal__header">
        <div className="team-modal__title">
          <span className="team-modal__symbol"><Users size={20} aria-hidden="true" /></span>
          <div><h1>Team mode</h1><p>{bot.name} orchestrates other models so they work together on this chat.</p></div>
        </div>
        <button type="button" className="icon-btn" onClick={close} aria-label="Close"><X size={19} /></button>
      </header>

      <div className="team-modal__body" aria-busy={loading}>
        <label className="team-switch">
          <span><b>Work as a team</b><small>Spread work across your plans so each 5-hour window lasts longer, and let models check each other.</small></span>
          <button type="button" role="switch" aria-checked={enabled} className={`toggle${enabled ? ' is-on' : ''}`} onClick={() => setEnabled(value => !value)} aria-label="Work as a team">
            <span className="toggle__knob" />
          </button>
        </label>

        <section className={`team-section${enabled ? '' : ' is-off'}`}>
          <h2><Crown size={14} aria-hidden="true" /> Orchestrator</h2>
          <p className="team-hint">Plans the work, runs Marion's tools, hands out tasks and answers you.</p>
          <div className="team-row team-row--lead">
            {orchestrator && <ProviderIcon provider={orchestrator.provider} />}
            {modelSelect(orchestrator ? keyOf(orchestrator) : '', model => setOrchestrator({
              provider: model.provider, model: model.id, label: model.label,
              effort: orchestrator?.provider === model.provider && orchestrator.effort && model.efforts.includes(orchestrator.effort) ? orchestrator.effort : model.defaultEffort ?? (model.provider === 'local' ? 'medium' : null),
            }), 'Orchestrator model')}
            {orchestratorModel && orchestratorModel.efforts.length > 0 && (
              <select className="team-select team-select--effort" aria-label="Orchestrator effort" value={orchestrator?.effort ?? ''} onChange={event => setOrchestrator(current => current && { ...current, effort: event.target.value })}>
                {orchestratorModel.efforts.map(effort => <option key={effort} value={effort}>{effort === 'xhigh' ? 'Extra high' : effort[0].toUpperCase() + effort.slice(1)}</option>)}
              </select>
            )}
          </div>
        </section>

        <section className={`team-section${enabled ? '' : ' is-off'}`}>
          <h2><Users size={14} aria-hidden="true" /> Team members <span className="team-count">{members.length}/6</span></h2>
          <p className="team-hint">Any mix of local and cloud models. They see each other's work on a shared team board.</p>
          <ul className="team-list">
            {members.map((member, index) => {
              const option = find(keyOf(member));
              return (
                <li className="team-row" key={member.id ?? `new-${index}`}>
                  <ProviderIcon provider={member.provider} />
                  <input className="team-input team-input--name" value={member.label} maxLength={40} aria-label="Member name"
                    onChange={event => update(index, { label: event.target.value })} />
                  {modelSelect(keyOf(member), model => update(index, { provider: model.provider, model: model.id, effort: model.defaultEffort ?? (model.provider === 'local' ? 'medium' : null) }), `${member.label} model`)}
                  {option && option.efforts.length > 0 && (
                    <select className="team-select team-select--effort" aria-label={`${member.label} effort`} value={member.effort ?? ''} onChange={event => update(index, { effort: event.target.value })}>
                      {option.efforts.map(effort => <option key={effort} value={effort}>{effort === 'xhigh' ? 'Extra high' : effort[0].toUpperCase() + effort.slice(1)}</option>)}
                    </select>
                  )}
                  <input className="team-input team-input--role" value={member.role} list="team-roles" maxLength={80} placeholder="Role" aria-label={`${member.label} role`}
                    onChange={event => update(index, { role: event.target.value })} />
                  <button type="button" className="icon-btn team-row__remove" aria-label={`Remove ${member.label}`} onClick={() => setMembers(current => current.filter((_, i) => i !== index))}><Trash2 size={15} /></button>
                </li>
              );
            })}
          </ul>
          <datalist id="team-roles">{roles.map(role => <option key={role} value={role} />)}</datalist>
          <div className="team-actions">
            <button type="button" className="team-add" disabled={loading || members.length >= 6 || !models.length} onClick={() => addMember()}><Plus size={14} /> Add member</button>
            {(['codex', 'gemini', 'claude', 'local'] as ChatProvider[]).map(provider => {
              const model = models.find(option => option.provider === provider);
              if (!model || members.length >= 6) return null;
              return <button type="button" key={provider} className="team-chip" onClick={() => addMember(model)}><ProviderIcon provider={provider} /> {providerNames[provider]}</button>;
            })}
          </div>
          {Object.entries(unavailable).map(([provider, reason]) => <p className="team-hint team-hint--warn" key={provider}>{providerNames[provider as ChatProvider]}: {reason}</p>)}
        </section>

        <label className="team-switch team-switch--small">
          <span><b>Balance plan usage</b><small>Give "auto" tasks to whoever has the most usage left, and hand off when a plan runs out.</small></span>
          <button type="button" role="switch" aria-checked={balance} className={`toggle${balance ? ' is-on' : ''}`} onClick={() => setBalance(value => !value)} aria-label="Balance plan usage">
            <span className="toggle__knob" />
          </button>
        </label>

        {backup?.installed && (
          <div className="team-backup">
            <span><b>Backup: {backup.name}</b><small>If Team mode can't do a job, run the agents side by side in T3 Code.</small></span>
            <button type="button" className="team-add" onClick={() => configApi.openOrchestrationBackup().catch(cause => setError((cause as Error).message))}>Open <ArrowUpRight size={13} /></button>
          </div>
        )}
        {error && <p className="team-error" role="alert">{error}</p>}
      </div>

      <footer className="team-modal__footer">
        <button type="button" className="btn" onClick={close}>Cancel</button>
        <button type="button" className="btn btn--primary" disabled={saving || loading} onClick={save}>{saving ? 'Saving…' : 'Save team'}</button>
      </footer>
    </Modal>
  );
}
