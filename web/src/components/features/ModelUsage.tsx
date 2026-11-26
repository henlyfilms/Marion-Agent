import { useEffect, useMemo, useState } from 'react';
import type { Bot, ResponseUsage, SubscriptionUsage } from '@shared/types';
import { api } from '../../lib/api';
import { usageLabel } from '../../lib/modelUsage';
import { formatTokens } from '../../lib/featuresApi';
import { sortedRows, useStore } from '../../store';
import { useVoice } from '../../voice/call';
import { callModelFor, isLocalCallActive, useLocalCall } from '../../voice/localCall';
import { ModelIcon } from '../ProviderLogo';

const resetFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** One plan window as a glowing bar that glides to its value; warms up as the limit gets close. */
function UsageMeter({ label, used, resetsAt }: { label: string; used: number; resetsAt?: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(Math.min(100, Math.max(0, used))));
    return () => cancelAnimationFrame(frame);
  }, [used]);
  const tone = used >= 90 ? 'is-high' : used >= 70 ? 'is-warm' : '';
  const reset = resetsAt ? new Date(resetsAt) : null;
  const percent = used > 0 && used < 1 ? '<1' : String(Math.round(used));
  return (
    <div className={`model-usage__window ${tone}`}>
      <div className="model-usage__row">
        <span>{label}</span>
        <strong>{percent}%<small> used</small></strong>
      </div>
      <div className="model-usage__bar" role="meter" aria-label={`${label} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used)}>
        <span style={{ transform: `scaleX(${shown / 100})` }} />
      </div>
      {reset && !Number.isNaN(reset.getTime()) && <span className="model-usage__reset">Resets {resetFormat.format(reset)}</span>}
    </div>
  );
}

export function ModelUsage({ bot, open }: { bot: Bot; open: boolean }) {
  const onCall = useLocalCall(state => state.botId === bot.id && isLocalCallActive(state));
  const realtime = useVoice(state => state.botId === bot.id && state.status === 'live' ? state.model : undefined);
  const realtimeUsage = useVoice(state => state.botId === bot.id && state.status === 'live' ? state.usage : undefined);
  const live = useStore(state => state.live[bot.id]);
  const transcript = useStore(state => state.transcripts[bot.id]);
  const model = live?.activeModel ?? (onCall ? callModelFor(bot.id) : null) ?? bot.chatModel;
  const provider = realtime ? undefined : model?.provider;
  const [plan, setPlan] = useState<SubscriptionUsage>();
  const completedAt = bot.completedAt;

  useEffect(() => {
    if (!open || !provider || provider === 'local') return;
    const ctrl = new AbortController();
    api.subscriptionUsage(false, ctrl.signal, provider).then(result => {
      if (!ctrl.signal.aborted) setPlan(result.subscriptions[0]);
    }).catch(() => {});
    return () => ctrl.abort();
  }, [open, provider, completedAt]);

  const matched = (items?: ResponseUsage[]) => items?.find(usage =>
    usage.provider === provider && (!model?.model || usage.model === model.model));
  const previous = useMemo(() => sortedRows(transcript).flatMap(row =>
    row.body.type === 'message' && !row.body.from && row.body.usage ? [row.body.usage] : []).reverse(), [transcript]);
  const lastChatUsage = matched(live?.modelUsage) ?? previous.map(matched).find(Boolean);
  const usage = realtime ? realtimeUsage : lastChatUsage;
  const windows = plan?.provider === provider ? plan?.windows ?? [] : [];

  return (
    <div className={`panel-card context-card model-usage${provider ? ` model-usage--${provider}` : ''}`}>
      <div className="context-card__top">
        <span className="context-card__label">Model usage</span>
        <span className="context-card__value model-usage__model" title={realtime || model?.model}>
          {provider && <ModelIcon provider={provider} model={model?.model} size={15} />}
          <span>{realtime || model?.label || lastChatUsage?.label || model?.model || 'Default model'}</span>
        </span>
      </div>
      {usage
        ? <span className="context-card__meta" title={usageLabel(usage)}>Last response · {usage.estimated ? '≈' : ''}{formatTokens(usage.input + usage.output)} tokens</span>
        : <span className="context-card__meta">{realtime ? 'Usage unavailable until reported by the provider.' : 'Usage appears after the first response.'}</span>}
      {windows.length > 0 && (
        <div className={`model-usage__windows${plan?.status === 'stale' ? ' is-stale' : ''}`}>
          {windows.map(window => <UsageMeter key={window.id} label={window.label} used={window.usedPercent} resetsAt={window.resetsAt} />)}
        </div>
      )}
    </div>
  );
}
