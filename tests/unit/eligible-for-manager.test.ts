import { describe, expect, it } from 'vitest';
import type { Handoff, ManagerJob, Repository, TownState, WorkspaceSummary } from '@agent-town/contracts';
import { privateState } from '../../apps/service/src/workspaces';
import { eligibleForManager, managerEligibility } from '../../apps/service/src/workflow/budget';

// H0-13 (Stop watching, plan v5): while automatic manager processing is on, the final drain
// saves a connection's last reports but holds them out of the automatic queue (D47's default).
// eligibleForManager is the single predicate queueManagerReports and managerQueueStatus both
// read, so this is the one place the hold has to take effect for it to mean anything.
describe('eligibleForManager: D47 hold (H0-13)', () => {
  const workspace: WorkspaceSummary = { id: 'w1', name: 'w', kind: 'personal' };
  const report = (id: string, overrides: Partial<Handoff> = {}): Handoff => ({
    id, repoId: 'r1', agentId: 'agent', summary: 'x', createdAt: '2026-09-25T00:00:00.000Z',
    status: 'saved', contextVersion: null, delivery: 'unsupported', ...overrides,
  });
  const stateWithHeld = (heldIds: string[]): TownState => {
    const state = privateState(workspace);
    return { ...state, observation: { ...(state.observation ?? {}), heldFromManagerReportIds: heldIds } } as TownState;
  };

  it('excludes a report whose id is in heldFromManagerReportIds', () => {
    const state = stateWithHeld(['h1']);
    expect(eligibleForManager(report('h1'), state)).toBe(false);
  });

  it('still admits a saved report whose id is not held', () => {
    const state = stateWithHeld(['other-id']);
    expect(eligibleForManager(report('h1'), state)).toBe(true);
  });

  it('admits every report when observation.heldFromManagerReportIds is absent (no Watch connection yet)', () => {
    const state = privateState(workspace);
    expect(state.observation).toBeUndefined();
    expect(eligibleForManager(report('h1'), state)).toBe(true);
  });

  it('admits every report when the held list is empty', () => {
    const state = stateWithHeld([]);
    expect(eligibleForManager(report('h1'), state)).toBe(true);
  });

  it('the held check does not override the existing saved-status and baseline rules', () => {
    const state = stateWithHeld(['h1']);
    expect(eligibleForManager(report('h1', { status: 'processed' }), state)).toBe(false);
  });
});

