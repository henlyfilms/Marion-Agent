import type { ChatProvider, WorkUsage } from '../types.js';
import { clampPercent } from '../usage-scale.js';

/**
 * Per-run usage for builder work cards, read from the JSON each CLI already prints while it works (no extra
 * model calls): Claude Code's stream-json (per-request `usage`, the final `result` with `modelUsage`/cost, and
 * `rate_limit_event`), Codex's app server (`thread/tokenUsage/updated`, `account/rateLimits/updated`) and
 * Antigravity/Gemini (`usage`/`usageMetadata`/`stats` bags and ACP-style `usage_update`).
 */

type Provider = Exclude<ChatProvider, 'local'>;
type Bag = WorkUsage['tokens'];

/**
 * A big builder run, in cost-weighted tokens: a ring fills up when a task gets near it. Weights follow typical API
 * pricing ratios against fresh input: cache reads ~0.1×, cache writes ~1.25×, output (with reasoning) ~5×.
 */
export const TASK_TOKEN_BUDGET = 2_000_000;
const WEIGHTS = { input: 1, cached: 0.1, cacheWrite: 1.25, output: 5 };

/** Used until the CLI reports the model's real window. */
export const DEFAULT_CONTEXT_WINDOW: Record<Provider, number> = { claude: 200_000, codex: 272_000, gemini: 1_048_576 };

const zero = (): Bag => ({ input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 });
const add = (a: Bag, b: Bag): Bag => ({
  input: a.input + b.input, cached: a.cached + b.cached, cacheWrite: a.cacheWrite + b.cacheWrite,
  output: a.output + b.output, reasoning: a.reasoning + b.reasoning, total: a.total + b.total,
});

const num = (...values: unknown[]) => {
  for (const value of values) if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  return undefined;
};

/**
 * One usage object in any CLI's shape, normalized. `cachedIncluded`: the input count already includes cache reads
 * (Codex, Gemini), unlike Claude's. `reasoningSeparate`: thinking tokens are not in the output count (Gemini).
 */
export function tokenBag(source: any, options: { cachedIncluded: boolean; reasoningSeparate?: boolean }): Bag | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const input = num(source.input_tokens, source.inputTokens, source.prompt_tokens, source.promptTokenCount, source.input);
  let output = num(source.output_tokens, source.outputTokens, source.completion_tokens, source.candidates_tokens, source.candidatesTokenCount, source.output);
  if (input === undefined && output === undefined) return undefined;
  const cached = num(source.cache_read_input_tokens, source.cacheReadInputTokens, source.cachedInputTokens, source.cached_input_tokens,
    source.cached_tokens, source.cachedContentTokenCount, source.cached) ?? 0;
  const cacheWrite = num(source.cache_creation_input_tokens, source.cacheCreationInputTokens) ?? 0;
  const reasoning = num(source.reasoningOutputTokens, source.reasoning_output_tokens, source.reasoning_tokens, source.thoughtsTokenCount, source.thoughts_tokens, source.thoughts) ?? 0;
  if (options.reasoningSeparate) output = (output ?? 0) + reasoning;
  const fresh = options.cachedIncluded ? Math.max(0, (input ?? 0) - cached) : input ?? 0;
  const out = output ?? 0;
  return { input: fresh, cached, cacheWrite, output: out, reasoning, total: fresh + cached + cacheWrite + out };
}

/** Cost-weighted tokens against the task budget, as 0–100. */
export function tokenIntensity(tokens: Bag): number {
  const weighted = tokens.input * WEIGHTS.input + tokens.cached * WEIGHTS.cached + tokens.cacheWrite * WEIGHTS.cacheWrite + tokens.output * WEIGHTS.output;
  return clampPercent(weighted / TASK_TOKEN_BUDGET * 100);
}

function minutesLabel(minutes?: number) {
  if (!minutes) return 'Usage limit';
  if (minutes === 10_080) return 'Weekly limit';
  if (minutes % 1440 === 0) return `${minutes / 1440}-day limit`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
}

const CLAUDE_LIMITS: Record<string, string> = {
  five_hour: '5-hour limit', seven_day: 'Weekly limit', seven_day_opus: 'Weekly Opus limit', seven_day_sonnet: 'Weekly Sonnet limit',
};

