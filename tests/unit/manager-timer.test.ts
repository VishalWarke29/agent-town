import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { TownState } from '@agent-town/contracts';
import type { ManagerConfig, WorkflowModel, WorkflowUsage } from '../../packages/contracts/src/workflow';
import type { CredentialVault } from '../../apps/service/src/identity';
import { Store } from '../../apps/service/src/store';
import { registerWorkflowApi } from '../../apps/service/src/workflow-api';
import { WorkflowError, billingDay } from '../../apps/service/src/workflow/budget';
import { ProviderRequestError, OfficialWorkflowProvider, type WorkflowProvider, type ManagerResponse } from '../../apps/service/src/workflow/provider';
import { isManagerWaitCode, isTransientManagerWaitCode, MANAGER_STICKY_WAIT_CODES, MANAGER_TRANSIENT_WAIT_CODES } from '../../apps/service/src/workflow/service';

// These tests drive the real 30-second scheduling timer through registerWorkflowApi, under
// fake timers, with a counting fake provider and vault. They exist because the guard had only
// 3 of 10 known wait codes before this change, so 7 kept re-reading the vault and re-counting
// tokens every 30 seconds even though nothing could change the outcome (docs/29 C3). Restoring
// the old 3-code guard/catch in a scratch copy of workflow/service.ts and re-running this file
// reproduces that regression: the credential_unavailable/provider_rejected/manager_dispatch_failed/
// budget/token_count_unavailable/provider_unavailable cases below then keep making calls on
// every one of the 100 further ticks instead of holding steady, failing their assertions.

const key = 'sk-fixture_credential_for_manager_timer_tests';
const fakeApp = { get() {}, post() {}, patch() {}, log: { error() {} } } as unknown as FastifyInstance;

function buildFixture(workspaceId: string) {
  const seed: TownState = { schemaVersion: 1, workspace: { id: workspaceId, name: 'Private', mode: 'private' }, simulation: { running: false, step: 0 },
    repositories: [{ id: 'repo', name: 'Repo', description: '', language: 'TypeScript', branch: 'main', color: '#abc', position: [0, 0] }],
    agents: [], handoffs: [], activity: [], manager: { version: 0, brief: '', updatedAt: null } };
  const store = new Store(':memory:', seed);
  const secrets = new Map<string, string>();
  const vault: CredentialVault = { available: true, put: vi.fn(async (id, value) => { secrets.set(id, value); }), get: vi.fn(async id => secrets.get(id) ?? null), delete: vi.fn(async id => { secrets.delete(id); }) };
  const usage: WorkflowUsage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, source: 'provider-reported' };
  const provider: WorkflowProvider = {
    verify: vi.fn(async () => ({ models: ['economy-test-model'] })),
    countInput: vi.fn(async () => 1),
    summarize: vi.fn(async (_connection, _apiKey, request): Promise<ManagerResponse> => {
      const input = JSON.parse(request.input) as { reports: { id: string; repoId: string }[] };
      return { complete: true, requestId: 'req', usage, text: JSON.stringify({ overview: 'ok', repoBriefs: [{ repoId: 'repo', brief: 'ok' }], processedReportIds: input.reports.map(report => report.id), blockers: [], proposals: [] }) };
    }),
  };
  const model: WorkflowModel = { model: 'economy-test-model', contextWindowTokens: 16000, inputPerMillionMicroUsd: 1_000_000, outputPerMillionMicroUsd: 1_000_000,
    cachedInputPerMillionMicroUsd: 100_000, cacheWritePerMillionMicroUsd: 200_000, priceSource: 'https://example.test/pricing', priceCheckedAt: new Date().toISOString(), qualityStatus: 'user-attested', qualityNote: 'Fixture human review; no real model evaluation.' };
  const addReport = (id: string) => store.commit(`report-${id}`, state => {
    state.handoffs.push({ id, repoId: 'repo', agentId: 'external-agent', summary: 'Worker report body.', createdAt: new Date().toISOString(), status: 'saved', contextVersion: null, delivery: 'unsupported' }); return 'handoff.saved';
  });
  return { store, vault, provider, model, secrets, addReport };
}

