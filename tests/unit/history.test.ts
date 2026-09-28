import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Handoff, NativeHideAllCounts, NativeSource, ObservationConnection, ObservationEvent } from '@agent-town/contracts';
import { Store } from '../../apps/service/src/store';
import { privateState } from '../../apps/service/src/workspaces';
import { applyObservation } from '../../apps/service/src/observation/reducer';
import { archiveReview, requireRepositoryRemovable, rootRemovalReview } from '../../apps/service/src/history-state';
import { registerHistoryApi } from '../../apps/service/src/history-api';
import { IdentityError } from '../../apps/service/src/identity/types';

let folder: string, store: Store;
const timestamp = () => new Date().toISOString();
const connection: ObservationConnection = { id: 'fixture-connection', provider: 'codex', repoId: 'fixture-repo', label: 'Fixture', status: 'receiving', createdAt: '2026-09-14T00:00:00Z', lastEventAt: null, version: null, coverage: 'partial', droppedEvents: 0 };
const seed = () => {
  const state = privateState({ id: 'fixture-workspace', name: 'Fixture', kind: 'personal' });
  state.repositories = [{ id: 'fixture-repo', name: 'Fixture repository', source: 'local', localPath: 'C:\\fixture-projects\\checkout', selectedRoot: 'C:\\fixture-projects', description: 'Fixture', language: 'Unavailable', branch: 'main', color: '#aaaaaa', position: [8, 8] }];
  state.discovery!.roots = ['C:\\fixture-projects']; state.observation = { connections: [structuredClone(connection)] };
  return state;
};
const receive = (event: ObservationEvent) => store.commit(`observe:${connection.id}:${event.id}`, (state, now) => {
  const archived = store.archivedObservation(connection.id, event.sessionId, event.parentSessionId ?? null);
  const type = applyObservation(state, connection, event, now, archived);
  if (archived) store.saveArchivedObservation(archived, state, now);
  return type;
}, JSON.stringify(event));
const event = (id: string, kind: ObservationEvent['kind'], sequence: number, extra: Partial<ObservationEvent> = {}): ObservationEvent => ({ id, kind, sessionId: 'session-one', occurredAt: timestamp(), sequence, ...extra });
const archive = () => { const state = store.snapshot().state, agent = state.agents[0]!; return store.archiveAgent(agent.id, archiveReview(state, agent).reviewToken); };
beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'agent-town-history-')); store = new Store(join(folder, 'town.sqlite'), seed()); });
afterEach(async () => { store.close(); const path = resolve(folder); if (!path.startsWith(`${resolve(tmpdir())}${sep}agent-town-history-`)) throw new Error('Unsafe fixture cleanup'); await rm(path, { recursive: true, force: true }); });

