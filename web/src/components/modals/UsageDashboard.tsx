import { useEffect, useState } from 'react';
import { Activity, ArrowUpRight, CircleAlert, Code2, RefreshCw, Sparkles, Sun, X } from 'lucide-react';
import type { SubscriptionUsage, UsageWindow } from '@shared/types';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { Modal } from './Modal';

type ProviderId = SubscriptionUsage['provider'];
const providers = [
  { id: 'codex', name: 'Codex', account: 'ChatGPT', icon: Code2, url: 'https://chatgpt.com/codex/settings/usage' },
  { id: 'claude', name: 'Claude Code', account: 'Anthropic', icon: Sun, url: 'https://claude.ai/settings/usage' },
  { id: 'gemini', name: 'Gemini', account: 'Google Antigravity', icon: Sparkles, url: 'https://antigravity.google/docs/cli/commands/usage' },
] as const;

const statusLabels = { ready: 'Available', unavailable: 'Unavailable', 'sign-in': 'Sign in required', missing: 'CLI missing', stale: 'Last reading' };
const percentage = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });
const resetFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const localZone = timeFormat.resolvedOptions().timeZone;

/** Last readings, kept between openings so the dashboard opens with numbers instead of an empty flash. */
let remembered: SubscriptionUsage[] | undefined;
let rememberedPlans: { plans: Record<ProviderId, string>; options: Record<ProviderId, string[]> } | undefined;

function Window({ window, index }: { window: UsageWindow; index: number }) {
  const used = window.usedPercent;
  const value = percentage.format(used / 100);
  const reset = window.resetsAt && new Date(window.resetsAt);
  const resetLabel = window.resetLabel?.replace(` (${localZone})`, '');
  // Start the bar at 0 and let CSS grow it, so new numbers glide in instead of snapping.
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(used));
    return () => cancelAnimationFrame(frame);
  }, [used]);
  return (
    <div className={`usage-window${used >= 90 ? ' is-high' : ''}`} style={{ animationDelay: `${index * 60}ms` }}>
      <div className="usage-window__label"><span>{window.label}</span><strong>{value} <small>used</small></strong></div>
      <div className="usage-bar" role="progressbar" aria-label={window.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used)} aria-valuetext={`${value} used`}>
        <span style={{ transform: `scaleX(${shown / 100})` }} />
      </div>
      <div className="usage-window__reset">
        {reset ? <time dateTime={reset.toISOString()}>Resets {resetFormat.format(reset)}</time> : resetLabel ? `Resets ${resetLabel}` : 'Reset time unavailable'}
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="usage-skeleton" aria-hidden="true">
      {[0, 1].map(key => (
        <div className="usage-skeleton__window" key={key}>
          <div className="usage-skeleton__line usage-skeleton__line--label" />
          <div className="usage-skeleton__line usage-skeleton__line--bar" />
          <div className="usage-skeleton__line usage-skeleton__line--reset" />
        </div>
      ))}
    </div>
  );
}

