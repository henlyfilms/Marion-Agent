import type { ChatModel, ChatModelSelection, ChatProvider } from '../types.js';

/**
 * Per-provider defaults from Settings → Models → "Default model & effort" (Claude, Codex, Gemini). Every builder run
 * (ask_subscription, orchestrate subagents and orchestrators, chat relays) uses them whenever the request does not name
 * a model or an effort itself. Pure: no database, so it is shared by the tools and unit tests.
 */
export type ProviderDefault = { model: string; effort: string | null };
export type ProviderDefaults = Partial<Record<ChatProvider, ProviderDefault>>;

const providerNames: Record<ChatProvider, string> = { local: 'Local', codex: 'Codex', gemini: 'Gemini', claude: 'Claude' };
const words = (value: string) => value.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').split(' ').filter(Boolean);

/** "claude", "codex" (or chatgpt/openai/gpt), "gemini", "local" alone: a provider, not a specific model. */
export function providerOnly(query: string): ChatProvider | undefined {
  const wanted = words(query);
  if (wanted.length !== 1) return undefined;
  return (['codex', 'gemini', 'claude', 'local'] as const)
    .find(p => wanted[0] === p || (p === 'codex' && ['chatgpt', 'openai', 'gpt'].includes(wanted[0])));
}

/** "6.2 Astra", "gemini 4 neon", "claude", "codex" → the best matching model (a bare provider → its catalog default). */
export function matchModel(models: ChatModel[], query: string): ChatModel | undefined {
  const wanted = words(query);
  if (!wanted.length) return undefined;
  const provider = providerOnly(query);
  if (provider) return models.find(m => m.provider === provider && m.defaultEffort) ?? models.find(m => m.provider === provider);
  let best: { model: ChatModel; score: number } | undefined;
  for (const model of models) {
    const hay = words(`${providerNames[model.provider]} ${model.label} ${model.id}`).join(' ');
    const hits = wanted.filter(word => hay.includes(word)).length;
    const score = hits / wanted.length + (hay.includes(wanted.join(' ')) ? 0.5 : 0);
    if (hits && (!best || score > best.score)) best = { model, score };
  }
  return best && best.score >= 0.6 ? best.model : undefined;
}

/** Effort for `model` when the request named none: the provider's saved effort when the model offers it, else the model's own default. */
export function defaultEffortFor(model: ChatModel, saved?: ProviderDefault): string | null {
  if (!model.efforts.length) return null;
  if (saved?.effort && model.efforts.includes(saved.effort)) return saved.effort;
  return model.defaultEffort ?? model.efforts[0] ?? null;
}

/** A team model by name. A bare provider name ("claude", "gemini") means that provider's Settings default model. */
export function pickModel(models: ChatModel[], query: string, defaults: ProviderDefaults): ChatModel | undefined {
  const provider = providerOnly(query);
  const saved = provider ? defaults[provider] : undefined;
  if (provider && saved) {
    const chosen = models.find(m => m.provider === provider && m.id === saved.model);
    if (chosen) return chosen;
  }
  return matchModel(models, query);
}

/**
 * The model and effort one provider run uses. A model or effort the request names explicitly wins (validated against the
 * provider's catalog when it is known); anything left out comes from the provider's Settings default.
 */
export function resolveRunSelection<P extends ChatProvider>(
  provider: P, models: ChatModel[], saved: ProviderDefault, request: { model?: unknown; effort?: unknown } = {},
): ChatModelSelection & { provider: P } {
  const own = models.filter(m => m.provider === provider);
  const asked = typeof request.model === 'string' ? request.model.trim() : '';
  let modelId = saved.model;
  let chosen: ChatModel | undefined;
  if (asked && !providerOnly(asked)) {
    chosen = own.find(m => m.id === asked) ?? matchModel(own, asked);
    if (!chosen && own.length) {
      throw new Error(`No ${providerNames[provider]} model matches "${asked}". Available: ${own.map(m => m.label).join(', ')}.`);
    }
    modelId = chosen?.id ?? asked;
  } else chosen = own.find(m => m.id === saved.model);
  const askedEffort = typeof request.effort === 'string' ? request.effort.trim().toLowerCase() : '';
  let effort: string | null;
  if (askedEffort) {
    if (chosen && !chosen.efforts.includes(askedEffort)) {
      throw new Error(chosen.efforts.length ? `${chosen.label} supports ${chosen.efforts.join(', ')} effort.` : `${chosen.label} has no effort setting.`);
    }
    effort = askedEffort;
  } else effort = chosen ? defaultEffortFor(chosen, saved) : saved.effort;
  return { provider, model: modelId, effort, ...(chosen ? { label: chosen.label } : {}) };
}
