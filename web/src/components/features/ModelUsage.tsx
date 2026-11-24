import { useEffect, useMemo, useState } from 'react';
import type { Bot, ResponseUsage, SubscriptionUsage } from '@shared/types';
import { api } from '../../lib/api';
import { usageLabel } from '../../lib/modelUsage';
import { formatTokens } from '../../lib/featuresApi';
import { sortedRows, useStore } from '../../store';
import { useVoice } from '../../voice/call';
import { callModelFor, isLocalCallActive, useLocalCall } from '../../voice/localCall';

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
    <div className="panel-card context-card model-usage">
      <div className="context-card__top">
        <span className="context-card__label">Model usage</span>
        <span className="context-card__value" title={realtime || model?.model}>{realtime || model?.label || lastChatUsage?.label || model?.model || 'Default model'}</span>
      </div>
      {usage
        ? <span className="context-card__meta" title={usageLabel(usage)}>Last response · {usage.estimated ? '≈' : ''}{formatTokens(usage.input + usage.output)} tokens</span>
        : <span className="context-card__meta">{realtime ? 'Usage unavailable until reported by the provider.' : 'Usage appears after the first response.'}</span>}
      {windows.map(window => (
        <div key={window.id} className="context-card__meta">
          <span>{window.label}{plan?.status === 'stale' ? ' · Last checked' : ''}</span>
          <span>{Math.round(window.usedPercent)}% of plan used</span>
        </div>
      ))}
    </div>
  );
}