export function UsageDashboard() {
  const close = () => useStore.getState().setModal(null);
  const [data, setData] = useState<SubscriptionUsage[] | undefined>(remembered);
  const [plans, setPlans] = useState(rememberedPlans);
  const [refresh, setRefresh] = useState(0);
  const [pendingIds, setPendingIds] = useState<Set<ProviderId>>(() => new Set(providers.map(p => p.id)));
  const [error, setError] = useState(false);
  const loading = pendingIds.size > 0;

  useEffect(() => {
    api.subscriptionPlans().then(value => { rememberedPlans = value; setPlans(value); }).catch(() => {});
  }, []);

  useEffect(() => {
    const request = new AbortController();
    setPendingIds(new Set(providers.map(p => p.id)));
    async function load(provider: ProviderId) {
      try {
        const { subscriptions: [item] } = await api.subscriptionUsage(refresh > 0, request.signal, provider);
        if (item && !request.signal.aborted) {
          setData(current => {
            const next = [...(current ?? []).filter(entry => entry.provider !== provider), item];
            remembered = next;
            return next;
          });
        }
      } catch {
        if (!request.signal.aborted) setError(true);
      } finally {
        if (!request.signal.aborted) setPendingIds(current => { const next = new Set(current); next.delete(provider); return next; });
      }
    }
    for (const { id } of providers) void load(id);
    return () => request.abort();
  }, [refresh]);

  const choosePlan = (provider: ProviderId, plan: string) => {
    if (!plans) return;
    const next = { ...plans, plans: { ...plans.plans, [provider]: plan } };
    rememberedPlans = next;
    setPlans(next);
    setData(current => current?.map(item => item.provider === provider ? { ...item, plan } : item));
    api.saveSubscriptionPlan(provider, plan).catch(() => {});
  };

  const readings = data?.filter(item => item.status === 'ready').length ?? 0;
  const checkedAt = Math.max(0, ...(data ?? []).map(item => item.checkedAt ?? 0));
  return (
    <Modal onClose={close} className="usage-dashboard" label="Subscription usage">
      <header className="usage-dashboard__header">
        <div className="usage-dashboard__title">
          <div className="usage-dashboard__symbol"><Activity size={21} aria-hidden="true" /></div>
          <div><h1>Subscription usage</h1><p>Account limits and resets for your AI subscriptions.</p></div>
        </div>
        <button type="button" className="icon-btn usage-dashboard__close" onClick={close} aria-label="Close"><X size={19} /></button>
      </header>
      <div className="usage-dashboard__body" aria-busy={loading}>
        <div className="usage-dashboard__toolbar">
          <span className="usage-dashboard__status" role="status">
            <span className={`usage-check${readings ? ' is-ready' : ''}${loading ? ' is-loading' : ''}`} />
            {data?.length ? `${readings} of ${providers.length} reporting` : loading ? 'Checking subscriptions…' : 'Usage unavailable'}
            <span className={`usage-dashboard__updating${loading && data?.length ? ' is-on' : ''}`}> · Updating…</span>
          </span>
          <button type="button" className="usage-dashboard__refresh" disabled={loading} onClick={() => { setError(false); setRefresh(value => value + 1); }}>
            <RefreshCw size={14} aria-hidden="true" className={loading ? 'is-spinning' : undefined} /> Refresh
          </button>
        </div>
        {error && <p className="usage-dashboard__error" role="alert"><CircleAlert size={16} /> Couldn’t reach the usage service. Try refreshing.</p>}
        <div className="usage-dashboard__grid">
          {providers.map(({ id, name, account, icon: Mark, url }, cardIndex) => {
            const item = data?.find(subscription => subscription.provider === id);
            const busy = pendingIds.has(id);
            const plan = plans?.plans[id] ?? item?.plan;
            return (
              <section className={`usage-card usage-card--${id}${busy ? ' is-busy' : ''}`} key={id} aria-label={name} style={{ animationDelay: `${cardIndex * 50}ms` }}>
                <header className="usage-card__header">
                  <span className="usage-card__mark"><Mark size={20} aria-hidden="true" /></span>
                  <div>
                    <h2>{name}</h2>
                    {plans ? (
                      <select className="usage-card__plan" value={plan} aria-label={`${name} plan`} onChange={event => choosePlan(id, event.target.value)}>
                        {plans.options[id].map(option => <option key={option} value={option}>{option}</option>)}
                      </select>
                    ) : <p>{plan ?? account}</p>}
                  </div>
                </header>
                <div className="usage-card__body">
                  {item?.windows.length ? (
                    <div className="usage-card__content" key={item.checkedAt ?? 'saved'}>
                      {item.windows.map((window, index) => <Window key={window.id} window={window} index={index} />)}
                    </div>
                  ) : !item && busy ? <Skeleton /> : (
                    <div className="usage-card__empty usage-card__content">
                      <span>{item ? statusLabels[item.status] : 'Unavailable'}</span>
                      {item?.detail && <p>{item.detail}</p>}
                    </div>
                  )}
                  {item?.status === 'stale' && item.checkedAt && <div className="usage-window__reset">Last reading at {timeFormat.format(item.checkedAt)}</div>}
                </div>
                <a className="usage-card__link" href={url} target="_blank" rel="noreferrer">
                  {id === 'gemini' ? 'Usage command' : 'Provider usage'} <ArrowUpRight size={13} aria-hidden="true" />
                </a>
              </section>
            );
          })}
        </div>
      </div>
      <footer className="usage-dashboard__footer">
        <span>Provider-reported usage · plan names are the ones you picked</span>
        {checkedAt > 0 && <span>Latest reading at <time dateTime={new Date(checkedAt).toISOString()}>{timeFormat.format(checkedAt)}</time></span>}
      </footer>
    </Modal>
  );
}
