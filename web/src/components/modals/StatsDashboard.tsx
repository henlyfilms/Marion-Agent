import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { BarChart3, CircleAlert, Clock, Cpu, Flame, FolderOpen, MessageSquare, Sparkles, Trophy, X } from 'lucide-react';
import type { ChatProvider, StatsBot, StatsDay, StatsRange, StatsSummary, StatsTokens } from '@shared/types';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { featuresApi, formatTokens } from '../../lib/featuresApi';
import { botVars } from '../../lib/colors';
import { relativeShort } from '../../lib/time';
import { useStore } from '../../store';
import { openBotChat } from '../botMenuItems';
import { ProviderLogo } from '../ProviderLogo';
import { FilterBar } from '../sessions/SessionsView';
import { Modal } from './Modal';

const RANGES: { id: StatsRange; label: string }[] = [{ id: '7d', label: '7 days' }, { id: '30d', label: '30 days' }, { id: 'all', label: 'All time' }];
const RANGE_PREF = 'marion-agent:stats-range';
const PROVIDER_NAMES: Record<ChatProvider, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', local: 'Chat models' };
const PROVIDER_ACCENT: Record<ChatProvider, string> = { claude: '#d48161', codex: '#648af7', gemini: '#40ac9f', local: 'var(--color-primary)' };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const number = new Intl.NumberFormat();
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const percent = (value: number) => `${Math.round(value * 100)}%`;
const parseDay = (date: string) => new Date(`${date}T00:00:00Z`);

function readRange(): StatsRange {
  try { const saved = localStorage.getItem(RANGE_PREF); return RANGES.some(r => r.id === saved) ? saved as StatsRange : '30d'; } catch { return '30d'; }
}

function hourLabel(hour: number) {
  const suffix = hour < 12 ? 'AM' : 'PM';
  return `${hour % 12 || 12} ${suffix}`;
}

function duration(ms: number) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return ms >= 1000 ? `${Math.round(ms / 1000)}s` : '0m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${number.format(n)} ${n === 1 ? one : many}`;

/** Last answer per range, kept between openings so the dialog opens with numbers instead of a blank. */
const remembered = new Map<StatsRange, StatsSummary>();

function Kpi({ icon, label, value, detail, tone, children }: { icon: React.ReactNode; label: string; value: React.ReactNode; detail?: React.ReactNode; tone?: 'flame'; children?: React.ReactNode }) {
  return (
    <section className={`stats-kpi${tone ? ` stats-kpi--${tone}` : ''}`} aria-label={label}>
      <span className="stats-kpi__badge" aria-hidden>{icon}</span>
      <div className="stats-kpi__copy">
        <span className="stats-kpi__label">{label}</span>
        <strong className="stats-kpi__value">{value}</strong>
        {detail && <small className="stats-kpi__detail">{detail}</small>}
      </div>
      {children}
    </section>
  );
}

function tipText(day: StatsDay) {
  const parts = [`${plural(day.messages, 'message')}`];
  if (day.runs) parts.push(plural(day.runs, 'agent run'));
  parts.push(`${formatTokens(day.tokens)} tokens`);
  return parts;
}

function Tip({ day, edge }: { day: StatsDay; edge: 'start' | 'end' | 'mid' }) {
  return (
    <span className={`stats-tip stats-tip--${edge}`} role="tooltip">
      <strong>{dayFormat.format(parseDay(day.date))}</strong>
      {tipText(day).map(line => <span key={line}>{line}</span>)}
    </span>
  );
}

const edgeFor = (index: number, length: number) => index < 3 ? 'start' : index > length - 4 ? 'end' : 'mid';

/** Activity of a day: messages you sent plus relayed agent runs. */
const activityOf = (day: StatsDay) => day.messages + day.runs;

