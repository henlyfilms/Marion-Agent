import { db } from '../db.js';
import type {
  AvatarColor, AvatarShape, ChatProvider, StatsBot, StatsDay, StatsFolder, StatsModel, StatsProvider, StatsRange, StatsSummary, StatsTokens,
} from '../types.js';
import './schema.js';

/**
 * Statistics for the Statistics view (GET /api/stats?range=7d|30d|all).
 *
 * What counts:
 *  - "messages sent" are the user's own messages (role 'user', not forwarded from another bot or a routine);
 *  - an "active day" is a day with at least one of those messages or at least one relayed agent run;
 *  - tokens are read from the usage footers on assistant replies (chat models) plus relayed runs (agent_sessions).
 *    A subscription-backed chat is recorded in both places, so its relayed `subscription_bot` runs are not added a second time;
 *  - chats that are deleted, and hidden sub-agent chats, are left out (the same rule as the Sessions view).
 * Days are calendar days in the server's time zone (or a fixed offset, which is what the tests use).
 * The streak always looks at the whole history; the range only narrows totals, the leaderboard and the charts.
 */

export const STATS_RANGES: readonly StatsRange[] = ['7d', '30d', 'all'];
export const parseStatsRange = (value: unknown): StatsRange => STATS_RANGES.find(range => range === value) ?? '30d';

export interface StatsOptions {
  range?: StatsRange;
  /** "Now", for tests. */
  now?: number;
  /** Fixed offset in minutes west of UTC (as Date#getTimezoneOffset). Default: the server's own time zone. */
  tzOffset?: number;
}

const DAY_MS = 86_400_000;
/**
 * "All time" draws every day from the first activity to today. This bound only protects against a wildly wrong
 * timestamp (a clock set to 1970); real histories are never cut, so the chart always matches the totals.
 */
const MAX_ALL_DAYS = 10 * 366;
const TOP_FOLDERS = 5;
const TOP_MODELS = 8;

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
const noTokens = (): StatsTokens => ({ input: 0, output: 0, total: 0 });
const addTokens = (to: StatsTokens, input: number, output: number) => { to.input += input; to.output += output; to.total += input + output; };

interface When { day: number; weekday: number; hour: number }

function whenOf(ts: number, tzOffset: number | undefined): When {
  if (tzOffset !== undefined) {
    const shifted = new Date(ts - tzOffset * 60_000);
    return { day: Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) / DAY_MS, weekday: shifted.getUTCDay(), hour: shifted.getUTCHours() };
  }
  const date = new Date(ts);
  return { day: Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS, weekday: date.getDay(), hour: date.getHours() };
}

const dateKey = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** Current and longest run of consecutive days. A streak that ended yesterday is still "current" (today isn't over). */
export function streaks(activeDays: Iterable<number>, today: number) {
  const days = [...new Set(activeDays)].sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i] - days[i - 1] === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  const set = new Set(days);
  const activeToday = set.has(today);
  let cursor = activeToday ? today : today - 1;
  let current = 0;
  while (set.has(cursor)) { current++; cursor--; }
  return { current, longest, activeDays: days.length, activeToday, lastActiveDay: days.length ? days[days.length - 1] : null };
}

interface BotRow { id: string; name: string; label: string | null; kind: string | null; avatar_shape: string; avatar_color: string; avatar_stem_color: string | null }
interface MessageRow { bot_id: string; generation: number; created_at: number; role: string | null; from_kind: string | null; usage: string | null }
interface SessionRow {
  bot_id: string; provider: string; kind: string; status: string; folder_path: string | null; folder_label: string | null; model: string | null;
  model_label: string | null; tokens_in: number | null; tokens_out: number | null; started_at: number; ended_at: number | null; duration_ms: number | null;
}

