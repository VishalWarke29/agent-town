import { describe, expect, it } from 'vitest';
import type { ContextVersion } from '@agent-town/contracts';
import { manualContext } from '../../apps/web/src/manual-context';

function saved(): ContextVersion {
  return { version: 3, previousVersion: 2, reportIds: ['report'], overview: 'Earlier overview. Current structured status takes precedence.', repoBriefs: [{ repoId: 'one', brief: 'One project' }, { repoId: 'two', brief: 'Two project' }], blockers: [], createdAt: '2026-09-15T00:00:00Z',
    decisions: ['one', 'two', null].map((repoId, index) => ({ id: `decision-${index}`, text: `Decision ${index}`, repoId, sourceReportIds: [`source-${index}`], sourceContextVersion: 1, acceptedAt: '2026-09-15T00:00:00Z', acceptedVersion: 2 })),
    blockerRecords: [{ id: 'blocker', text: 'Build access', repoId: 'one', sourceReportIds: ['build-report'], sourceContextVersion: 1, origin: 'workspace-owner', createdAt: '2026-09-15T00:00:00Z', status: 'resolved', history: [{ action: 'resolved', reason: 'Owner supplied test evidence.', at: '2026-09-15T00:00:00Z', version: 3, actor: 'workspace-owner' }] }] };
}
describe('bounded manual context handoff', () => {
  it('keeps global and selected-repository decisions, resolution evidence and version without changing delivery', () => {
    const version = saved(), before = structuredClone(version);
    const result = JSON.parse(manualContext(version, 'one').text!);
    expect(result.version).toBe(3); expect(result.repositories).toEqual([{ repoId: 'one', brief: 'One project' }]);
    expect(result.acceptedDecisions.map((record: { id: string }) => record.id)).toEqual(['decision-0', 'decision-2']);
    expect(result.blockers[0]).toMatchObject({ status: 'resolved', latestChange: { reason: 'Owner supplied test evidence.' } });
    expect(result.delivery).toContain('not a verified recipient acknowledgement');
    expect(version).toEqual(before);
  });
  it('refuses an oversized context rather than dropping accepted decisions or blockers', () => {
    const version = saved(); version.overview = '界'.repeat(11000);
    const result = manualContext(version, null);
    expect(result.text).toBeNull(); expect(result.reason).toContain('No decisions or blockers were silently removed');
  });
  it('preserves legacy open blockers and excludes superseded decisions', () => {
    const version = saved(); delete version.blockerRecords; version.blockers = ['Unresolved legacy issue'];
    version.decisions![0]!.superseded = { version: 3, at: version.createdAt, reason: 'Changed requirement' };
    const result = JSON.parse(manualContext(version, null).text!);
    expect(result.blockers).toEqual([{ text: 'Unresolved legacy issue', status: 'open', source: 'legacy-context' }]);
    expect(result.acceptedDecisions).toHaveLength(2);
  });
});