function withApi(fixture: ReturnType<typeof buildFixture>, stores: Store[] = [fixture.store]) {
  const handle = registerWorkflowApi(fakeApp, { scoped: () => fixture.store, stores: () => stores, vault: fixture.vault, provider: fixture.provider });
  const service = handle.service(fixture.store);
  const enable = async (overrides: { requestBudgetMicroUsd?: number; dailyBudgetMicroUsd?: number; managerDailyBudgetMicroUsd?: number; automatic?: boolean } = {}) => {
    await service.connectApi({ provider: 'openai', label: 'Account', apiKey: key }, `connection-${fixture.store.snapshot().state.workspace.id}`);
    service.configurePolicy({ paidEnabled: true, dailyBudgetMicroUsd: overrides.dailyBudgetMicroUsd ?? 1_000_000, managerDailyBudgetMicroUsd: overrides.managerDailyBudgetMicroUsd ?? 1_000_000, maxRunBudgetMicroUsd: 1_000_000, workerConcurrency: 1, timeZone: 'UTC' }, 'policy');
    const config: ManagerConfig = { enabled: true, connectionId: service.state().connections[0].id, model: fixture.model, maxInputTokens: 4000, maxOutputTokens: 800, requestBudgetMicroUsd: overrides.requestBudgetMicroUsd ?? 1_000_000, automatic: overrides.automatic ?? true };
    service.configureManager(config, 'manager-config');
    return config;
  };
  return { ...fixture, handle, service, enable };
}

function setup(workspaceId = 'workspace-timer') { return withApi(buildFixture(workspaceId)); }

/** Directly records a settled reservation for today, as an earlier request would have left it, to test how the floor pre-check reacts to a shared budget that is already partly spent. */
function injectSettledReservation(ctx: ReturnType<typeof setup>, purpose: 'manager' | 'worker', amountMicroUsd: number) {
  const connectionId = ctx.service.state().connections[0].id;
  const now = new Date().toISOString();
  ctx.store.commit(`inject-${purpose}-${amountMicroUsd}`, state => {
    state.workflow!.reservations.push({ id: `prior-${purpose}-${amountMicroUsd}`, runId: `prior-run-${purpose}-${amountMicroUsd}`, purpose, connectionId, provider: 'openai', mode: 'api', model: ctx.model,
      amountMicroUsd, runBudgetMicroUsd: amountMicroUsd, actualMicroUsd: amountMicroUsd, usage: null, status: 'settled', day: billingDay(now, 'UTC'), createdAt: now, settledAt: now, settlementSource: 'provider-usage' });
    return 'inject-reservation';
  });
}

const runTicks = async (count: number) => { await vi.advanceTimersByTimeAsync(count * 30_000); };
const openHandles: { close(): Promise<void> }[] = [];
const openStores: Store[] = [];

// The daily budget window is a UTC day and queueBasis (workflow/queue.ts) includes it, so the
// service correctly allows one fresh attempt, and one fresh vault read, when the day changes.
// These tests build fixtures with new Date() and then advance 100 ticks of 30 seconds (50
// minutes) of fake time. Started from the real clock, a run inside the 50 minutes before 00:00 UTC
// crossed midnight, the window rolled over and six tests failed for about an hour every day
// (MG-40). Every test therefore starts from the same fixed midday UTC moment; the tests in the
// "UTC midnight" describe below set their own start on purpose, so the rollover stays pinned.
const PINNED_START = '2026-09-24T12:00:00.000Z';
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(PINNED_START)); });
afterEach(async () => {
  for (const handle of openHandles.splice(0)) await handle.close();
  for (const store of openStores.splice(0)) store.close();
  vi.useRealTimers();
});