/** 7 and 30 days: one bar per day. */
function BarChart({ days }: { days: StatsDay[] }) {
  const max = Math.max(1, ...days.map(activityOf));
  const step = days.length > 14 ? 5 : 1;
  return (
    <div className="stats-bars" role="img" aria-label={`Daily activity, ${days.length} days`}>
      <div className="stats-bars__plot" style={{ '--bars': days.length } as CSSProperties}>
        {days.map((day, index) => {
          const value = activityOf(day);
          return (
            <button type="button" key={day.date} className={`stats-bar${value ? ' is-active' : ''}${index === days.length - 1 ? ' is-today' : ''}`}
              aria-label={`${dayFormat.format(parseDay(day.date))}: ${tipText(day).join(', ')}`}>
              <span className="stats-bar__fill" style={{ height: value ? `${Math.max(6, (value / max) * 100)}%` : undefined }} />
              <Tip day={day} edge={edgeFor(index, days.length)} />
            </button>
          );
        })}
      </div>
      <div className="stats-bars__axis" aria-hidden style={{ '--bars': days.length } as CSSProperties}>
        {days.map((day, index) => <span key={day.date}>{(days.length - 1 - index) % step === 0 ? shortDay.format(parseDay(day.date)) : ''}</span>)}
      </div>
    </div>
  );
}

/** All time: a contribution heatmap, one column per week. */
function Heatmap({ days }: { days: StatsDay[] }) {
  const { cells, weeks } = useMemo(() => {
    const lead = parseDay(days[0].date).getUTCDay();
    const padded: (StatsDay | null)[] = [...Array<null>(lead).fill(null), ...days];
    return { cells: padded, weeks: Math.ceil(padded.length / 7) };
  }, [days]);
  const max = Math.max(1, ...days.map(activityOf));
  const level = (day: StatsDay) => {
    const value = activityOf(day);
    return value === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((value / max) * 4)));
  };
  return (
    <div className="stats-heat" role="img" aria-label={`Daily activity, ${days.length} days`}>
      <div className="stats-heat__grid" style={{ '--weeks': weeks } as CSSProperties}>
        {cells.map((day, index) => day
          ? (
            <button type="button" key={day.date} className={`stats-cell stats-cell--${level(day)}`}
              aria-label={`${dayFormat.format(parseDay(day.date))}: ${tipText(day).join(', ')}`}>
              <Tip day={day} edge={Math.floor(index / 7) < 3 ? 'start' : Math.floor(index / 7) > weeks - 4 ? 'end' : 'mid'} />
            </button>
          )
          : <span key={`pad${index}`} className="stats-cell stats-cell--pad" />)}
      </div>
      <div className="stats-heat__legend" aria-hidden>
        <span>Less</span>{[0, 1, 2, 3, 4].map(n => <i key={n} className={`stats-cell stats-cell--${n}`} />)}<span>More</span>
      </div>
    </div>
  );
}

function BotRow({ bot, max, index }: { bot: StatsBot; max: number; index: number }) {
  const live = useStore(s => s.bots.find(entry => entry.id === bot.id));
  const work = bot.totalMessages + bot.relayedRuns;
  const open = () => { useStore.getState().setModal(null); openBotChat(bot.id); };
  return (
    <li style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}>
      <button type="button" className="stats-bot" style={botVars(bot.avatarColor)} onClick={open} disabled={!live}
        aria-label={`${bot.name}: ${plural(bot.chats, 'chat')}, ${plural(bot.messages, 'message')} sent, ${plural(bot.relayedRuns, 'agent run')}, ${formatTokens(bot.tokens.total)} tokens`}>
        <span className="stats-bot__rank">{index + 1}</span>
        <BotAvatarFor bot={live ?? { ...bot, id: bot.id }} size={36} />
        <span className="stats-bot__main">
          <span className="stats-bot__name"><strong>{bot.name}</strong>{bot.label && <small>{bot.label}</small>}</span>
          <span className="stats-meter" aria-hidden><span style={{ transform: `scaleX(${max ? work / max : 0})` }} /></span>
        </span>
        <span className="stats-bot__figures">
          <span><b>{number.format(bot.chats)}</b><small>{bot.chats === 1 ? 'chat' : 'chats'}</small></span>
          <span><b>{number.format(bot.messages)}</b><small>sent</small></span>
          <span><b>{number.format(bot.relayedRuns)}</b><small>{bot.relayedRuns === 1 ? 'run' : 'runs'}</small></span>
          <span><b>{formatTokens(bot.tokens.total)}</b><small>tokens</small></span>
        </span>
        <span className="stats-bot__when">{bot.lastActiveAt ? (() => { const r = relativeShort(bot.lastActiveAt); return r === 'now' ? 'Just now' : /^\d/.test(r) ? `${r} ago` : r; })() : '—'}</span>
      </button>
    </li>
  );
}

