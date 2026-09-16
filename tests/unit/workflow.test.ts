import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TownState } from '@agent-town/contracts';
import type { ManagerConfig, WorkflowModel, WorkflowUsage } from '../../packages/contracts/src/workflow';
import { IdentityError, type CredentialVault } from '../../apps/service/src/identity';
import { Store } from '../../apps/service/src/store';
import { WorkflowService, OfficialWorkflowProvider, ProviderRequestError, reserveOperation, settleReservation, estimatedCost, maximumRequestCost, workflowState, sanitizeModelText, type WorkflowProvider, type ManagerResponse } from '../../apps/service/src/workflow';

const key = 'sk-fixture_credential_for_boundary_tests';
const stores: Store[] = [];
const services: WorkflowService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); for (const store of stores.splice(0)) store.close(); });
function setup() {
  let now = Date.now();
  const seed: TownState = { schemaVersion: 1, workspace: { id: 'workspace-fixture', name: 'Private', mode: 'private' }, simulation: { running: false, step: 0 },
    repositories: [{ id: 'repo', name: 'Repo', description: '', language: 'TypeScript', branch: 'main', color: '#abc', position: [0, 0] }],
    agents: [], handoffs: [], activity: [], manager: { version: 0, brief: 'Existing accepted decision: preserve tests.', updatedAt: null } };
  const store = new Store(':memory:', seed); stores.push(store);
  const secrets = new Map<string, string>();
  const vault: CredentialVault = { available: true, put: vi.fn(async (id, value) => { secrets.set(id, value); }), get: vi.fn(async id => secrets.get(id) ?? null), delete: vi.fn(async id => { secrets.delete(id); }) };
  const usage: WorkflowUsage = { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, source: 'provider-reported' };
  const provider: WorkflowProvider = { verify: vi.fn(async () => ({ models: ['economy-test-model'] })), countInput: vi.fn(async () => 1000),
    summarize: vi.fn(async (_connection, _key, request): Promise<ManagerResponse> => {
      const input = JSON.parse(request.input) as { reports: { id: string; repoId: string }[]; blockers: string[] };
      return { complete: true, requestId: 'request-fixture', usage,
        text: JSON.stringify({ overview: 'Updated brief. Worker claims remain unverified.', repoBriefs: [{ repoId: 'repo', brief: 'Repo progress saved.' }], processedReportIds: input.reports.map(report => report.id), blockers: input.blockers, proposals: [{ repoId: 'repo', title: 'Review changes', acceptanceCriteria: ['Inspect the test evidence'] }] }) };
    }) };
  const service = new WorkflowService({ store, vault, provider, now: () => now }); services.push(service);
  const model: WorkflowModel = { model: 'economy-test-model', contextWindowTokens: 16000, inputPerMillionMicroUsd: 1_000_000, outputPerMillionMicroUsd: 5_000_000,
    cachedInputPerMillionMicroUsd: 100_000, cacheWritePerMillionMicroUsd: 2_000_000, priceSource: 'https://example.test/pricing', priceCheckedAt: new Date(now).toISOString(), qualityStatus: 'user-attested', qualityNote: 'Fixture human review; no real model evaluation.' };
  const addReport = (id: string, summary = 'Worker says tests passed; evidence is not verified.') => store.commit(`report-${id}`, state => {
    state.handoffs.push({ id, repoId: 'repo', agentId: 'external-agent', summary, createdAt: new Date(now).toISOString(), status: 'saved', contextVersion: null, delivery: 'unsupported' }); return 'handoff.saved';
  });
  const enable = async () => {
    await service.connectApi({ provider: 'openai', label: 'First account', apiKey: key }, 'connection-first');
    service.configurePolicy({ paidEnabled: true, dailyBudgetMicroUsd: 1_000_000, managerDailyBudgetMicroUsd: 500_000, maxRunBudgetMicroUsd: 100_000, workerConcurrency: 1, timeZone: 'UTC' }, 'policy');
    const config: ManagerConfig = { enabled: true, connectionId: service.state().connections[0].id, model, maxInputTokens: 4000, maxOutputTokens: 800, requestBudgetMicroUsd: 100_000 };
    service.configureManager(config, 'manager-config');
    return config;
  };
  return { service, store, vault, provider, secrets, model, usage, addReport, enable, advance: (ms: number) => { now += ms; }, time: () => new Date(now).toISOString() };
}

