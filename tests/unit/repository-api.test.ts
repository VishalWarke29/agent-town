import { mkdir, mkdtemp, readdir, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repository } from '@agent-town/contracts';
import { registerRepositoryApi } from '../../apps/service/src/repository-api';
import { Store } from '../../apps/service/src/store';
import { privateState } from '../../apps/service/src/workspaces';
import { IdentityError, type GitHubRepositoryListing } from '../../apps/service/src/identity/types';
import { localRepositoryId, type DiscoveryResult } from '../../apps/service/src/discovery';

let fixture: string, app: FastifyInstance, store: Store, closeRepository: (() => Promise<void>) | undefined;
const prefix = '/api/v1/workspaces/fixture-workspace';
const before = '2026-09-14T10:00:00Z';
const local = (id: string): Repository => ({ id, name: id, description: 'Fixture', branch: 'main', language: 'Unavailable', color: '#ffffff', position: [0, 0], source: 'local', scan: { at: before, coverage: 'complete', reasons: [] }, git: { availability: 'available', head: 'a'.repeat(40), changedFiles: 0, untrackedFiles: null } });
const remote = (id: string): Repository => ({ ...local(id), source: 'github', git: undefined });
const result = (): DiscoveryResult => ({ roots: [fixture], repositories: [], scannedAt: before, coverage: { status: 'complete', issues: [], entriesVisited: 1, excludedEntries: 0, unsafeEntries: 0 }, delta: { added: [], changed: [], removed: [], removalConfirmed: true } });
const listing = (count = 0): GitHubRepositoryListing => ({ repositories: Array.from({ length: count }, (_, index) => ({ id: String(index + 1), installationId: '1', name: `repo-${index}`, fullName: `fixture/repo-${index}`, private: true, defaultBranch: 'main', htmlUrl: `https://github.com/fixture/repo-${index}`, archived: false })), truncated: false, checkedAt: before, diagnostics: { installationCount: 1, installationTotal: 1, repositoryTotal: count, suspendedInstallations: 0, reasons: count ? [] : ['no-repositories'] } });
beforeEach(async () => { fixture = await mkdtemp(join(tmpdir(), 'agent-town-repository-api-')); app = Fastify({ logger: false }); store = new Store(':memory:', privateState({ id: 'fixture-workspace', name: 'Fixture', kind: 'personal' })); });
afterEach(async () => { await closeRepository?.(); await app.close(); store.close(); closeRepository = undefined; const path = resolve(fixture); if (!path.startsWith(`${resolve(tmpdir())}${sep}agent-town-repository-api-`)) throw new Error('Unsafe fixture cleanup'); await rm(path, { recursive: true, force: true }); });

