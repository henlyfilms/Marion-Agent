import OpenAI from 'openai';
import { db } from '../db.js';
import '../db-config.js';
import { env } from '../env.js';

export { localEfforts } from '../types.js';

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

export const selectedLocalModel = (userId: string): string =>
  (db.prepare('SELECT model FROM local_model_preferences WHERE user_id=?').get(userId) as { model: string } | undefined)?.model ?? env.localModelName;

export const modelForBot = (botId: string): string => {
  const row = db.prepare('SELECT user_id FROM bots WHERE id=?').get(botId) as { user_id: string } | undefined;
  return row ? selectedLocalModel(row.user_id) : env.localModelName;
};

export async function availableLocalModels(): Promise<string[]> {
  const page = await localModel.models.list({ timeout: 4000 });
  return [...new Set(page.data.map(model => model.id).filter(Boolean))].sort();
}

export function saveLocalModel(userId: string, model: string) {
  if (!model) db.prepare('DELETE FROM local_model_preferences WHERE user_id=?').run(userId);
  else db.prepare('INSERT INTO local_model_preferences(user_id,model) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET model=excluded.model')
    .run(userId, model);
}