// MG-42: eligibleForManager and managerEligibility must never disagree about a 'saved' report,
// across every exclusion reason managerEligibility knows about, EXCEPT 'already-processing' —
// an additive gate eligibleForManager has never covered and must keep not covering (queue.ts /
// service.ts layer it on top separately; see budget.ts's own docs on the two functions).
describe('managerEligibility: never disagrees with eligibleForManager (MG-42)', () => {
  const workspace: WorkspaceSummary = { id: 'w2', name: 'w', kind: 'personal' };
  const repo: Repository = { id: 'r1', name: 'Repo', description: '', language: '', branch: 'main', color: '#abc', position: [0, 0] };
  const report = (id: string, overrides: Partial<Handoff> = {}): Handoff => ({
    id, repoId: 'r1', agentId: 'agent', summary: 'x', createdAt: '2026-09-25T00:00:00.000Z',
    status: 'saved', contextVersion: null, delivery: 'unsupported', ...overrides,
  });
  const job = (id: string, reportIds: string[], status: ManagerJob['status']): ManagerJob => ({
    id, reportIds, connectionId: 'connection', model: 'fixture-model', reservationId: id,
    status, automatic: false, startedAt: '2026-09-25T00:00:00.000Z', completedAt: null, message: null,
  });
  const baseState = (overrides: Partial<TownState> = {}): TownState => ({ ...privateState(workspace), repositories: [repo], ...overrides });

  it('neither excluded: eligible in both, with an empty excluded list', () => {
    const state = baseState();
    const r = report('neither');
    expect(eligibleForManager(r, state)).toBe(true);
    const result = managerEligibility({ ...state, handoffs: [r] });
    expect(result.eligibleIds).toEqual(['neither']);
    expect(result.excluded).toEqual([]);
  });

  it('held-after-stop only: both agree it is excluded, with the right reason', () => {
    const state = baseState({ observation: { heldFromManagerReportIds: ['held'] } as TownState['observation'] });
    const r = report('held');
    expect(eligibleForManager(r, state)).toBe(false);
    const result = managerEligibility({ ...state, handoffs: [r] });
    expect(result.eligibleIds).toEqual([]);
    expect(result.excluded).toEqual([{ id: 'held', reason: 'held-after-stop' }]);
  });

  it('older-than-baseline only: both agree it is excluded, with the right reason', () => {
    const state = baseState({ workflow: { ...privateState(workspace).workflow!, manager: { ...privateState(workspace).workflow!.manager, baselineAt: '2026-09-26T00:00:00.000Z' } } });
    const r = report('old');
    expect(eligibleForManager(r, state)).toBe(false);
    const result = managerEligibility({ ...state, handoffs: [r] });
    expect(result.eligibleIds).toEqual([]);
    expect(result.excluded).toEqual([{ id: 'old', reason: 'older-than-baseline' }]);
  });

  it('both held and older-than-baseline: eligibleForManager\'s own check order (baseline first) decides the single reported reason', () => {
    const state = baseState({
      workflow: { ...privateState(workspace).workflow!, manager: { ...privateState(workspace).workflow!.manager, baselineAt: '2026-09-26T00:00:00.000Z' } },
      observation: { heldFromManagerReportIds: ['both'] } as TownState['observation'],
    });
    const r = report('both');
    expect(eligibleForManager(r, state)).toBe(false);
    const result = managerEligibility({ ...state, handoffs: [r] });
    expect(result.eligibleIds).toEqual([]);
    expect(result.excluded).toEqual([{ id: 'both', reason: 'older-than-baseline' }]);
  });

  it('wrong-scope (repository no longer connected): eligibleForManager still admits it (a check it has never covered), but managerEligibility excludes it', () => {
    const state = baseState({ repositories: [] });
    const r = report('orphaned');
    expect(eligibleForManager(r, state)).toBe(true);
    const result = managerEligibility({ ...state, handoffs: [r] });
    expect(result.eligibleIds).toEqual([]);
    expect(result.excluded).toEqual([{ id: 'orphaned', reason: 'wrong-scope' }]);
  });

  it.each(['running', 'uncertain', 'processed'] as const)('already-processing (job status %s): eligibleForManager still admits it (an additive gate it has never covered), but managerEligibility excludes it', status => {
    const state = baseState({ workflow: { ...privateState(workspace).workflow!, manager: { ...privateState(workspace).workflow!.manager, jobs: [job('job-1', ['claimed'], status)] } } });
    const r = report('claimed');
    expect(eligibleForManager(r, state)).toBe(true);
    const result = managerEligibility({ ...state, handoffs: [r] });
    expect(result.eligibleIds).toEqual([]);
    expect(result.excluded).toEqual([{ id: 'claimed', reason: 'already-processing' }]);
  });

  it('a failed job does NOT count as already-processing: the report stays eligible in both (retry is a separate, explicit concern)', () => {
    const state = baseState({ workflow: { ...privateState(workspace).workflow!, manager: { ...privateState(workspace).workflow!.manager, jobs: [job('job-1', ['retryable'], 'failed')] } } });
    const r = report('retryable');
    expect(eligibleForManager(r, state)).toBe(true);
    const result = managerEligibility({ ...state, handoffs: [r] });
    expect(result.eligibleIds).toEqual(['retryable']);
    expect(result.excluded).toEqual([]);
  });

  it('a mixed batch: eligibleIds and excluded partition every saved report exactly once, agreeing with eligibleForManager on every id except the already-processing one', () => {
    const state = baseState({
      workflow: { ...privateState(workspace).workflow!, manager: { ...privateState(workspace).workflow!.manager, baselineAt: '2026-09-26T00:00:00.000Z', jobs: [job('job-1', ['claimed'], 'running')] } },
      observation: { heldFromManagerReportIds: ['held'] } as TownState['observation'],
    });
    const handoffs = [
      report('neither', { createdAt: '2026-09-27T00:00:00.000Z' }),
      report('held', { createdAt: '2026-09-27T00:00:00.000Z' }),
      report('old', { createdAt: '2026-09-25T00:00:00.000Z' }),
      report('claimed', { createdAt: '2026-09-27T00:00:00.000Z' }),
      report('orphaned', { createdAt: '2026-09-27T00:00:00.000Z', repoId: 'missing-repo' }),
      report('not-saved', { status: 'processed' }),
    ];
    const full = { ...state, handoffs };
    const result = managerEligibility(full);
    expect(result.eligibleIds.sort()).toEqual(['neither']);
    expect(new Map(result.excluded.map(item => [item.id, item.reason]))).toEqual(new Map([
      ['held', 'held-after-stop'], ['old', 'older-than-baseline'], ['claimed', 'already-processing'], ['orphaned', 'wrong-scope'],
    ]));
    for (const r of handoffs) {
      if (r.status !== 'saved') continue;
      const eligible = eligibleForManager(r, full);
      const excludedReason = result.excluded.find(item => item.id === r.id)?.reason;
      if (excludedReason === 'already-processing' || excludedReason === 'wrong-scope') expect(eligible).toBe(true); // additive-only reasons
      else expect(eligible).toBe(result.eligibleIds.includes(r.id));
    }
  });
});
