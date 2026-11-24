import { localModel } from './models.js';
import { chatModelForBot } from './chat-model.js';
import { subscriptionReply, type SubscriptionSelection } from './subscriptions.js';
import { getBotRow } from '../store.js';

/**
 * One text call for background jobs (compaction summaries, memory, self-improvement).
 * Uses the bot's own chat model: its Claude, Codex or Gemini plan when one is selected,
 * otherwise the local model. Background jobs used to require the local model even when
 * every chat ran on a subscription, so they silently never ran.
 */
export async function backgroundText(botId: string, system: string, user: string, signal?: AbortSignal): Promise<string> {
  const bot = getBotRow(botId);
  if (!bot) throw new Error('Bot not found');
  const selection = chatModelForBot(bot);
  const abort = signal ?? AbortSignal.timeout(240_000);
  if (selection.provider !== 'local') {
    const prompt = `${system}\n\nAnswer with the requested output only. Do not request tools.\n\n${user}`;
    return (await subscriptionReply(selection as SubscriptionSelection, prompt, abort)).trim();
  }
  const res: any = await localModel.responses.create({
    model: selection.model,
    input: [{ role: 'system', content: system }, { role: 'user', content: user }],
    reasoning: { effort: 'low' },
  } as any, { signal: abort });
  return String(res.output_text ?? '').trim();
}

/** Pull the first JSON object out of a model reply (CLIs sometimes wrap it in a code fence or prose). */
export function parseJsonObject<T = any>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  for (const candidate of [fenced, text]) {
    if (!candidate) continue;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try { return JSON.parse(candidate.slice(start, end + 1)) as T; } catch { /* try the next form */ }
  }
  return null;
}