describe('Economy connections and budget boundaries', () => {
  describe.each(['openai', 'anthropic'] as const)('%s credential recovery', providerName => {
    it.each([false, true])('preserves a storage failure and retries without an incomplete connection (partial write: %s)', async partialWrite => {
      const { service, store, vault, provider, secrets } = setup();
      const before = store.snapshot();
      const failure = new IdentityError('vault_unavailable', 'Windows protected credential storage could not complete the operation.', 503);
      vi.mocked(vault.put).mockImplementationOnce(async (reference, secret) => {
        if (partialWrite) secrets.set(reference, secret);
        throw failure;
      });
      const input = { provider: providerName, label: 'Recovery account', apiKey: key };
      await expect(service.connectApi(input, 'recovery-connection')).rejects.toBe(failure);
      expect(provider.verify).toHaveBeenCalledOnce();
      expect(provider.verify).toHaveBeenCalledWith(input, expect.any(AbortSignal));
      expect(store.snapshot()).toEqual(before);
      expect(service.state().connections).toEqual([]);
      expect(service.state().defaults).toEqual({});
      expect(secrets.size).toBe(0);
      const reference = vi.mocked(vault.put).mock.calls[0][0];
      expect(vault.delete).toHaveBeenCalledExactlyOnceWith(reference);

      await service.connectApi(input, 'recovery-connection');
      expect(provider.verify).toHaveBeenCalledTimes(2);
      expect(service.state().connections).toHaveLength(1);
      expect(service.state().connections[0]).toMatchObject({ provider: providerName, status: 'verified' });
      expect(service.state().defaults[`${providerName}:api`]).toBe(service.state().connections[0].id);
      expect([...secrets.keys()]).toEqual([reference]);
      expect(service.state().policy.paidEnabled).toBe(false);
      expect(provider.countInput).not.toHaveBeenCalled();
      expect(provider.summarize).not.toHaveBeenCalled();
      expect(JSON.stringify(store.snapshot())).not.toContain(key);
    });

    it.each(['provider', 'storage'] as const)('sanitizes unknown %s errors without publishing a connection', async stage => {
      const { service, store, provider, vault, secrets } = setup();
      const before = store.snapshot();
      const failure = new Error(`Untrusted diagnostic includes ${key}`);
      if (stage === 'provider') vi.mocked(provider.verify).mockRejectedValueOnce(failure);
      else vi.mocked(vault.put).mockImplementationOnce(async (reference, secret) => { secrets.set(reference, secret); throw failure; });
      await expect(service.connectApi({ provider: providerName, label: 'Failure fixture', apiKey: key }, 'unknown-failure')).rejects.toMatchObject({ code: 'connection_failed', statusCode: 502, message: 'The provider connection could not be verified and saved.' });
      expect(store.snapshot()).toEqual(before);
      expect(secrets.size).toBe(0);
      if (stage === 'provider') { expect(vault.put).not.toHaveBeenCalled(); expect(vault.delete).not.toHaveBeenCalled(); }
      else expect(vault.delete).toHaveBeenCalledExactlyOnceWith(vi.mocked(vault.put).mock.calls[0][0]);
      expect(provider.countInput).not.toHaveBeenCalled();
      expect(provider.summarize).not.toHaveBeenCalled();
    });
  });

  it('can disable future summaries while preserving an already-sent manager request', async () => {
    const { service, provider, addReport, enable } = setup();
    const config = await enable(); addReport('pause-race');
    const summarize = provider.summarize;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    provider.summarize = async (...args) => { entered(); await gate; return summarize(...args); };
    const process = service.processManager('active-batch'); await started;
    try {
      expect(() => service.configureManager({ ...config, maxOutputTokens: 900 }, 'changed-inflight')).toThrow('current manager operation');
      service.configureManager({ ...config, enabled: false }, 'pause-future');
      expect(service.state().manager.config.enabled).toBe(false);
    } finally { release(); }
    await process;
    expect(service.state().manager.jobs[0]?.status).toBe('processed');
    expect(service.state().manager.config.enabled).toBe(false);
    await expect(service.processManager('later-batch')).rejects.toMatchObject({ code: 'manager_disabled' });
  });

  it('defaults to no paid work and makes no inference on connection, snapshots, or configuration', async () => {
    const { service, provider, secrets, store } = setup();
    expect(service.state().policy.paidEnabled).toBe(false);
    await expect(service.processManager('disabled')).rejects.toMatchObject({ code: 'manager_disabled' });
    await service.connectApi({ provider: 'openai', label: 'API account', apiKey: key }, 'connection');
    expect(provider.verify).toHaveBeenCalledTimes(1);
    expect(provider.summarize).not.toHaveBeenCalled();
    expect(provider.countInput).not.toHaveBeenCalled();
    expect(secrets.size).toBe(1);
    expect(JSON.stringify(store.snapshot())).not.toContain(key);
    expect(service.state().connections[0].accountIdentity).toBe('unavailable');
  });

  it('keeps first defaults per provider, deduplicates key registration, and never falls back after disconnect', async () => {
    const { service, provider, store, model, time } = setup();
    const input = { provider: 'openai' as const, label: 'First', apiKey: key };
    await service.connectApi(input, 'first');
    expect((await service.connectApi(input, 'first')).duplicate).toBe(true);
    await service.connectApi({ ...input, label: 'Second' }, 'second');
    await service.connectApi({ ...input, provider: 'anthropic' }, 'anthropic');
    const value = service.state();
    expect(value.defaults['openai:api']).toBe(value.connections[0].id);
    expect(value.defaults['anthropic:api']).toBe(value.connections[2].id);
    expect(provider.verify).toHaveBeenCalledTimes(3);
    await service.disconnect(value.connections[0].id, 'disconnect');
    expect(service.state().defaults['openai:api']).toBe(value.connections[0].id);
    store.commit('enable-policy-direct', state => { workflowState(state).policy = { paidEnabled: true, dailyBudgetMicroUsd: 10000, managerDailyBudgetMicroUsd: 5000, maxRunBudgetMicroUsd: 1000, workerConcurrency: 1, timeZone: 'UTC' }; return 'policy'; });
    expect(() => store.commit('reserve', state => { reserveOperation(state, { id: 'r', runId: 'run', purpose: 'worker', connectionId: value.connections[0].id, model, amountMicroUsd: 100, runBudgetMicroUsd: 1000 }, time()); return 'reserved'; })).toThrow('no fallback');
  });

  it('uses exact microUSD arithmetic including cache writes and inclusive output reasoning', () => {
    const { model } = setup();
    expect(estimatedCost(model, { inputTokens: 1000, cachedInputTokens: 500, cacheWriteTokens: 100, outputTokens: 100, reasoningTokens: 50, source: 'provider-reported' })).toBe(1150);
    expect(maximumRequestCost(model, 1000, 100)).toBe(2500);
    expect(estimatedCost({ ...model, inputPerMillionMicroUsd: 200000 }, { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: null, source: 'provider-reported' })).toBe(1);
    expect(() => estimatedCost(model, { inputTokens: 1, cachedInputTokens: 2, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: null, source: 'provider-reported' })).toThrow('reconciled');
  });

  it('atomically enforces concurrency, fixed run account/model/allowance, and uncertain holds after midnight', async () => {
    const { enable, service, store, model, time, advance } = setup();
    const config = await enable();
    const request = { id: 'one', runId: 'run', purpose: 'worker' as const, connectionId: config.connectionId!, model, amountMicroUsd: 90000, runBudgetMicroUsd: 100000 };
    store.commit('reserve-one', state => { reserveOperation(state, request, time()); return 'reserved'; });
    const cursor = store.snapshot().cursor;
    expect(() => store.commit('reserve-two', state => { reserveOperation(state, { ...request, id: 'two', runId: 'other' }, time()); return 'reserved'; })).toThrow('active operation');
    expect(store.snapshot().cursor).toBe(cursor);
    store.commit('unknown', state => { settleReservation(state, 'one', null, time()); return 'uncertain'; });
    advance(86_400_000);
    expect(() => store.commit('reserve-three', state => { reserveOperation(state, { ...request, id: 'three', runBudgetMicroUsd: 99000 }, time()); return 'reserved'; })).toThrow('cannot change');
    expect(service.state().reservations[0].status).toBe('uncertain');
    expect(service.state().reservations[0].actualMicroUsd).toBeNull();
    expect(() => store.commit('reserve-four', state => { reserveOperation(state, { ...request, id: 'four' }, time()); return 'reserved'; })).toThrow('Reconcile');
  });

  it('blocks model quality claims, stale pricing, and cost-policy timezone reset tricks', async () => {
    const { service, enable, addReport, advance } = setup();
    const config = await enable();
    expect(() => service.configureManager({ ...config, model: { ...config.model!, qualityStatus: 'unevaluated' } }, 'unevaluated')).toThrow('quality review');
    addReport('report');
    await service.processManager('run');
    expect(() => service.configurePolicy({ ...service.state().policy, timeZone: 'America/Los_Angeles' }, 'timezone')).toThrow('timezone');
    advance(31 * 86_400_000);
    expect(() => service.configureManager(config, 'stale')).toThrow('price record');
  });
});

