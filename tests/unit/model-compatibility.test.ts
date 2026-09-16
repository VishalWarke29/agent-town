import { describe, expect, it, vi } from 'vitest';
import { getModelProfile, profilePrice } from '@agent-town/contracts';
import { measuredOpenAIUsage, requireModelProfile } from '../../apps/service/src/workflow/model-compatibility';
import { OfficialWorkflowProvider } from '../../apps/service/src/workflow/provider';
import type { WorkflowConnection } from '@agent-town/contracts';

describe('documented API model compatibility', () => {
  it('blocks unreviewed models before any network request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const adapter = new OfficialWorkflowProvider(fetcher);
    const connection = { provider: 'openai' } as WorkflowConnection;
    await expect(adapter.countInput(connection, 'fixture-only', { model: 'unknown-next-model', input: '', maxOutputTokens: 800 })).rejects.toMatchObject({ code: 'model_capability_unverified' });
    await expect(adapter.summarize(connection, 'fixture-only', { model: 'unknown-next-model', input: '', maxOutputTokens: 800 })).rejects.toMatchObject({ code: 'model_capability_unverified' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses documented older-model cache semantics without guessing for other models', () => {
    const raw = { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 20 } };
    expect(measuredOpenAIUsage('gpt-5.4-mini-2026-03-17', raw)).toMatchObject({ inputTokens: 100, cachedInputTokens: 20, cacheWriteTokens: 0 });
    expect(measuredOpenAIUsage('gpt-6-unreviewed', raw)).toBeNull();
    expect(measuredOpenAIUsage('gpt-5.4-mini-2026-03-17', { ...raw, input_tokens_details: { cached_tokens: 200 } })).toBeNull();
    expect(measuredOpenAIUsage('gpt-5.4-mini-2026-03-17', { ...raw, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 } })).toBeNull();
  });
  it('does not turn documented prices into quality approval or provider fallback', () => {
    const profile = getModelProfile('anthropic', 'claude-haiku-4-5-20251001')!;
    expect(profilePrice(profile)).toMatchObject({ qualityStatus: 'unevaluated', inputPerMillionMicroUsd: 1000000, outputPerMillionMicroUsd: 5000000 });
    expect(() => requireModelProfile('openai', profile.model)).toThrow('No inference');
  });
});
