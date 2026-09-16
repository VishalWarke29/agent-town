import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunDraftSchema, type TownState, type WorkflowModel, type WorkflowUsage } from '@agent-town/contracts';
import { Store } from '../../apps/service/src/store';
import { WorkflowService, type WorkflowProvider } from '../../apps/service/src/workflow';
import { initialWorkflow } from '../../apps/service/src/workflow/budget';
import { buildManagerInput, buildWorkerContext } from '../../apps/service/src/workflow/context';
import { managerQueueStatus, queueBasis } from '../../apps/service/src/workflow/queue';

const closing: { store: Store; service: WorkflowService }[] = [];
afterEach(() => { for (const fixture of closing.splice(0)) { fixture.service.close(); fixture.store.close(); } });
function setup() {
  let now = Date.now(); const time = () => new Date(now).toISOString();
  const model: WorkflowModel = { model: 'fixture', contextWindowTokens: 16000, inputPerMillionMicroUsd: 1000000, outputPerMillionMicroUsd: 5000000,
    cachedInputPerMillionMicroUsd: 100000, cacheWritePerMillionMicroUsd: 1000000, priceSource: 'https://example.test/prices', priceCheckedAt: time(), qualityStatus: 'user-attested', qualityNote: 'Fixture only.' };
  const workflow = initialWorkflow();
  workflow.connections.push({ id: 'connection', provider: 'openai', mode: 'api', label: 'Fixture', status: 'verified', accountIdentity: 'unavailable', verifiedAt: time(), createdAt: time(), models: ['fixture'], capabilities: { manager: true, managedExecution: true } });
  workflow.policy = { ...workflow.policy, paidEnabled: true, dailyBudgetMicroUsd: 1000000, maxRunBudgetMicroUsd: 100000, managerDailyBudgetMicroUsd: 100000 };
  workflow.manager.config = { enabled: true, connectionId: 'connection', model, maxInputTokens: 4000, maxOutputTokens: 800, requestBudgetMicroUsd: 100000 };
  const state: TownState = { schemaVersion: 1, workspace: { mode: 'private', id: 'memory-workspace', name: 'Fixture' }, workflow,
    repositories: [{ id: 'repo', name: 'Fixture', branch: 'main', description: '', language: '', color: '#abc', position: [0, 0] }],
    agents: [], handoffs: [], activity: [], simulation: { running: false, step: 0 }, manager: { version: 0, brief: 'Keep the original objective.', updatedAt: null } };
  const store = new Store(':memory:', state);
  const usage: WorkflowUsage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, source: 'provider-reported' };
  let blockers: string[] | undefined;
  const provider: WorkflowProvider = { verify: vi.fn(async () => ({ models: ['fixture'] })), countInput: vi.fn(async () => 100), summarize: vi.fn(async (_connection, _key, request) => {
    const input = JSON.parse(request.input);
    return { requestId: 'fixture-response', complete: true, usage, text: JSON.stringify({ overview: 'Shorter summary.', repoBriefs: [{ repoId: 'repo', brief: 'Progress.' }], processedReportIds: input.reports.map((report: { id: string }) => report.id), blockers: blockers ?? input.blockers, proposals: [] }) };
  }) };
  const vault = { available: true, put: vi.fn(), delete: vi.fn(), get: vi.fn(async () => 'fixture-key') };
  const service = new WorkflowService({ store, vault, provider, now: () => now }); closing.push({ store, service });
  const addReport = (id: string, summary = 'Independent worker claim.') => store.commit(`report-${id}`, current => { current.handoffs.push({ id, repoId: 'repo', agentId: 'external', summary, createdAt: new Date(now - 40000).toISOString(), status: 'saved', contextVersion: null, delivery: 'unsupported' }); return 'handoff.saved'; });
  const owner = (text: string, id = `owner-${store.snapshot().cursor}`) => service.updateMemory({ action: 'accept-decision', expectedVersion: store.snapshot().state.manager.version, text, repoId: null, sourceReportIds: [] }, id);
  const draft = createRunDraftSchema.parse({ repoId: 'repo', tool: 'openai-api', mode: 'api', connectionId: 'connection', model: model.model, price: model, objective: 'Inspect the source changes.', acceptanceCriteria: ['Evidence reviewed.'], maxTurns: 1, maxOutputTokens: 256, maxMinutes: 1, budgetMicroUsd: 100000 });
  return { store, service, provider, vault, model, draft, addReport, owner, time, advance: (ms: number) => { now += ms; }, outputBlockers: (value: string[] | undefined) => { blockers = value; } };
}

