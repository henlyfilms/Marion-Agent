import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { SubscriptionUsage, UsageWindow } from '../types.js';
import { getSetting, setSetting } from '../features/schema.js';
import {
  claudeIsolation, cliEnvironment, codexArgs, executable, googleSettings, initializeCodex,
  parseLine, requireClaudeSubscription, type SubscriptionProvider,
} from './subscriptions.js';

const run = promisify(execFile);
export const usageProviders = ['codex', 'claude', 'gemini'] as const;
const maxAge = 60_000;
const cache = new Map<SubscriptionProvider, { saved: SubscriptionUsage; expires: number }>();
const pending = new Map<SubscriptionProvider, Promise<SubscriptionUsage>>();

/** Highest share of any limit window used in the last reading (0–100), if one is cached. */
export function lastUsedPercent(provider: SubscriptionProvider): number | undefined {
  const saved = cache.get(provider)?.saved;
  if (!saved?.windows.length) return undefined;
  return Math.max(...saved.windows.map(window => window.usedPercent));
}

function usageWindow(id: string, label: string, usedPercent: unknown, resetsAt?: number): UsageWindow[] {
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return [];
  const reset = typeof resetsAt === 'number' && resetsAt > 0 && resetsAt < 8.64e15 ? resetsAt : undefined;
  return [{ id, label, usedPercent: Math.min(100, Math.max(0, usedPercent)), resetsAt: reset }];
}

function windowLabel(minutes?: number) {
  if (!minutes) return 'Usage limit';
  if (minutes === 10_080) return 'Weekly limit';
  if (minutes % 1440 === 0) return `${minutes / 1440}-day limit`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
}

type CodexWindow = { usedPercent?: number; windowDurationMins?: number; resetsAt?: number };
type CodexLimit = { limitId?: string; limitName?: string; primary?: CodexWindow; secondary?: CodexWindow };
type GeminiBucket = { id?: string; name?: string; window?: string; remaining_fraction?: number; reset_time?: string; disabled?: boolean };
type GeminiReport = { command?: { data?: { groups?: { name?: string; buckets?: GeminiBucket[] }[] } } };
type UsageReading = { windows: UsageWindow[]; plan?: string; signedOut?: boolean };

async function codexUsage(program: string, cwd: string): Promise<UsageReading> {
  const child = spawn(program, codexArgs, { cwd, env: cliEnvironment(), signal: AbortSignal.timeout(10_000), stdio: ['pipe', 'pipe', 'ignore'] });
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
  let plan: string | undefined;
  try {
    send(initializeCodex);
    for await (const line of output) {
      const message = parseLine(line);
      if (!message || message.method) continue;
      if (message.error) break;
      if (message.id === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/read', params: { refreshToken: false } });
      }
      if (message.id === 2) {
        const account = message.result?.account;
        if (account?.type !== 'chatgpt') return { windows: [], signedOut: true };
        plan = typeof account.planType === 'string' && account.planType ? account.planType : undefined;
        send({ id: 6, method: 'account/rateLimits/read' });
      }
      if (message.id === 6) {
        const main = message.result?.rateLimits as CodexLimit | undefined;
        const byId = message.result?.rateLimitsByLimitId as Record<string, CodexLimit> | undefined;
        const limits = Object.entries(byId ?? {}).filter(([, limit]) => limit);
        if (main && !limits.some(([id]) => id === (main.limitId || 'codex'))) limits.unshift([main.limitId || 'codex', main]);
        const windows = limits.flatMap(([id, limit]) => [limit.primary, limit.secondary].flatMap((window, index) => {
          if (!window) return [];
          const label = windowLabel(window.windowDurationMins);
          const title = id === 'codex' ? label : `${limit.limitName || id.replaceAll('_', ' ')} · ${label}`;
          return usageWindow(`${id}-${index}`, title, window.usedPercent, window.resetsAt && window.resetsAt * 1000);
        }));
        return { plan: plan && `ChatGPT ${plan[0].toUpperCase()}${plan.slice(1)}`, windows };
      }
    }
  } finally {
    output.close();
    child.stdin.destroy();
    child.kill();
  }
  return { windows: [] };
}

async function geminiUsage(program: string, cwd: string): Promise<UsageReading> {
  try {
    const { stdout } = await run(program, ['--mode', 'plan', '--sandbox', '--settings', googleSettings, '--print', '/usage', '--output-format', 'json'], {
      cwd, env: cliEnvironment(), timeout: 12_000, maxBuffer: 128_000,
    });
    const report = parseLine<GeminiReport>(stdout);
    const group = report?.command?.data?.groups?.find(group => /^gemini\b/i.test(group.name ?? ''));
    const buckets = [...(group?.buckets ?? [])].sort((a, b) => Number(b.window === '5h') - Number(a.window === '5h'));
    const windows = buckets.flatMap(bucket => {
      if (!bucket.id || bucket.disabled || typeof bucket.remaining_fraction !== 'number') return [];
      const title = bucket.window === 'weekly' ? 'Weekly limit' : bucket.window === '5h' ? '5-hour limit' : bucket.name?.replace(/ remaining$/i, '') ?? 'Usage limit';
      return usageWindow(bucket.id, title, (1 - bucket.remaining_fraction) * 100, Date.parse(bucket.reset_time ?? ''));
    });
    return { windows };
  } catch (error) {
    const failure = error as { message?: string; stderr?: string; stdout?: string };
    return { windows: [], signedOut: /not authenticated|authentication required|no valid authentication|sign in to antigravity/i.test(`${failure.stderr} ${failure.stdout}`) };
  }
}

