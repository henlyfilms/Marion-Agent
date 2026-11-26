import type { CardBody, ChatModelSelection, ChatProvider, Row } from '@shared/types';
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { configApi, type SubscriptionModelSettings } from '../lib/configApi';
import { featuresApi, type AgentSettings } from '../lib/featuresApi';
import { Switch } from './config/ui';

const providers = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' } as const;
type Provider = keyof typeof providers;

function FallbackFields({ initial, onChange }: {
  initial: ChatModelSelection | null; onChange: (selection: ChatModelSelection | null) => void;
}) {
  const [provider, setProvider] = useState<Provider>(initial?.provider && initial.provider !== 'local' ? initial.provider : 'codex');
  const [model, setModel] = useState(initial?.model ?? '');
  const [effort, setEffort] = useState(initial?.effort ?? '');
  const [catalog, setCatalog] = useState<SubscriptionModelSettings | null>(null);
  useEffect(() => {
    let current = true;
    configApi.subscriptionModel(provider).then(result => { if (current) setCatalog(result); },
      error => { if (current) setCatalog({ models: [], selection: { provider, model: '', effort: null }, error: error.message }); });
    return () => { current = false; };
  }, [provider]);
  const data = catalog?.selection.provider === provider ? catalog : null;
  const chosen = data?.models.find(option => option.id === model)
    ?? data?.models.find(option => option.id === data.selection.model) ?? data?.models[0];
  const reasoning = chosen?.efforts.includes(effort) ? effort : chosen?.defaultEffort ?? chosen?.efforts[0] ?? null;
  useEffect(() => {
    onChange(chosen ? { provider, model: chosen.id, effort: reasoning } : null);
  }, [chosen, reasoning, provider, onChange]);
  return (
    <div className="utility-fields">
      <label>Provider<select className="text-input" value={provider} onChange={event => {
        setCatalog(null); setProvider(event.target.value as Exclude<ChatProvider, 'local'>); setModel(''); setEffort('');
      }}>
        {Object.entries(providers).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select></label>
      <label>Model<select className="text-input" value={chosen?.id ?? ''} disabled={!chosen} onChange={event => {
        setModel(event.target.value); setEffort('');
      }}>
        {!chosen && <option value="">{data ? 'No models available' : 'Loading models…'}</option>}
        {data?.models.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select></label>
      <label>Effort<select className="text-input" value={reasoning ?? ''} disabled={!chosen?.efforts.length} onChange={event => setEffort(event.target.value)}>
        {!reasoning && <option value="">Provider default</option>}
        {chosen?.efforts.map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>
      {data?.error && <p className="cfg-field__hint" role="status">{data.error}</p>}
    </div>
  );
}

export function HandoffSettings() {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [selection, setSelection] = useState<ChatModelSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { featuresApi.agentSettings().then(result => setSettings(result.settings), cause => setError(cause.message)); }, []);
  const save = async (patch: Partial<AgentSettings>) => {
    setBusy(true); setError('');
    try { setSettings((await featuresApi.saveAgentSettings(patch)).settings); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const saved = settings?.handoffFallback;
  const unchanged = saved?.provider === selection?.provider && saved?.model === selection?.model && saved?.effort === selection?.effort;
  return (
    <section className="cfg-card utility-settings">
      <div className="cfg-row">
        <div><div className="cfg-row__title">Auto-handoff</div>
        <div className="cfg-row__sub">When a subscription hits its limit, save its progress and continue with the fallback. Off asks first.</div></div>
        <Switch label="Auto-handoff" on={!!settings?.autoHandoff} disabled={busy || !settings || (!settings.autoHandoff && !saved)}
          onChange={autoHandoff => void save({ autoHandoff })} />
      </div>
      {settings && <FallbackFields initial={settings.handoffFallback} onChange={setSelection} />}
      <div><button type="button" className="btn btn--primary" disabled={busy || !selection || unchanged}
        onClick={() => void save({ handoffFallback: selection })}>Save fallback</button></div>
      {error && <p role="alert" className="cfg-field__hint">{error}</p>}
    </section>
  );
}

export function UsageHandoffCard({ row, body }: { row: Row; body: Extract<CardBody, { card: 'handoff' }> }) {
  const local = useStore(s => s.localWorkspace && !s.mobilePaired);
  const [selection, setSelection] = useState<ChatModelSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [started, setStarted] = useState(false);
  async function submit() {
    if (!selection || busy) return;
    setBusy(true); setError('');
    try { await featuresApi.continueHandoff(row.botId, body.id, row.seq, selection); setStarted(true); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <section className="utility-handoff cfg-card" aria-label="Usage-limit handoff">
      <strong>{providers[body.provider]} hit its usage limit</strong>
      <p className="cfg-field__hint">{body.goal}</p>
      {body.status === 'started' || started ? <p role="status">Continuation started from the saved handoff.</p>
        : !local ? <p>Handoff saved. Open Marion Agent on the Mac to continue.</p>
        : <>
          <p>Handoff saved. Choose where to continue the work.</p>
          <FallbackFields initial={body.fallback ?? { provider: body.provider === 'codex' ? 'claude' : 'codex', model: '', effort: null }} onChange={setSelection} />
          <div><button type="button" className="btn btn--primary" disabled={busy || !selection} onClick={() => void submit()}>
            {busy ? 'Starting…' : 'Continue from handoff'}
          </button></div>
        </>}
      {error && <p role="alert" className="cfg-field__hint">{error}</p>}
    </section>
  );
}
