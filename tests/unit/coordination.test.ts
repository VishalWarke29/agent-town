import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { CreateRunDraft, Handoff, ManagedRun, RunnerTask, TownState, WorkflowModel } from '@agent-town/contracts';
import { buildCoordinationPlan, buildManagerInput, buildWorkerContext, initialWorkflow, taskIntentFingerprint, uniqueReports, WorkflowService, type WorkflowProvider } from '../../apps/service/src/workflow';
import { Store } from '../../apps/service/src/store';

const now = '2026-09-14T18:00:00.000Z';
const key = 'sk-fixture_coordination_credential';
function seed(): TownState {
  return { schemaVersion: 1, workspace: { id: 'coordination-fixture', name: 'Fixture', mode: 'private' }, simulation: { running: false, step: 0 },
    repositories: ['one', 'two', 'three'].map(id => ({ id, name: id, description: '', language: 'TypeScript', branch: 'main', color: '#aaa', position: [0, 0], localPath: `C:/fixture/${id}`, git: { availability: 'available', head: 'a'.repeat(40), changedFiles: 0, untrackedFiles: 0 } })),
    workflow: initialWorkflow(), runner: { schemaVersion: 1, tasks: [], runs: [], subscriptions: [], subscriptionDefault: null },
    agents: [], handoffs: [], activity: [], manager: { version: 1, brief: 'Preserve the reviewed design.', updatedAt: now } };
}
function draft(repoId = 'one', objective = 'Implement the reviewed change.'): CreateRunDraft {
  return { repoId, objective, acceptanceCriteria: ['Tests pass.', 'Existing behavior remains.'], dependencyTaskIds: [], tool: 'openai-api', connectionId: 'fixture', mode: 'api', model: 'fixture-model', price: null,
    maxTurns: 1, maxOutputTokens: 500, maxMinutes: 1, budgetMicroUsd: 10000, acknowledgeSubscriptionLimits: false };
}
function task(state: TownState, id: string, input = draft(), status: RunnerTask['status'] = 'draft'): RunnerTask {
  const result: RunnerTask = { id, draft: input, status, baseCommit: 'a'.repeat(40), contextVersion: state.manager.version, contextBrief: buildWorkerContext(state, input),
    approvalHash: 'b'.repeat(64), createdAt: now, approvedAt: null, runId: null };
  state.runner!.tasks.push(result); return result;
}
function run(state: TownState, task: RunnerTask, status: ManagedRun['status'] = 'running'): ManagedRun {
  const result: ManagedRun = { id: `run-${task.id}`, taskId: task.id, tool: task.draft.tool, connectionId: 'fixture', mode: 'api', model: 'fixture-model', price: null, status, startedAt: now, finishedAt: null,
    worktreePath: null, branch: null, contextVersion: 1, contextDelivery: 'pending', providerRequests: 0, usage: null, message: null, changedFiles: [], reportId: null };
  task.runId = result.id; state.runner!.runs.push(result); return result;
}
function report(id: string, repoId = 'one', summary = 'The worker reports a passing check.'): Handoff {
  return { id, repoId, agentId: 'fixture-agent', summary, createdAt: now, status: 'saved', contextVersion: null, delivery: 'unsupported' };
}
function previous(state: TownState) {
  state.workflow!.manager.versions.push({ version: 1, previousVersion: 0, reportIds: [], overview: state.manager.brief,
    repoBriefs: state.repositories.map(repo => ({ repoId: repo.id, brief: `Saved ${repo.id} decisions.` })), blockers: ['Keep the unresolved rollout gate.'], createdAt: now });
}