function ProviderRow({ provider, max }: { provider: StatsSummary['providers'][number]; max: number }) {
  const share = max ? provider.tokens.total / max : 0;
  return (
    <li className="stats-provider" style={{ '--stats-accent': PROVIDER_ACCENT[provider.provider] } as CSSProperties}>
      <span className="stats-provider__mark">{provider.provider === 'local' ? <Cpu size={16} aria-hidden /> : <ProviderLogo provider={provider.provider} size={18} />}</span>
      <span className="stats-provider__main">
        <span className="stats-provider__top">
          <strong>{PROVIDER_NAMES[provider.provider]}</strong>
          <span>{plural(provider.runs, provider.provider === 'local' ? 'reply' : 'run', provider.provider === 'local' ? 'replies' : 'runs')} · {formatTokens(provider.tokens.total)} tokens</span>
        </span>
        <span className="stats-meter" aria-hidden><span style={{ transform: `scaleX(${share})` }} /></span>
      </span>
      <span className="stats-provider__rate" title={provider.completionRate === null ? 'No finished runs yet' : `${provider.completed} of ${provider.completed + provider.failed + provider.stopped} finished runs completed`}>
        {provider.completionRate === null ? '—' : percent(provider.completionRate)}
        <small>done</small>
      </span>
    </li>
  );
}

function Insight({ label, value, detail }: { label: string; value: React.ReactNode; detail?: string }) {
  return <div className="stats-insight"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;
}

function Skeleton() {
  return (
    <div className="stats-skeleton" aria-hidden>
      <div className="stats-kpis">{[0, 1, 2, 3].map(n => <div key={n} className="stats-kpi stats-skeleton__block" />)}</div>
      <div className="stats-card stats-skeleton__block stats-skeleton__chart" />
      <div className="stats-card stats-skeleton__block stats-skeleton__chart" />
    </div>
  );
}

