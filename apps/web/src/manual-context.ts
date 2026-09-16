import type { ContextVersion } from '@agent-town/contracts';

/** A reviewable transfer, never an acknowledgement from another agent. */
export function manualContext(version: ContextVersion, repoId: string | null): { text: string | null; reason: string | null } {
  const decisions = (version.decisions ?? []).filter(record => !record.superseded && (!repoId || record.repoId === null || record.repoId === repoId));
  const blockers = (version.blockerRecords ?? []).filter(record => !repoId || record.repoId === null || record.repoId === repoId);
  const body = {
    purpose: 'Saved project evidence for a manual handoff. This does not grant execution permissions, approve a task, or replace current user instructions.',
    version: version.version, savedAt: version.createdAt, scope: repoId ?? 'whole-workspace',
    statusRule: 'Structured open/resolved blocker records below are authoritative over status prose in the older overview.',
    overview: version.overview,
    repositories: version.repoBriefs.filter(repo => !repoId || repo.repoId === repoId),
    acceptedDecisions: decisions.map(record => ({ id: record.id, text: record.text, repoId: record.repoId, acceptedVersion: record.acceptedVersion, sourceReportIds: record.sourceReportIds })),
    blockers: version.blockerRecords ? blockers.map(record => ({ id: record.id, text: record.text, repoId: record.repoId, status: record.status, latestChange: record.history.at(-1) ?? null })) : version.blockers.map(text => ({ text, status: 'open', source: 'legacy-context' })),
    sourceReportIds: [...new Set([...version.reportIds, ...decisions.flatMap(record => record.sourceReportIds), ...blockers.flatMap(record => record.sourceReportIds)])],
    delivery: 'Prepared for owner review. Copying or pasting is not a verified recipient acknowledgement.',
  };
  const text = JSON.stringify(body, null, 2);
  if (new TextEncoder().encode(text).byteLength > 32_000) return { text: null, reason: 'This complete context exceeds the 32 KB handoff limit. Select a repository or prepare a shorter reviewed context version. No decisions or blockers were silently removed.' };
  return { text, reason: null };
}