describe('deterministic coordination of saved tasks', () => {
  it('requires verified integration for changed accepted prerequisites and excludes archived drafts from suggestions', () => {
    const state = seed(), prerequisite = task(state, 'before', draft('two'), 'accepted');
    const previousRun = run(state, prerequisite, 'awaiting_review'); previousRun.changedFiles = ['source.ts'];
    const dependent = task(state, 'after', { ...draft(), dependencyTaskIds: ['before'] });
    expect(buildCoordinationPlan(state).tasks.find(value => value.taskId === 'after')?.issues).toContainEqual(expect.objectContaining({ code: 'integration-required', severity: 'block' }));
    prerequisite.integration = { commit: 'a'.repeat(40), files: ['source.ts'], verifiedAt: now };
    previousRun.sourceFingerprint = 'b'.repeat(64);
    expect(buildCoordinationPlan(state).tasks.find(value => value.taskId === 'after')?.issues).toContainEqual(expect.objectContaining({ code: 'integration-required', severity: 'block' }));
    previousRun.sourceFingerprint = `v2:${'b'.repeat(64)}`;
    dependent.contextBrief = buildWorkerContext(state, dependent.draft);
    expect(buildCoordinationPlan(state).tasks.find(value => value.taskId === 'after')?.state).toBe('reviewable');
    dependent.archivedAt = now;
    expect(buildCoordinationPlan(state).suggestedTaskIds).not.toContain('after');
    expect(buildCoordinationPlan(state).tasks.find(value => value.taskId === 'after')?.state).toBe('closed');
  });
  it('normalizes exact intent without conflating different criteria or repositories', () => {
    const original = draft();
    expect(taskIntentFingerprint(original)).toBe(taskIntentFingerprint({ ...original, objective: '  IMPLEMENT   THE reviewed change. ', acceptanceCriteria: ['EXISTING behavior remains.', 'Tests pass.', 'Tests pass.'] }));
    expect(taskIntentFingerprint({ ...original, repoId: 'two' })).not.toBe(taskIntentFingerprint(original));
    expect(taskIntentFingerprint({ ...original, acceptanceCriteria: ['Different behavior.'] })).not.toBe(taskIntentFingerprint(original));
  });

  it('suggests independent oldest drafts while flagging draft duplicates, without changing state', () => {
    const state = seed(); state.workflow!.policy.workerConcurrency = 2;
    task(state, 'first'); task(state, 'second'); task(state, 'third', draft('two'));
    const saved = JSON.stringify(state); const plan = buildCoordinationPlan(state);
    expect(plan).toMatchObject({ advisoryOnly: true, inferenceCalls: 0, capacity: { limit: 2, active: 0, available: 2 }, suggestedTaskIds: ['first', 'third'] });
    expect(plan.tasks[0].issues).toContainEqual(expect.objectContaining({ code: 'duplicate-task', severity: 'review', relatedTaskIds: ['second'] }));
    expect(JSON.stringify(state)).toBe(saved);
    expect(state.workflow!.reservations).toHaveLength(0);
  });

  it('blocks active repository overlap and duplicate work while allowing a different repository', () => {
    const state = seed(); state.workflow!.policy.workerConcurrency = 2;
    run(state, task(state, 'active', draft(), 'running'));
    task(state, 'duplicate'); task(state, 'same-repo-new-intent', draft('one', 'Implement a distinct feature.')); task(state, 'independent', draft('two'));
    let plan = buildCoordinationPlan(state);
    expect(plan.tasks.find(item => item.taskId === 'duplicate')?.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['duplicate-task', 'repository-active']));
    expect(plan.tasks.find(item => item.taskId === 'same-repo-new-intent')?.state).toBe('waiting');
    expect(plan.suggestedTaskIds).toEqual(['independent']);
    state.workflow!.policy.workerConcurrency = 1;
    plan = buildCoordinationPlan(state);
    expect(plan.suggestedTaskIds).toEqual([]);
    expect(plan.tasks.find(item => item.taskId === 'independent')?.issues).toContainEqual(expect.objectContaining({ code: 'capacity' }));
  });

  it('requires accepted prerequisites and a fresh evidence bundle, without treating acceptance as integration', () => {
    const state = seed(); previous(state);
    const prerequisite = task(state, 'before', draft('two'), 'awaiting_review');
    const previousRun = run(state, prerequisite, 'awaiting_review'); previousRun.reportId = 'before-report'; state.handoffs.push(report('before-report', 'two'));
    const dependent = task(state, 'after', { ...draft(), dependencyTaskIds: ['before'] });
    expect(buildCoordinationPlan(state).tasks.find(value => value.taskId === 'after')?.issues).toContainEqual(expect.objectContaining({ code: 'dependency-waiting' }));
    prerequisite.status = 'accepted';
    expect(buildCoordinationPlan(state).tasks.find(value => value.taskId === 'after')?.issues).toContainEqual(expect.objectContaining({ code: 'stale-context' }));
    dependent.contextBrief = buildWorkerContext(state, dependent.draft);
    expect(buildCoordinationPlan(state).tasks.find(value => value.taskId === 'after')?.state).toBe('reviewable');
    expect(dependent.contextBrief).toContain('does not prove its worktree was integrated');
    expect(JSON.parse(dependent.contextBrief).prerequisites[0]).toMatchObject({ taskId: 'before', runId: previousRun.id, reportId: 'before-report', reportEvidence: 'worker-reported' });
  });

  it('detects missing/cyclic prerequisites, stale versions, changed bases, and unavailable repositories', () => {
    const state = seed();
    task(state, 'cycle-a', { ...draft(), dependencyTaskIds: ['cycle-b'] }); task(state, 'cycle-b', { ...draft('two'), dependencyTaskIds: ['cycle-a', 'absent'] });
    const old = task(state, 'old', draft('three')); old.contextVersion = 0; old.baseCommit = 'c'.repeat(40);
    task(state, 'gone', draft('absent-repo'));
    const plan = buildCoordinationPlan(state);
    expect(plan.tasks[0].issues.map(issue => issue.code)).toContain('dependency-cycle');
    expect(plan.tasks[1].issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['dependency-cycle', 'dependency-missing']));
    expect(plan.tasks[2].issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['stale-context', 'base-changed']));
    expect(plan.tasks[3].issues.map(issue => issue.code)).toContain('repository-unavailable');
    expect(plan.suggestedTaskIds).toEqual([]);
  });

  it('separates saved path overlap and human review from verified conflicts, and permits an intentional accepted-task rerun', () => {
    const state = seed();
    const first = task(state, 'first', draft(), 'awaiting_review'); const second = task(state, 'second', draft('one', 'Another feature.'), 'awaiting_review');
    run(state, first, 'awaiting_review').changedFiles = ['src/feature.ts']; run(state, second, 'awaiting_review').changedFiles = ['src\\feature.ts'];
    expect(buildCoordinationPlan(state).tasks[0]).toMatchObject({ state: 'human-review', issues: expect.arrayContaining([expect.objectContaining({ code: 'awaiting-review' }), expect.objectContaining({ code: 'file-overlap', severity: 'review' })]) });
    first.status = 'accepted'; second.status = 'accepted'; task(state, 'intentional-rerun');
    expect(buildCoordinationPlan(state).tasks.at(-1)).toMatchObject({ state: 'reviewable', issues: [] });
  });
});

