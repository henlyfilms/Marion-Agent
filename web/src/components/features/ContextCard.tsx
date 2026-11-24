import { useEffect, useState } from 'react';
import type { Bot } from '@shared/types';
import { featuresApi, formatTokens, type ContextInfo } from '../../lib/featuresApi';
import { useStore } from '../../store';
import { Menu } from '../Menu';

const LIMIT = 1_000_000;
const AUTO_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'App default' },
  { value: 25_000, label: '25k tokens' },
  { value: 50_000, label: '50k tokens' },
  { value: 100_000, label: '100k tokens' },
  { value: 200_000, label: '200k tokens' },
  { value: 500_000, label: '500k tokens' },
  { value: 0, label: 'Never' },
];

/** Where a value sits on a 0 → 1M bar. Square-root scale so small chats still show a visible fill. */
export const contextFraction = (tokens: number) => Math.min(1, Math.sqrt(Math.max(0, tokens) / LIMIT));

export function contextTone(tokens: number) {
  return tokens >= 500_000 ? 'is-high' : tokens >= 150_000 ? 'is-mid' : '';
}

/** Context used by this chat (0 to 1M tokens) with compaction controls. */
export function ContextCard({ bot }: { bot: Bot }) {
  const [info, setInfo] = useState<ContextInfo | null>(null);
  const [busy, setBusy] = useState<'compact' | 'improve' | null>(null);
  const [message, setMessage] = useState('');
  const [menu, setMenu] = useState(false);
  const running = useStore(s => !!s.live[bot.id]?.isRunning);

  useEffect(() => {
    let alive = true;
    featuresApi.context(bot.id).then(next => { if (alive) setInfo(next); }).catch(() => {});
    return () => { alive = false; };
  }, [bot.id, bot.contextTokens, bot.generation, bot.compactAtTokens]);

  const tokens = bot.contextTokens ?? info?.tokens ?? 0;
  const autoAt = bot.compactAtTokens ?? info?.compactAtTokens ?? null;
  const autoLabel = autoAt === 0 ? 'Auto-compact off' : `Auto-compacts at ${formatTokens(autoAt ?? info?.defaultCompactAtTokens ?? 75_000)}`;

  const compact = async () => {
    setBusy('compact'); setMessage('');
    try {
      const result = await featuresApi.compact(bot.id);
      setMessage(`Compacted to about ${formatTokens(result.tokens)} tokens.`);
      setInfo(await featuresApi.context(bot.id));
    } catch (e) { setMessage((e as Error).message); }
    finally { setBusy(null); }
  };
  const improve = async () => {
    setBusy('improve'); setMessage('');
    try {
      const result = await featuresApi.improve(bot.id);
      setMessage(result.lessons || result.skills
        ? `Learned ${result.lessons} lesson${result.lessons === 1 ? '' : 's'} and updated ${result.skills} skill${result.skills === 1 ? '' : 's'}.`
        : 'Nothing new to learn from this chat yet.');
    } catch (e) { setMessage((e as Error).message); }
    finally { setBusy(null); }
  };
  const setAuto = async (value: number | null) => {
    setMenu(false);
    try {
      const { bot: updated } = await featuresApi.setBot(bot.id, { compactAtTokens: value });
      useStore.setState(s => ({ bots: s.bots.map(b => b.id === updated.id ? updated : b) }));
    } catch (e) { setMessage((e as Error).message); }
  };

  return (
    <div className="panel-card context-card">
      <div className="context-card__top">
        <span className="context-card__label">Context</span>
        <span className="context-card__value" title={`${tokens.toLocaleString()} of ${LIMIT.toLocaleString()} tokens`}>
          {formatTokens(tokens)} <span>/ 1M</span>
        </span>
      </div>
      <div className={`context-meter ${contextTone(tokens)}`} role="meter" aria-label="Context used" aria-valuemin={0} aria-valuemax={LIMIT} aria-valuenow={tokens}>
        <span style={{ width: `${contextFraction(tokens) * 100}%` }} />
      </div>
      <div className="context-card__scale" aria-hidden="true"><span>0</span><span>100k</span><span>1M</span></div>
      <div className="context-card__meta">
        <span className="context-card__auto">
          <button type="button" className="link-btn link-btn--small" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}>{autoLabel}</button>
          {menu && <Menu label="Auto-compact" placement="above" items={AUTO_OPTIONS.map(o => ({ label: o.label, checked: (bot.compactAtTokens ?? null) === o.value, onSelect: () => void setAuto(o.value) }))} onClose={() => setMenu(false)} />}
        </span>
        {info?.lastCompaction && <span className="context-card__last">Last: {formatTokens(info.lastCompaction.tokensBefore)} → {formatTokens(info.lastCompaction.tokensAfter)}</span>}
      </div>
      <div className="context-card__actions">
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void compact()} disabled={!!busy || running || (info?.items ?? 0) < 4}
          title="Summarize older messages so each reply costs fewer tokens">{busy === 'compact' ? 'Compacting…' : 'Compact now'}</button>
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void improve()} disabled={!!busy || running}
          title="Turn corrections from this chat into lessons and skills">{busy === 'improve' ? 'Learning…' : 'Learn from chat'}</button>
      </div>
      {message && <p className="context-card__message" role="status">{message}</p>}
    </div>
  );
}