describe('durable manager processing', () => {
  it('batches real saved reports and atomically saves a version without acceptance or context delivery', async () => {
    const { service, provider, store, enable, addReport, advance } = setup();
    await enable();
    for (let index = 0; index < 20; index++) addReport(`report-${index}`);
    await expect(service.processManager('early', { automatic: true })).rejects.toMatchObject({ code: 'manager_batch_waiting' });
    advance(30_000);
    await service.processManager('batch', { automatic: true });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
    expect(service.state().manager.versions[0].reportIds).toHaveLength(20);
    expect(store.snapshot().state.manager.version).toBe(1);
    expect(store.snapshot().state.handoffs.every(report => report.status === 'processed' && report.delivery === 'unsupported')).toBe(true);
    expect(service.state().manager.proposals[0].status).toBe('proposed');
    expect((await service.processManager('batch', { automatic: true })).duplicate).toBe(true);
    expect(provider.summarize).toHaveBeenCalledTimes(1);
  });

  it('stops automatic processing after six hourly batches', async () => {
    const { service, enable, addReport, advance, provider } = setup();
    await enable();
    for (let index = 0; index < 6; index++) { addReport(`report-${index}`); advance(30_000); await service.processManager(`batch-${index}`, { automatic: true }); }
    addReport('seventh'); advance(30_000);
    await expect(service.processManager('seventh', { automatic: true })).rejects.toMatchObject({ code: 'manager_hourly_limit' });
    expect(provider.summarize).toHaveBeenCalledTimes(6);
  });

  it('keeps the old brief on invalid output, settles known usage, and requires explicit retry', async () => {
    const { service, store, provider, enable, addReport, usage, advance } = setup();
    await enable(); addReport('report'); advance(30_000);
    provider.summarize = vi.fn(async () => ({ text: '{"invented":"fields"}', usage, requestId: 'request', complete: true }));
    await expect(service.processManager('invalid', { automatic: true })).rejects.toMatchObject({ code: 'manager_result_invalid' });
    expect(store.snapshot().state.manager.version).toBe(0);
    expect(store.snapshot().state.handoffs[0].status).toBe('saved');
    expect(service.state().reservations[0]).toMatchObject({ status: 'settled', actualMicroUsd: 1500 });
    await expect(service.processManager('automatic-retry', { automatic: true })).rejects.toMatchObject({ code: 'manager_no_reports' });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
  });

  it('holds unknown costs, recovers interrupted jobs, and permits only explicit reconciliation', async () => {
    const { service, store, provider, enable, addReport, usage } = setup();
    await enable(); addReport('report');
    provider.summarize = vi.fn(async () => { throw new ProviderRequestError('timeout', 'Outcome unknown', 'uncertain'); });
    await expect(service.processManager('unknown')).rejects.toMatchObject({ code: 'timeout' });
    expect(service.state().reservations[0].status).toBe('uncertain');
    await expect(service.processManager('retry')).rejects.toMatchObject({ code: 'manager_reconciliation_required' });
    const reservationId = service.state().reservations[0].id;
    service.reconcile(reservationId, { ...usage, source: 'user-reconciled' }, 'reconcile');
    expect(service.state().reservations[0].settlementSource).toBe('user-reconciled');
    expect(service.state().manager.jobs[0].status).toBe('failed');
    store.commit('simulate-restart-inflight', state => { const value = workflowState(state); value.manager.jobs[0].status = 'running'; value.reservations[0].status = 'reserved'; value.reservations[0].actualMicroUsd = null; return 'testing'; });
    service.recoverInterrupted();
    expect(service.state().manager.jobs[0].status).toBe('uncertain');
    expect(provider.summarize).toHaveBeenCalledTimes(1);
  });

  it('splits at report boundaries and blocks oversized single reports without dropping content', async () => {
    const { service, provider, enable, addReport } = setup();
    await enable(); addReport('one'); addReport('two');
    provider.countInput = vi.fn(async (_connection, _key, request) => JSON.parse(request.input).reports.length === 2 ? 5000 : 1000);
    await service.processManager('split');
    expect(service.state().manager.versions[0].reportIds).toHaveLength(1);
    expect(service.state().manager.queueReportIds).toHaveLength(1);
    provider.countInput = vi.fn(async () => 99999);
    await expect(service.processManager('large')).rejects.toMatchObject({ code: 'manager_input_large' });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
  });

  it('removes credentials and URL secrets before sending reports or saving output', async () => {
    const { service, store, provider, enable, addReport, usage } = setup();
    await enable(); addReport('secret-report', `Credential ${key}. See https://user:password@example.test/path?token=secret#fragment`);
    provider.summarize = vi.fn(async (_connection, _key, request) => {
      expect(request.input).not.toContain(key); expect(request.input).not.toContain('token=secret'); expect(request.input).not.toContain('user:password');
      return { complete: true, requestId: null, usage, text: JSON.stringify({ overview: `Result ${key}`, repoBriefs: [{ repoId: 'repo', brief: 'Saved' }], blockers: [], proposals: [], processedReportIds: ['secret-report'] }) };
    });
    await service.processManager('sanitize');
    expect(store.snapshot().state.manager.brief).toBe('Result [redacted]');
    expect(sanitizeModelText('Authorization: Bearer private-value')).toBe('[redacted sensitive field]');
  });
});