describe('manager scheduling: does not repeat a doomed attempt every 30 seconds', () => {
  it.each([
    { code: 'model_capability_unverified', arrange: (ctx: ReturnType<typeof setup>) => { ctx.provider.countInput = vi.fn(async () => { throw new WorkflowError('model_capability_unverified', 'This model has no reviewed compatibility record.'); }); } },
    { code: 'provider_rejected', arrange: (ctx: ReturnType<typeof setup>) => { ctx.provider.countInput = vi.fn(async () => { throw new ProviderRequestError('provider_rejected', 'The provider rejected this request.', 'not-billed', undefined, 400); }); } },
    { code: 'manager_dispatch_failed', arrange: (ctx: ReturnType<typeof setup>) => { ctx.provider.countInput = vi.fn(async () => { throw new Error('Unexpected pre-dispatch failure.'); }); } },
    { code: 'credential_unavailable', arrange: (ctx: ReturnType<typeof setup>) => { ctx.vault.get = vi.fn(async () => null); } },
  ])('$code: one wait is saved, then 100 further ticks make no further vault reads or count calls', async ({ code, arrange }) => {
    const ctx = setup(); openHandles.push(ctx.handle); openStores.push(ctx.store);
    await ctx.enable(); ctx.addReport('report'); arrange(ctx);
    await runTicks(1);
    expect(ctx.store.snapshot().state.workflow?.manager.waitingStatus?.code).toBe(code);
    const vaultReadsAfterFirstTick = vi.mocked(ctx.vault.get).mock.calls.length;
    const countCallsAfterFirstTick = vi.mocked(ctx.provider.countInput).mock.calls.length;
    await runTicks(100);
    expect(vi.mocked(ctx.vault.get).mock.calls.length).toBe(vaultReadsAfterFirstTick);
    expect(vi.mocked(ctx.provider.countInput).mock.calls.length).toBe(countCallsAfterFirstTick);
    expect(ctx.provider.summarize).not.toHaveBeenCalled();
  });

  // run/daily/manager budget codes: configureManager's own save-time check always keeps the
  // saved allowance at or above the worst-case cost for a full request, so in practice these
  // only surface once shared spending or a narrower stored value leaves no room for even the
  // floor cost. Each case below builds that condition directly, then proves the floor
  // pre-check catches it before any vault read or count call, on the first tick and every
  // later one, exactly like acceptance criterion 2.
  it('run_budget_reached: a per-request allowance narrower than the floor cost makes 0 vault reads or count calls, even on the first tick', async () => {
    const ctx = setup(); openHandles.push(ctx.handle); openStores.push(ctx.store);
    await ctx.enable({ requestBudgetMicroUsd: 10_000 }); ctx.addReport('report');
    // A direct edit below the 800 floor, standing in for a saved allowance narrower than
    // today's gate would allow at save time (configureManager's own check always keeps it at
    // or above the request's worst case). The runtime floor pre-check must still catch this.
    ctx.store.commit('shrink-run-budget', state => { state.workflow!.manager.config.requestBudgetMicroUsd = 500; return 'shrink'; });
    await runTicks(1);
    expect(ctx.store.snapshot().state.workflow?.manager.waitingStatus?.code).toBe('run_budget_reached');
    expect(ctx.vault.get).not.toHaveBeenCalled();
    expect(ctx.provider.countInput).not.toHaveBeenCalled();
    await runTicks(100);
    expect(ctx.vault.get).not.toHaveBeenCalled();
    expect(ctx.provider.countInput).not.toHaveBeenCalled();
  });

  it('daily_budget_reached: prior same-day spending leaves no room for even the floor cost', async () => {
    const ctx = setup(); openHandles.push(ctx.handle); openStores.push(ctx.store);
    await ctx.enable({ dailyBudgetMicroUsd: 10_000, managerDailyBudgetMicroUsd: 10_000, requestBudgetMicroUsd: 10_000 }); ctx.addReport('report');
    injectSettledReservation(ctx, 'worker', 9_300); // leaves 700 of today's 10,000 daily budget: under the 800 floor
    await runTicks(1);
    expect(ctx.store.snapshot().state.workflow?.manager.waitingStatus?.code).toBe('daily_budget_reached');
    expect(ctx.vault.get).not.toHaveBeenCalled();
    expect(ctx.provider.countInput).not.toHaveBeenCalled();
    await runTicks(100);
    expect(ctx.vault.get).not.toHaveBeenCalled();
    expect(ctx.provider.countInput).not.toHaveBeenCalled();
  });

  it('manager_budget_reached: prior same-day manager spending leaves no room for the floor cost, though the wider daily budget still has plenty', async () => {
    const ctx = setup(); openHandles.push(ctx.handle); openStores.push(ctx.store);
    await ctx.enable({ dailyBudgetMicroUsd: 100_000, managerDailyBudgetMicroUsd: 10_000, requestBudgetMicroUsd: 10_000 }); ctx.addReport('report');
    injectSettledReservation(ctx, 'manager', 9_300); // leaves 700 of the manager-only 10,000 allowance
    await runTicks(1);
    expect(ctx.store.snapshot().state.workflow?.manager.waitingStatus?.code).toBe('manager_budget_reached');
    expect(ctx.vault.get).not.toHaveBeenCalled();
    expect(ctx.provider.countInput).not.toHaveBeenCalled();
    await runTicks(100);
    expect(ctx.vault.get).not.toHaveBeenCalled();
    expect(ctx.provider.countInput).not.toHaveBeenCalled();
  });

  it.each([
    { code: 'provider_unavailable', throwError: () => new ProviderRequestError('provider_unavailable', 'The provider could not be reached.', 'uncertain') },
    { code: 'token_count_unavailable', throwError: () => new WorkflowError('token_count_unavailable', 'The provider could not count this bounded request.', 502) },
  ])('$code is transient: it retries on a backoff schedule, not every 30 seconds and not never', async ({ code, throwError }) => {
    const ctx = setup(); openHandles.push(ctx.handle); openStores.push(ctx.store);
    await ctx.enable(); ctx.addReport('report');
    ctx.provider.countInput = vi.fn(async () => { throw throwError(); });
    await runTicks(1);
    expect(ctx.store.snapshot().state.workflow?.manager.waitingStatus?.code).toBe(code);
    expect(ctx.store.snapshot().state.workflow?.manager.waitingStatus?.retryAt).not.toBeNull();
    const callsAfterFirstTick = vi.mocked(ctx.provider.countInput).mock.calls.length;
    // Nothing should retry on the very next tick (30s is far shorter than the 1-minute start).
    await runTicks(1);
    expect(vi.mocked(ctx.provider.countInput).mock.calls.length).toBe(callsAfterFirstTick);
    // Over 50 minutes (100 ticks), a 1/2/4/8/16-minute-doubling backoff retries a handful of
    // times: never on every tick (100 more calls) and never staying stuck forever (0 more calls).
    await runTicks(99);
    const callsAfter50Minutes = vi.mocked(ctx.provider.countInput).mock.calls.length;
    expect(callsAfter50Minutes).toBeGreaterThan(callsAfterFirstTick);
    expect(callsAfter50Minutes).toBeLessThan(callsAfterFirstTick + 10);
  });

  it('classifies a 429 provider rejection as transient (a saved retryAt), unlike other rejections (sticky, no retryAt)', async () => {
    const ctx = setup(); openHandles.push(ctx.handle); openStores.push(ctx.store);
    await ctx.enable(); ctx.addReport('report');
    ctx.provider.countInput = vi.fn(async () => { throw new ProviderRequestError('provider_rejected', 'Rate limited.', 'not-billed', undefined, 429); });
    await runTicks(1);
    const waiting = ctx.store.snapshot().state.workflow?.manager.waitingStatus;
    expect(waiting?.code).toBe('provider_rejected');
    expect(waiting?.retryAt).not.toBeNull();
  });

  it('any basis change (a new report) allows exactly one new automatic check', async () => {
    const ctx = setup(); openHandles.push(ctx.handle); openStores.push(ctx.store);
    await ctx.enable(); ctx.addReport('report');
    ctx.vault.get = vi.fn(async () => null); // credential_unavailable: sticky
    await runTicks(1);
    expect(ctx.store.snapshot().state.workflow?.manager.waitingStatus?.code).toBe('credential_unavailable');
    expect(vi.mocked(ctx.vault.get).mock.calls.length).toBe(1);
    await runTicks(10);
    expect(vi.mocked(ctx.vault.get).mock.calls.length).toBe(1); // still stuck: nothing changed
    ctx.addReport('second-report'); // changes queueBasis
    await runTicks(1);
    expect(vi.mocked(ctx.vault.get).mock.calls.length).toBe(2); // exactly one new check, not a flood
  });

  it('the explicit Process action always re-checks and can succeed even mid-wait', async () => {
    const ctx = setup(); openHandles.push(ctx.handle); openStores.push(ctx.store);
    await ctx.enable(); ctx.addReport('report');
    ctx.vault.get = vi.fn(async () => null);
    await runTicks(1);
    expect(ctx.store.snapshot().state.workflow?.manager.waitingStatus?.code).toBe('credential_unavailable');
    // The automatic path stays blocked (same basis, no time passed)...
    await runTicks(1);
    expect(vi.mocked(ctx.vault.get).mock.calls.length).toBe(1);
    // ...but explicit Process bypasses the guard and re-checks immediately.
    ctx.vault.get = vi.fn(async id => ctx.secrets.get(id) ?? null);
    await ctx.service.processManager('explicit-retry');
    expect(ctx.provider.summarize).toHaveBeenCalledTimes(1);
    expect(ctx.store.snapshot().state.handoffs[0].status).toBe('processed');
  });

  it('a disabled manager makes 0 provider calls from the timer', async () => {
    const ctx = setup(); openHandles.push(ctx.handle); openStores.push(ctx.store);
    ctx.addReport('report');
    await runTicks(5);
    expect(ctx.provider.countInput).not.toHaveBeenCalled();
    expect(ctx.provider.summarize).not.toHaveBeenCalled();
    expect(ctx.vault.get).not.toHaveBeenCalled();
  });

  it('an explicit-only manager (automatic: false) makes 0 automatic calls, but Process still works', async () => {
    const ctx = setup(); openHandles.push(ctx.handle); openStores.push(ctx.store);
    await ctx.enable({ automatic: false }); ctx.addReport('report');
    await runTicks(10);
    expect(ctx.provider.countInput).not.toHaveBeenCalled();
    expect(ctx.provider.summarize).not.toHaveBeenCalled();
    await ctx.service.processManager('explicit');
    expect(ctx.provider.summarize).toHaveBeenCalledTimes(1);
  });

  it('a config saved before the automatic flag existed behaves as explicit-only, without error', async () => {
    const ctx = setup(); openHandles.push(ctx.handle); openStores.push(ctx.store);
    const config = await ctx.enable(); ctx.addReport('report');
    // Simulate a pre-existing saved config with no `automatic` key at all (not merely false).
    ctx.store.commit('simulate-legacy-config', state => { const legacy = { ...config } as Partial<ManagerConfig>; delete legacy.automatic; (state.workflow!.manager.config as ManagerConfig) = legacy as ManagerConfig; return 'legacy'; });
    await runTicks(5);
    expect(ctx.provider.countInput).not.toHaveBeenCalled();
    await ctx.service.processManager('explicit-legacy');
    expect(ctx.provider.summarize).toHaveBeenCalledTimes(1);
  });

  it('two workspaces are scheduled independently', async () => {
    // registerWorkflowApi shares one vault and one provider across every workspace it serves
    // (the credential reference itself is scoped per workspace), so this test uses one of
    // each and makes the shared vault refuse only beta's own credential reference.
    const alpha = buildFixture('workspace-alpha');
    const beta = buildFixture('workspace-beta');
    const secrets = new Map<string, string>();
    const vault: CredentialVault = { available: true, put: vi.fn(async (id, value) => { secrets.set(id, value); }),
      get: vi.fn(async id => id.includes('workspace-beta') ? null : (secrets.get(id) ?? null)), delete: vi.fn(async id => { secrets.delete(id); }) };
    const provider = alpha.provider;
    const shared = registerWorkflowApi(fakeApp, { scoped: () => alpha.store, stores: () => [alpha.store, beta.store], vault, provider });
    openHandles.push(shared); openStores.push(alpha.store, beta.store);
    const alphaService = shared.service(alpha.store), betaService = shared.service(beta.store);
    const enableOn = async (fixture: typeof alpha, service: typeof alphaService) => {
      await service.connectApi({ provider: 'openai', label: 'Account', apiKey: key }, `connection-${fixture.store.snapshot().state.workspace.id}`);
      service.configurePolicy({ paidEnabled: true, dailyBudgetMicroUsd: 1_000_000, managerDailyBudgetMicroUsd: 1_000_000, maxRunBudgetMicroUsd: 1_000_000, workerConcurrency: 1, timeZone: 'UTC' }, 'policy');
      service.configureManager({ enabled: true, connectionId: service.state().connections[0].id, model: fixture.model, maxInputTokens: 4000, maxOutputTokens: 800, requestBudgetMicroUsd: 1_000_000, automatic: true }, 'manager-config');
    };
    await enableOn(alpha, alphaService); alpha.addReport('report-alpha');
    await enableOn(beta, betaService); beta.addReport('report-beta');
    await runTicks(1);
    expect(alpha.store.snapshot().state.handoffs[0].status).toBe('processed');
    expect(beta.store.snapshot().state.handoffs[0].status).toBe('saved');
    expect(beta.store.snapshot().state.workflow?.manager.waitingStatus?.code).toBe('credential_unavailable');
  });

  it('close() clears the timer: no further ticks fire any provider call', async () => {
    const ctx = setup(); openStores.push(ctx.store);
    await ctx.enable(); ctx.addReport('report');
    await ctx.handle.close();
    await runTicks(10);
    expect(ctx.provider.countInput).not.toHaveBeenCalled();
    expect(ctx.provider.summarize).not.toHaveBeenCalled();
  });
});