/** Seconds or milliseconds since 1970 → milliseconds. */
const resetMs = (value: unknown) => {
  const n = num(value);
  if (!n) return undefined;
  return n < 1e12 ? n * 1000 : n;
};

export class TaskUsageMeter {
  private running = zero();
  private final?: Bag;
  private readonly calls = new Map<string, Bag>();
  private contextTokens?: number;
  private contextWindow?: number;
  private cost?: number;
  private readonly limits = new Map<string, { label: string; startPercent: number; usedPercent: number; resetsAt?: number; readings: number }>();
  private seen = false;
  private geminiCalls = 0;
  private lastTop?: string;

  constructor(readonly provider: Provider, public model = '') {}

  /** Feed one parsed JSON line from the CLI. True when something changed. */
  feed(message: any): boolean {
    if (!message || typeof message !== 'object') return false;
    const changed = this.provider === 'claude' ? this.claude(message) : this.provider === 'codex' ? this.codex(message) : this.gemini(message);
    if (changed) this.seen = true;
    return changed;
  }

  /** The usage so far, or undefined when the CLI has reported nothing yet. */
  value(live = true): WorkUsage | undefined {
    if (!this.seen) return undefined;
    const tokens = this.final ?? this.running;
    const window = this.contextWindow ?? this.defaultWindow();
    const context = this.contextTokens !== undefined && window
      ? { tokens: this.contextTokens, window, percent: clampPercent(this.contextTokens / window * 100), windowKnown: this.contextWindow !== undefined }
      : undefined;
    // The window this run moved most (or, with one reading, the fullest one).
    const limits = [...this.limits.values()];
    const moved = limits.filter(limit => limit.readings > 1).sort((a, b) => (b.usedPercent - b.startPercent) - (a.usedPercent - a.startPercent))[0];
    const shown = moved ?? limits.sort((a, b) => b.usedPercent - a.usedPercent)[0];
    const taskPercent = moved ? clampPercent(moved.usedPercent - moved.startPercent) : tokenIntensity(tokens);
    return {
      tokens: { ...tokens },
      ...(this.cost !== undefined ? { costUsd: this.cost } : {}),
      ...(shown ? { limit: { label: shown.label, startPercent: shown.startPercent, usedPercent: shown.usedPercent, ...(shown.resetsAt ? { resetsAt: shown.resetsAt } : {}) } } : {}),
      ...(context ? { context } : {}),
      taskPercent,
      taskBasis: moved ? 'limit' : 'tokens',
      live,
    };
  }

  private defaultWindow() {
    if (this.provider === 'claude' && /\[1m\]|-1m\b/i.test(this.model)) return 1_000_000;
    return DEFAULT_CONTEXT_WINDOW[this.provider];
  }

  private limit(id: string, label: string, percent: number | undefined, resetsAt?: number) {
    if (percent === undefined) return false;
    const used = clampPercent(percent);
    const known = this.limits.get(id);
    // A window that reset mid-run starts over.
    if (!known || (resetsAt && known.resetsAt && resetsAt !== known.resetsAt && used < known.usedPercent)) {
      this.limits.set(id, { label, startPercent: used, usedPercent: used, resetsAt, readings: 1 });
      return true;
    }
    known.usedPercent = used;
    known.readings++;
    if (resetsAt) known.resetsAt = resetsAt;
    return true;
  }

  private sumCalls() {
    this.running = [...this.calls.values()].reduce(add, zero());
  }

