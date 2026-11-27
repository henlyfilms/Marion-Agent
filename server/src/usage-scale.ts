import type { WorkAgent, WorkUsage } from './types.js';

/**
 * The usage color scale shared by the server (tests) and the app (work card rings): less usage is cool blue,
 * more usage is red. 0–35% stays blue, 35–60% glides to violet, 60–80% warms to red, 80–100% is red.
 */
export const USAGE_BLUE = '#3b82f6';
export const USAGE_VIOLET = '#8b5cf6';
export const USAGE_RED = '#ef4444';

const STOPS: [number, string][] = [[0, USAGE_BLUE], [35, USAGE_BLUE], [60, USAGE_VIOLET], [80, USAGE_RED], [100, USAGE_RED]];

const rgb = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
const hex = (parts: number[]) => `#${parts.map(part => Math.round(part).toString(16).padStart(2, '0')).join('')}`;

export const clampPercent = (value: number) => Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;

/** The ring/bar color for a usage percentage (0–100) on the blue → red scale. */
export function usageColor(percent: number): string {
  const value = clampPercent(percent);
  for (let index = 1; index < STOPS.length; index++) {
    const [to, end] = STOPS[index];
    if (value > to) continue;
    const [from, start] = STOPS[index - 1];
    const t = to === from ? 1 : (value - from) / (to - from);
    const a = rgb(start);
    const b = rgb(end);
    return hex(a.map((part, i) => part + (b[i] - part) * t));
  }
  return USAGE_RED;
}

/** A word for the same scale (screen readers, tooltips, CSS hooks). */
export function usageTone(percent: number): 'low' | 'medium' | 'high' {
  const value = clampPercent(percent);
  return value < 35 ? 'low' : value < 80 ? 'medium' : 'high';
}

export interface WorkUsageSummary {
  tokens: WorkUsage['tokens'];
  costUsd?: number;
  /** 0–100 for the task ring (summed over the team, capped). */
  taskPercent: number;
  taskBasis: WorkUsage['taskBasis'];
  /** The plan limit reading to show (solo runs, or the window that moved most). */
  limit?: WorkUsage['limit'];
  /** The fullest session on the card and whose it is. */
  context?: WorkUsage['context'] & { agent: string };
  live: boolean;
}

/** One card's numbers: a solo run as is; a team's task usage combined and its fullest context. */
export function summarizeWorkUsage(agents: Pick<WorkAgent, 'label' | 'usage'>[]): WorkUsageSummary | undefined {
  const measured = agents.filter((agent): agent is Pick<WorkAgent, 'label'> & { usage: WorkUsage } => Boolean(agent.usage));
  if (!measured.length) return undefined;
  const tokens = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
  let cost: number | undefined;
  for (const { usage } of measured) {
    for (const key of Object.keys(tokens) as (keyof typeof tokens)[]) tokens[key] += usage.tokens[key] ?? 0;
    if (usage.costUsd !== undefined) cost = (cost ?? 0) + usage.costUsd;
  }
  const moved = (usage: WorkUsage) => usage.limit ? usage.limit.usedPercent - usage.limit.startPercent : -1;
  const limit = measured.map(agent => agent.usage).sort((a, b) => moved(b) - moved(a))[0].limit;
  const fullest = measured.filter(agent => agent.usage.context).sort((a, b) => b.usage.context!.percent - a.usage.context!.percent)[0];
  return {
    tokens,
    ...(cost !== undefined ? { costUsd: cost } : {}),
    taskPercent: clampPercent(measured.reduce((sum, agent) => sum + agent.usage.taskPercent, 0)),
    taskBasis: measured.every(agent => agent.usage.taskBasis === 'limit') ? 'limit' : 'tokens',
    ...(limit ? { limit } : {}),
    ...(fullest ? { context: { ...fullest.usage.context!, agent: fullest.label } } : {}),
    live: measured.some(agent => agent.usage.live),
  };
}