// The UTC day change is deliberate here, so the behaviour is pinned instead of accidental. Each test
// starts at 23:58:40 UTC, so the 30-second ticks land at 23:59:10, 23:59:40 and 00:00:10. Pinning the
// other tests to midday must never hide a rollover bug: if the window stopped rolling over, or rolled
// over on every tick, these two fail.
describe('UTC midnight: the daily window rolls over on purpose (MG-40 guard)', () => {
  const beforeMidnight = '2026-09-24T23:58:40.000Z';

  it('daily_budget_reached: spending from the previous UTC day stops counting at 00:00, so exactly one new vault read is allowed and the report is processed', async () => {
    vi.setSystemTime(new Date(beforeMidnight));
    const ctx = setup(); openHandles.push(ctx.handle); openStores.push(ctx.store);
    await ctx.enable({ dailyBudgetMicroUsd: 10_000, managerDailyBudgetMicroUsd: 10_000, requestBudgetMicroUsd: 10_000 }); ctx.addReport('report');
    injectSettledReservation(ctx, 'worker', 9_300); // stamped with billing day 2026-09-24; leaves 700, under the 800 floor
    await runTicks(1); // 23:59:10
    expect(ctx.store.snapshot().state.workflow?.manager.waitingStatus?.code).toBe('daily_budget_reached');
    await runTicks(1); // 23:59:40, still the same UTC day
    expect(ctx.store.snapshot().state.workflow?.manager.waitingStatus?.code).toBe('daily_budget_reached');
    expect(ctx.vault.get).not.toHaveBeenCalled();
    expect(ctx.provider.countInput).not.toHaveBeenCalled();
    await runTicks(1); // 00:00:10 on 2026-09-25
    expect(billingDay(new Date().toISOString(), 'UTC')).toBe('2026-09-25');
    expect(ctx.vault.get).toHaveBeenCalledTimes(1);
    expect(ctx.provider.summarize).toHaveBeenCalledTimes(1);
    expect(ctx.store.snapshot().state.handoffs[0].status).toBe('processed');
    const spent = ctx.store.snapshot().state.workflow!.reservations.filter(reservation => reservation.purpose === 'manager');
    expect(spent.map(reservation => reservation.day)).toEqual(['2026-09-25']); // new spending is stamped with the new day
    await runTicks(10); // nothing is left to process: the rollover caused no repeated reads
    expect(ctx.vault.get).toHaveBeenCalledTimes(1);
    expect(ctx.provider.summarize).toHaveBeenCalledTimes(1);
  });

  it('credential_unavailable: a wait saved before midnight is re-checked exactly once when the UTC day changes, then holds again', async () => {
    vi.setSystemTime(new Date(beforeMidnight));
    const ctx = setup(); openHandles.push(ctx.handle); openStores.push(ctx.store);
    await ctx.enable(); ctx.addReport('report');
    ctx.vault.get = vi.fn(async () => null);
    await runTicks(1); // 23:59:10
    expect(ctx.store.snapshot().state.workflow?.manager.waitingStatus?.code).toBe('credential_unavailable');
    expect(vi.mocked(ctx.vault.get).mock.calls.length).toBe(1);
    await runTicks(1); // 23:59:40: same day, nothing changed
    expect(vi.mocked(ctx.vault.get).mock.calls.length).toBe(1);
    await runTicks(1); // 00:00:10: the day is part of the queue basis, so one new check is allowed
    expect(billingDay(new Date().toISOString(), 'UTC')).toBe('2026-09-25');
    expect(vi.mocked(ctx.vault.get).mock.calls.length).toBe(2);
    expect(ctx.store.snapshot().state.workflow?.manager.waitingStatus?.code).toBe('credential_unavailable');
    await runTicks(100); // the rest of the new day's first 50 minutes: one new check, not a flood
    expect(vi.mocked(ctx.vault.get).mock.calls.length).toBe(2);
    expect(ctx.provider.summarize).not.toHaveBeenCalled();
  });
});