describe('immutable owner memory and context evidence', () => {
  it('preserves accepted decisions through a shorter paid-fixture summary and retains old versions unchanged', async () => {
    const { service, store, owner, addReport, provider, draft } = setup();
    owner('Preserve backward compatibility.'); const before = structuredClone(service.state().manager.versions[0]);
    addReport('claim-one', 'A conflicting worker says compatibility can be removed.');
    await service.processManager('fixture-summary');
    expect(service.state().manager.versions[0]).toEqual(before);
    const latest = service.state().manager.versions.at(-1)!;
    expect(latest.overview).toBe('Shorter summary.'); expect(latest.decisions).toEqual(before.decisions);
    const request = vi.mocked(provider.summarize).mock.calls[0][2];
    expect(JSON.parse(request.input).acceptedDecisions[0].text).toBe('Preserve backward compatibility.');
    expect(store.snapshot().state.handoffs[0].summary).toContain('conflicting worker');
    expect(JSON.parse(buildWorkerContext(store.snapshot().state, draft)).acceptedDecisions[0].text).toBe('Preserve backward compatibility.');
  });

  it('resolves and reopens blockers only through versioned owner actions with reason history', async () => {
    const { service, store, addReport, provider, draft } = setup();
    service.updateMemory({ action: 'open-blocker', expectedVersion: 0, text: 'Missing login evidence.', repoId: 'repo', sourceReportIds: [] }, 'open');
    const initial = structuredClone(service.state().manager.versions[0]), id = initial.blockerRecords![0].id;
    service.updateMemory({ action: 'resolve-blocker', expectedVersion: 1, recordId: id, reason: 'Owner reviewed the retained test output.' }, 'resolve');
    addReport('resolved-report'); await service.processManager('after-resolution');
    expect(JSON.parse(vi.mocked(provider.summarize).mock.calls[0][2].input).blockers).toEqual([]);
    const workerContext = JSON.parse(buildWorkerContext(store.snapshot().state, draft));
    expect(workerContext.blockers).toEqual([]); expect(workerContext.resolvedBlockers[0]).toMatchObject({ id, status: 'resolved', resolvedVersion: 2 });
    expect(workerContext.blockerStatusPolicy).toContain('authoritative over older summary prose');
    expect(service.state().manager.versions.at(-1)?.blockerRecords?.[0]).toMatchObject({ status: 'resolved', history: [{ action: 'resolved', reason: 'Owner reviewed the retained test output.', version: 2 }] });
    service.updateMemory({ action: 'reopen-blocker', expectedVersion: 3, recordId: id, reason: 'New contradictory evidence arrived.' }, 'reopen');
    expect(service.state().manager.versions[0]).toEqual(initial);
    expect(service.state().manager.versions.at(-1)?.blockers).toEqual(['Missing login evidence.']);
    expect(service.state().manager.versions.at(-1)?.blockerRecords?.[0].history).toHaveLength(2);
    expect(store.snapshot().state.manager.version).toBe(4);
  });

  it('rejects a model that erases an open blocker or resurrects an owner-resolved one', async () => {
    const { service, addReport, outputBlockers } = setup();
    service.updateMemory({ action: 'open-blocker', expectedVersion: 0, text: 'Missing evidence.', repoId: null, sourceReportIds: [] }, 'open');
    addReport('one'); outputBlockers([]);
    await expect(service.processManager('bad-omit')).rejects.toMatchObject({ code: 'manager_blockers_missing' });
    expect(service.state().manager.versions).toHaveLength(1);
    service.updateMemory({ action: 'resolve-blocker', expectedVersion: 1, recordId: service.state().manager.versions[0].blockerRecords![0].id, reason: 'Owner verified.' }, 'resolve');
    outputBlockers(['Missing evidence.']);
    await expect(service.processManager('bad-reopen')).rejects.toMatchObject({ code: 'manager_blocker_resolved' });
    expect(service.state().manager.versions).toHaveLength(2); expect(service.state().manager.versions[1].blockers).toEqual([]);
  });

  it('checks owner scope, stale versions, action deduplication and explicit supersession without inference', () => {
    const { service, provider, owner } = setup();
    const action = { action: 'accept-decision', expectedVersion: 0, text: 'Keep interfaces stable.', repoId: null, sourceReportIds: [] };
    service.updateMemory(action, 'idempotent-owner'); expect(service.updateMemory(action, 'idempotent-owner').duplicate).toBe(true);
    expect(() => service.updateMemory({ ...action, text: 'Different content.' }, 'idempotent-owner')).toThrow();
    expect(() => service.updateMemory(action, 'stale')).toThrow('context changed');
    expect(() => service.updateMemory({ ...action, expectedVersion: 1, repoId: 'other-workspace' }, 'wrong-repo')).toThrow('repository in this workspace');
    expect(() => service.updateMemory({ ...action, expectedVersion: 1, sourceReportIds: ['unknown-report'] }, 'wrong-evidence')).toThrow('existing source reports');
    const decision = service.state().manager.versions[0].decisions![0];
    service.updateMemory({ action: 'supersede-decision', expectedVersion: 1, recordId: decision.id, reason: 'Owner approved a replacement design.' }, 'supersede');
    owner('Use the reviewed replacement interface.');
    expect(service.state().manager.versions[0].decisions![0].superseded).toBeUndefined();
    expect(service.state().manager.versions.at(-1)?.decisions).toHaveLength(2);
    expect(provider.countInput).not.toHaveBeenCalled(); expect(provider.summarize).not.toHaveBeenCalled();
  });

  it('normalizes legacy blocker provenance and keeps used context separate from processed context', () => {
    const { service, store, addReport, time } = setup();
    store.commit('legacy', state => { state.manager.version = 1; state.workflow!.manager.versions.push({ version: 1, previousVersion: 0, overview: state.manager.brief, repoBriefs: [], blockers: ['Older blocker.'], createdAt: time(), reportIds: [] }); return 'fixture'; });
    const view = service.contextHistory(); expect(view.versions[0].blockerRecords[0]).toMatchObject({ origin: 'legacy-context', sourceContextVersion: 1, sourceReportIds: [] });
    addReport('structured');
    store.commit('details', state => { state.handoffs[0].details = { outcome: 'failed', taskId: 'task', runId: 'run', sourceEventId: 'run:finished', occurredAt: time(), contextVersionUsed: 1, baseCommit: null, branch: null, worktreePath: 'PRIVATE_PATH', files: { status: 'unavailable', paths: [] }, checks: [{ name: 'npm test', result: 'unavailable', evidence: 'unavailable', reference: null }], decisions: [], assumptions: [], remainingWork: [], evidenceRefs: ['run:finished'], limitations: ['Checks unavailable.'] }; return 'fixture'; });
    const bundle = buildManagerInput(store.snapshot().state, store.snapshot().state.handoffs);
    expect(JSON.parse(bundle.input).reports[0]).toMatchObject({ outcome: 'failed', contextVersionUsed: 1, checks: [{ result: 'unavailable' }] });
    expect(bundle.input).not.toContain('PRIVATE_PATH');
  });

  it('fails closed when accepted decisions alone exceed worker context instead of trimming requirements', () => {
    const { owner, store, draft, provider } = setup();
    for (let index = 0; index < 14; index++) owner(`${index}: ${'Required compatibility constraint. '.repeat(25)}`);
    expect(() => buildWorkerContext(store.snapshot().state, draft)).toThrow('no blocker or workspace decision was truncated');
    expect(provider.summarize).not.toHaveBeenCalled();
  });
});

