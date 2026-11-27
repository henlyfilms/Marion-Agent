import { createHash } from 'node:crypto';
import { db } from '../db.js';
import { isUsageLimitError } from './usage-limit.js';
import { isSignInFailure } from './sign-in.js';
import type { ChatModelSelection } from '../types.js';

/**
 * A chat runner's own settings (provider, model, effort) checked before a run launches, and told apart from failures of
 * the request it makes downstream (reliability plan §3.5, fixture `rt_fzpoML-AEEjk`: a scheduled run that failed
 * before any tool call).
 * - Empty effort (`""`) is unset: the CLI gets no `--effort` at all, never `--effort ""`.
 * - Settings that can't work (empty or garbled model, a model for another provider, an unknown effort level) stop the
 *   run before anything launches. A CLI that rejects the model itself is classified the same way.
 * - Either way the chat gets one card per settings key, and the same settings are not launched again (polls, auto
 *   resumes, routines, restarts) until they change.
 */

export const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

type RunnerSelection = Pick<ChatModelSelection, 'provider' | 'model' | 'effort'>;

export class RunnerSettingsInvalid extends Error {
  override name = 'RunnerSettingsInvalid';
  constructor(readonly provider: string, readonly setting: 'model' | 'effort', readonly value: string, readonly key: string, detail: string) {
    super(detail);
  }
}

/** `""`, whitespace, null and undefined all mean "no effort chosen". */
export function normalizeEffort(effort: string | null | undefined): string | null {
  const value = typeof effort === 'string' ? effort.trim() : effort;
  return value ? value : null;
}

/** Stable key of the settings a run launches with: a relaunch is allowed only after it changes. */
export function runnerSettingsKey(selection: RunnerSelection): string {
  const raw = [selection.provider, (selection.model ?? '').trim(), normalizeEffort(selection.effort) ?? ''].join('\u0000');
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

const providerName: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', local: 'the local model' };
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;
const PROVIDER_MODEL: Record<string, RegExp> = {
  claude: /^(?:claude-[a-z0-9.-]+|opus|sonnet|haiku)(?:\[1m\])?$/i,
  gemini: /^gemini-[a-z0-9.-]+$/i,
};

/** The reason these settings can't launch, or null when they can. Purely local: no CLI, no network. */
export function checkRunnerSettings(selection: RunnerSelection): RunnerSettingsInvalid | null {
  const { provider } = selection;
  if (provider === 'local') return null;
  const key = runnerSettingsKey(selection);
  const who = providerName[provider] ?? provider;
  const model = String(selection.model ?? '').trim();
  // Codex alone treats "no model" as "the account's default".
  const modelOk = model ? MODEL_ID.test(model) && !/^(?:undefined|null|nan)$/i.test(model) && (PROVIDER_MODEL[provider]?.test(model) ?? true)
    : provider === 'codex';
  if (!modelOk) {
    return new RunnerSettingsInvalid(provider, 'model', model, key,
      model ? `the model "${model.slice(0, 80)}" isn't a ${who} model` : `no ${who} model is set`);
  }
  const effort = normalizeEffort(selection.effort);
  if (effort && !(EFFORT_LEVELS as readonly string[]).includes(effort)) {
    return new RunnerSettingsInvalid(provider, 'effort', effort, key, `"${effort.slice(0, 40)}" isn't a reasoning effort level`);
  }
  return null;
}

/** What a CLI says when the model it was given doesn't exist or isn't available (not effort refusals: those retry once). */
const MODEL_REJECTED = new RegExp([
  String.raw`issue\s+with\s+the\s+selected\s+model`,
  String.raw`\b(?:unknown|invalid|unsupported|unrecognized)\s+model\b`,
  // agy: `invalid model selection (--model "gemini-4-neon" --effort ""): model gemini-4-neon is not recognized as a known
  // model or custom model in settings` — the model itself is unknown (never an effort refusal, never retried).
  String.raw`\binvalid\s+model\s+selection\b`,
  String.raw`\bmodel\s+"?[\w.:/@-]+"?\s+is\s+not\s+(?:recognized|recognised)\b`,
  String.raw`\bnot\s+(?:recognized|recognised)\s+as\s+a\s+known\s+model\b`,
  String.raw`\bmodel\s+"?[\w.:/@-]+"?\s+(?:is\s+)?(?:not\s+found|does\s+not\s+exist|is\s+unavailable|not\s+available)`,
  String.raw`Codex model \S+ is unavailable for this account`,
  String.raw`could not use \S+ with this account\. Choose another model`,
  String.raw`Choose a supported reasoning effort for`,
].join('|'), 'i');

/** The runner's own launch failed because of its settings (not the downstream request): the classified error, else null. */
export function runnerSettingsFailure(error: unknown, selection: RunnerSelection): RunnerSettingsInvalid | null {
  if (error instanceof RunnerSettingsInvalid) return error;
  const message = String((error as Error)?.message ?? error ?? '');
  if (!MODEL_REJECTED.test(message)) return null;
  const effortProblem = /reasoning effort/i.test(message);
  return new RunnerSettingsInvalid(selection.provider, effortProblem ? 'effort' : 'model',
    effortProblem ? normalizeEffort(selection.effort) ?? '' : String(selection.model ?? ''), runnerSettingsKey(selection),
    `${providerName[selection.provider] ?? selection.provider} rejected them: ${message.split('\n')[0].slice(0, 200)}`);
}

/** Card text for a runner-settings block. Scheduled runs name the scheduled chat runner, so it is never read as a provider outage. */
export function runnerSettingsText(error: RunnerSettingsInvalid, routine?: string): string {
  const what = routine ? `Routine "${routine}" didn't start: the scheduled chat runner settings are invalid` : `This chat's runner settings are invalid`;
  return `${what} (${error.message}). Fix the ${error.setting} in this chat's model settings; it won't run again with the same settings.`;
}

export type DownstreamClass = 'quota' | 'auth' | 'provider';

/** A failure of the request the runner made (valid settings): quota, sign-in or a plain provider error. */
export function downstreamClass(error: unknown): DownstreamClass {
  if (isUsageLimitError(error)) return 'quota';
  const message = String((error as Error)?.message ?? error ?? '');
  // The same narrowed classifier as the Gemini sign-in card: proxy auth (407), an account mismatch, "log in to file" and
  // `--login` paths/flags are not a sign-in.
  if ((error as Error)?.name === 'GoogleSignInRequired' || isSignInFailure(message)) return 'auth';
  return 'provider';
}

export function downstreamText(error: unknown, provider: string, routine?: string): string {
  const message = String((error as Error)?.message ?? error ?? '');
  const kind = { quota: 'hit a usage limit', auth: 'needs a sign-in', provider: 'failed' }[downstreamClass(error)];
  const who = providerName[provider] ?? provider;
  return routine ? `Routine "${routine}": the ${who} request ${kind}: ${message}` : `Something went wrong: ${message}`;
}

/** The latest runner-settings card in this chat has this key: the same settings already failed, so don't launch or re-card. */
export function blockedSettingsKey(botId: string, generation: number): string | null {
  const row = db.prepare("SELECT json_extract(body,'$.blocker.key') key FROM rows WHERE bot_id=? AND generation=? AND kind='notice' AND json_extract(body,'$.blocker.kind')='runner_settings' ORDER BY seq DESC LIMIT 1")
    .get(botId, generation) as { key: string | null } | undefined;
  return row?.key ?? null;
}
