import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { addRootSchema, connectLocalProjectSchema, removeRootSchema, selectRepositoriesSchema, reconcileAgentHomes, type Repository, type ConnectLocalProjectResult } from '@agent-town/contracts';
import { canonicalizeRoot, discoverRepositories, inspectLocalProject, isWithin, DiscoveryError, type DiscoveredRepository, type DiscoveryResult, type LocalProjectDirectory } from './discovery/index.js';
import { IdentityError, type GitHubRepositoryListing } from './identity/index.js';
import type { Store } from './store.js';
import { checkedPath } from './discovery/paths.js';
import { markLocalAttemptIncomplete, reconcileGitHubDiscovery, reconcileLocalDiscovery } from './repository-state.js';
import { requireRepositoryRemovable, rootRemovalReview } from './history-state.js';

interface Dependencies { store(request: FastifyRequest): Store; stores?(): Store[]; listGitHub(request: FastifyRequest): Promise<GitHubRepositoryListing>; listGitHubBackground?(store: Store): Promise<GitHubRepositoryListing>; refreshIntervalMs?: number; githubRefreshIntervalMs?: number; discover?: typeof discoverRepositories }
const githubSafeCodes = ['github_unauthorized', 'github_access_limited', 'github_permissions_too_broad', 'github_listing_cancelled', 'github_listing_timeout', 'github_unavailable', 'github_response_invalid', 'github_not_connected'];
const colors = ['#859b87', '#bc9782', '#c6ad71', '#829ca3', '#a78caa'];
const position = (index: number): [number, number] => index < 3 ? [[-6, -3.3], [5.7, -3.8], [-5, 5.5]][index] as [number, number] : [18 + ((index - 3) % 5) * 8, -4 + Math.floor((index - 3) / 5) * 8];

function fromLocal(repo: DiscoveredRepository, result: DiscoveryResult, index: number): Repository {
  return {
    id: repo.id, name: repo.name, description: 'Selected local Git repository. Instruction files are inventoried as metadata only.',
    language: 'Not scanned', branch: repo.git.branch ?? 'Unavailable', color: colors[index % colors.length]!, position: position(index),
    source: 'local', projectKind: 'git', localPath: repo.canonicalPath, selectedRoot: repo.rootPath,
    scan: { at: repo.scannedAt, coverage: result.coverage.status, reasons: result.coverage.issues },
    git: { availability: repo.git.availability, head: repo.git.head, changedFiles: repo.git.changedFiles, untrackedFiles: null, ...(repo.git.reason ? { reason: repo.git.reason } : {}) },
    instructions: repo.instructions.map(file => ({ path: file.path, scope: file.scope, tool: file.tool, size: file.bytes, modifiedAt: file.modifiedAt, hash: null, appliedToRun: false })),
  };
}

function fromProject(project: LocalProjectDirectory, checkedAt: string, index: number, prior?: Repository): Repository {
  if (project.projectKind === 'git' && prior && prior.projectKind !== 'folder') return { ...prior, projectKind: 'git' };
  const folder = project.projectKind === 'folder';
  return {
    id: project.id, name: prior?.name ?? project.name,
    description: folder ? 'Explicitly connected local project folder. Git is not configured; instruction files have not been scanned.' : 'Explicitly connected local Git project. Scan selected folders to refresh Git and instruction metadata.',
    language: 'Not scanned', branch: 'Unavailable', color: prior?.color ?? colors[index % colors.length]!, position: prior?.position ?? position(index),
    source: 'local', projectKind: project.projectKind, localPath: project.canonicalPath, selectedRoot: prior?.selectedRoot ?? project.rootPath,
    ...(folder ? {} : { scan: { at: checkedAt, coverage: 'partial' as const, reasons: ['git-metadata-not-scanned'] } }),
    discoveryStatus: { state: folder ? 'current' : 'stale', checkedAt, lastVerifiedAt: folder ? checkedAt : prior?.discoveryStatus?.lastVerifiedAt ?? null, reasons: folder ? [] : ['git-metadata-not-scanned'] },
    git: { availability: 'unavailable', head: null, changedFiles: null, untrackedFiles: null, reason: folder ? 'not-a-git-repository' : 'git-metadata-not-scanned' },
    instructions: [],
  };
}