describe('bounded evidence bundles', () => {
  it('includes relevant repo/prerequisite briefs and global blockers while reusing report bodies without losing IDs', () => {
    const state = seed(); previous(state);
    const prerequisite = task(state, 'before', draft('two'), 'accepted'); run(state, prerequisite, 'awaiting_review');
    const current = task(state, 'current', { ...draft(), dependencyTaskIds: ['before'] }, 'awaiting_review'); run(state, current, 'awaiting_review').reportId = 'first';
    const reports = [report('first'), report('second'), report('third', 'one', 'A distinct worker claim.')];
    const bundle = buildManagerInput(state, reports); const input = JSON.parse(bundle.input);
    expect(input.previousRepoBriefs.map((repo: { repoId: string }) => repo.repoId)).toEqual(['one', 'two']);
    expect(input.blockers).toEqual(['Keep the unresolved rollout gate.']);
    expect(input.reports).toHaveLength(3); expect(input.reports[1]).toMatchObject({ id: 'second', summaryRef: 'first', evidence: 'worker-reported' });
    expect(input.reports[2].summary).toBe(reports[2].summary);
    expect(bundle.evidence).toMatchObject({ reportIds: ['first', 'second', 'third'], summaryBodyCount: 2, reusedSummaryCount: 1, omittedRepoBriefCount: 1, includedTaskIds: ['current', 'before'], inputBytes: Buffer.byteLength(bundle.input) });
    expect(bundle.evidence.payloadHash).toBe(createHash('sha256').update(bundle.input).digest('hex'));
    expect(bundle.input).not.toContain('Saved three decisions.');
    const crossRepo = JSON.parse(buildManagerInput(state, [report('same-one'), report('same-two', 'two')]).input);
    expect(crossRepo.reports[1].summary).toBe(crossRepo.reports[0].summary);
    expect(crossRepo.reports[1].summaryRef).toBeUndefined();
  });

  it('declares omitted task facts without dropping selected report evidence or global blockers', () => {
    const state = seed(); previous(state);
    for (let index = 0; index < 55; index++) task(state, `review-${index}`, draft(), 'awaiting_review');
    const bundle = buildManagerInput(state, [report('saved')]); const input = JSON.parse(bundle.input);
    expect(input.tasks).toHaveLength(40);
    expect(bundle.evidence).toMatchObject({ omittedTaskCount: 15, reportIds: ['saved'] });
    expect(input.reports[0].summary).toBe(report('saved').summary);
    expect(input.blockers).toEqual(['Keep the unresolved rollout gate.']);
  });

  it('keeps short repeated summaries inline when a reference costs more bytes, with actual representation counts', () => {
    const state = seed();
    const firstId = `report-${'a'.repeat(100)}`;
    const reports = [report(firstId, 'one', 'Done.'), report('second', 'one', 'Done.')];
    const bundle = buildManagerInput(state, reports); const input = JSON.parse(bundle.input);
    expect(Buffer.byteLength(JSON.stringify({ summaryRef: firstId }), 'utf8')).toBeGreaterThan(Buffer.byteLength(JSON.stringify({ summary: 'Done.' }), 'utf8'));
    expect(input.reports.map((value: { id: string; summary: string }) => ({ id: value.id, summary: value.summary }))).toEqual([{ id: firstId, summary: 'Done.' }, { id: 'second', summary: 'Done.' }]);
    expect(input.reports[1].summaryRef).toBeUndefined();
    expect(bundle.evidence).toMatchObject({ reportIds: [firstId, 'second'], summaryBodyCount: 2, reusedSummaryCount: 0, inputBytes: Buffer.byteLength(bundle.input, 'utf8') });
  });

  it('uses serialized UTF-8 size for long summary reuse and keeps equal-size representations inline', () => {
    const state = seed();
    const summary = '完了しました。'.repeat(20);
    const reports = [report('unicode-first', 'one', summary), report('unicode-second', 'one', summary), report('r', 'one', 'Done'), report('equal-second', 'one', 'Done')];
    const bundle = buildManagerInput(state, reports); const input = JSON.parse(bundle.input);
    expect(Buffer.byteLength(JSON.stringify({ summary: 'Done' }), 'utf8')).toBe(Buffer.byteLength(JSON.stringify({ summaryRef: 'r' }), 'utf8'));
    expect(input.reports[1]).toMatchObject({ id: 'unicode-second', summaryRef: 'unicode-first' });
    expect(input.reports[3]).toMatchObject({ id: 'equal-second', summary: 'Done' });
    expect(bundle.evidence).toMatchObject({ reportIds: reports.map(value => value.id), summaryBodyCount: 3, reusedSummaryCount: 1 });
    expect(bundle.evidence.summaryBodyCount + bundle.evidence.reusedSummaryCount).toBe(reports.length);
    // Two visible characters still need six UTF-8 bytes; character counts would choose incorrectly.
    const unicodeBoundary = JSON.parse(buildManagerInput(state, [report('u', 'one', '完了'), report('u-next', 'one', '完了')]).input);
    expect(unicodeBoundary.reports[1].summaryRef).toBe('u');
  });

  it('deduplicates exact report retries but rejects conflicting content for the same ID', () => {
    const saved = report('one');
    expect(uniqueReports([saved, structuredClone(saved)])).toHaveLength(1);
    expect(() => uniqueReports([saved, { ...saved, summary: 'Different claim.' }])).toThrow('Conflicting saved evidence');
  });

  it('bounds optional worker excerpts, retains every prerequisite ID and blocker, and never changes approved requirements', () => {
    const state = seed(); previous(state); state.manager.brief = 'Overview detail. '.repeat(100);
    state.workflow!.manager.versions[0].repoBriefs[0].brief = 'Repo detail. '.repeat(1000);
    const ids: string[] = [];
    for (let index = 0; index < 20; index++) {
      const item = task(state, `before-${index}`, draft('two'), 'accepted'); const savedRun = run(state, item, 'awaiting_review');
      savedRun.reportId = `report-${index}`; state.handoffs.push(report(savedRun.reportId, 'two', 'Long worker evidence. '.repeat(400))); ids.push(item.id);
    }
    const input = { ...draft(), dependencyTaskIds: ids }; const original = JSON.stringify(input);
    const context = buildWorkerContext(state, input); const parsed = JSON.parse(context);
    expect(context.length).toBeLessThanOrEqual(12000);
    expect(parsed.prerequisites.map((value: { taskId: string }) => value.taskId)).toEqual(ids);
    expect(parsed.prerequisites.every((value: { summary: { truncated: boolean } }) => value.summary.truncated)).toBe(true);
    expect(parsed.blockers).toEqual(['Keep the unresolved rollout gate.']);
    expect(parsed.workspaceOverview).toEqual({ text: state.manager.brief, originalCharacters: state.manager.brief.length, truncated: false });
    expect(JSON.stringify(input)).toBe(original);
  });

  it('keeps blockers absent from the overview and refuses a bundle whose blockers alone exceed the limit', () => {
    const state = seed(); previous(state);
    expect(JSON.parse(buildWorkerContext(state, draft())).blockers).toEqual(['Keep the unresolved rollout gate.']);
    state.workflow!.manager.versions[0].blockers = Array.from({ length: 40 }, (_, index) => `${index}: ${'B'.repeat(490)}`);
    expect(() => buildWorkerContext(state, draft())).toThrow('no blocker or workspace decision was truncated');
    state.workflow!.manager.versions[0].blockers = [];
    state.manager.brief = 'A'.repeat(12000);
    expect(() => buildWorkerContext(state, draft())).toThrow('full workspace overview');
  });

  it('redacts credentials and URL secrets before either manager or worker context is assembled', () => {
    const state = seed(); previous(state); state.manager.brief = `Saved ${key} https://user:password@example.test/path?token=secret#fragment`;
    const manager = buildManagerInput(state, [report('secret', 'one', key)], [key]).input;
    const worker = buildWorkerContext(state, draft());
    for (const input of [manager, worker]) { expect(input).not.toContain(key); expect(input).not.toContain('user:password'); expect(input).not.toContain('token=secret'); }
  });
});

