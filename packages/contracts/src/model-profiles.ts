import type { WorkflowModel } from './workflow.js';

export interface ModelProfile {
  provider: 'openai' | 'anthropic'; model: string; label: string;
  documentedAt: string; source: string; contextWindowTokens: number;
  input: number; output: number; cachedInput: number; cacheWrite: number;
  usage: 'openai-before-5.6' | 'anthropic';
  inputCounting: true; structuredOutput: true; functionTools: true;
}
// Deliberately reviewed snapshots. Model-list access and documentation do not
// establish funded credits, local sandbox readiness, or task quality.
export const modelProfiles: readonly ModelProfile[] = [
  { provider: 'openai', model: 'gpt-5.4-mini-2026-03-17', label: 'GPT-5.4 mini', documentedAt: '2026-09-15T00:00:00.000Z', source: 'https://developers.openai.com/api/docs/models/gpt-5.4-mini', contextWindowTokens: 400000, input: 750000, output: 4500000, cachedInput: 75000, cacheWrite: 750000, usage: 'openai-before-5.6', inputCounting: true, structuredOutput: true, functionTools: true },
  { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', documentedAt: '2026-09-15T00:00:00.000Z', source: 'https://platform.claude.com/docs/en/models/haiku-4-5/overview', contextWindowTokens: 200000, input: 1000000, output: 5000000, cachedInput: 100000, cacheWrite: 1250000, usage: 'anthropic', inputCounting: true, structuredOutput: true, functionTools: true },
];

export function getModelProfile(provider: string, model: string): ModelProfile | undefined {
  return modelProfiles.find(profile => profile.provider === provider && profile.model === model);
}
export function profilePrice(profile: ModelProfile): WorkflowModel {
  return { model: profile.model, contextWindowTokens: profile.contextWindowTokens,
    inputPerMillionMicroUsd: profile.input, outputPerMillionMicroUsd: profile.output,
    cachedInputPerMillionMicroUsd: profile.cachedInput, cacheWritePerMillionMicroUsd: profile.cacheWrite,
    priceSource: profile.source, priceCheckedAt: profile.documentedAt,
    qualityStatus: 'unevaluated', qualityNote: 'Documentation only. Review quality for this task before enabling paid work.' };
}
