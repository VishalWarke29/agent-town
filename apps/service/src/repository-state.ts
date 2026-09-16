import type { GitHubListingStatus, Repository, TownState } from '@agent-town/contracts';

const CANDIDATE_LIMIT = 200;
const lastVerified = (repo: Repository): string | null => repo.discoveryStatus?.lastVerifiedAt
  ?? (repo.scan?.coverage === 'complete' && (repo.source === 'github' || repo.projectKind === 'folder' || repo.git?.availability === 'available') ? repo.scan.at : null);

function unverified(repo: Repository, checkedAt: string, reasons: string[], unavailable = false): Repository {
  return { ...repo,
    scan: { at: checkedAt, coverage: 'partial', reasons },
    discoveryStatus: { state: unavailable ? 'unavailable' : 'stale', checkedAt, lastVerifiedAt: lastVerified(repo), reasons },
    ...(repo.source === 'local' ? { git: { availability: 'unavailable' as const, head: null, changedFiles: null, untrackedFiles: null, reason: reasons[0] ?? 'not-verified' } } : {}),
  };
}

/** Preserve saved evidence while refusing to present a failed attempt as current. */
export function markLocalAttemptIncomplete(state: TownState, checkedAt: string, reasons: string[]): void {
  const mark = (repo: Repository) => repo.source === 'local' ? unverified(repo, checkedAt, reasons) : repo;
  state.repositories = state.repositories.map(mark);
  state.discovery!.candidates = state.discovery!.candidates.map(mark);
}

/** Selected records always remain visible; the remaining review inventory is bounded. */
function retainCandidates(state: TownState, records: Repository[]): void {
  state.discovery!.candidates = [...new Map([...state.repositories, ...records].map(repo => [repo.id, repo])).values()].slice(0, CANDIDATE_LIMIT);
  if (state.discovery!.githubListing) state.discovery!.githubListing.selectableCount = new Set([...state.repositories, ...state.discovery!.candidates].filter(repo => repo.source === 'github' && repo.discoveryStatus?.state === 'current').map(repo => repo.id)).size;
}

export function reconcileLocalDiscovery(state: TownState, found: Repository[], checkedAt: string, partial: boolean, reasons: string[], explicitProjects: Repository[] = []): void {
  const prior = new Map([...state.discovery!.candidates, ...state.repositories].map(repo => [repo.id, repo]));
  const fresh = new Map(found.map(repo => [repo.id, { ...repo, discoveryStatus: {
    state: (!partial && repo.git?.availability === 'available' ? 'current' : 'stale') as 'current' | 'stale',
    checkedAt,
    lastVerifiedAt: !partial && repo.git?.availability === 'available' ? checkedAt : (prior.has(repo.id) ? lastVerified(prior.get(repo.id)!) : null),
    reasons,
  } }]));
  // A Git scan cannot establish absence of an explicitly connected plain folder.
  // Its bounded directory check is independent of recursive scan coverage; a Git discovery wins.
  const projectChecks = new Map(explicitProjects.map(repo => [repo.id, repo]));
  const update = (repo: Repository) => repo.source !== 'local' ? repo : fresh.get(repo.id)
    ?? projectChecks.get(repo.id) ?? (repo.projectKind === 'folder' ? repo : undefined)
    ?? unverified(repo, checkedAt, partial ? reasons : ['repository-unavailable'], !partial);
  state.repositories = state.repositories.map(repo => ({ ...update(repo), position: repo.position, color: repo.color }));
  const retained = state.discovery!.candidates.filter(repo => repo.source !== 'local' || repo.projectKind === 'folder' || fresh.has(repo.id) || partial).map(update);
  retainCandidates(state, [...fresh.values(), ...retained.filter(repo => repo.source === 'local'), ...retained.filter(repo => repo.source !== 'local')]);
}

export function reconcileGitHubDiscovery(state: TownState, found: Repository[], summary: Omit<GitHubListingStatus, 'retainedCount' | 'selectableCount'>): GitHubListingStatus {
  const fresh = new Map(found.map(repo => [repo.id, { ...repo, discoveryStatus: {
    state: 'current' as const, checkedAt: summary.checkedAt, lastVerifiedAt: summary.checkedAt, reasons: [],
  } }]));
  const update = (repo: Repository) => repo.source !== 'github' ? repo : fresh.get(repo.id)
    ?? unverified(repo, summary.checkedAt, summary.status === 'complete' ? ['github-repository-unavailable'] : summary.reasons, summary.status === 'complete');
  state.repositories = state.repositories.map(repo => ({ ...update(repo), position: repo.position, color: repo.color }));
  // Keep unseen previous candidates only when this check cannot establish absence.
  const prior = state.discovery!.candidates.filter(repo => repo.source !== 'github' || (summary.status !== 'complete' && !fresh.has(repo.id))).map(update);
  retainCandidates(state, [...prior.filter(repo => repo.source !== 'github'), ...fresh.values(), ...prior.filter(repo => repo.source === 'github')]);
  const retained = state.discovery!.candidates.filter(repo => fresh.has(repo.id));
  const limited = retained.length < fresh.size;
  const status: GitHubListingStatus = { ...summary,
    status: summary.status === 'failed' ? 'failed' : summary.status === 'partial' || limited ? 'partial' : 'complete',
    retainedCount: retained.length,
    selectableCount: new Set([...state.repositories, ...state.discovery!.candidates].filter(repo => repo.source === 'github' && repo.discoveryStatus?.state === 'current').map(repo => repo.id)).size,
    reasons: [...new Set([...summary.reasons, ...(limited ? ['candidate-limit'] : [])])],
  };
  state.discovery!.githubListing = status;
  return status;
}