describe('repository setup API', () => {
  it('requires an explicitly added valid root and explains an ordinary non-Git folder without creating Git metadata', async () => {
    closeRepository = registerRepositoryApi(app, { store: () => store, listGitHub: async () => listing() });
    expect((await app.inject({ method: 'POST', url: `${prefix}/scans` })).statusCode).toBe(400);
    for (const path of ['', join(fixture, 'missing')]) expect((await app.inject({ method: 'POST', url: `${prefix}/roots`, payload: { path } })).statusCode).toBe(400);
    expect(store.snapshot().state.discovery!.roots).toEqual([]);
    expect((await app.inject({ method: 'POST', url: `${prefix}/roots`, payload: { path: fixture } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `${prefix}/scans` })).statusCode).toBe(202);
    await vi.waitFor(() => expect(store.snapshot().state.discovery!.operation?.status).toBe('complete'));
    expect(store.snapshot().state.discovery!.operation).toMatchObject({ foundCount: 0, retainedCount: 0, coverage: 'complete' });
    expect(store.snapshot().state.discovery!.operation?.message).toContain('No Git checkouts');
    expect(store.snapshot().state.discovery!.operation?.message).toContain('Use as local project');
    expect(await readdir(fixture)).toEqual([]);
  });

  it('explicitly connects the allowed folder without Git, preserves saved choices and repeats without another house', async () => {
    const savedOperation = { id: 'prior-scan', status: 'complete' as const, startedAt: before, finishedAt: before, message: 'Prior scan', coverage: 'complete' as const, foundCount: 0 };
    store.commit('fixture-seed', state => { state.discovery!.roots = [fixture]; state.repositories = [remote('github-selected')]; state.discovery!.candidates = [...state.repositories, remote('github-candidate')]; state.discovery!.operation = savedOperation; return 'fixture'; });
    closeRepository = registerRepositoryApi(app, { store: () => store, listGitHub: async () => listing() });
    const connect = () => app.inject({ method: 'POST', url: `${prefix}/projects/local`, payload: { path: fixture } });
    const response = await connect(); expect(response.statusCode).toBe(200);
    const connected = response.json();
    expect(connected).toMatchObject({ duplicate: false, repository: { id: localRepositoryId(fixture), source: 'local', projectKind: 'folder', localPath: fixture, selectedRoot: fixture, branch: 'Unavailable', discoveryStatus: { state: 'current' }, git: { availability: 'unavailable', head: null, changedFiles: null, untrackedFiles: null, reason: 'not-a-git-repository' }, instructions: [] } });
    expect(connected.repository.scan).toBeUndefined();
    expect(connected.snapshot.state.repositories.map((repo: Repository) => repo.id)).toEqual(['github-selected', connected.repository.id]);
    expect(connected.snapshot.state.discovery.operation).toEqual(savedOperation);
    expect(connected.snapshot.state.discovery.candidates.map((repo: Repository) => repo.id)).toEqual(['github-selected', connected.repository.id, 'github-candidate']);
    const repeated = (await connect()).json();
    expect(repeated).toMatchObject({ duplicate: true, repository: { id: connected.repository.id, position: connected.repository.position } });
    expect(store.snapshot().state.repositories).toHaveLength(2);
    expect(store.snapshot().state.agents).toEqual([]);
    expect(await readdir(fixture)).toEqual([]);
  });

  it('rejects unallowed, relative, missing, file and linked project paths without changing the inventory', async () => {
    const root = join(fixture, 'allowed'), outside = join(fixture, 'outside');
    await mkdir(root); await mkdir(outside); await writeFile(join(root, 'file.txt'), 'fixture');
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(root, join(root, 'internal-link'), process.platform === 'win32' ? 'junction' : 'dir');
    closeRepository = registerRepositoryApi(app, { store: () => store, listGitHub: async () => listing() });
    expect((await app.inject({ method: 'POST', url: `${prefix}/projects/local`, payload: { path: root } })).statusCode).toBe(400);
    store.commit('fixture-root', state => { state.discovery!.roots = [root]; return 'fixture'; });
    for (const path of [outside, '.', join(root, 'missing'), join(root, 'file.txt'), join(root, 'escape'), join(root, 'internal-link')]) {
      expect((await app.inject({ method: 'POST', url: `${prefix}/projects/local`, payload: { path } })).statusCode, path).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: `${prefix}/projects/local`, payload: { path: root, initializeGit: true } })).statusCode).toBe(400);
    expect(store.snapshot().state.repositories).toEqual([]);
    expect(store.snapshot().state.discovery!.candidates).toEqual([]);
  });

  it('keeps explicit folders current through zero and partial Git scans, then upgrades the same house in place', async () => {
    store.commit('fixture-root', state => { state.discovery!.roots = [fixture]; return 'fixture'; });
    let phase: 'empty' | 'partial' | 'git' = 'empty';
    closeRepository = registerRepositoryApi(app, { store: () => store, listGitHub: async () => listing(), discover: async () => ({ ...result(),
      ...(phase === 'partial' ? { coverage: { ...result().coverage, status: 'partial' as const, issues: ['entry-limit' as const] } } : {}),
      repositories: phase !== 'git' ? [] : [{ id: localRepositoryId(fixture), name: 'Now Git', canonicalPath: fixture, rootPath: fixture, kind: 'checkout', commonGitDirectory: join(fixture, '.git'), scannedAt: before, fingerprint: 'fixture', instructions: [], git: { availability: 'available', branch: 'main', head: 'a'.repeat(40), changedFiles: 0, untrackedFiles: null, scope: 'tracked-files', refreshedAt: before, reason: null } }],
    }) });
    const connected = (await app.inject({ method: 'POST', url: `${prefix}/projects/local`, payload: { path: fixture } })).json().repository;
    const scan = async () => { expect((await app.inject({ method: 'POST', url: `${prefix}/scans` })).statusCode).toBe(202); await vi.waitFor(() => expect(store.snapshot().state.discovery!.operation?.status).toBe('complete')); };
    await scan();
    expect(store.snapshot().state.repositories[0]).toMatchObject({ id: connected.id, projectKind: 'folder', discoveryStatus: { state: 'current' } });
    expect(store.snapshot().state.discovery!.operation?.foundCount).toBe(0);
    phase = 'partial'; await scan();
    expect(store.snapshot().state.repositories[0]?.discoveryStatus?.state).toBe('current');
    phase = 'git'; await scan();
    expect(store.snapshot().state.repositories).toHaveLength(1);
    expect(store.snapshot().state.repositories[0]).toMatchObject({ id: connected.id, projectKind: 'git', name: 'Now Git', position: connected.position, color: connected.color, branch: 'main', discoveryStatus: { state: 'current' }, git: { availability: 'available' } });
    expect(await readdir(fixture)).toEqual([]);
  });

  it('fills an unused house slot without moving selected repositories or using a colliding candidate position', async () => {
    await mkdir(join(fixture, '.git'));
    const first = { ...remote('first'), position: [-6, -3.3] as [number, number] };
    const third = { ...remote('third'), position: [-5, 5.5] as [number, number] };
    const candidate = { ...local(localRepositoryId(fixture)), localPath: fixture, selectedRoot: fixture, position: third.position };
    store.commit('fixture-holes', state => { state.discovery!.roots = [fixture]; state.repositories = [first, third]; state.discovery!.candidates = [first, third, candidate]; return 'fixture'; });
    closeRepository = registerRepositoryApi(app, { store: () => store, listGitHub: async () => listing() });
    const response = await app.inject({ method: 'POST', url: `${prefix}/projects/local`, payload: { path: fixture } });
    expect(response.statusCode).toBe(200);
    const saved = store.snapshot().state.repositories;
    expect(saved.slice(0, 2)).toEqual([first, third]);
    expect(saved[2]?.position).toEqual([5.7, -3.8]);
    expect(new Set(saved.map(repo => JSON.stringify(repo.position))).size).toBe(3);
    expect((await app.inject({ method: 'POST', url: `${prefix}/projects/local`, payload: { path: fixture } })).json().repository.position).toEqual(saved[2]?.position);
  });

  it('checks actual folder disappearance and recovery separately from Git inventory', async () => {
    const project = join(fixture, 'project'); await mkdir(project);
    store.commit('fixture-root', state => { state.discovery!.roots = [fixture]; return 'fixture'; });
    closeRepository = registerRepositoryApi(app, { store: () => store, listGitHub: async () => listing(), discover: async () => result() });
    const connected = (await app.inject({ method: 'POST', url: `${prefix}/projects/local`, payload: { path: project } })).json().repository;
    await rmdir(project);
    const scan = async () => { expect((await app.inject({ method: 'POST', url: `${prefix}/scans` })).statusCode).toBe(202); await vi.waitFor(() => expect(store.snapshot().state.discovery!.operation?.status).toBe('complete')); };
    await scan();
    expect(store.snapshot().state.repositories[0]).toMatchObject({ id: connected.id, discoveryStatus: { state: 'unavailable', lastVerifiedAt: connected.discoveryStatus.lastVerifiedAt, reasons: ['project-folder-unavailable'] } });
    await mkdir(project); await scan();
    expect(store.snapshot().state.repositories[0]).toMatchObject({ id: connected.id, discoveryStatus: { state: 'current' }, projectKind: 'folder' });
  });

  it('reuses verified Git candidates and enforces selected-project capacity and ownership', async () => {
    await mkdir(join(fixture, '.git'));
    const candidate = { ...local(localRepositoryId(fixture)), localPath: fixture, selectedRoot: fixture };
    store.commit('fixture-root', state => { state.discovery!.roots = [fixture]; state.discovery!.candidates = [candidate]; return 'fixture'; });
    let owned = true;
    closeRepository = registerRepositoryApi(app, { store: () => { if (!owned) throw new IdentityError('WORKSPACE_NOT_FOUND', 'Not available', 404); return store; }, listGitHub: async () => listing() });
    const response = await app.inject({ method: 'POST', url: `${prefix}/projects/local`, payload: { path: fixture } });
    expect(response.json().repository).toMatchObject({ id: candidate.id, projectKind: 'git', branch: 'main', git: candidate.git });
    const child = join(fixture, 'child'); await mkdir(child);
    store.commit('fixture-capacity', state => { state.repositories = Array.from({ length: 100 }, (_, index) => remote(`github-${index}`)); return 'fixture'; });
    expect((await app.inject({ method: 'POST', url: `${prefix}/projects/local`, payload: { path: child } })).json()).toMatchObject({ statusCode: 400, code: 'REPOSITORY_LIMIT' });
    owned = false;
    expect((await app.inject({ method: 'POST', url: `${prefix}/projects/local`, payload: { path: fixture } })).statusCode).toBe(404);
    expect(store.snapshot().state.repositories).toHaveLength(100);
  });

  it('rechecks ownership after inspecting the folder and saves no project if access was revoked', async () => {
    store.commit('fixture-root', state => { state.discovery!.roots = [fixture]; return 'fixture'; });
    const beforeRegistration = store.snapshot();
    let checks = 0;
    closeRepository = registerRepositoryApi(app, { store: () => {
      if (++checks > 1) throw new IdentityError('WORKSPACE_NOT_FOUND', 'Not available', 404);
      return store;
    }, listGitHub: async () => listing() });
    expect((await app.inject({ method: 'POST', url: `${prefix}/projects/local`, payload: { path: fixture } })).statusCode).toBe(404);
    expect(checks).toBe(2);
    expect(store.snapshot()).toEqual(beforeRegistration);
  });

  it('uses the normal reviewed root removal and archives folder metadata without deleting files', async () => {
    store.commit('fixture-root', state => { state.discovery!.roots = [fixture]; return 'fixture'; });
    closeRepository = registerRepositoryApi(app, { store: () => store, listGitHub: async () => listing() });
    const connected = (await app.inject({ method: 'POST', url: `${prefix}/projects/local`, payload: { path: fixture } })).json().repository;
    const review = (await app.inject({ method: 'POST', url: `${prefix}/roots/remove/preview`, payload: { path: fixture } })).json();
    expect(review.allowed).toBe(true);
    expect((await app.inject({ method: 'POST', url: `${prefix}/roots/remove`, payload: { path: fixture, reviewToken: review.reviewToken } })).statusCode).toBe(200);
    expect(store.snapshot().state.repositories).toEqual([]);
    expect(store.snapshot().state.discovery!.candidates).toEqual([]);
    expect(store.repositoryHistory(connected.id).repository.projectKind).toBe('folder');
    expect(await readdir(fixture)).toEqual([]);
  });

  it('persists partial and cancelled attempts as stale while preserving remote records and the last verification', async () => {
    store.commit('fixture-seed', state => { state.discovery!.roots = [fixture]; state.repositories = [local('local-one'), remote('github-one')]; state.discovery!.candidates = [...state.repositories]; return 'fixture'; });
    let cancelPhase = false;
    closeRepository = registerRepositoryApi(app, { store: () => store, listGitHub: async () => listing(), discover: async (_roots, options) => {
      if (!cancelPhase) return { ...result(), coverage: { ...result().coverage, status: 'partial', issues: ['unreadable-entry'] } };
      return new Promise((_resolve, reject) => { options!.signal!.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }); });
    } });
    await app.inject({ method: 'POST', url: `${prefix}/scans` });
    await vi.waitFor(() => expect(store.snapshot().state.discovery!.operation?.status).toBe('complete'));
    expect(store.snapshot().state.repositories[0]?.discoveryStatus).toMatchObject({ state: 'stale', lastVerifiedAt: before, reasons: ['unreadable-entry'] });
    expect(store.snapshot().state.repositories[1]).toEqual(remote('github-one'));
    cancelPhase = true;
    const scan = (await app.inject({ method: 'POST', url: `${prefix}/scans` })).json<{ operationId: string }>();
    expect((await app.inject({ method: 'POST', url: `${prefix}/scans/${scan.operationId}/cancel` })).statusCode).toBe(200);
    await vi.waitFor(() => expect(store.snapshot().state.discovery!.operation?.status).toBe('cancelled'));
    expect(store.snapshot().state.repositories[0]?.discoveryStatus).toMatchObject({ state: 'stale', lastVerifiedAt: before, reasons: ['cancelled'] });
  });

  it('returns exactly the retained GitHub results and matching counts when local candidates consume capacity', async () => {
    store.commit('fixture-seed', state => { state.discovery!.candidates = Array.from({ length: 100 }, (_, index) => local(`local-${index}`)); state.repositories = [remote('github-250')]; return 'fixture'; });
    closeRepository = registerRepositoryApi(app, { store: () => store, listGitHub: async () => listing(250) });
    const response = (await app.inject({ method: 'POST', url: `${prefix}/github/repositories` })).json();
    expect(response.repositories).toHaveLength(100);
    expect(response).toMatchObject({ partial: true, diagnostics: { receivedCount: 250, retainedCount: 100, selectableCount: 100, reasons: ['candidate-limit'] } });
    expect(store.snapshot().state.repositories[0]).toMatchObject({ name: 'fixture/repo-249', discoveryStatus: { state: 'current' } });
    expect(store.snapshot().state.discovery!.candidates).toHaveLength(200);
  });

  it('serializes GitHub checks and rechecks ownership before saving delayed results', async () => {
    let owned = true, release!: (value: GitHubRepositoryListing) => void;
    const provider = vi.fn(() => new Promise<GitHubRepositoryListing>(resolve => { release = resolve; }));
    closeRepository = registerRepositoryApi(app, { store: () => { if (!owned) throw new IdentityError('WORKSPACE_NOT_FOUND', 'Not available', 404); return store; }, listGitHub: provider });
    const first = app.inject({ method: 'POST', url: `${prefix}/github/repositories` });
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
    expect((await app.inject({ method: 'POST', url: `${prefix}/github/repositories` })).statusCode).toBe(409);
    owned = false; release(listing(1));
    expect((await first).statusCode).toBe(404);
    expect(store.snapshot().state.discovery!.candidates).toEqual([]);
    expect(store.snapshot().state.discovery!.githubListing).toBeUndefined();
  });

  it('preserves revoked metadata as stale and rejects newly selecting it until verification recovers', async () => {
    store.commit('fixture-seed', state => { state.discovery!.candidates = [remote('github-one')]; return 'fixture'; });
    closeRepository = registerRepositoryApi(app, { store: () => store, listGitHub: async () => { throw new IdentityError('github_unauthorized', 'Sign in again.', 401); } });
    expect((await app.inject({ method: 'POST', url: `${prefix}/github/repositories` })).statusCode).toBe(401);
    expect(store.snapshot().state.discovery!.githubListing).toMatchObject({ status: 'failed', installationCount: null, reasons: ['github_unauthorized'] });
    expect(store.snapshot().state.discovery!.candidates[0]?.discoveryStatus).toMatchObject({ state: 'stale', lastVerifiedAt: before });
    expect((await app.inject({ method: 'POST', url: `${prefix}/repositories/select`, payload: { ids: ['github-one'] } })).statusCode).toBe(409);
    expect(store.snapshot().state.repositories).toEqual([]);
  });

  it('requires a fresh removal review and preserves repository metadata and all files on disconnect', async () => {
    store.commit('fixture-seed', state => { state.discovery!.roots = [fixture]; state.repositories = [{ ...local('local-one'), selectedRoot: fixture, localPath: fixture }]; return 'fixture'; });
    closeRepository = registerRepositoryApi(app, { store: () => store, listGitHub: async () => listing() });
    const preview = async () => (await app.inject({ method: 'POST', url: `${prefix}/roots/remove/preview`, payload: { path: fixture } })).json();
    const first = await preview(); expect(first.allowed).toBe(true);
    store.commit('rename-fixture', state => { state.repositories[0]!.name = 'Changed metadata'; return 'repository.refreshed'; });
    expect((await app.inject({ method: 'POST', url: `${prefix}/roots/remove`, payload: { path: fixture, reviewToken: first.reviewToken } })).statusCode).toBe(409);
    const reviewed = await preview();
    expect((await app.inject({ method: 'POST', url: `${prefix}/roots/remove`, payload: { path: fixture, reviewToken: reviewed.reviewToken } })).statusCode).toBe(200);
    expect(store.snapshot().state.repositories).toEqual([]);
    expect(store.snapshot().state.discovery!.roots).toEqual([]);
    expect(store.repositoryHistory('local-one').repository.name).toBe('Changed metadata');
    expect(await readdir(fixture)).toEqual([]);
  });
});
