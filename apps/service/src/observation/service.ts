import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { bindNativeSourceSchema, createObservationSchema, observationBatchSchema, type ObservationEvent, type ObservationConnection } from '@agent-town/contracts';
import type { Store } from '../store.js';
import { IdentityError, type CredentialVault } from '../identity/index.js';
import { checkedPath } from '../discovery/paths.js';
import { ObservationRegistry, type RegisteredObservation } from './registry.js';
import { applyObservation, observationReceiptKey } from './reducer.js';
import { inspectObservationSetup, writeBridgeConfig, changeHooks, spoolPath } from './setup.js';
import { drainObservationSpool } from './spool.js';
import { registerNativeApi } from './native-api.js';

interface Dependencies {
  directory: string;
  vault: CredentialVault;
  scoped(request: FastifyRequest): { ownerId: string; store: Store };
  workspace(ownerId: string, workspaceId: string): Store;
}

export function registerObservationApi(app: FastifyInstance, dependencies: Dependencies) {
  const native = registerNativeApi(app, dependencies.scoped);
  const registry = new ObservationRegistry(join(dependencies.directory, 'observation.sqlite'));
  const rate = new Map<string, { start: number; count: number }>();
  const unavailableWorkspaces = new Set<string>();
  const blockedByWorkspaceFailure = new Set<string>();
  let active: Promise<void> | null = null;
  let closing = false;
  const prefix = '/api/v1/workspaces/:id/observation/connections';

  const authorize = (request: FastifyRequest) => {
    const scope = dependencies.scoped(request);
    const record = registry.get((request.params as { connectionId: string }).connectionId);
    if (!record || record.ownerId !== scope.ownerId || record.workspaceId !== scope.store.snapshot().state.workspace.id) throw new IdentityError('CONNECTION_NOT_FOUND', 'This observation connection is unavailable.', 404);
    return { ...scope, record };
  };
  const receive = (record: RegisteredObservation, events: ObservationEvent[]) => {
    const current = registry.get(record.connection.id);
    if (!current || current.connection.status === 'revoked') throw new IdentityError('CONNECTION_REVOKED', 'This observation connection was revoked.', 403);
    const store = dependencies.workspace(record.ownerId, record.workspaceId);
    const now = Date.now(), bucket = rate.get(record.connection.id);
    const next = !bucket || now - bucket.start >= 60000 ? { start: now, count: 0 } : bucket;
    if (next.count + events.length > 1200) throw new IdentityError('SOURCE_RATE_LIMIT', 'This observation source reached its per-minute limit.', 429);
    next.count += events.length; rate.set(record.connection.id, next);
    let accepted = 0, duplicate = 0;
    for (const event of events) {
      // Authorize even duplicate receipts; an old receipt never bypasses profile
      // revocation or revision checks. Transport aliases are not event identity.
      const fingerprint = store.native.receiptFingerprint(current.connection, event, store.snapshot().state);
      const result = store.commit(observationReceiptKey(current.connection, event), (state, at) => {
        const canonical = store.native.receive(state, current.connection, event, at);
        if (canonical !== null) return canonical;
        const archived = store.archivedObservation(record.connection.id, event.sessionId, event.parentSessionId ?? null);
        const type = applyObservation(state, record.connection, event, at, archived);
        if (archived) store.saveArchivedObservation(archived, state, at);
        return type;
      }, fingerprint);
      if (result.duplicate) duplicate++; else accepted++;
    }
    return { accepted, duplicate };
  };

  app.post(prefix, async request => {
    const { ownerId, store } = dependencies.scoped(request);
    const parsed = createObservationSchema.safeParse(request.body);
    if (!parsed.success) throw new IdentityError('INVALID_CONNECTION', 'Choose a tool, local project, and connection name.');
    const state = store.snapshot().state;
    const repo = state.repositories.find(repo => repo.id === parsed.data.repoId && repo.source === 'local');
    if (!repo?.localPath) throw new IdentityError('LOCAL_REPOSITORY_REQUIRED', 'Connect a selected local project first.');
    await checkedPath(repo.localPath, state.discovery?.roots ?? []);
    dependencies.scoped(request);
    if (registry.all().some(record => record.workspaceId === state.workspace.id && record.connection.provider === parsed.data.provider && record.connection.repoId === repo.id && record.connection.nativeSourceId === parsed.data.nativeSourceId)) throw new IdentityError('CONNECTION_EXISTS', 'This tool and profile already have an active connection for this repository.', 409);
    const connection: ObservationConnection = { id: randomUUID(), provider: parsed.data.provider, repoId: repo.id, label: parsed.data.label, status: 'unverified', createdAt: new Date().toISOString(), lastEventAt: null, version: null, coverage: 'partial', droppedEvents: 0, droppedEventsExact: true };
    const record: RegisteredObservation = { connection, ownerId, workspaceId: state.workspace.id, repoPath: repo.localPath };
    if (parsed.data.nativeSourceId) {
      const stored = store.native.source(parsed.data.nativeSourceId);
      if (!stored || stored.source.status !== 'ready' || stored.source.provider !== connection.provider) throw new IdentityError('NATIVE_SOURCE_MISMATCH', 'Choose an approved local profile for this tool.', 400);
      await checkedPath(stored.homePath, [stored.homePath]);
      connection.nativeSourceId = stored.source.id; connection.sourceRevision = stored.source.revision; connection.binding = 'declared'; record.nativeHome = stored.homePath;
    }
    const token = randomBytes(32).toString('hex');
    await dependencies.vault.put(`observation-${connection.id}`, token);
    try {
      dependencies.scoped(request);
      registry.register(record, token); await writeBridgeConfig(record, dependencies.directory);
      store.commit(`connection-create:${connection.id}`, state => { state.observation ??= { connections: [] }; state.observation.connections.push(connection); return 'observation.registered'; });
      return inspectObservationSetup(record, dependencies.directory);
    } catch (error) { registry.revoke(connection.id); await dependencies.vault.delete(`observation-${connection.id}`).catch(() => undefined); throw error; }
  });
  app.get(`${prefix}/:connectionId/setup`, async request => {
    const { record, store } = authorize(request);
    const latest = store.snapshot().state.observation?.connections.find(item => item.id === record.connection.id);
    return inspectObservationSetup({ ...record, connection: latest ?? record.connection }, dependencies.directory);
  });
  app.post(`${prefix}/:connectionId/source`, async request => {
    const { record, store } = authorize(request), parsed = bindNativeSourceSchema.safeParse(request.body);
    if (!parsed.success) throw new IdentityError('INVALID_NATIVE_SOURCE', 'Choose an approved local profile.');
    const stored = store.native.source(parsed.data.nativeSourceId);
    if (!stored || stored.source.status !== 'ready' || stored.source.provider !== record.connection.provider) throw new IdentityError('NATIVE_SOURCE_MISMATCH', 'Choose an approved profile for this agent tool.', 400);
    await checkedPath(stored.homePath, [stored.homePath]); authorize(request);
    const next = registry.bindSource(record.connection.id, { id: stored.source.id, revision: stored.source.revision, homePath: stored.homePath });
    await writeBridgeConfig(next, dependencies.directory);
    store.commit(`connection-source:${randomUUID()}`, state => {
      const item = state.observation?.connections.find(c => c.id === record.connection.id);
      if (item) Object.assign(item, { nativeSourceId: stored.source.id, sourceRevision: stored.source.revision, binding: 'declared' });
      store.native.preserveLegacyAliases(state); return 'observation.source_bound';
    });
    return inspectObservationSetup(next, dependencies.directory);
  });
  app.post(`${prefix}/:connectionId/apply`, async request => {
    const { record, store } = authorize(request);
    if (record.connection.status === 'revoked') throw new IdentityError('CONNECTION_REVOKED', 'Create a new connection before installing hooks.', 409);
    const result = await changeHooks(record, dependencies.directory, dependencies.vault);
    store.commit(`hooks-applied:${randomUUID()}`, state => { state.activity.unshift({ id: randomUUID(), message: `Observation hooks applied for ${record.connection.provider}. Trigger a native session to verify receipt.`, createdAt: new Date().toISOString(), kind: 'system' }); return 'observation.hooks_applied'; });
    return result;
  });
  app.post(`${prefix}/:connectionId/remove-hooks`, async request => {
    const { record } = authorize(request);
    return changeHooks(record, dependencies.directory, dependencies.vault, true);
  });
  app.post(`${prefix}/:connectionId/revoke`, async request => {
    const { record, store } = authorize(request);
    registry.revoke(record.connection.id);
    const result = store.commit(`connection-revoke:${randomUUID()}`, state => {
      const connection = state.observation?.connections.find(item => item.id === record.connection.id);
      if (connection) connection.status = 'revoked';
      for (const agent of state.agents) if (agent.observation?.connectionId === record.connection.id) agent.observation.freshness = 'stale';
      return 'observation.revoked';
    });
    await dependencies.vault.delete(`observation-${record.connection.id}`);
    return result;
  });
  app.post('/ingest/v1/events', { bodyLimit: 1024 * 1024 }, async request => {
    const record = registry.authenticate(request.headers.authorization);
    const batch = observationBatchSchema.safeParse(request.body);
    if (!batch.success) throw new IdentityError('INVALID_EVENTS', 'Use the normalized observation event contract.');
    return receive(record, batch.data.events);
  });

  const drain = async () => {
    for (const record of registry.all()) {
      if (closing) return;
      try {
        const store = dependencies.workspace(record.ownerId, record.workspaceId);
        unavailableWorkspaces.delete(record.workspaceId);
        // A workspace that just recovered first gets a durable blocked marker for the
        // outage; normal delivery (which could immediately overwrite it with 'idle')
        // resumes on the next cycle instead of within this same recovery tick.
        if (blockedByWorkspaceFailure.delete(record.connection.id)) {
          store.commit(`workspace-recovered:${randomUUID()}`, (state, now) => {
            const source = state.observation?.connections.find(item => item.id === record.connection.id);
            if (source && source.status !== 'revoked') source.delivery = { status: 'blocked', pendingEvents: null, lastAttemptAt: now, message: 'The workspace was briefly unavailable and observation delivery was paused. Retry follows automatically.' };
            return 'observation.delivery';
          });
          continue;
        }
        await drainObservationSpool({ directory: dependencies.directory, spool: spoolPath(dependencies.directory, record.connection.id), record, store, receive: events => receive(record, events), closing: () => closing });
      } catch {
        if (!unavailableWorkspaces.has(record.workspaceId)) app.log.warn('Observation replay could not open a scoped workspace. Pending local files were retained.');
        unavailableWorkspaces.add(record.workspaceId); blockedByWorkspaceFailure.add(record.connection.id);
      }
    }
  };
  const timer = setInterval(() => {
    if (active || closing) return;
    active = drain().catch(() => { app.log.warn('Observation replay could not read its local registry. Pending local files were retained.'); }).finally(() => { active = null; });
  }, 500);
  timer.unref();
  const staleTimer = setInterval(() => {
    for (const record of registry.all()) {
      try {
        const store = dependencies.workspace(record.ownerId, record.workspaceId);
        if (store.snapshot().state.agents.some(agent => agent.observation?.connectionId === record.connection.id && agent.observation.freshness !== 'stale' && Date.now() - Date.parse(agent.updatedAt) > 120000)) store.commit(`source-stale:${randomUUID()}`, state => { for (const agent of state.agents) if (agent.observation?.connectionId === record.connection.id && Date.now() - Date.parse(agent.updatedAt) > 120000) agent.observation.freshness = 'stale'; return 'observation.stale'; });
      } catch { /* A deleted workspace cannot receive updates. */ }
    }
  }, 30000); staleTimer.unref();
  return { registry, receive, close: async () => { closing = true; native.close(); clearInterval(timer); clearInterval(staleTimer); await active; registry.close(); } };
}