  private claude(message: any): boolean {
    if (message.type === 'assistant' && message.message?.usage) {
      const bag = tokenBag(message.message.usage, { cachedIncluded: false });
      if (!bag) return false;
      // Claude repeats a request's usage on every content block of that message: keep the latest per message.
      const id = String(message.message.id ?? message.uuid ?? this.calls.size);
      const older = this.calls.has(id) && id !== this.lastTop;
      this.calls.set(id, bag);
      this.sumCalls();
      // Subagents (Task tool) run in their own context; the session's context is its newest top-level request.
      if (!message.parent_tool_use_id && !older) { this.contextTokens = bag.total; this.lastTop = id; }
      return true;
    }
    if (message.type === 'result') {
      let changed = false;
      const models = message.modelUsage && typeof message.modelUsage === 'object' ? Object.entries<any>(message.modelUsage) : [];
      const bags = models.map(([, entry]) => tokenBag(entry, { cachedIncluded: false })).filter((bag): bag is Bag => Boolean(bag));
      const total = bags.length ? bags.reduce(add, zero()) : tokenBag(message.usage, { cachedIncluded: false });
      if (total) { this.final = total; changed = true; }
      const cost = num(message.total_cost_usd, message.cost_usd);
      if (cost !== undefined) { this.cost = cost; changed = true; }
      // The main model's window: the one matching the run's model, else the one that wrote the most.
      const main = models.find(([id]) => this.model && id.startsWith(this.model.replace(/\[.*$/, '')))
        ?? models.sort((a, b) => (num(b[1]?.outputTokens) ?? 0) - (num(a[1]?.outputTokens) ?? 0))[0];
      const window = num(main?.[1]?.contextWindow);
      if (window) { this.contextWindow = window; changed = true; }
      return changed;
    }
    if (message.type === 'rate_limit_event') {
      const info = message.rate_limit_info ?? {};
      const raw = num(info.utilization, info.usedPercent, info.used_percent, info.percent_used);
      const percent = raw === undefined ? undefined : raw <= 1 && info.utilization !== undefined ? raw * 100 : raw;
      const type = String(info.rateLimitType ?? info.rate_limit_type ?? 'usage');
      return this.limit(`claude:${type}`, CLAUDE_LIMITS[type] ?? `${type.replace(/_/g, ' ')} limit`, percent, resetMs(info.resetsAt ?? info.resets_at));
    }
    return false;
  }

  private codex(message: any): boolean {
    const params = message.params ?? {};
    if (message.method === 'thread/tokenUsage/updated') {
      const usage = params.tokenUsage ?? {};
      const total = tokenBag(usage.total, { cachedIncluded: true });
      const last = tokenBag(usage.last, { cachedIncluded: true });
      const window = num(usage.modelContextWindow, usage.model_context_window);
      if (!total && !last && !window) return false;
      if (total) this.final = total;
      if (last) this.contextTokens = num(usage.last?.totalTokens) ?? last.total;
      if (window) this.contextWindow = window;
      return true;
    }
    if (message.method === 'account/rateLimits/updated') {
      const limits = params.rateLimits ?? params;
      let changed = false;
      for (const key of ['primary', 'secondary'] as const) {
        const window = limits?.[key];
        if (!window) continue;
        changed = this.limit(`codex:${key}`, minutesLabel(num(window.windowDurationMins)), num(window.usedPercent), resetMs(window.resetsAt)) || changed;
      }
      return changed;
    }
    return false;
  }

  private gemini(message: any): boolean {
    let changed = false;
    // ACP-style "usage_update": context used / window size, and a running cost.
    const update = message.update ?? message.session_update ?? message.params?.update ?? message;
    if ((update?.sessionUpdate === 'usage_update' || update?.type === 'usage_update') && num(update.used) !== undefined) {
      this.contextTokens = num(update.used);
      const size = num(update.size);
      if (size) this.contextWindow = size;
      const cost = num(update.cost?.amount);
      if (cost !== undefined && (!update.cost?.currency || update.cost.currency === 'USD')) this.cost = cost;
      changed = true;
    }
    const shape = { cachedIncluded: true, reasoningSeparate: true };
    if (message.event === 'result') {
      const result = message.result ?? {};
      const bag = tokenBag(result.usage ?? result.usageMetadata ?? result.usage_metadata ?? result.stats ?? message.usage ?? message.stats, shape);
      if (bag) { this.final = bag; changed = true; }
      const cost = num(result.cost_usd, result.total_cost_usd);
      if (cost !== undefined) { this.cost = cost; changed = true; }
      const window = num(result.context_window, result.contextWindow);
      if (window) { this.contextWindow = window; changed = true; }
      return changed;
    }
    const source = message.usageMetadata ?? message.usage_metadata ?? message.usage ?? message.step_update?.usage ?? message.step_update?.usage_metadata;
    const bag = tokenBag(source, shape);
    if (bag) {
      this.calls.set(String(message.step_update?.step_id ?? message.id ?? this.geminiCalls++), bag);
      this.sumCalls();
      this.contextTokens = bag.total;
      changed = true;
    }
    return changed;
  }
}