describe('zero-inference manager queue explanations', () => {
  it('explains disabled, unavailable, stale-price and exhausted-budget states without provider calls', () => {
    const { store, service, addReport, provider, time } = setup(); addReport('queued');
    const state = store.snapshot().state;
    expect(managerQueueStatus(state, time()).state).toBe('ready');
    state.workflow!.manager.config.enabled = false; expect(managerQueueStatus(state, time()).code).toBe('manager_disabled');
    state.workflow!.manager.config.enabled = true; state.workflow!.connections[0].status = 'disconnected'; expect(managerQueueStatus(state, time()).code).toBe('connection_unavailable');
    state.workflow!.connections[0].status = 'verified'; state.workflow!.manager.config.model!.priceCheckedAt = '2020-01-01T00:00:00.000Z'; expect(managerQueueStatus(state, time()).code).toBe('price_stale');
    state.workflow!.manager.config.model!.priceCheckedAt = time(); state.workflow!.policy.managerDailyBudgetMicroUsd = 1; expect(managerQueueStatus(state, time()).code).toBe('manager_budget_reached');
    service.refreshQueueStatus(); const cursor = store.snapshot().cursor; service.refreshQueueStatus(); expect(store.snapshot().cursor).toBe(cursor);
    expect(provider.countInput).not.toHaveBeenCalled(); expect(provider.summarize).not.toHaveBeenCalled();
  });

  it('persists an oversized counted request before inference and clears its explanation when limits change', async () => {
    const { service, store, addReport, provider } = setup(); addReport('too-large');
    provider.countInput = vi.fn(async () => 4500);
    await expect(service.processManager('blocked-count')).rejects.toMatchObject({ code: 'manager_input_large' });
    expect(store.snapshot().state.workflow!.manager.waitingStatus).toMatchObject({ state: 'waiting', code: 'manager_input_large', reportIds: ['too-large'], inferenceCalls: 0 });
    expect(service.queueStatus().code).toBe('manager_input_large'); expect(provider.summarize).not.toHaveBeenCalled();
    await expect(service.processManager('unchanged-automatic', { automatic: true })).rejects.toMatchObject({ code: 'manager_input_large' });
    expect(provider.countInput).toHaveBeenCalledTimes(1);
    await expect(service.processManager('explicit-retry')).rejects.toMatchObject({ code: 'manager_input_large' });
    expect(provider.countInput).toHaveBeenCalledTimes(2);
    expect(service.state().reservations).toEqual([]); expect(service.state().manager.jobs).toEqual([]);
    service.configureManager({ ...service.state().manager.config, enabled: false }, 'pause');
    expect(service.queueStatus().code).toBe('manager_disabled');
  });

  it('lets batch windows expire and treats worker dependency waits separately from manager reports', () => {
    const { store, service, addReport, draft, time, advance, provider } = setup(); addReport('queued');
    store.commit('waiting-worker', state => { state.runner = { schemaVersion: 1, tasks: [{ id: 'waiting-task', draft: { ...draft, dependencyTaskIds: ['unaccepted-task'] }, baseCommit: 'a'.repeat(40), contextVersion: 0, contextBrief: '', approvalHash: 'b'.repeat(64), status: 'draft', createdAt: time(), approvedAt: null, runId: null }], runs: [], subscriptions: [], subscriptionDefault: null }; state.handoffs[0].createdAt = time(); return 'fixture'; });
    expect(service.queueStatus().code).toBe('manager_batch_waiting'); advance(31000);
    expect(service.queueStatus().state).toBe('ready'); expect(provider.summarize).not.toHaveBeenCalled();
    const priorBasis = queueBasis(store.snapshot().state, time());
    const ready = service.queueStatus();
    store.commit('saved-count-bound', state => { state.workflow!.manager.waitingStatus = { ...ready, state: 'waiting', code: 'manager_input_large', message: 'Previous task facts did not fit.', basisHash: priorBasis }; return 'fixture'; });
    expect(service.queueStatus().code).toBe('manager_input_large');
    store.commit('prerequisite-status', state => { state.runner!.tasks[0].status = 'accepted'; return 'fixture'; });
    expect(service.queueStatus().state).toBe('ready');
  });

  it('returns the exact pinned initial context without implying delivery of newer versions', () => {
    const { store, service, draft, owner, time } = setup();
    store.commit('delivery', state => { state.runner = { schemaVersion: 1, subscriptions: [], subscriptionDefault: null, tasks: [{ id: 'task', draft, baseCommit: 'a'.repeat(40), contextVersion: 0, contextBrief: 'Pinned initial approved context.', approvalHash: 'b'.repeat(64), status: 'running', createdAt: time(), approvedAt: time(), runId: 'run' }], runs: [{ id: 'run', taskId: 'task', tool: draft.tool, connectionId: draft.connectionId, mode: draft.mode, model: draft.model, price: draft.price, status: 'running', startedAt: time(), finishedAt: null, worktreePath: null, branch: null, contextVersion: 0, contextDelivery: 'provider-acknowledged', providerRequests: 1, usage: null, message: null, changedFiles: [], reportId: null }] }; return 'fixture'; });
    owner('New owner decision.');
    expect(service.contextHistory().deliveries).toEqual([{ runId: 'run', taskId: 'task', approvedContextVersion: 0, status: 'provider-acknowledged', boundary: 'initial-request', contextBrief: 'Pinned initial approved context.', newerContextDelivery: 'unsupported' }]);
  });
});
