import { describe, expect, it } from 'vitest';
import type { Repository } from '@agent-town/contracts';
import { privateState } from '../../apps/service/src/workspaces';
import { markLocalAttemptIncomplete, reconcileGitHubDiscovery, reconcileLocalDiscovery } from '../../apps/service/src/repository-state';

const before = '2026-09-14T10:00:00Z', now = '2026-09-14T12:00:00Z';
const local = (id = 'local-one'): Repository => ({ id, name: id, description: 'Fixture', language: 'Unavailable', branch: 'main', color: '#ffffff', position: [7, 8], source: 'local', localPath: `C:\\fixtures\\${id}`, selectedRoot: 'C:\\fixtures', scan: { at: before, coverage: 'complete', reasons: [] }, git: { availability: 'available', head: 'a'.repeat(40), changedFiles: 1, untrackedFiles: null }, instructions: [] });
const remote = (id = 'github-one'): Repository => ({ ...local(id), source: 'github', localPath: undefined, selectedRoot: undefined, git: undefined, githubUrl: 'https://github.com/fixture/project' });
const state = () => privateState({ id: 'fixture-workspace', name: 'Fixture', kind: 'personal' });
const summary = (partial = false) => ({ checkedAt: now, status: partial ? 'partial' as const : 'complete' as const, installationCount: 1, installationTotal: 1, repositoryTotal: 1, receivedCount: 1, reasons: partial ? ['deadline'] : [] });

describe('repository refresh evidence', () => {
  it('marks unseen local records stale on partial/cancelled scans and preserves successful time and remote state', () => {
    const current = state(); current.repositories = [local(), remote()]; current.discovery!.candidates = [...current.repositories, local('unselected')];
    const remoteBefore = structuredClone(current.repositories[1]);
    reconcileLocalDiscovery(current, [], now, true, ['entry-limit']);
    expect(current.repositories[0]).toMatchObject({ branch: 'main', position: [7, 8], git: { availability: 'unavailable', head: null, changedFiles: null }, discoveryStatus: { state: 'stale', checkedAt: now, lastVerifiedAt: before, reasons: ['entry-limit'] } });
    expect(current.repositories[1]).toEqual(remoteBefore);
    expect(current.discovery!.candidates.find(repo => repo.id === 'unselected')?.discoveryStatus?.state).toBe('stale');
    markLocalAttemptIncomplete(current, '2026-09-14T13:00:00Z', ['cancelled']);
    expect(current.repositories[0]?.discoveryStatus?.lastVerifiedAt).toBe(before);
    expect(current.repositories[1]).toEqual(remoteBefore);
  });

  it('complete absence preserves a selected record as unavailable, removes unselected absence and recovers in place', () => {
    const current = state(); current.repositories = [local()]; current.discovery!.candidates = [local(), local('old-candidate')];
    reconcileLocalDiscovery(current, [], now, false, []);
    expect(current.repositories[0]?.discoveryStatus).toMatchObject({ state: 'unavailable', lastVerifiedAt: before });
    expect(current.discovery!.candidates.some(repo => repo.id === 'old-candidate')).toBe(false);
    reconcileLocalDiscovery(current, [{ ...local(), branch: 'renamed', position: [99, 99] }], now, false, []);
    expect(current.repositories[0]).toMatchObject({ branch: 'renamed', position: [7, 8], discoveryStatus: { state: 'current', lastVerifiedAt: now } });
  });

  it('updates selected GitHub renames, retains revoked history and distinguishes partial access from confirmed absence', () => {
    const current = state(); current.repositories = [remote()]; current.discovery!.candidates = [remote()];
    reconcileGitHubDiscovery(current, [{ ...remote(), name: 'fixture/renamed', branch: 'develop', position: [99, 99] }], summary());
    expect(current.repositories[0]).toMatchObject({ name: 'fixture/renamed', branch: 'develop', position: [7, 8], discoveryStatus: { state: 'current' } });
    reconcileGitHubDiscovery(current, [], { ...summary(true), receivedCount: 0 });
    expect(current.repositories[0]).toMatchObject({ name: 'fixture/renamed', discoveryStatus: { state: 'stale', lastVerifiedAt: now } });
    reconcileGitHubDiscovery(current, [], { ...summary(), receivedCount: 0, repositoryTotal: 0 });
    expect(current.repositories[0]?.discoveryStatus?.state).toBe('unavailable');
    reconcileGitHubDiscovery(current, [remote()], summary());
    expect(current.repositories[0]?.discoveryStatus?.state).toBe('current');
  });

  it('reports received versus retained counts under combined limits and always preserves selected remote records', () => {
    const current = state(); current.repositories = [remote('github-249')];
    current.discovery!.candidates = Array.from({ length: 100 }, (_, index) => local(`local-${index}`));
    const incoming = Array.from({ length: 250 }, (_, index) => remote(`github-${index}`));
    const result = reconcileGitHubDiscovery(current, incoming, { ...summary(), receivedCount: 250, repositoryTotal: 250 });
    expect(current.discovery!.candidates).toHaveLength(200);
    expect(current.discovery!.candidates.find(repo => repo.id === 'github-249')?.discoveryStatus?.state).toBe('current');
    expect(result).toMatchObject({ status: 'partial', receivedCount: 250, retainedCount: 100, selectableCount: 100, reasons: ['candidate-limit'] });
    expect(current.discovery!.candidates.filter(repo => repo.source === 'local')).toHaveLength(100);
  });

  it('allows local discoveries into a full remote candidate list without losing selected remote records', () => {
    const current = state(); current.repositories = [remote('github-selected')];
    current.discovery!.candidates = Array.from({ length: 200 }, (_, index) => remote(`github-${index}`));
    reconcileLocalDiscovery(current, [local()], now, false, []);
    expect(current.discovery!.candidates).toHaveLength(200);
    expect(current.discovery!.candidates.some(repo => repo.id === 'local-one')).toBe(true);
    expect(current.repositories[0]?.source).toBe('github');
  });
});
