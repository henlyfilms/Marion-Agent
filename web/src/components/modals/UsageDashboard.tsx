import { useEffect, useState } from 'react';
import { Activity, ArrowUpRight, CircleAlert, Code2, RefreshCw, Sparkles, Sun, X } from 'lucide-react';
import type { SubscriptionUsage, UsageWindow } from '@shared/types';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { Modal } from './Modal';

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

function Window({ window }: { window: UsageWindow }) {
  const used = window.usedPercent;
  const value = percentage.format(used / 100);
  const reset = window.resetsAt && new Date(window.resetsAt);
  const resetLabel = window.resetLabel?.replace(` (${localZone})`, '');
  return (
    <div className={`usage-window${used >= 90 ? ' is-high' : ''}`}>
      <div className="usage-window__label"><span>{window.label}</span><strong>{value} <small>used</small></strong></div>
      <progress max={100} value={used} aria-label={window.label} aria-valuetext={`${value} used`} />
      <div className="usage-window__reset">
        {reset ? <time dateTime={reset.toISOString()}>Resets {resetFormat.format(reset)}</time> : resetLabel ? `Resets ${resetLabel}` : 'Reset time unavailable'}
      </div>
    </div>
  );
}

export function UsageDashboard() {
  const close = () => useStore.getState().setModal(null);
  const [data, setData] = useState<SubscriptionUsage[]>();
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const request = new AbortController();
    async function load(provider: typeof providers[number]['id']) {
      try {
        const { subscriptions: [item] } = await api.subscriptionUsage(refresh > 0, request.signal, provider);
        if (item && !request.signal.aborted) setData(current => [...(current ?? []).filter(entry => entry.provider !== provider), item]);
      } catch {
        if (!request.signal.aborted) setError(true);
      }
    }
    void Promise.all(providers.map(({ id }) => load(id))).then(() => {
      if (!request.signal.aborted) setLoading(false);
    });
    return () => request.abort();
  }, [refresh]);

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
            <span className={readings ? 'usage-check is-ready' : 'usage-check'} />
            {data ? `${readings} of ${providers.length} reporting${loading ? ' · Updating…' : ''}` : loading ? 'Checking subscriptions…' : 'Usage unavailable'}
          </span>
          <button type="button" className="usage-dashboard__refresh" disabled={loading} onClick={() => { setLoading(true); setError(false); setRefresh(value => value + 1); }}>
            <RefreshCw size={14} aria-hidden="true" /> Refresh
          </button>
        </div>
        {error && <p className="usage-dashboard__error" role="alert"><CircleAlert size={16} /> Couldn’t reach the usage service. Try refreshing.</p>}
        <div className="usage-dashboard__grid">
          {providers.map(({ id, name, account, icon: Mark, url }) => {
            const item = data?.find(subscription => subscription.provider === id);
            return (
              <section className={`usage-card usage-card--${id}`} key={id} aria-label={name}>
                <header className="usage-card__header">
                  <span className="usage-card__mark"><Mark size={20} aria-hidden="true" /></span>
                  <div><h2>{name}</h2><p>{item?.plan ?? account}</p></div>
                </header>
                <div className="usage-card__body">
                  {item?.windows.length ? item.windows.map(window => <Window key={window.id} window={window} />) : (
                    <div className="usage-card__empty">
                      <span>{item ? statusLabels[item.status] : loading ? 'Checking limits…' : 'Unavailable'}</span>
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
        <span>Provider-reported usage</span>
        {checkedAt > 0 && <span>Latest reading at <time dateTime={new Date(checkedAt).toISOString()}>{timeFormat.format(checkedAt)}</time></span>}
      </footer>
    </Modal>
  );
}
