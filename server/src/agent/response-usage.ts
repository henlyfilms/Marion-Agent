import type { ChatModelSelection, ResponseUsage } from '../types.js';

export interface TokenCounts {
  input: number;
  output: number;
}

export function tokenCounts(input: unknown, output: unknown): TokenCounts | undefined {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0
      || typeof output !== 'number' || !Number.isFinite(output) || output < 0) return;
  return { input, output };
}

export function addResponseUsage(
  usages: ResponseUsage[], model: ChatModelSelection, counts: TokenCounts | undefined, estimate: TokenCounts,
) {
  const existing = usages.find(usage => usage.provider === model.provider && usage.model === model.model);
  const tokens = counts ?? estimate;
  if (existing) {
    existing.input += tokens.input;
    existing.output += tokens.output;
    existing.estimated ||= !counts;
  } else {
    usages.push({ ...model, ...tokens, estimated: !counts });
  }
}
