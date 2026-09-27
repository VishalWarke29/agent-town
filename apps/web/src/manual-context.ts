import type { ContextVersion } from '@agent-town/contracts';

/** MG-41: which decisions/blockers/overview/report references a manual (or, later, MG-24's manager)
 * handoff includes for a chosen scope. A repository scope excludes workspace-wide overview text,
 * unscoped legacy blockers and unattributed report ids by default — none of those can be safely
 * attributed to the selected project — unless the caller explicitly opts into whole-workspace
 * material. Global (repoId: null) decisions/blockers are not "unknown provenance": they were
 * deliberately recorded as applying to every project, so they stay in a repository scope exactly as
 * they always have. */
export interface ContextScopeOptions {
  /** Explicit, separate selection to also include workspace-wide overview text and unscoped legacy
   * blockers in a repository-scoped context. Ignored (treated as true) when repoId is null: the whole
   * workspace is already the explicit choice at that point. */
  includeWorkspaceMaterial?: boolean;
}

function selectScopedContext(version: ContextVersion, repoId: string | null, options: ContextScopeOptions) {
  const wholeWorkspace = repoId === null;
  const includeUnscoped = wholeWorkspace || options.includeWorkspaceMaterial === true;
  const decisions = (version.decisions ?? []).filter(record => !record.superseded && (!repoId || record.repoId === null || record.repoId === repoId));
  const blockers = (version.blockerRecords ?? []).filter(record => !repoId || record.repoId === null || record.repoId === repoId);
  const legacyBlockers = includeUnscoped ? version.blockers : [];
  const repoBriefs = version.repoBriefs.filter(repo => !repoId || repo.repoId === repoId);
  const overview = includeUnscoped ? version.overview : null;
  // version.reportIds has no per-report repository attribution (it is the whole workspace's processed-
  // report list) — only a genuine whole-workspace scope includes it wholesale. The repository-scoped
  // "include workspace material" checkbox is documented (and labeled) as adding only the overview and
  // unscoped legacy blockers; it must never also silently re-add another, unselected repository's opaque
  // report id through this same flag. A repository scope's own report references stay attributable
  // (decisions'/blockers' own sourceReportIds, already filtered above) regardless of this option.
  const sourceReportIds = [...new Set([...(wholeWorkspace ? version.reportIds : []), ...decisions.flatMap(record => record.sourceReportIds), ...blockers.flatMap(record => record.sourceReportIds)])];
  return { wholeWorkspace, includeUnscoped, overview, repoBriefs, decisions, blockers, legacyBlockers, sourceReportIds };
}

/** A reviewable transfer, never an acknowledgement from another agent. */
export function manualContext(version: ContextVersion, repoId: string | null, options: ContextScopeOptions = {}): { text: string | null; reason: string | null; scopeNote: string } {
  const scoped = selectScopedContext(version, repoId, options);
  const scopeNote = scoped.wholeWorkspace
    ? 'Whole workspace: every saved project, decision and blocker is included.'
    : scoped.includeUnscoped
      ? 'This repository, plus the workspace-wide overview and unscoped legacy blockers you explicitly included.'
      : 'This repository only. The workspace-wide overview and unscoped legacy blockers are excluded; include whole-workspace material separately if you need them.';
  const body = {
    purpose: 'Saved project evidence for a manual handoff. This does not grant execution permissions, approve a task, or replace current user instructions.',
    version: version.version, savedAt: version.createdAt, scope: repoId ?? 'whole-workspace', scopeNote,
    statusRule: 'Structured open/resolved blocker records below are authoritative over status prose in the older overview.',
    overview: scoped.overview,
    repositories: scoped.repoBriefs,
    acceptedDecisions: scoped.decisions.map(record => ({ id: record.id, text: record.text, repoId: record.repoId, acceptedVersion: record.acceptedVersion, sourceReportIds: record.sourceReportIds })),
    blockers: version.blockerRecords ? scoped.blockers.map(record => ({ id: record.id, text: record.text, repoId: record.repoId, status: record.status, latestChange: record.history.at(-1) ?? null })) : scoped.legacyBlockers.map(text => ({ text, status: 'open', source: 'legacy-context' })),
    sourceReportIds: scoped.sourceReportIds,
    delivery: 'Prepared for owner review. Copying or pasting is not a verified recipient acknowledgement.',
  };
  const text = JSON.stringify(body, null, 2);
  if (new TextEncoder().encode(text).byteLength > 32_000) return { text: null, reason: 'This complete context exceeds the 32 KB handoff limit. Select a repository or prepare a shorter reviewed context version. No decisions or blockers were silently removed.', scopeNote };
  return { text, reason: null, scopeNote };
}