export function StatsDashboard() {
  const close = () => useStore.getState().setModal(null);
  const [range, setRange] = useState<StatsRange>(readRange);
  const [data, setData] = useState<StatsSummary | undefined>(() => remembered.get(readRange()));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const request = new AbortController();
    setLoading(true);
    setError(false);
    setData(remembered.get(range));
    featuresApi.stats(range, request.signal)
      .then(next => { remembered.set(range, next); setData(next); })
      .catch(() => { if (!request.signal.aborted) setError(true); })
      .finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [range, attempt]);

  const choose = (next: StatsRange) => {
    setRange(next);
    try { localStorage.setItem(RANGE_PREF, next); } catch { /* private mode */ }
  };

  const top = data?.mostWorkedBot ?? null;
  const topLive = useStore(s => s.bots.find(entry => entry.id === top?.id));
  const maxWork = Math.max(1, ...(data?.bots ?? []).map(bot => bot.totalMessages + bot.relayedRuns));
  const maxProviderTokens = Math.max(1, ...(data?.providers ?? []).map(provider => provider.tokens.total));
  const empty = !!data && data.totals.totalMessages === 0 && data.totals.relayedRuns === 0;
  const streak = data?.streak;
  const insights = data?.insights;
  const maxWeekday = Math.max(1, ...(insights?.weekdayCounts ?? [0]));

  return (
    <Modal onClose={close} className="usage-dashboard stats-dashboard" label="Statistics">
      <header className="usage-dashboard__header">
        <div className="usage-dashboard__title">
          <div className="usage-dashboard__symbol"><BarChart3 size={22} strokeWidth={1.8} aria-hidden /></div>
          <div><h1>Statistics</h1><p>Your streak, messages, tokens and the Bots you work with most.</p></div>
        </div>
        <button type="button" className="icon-btn usage-dashboard__close" onClick={close} aria-label="Close"><X size={19} /></button>
      </header>
      <div className="usage-dashboard__body stats-body" aria-busy={loading}>
        <div className="stats-toolbar">
          <FilterBar value={range} onChange={choose} counts={{ '7d': 0, '30d': 0, all: 0 }} options={RANGES} label="Timeframe" />
          <span className="stats-toolbar__status" role="status">
            {loading ? 'Updating…' : data ? `${shortDay.format(parseDay(data.from))} – ${shortDay.format(parseDay(data.to))}` : ''}
          </span>
        </div>
        {error && (
          <p className="usage-dashboard__error" role="alert">
            <CircleAlert size={16} /> Couldn’t load statistics. <button type="button" className="stats-link" onClick={() => setAttempt(n => n + 1)}>Try again</button>
          </p>
        )}
        {!data && !error && <Skeleton />}
        {data && streak && insights && (
          <div className={`stats-content${loading ? ' is-refreshing' : ''}`}>
            <div className="stats-kpis">
              <Kpi tone="flame" icon={<Flame size={20} />} label="Daily streak"
                value={<>{streak.current}<small> {streak.current === 1 ? 'day' : 'days'}</small></>}
                detail={streak.current === 0 ? (streak.longest ? `Best ${streak.longest} · send a message to start` : 'Send a message to start one')
                  : `${streak.activeToday ? 'Active today' : 'Keep it going today'} · best ${streak.longest}`}>
                {streak.longest > 0 && <span className="stats-kpi__pill" title="Longest streak"><Trophy size={11} aria-hidden /> {streak.longest}</span>}
              </Kpi>
              <Kpi icon={<Sparkles size={20} />} label="Tokens spent" value={formatTokens(data.totals.tokens.total)}
                detail={`${formatTokens(data.totals.tokens.input)} in · ${formatTokens(data.totals.tokens.output)} out`} />
              <Kpi icon={<MessageSquare size={20} />} label="Messages & chats" value={number.format(data.totals.userMessages)}
                detail={`${plural(data.totals.chats, 'chat')} · ${number.format(data.totals.totalMessages)} total messages`} />
              <section className="stats-kpi stats-kpi--bot" aria-label="Most worked-on Bot" style={top ? botVars(top.avatarColor) : undefined}>
                <span className="stats-kpi__badge stats-kpi__badge--avatar" aria-hidden>
                  {top ? <BotAvatarFor bot={topLive ?? { ...top, id: top.id }} size={34} /> : <Trophy size={20} />}
                </span>
                <div className="stats-kpi__copy">
                  <span className="stats-kpi__label">Most worked-on</span>
                  <strong className="stats-kpi__value stats-kpi__value--name">{top ? top.name : '—'}</strong>
                  <small className="stats-kpi__detail">{top ? `${number.format(top.totalMessages)} messages · ${plural(top.relayedRuns, 'run')}` : 'No chats yet'}</small>
                </div>
              </section>
            </div>

            {empty && (
              <div className="stats-empty">
                <BarChart3 size={22} aria-hidden />
                <strong>Nothing to show for this timeframe yet</strong>
                <span>Chat with a Bot or relay a task to Claude, Codex or Gemini and your numbers will appear here.</span>
              </div>
            )}

            <section className="stats-card" aria-label="Daily activity">
              <header className="stats-card__head">
                <h2>Daily activity</h2>
                <span>{plural(data.totals.activeDays, 'active day')} · {insights.avgMessagesPerActiveDay} messages per active day</span>
              </header>
              {range === 'all' ? <Heatmap days={data.days} /> : <BarChart days={data.days} />}
            </section>

            <section className="stats-card" aria-label="Bots">
              <header className="stats-card__head">
                <h2>Bots, most worked on first</h2>
                <span>{plural(data.bots.length, 'Bot')} · {plural(data.totals.relayedRuns, 'agent run')} · {duration(data.totals.agentTimeMs)} of agent time</span>
              </header>
              {data.bots.length ? (
                <ul className="stats-bots">{data.bots.map((bot, index) => <BotRow key={bot.id} bot={bot} max={maxWork} index={index} />)}</ul>
              ) : <p className="stats-card__empty">No Bot activity in this timeframe.</p>}
            </section>

            <div className="stats-split">
              <section className="stats-card" aria-label="Providers">
                <header className="stats-card__head"><h2>Providers</h2><span>Tokens and completed runs</span></header>
                {data.providers.length
                  ? <ul className="stats-providers">{data.providers.map(provider => <ProviderRow key={provider.provider} provider={provider} max={maxProviderTokens} />)}</ul>
                  : <p className="stats-card__empty">No model activity in this timeframe.</p>}
                {data.models.length > 0 && (
                  <p className="stats-models">Top model: <strong>{data.models[0].label}</strong> · {formatTokens(data.models[0].tokens.total)} tokens</p>
                )}
              </section>

              <section className="stats-card" aria-label="Highlights">
                <header className="stats-card__head"><h2>Highlights</h2><span>When and where you work</span></header>
                <div className="stats-insights">
                  <Insight label="Busiest day" value={insights.busiestWeekday ? WEEKDAYS[insights.busiestWeekday.day] : '—'}
                    detail={insights.busiestWeekday ? plural(insights.busiestWeekday.count, 'action') : undefined} />
                  <Insight label="Peak hour" value={insights.peakHour ? hourLabel(insights.peakHour.hour) : '—'}
                    detail={insights.peakHour ? plural(insights.peakHour.count, 'action') : undefined} />
                  <Insight label="Agent success" value={insights.agentSuccessRate === null ? '—' : percent(insights.agentSuccessRate)}
                    detail={data.totals.relayedRuns ? `${data.totals.completedRuns} of ${data.totals.relayedRuns} runs` : undefined} />
                  <Insight label="Agent time" value={duration(data.totals.agentTimeMs)} detail="relayed to Claude, Codex, Gemini" />
                </div>
                <div className="stats-week" role="img" aria-label={`Activity by weekday: ${WEEKDAYS.map((name, i) => `${name} ${insights.weekdayCounts[i]}`).join(', ')}`}>
                  {insights.weekdayCounts.map((count, i) => (
                    <span key={i} className={`stats-week__day${insights.busiestWeekday?.day === i ? ' is-top' : ''}`} title={`${WEEKDAYS[i]}: ${plural(count, 'action')}`}>
                      <i style={{ height: `${count ? Math.max(8, (count / maxWeekday) * 100) : 0}%` }} />
                      <b>{WEEKDAY_SHORT[i]}</b>
                    </span>
                  ))}
                </div>
                <h3 className="stats-folders__title"><FolderOpen size={13} aria-hidden /> Top project folders</h3>
                {insights.topFolders.length ? (
                  <ul className="stats-folders">
                    {insights.topFolders.map(folder => (
                      <li key={folder.path} title={folder.path}>
                        <span>{folder.name}</span>
                        <small>{plural(folder.runs, 'run')} · {formatTokens(folder.tokens)} tokens</small>
                      </li>
                    ))}
                  </ul>
                ) : <p className="stats-card__empty">No folder runs yet.</p>}
              </section>
            </div>
          </div>
        )}
      </div>
      <footer className="usage-dashboard__footer">
        <span><Clock size={11} aria-hidden style={{ verticalAlign: '-1px' }} /> Days follow this computer’s clock · the streak counts every day since you started</span>
        {data && <span>Updated <time dateTime={new Date(data.generatedAt).toISOString()}>{new Date(data.generatedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time></span>}
      </footer>
    </Modal>
  );
}

export type { StatsTokens };