async function claudeUsage(program: string, cwd: string): Promise<UsageReading> {
  const plan = await requireClaudeSubscription(program, cwd, AbortSignal.timeout(6_000)).catch(() => null);
  if (!plan) return { windows: [], signedOut: true };
  return { windows: await claudeUsageWindows(program, cwd), plan: `Claude ${plan[0].toUpperCase()}${plan.slice(1)}` };
}

async function claudeUsageWindows(program: string, cwd: string): Promise<UsageWindow[]> {
  return run(program, [
    ...claudeIsolation, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '',
    '--permission-mode', 'dontAsk', '--no-session-persistence', '--print', '/usage', '--output-format', 'json',
  ], {
    cwd, env: { ...cliEnvironment(), DISABLE_AUTOUPDATER: '1' }, timeout: 12_000, maxBuffer: 128_000,
  }).then(({ stdout }) => {
    const report = parseLine<{ subtype?: string; num_turns?: number; result?: string }>(stdout);
    if (report?.subtype !== 'success' || report.num_turns !== 0 || typeof report.result !== 'string') return [];
    return report.result.split(/\r?\n/).flatMap(line => {
      const match = /^(Current session|Current week(?: \([^)]+\))?):\s*(\d{1,3}(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.{1,100}))?$/i.exec(line.trim());
      if (!match) return [];
      const [, name, percent, resetLabel] = match;
      const session = name.toLowerCase() === 'current session';
      const scope = /\(([^)]+)\)/.exec(name)?.[1];
      const title = session ? '5-hour limit' : scope && scope.toLowerCase() !== 'all models' ? `Weekly · ${scope}` : 'Weekly limit';
      return usageWindow(name.toLowerCase(), title, Number(percent)).map(window => ({ ...window, resetLabel }));
    });
  }).catch(() => []);
}

const readers = { codex: codexUsage, gemini: geminiUsage, claude: claudeUsage };
const details = {
  codex: 'Check account usage in Codex.',
  claude: 'Open /usage in Claude Code or view your Claude plan.',
  gemini: 'Open /usage in Antigravity to check your Google AI plan.',
};
const login = {
  codex: 'Run codex login and sign in with ChatGPT.',
  claude: 'Run claude auth login --claudeai.',
  gemini: 'Run agy acp --login and sign in with Google.',
};

export function readProvider(provider: SubscriptionProvider, desktop: boolean, refresh: boolean): Promise<SubscriptionUsage> {
  const empty = { provider, windows: [] };
  if (!desktop) return Promise.resolve({ ...empty, status: 'unavailable', detail: 'Open the Mac app to read its signed-in CLI.' });
  const previous = cache.get(provider);
  const inFlight = pending.get(provider);
  if (inFlight) return inFlight;
  if (!refresh && previous && previous.expires > Date.now()) return Promise.resolve(previous.saved);
  const program = executable(provider);
  if (!program) {
    cache.delete(provider);
    return Promise.resolve({ ...empty, status: 'missing', detail: 'Install this CLI on the Marion Agent Mac.' });
  }

  const collect = async (): Promise<SubscriptionUsage> => {
    const cwd = await mkdtemp(join(tmpdir(), 'marion-usage-'));
    let reading: UsageReading = { windows: [] };
    try { reading = await readers[provider](program, cwd); }
    catch { /* Provider failures are independent and never expose raw CLI output. */ }
    finally { await rm(cwd, { recursive: true, force: true }); }
    if (reading.signedOut) return { ...empty, status: 'sign-in', detail: login[provider] };
    if (reading.windows.length) return { provider, status: 'ready', plan: reading.plan, windows: reading.windows, checkedAt: Date.now() };
    if (previous?.saved.windows.length) return { ...previous.saved, status: 'stale' };
    return { ...empty, status: 'unavailable', plan: reading.plan, detail: details[provider] };
  };
  const task = collect().catch((): SubscriptionUsage => ({ ...empty, status: 'unavailable', detail: details[provider] }))
    .then(saved => { cache.set(provider, { saved, expires: Date.now() + (saved.status === 'ready' ? maxAge : 15_000) }); return saved; })
    .finally(() => pending.delete(provider));
  pending.set(provider, task);
  return task;
}

export function subscriptionUsage(desktop: boolean, refresh: boolean) {
  return Promise.all(usageProviders.map(provider => readProvider(provider, desktop, refresh)));
}

// ---------- plan labels ----------
// The CLIs report the plan stored in their sign-in token, which lags behind an upgrade until the
// owner signs in again (Claude still says "pro" after moving to Max). The owner's chosen plan wins.

export const planOptions: Record<SubscriptionProvider, string[]> = {
  claude: ['Claude Pro · $20/mo', 'Claude Max · $100/mo', 'Claude Max · $200/mo'],
  codex: ['ChatGPT Plus · $20/mo', 'ChatGPT Pro · $200/mo'],
  gemini: ['Google AI Pro · $20/mo', 'Google AI Ultra · $250/mo'],
};
const defaultPlans: Record<SubscriptionProvider, string> = {
  claude: 'Claude Max · $100/mo',
  codex: 'ChatGPT Plus · $20/mo',
  gemini: 'Google AI Pro · $20/mo',
};

export const planLabels = (userId: string) => getSetting<Record<SubscriptionProvider, string>>(userId, 'plan-labels', defaultPlans);

export function savePlanLabels(userId: string, input: Record<string, unknown>) {
  const next = { ...planLabels(userId) };
  for (const provider of usageProviders) {
    const value = input[provider];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !planOptions[provider].includes(value)) throw new Error('Choose one of the listed plans.');
    next[provider] = value;
  }
  setSetting(userId, 'plan-labels', next);
  return next;
}

export function withPlanLabel(userId: string, usage: SubscriptionUsage): SubscriptionUsage {
  const plan = planLabels(userId)[usage.provider];
  return plan ? { ...usage, plan } : usage;
}
