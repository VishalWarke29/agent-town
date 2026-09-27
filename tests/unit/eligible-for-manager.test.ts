import { describe, expect, it } from 'vitest';
import type { Handoff, TownState, WorkspaceSummary } from '@agent-town/contracts';
import { privateState } from '../../apps/service/src/workspaces';
import { eligibleForManager } from '../../apps/service/src/workflow/budget';

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