/** Refresh only explicitly registered folders; this does not discover or traverse new folders. */
async function checkExplicitProjects(repositories: Repository[], roots: string[], checkedAt: string): Promise<Repository[]> {
  return Promise.all(repositories.filter(repo => repo.source === 'local' && repo.projectKind === 'folder').map(async (repo, index) => {
    try { return fromProject(await inspectLocalProject(repo.localPath!, roots), checkedAt, index, repo); }
    catch {
      return { ...repo, discoveryStatus: { state: 'unavailable' as const, checkedAt, lastVerifiedAt: repo.discoveryStatus?.lastVerifiedAt ?? null, reasons: ['project-folder-unavailable'] },
        git: { availability: 'unavailable' as const, head: null, changedFiles: null, untrackedFiles: null, reason: 'project-folder-unavailable' } };
    }
  }));
}

export function registerRepositoryApi(app: FastifyInstance, dependencies: Dependencies): () => Promise<void> {
  const jobs = new Map<string, { id: string; abort: AbortController; promise: Promise<void> }>();
  const listings = new Map<string, Promise<unknown>>();
  const previous = new Map<string, DiscoveredRepository[]>();
  const watchers = new Map<string, FSWatcher[]>();
  const debounce = new Map<string, ReturnType<typeof setTimeout>>();
  const prefix = '/api/v1/workspaces/:id';
  let closing = false;
  const clearWatchers = (id: string) => { for (const watcher of watchers.get(id) ?? []) watcher.close(); watchers.delete(id); clearTimeout(debounce.get(id)); debounce.delete(id); };
  const refreshWatchers = async (store: Store) => {
    const state = store.snapshot().state, id = state.workspace.id;
    clearWatchers(id);
    if (closing) return;
    if (!state.discovery?.roots.length) {
      store.commit(`watchers:${randomUUID()}`, (current, now) => {
        current.discovery!.refresh = { checkedAt: now, watchedPaths: 0, skippedPaths: 0, reconciliationSeconds: (dependencies.refreshIntervalMs ?? 60000) / 1000, state: 'inactive' };
        return 'discovery.watchers_changed';
      });
      return;
    }
    const paths = new Set(state.discovery.roots);
    for (const repo of state.repositories) if (repo.localPath) {
      paths.add(repo.localPath); if (repo.projectKind !== 'folder') paths.add(join(repo.localPath, '.git'));
      for (const file of repo.instructions ?? []) paths.add(dirname(join(repo.localPath, file.path)));
    }
    const active: FSWatcher[] = []; watchers.set(id, active);
    const reportWatchers = () => {
      if (closing || watchers.get(id) !== active) return;
      store.commit(`watchers:${randomUUID()}`, (current, now) => {
        current.discovery!.refresh = { checkedAt: now, watchedPaths: active.length, skippedPaths: paths.size - active.length, reconciliationSeconds: (dependencies.refreshIntervalMs ?? 60000) / 1000, state: active.length ? 'watching' : 'periodic-only' };
        return 'discovery.watchers_changed';
      });
    };
    for (const path of [...paths].slice(0, 256)) {
      try {
        await checkedPath(path, state.discovery.roots);
        if (closing || watchers.get(id) !== active) break;
        const watcher = watch(path, { persistent: false }, () => {
          clearTimeout(debounce.get(id));
          const timer = setTimeout(() => { debounce.delete(id); if (!closing && !jobs.has(id)) { try { startScan(store, true); } catch { /* Periodic reconciliation remains available. */ } } }, 500);
          timer.unref(); debounce.set(id, timer);
        });
        watcher.on('error', () => { watcher.close(); const index = active.indexOf(watcher); if (index >= 0) active.splice(index, 1); reportWatchers(); }); active.push(watcher);
      } catch { /* Missing/unsupported watch paths are covered by bounded reconciliation. */ }
    }
    reportWatchers();
  };
  const assertIdle = (store: Store) => {
    if (closing) throw new IdentityError('SHUTTING_DOWN', 'The service is shutting down.', 503);
    if (jobs.has(store.snapshot().state.workspace.id)) throw new IdentityError('SCAN_RUNNING', 'Wait for the current scan or cancel it first.', 409);
  };

  app.post(`${prefix}/roots`, async request => {
    const store = dependencies.store(request); assertIdle(store);
    const parsed = addRootSchema.safeParse(request.body);
    if (!parsed.success) throw new IdentityError('INVALID_ROOT', 'Choose an absolute local project folder.');
    let root: string;
    try { root = await canonicalizeRoot(parsed.data.path); }
    catch (error) { if (error instanceof DiscoveryError) throw new IdentityError(error.code, error.message); throw error; }
    // Recheck after the asynchronous filesystem operation, before committing selection.
    dependencies.store(request); assertIdle(store);
    return store.commit(`root:${randomUUID()}`, state => {
      if (!state.discovery!.roots.includes(root)) {
        if (state.discovery!.roots.length >= 8) throw new IdentityError('ROOT_LIMIT', 'Use up to eight selected project folders.');
        state.discovery!.roots.push(root);
        state.discovery!.operation = null;
      }
      return 'repository.root_added';
    });
  });

  app.post(`${prefix}/projects/local`, async request => {
    const store = dependencies.store(request); assertIdle(store);
    const parsed = connectLocalProjectSchema.safeParse(request.body);
    if (!parsed.success) throw new IdentityError('INVALID_PROJECT', 'Choose an absolute local project folder inside an allowed folder.');
    const roots = store.snapshot().state.discovery!.roots;
    if (!roots.length) throw new IdentityError('ROOT_REQUIRED', 'Add an allowed project folder before connecting it.');
    let project: LocalProjectDirectory;
    try { project = await inspectLocalProject(parsed.data.path, roots); }
    catch (error) { if (error instanceof DiscoveryError) throw new IdentityError(error.code, error.message); throw error; }
    dependencies.store(request); assertIdle(store);
    let duplicate = false;
    const result = store.commit(`local-project:${randomUUID()}`, (state, now) => {
      // Scope or ownership may have changed while the filesystem check was pending.
      if (!state.discovery!.roots.includes(project.rootPath) || !isWithin(project.rootPath, project.canonicalPath)) throw new IdentityError('ROOT_CHANGED', 'Allowed folders changed. Review them and connect the project again.', 409);
      const selected = state.repositories.find(repo => repo.id === project.id);
      duplicate = Boolean(selected);
      if (!selected && state.repositories.length >= 100) throw new IdentityError('REPOSITORY_LIMIT', 'Select up to 100 projects in this workspace.');
      const prior = selected ?? state.discovery!.candidates.find(repo => repo.id === project.id);
      // Root removal can leave holes, and an unselected candidate may occupy a
      // selected house's coordinates. Fill a free slot without moving residents.
      let slot = 0;
      while (state.repositories.some(repo => repo.position[0] === position(slot)[0] && repo.position[1] === position(slot)[1])) slot++;
      const repository = fromProject(project, now, slot, prior);
      if (!selected) { repository.position = position(slot); repository.color = colors[slot % colors.length]!; }
      if (selected) state.repositories = state.repositories.map(repo => repo.id === repository.id ? repository : repo);
      else state.repositories.push(repository);
      const selectedIds = new Set(state.repositories.map(repo => repo.id));
      state.discovery!.candidates = [...state.repositories, ...state.discovery!.candidates.filter(repo => !selectedIds.has(repo.id))].slice(0, 200);
      return 'repository.local_project_connected';
    });
    await refreshWatchers(store);
    const snapshot = result.snapshot;
    return { repository: snapshot.state.repositories.find(repo => repo.id === project.id)!, snapshot, duplicate } satisfies ConnectLocalProjectResult;
  });

  app.post(`${prefix}/roots/remove/preview`, request => {
    const store = dependencies.store(request); assertIdle(store);
    const parsed = addRootSchema.safeParse(request.body);
    if (!parsed.success) throw new IdentityError('INVALID_ROOT', 'Choose a registered project folder.');
    return rootRemovalReview(store.snapshot().state, parsed.data.path);
  });
  app.post(`${prefix}/roots/remove`, async request => {
    const store = dependencies.store(request); assertIdle(store);
    const parsed = removeRootSchema.safeParse(request.body);
    if (!parsed.success) throw new IdentityError('INVALID_ROOT', 'Choose a registered project folder.');
    const result = store.commit(`root-remove:${randomUUID()}`, (state, now) => {
      const review = rootRemovalReview(state, parsed.data.path);
      if (review.reviewToken !== parsed.data.reviewToken) throw new IdentityError('ROOT_REVIEW_CHANGED', 'The folder inventory changed. Review the removal again.', 409);
      if (!review.allowed) throw new IdentityError('ROOT_IN_USE', review.reasons.join(' '), 409);
      for (const repo of state.repositories.filter(repo => repo.selectedRoot === parsed.data.path)) store.saveRepositoryHistory(repo, now);
      state.discovery!.roots = state.discovery!.roots.filter(root => root !== parsed.data.path);
      state.discovery!.operation = null;
      state.discovery!.candidates = state.discovery!.candidates.filter(repo => repo.selectedRoot !== parsed.data.path);
      state.repositories = state.repositories.filter(repo => repo.selectedRoot !== parsed.data.path);
      return 'repository.root_removed';
    });
    await refreshWatchers(store);
    return result;
  });

  const startScan = (store: Store, automatic = false) => {
    assertIdle(store);
    const initial = store.snapshot().state;
    if (!initial.discovery!.roots.length) throw new IdentityError('ROOT_REQUIRED', 'Add a project folder before scanning.');
    const workspaceId = initial.workspace.id, id = randomUUID(), abort = new AbortController();
    store.commit(`scan-start:${id}`, (state, now) => {
      state.discovery!.operation = { id, status: 'running', startedAt: now, finishedAt: null, message: automatic ? 'Refreshing selected repository metadata…' : 'Reading repository metadata inside your selected folders…', coverage: null };
      return 'discovery.started';
    });
    const promise = (async () => {
      try {
        const result = await (dependencies.discover ?? discoverRepositories)(initial.discovery!.roots, { signal: abort.signal, previous: previous.get(workspaceId) });
        if (abort.signal.aborted) throw new Error('Scan cancelled');
        const found = result.repositories.map((repo, index) => fromLocal(repo, result, index));
        const explicitProjects = await checkExplicitProjects([...new Map([...initial.discovery!.candidates, ...initial.repositories].map(repo => [repo.id, repo])).values()], initial.discovery!.roots, result.scannedAt);
        if (abort.signal.aborted) throw new Error('Scan cancelled');
        store.commit(`scan-result:${id}`, (state, now) => {
          const discovery = state.discovery!;
          reconcileLocalDiscovery(state, found, now, result.coverage.status === 'partial', result.coverage.issues, explicitProjects);
          const retainedCount = discovery.candidates.filter(repo => found.some(item => item.id === repo.id)).length;
          const reasons = [...result.coverage.issues, ...(retainedCount < found.length ? ['candidate-limit'] : [])];
          Object.assign(discovery.operation!, { status: 'complete', finishedAt: now, coverage: reasons.length ? 'partial' : 'complete', reasons, foundCount: found.length, retainedCount, message: `${found.length} Git repositories found; ${retainedCount} retained for review. ${found.length ? 'Review the results and select repositories to show in town.' : 'No Git checkouts were found inside these folders. Choose “Use as local project” beside an allowed folder to connect it without Git. Already connected local projects remain in town.'}${reasons.length ? ' Some paths or metadata could not be checked. Review the coverage reasons below.' : ''}` });
          return 'discovery.completed';
        });
        previous.set(workspaceId, result.repositories);
      } catch {
        store.commit(`scan-failed:${id}`, (state, now) => {
          const reasons = [abort.signal.aborted ? 'cancelled' : 'scan-failed'];
          markLocalAttemptIncomplete(state, now, reasons);
          Object.assign(state.discovery!.operation!, { status: abort.signal.aborted ? 'cancelled' : 'failed', finishedAt: now, coverage: 'partial', reasons, message: abort.signal.aborted ? 'Scan cancelled. Previous inventory is preserved as stale; scan again to verify it.' : 'The scan could not finish. Previous inventory is stale. Check that the selected folders are accessible, then retry.' });
          return abort.signal.aborted ? 'discovery.cancelled' : 'discovery.failed';
        });
      } finally { jobs.delete(workspaceId); if (!closing) await refreshWatchers(store); }
    })();
    void promise.catch(() => app.log.error('Repository refresh stopped. Previous saved state remains available.'));
    jobs.set(workspaceId, { id, abort, promise });
    return id;
  };
  app.post(`${prefix}/scans`, async (request, reply) => reply.code(202).send({ operationId: startScan(dependencies.store(request)) }));

  app.post(`${prefix}/scans/:operationId/cancel`, async request => {
    const store = dependencies.store(request);
    const job = jobs.get(store.snapshot().state.workspace.id);
    if (!job || job.id !== (request.params as { operationId: string }).operationId) throw new IdentityError('SCAN_NOT_ACTIVE', 'This scan is no longer active.', 409);
    job.abort.abort(); return { cancellationRequested: true };
  });
  app.get(`${prefix}/scans/:operationId`, async request => {
    const operation = dependencies.store(request).snapshot().state.discovery!.operation;
    if (!operation || operation.id !== (request.params as { operationId: string }).operationId) throw new IdentityError('SCAN_NOT_FOUND', 'This scan is not available.', 404);
    return { operation };
  });

  // Shared by the manual button and the periodic background refresh below, so both
  // paths record failures/successes (and rate-limit backoff) identically.
  const githubBackoff = new Set<string>();
  const commitGithubFailure = (store: Store, workspaceId: string, error: unknown) => {
    const reason = error instanceof IdentityError && githubSafeCodes.includes(error.code) ? error.code : 'github_unavailable';
    if (reason === 'github_access_limited') githubBackoff.add(workspaceId); else githubBackoff.delete(workspaceId);
    store.commit(`github-failed:${randomUUID()}`, (state, now) => {
      reconcileGitHubDiscovery(state, [], { checkedAt: now, status: 'failed', installationCount: null, installationTotal: null, repositoryTotal: null, receivedCount: 0, reasons: [reason] });
      return 'repository.github_failed';
    });
  };
  const commitGithubSuccess = (store: Store, workspaceId: string, result: GitHubRepositoryListing) => {
    githubBackoff.delete(workspaceId);
    const repositories: Repository[] = result.repositories.map((repo, index) => ({
      id: `github-${repo.id}`, githubId: Number(repo.id), name: repo.fullName, description: 'Selected GitHub repository metadata. Connect a local checkout to observe local agents.', language: 'Unavailable', branch: repo.defaultBranch,
      color: colors[index % colors.length]!, position: position(index), source: 'github', githubUrl: repo.htmlUrl,
      scan: { at: result.checkedAt, coverage: result.truncated ? 'partial' : 'complete', reasons: result.truncated ? ['listing-limit'] : [] },
    }));
    store.commit(`github-list:${randomUUID()}`, state => {
      reconcileGitHubDiscovery(state, repositories, { checkedAt: result.checkedAt, status: result.truncated ? 'partial' : 'complete', installationCount: result.diagnostics?.installationCount ?? null, installationTotal: result.diagnostics?.installationTotal ?? null, repositoryTotal: result.diagnostics?.repositoryTotal ?? null, receivedCount: new Set(repositories.map(repo => repo.id)).size, reasons: result.diagnostics?.reasons ?? (result.truncated ? ['page-limit'] : []) });
      return 'repository.github_listed';
    });
    const saved = store.snapshot().state.discovery!;
    const returnedIds = new Set(repositories.map(repo => repo.id));
    return { repositories: saved.candidates.filter(repo => returnedIds.has(repo.id)), partial: saved.githubListing!.status !== 'complete', diagnostics: saved.githubListing };
  };

  app.post(`${prefix}/github/repositories`, async request => {
    const store = dependencies.store(request);
    const workspaceId = store.snapshot().state.workspace.id;
    if (closing) throw new IdentityError('SHUTTING_DOWN', 'The service is shutting down.', 503);
    if (listings.has(workspaceId)) throw new IdentityError('GITHUB_LIST_RUNNING', 'A GitHub repository check is already running. Wait for its result.', 409);
    const work = (async () => {
    let result: GitHubRepositoryListing;
    try { result = await dependencies.listGitHub(request); }
    catch (error) {
      dependencies.store(request);
      if (!closing) commitGithubFailure(store, workspaceId, error);
      throw error;
    }
    dependencies.store(request);
    if (closing) throw new IdentityError('SHUTTING_DOWN', 'The service is shutting down.', 503);
    return commitGithubSuccess(store, workspaceId, result);
    })();
    listings.set(workspaceId, work);
    try { return await work; } finally { listings.delete(workspaceId); }
  });

  // Background refresh: re-run the same GitHub listing for workspaces that have
  // already established a GitHub connection (evidenced by a prior listing status),
  // read-only and scoped to one workspace's own store per cycle. Skips a workspace
  // for one cycle after that workspace's previous attempt hit a GitHub rate limit.
  const refreshGithubBackground = (store: Store) => {
    const state = store.snapshot().state;
    const workspaceId = state.workspace.id;
    if (closing || listings.has(workspaceId) || !state.discovery?.githubListing) return;
    if (githubBackoff.delete(workspaceId)) return;
    const work = (async () => {
      let result: GitHubRepositoryListing;
      try { result = await dependencies.listGitHubBackground!(store); }
      catch (error) { if (!closing) commitGithubFailure(store, workspaceId, error); return; }
      if (!closing) commitGithubSuccess(store, workspaceId, result);
    })();
    listings.set(workspaceId, work);
    void work.finally(() => listings.delete(workspaceId));
  };
  const githubTimer = setInterval(() => {
    if (closing || !dependencies.listGitHubBackground) return;
    try { for (const store of dependencies.stores?.() ?? []) refreshGithubBackground(store); }
    catch { app.log.error('GitHub background refresh could not read the workspace registry.'); }
  }, dependencies.githubRefreshIntervalMs ?? 300000); githubTimer.unref();

  app.post(`${prefix}/repositories/select`, async request => {
    const store = dependencies.store(request);
    const parsed = selectRepositoriesSchema.safeParse(request.body);
    if (!parsed.success) throw new IdentityError('INVALID_SELECTION', 'Choose repositories from the scanned results.');
    const result = store.commit(`repo-selection:${randomUUID()}`, (state, now) => {
      const ids = [...new Set(parsed.data.ids)];
      const available = new Map([...state.repositories, ...state.discovery!.candidates].map(repo => [repo.id, repo]));
      if (ids.some(id => !available.has(id))) throw new IdentityError('UNKNOWN_REPOSITORY', 'Scan or list the repositories before selecting them.');
      if (ids.some(id => !state.repositories.some(repo => repo.id === id) && available.get(id)!.discoveryStatus && available.get(id)!.discoveryStatus!.state !== 'current')) throw new IdentityError('REPOSITORY_NOT_VERIFIED', 'Refresh stale or unavailable repositories before adding them to the workspace.', 409);
      const removed = state.repositories.filter(repo => !ids.includes(repo.id));
      requireRepositoryRemovable(state, new Set(removed.map(repo => repo.id)));
      for (const repo of removed) store.saveRepositoryHistory(repo, now);
      const previousRepositories = state.repositories;
      state.repositories = ids.map((id, index) => ({ ...available.get(id)!, position: position(index), color: colors[index % colors.length]! }));
      state.agents = reconcileAgentHomes(state.repositories, state.agents, previousRepositories);
      return 'repository.selection_changed';
    });
    await refreshWatchers(store);
    return result;
  });

  const timer = setInterval(() => {
    if (closing) return;
    try { for (const store of dependencies.stores?.() ?? []) {
      const state = store.snapshot().state;
      if (state.discovery?.roots.length && !jobs.has(state.workspace.id)) { try { startScan(store, true); } catch { /* Retry on the next bounded reconciliation. */ } }
    } } catch { app.log.error('Repository reconciliation could not read the local registry.'); }
  }, dependencies.refreshIntervalMs ?? 60000); timer.unref();
  return async () => { closing = true; clearInterval(timer); clearInterval(githubTimer); for (const id of watchers.keys()) clearWatchers(id); for (const job of jobs.values()) job.abort.abort(); await Promise.allSettled([...jobs.values()].map(job => job.promise).concat([...listings.values()].map(promise => promise.then(() => undefined)))); };
}