describe('provider error classification (queue.ts / service.ts must agree)', () => {
  it('pins the sticky/transient class of every named manager wait code', () => {
    for (const code of MANAGER_STICKY_WAIT_CODES) expect(isTransientManagerWaitCode(code)).toBe(false);
    for (const code of MANAGER_TRANSIENT_WAIT_CODES) expect(isTransientManagerWaitCode(code)).toBe(true);
    expect(isTransientManagerWaitCode('provider_rejected', 429)).toBe(true);
    expect(isTransientManagerWaitCode('provider_rejected', 400)).toBe(false);
    expect(isTransientManagerWaitCode('provider_rejected', undefined)).toBe(false);
    expect(isManagerWaitCode('manager_no_reports')).toBe(false);
    expect(isManagerWaitCode('manager_batch_waiting')).toBe(false);
  });

  it('maps official HTTP statuses to the documented codes with the real status attached', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockRejectedValueOnce(new Error('network unreachable'));
    const adapter = new OfficialWorkflowProvider(request);
    const reviewedModel = 'gpt-5.4-mini-2026-03-17'; // a model with a reviewed compatibility profile; an unreviewed id would fail before ever reaching the request
    const connection = { id: 'c', provider: 'openai' as const, mode: 'api' as const, label: 'x', status: 'verified' as const, verifiedAt: '', createdAt: '', accountIdentity: 'unavailable' as const, models: [reviewedModel], capabilities: { manager: true, managedExecution: false } };
    const input = { model: reviewedModel, input: 'x', maxOutputTokens: 10 };
    await expect(adapter.countInput(connection, key, input)).rejects.toMatchObject({ code: 'provider_rejected', providerStatus: 429, outcome: 'not-billed' });
    await expect(adapter.countInput(connection, key, input)).rejects.toMatchObject({ code: 'provider_rejected', providerStatus: 401, outcome: 'not-billed' });
    await expect(adapter.summarize(connection, key, input)).rejects.toMatchObject({ code: 'provider_unavailable', outcome: 'uncertain' });
  });
});
