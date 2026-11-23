import OpenAI from 'openai';
import { env } from '../env.js';

export const localModel = new OpenAI({
  baseURL: env.localModelUrl,
  // The SDK requires a value. Loopback Ollama ignores the authorization header.
  apiKey: env.localModelKey || 'ollama',
  timeout: 360_000,
  maxRetries: 0,
});

export const grok = env.xaiKey ? new OpenAI({
  baseURL: 'https://api.x.ai/v1',
  apiKey: env.xaiKey,
  timeout: 90_000,
}) : null;

/** Replay portable conversation items, dropping opaque artifacts from the old hosted model. */
export function localInput(items: any[]) {
  return items.filter(item => {
    if (!item || item.encrypted_content) return false;
    return ['message', 'function_call', 'function_call_output', 'reasoning'].includes(item.type)
      || (!item.type && ['user', 'assistant', 'system', 'developer'].includes(item.role));
  });
}
