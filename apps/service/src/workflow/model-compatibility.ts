import { z } from 'zod';
import { getModelProfile, type ModelProfile } from '../../../../packages/contracts/src/model-profiles.js';
import type { WorkflowUsage } from '../../../../packages/contracts/src/workflow.js';
import { WorkflowError } from './budget.js';

export function requireModelProfile(provider: string, model: string): ModelProfile {
  const profile = getModelProfile(provider, model);
  if (!profile) throw new WorkflowError('model_capability_unverified', 'This model has no reviewed compatibility record for the selected API. Choose a documented supported snapshot; model-list access alone is insufficient. No inference was started.');
  return profile;
}
const count = z.number().int().nonnegative().max(100000000);
const openaiUsage = z.object({ input_tokens: count, output_tokens: count,
  input_tokens_details: z.object({ cached_tokens: count, cache_write_tokens: count.optional() }),
  output_tokens_details: z.object({ reasoning_tokens: count }).nullable().optional() });
/** Missing cache writes mean zero only for the explicitly reviewed older model.
 * Unknown/newer models retain unavailable usage instead of guessed charges. */
export function measuredOpenAIUsage(model: string, raw: unknown): WorkflowUsage | null {
  const profile = getModelProfile('openai', model), parsed = openaiUsage.safeParse(raw);
  if (!parsed.success || !profile || profile.usage !== 'openai-before-5.6') return null;
  const value = parsed.data, write = value.input_tokens_details.cache_write_tokens ?? 0;
  if (value.input_tokens_details.cached_tokens + write > value.input_tokens || write !== 0) return null;
  return { inputTokens: value.input_tokens, outputTokens: value.output_tokens,
    cachedInputTokens: value.input_tokens_details.cached_tokens, cacheWriteTokens: write,
    reasoningTokens: value.output_tokens_details?.reasoning_tokens ?? null, source: 'provider-reported' };
}
