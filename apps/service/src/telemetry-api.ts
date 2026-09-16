import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { apiInventoryRequestSchema, telemetryRegistrationSchema, type TelemetrySignal, type TelemetrySource } from '@agent-town/contracts';
import { decodeOtlp, emptyTelemetryState, encodeOtlpResponse, ingestTelemetry, scanApiInventory, TelemetryError, trafficForService } from './telemetry/index.js';
import { IdentityError, type CredentialVault } from './identity/index.js';
import type { Store } from './store.js';

interface Dependencies {
  directory: string; port: number; vault: CredentialVault;
  scoped(request: FastifyRequest): { ownerId: string; store: Store };
  workspace(ownerId: string, workspaceId: string): Store;
}
interface SourceRow { id: string; owner_id: string; workspace_id: string; token_hash: string; revoked: number; data: string }

export function registerTelemetryApi(app: FastifyInstance, dependencies: Dependencies) {
  const registry = new Database(join(dependencies.directory, 'telemetry.sqlite'));
  registry.pragma('journal_mode = WAL'); registry.pragma('busy_timeout = 5000');
  registry.exec('CREATE TABLE IF NOT EXISTS telemetry_sources(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,token_hash TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL)');
  const jobs = new Map<string, { id: string; abort: AbortController; promise: Promise<void> }>();
  const rates = new Map<string, { start: number; count: number }>();
  let closing = false;
  const prefix = '/api/v1/workspaces/:id';
  const source = (request: FastifyRequest) => {
    const scope = dependencies.scoped(request);
    const row = registry.prepare('SELECT * FROM telemetry_sources WHERE id=? AND owner_id=? AND workspace_id=?').get((request.params as { sourceId: string }).sourceId, scope.ownerId, scope.store.snapshot().state.workspace.id) as SourceRow | undefined;
    if (!row) throw new IdentityError('SOURCE_NOT_FOUND', 'This telemetry source is unavailable.', 404);
    return { ...scope, row };
  };
  app.post(`${prefix}/services`, async request => {
    const scope = dependencies.scoped(request);
    const parsed = telemetryRegistrationSchema.safeParse(request.body);
    if (!parsed.success) throw new IdentityError('INVALID_SERVICE', 'Choose a repository and a simple service name.');
    const state = scope.store.snapshot().state;
    if (!state.repositories.some(repo => repo.id === parsed.data.repoId)) throw new IdentityError('REPOSITORY_REQUIRED', 'Connect this repository first.');
    if ((state.telemetry?.sources?.filter(item => item.status !== 'revoked').length ?? 0) >= 50) throw new IdentityError('SOURCE_CAPACITY', 'Use up to 50 active telemetry sources in a workspace.', 429);
    if (state.telemetry?.sources?.some(item => item.repoId === parsed.data.repoId && item.serviceName === parsed.data.serviceName && item.status !== 'revoked')) throw new IdentityError('SOURCE_EXISTS', 'This repository already has a source with that service name.', 409);
    const id = randomUUID(), token = randomBytes(32).toString('hex');
    const item: TelemetrySource = { id, serviceId: id, repoId: parsed.data.repoId, serviceName: parsed.data.serviceName, createdAt: new Date().toISOString(), status: 'unverified', lastReceivedAt: null };
    await dependencies.vault.put(`telemetry-${id}`, token);
    try {
      dependencies.scoped(request);
      registry.prepare('INSERT INTO telemetry_sources(id,owner_id,workspace_id,token_hash,data) VALUES(?,?,?,?,?)').run(id, scope.ownerId, state.workspace.id, createHash('sha256').update(token).digest('hex'), JSON.stringify(item));
      scope.store.commit(`telemetry-source:${id}`, current => { current.telemetry ??= emptyTelemetryState(); current.telemetry.sources ??= []; current.telemetry.sources.push(item); return 'telemetry.source_registered'; });
      return { source: item, setup: { endpoint: `http://127.0.0.1:${dependencies.port}/ingest/otlp`, authorization: `Bearer ${id}.${token}`, serviceName: item.serviceName, protocol: 'http/protobuf', compression: 'none' } };
    } catch (error) { registry.prepare('UPDATE telemetry_sources SET revoked=1 WHERE id=?').run(id); await dependencies.vault.delete(`telemetry-${id}`).catch(() => undefined); throw error; }
  });
  app.get(`${prefix}/services`, async request => {
    const state = dependencies.scoped(request).store.snapshot().state.telemetry ?? emptyTelemetryState();
    return { sources: state.sources ?? [], traffic: (state.sources ?? []).map(item => trafficForService(state, item.serviceId)), inventories: state.inventories, coverage: state.coverage };
  });
  app.post(`${prefix}/services/:sourceId/revoke`, async request => {
    const { row, store } = source(request);
    registry.prepare('UPDATE telemetry_sources SET revoked=1 WHERE id=?').run(row.id);
    const result = store.commit(`telemetry-revoke:${randomUUID()}`, state => { const item = state.telemetry?.sources?.find(item => item.id === row.id); if (item) item.status = 'revoked'; return 'telemetry.source_revoked'; });
    await dependencies.vault.delete(`telemetry-${row.id}`); return result;
  });

  app.post(`${prefix}/inventory/scan`, async (request, reply) => {
    const { store } = dependencies.scoped(request);
    const state = store.snapshot().state, workspaceId = state.workspace.id;
    if (closing || jobs.has(workspaceId)) throw new IdentityError('SCAN_UNAVAILABLE', 'Wait for the active API scan or cancel it first.', 409);
    const parsed = apiInventoryRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new IdentityError('INVALID_SCAN', 'Choose a selected local repository and optional relative OpenAPI JSON paths.');
    const repo = state.repositories.find(repo => repo.id === parsed.data.repoId);
    if (!repo?.localPath) throw new IdentityError('LOCAL_REPOSITORY_REQUIRED', 'Connect a local checkout before scanning its API routes.');
    const id = randomUUID(), abort = new AbortController();
    store.commit(`inventory-start:${id}`, (state, now) => { state.telemetry ??= emptyTelemetryState(); state.telemetry.inventoryOperation = { id, repoId: repo.id, status: 'running', startedAt: now, finishedAt: null, message: 'Reading supported source syntax without executing project code…' }; return 'inventory.started'; });
    const promise = (async () => {
      try {
        const inventory = await scanApiInventory({ repoId: repo.id, rootPath: repo.localPath!, openApiFiles: parsed.data.openApiFiles, signal: abort.signal });
        if (abort.signal.aborted) throw new Error('Cancelled');
        store.commit(`inventory-result:${id}`, (state, now) => {
          state.telemetry!.inventories = [...state.telemetry!.inventories.filter(item => item.repoId !== repo.id), inventory];
          Object.assign(state.telemetry!.inventoryOperation!, { status: 'complete', finishedAt: now, message: `${inventory.endpoints.length} declared routes found. Coverage: ${inventory.coverage}.` });
          return 'inventory.completed';
        });
      } catch {
        store.commit(`inventory-failure:${id}`, (state, now) => { Object.assign(state.telemetry!.inventoryOperation!, { status: abort.signal.aborted ? 'cancelled' : 'failed', finishedAt: now, message: abort.signal.aborted ? 'API scan cancelled; previous inventory retained.' : 'API scan failed. Check selected paths and repository access.' }); return 'inventory.failed'; });
      } finally { jobs.delete(workspaceId); }
    })();
    jobs.set(workspaceId, { id, abort, promise }); return reply.code(202).send({ operationId: id });
  });
  app.post(`${prefix}/inventory/:operationId/cancel`, async request => {
    const job = jobs.get(dependencies.scoped(request).store.snapshot().state.workspace.id);
    if (!job || job.id !== (request.params as { operationId: string }).operationId) throw new IdentityError('SCAN_NOT_ACTIVE', 'This API scan is no longer active.', 409);
    job.abort.abort(); return { cancellationRequested: true };
  });

  app.addContentTypeParser('application/x-protobuf', { parseAs: 'buffer', bodyLimit: 8 * 1024 * 1024 }, (_request, body, done) => done(null, body));
  for (const signal of ['traces', 'metrics', 'logs'] as TelemetrySignal[]) app.post(`/ingest/otlp/v1/${signal}`, {
    bodyLimit: 8 * 1024 * 1024,
    onRequest: async (request, reply) => { if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') return reply.code(415).send({ code: 'COMPRESSION_UNSUPPORTED', message: 'Send uncompressed OTLP HTTP JSON or Protobuf.' }); },
  }, async (request, reply) => {
    const match = /^Bearer ([a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(request.headers.authorization ?? '');
    const row = match ? registry.prepare('SELECT * FROM telemetry_sources WHERE id=? AND revoked=0').get(match[1]) as SourceRow | undefined : undefined;
    if (!row || !match || !timingSafeEqual(Buffer.from(row.token_hash, 'hex'), createHash('sha256').update(match[2]!).digest())) throw new IdentityError('SOURCE_AUTH_REQUIRED', 'A registered telemetry credential is required.', 401);
    const now = Date.now(), prior = rates.get(row.id), bucket = !prior || now - prior.start >= 60000 ? { start: now, count: 0 } : prior;
    if (++bucket.count > 120) throw new IdentityError('TELEMETRY_RATE_LIMIT', 'This telemetry source reached its batch limit.', 429);
    rates.set(row.id, bucket);
    const item = JSON.parse(row.data) as TelemetrySource, store = dependencies.workspace(row.owner_id, row.workspace_id);
    const state = store.snapshot().state;
    if (!state.repositories.some(repo => repo.id === item.repoId)) throw new IdentityError('SOURCE_REPOSITORY_UNAVAILABLE', 'This source repository is no longer selected.', 403);
    const routeTemplates = [...new Set(state.telemetry?.inventories.find(inventory => inventory.repoId === item.repoId)?.endpoints.flatMap(endpoint => endpoint.route ? [endpoint.route] : []) ?? [])];
    const taskIds = new Set(state.runner?.tasks.filter(task => task.draft.repoId === item.repoId).map(task => task.id) ?? []);
    const allowedRunIds = state.runner?.runs.filter(run => taskIds.has(run.taskId)).map(run => run.id) ?? [];
    const contentType = request.headers['content-type'] ?? '';
    try {
      const batch = decodeOtlp(signal, request.body, contentType, { sourceId: item.id, serviceId: item.serviceId, repoId: item.repoId, resourceServiceName: item.serviceName, routeTemplates, allowedRunIds });
      let rejected = 0;
      store.commit(`telemetry-batch:${randomUUID()}`, current => {
        const result = ingestTelemetry(current.telemetry ?? emptyTelemetryState(), batch);
        current.telemetry = result.state; rejected = result.rejected;
        const registration = current.telemetry.sources?.find(source => source.id === item.id);
        if (registration && result.accepted + result.duplicate > 0) { registration.status = 'receiving'; registration.lastReceivedAt = batch.receivedAt; }
        return 'telemetry.received';
      });
      reply.type(contentType.split(';')[0]!);
      return encodeOtlpResponse(signal, contentType, rejected);
    } catch (error) {
      if (error instanceof TelemetryError) return reply.code(error.code === 'payload-too-large' ? 413 : error.code === 'unsupported-content-type' ? 415 : error.code === 'invalid-scope' ? 500 : 400).send({ code: error.code, message: error.message });
      throw error;
    }
  });

  return { close: async () => { closing = true; for (const job of jobs.values()) job.abort.abort(); await Promise.allSettled([...jobs.values()].map(job => job.promise)); registry.close(); } };
}