describe('official inference adapters using HTTP fixtures', () => {
  it('uses fixed endpoints and bounded standard-tier requests without tools or automatic retry', async () => {
    const { service, enable } = setup(); await enable();
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ input_tokens: 42 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'resp_fixture', model: 'gpt-5.4-mini-2026-03-17', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }], usage: { input_tokens: 42, output_tokens: 12, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 2 } } })));
    const adapter = new OfficialWorkflowProvider(request);
    const connection = service.state().connections[0];
    const input = { model: 'gpt-5.4-mini-2026-03-17', input: 'sanitized reports', maxOutputTokens: 800 };
    expect(await adapter.countInput(connection, key, input)).toBe(42);
    const result = await adapter.summarize(connection, key, input);
    expect(result.usage).toMatchObject({ inputTokens: 42, outputTokens: 12, reasoningTokens: 2 });
    expect(request.mock.calls.map(call => call[0])).toEqual(['https://api.openai.com/v1/responses/input_tokens', 'https://api.openai.com/v1/responses']);
    const body = JSON.parse(String(request.mock.calls[1][1]?.body));
    expect(body).toMatchObject({ max_output_tokens: 800, service_tier: 'default', tools: [], store: false, truncation: 'disabled' });
    expect(request.mock.calls[1][1]?.redirect).toBe('error');
    expect(JSON.stringify(body)).not.toContain(key);
  });

  it('keeps missing usage unavailable and treats transport failures as uncertain', async () => {
    const { service, enable } = setup(); await enable();
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ id: 'resp_fixture', model: 'gpt-5.4-mini-2026-03-17', status: 'completed', output: [], usage: { input_tokens: 42, output_tokens: 12 } })))
      .mockRejectedValueOnce(new Error(`network failure ${key}`));
    const adapter = new OfficialWorkflowProvider(request);
    const connection = service.state().connections[0];
    const input = { model: 'gpt-5.4-mini-2026-03-17', input: 'reports', maxOutputTokens: 800 };
    expect((await adapter.summarize(connection, key, input)).usage).toBeNull();
    await expect(adapter.summarize(connection, key, input)).rejects.toMatchObject({ outcome: 'uncertain', code: 'provider_unavailable' });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
