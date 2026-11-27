import { useId } from 'react';
import type { WorkAgent } from '@shared/types';
import { summarizeWorkUsage, usageColor, usageTone } from '@shared/usage-scale';
import { formatTokens } from '../../lib/featuresApi';

const number = new Intl.NumberFormat();
const resetFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const pct = (value: number) => value > 0 && value < 1 ? '<1%' : `${Math.round(value)}%`;
const money = (value: number) => value < 0.01 ? '<$0.01' : `$${value.toFixed(value < 10 ? 2 : 1)}`;

/** A small progress ring, colored on the blue → red usage scale (like the usage rings in the Claude apps). */
export function UsageRing({ percent, size = 18 }: { percent: number; size?: number }) {
  const value = Math.min(100, Math.max(0, percent));
  // A sliver always shows, so a fresh run still reads as a ring with a start.
  const shown = value > 0 ? Math.max(value, 3) : 0;
  return (
    <svg className="usage-ring" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <circle className="usage-ring__track" cx="10" cy="10" r="7.5" />
      <circle className="usage-ring__value" cx="10" cy="10" r="7.5" pathLength={100}
        strokeDasharray={`${shown} 100`} style={{ stroke: usageColor(value) }} transform="rotate(-90 10 10)" />
    </svg>
  );
}

/** Task usage and session context for a work card: two rings, full breakdown on hover or focus. */
export function UsageRings({ agents }: { agents: WorkAgent[] }) {
  const tip = useId();
  const usage = summarizeWorkUsage(agents);
  if (!usage) return null;
  const { tokens, context, limit } = usage;
  const delta = limit ? limit.usedPercent - limit.startPercent : 0;
  const taskLabel = usage.taskBasis === 'limit' ? `+${pct(usage.taskPercent)}` : formatTokens(tokens.total);
  const taskText = usage.taskBasis === 'limit' && limit
    ? `Task used ${pct(usage.taskPercent)} of the ${limit.label.toLowerCase()}`
    : `Task used ${number.format(tokens.total)} tokens`;
  const reset = limit?.resetsAt ? new Date(limit.resetsAt) : null;
  return (
    <span className={`work-meters${usage.live ? ' is-live' : ''}`} tabIndex={0} aria-describedby={tip}
      aria-label={[taskText, context && `session context ${pct(context.percent)} full`].filter(Boolean).join(', ')}>
      <span className={`work-meter is-${usageTone(usage.taskPercent)}`} data-meter="task">
        <UsageRing percent={usage.taskPercent} />
        <b>{taskLabel}</b><small>task</small>
      </span>
      {context && (
        <span className={`work-meter is-${usageTone(context.percent)}`} data-meter="context">
          <UsageRing percent={context.percent} />
          <b>{pct(context.percent)}</b><small>context</small>
        </span>
      )}
      <span className="work-meters__tip" role="tooltip" id={tip}>
        <strong>Task usage{usage.live ? ' · live' : ''}</strong>
        <span>{number.format(tokens.total)} tokens</span>
        <small>
          {[`${number.format(tokens.input)} input`, tokens.cached && `${formatTokens(tokens.cached)} cache read`, tokens.cacheWrite && `${formatTokens(tokens.cacheWrite)} cache write`,
            `${formatTokens(tokens.output)} output${tokens.reasoning ? ` (${formatTokens(tokens.reasoning)} reasoning)` : ''}`].filter(Boolean).join(' · ')}
        </small>
        {usage.costUsd !== undefined && <span>{money(usage.costUsd)} <small>API-equivalent cost</small></span>}
        {limit && (
          <span>
            {limit.label}: {delta > 0 ? `${pct(limit.startPercent)} → ${pct(limit.usedPercent)} (+${pct(delta)})` : `${pct(limit.usedPercent)} used`}
            {reset && !Number.isNaN(reset.getTime()) && <small> · resets {resetFormat.format(reset)}</small>}
          </span>
        )}
        {usage.taskBasis === 'tokens' && <small>Ring: {pct(usage.taskPercent)} of a large task (cost-weighted tokens)</small>}
        {context && <>
          <strong>Session context</strong>
          <span>{number.format(context.tokens)} of {number.format(context.window)} tokens ({pct(context.percent)})</span>
          {(agents.filter(agent => agent.usage?.context).length > 1 || !context.windowKnown) && (
            <small>{[agents.filter(agent => agent.usage?.context).length > 1 && `Fullest: ${context.agent}`, !context.windowKnown && 'window size estimated'].filter(Boolean).join(' · ')}</small>
          )}
        </>}
      </span>
    </span>
  );
}