describe('durable session history', () => {
  it('pages active reports by saved time with stable ties without archiving or changing the workspace', () => {
    receive(event('start-report-reader', 'session.start', 1));
    const id = store.snapshot().state.agents[0]!.id;
    const report = (id: string, createdAt: string, agentId: string): Handoff => ({ id, agentId, repoId: connection.repoId, createdAt, summary: `Evidence ${id}`, status: 'saved', contextVersion: null, delivery: 'unsupported' });
    store.commit('mixed-report-order', state => {
      state.handoffs.push(report('report-b', '2026-09-15T12:00:00Z', id), report('report-old', '2026-09-14T12:00:00Z', id));
      state.handoffs.unshift(report('report-a', '2026-09-15T12:00:00Z', id), report('report-other', '2026-09-16T12:00:00Z', 'unknown-agent'));
      return 'handoff.saved';
    });
    const before = store.snapshot(), diagnostics = store.diagnostics();
    expect(store.agentReports(id, 0, 1)).toMatchObject({ reportCount: 3, reportsNextOffset: 1, reports: [{ id: 'report-a' }] });
    expect(store.agentReports(id, 1, 2)).toMatchObject({ reportCount: 3, reportsNextOffset: null, reports: [{ id: 'report-b' }, { id: 'report-old' }] });
    expect(store.agentReports(id, 3, 25)).toEqual({ reportCount: 3, reportsNextOffset: null, reports: [] });
    expect(() => store.agentReports('unknown-agent')).toThrowError(expect.objectContaining({ code: 'AGENT_NOT_FOUND', statusCode: 404 }));
    expect(() => store.agentReports(id, -1)).toThrow('Invalid report history page');
    expect(() => store.agentReports(id, 0, 51)).toThrow('Invalid report history page');
    expect(store.snapshot()).toEqual(before); expect(store.diagnostics()).toEqual(diagnostics); expect(store.history().total).toBe(0);
  });

  it.each(['hidden', 'overflow'] as const)('reads %s native session reports without creating a character or archive', visibility => {
    let id = '';
    store.commit('native-report-fixture', (state, now) => {
      const source = store.native.register('codex', 'C:\\fixture-native', 'Fixture native profile');
      store.native.discover(source, connection.repoId, Array.from({ length: visibility === 'overflow' ? 201 : 1 }, (_, index) => ({ nativeSessionId: `native-${index}`, projectPath: state.repositories[0]!.localPath!, createdAt: now, updatedAt: now })), state, now);
      const sessions = Array.from({ length: visibility === 'overflow' ? 9 : 1 }, (_, page) => store.native.page(state, { cursor: String(page * 25) }).items).flat();
      id = sessions.at(-1)!.agentId;
      if (visibility === 'overflow') for (const session of sessions) store.native.visibility(session.id, true, state, now);
      else store.native.visibility(id, false, state, now);
      state.handoffs.push({ id: 'native-saved-report', agentId: id, repoId: connection.repoId, createdAt: now, summary: 'Retained native evidence', status: 'saved', contextVersion: null, delivery: 'unsupported' });
      return 'handoff.saved';
    });
    const before = store.snapshot(), diagnostics = store.diagnostics();
    expect(before.state.agents.some(agent => agent.id === id)).toBe(false);
    expect(before.state.agents).toHaveLength(visibility === 'overflow' ? 200 : 0);
    expect(store.agentReports(id)).toMatchObject({ reports: [{ id: 'native-saved-report' }], reportCount: 1, reportsNextOffset: null });
    expect(store.snapshot()).toEqual(before); expect(store.diagnostics()).toEqual(diagnostics); expect(store.history().total).toBe(0);
    if (visibility === 'hidden') {
      const fixture = new Database(join(folder, 'town.sqlite'));
      fixture.prepare('INSERT INTO native_session_aliases(alias_key,session_id) VALUES(?,?)').run(JSON.stringify(['actor', 'merged-native-actor']), id); fixture.close();
      expect(store.agentReports('merged-native-actor')).toEqual(store.agentReports(id));
    }
  });

  it('keeps hide-all separate from archive: nothing is archived or deleted, reports stay readable, and the hidden state survives a restart (H0-12)', () => {
    let source!: NativeSource;
    store.commit('native-hide-source', () => { source = store.native.register('codex', 'C:\\fixture-native', 'Fixture native profile'); return 'observation.native_source_registered'; });
    const nativeConnection: ObservationConnection = { ...connection, id: 'native-fixture-connection', nativeSourceId: source.id, sourceRevision: source.revision, binding: 'declared' };
    const nativeEvent = (id: string, session: string, kind: ObservationEvent['kind'], summary?: string): ObservationEvent =>
      ({ id, sessionId: session, nativeSessionId: session, nativeSourceId: source.id, sourceRevision: source.revision, kind, occurredAt: timestamp(), ...(summary ? { summary } : {}) });
    const receiveNative = (value: ObservationEvent) => store.commit(`observe-native:${source.id}:${value.id}`, (state, now) => store.native.receive(state, nativeConnection, value, now) ?? 'observation.legacy');
    // One finished session is archived on purpose first; the hide-all below must not touch it.
    receiveNative(nativeEvent('finished', 'session-finished', 'session.end'));
    archive();
    receiveNative(nativeEvent('start-a', 'session-a', 'tool.start')); receiveNative(nativeEvent('report-a', 'session-a', 'turn.end', 'A saved report that must outlive hiding.')); receiveNative(nativeEvent('start-b', 'session-b', 'tool.start'));
    const state = store.snapshot().state, reported = state.agents.find(agent => agent.observation?.sessionId === 'session-a')!;
    const archiveBefore = store.history(), archivedCount = store.diagnostics().archivedAgents;
    expect(state.agents).toHaveLength(2); expect(archiveBefore.total).toBe(1); expect(archivedCount).toBe(1);

    let counts: NativeHideAllCounts | undefined;
    store.commit('hide-all-fixture', (current, now) => { counts = store.native.hideProject(connection.repoId, current, now); return 'observation.native_visibility_bulk'; });
    expect(counts).toEqual({ hidden: 2, alreadyHidden: 0, skippedLegacy: 0 });

    const check = () => {
      const after = store.snapshot().state;
      expect(after.agents).toHaveLength(0);
      // Hide is not archive: no archive row was added or changed, and a hidden session is not an archived one.
      expect(store.history()).toEqual(archiveBefore); expect(store.diagnostics().archivedAgents).toBe(archivedCount); expect(after.history?.archivedAgents).toBe(archivedCount);
      expect(() => store.historyDetail(reported.id)).toThrowError(expect.objectContaining({ code: 'HISTORY_NOT_FOUND' }));
      // Its saved report is still readable, and the session can still be opened from the inventory.
      expect(store.agentReports(reported.id)).toMatchObject({ reportCount: 1, reports: [{ summary: 'A saved report that must outlive hiding.' }] });
      expect(store.native.detail(reported.id, after)).toMatchObject({ id: reported.id, activity: 'reporting' });
      expect(store.native.page(after, { includeOlder: true }).items.filter(item => item.visibility === 'hidden')).toHaveLength(2);
    };
    check();
    store.close(); store = new Store(join(folder, 'town.sqlite'), seed());
    check();
    // A later event neither un-hides the session nor archives it.
    receiveNative({ ...nativeEvent('tool-later', 'session-b', 'tool.start'), occurredAt: new Date(Date.now() + 1000).toISOString() });
    expect(store.snapshot().state.agents).toHaveLength(0); expect(store.history()).toEqual(archiveBefore);
  });

  it('retains identity, reports and repository metadata across archive and restart without a live character', () => {
    receive(event('report-one', 'turn.end', 1, { summary: 'Fixture report', files: ['src/example.ts'] }));
    receive(event('end-one', 'session.end', 2));
    const id = store.snapshot().state.agents[0]!.id;
    archive();
    expect(store.snapshot().state.agents).toEqual([]);
    expect(store.snapshot().state.handoffs).toHaveLength(1);
    expect(store.history()).toMatchObject({ total: 1, items: [{ id, repositoryName: 'Fixture repository', activity: 'offline' }] });
    store.close(); store = new Store(join(folder, 'town.sqlite'), seed());
    expect(store.historyDetail(id)).toMatchObject({ agent: { id, activity: 'offline' }, repository: { id: 'fixture-repo' }, reportCount: 1, reports: [{ summary: 'Fixture report' }] });
    expect(store.agentReports(id)).toEqual({ reports: store.historyDetail(id).reports, reportCount: 1, reportsNextOffset: null });
    expect(store.snapshot().state.history?.archivedAgents).toBe(1);
  });

  it('saves an unseen delayed report once in history and only resumes on newer active evidence', () => {
    const endTime = timestamp();
    receive(event('end', 'session.end', 9, { occurredAt: endTime }));
    const id = store.snapshot().state.agents[0]!.id;
    const originalReview = archiveReview(store.snapshot().state, store.snapshot().state.agents[0]!);
    archive();
    const earlier = event('late-report', 'turn.end', 3, { occurredAt: new Date(Date.parse(endTime) - 1000).toISOString(), summary: 'Late evidence', files: ['earlier.ts'] });
    expect(receive(earlier).duplicate).toBe(false);
    expect(receive(earlier).duplicate).toBe(true);
    expect(store.snapshot().state.agents).toHaveLength(0);
    expect(store.historyDetail(id)).toMatchObject({ reportCount: 1, agent: { activity: 'offline', files: [], observation: { lastSequence: 9, sourceTime: endTime } } });
    receive(event('late-tool', 'tool.start', 4, { occurredAt: new Date(Date.parse(endTime) - 500).toISOString() }));
    expect(store.snapshot().state.agents).toHaveLength(0);
    receive(event('resume', 'turn.start', 10, { occurredAt: new Date(Date.parse(endTime) + 1000).toISOString() }));
    expect(store.snapshot().state.agents).toMatchObject([{ id, activity: 'working', observation: { lastSequence: 10 } }]);
    expect(store.history().total).toBe(0);
    expect(store.snapshot().state.handoffs).toHaveLength(1);
    expect(() => store.archiveAgent(id, originalReview.reviewToken)).toThrow('session changed');
  });

  it('journals an observation event on a full activity list in about a kilobyte, not a rewrite of every row', () => {
    store.commit('fill-activity', state => {
      state.activity = Array.from({ length: 500 }, (_, index) => ({ id: `seed-activity-${index}`, message: `Earlier event ${index} in the retained activity list`, createdAt: timestamp(), kind: 'work' as const }));
      return 'demo.tick';
    });
    receive(event('warm-up', 'session.start', 1));
    const before = store.diagnostics();
    for (let index = 0; index < 20; index++) receive(event(`tool-${index}`, 'tool.start', 2 + index, { tool: 'Read' }));
    const after = store.diagnostics();
    expect(store.snapshot().state.activity).toHaveLength(500);
    expect(after.events - before.events).toBe(20);
    expect((after.eventBytes - before.eventBytes) / 20).toBeLessThan(2500);
  });

  it('lets a finished child session be archived without treating an idle parent as ended, then resumes it on new work', () => {
    const child = (id: string, kind: ObservationEvent['kind'], sequence: number, extra: Partial<ObservationEvent> = {}) =>
      event(id, kind, sequence, { sessionId: 'child-session', parentSessionId: 'session-one', ...extra });
    receive(event('parent-start', 'session.start', 1));
    receive(child('child-start', 'session.start', 1));
    const review = (role: 'parent' | 'child') => { const state = store.snapshot().state; return archiveReview(state, state.agents.find(agent => role === 'child' ? agent.observation?.parentSessionId : !agent.observation?.parentSessionId)!); };
    expect(review('child').allowed).toBe(false);
    receive(child('child-stop', 'turn.end', 2, { summary: 'Child finished its part.' }));
    const finished = store.snapshot().state.agents.find(agent => agent.observation?.parentSessionId)!;
    expect(finished.activity).toBe('reporting');
    expect(review('child')).toMatchObject({ allowed: true, reasons: [], reportCount: 1 });
    receive(child('child-idle', 'turn.end', 3));
    expect(store.snapshot().state.agents.find(agent => agent.observation?.parentSessionId)!.activity).toBe('idle');
    expect(review('child').allowed).toBe(true);
    receive(event('parent-stop', 'turn.end', 2));
    expect(review('parent')).toMatchObject({ allowed: false });
    store.archiveAgent(finished.id, review('child').reviewToken);
    expect(store.snapshot().state.agents).toHaveLength(1);
    expect(store.history().total).toBe(1);
    expect(store.historyDetail(finished.id)).toMatchObject({ reportCount: 1, agent: { observation: { parentSessionId: 'session-one' } } });
    receive(child('child-resume', 'turn.start', 4, { occurredAt: new Date(Date.now() + 1000).toISOString() }));
    expect(store.snapshot().state.agents.find(agent => agent.id === finished.id)).toMatchObject({ activity: 'working' });
    expect(store.history().total).toBe(0);
  });

  it('supports more than 200 lifetime sessions through explicit archive while retaining every session identity', () => {
    for (let index = 0; index < 205; index++) { receive(event(`end-${index}`, 'session.end', 1, { sessionId: `session-${index}` })); archive(); }
    expect(store.snapshot().state.agents).toHaveLength(0);
    expect(store.history(0, 50)).toMatchObject({ total: 205, nextOffset: 50 });
    expect(store.history(200, 50)).toMatchObject({ total: 205, nextOffset: null });
    expect(store.history(200, 50).items).toHaveLength(5);
    expect(store.archivedObservation(connection.id, 'session-0', null)?.agent.observation?.sessionId).toBe('session-0');
    expect(store.snapshot().state.history?.archivedAgents).toBe(205);
  });

  it('keeps archived reports writable at live capacity and resumes without reusing an occupied home', () => {
    for (let index = 0; index < 200; index++) receive(event(`end-${index}`, 'session.end', 5, { sessionId: `full-${index}` }));
    const id = store.snapshot().state.agents[0]!.id;
    archive();
    receive(event('replacement', 'session.end', 1, { sessionId: 'replacement-session' }));
    receive(event('capacity-late-report', 'turn.end', 3, { sessionId: 'full-0', summary: 'Report survives full live town' }));
    expect(store.historyDetail(id).reportCount).toBe(1);
    const resume = event('capacity-resume', 'turn.start', 6, { sessionId: 'full-0', occurredAt: new Date(Date.now() + 1000).toISOString() });
    expect(() => receive(resume)).toThrowError(expect.objectContaining({ code: 'AGENT_CAPACITY' }));
    expect(store.historyDetail(id).agent.observation?.lastSequence).toBe(5);
    archive();
    expect(receive(resume).duplicate).toBe(false);
    const residents = store.snapshot().state.agents;
    expect(residents).toHaveLength(200);
    expect(residents.find(agent => agent.id === id)?.activity).toBe('working');
    expect(new Set(residents.map(agent => agent.home.join(','))).size).toBe(200);
  });

  it('rejects stale archive approval after a session resumes and rolls back archival on protected receipt exhaustion', () => {
    receive(event('end', 'session.end', 1));
    const state = store.snapshot().state, agent = state.agents[0]!, review = archiveReview(state, agent);
    receive(event('resume', 'turn.start', 2, { occurredAt: new Date(Date.now() + 1000).toISOString() }));
    expect(() => store.archiveAgent(agent.id, review.reviewToken)).toThrow('session changed');
    expect(store.history().total).toBe(0);
    expect(store.snapshot().state.agents).toHaveLength(1);
    store.close(); store = new Store(':memory:', seed(), { maxPinnedReceipts: 1 });
    receive(event('terminal', 'session.end', 1));
    store.commit('fill-protected-receipt', () => 'handoff.saved');
    expect(() => archive()).toThrow('protected action history limit');
    expect(store.history().total).toBe(0);
    expect(store.snapshot().state.agents).toHaveLength(1);
  });

  it('requires active connectors and work to be resolved before disconnect and preserves disconnected repository metadata', () => {
    const state = store.snapshot().state;
    expect(() => requireRepositoryRemovable(state, new Set(['fixture-repo']))).toThrow('observation connections');
    state.observation!.connections[0]!.status = 'revoked';
    expect(() => requireRepositoryRemovable(state, new Set(['fixture-repo']))).not.toThrow();
    const review = rootRemovalReview(state, 'C:\\fixture-projects');
    expect(review.allowed).toBe(true);
    store.commit('disconnect-fixture', (current, now) => { store.saveRepositoryHistory(current.repositories[0]!, now); current.repositories = []; return 'repository.disconnected'; });
    expect(store.repositoryHistory('fixture-repo').repository.name).toBe('Fixture repository');
  });

  it('makes a validated pre-v3 backup and migrates v2 state without deleting saved evidence', async () => {
    receive(event('report', 'turn.end', 1, { summary: 'Keep this report' }));
    const saved = store.snapshot(); store.close();
    const legacy = new Database(join(folder, 'town.sqlite'));
    legacy.exec('DROP TABLE agent_archive; DROP TABLE repository_archive; DROP TABLE native_sources; DROP TABLE native_sessions; DROP TABLE native_session_aliases; DELETE FROM __drizzle_migrations WHERE created_at>=1789401602000; PRAGMA user_version=2'); legacy.close();
    store = new Store(join(folder, 'town.sqlite'), seed());
    expect(store.snapshot()).toEqual(saved);
    expect(store.diagnostics().storageVersion).toBe(4);
    expect((await stat(join(folder, 'town.sqlite.before-v3.bak'))).size).toBeGreaterThan(0);
    expect(store.history().total).toBe(0);
  });

  it('backs up v3 before adding native identity indexes without changing existing character IDs or reports', async () => {
    receive(event('keep-native-history', 'turn.end', 1, { summary: 'Retain existing evidence' }));
    const saved = store.snapshot(); store.close();
    const previous = new Database(join(folder, 'town.sqlite'));
    previous.exec('DROP TABLE native_sources; DROP TABLE native_sessions; DROP TABLE native_session_aliases; DELETE FROM __drizzle_migrations WHERE created_at=1789401603000; PRAGMA user_version=3'); previous.close();
    store = new Store(join(folder, 'town.sqlite'), seed());
    expect(store.snapshot()).toEqual(saved); expect(store.native.sources()).toEqual([]);
    expect((await stat(join(folder, 'town.sqlite.before-v4.bak'))).size).toBeGreaterThan(0);
  });

  it('applies ownership checks to history/detail/archive routes and validates pagination', async () => {
    const app = Fastify({ logger: false });
    registerHistoryApi(app, request => { if ((request.params as { id: string }).id !== 'fixture-workspace') throw new IdentityError('WORKSPACE_NOT_FOUND', 'Unavailable', 404); return store; });
    try {
      expect((await app.inject('/api/v1/workspaces/other/history/agents')).statusCode).toBe(404);
      expect((await app.inject('/api/v1/workspaces/fixture-workspace/history/agents?limit=500')).statusCode).toBe(400);
      expect((await app.inject('/api/v1/workspaces/fixture-workspace/agents/missing/reports')).statusCode).toBe(404);
      receive(event('end', 'session.end', 1));
      const id = store.snapshot().state.agents[0]!.id;
      const beforeRead = store.snapshot();
      expect((await app.inject(`/api/v1/workspaces/fixture-workspace/agents/${id}/reports`)).json()).toEqual({ reports: [], reportCount: 0, reportsNextOffset: null });
      for (const query of ['limit=51', 'offset=-1', 'offset=1.5', 'unexpected=true']) expect((await app.inject(`/api/v1/workspaces/fixture-workspace/agents/${id}/reports?${query}`)).statusCode).toBe(400);
      expect((await app.inject(`/api/v1/workspaces/other/agents/${id}/reports`)).statusCode).toBe(404);
      expect(store.snapshot()).toEqual(beforeRead);
      const review = (await app.inject(`/api/v1/workspaces/fixture-workspace/agents/${id}/archive`)).json();
      expect(review.allowed).toBe(true);
      expect((await app.inject({ method: 'POST', url: `/api/v1/workspaces/fixture-workspace/agents/${id}/archive`, payload: { reviewToken: review.reviewToken } })).statusCode).toBe(200);
      expect((await app.inject(`/api/v1/workspaces/fixture-workspace/history/agents/${id}`)).json()).toMatchObject({ reportCount: 0, agent: { id } });
      expect((await app.inject(`/api/v1/workspaces/fixture-workspace/agents/${id}/reports`)).json()).toEqual({ reports: [], reportCount: 0, reportsNextOffset: null });
      expect((await app.inject(`/api/v1/workspaces/other/history/agents/${id}`)).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it('review tokens ignore scan/discoveryStatus/picture fields but still change on a real blocking-relevant change', () => {
    receive(event('end', 'session.end', 1));
    const state = store.snapshot().state;
    const agent = state.agents[0]!;
    const before = archiveReview(state, agent).reviewToken;

    // A background rescan updating repository.scan/discoveryStatus, and the agent's own
    // updatedAt/files/evidence churning, must never change the token.
    const rescanned = structuredClone(state);
    const repo = rescanned.repositories.find(r => r.id === agent.repoId)!;
    repo.scan = { at: timestamp(), coverage: 'complete', reasons: [] };
    repo.discoveryStatus = { state: 'stale', checkedAt: timestamp(), lastVerifiedAt: null, reasons: ['drifted'] };
    const rescannedAgent = { ...agent, updatedAt: timestamp(), files: ['a.ts', 'b.ts'], evidence: 'different evidence text' };
    expect(archiveReview(rescanned, rescannedAgent).reviewToken).toBe(before);

    // A real, blocking-relevant change (activity) must change the token.
    const changed = { ...agent, activity: agent.activity === 'idle' ? 'working' as const : 'idle' as const };
    expect(archiveReview(state, changed).reviewToken).not.toBe(before);
  });

  it('root-removal review tokens ignore scan/discoveryStatus/picture fields but still change when a repository is added or its root changes', () => {
    const state = store.snapshot().state;
    const before = rootRemovalReview(state, 'C:\\fixture-projects').reviewToken;

    const rescanned = structuredClone(state);
    rescanned.repositories[0]!.scan = { at: timestamp(), coverage: 'complete', reasons: [] };
    rescanned.repositories[0]!.discoveryStatus = { state: 'stale', checkedAt: timestamp(), lastVerifiedAt: null, reasons: ['drifted'] };
    expect(rootRemovalReview(rescanned, 'C:\\fixture-projects').reviewToken).toBe(before);

    const withExtraRepo = structuredClone(state);
    withExtraRepo.repositories.push({ id: 'second-repo', name: 'Second', source: 'local', localPath: 'C:\\fixture-projects\\second', selectedRoot: 'C:\\fixture-projects', description: '', language: 'Unavailable', branch: 'main', color: '#bbbbbb', position: [9, 9] });
    expect(rootRemovalReview(withExtraRepo, 'C:\\fixture-projects').reviewToken).not.toBe(before);
  });
});