const fixtures: { store: Store; service: WorkflowService }[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) { fixture.service.close(); fixture.store.close(); } });
async function managerFixture() {
  const state = seed(); previous(state);
  const store = new Store(':memory:', state);
  const provider: WorkflowProvider = { verify: vi.fn(async () => ({ models: ['fixture-model'] })), countInput: vi.fn(async () => 1000), summarize: vi.fn(async (_connection, _key, request) => {
    const input = JSON.parse(request.input) as { reports: { id: string; repoId: string }[]; blockers: string[] };
    return { complete: true, requestId: 'fixture-request', usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, source: 'provider-reported' as const },
      text: JSON.stringify({ overview: 'Updated worker claims remain unverified.', repoBriefs: [...new Set(input.reports.map(item => item.repoId))].map(repoId => ({ repoId, brief: 'Saved progress.' })), processedReportIds: input.reports.map(item => item.id), blockers: input.blockers,
        proposals: [{ repoId: 'one', title: 'Review the saved evidence.', acceptanceCriteria: ['Inspect checks.'] }] }) };
  }) };
  const service = new WorkflowService({ store, now: () => Date.parse(now), provider, vault: { available: true, put: vi.fn(), get: vi.fn(async () => key), delete: vi.fn() } });
  fixtures.push({ store, service });
  await service.connectApi({ provider: 'openai', label: 'Fixture', apiKey: key }, 'fixture-connection');
  service.configurePolicy({ paidEnabled: true, dailyBudgetMicroUsd: 1000000, managerDailyBudgetMicroUsd: 500000, maxRunBudgetMicroUsd: 100000, workerConcurrency: 1, timeZone: 'UTC' }, 'policy');
  const model: WorkflowModel = { model: 'fixture-model', contextWindowTokens: 16000, inputPerMillionMicroUsd: 1000000, outputPerMillionMicroUsd: 5000000, cachedInputPerMillionMicroUsd: 100000, cacheWritePerMillionMicroUsd: 2000000,
    priceSource: 'https://example.test/pricing', priceCheckedAt: now, qualityStatus: 'user-attested', qualityNote: 'Fixture only.' };
  service.configureManager({ enabled: true, connectionId: service.state().connections[0].id, model, maxInputTokens: 4000, maxOutputTokens: 800, requestBudgetMicroUsd: 100000 }, 'config');
  const add = (count: number, prefix = 'report') => store.commit(`add-${prefix}`, current => { for (let index = 0; index < count; index++) current.handoffs.push(report(`${prefix}-${String(index).padStart(2, '0')}`)); return 'reports.saved'; });
  return { store, service, provider, add };
}