/** Usage footer of one reply: [{provider, model, label?, input, output}]. Anything malformed counts as nothing. */
function parseUsage(raw: string | null): { provider: string; model: string; label: string; input: number; output: number }[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter(item => item && typeof item === 'object').map(item => ({
      provider: typeof item.provider === 'string' ? item.provider : 'local',
      model: typeof item.model === 'string' ? item.model : 'unknown',
      label: typeof item.label === 'string' && item.label ? item.label : typeof item.model === 'string' ? item.model : 'Unknown model',
      input: num(item.input), output: num(item.output),
    }));
  } catch { return []; }
}

export function computeStats(userId: string, options: StatsOptions = {}): StatsSummary {
  const range = options.range ?? '30d';
  const nowTs = options.now ?? Date.now();
  const tz = options.tzOffset;
  const today = whenOf(nowTs, tz).day;

  const bots = db.prepare(`SELECT id, name, label, kind, avatar_shape, avatar_color, avatar_stem_color FROM bots
    WHERE user_id=? AND COALESCE(hidden,0)=0 AND deleted_at IS NULL`).all(userId) as BotRow[];
  const botById = new Map(bots.map(bot => [bot.id, bot]));
  const messages = db.prepare(`SELECT r.bot_id, r.generation, r.created_at, json_extract(r.body,'$.role') role,
      json_extract(r.body,'$.from.kind') from_kind, json_extract(r.body,'$.usage') usage
    FROM rows r JOIN bots b ON b.id=r.bot_id
    WHERE b.user_id=? AND COALESCE(b.hidden,0)=0 AND b.deleted_at IS NULL AND r.kind='message'`).all(userId) as MessageRow[];
  const sessions = db.prepare(`SELECT s.bot_id, s.provider, s.kind, s.status, s.folder_path, s.folder_label, s.model, s.model_label,
      s.tokens_in, s.tokens_out, s.started_at, s.ended_at, s.duration_ms
    FROM agent_sessions s JOIN bots b ON b.id=s.bot_id
    WHERE s.user_id=? AND COALESCE(b.hidden,0)=0 AND b.deleted_at IS NULL`).all(userId) as SessionRow[];

  // ---- the whole history: which days were active (for the streak) and when each bot was last used
  const allActive = new Set<number>();
  const lastActive = new Map<string, number>();
  // The first day anything counted happened (a reply or a forwarded message also counts toward the totals).
  let firstSeen = Infinity;
  const touch = (botId: string, at: number) => { if (at > (lastActive.get(botId) ?? 0)) lastActive.set(botId, at); };
  const isSent = (row: MessageRow) => row.role === 'user' && row.from_kind !== 'bot' && row.from_kind !== 'routine';
  for (const row of messages) {
    touch(row.bot_id, row.created_at);
    const day = whenOf(row.created_at, tz).day;
    if (day <= today && day < firstSeen) firstSeen = day;
    if (isSent(row)) allActive.add(day);
  }
  for (const row of sessions) {
    touch(row.bot_id, row.ended_at ?? row.started_at);
    const day = whenOf(row.started_at, tz).day;
    if (day <= today && day < firstSeen) firstSeen = day;
    allActive.add(day);
  }
  const streak = streaks(allActive, today);

  // ---- the chart window: "All time" runs from the first activity to today (at least a week), one entry per day
  const firstDay = Number.isFinite(firstSeen) ? firstSeen : today;
  const length = range === '7d' ? 7 : range === '30d' ? 30 : Math.min(MAX_ALL_DAYS, Math.max(7, today - firstDay + 1));
  const fromDay = today - length + 1;
  const dayRows = new Map<number, StatsDay>();
  for (let day = fromDay; day <= today; day++) dayRows.set(day, { date: dateKey(day), messages: 0, runs: 0, tokens: 0 });
  // "All time" totals cover everything, even days older than the chart.
  const inRange = (day: number) => range === 'all' ? day <= today : day >= fromDay && day <= today;

  const botStats = new Map<string, StatsBot & { generations: Set<number> }>();
  const statFor = (botId: string) => {
    let stat = botStats.get(botId);
    if (!stat) {
      const bot = botById.get(botId)!;
      stat = {
        id: bot.id, name: bot.name, label: bot.label ?? '', kind: bot.kind === 'room' ? 'room' : 'agent',
        avatarShape: bot.avatar_shape as AvatarShape, avatarColor: bot.avatar_color as AvatarColor, avatarStemColor: bot.avatar_stem_color,
        chats: 0, messages: 0, totalMessages: 0, relayedRuns: 0, tokens: noTokens(), lastActiveAt: lastActive.get(bot.id) ?? null, generations: new Set(),
      };
      botStats.set(botId, stat);
    }
    return stat;
  };

  const totals = { userMessages: 0, totalMessages: 0, relayedRuns: 0, completedRuns: 0, tokens: noTokens(), agentTimeMs: 0 };
  const activeInRange = new Set<number>();
  const weekdayCounts = new Array<number>(7).fill(0);
  const hourCounts = new Array<number>(24).fill(0);
  const providerStats = new Map<ChatProvider, StatsProvider>();
  const providerFor = (provider: ChatProvider) => {
    let stat = providerStats.get(provider);
    if (!stat) {
      stat = { provider, runs: 0, completed: 0, failed: 0, stopped: 0, completionRate: null, tokens: noTokens(), durationMs: 0 };
      providerStats.set(provider, stat);
    }
    return stat;
  };
  const modelStats = new Map<string, StatsModel>();
  const modelFor = (provider: ChatProvider, model: string, label: string) => {
    const key = `${provider}:${model}`;
    let stat = modelStats.get(key);
    if (!stat) { stat = { provider, model, label, runs: 0, tokens: noTokens() }; modelStats.set(key, stat); }
    return stat;
  };
  const folders = new Map<string, StatsFolder>();
  const activity = (when: When) => { weekdayCounts[when.weekday]++; hourCounts[when.hour]++; };

  for (const row of messages) {
    const when = whenOf(row.created_at, tz);
    if (!inRange(when.day)) continue;
    const bot = statFor(row.bot_id);
    const day = dayRows.get(when.day);
    bot.generations.add(row.generation);
    bot.totalMessages++;
    totals.totalMessages++;
    if (isSent(row)) {
      bot.messages++;
      totals.userMessages++;
      activeInRange.add(when.day);
      if (day) day.messages++;
      activity(when);
    }
    if (row.role === 'assistant') {
      for (const usage of parseUsage(row.usage)) {
        const provider = (['local', 'claude', 'codex', 'gemini'].includes(usage.provider) ? usage.provider : 'local') as ChatProvider;
        addTokens(bot.tokens, usage.input, usage.output);
        addTokens(totals.tokens, usage.input, usage.output);
        if (day) day.tokens += usage.input + usage.output;
        // Chat models answer in-app, so they count as runs here; relayed providers are counted from their sessions below.
        if (provider === 'local') {
          const local = providerFor('local');
          local.runs++; local.completed++;
          addTokens(local.tokens, usage.input, usage.output);
          const model = modelFor('local', usage.model, usage.label);
          model.runs++;
          addTokens(model.tokens, usage.input, usage.output);
        }
      }
    }
  }

  for (const row of sessions) {
    const when = whenOf(row.started_at, tz);
    if (!inRange(when.day)) continue;
    const provider = (['claude', 'codex', 'gemini'].includes(row.provider) ? row.provider : 'claude') as ChatProvider;
    const input = num(row.tokens_in);
    const output = num(row.tokens_out);
    // Same rule as the Sessions view: a run that is still going (or waiting on the user) counts up to now.
    const duration = row.status === 'running' || row.status === 'waiting' ? Math.max(0, nowTs - row.started_at) : num(row.duration_ms);
    const bot = statFor(row.bot_id);
    const day = dayRows.get(when.day);
    bot.relayedRuns++;
    totals.relayedRuns++;
    totals.agentTimeMs += duration;
    activeInRange.add(when.day);
    activity(when);
    if (day) day.runs++;
    // The reply of a subscription-backed chat already carries these tokens in its usage footer.
    if (row.kind !== 'subscription_bot') {
      addTokens(bot.tokens, input, output);
      addTokens(totals.tokens, input, output);
      if (day) day.tokens += input + output;
    }
    const stat = providerFor(provider);
    stat.runs++;
    stat.durationMs += duration;
    addTokens(stat.tokens, input, output);
    if (row.status === 'completed') { stat.completed++; totals.completedRuns++; }
    else if (row.status === 'failed') stat.failed++;
    else if (row.status === 'stopped') stat.stopped++;
    const model = modelFor(provider, row.model ?? 'unknown', row.model_label || row.model || 'Unknown model');
    model.runs++;
    addTokens(model.tokens, input, output);
    if (row.folder_path) {
      const folder = folders.get(row.folder_path) ?? { path: row.folder_path, name: row.folder_label || row.folder_path.split('/').filter(Boolean).pop() || row.folder_path, runs: 0, tokens: 0 };
      folder.runs++;
      folder.tokens += input + output;
      folders.set(row.folder_path, folder);
    }
  }

  for (const stat of providerStats.values()) {
    const finished = stat.completed + stat.failed + stat.stopped;
    stat.completionRate = stat.provider !== 'local' && finished > 0 ? stat.completed / finished : null;
  }
  const finishedRuns = [...providerStats.values()].filter(p => p.provider !== 'local').reduce((n, p) => n + p.completed + p.failed + p.stopped, 0);

  const leaderboard: StatsBot[] = [...botStats.values()].map(({ generations, ...stat }) => ({ ...stat, chats: generations.size }))
    .sort((a, b) => (b.totalMessages + b.relayedRuns) - (a.totalMessages + a.relayedRuns) || b.tokens.total - a.tokens.total
      || (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) || a.name.localeCompare(b.name));

  const providerOrder: ChatProvider[] = ['claude', 'codex', 'gemini', 'local'];
  const providers = [...providerStats.values()].sort((a, b) => providerOrder.indexOf(a.provider) - providerOrder.indexOf(b.provider));
  const peak = (counts: number[]) => {
    const best = Math.max(...counts);
    return best > 0 ? counts.indexOf(best) : -1;
  };
  const weekday = peak(weekdayCounts);
  const hour = peak(hourCounts);

  return {
    range,
    generatedAt: nowTs,
    from: dateKey(fromDay),
    to: dateKey(today),
    since: Number.isFinite(firstSeen) ? dateKey(firstSeen) : null,
    streak: { current: streak.current, longest: streak.longest, activeDays: streak.activeDays, activeToday: streak.activeToday, lastActiveDate: streak.lastActiveDay === null ? null : dateKey(streak.lastActiveDay) },
    totals: {
      userMessages: totals.userMessages, totalMessages: totals.totalMessages,
      chats: leaderboard.reduce((n, bot) => n + bot.chats, 0),
      relayedRuns: totals.relayedRuns, completedRuns: totals.completedRuns,
      tokens: totals.tokens, agentTimeMs: totals.agentTimeMs,
      activeDays: activeInRange.size, activeBots: leaderboard.length,
    },
    days: [...dayRows.values()],
    bots: leaderboard,
    mostWorkedBot: leaderboard[0] ?? null,
    providers,
    models: [...modelStats.values()].sort((a, b) => b.tokens.total - a.tokens.total || b.runs - a.runs).slice(0, TOP_MODELS),
    insights: {
      busiestWeekday: weekday >= 0 ? { day: weekday, count: weekdayCounts[weekday] } : null,
      peakHour: hour >= 0 ? { hour, count: hourCounts[hour] } : null,
      weekdayCounts, hourCounts,
      avgMessagesPerActiveDay: activeInRange.size ? Math.round((totals.userMessages / activeInRange.size) * 10) / 10 : 0,
      agentSuccessRate: finishedRuns ? totals.completedRuns / finishedRuns : null,
      topFolders: [...folders.values()].sort((a, b) => b.runs - a.runs || b.tokens - a.tokens).slice(0, TOP_FOLDERS),
    },
  };
}
