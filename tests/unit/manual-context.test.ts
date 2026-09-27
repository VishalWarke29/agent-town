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

  it('MG-41: a repository scope excludes the workspace overview, unscoped legacy blockers and unattributed report ids by default (A/B canary)', () => {
    const version = saved();
    version.overview = 'CANARY-OVERVIEW project-two-secret';
    version.reportIds = ['report', 'CANARY-REPORT-two-only'];
    delete version.blockerRecords;
    version.blockers = ['CANARY-LEGACY-BLOCKER for project two'];
    const result = JSON.parse(manualContext(version, 'one').text!);
    expect(result.overview).toBeNull();
    expect(result.blockers).toEqual([]);
    expect(result.sourceReportIds).not.toContain('CANARY-REPORT-two-only');
    // Only report ids actually attributable to what stayed in scope (decision-0's and decision-2's own sourceReportIds) survive.
    expect(result.sourceReportIds.sort()).toEqual(['source-0', 'source-2']);
    expect(JSON.stringify(result)).not.toContain('CANARY');
  });

  it('MG-41: explicit whole-workspace inclusion is a separate, described selection that restores the excluded overview and legacy-blocker material', () => {
    const version = saved(); delete version.blockerRecords; version.blockers = ['Unresolved legacy issue'];
    const scoped = manualContext(version, 'one');
    expect(scoped.scopeNote).toContain('excluded');
    const included = JSON.parse(manualContext(version, 'one', { includeWorkspaceMaterial: true }).text!);
    expect(included.overview).toBe(version.overview);
    expect(included.blockers).toEqual([{ text: 'Unresolved legacy issue', status: 'open', source: 'legacy-context' }]);
    const wholeWorkspace = manualContext(version, null);
    expect(wholeWorkspace.scopeNote).toContain('Whole workspace');
  });

  it('MG-41: the repository-scoped "include workspace material" checkbox never re-adds an unattributed report id from a different repository (it only restores overview/legacy-blocker text, exactly as it is labeled)', () => {
    const version = saved();
    // 'report' is workspace-wide and unattributed to any single repo; only decisions/blockers actually
    // carry per-repo attribution (their own sourceReportIds, already asserted by the canary test above).
    version.reportIds = ['report'];
    const scopedDefault = JSON.parse(manualContext(version, 'one').text!);
    expect(scopedDefault.sourceReportIds).not.toContain('report');
    const scopedWithCheckbox = JSON.parse(manualContext(version, 'one', { includeWorkspaceMaterial: true }).text!);
    expect(scopedWithCheckbox.sourceReportIds).not.toContain('report');
    // A genuine whole-workspace scope (selecting "Whole workspace", not the checkbox) is the only way to see it.
    const wholeWorkspace = JSON.parse(manualContext(version, null).text!);
    expect(wholeWorkspace.sourceReportIds).toContain('report');
  });
});