describe('manager planning preserves paid-work boundaries', () => {
  it('saves input evidence, preserves unrelated briefs, and suppresses repeated proposals across batches', async () => {
    const { service, provider, store, add } = await managerFixture(); add(2);
    await service.processManager('batch-one');
    const first = service.state().manager;
    expect(first.jobs[0].contextEvidence).toMatchObject({ reportIds: ['report-00', 'report-01'], summaryBodyCount: 1, reusedSummaryCount: 1, inputTokens: 1000, includedRepoBriefIds: ['one'], omittedRepoBriefCount: 2 });
    expect(first.versions.at(-1)?.repoBriefs.find(repo => repo.repoId === 'three')?.brief).toBe('Saved three decisions.');
    expect(first.versions.at(-1)?.blockers).toEqual(['Keep the unresolved rollout gate.']);
    add(1, 'next'); await service.processManager('batch-two');
    expect(service.state().manager.proposals).toHaveLength(1);
    expect(service.state().manager.jobs[1].duplicateProposalsSkipped).toBe(1);
    expect(provider.summarize).toHaveBeenCalledTimes(2);
    expect(store.snapshot().state.runner?.tasks).toHaveLength(0);
  });

  it('shrinks an ordered batch to fit the remaining saved budget before sending one inference request', async () => {
    const { service, provider, add } = await managerFixture(); add(20);
    provider.countInput = vi.fn(async (_connection, _key, request) => JSON.parse(request.input).reports.length * 100);
    service.configurePolicy({ ...service.state().policy, dailyBudgetMicroUsd: 6000, managerDailyBudgetMicroUsd: 6000 }, 'smaller-remaining-budget');
    await service.processManager('bounded-batch');
    expect(provider.countInput).toHaveBeenCalledTimes(2); expect(provider.summarize).toHaveBeenCalledOnce();
    expect(service.state().manager.jobs[0].reportIds).toEqual(Array.from({ length: 10 }, (_, index) => `report-${String(index).padStart(2, '0')}`));
    expect(service.state().reservations[0].amountMicroUsd).toBe(6000);
    expect(service.state().manager.queueReportIds).toHaveLength(10);
  });

  it('uses at most five counts, keeps oversized evidence queued, and starts no inference or reservation', async () => {
    const { service, provider, store, add } = await managerFixture(); add(20);
    const sizes: number[] = []; provider.countInput = vi.fn(async (_connection, _key, request) => { sizes.push(JSON.parse(request.input).reports.length); return 99999; });
    await expect(service.processManager('oversized')).rejects.toMatchObject({ code: 'manager_input_large' });
    expect(sizes).toEqual([20, 10, 5, 2, 1]); expect(provider.summarize).not.toHaveBeenCalled();
    expect(service.state().reservations).toHaveLength(0); expect(service.state().manager.jobs).toHaveLength(0);
    expect(store.snapshot().state.handoffs.every(item => item.status === 'saved')).toBe(true);
  });

  it('rechecks live budget atomically after counting, so a racing policy change cannot authorize spending', async () => {
    const { service, provider, add } = await managerFixture(); add(1);
    provider.countInput = vi.fn(async () => { service.configurePolicy({ ...service.state().policy, dailyBudgetMicroUsd: 1, managerDailyBudgetMicroUsd: 1 }, 'racing-budget'); return 1000; });
    await expect(service.processManager('race')).rejects.toMatchObject({ code: 'daily_budget_reached' });
    expect(service.state().reservations).toHaveLength(0); expect(provider.summarize).not.toHaveBeenCalled();
  });

  it('rejects a report changed during counting before a paid request can use stale evidence', async () => {
    const { service, provider, store, add } = await managerFixture(); add(1);
    provider.countInput = vi.fn(async () => { store.commit('changed-report', current => { current.handoffs[0].summary = 'The evidence changed.'; return 'report.changed'; }); return 1000; });
    await expect(service.processManager('changed-evidence')).rejects.toMatchObject({ code: 'manager_reports_changed' });
    expect(service.state().reservations).toHaveLength(0); expect(provider.summarize).not.toHaveBeenCalled();
    expect(store.snapshot().state.handoffs[0].status).toBe('saved');
  });
});
