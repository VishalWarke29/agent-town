import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { autoDetectTools, bindNativeSourceSchema, createObservationSchema, hookOverlapConflicts, hookOverlapMessage, recommendToolSet, observationBatchSchema, toolDetectionReviewSchema, toolDetectionApplySchema, stopSyncingPreviewQuerySchema, stopSyncingRequestSchema, STOP_SYNCING_CONNECTION_CAP, type ObservationEvent, type ObservationConnection, type NativeToolStatus, type ToolDetectionStatus, type ToolDetectionSnapshot, type ToolDetectionReview, type ToolDetectionConflict, type ToolDetectionApplyResult, type ToolDetectionApplyResponse, type AutoDetectSurface, type ToolSurface, type HookOverlapConflict, type StopSyncingStep, type StopSyncingHooksOutcome, type StopSyncingConnectionStatus, type StopSyncingConnectionProgress, type StopSyncingPreview, type StopSyncingOperation } from '@agent-town/contracts';
import type { Store } from '../store.js';
import { IdentityError, type CredentialVault } from '../identity/index.js';
import { checkedPath } from '../discovery/paths.js';
import { DiscoveryError } from '../discovery/types.js';
import { discoverNativeSessions } from '../native-discovery/index.js';
import { stopSyncingReviewToken } from '../history-state.js';
import { ObservationRegistry, type RegisteredObservation } from './registry.js';
import { applyObservation, observationReceiptKey } from './reducer.js';
import { activationStep, inspectObservationSetup, observationSetup, removeConnectionFiles, writeBridgeConfig, writeServiceCapabilities, changeHooks, spoolPath, hookBridgeAvailable, neutralizeConnection, cleanupConnectionFiles, planHookRemoval } from './setup.js';
import { drainObservationSpool, drainMutex, finalDrainConnection, eventName as spoolEventFileName } from './spool.js';
import { hasAmbiguousHookOverlap } from './source-binding.js';
import { registerNativeApi, detectedTools } from './native-api.js';

/** Kept in one place so detection, review, and apply always agree on which
 * tools this combined onboarding flow covers. copilot-vscode and custom stay
 * on the existing single-tool setup in ObservationPanel. */
const AUTO_DETECT_PROVIDERS: AutoDetectSurface[] = autoDetectTools.map(tool => tool.provider);

let stopSyncingStepHookForTests: ((connectionId: string, step: StopSyncingStep) => void) | null = null;
/** Test-only seam, the same kind setup.ts already uses (__setRenameForTests and friends): called immediately
 * after a Stop-watching step's durable marker is recorded, so a test can throw right there to simulate the
 * service ending at exactly that point, with nothing further ever written. Never used outside tests. */
export function __setStopSyncingStepHookForTests(fn: ((connectionId: string, step: StopSyncingStep) => void) | null) { stopSyncingStepHookForTests = fn; }

interface Dependencies {
  directory: string;
  vault: CredentialVault;
  scoped(request: FastifyRequest): { ownerId: string; store: Store };
  workspace(ownerId: string, workspaceId: string): Store;
}

export function registerObservationApi(app: FastifyInstance, dependencies: Dependencies) {
  const native = registerNativeApi(app, dependencies.scoped);
  const registry = new ObservationRegistry(join(dependencies.directory, 'observation.sqlite'));
  // A restart can be a newer (or older) build than whichever one last wrote each connection's
  // capability file; refresh every already-registered connection's file before its first drain.
  for (const record of registry.all()) {
    writeServiceCapabilities(dependencies.directory, record.connection.id)
      .catch(() => app.log.warn('A connection\'s service capability file could not be refreshed at startup. Its bridge keeps assuming the baseline event format.'));
  }
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
    // Manual create and manual apply share the combined flow's own per-project lock (WS2-02), so a
    // manual request and a combined apply for the same project can never both succeed.
    return serialized(`${state.workspace.id}:${repo.id}`, async () => {
      dependencies.scoped(request);
      const current = store.snapshot().state;
      if (registry.all().some(record => record.workspaceId === current.workspace.id && record.connection.provider === parsed.data.provider && record.connection.repoId === repo.id && record.connection.nativeSourceId === parsed.data.nativeSourceId)) throw new IdentityError('CONNECTION_EXISTS', 'This tool and profile already have an active connection for this repository.', 409);
      // The same question the combined flow asks: a tool that would silence (or be silenced by) an
      // already-connected one is refused here too, never just for the combined onboarding.
      const overlaps = relevantOverlapConflicts([...activeProviders(current, repo.id), parsed.data.provider], [parsed.data.provider]);
      if (overlaps.length) throw new IdentityError('HOOK_OVERLAP', hookOverlapMessage(overlaps), 409);
      const connection: ObservationConnection = { id: randomUUID(), provider: parsed.data.provider, repoId: repo.id, label: parsed.data.label, status: 'unverified', createdAt: new Date().toISOString(), lastEventAt: null, version: null, coverage: 'partial', droppedEvents: 0, droppedEventsExact: true };
      const record: RegisteredObservation = { connection, ownerId, workspaceId: current.workspace.id, repoPath: repo.localPath! };
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
    const { record } = authorize(request);
    if (record.connection.status === 'revoked') throw new IdentityError('CONNECTION_REVOKED', 'Create a new connection before installing hooks.', 409);
    // Same per-project lock the combined apply uses (WS2-02): a manual apply and a combined apply for
    // this project can never both proceed, and the overlap guard below reads a state no other write
    // for this project can change out from under it.
    return serialized(`${record.workspaceId}:${record.connection.repoId}`, async () => {
      const { record, store } = authorize(request);
      if (record.connection.status === 'revoked') throw new IdentityError('CONNECTION_REVOKED', 'Create a new connection before installing hooks.', 409);
      const state = store.snapshot().state;
      const overlaps = relevantOverlapConflicts(activeProviders(state, record.connection.repoId), [record.connection.provider]);
      if (overlaps.length) throw new IdentityError('HOOK_OVERLAP', hookOverlapMessage(overlaps), 409);
      const result = await changeHooks(record, dependencies.directory, dependencies.vault);
      store.commit(`hooks-applied:${randomUUID()}`, state => { state.activity.unshift({ id: randomUUID(), message: `Observation hooks applied for ${record.connection.provider}. Trigger a native session to verify receipt.`, createdAt: new Date().toISOString(), kind: 'system' }); return 'observation.hooks_applied'; });
      return result;
    });
  });
  /** One whole removal for one connection, WITHOUT taking the project lock: the caller must already hold it (`serialized` is
   * not re-entrant, so a caller that removes for several connections of one project holds it once around all of them).
   * A repeat that finds nothing of Agent Town's own changed nothing, so it saves no record either. Counts and provider
   * only: no path and no command text reach saved state. */
  const removeHooksHoldingLock = async (record: RegisteredObservation, store: Store) => {
    const result = await changeHooks(record, dependencies.directory, dependencies.vault, true);
    if (result.removed) {
      const plural = (count: number) => `${count} ${count === 1 ? 'entry' : 'entries'}`;
      try {
        store.commit(`hooks-removed:${randomUUID()}`, state => {
          state.activity.unshift({ id: randomUUID(), message: `Observation hooks removed for ${record.connection.provider}: ${plural(result.removedEntries)} of Agent Town's taken out${result.residualEntries ? `, ${plural(result.residualEntries)} that look like Agent Town's left as they were` : ''}${result.file === 'deleted' ? `. The hook file Agent Town created was deleted${result.leftoverCopy ? ', but a leftover copy of it (a file named .agent-town-, then letters and numbers, ending in .tmp, in the same folder) could not be deleted and can be deleted by hand' : ''}` : ''}.`, createdAt: new Date().toISOString(), kind: 'system' });
          return 'observation.hooks_removed';
        });
      } catch { app.log.warn('The hooks were removed but the activity note could not be saved.'); }
    }
    return result;
  };
  app.post(`${prefix}/:connectionId/remove-hooks`, async request => {
    const { record } = authorize(request);
    // The same per-project lock as apply and the combined flow (H0-10): a removal and an apply for this project can
    // never work on one hook file at the same time. It also serves a revoked connection, the usual order on the card.
    return serialized(`${record.workspaceId}:${record.connection.repoId}`, async () => {
      const { record, store } = authorize(request);
      return removeHooksHoldingLock(record, store);
    });
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
  const detectionPrefix = '/api/v1/workspaces/:id/observation/tool-detection';
  // Keyed per workspace, project AND tool (WS2-06): only the expensive discovery read is shared across
  // concurrent requests; each request's own connected/revoked/last-event view is always computed fresh.
  const detecting = new Map<string, Promise<ToolDetectionStatus>>();
  const localRepo = (store: Store, repoId: string) => {
    const state = store.snapshot().state;
    const repo = state.repositories.find(item => item.id === repoId && item.source === 'local');
    if (!repo?.localPath) throw new IdentityError('LOCAL_REPOSITORY_REQUIRED', 'Select a connected local project.');
    return { state, repo, localPath: repo.localPath };
  };
  /** A deleted, moved or re-linked project folder is an ordinary condition, not an internal error. */
  const checkedRepoPath = async (path: string, roots: string[]) => {
    try { return await checkedPath(path, roots); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (error instanceof DiscoveryError || code === 'ENOENT' || code === 'ENOTDIR' || code === 'EPERM' || code === 'EACCES') throw new IdentityError('PROJECT_FOLDER_UNAVAILABLE', 'This project folder could not be read. Check that it still exists inside an allowed folder, then try again.', 409);
      throw error;
    }
  };
  type TownStateSnapshot = ReturnType<Store['snapshot']>['state'];
  /** A tool already actively connected for this repo is reported once here so both
   * GET (status) and POST /review (what's offered for review) agree; review must not
   * mint a preview for a tool /apply will just reject as already connected. */
  const activeToolConnection = (state: TownStateSnapshot, repoId: string, provider: AutoDetectSurface) =>
    registry.all().find(record => record.workspaceId === state.workspace.id && record.connection.repoId === repoId && record.connection.provider === provider);
  const activeProviders = (state: TownStateSnapshot, repoId: string): ToolSurface[] =>
    [...new Set(registry.all().filter(record => record.workspaceId === state.workspace.id && record.connection.repoId === repoId).map(record => record.connection.provider))];
  /** The bridge rejects events by reading the hook files on disk, so setup asks the very same function. */
  const hookFilesOverlap = (provider: ToolSurface, connectionId: string, repoPath: string) =>
    hasAmbiguousHookOverlap({ version: 2, connectionId, provider, repoPath, spoolPath: spoolPath(dependencies.directory, connectionId) });
  const leftoverHookMessage = 'This project already has an Agent Town hook from another connection (for example one that was revoked but not removed), or its hook files could not be checked safely. Agent Town would ignore this tool\'s activity. In Observation, choose Remove Agent Town hook for the old connection, then try again.';
  /** The one place every route (combined review, combined apply, manual create, manual apply) asks
   * whether a combination of tools would make the bridge reject events — see WS2-01/WS2-02. A
   * conflict is relevant only if at least one of the tools actually being changed right now (never a
   * pre-existing pair of already-active tools) is on either side of it. */
  const relevantOverlapConflicts = (present: readonly ToolSurface[], changing: readonly ToolSurface[]): HookOverlapConflict[] => {
    const changingSet = new Set(changing);
    return hookOverlapConflicts(present).filter(conflict => changingSet.has(conflict.provider) || conflict.blockedBy.some(provider => changingSet.has(provider)));
  };
  const applying = new Map<string, Promise<unknown>>();
  const serialized = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const next = (applying.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
    applying.set(key, next);
    try { return await next; } finally { if (applying.get(key) === next) applying.delete(key); }
  };

  // H0-13: "Stop watching" — one resumable job, under the project lock, that undoes tracking for every
  // active (or not-yet-finished) observation connection of one project in the documented order: remove
  // Agent Town's own hook entries (H0-10, skippable) -> neutralize (H0-11) -> bounded final drain (H0-11) ->
  // only when the drain left nothing pending or the owner chose Discard: revoke (registry, then one state
  // transaction that also hides the connection's sessions, H0-12, and writes one audit note) -> clean up
  // local files (H0-11). A durable per-connection step marker lives in state.observation.stopSyncingProgress
  // (contracts, additive) so a restart or a reload always resumes from the true last completed step.
  const STOP_SYNCING_PREFIX = '/api/v1/workspaces/:id/observation/stop-syncing';
  interface StopSyncingJob { id: string; workspaceId: string; repoId: string; cancelRequested: boolean; status: StopSyncingOperation['status']; connections: StopSyncingConnectionStatus[]; promise: Promise<void> }
  const stopSyncingJobs = new Map<string, StopSyncingJob>();
  const stopSyncingProgressOf = (state: TownStateSnapshot, id: string) => state.observation?.stopSyncingProgress?.find(item => item.connectionId === id) ?? null;
  const countPendingSpoolEvents = async (id: string): Promise<number | null> => {
    try { return (await readdir(spoolPath(dependencies.directory, id))).filter(name => spoolEventFileName.test(name)).length; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : null; }
  };
  const stopSyncingAutomatic = (state: TownStateSnapshot): boolean => {
    const config = state.workflow?.manager.config;
    return !!(config?.enabled && config.automatic);
  };
  /** What the preview (and the seed of a live job entry) says about one connection's hook entries, without
   * writing anything — planHookRemoval (setup.ts) is the single source both this and the real removal use, so
   * the preview can never promise something a real removal would not do. */
  const stopSyncingHooksPreview = async (record: RegisteredObservation) => {
    if (record.connection.provider === 'custom') return { hooks: 'unsupported' as StopSyncingHooksOutcome, hooksPath: null as string | null, removedEntries: 0, residualEntries: 0, entries: [] as { event: string; count: number }[] };
    const plan = await planHookRemoval(record, dependencies.directory);
    const hooks: StopSyncingHooksOutcome = plan.removedEntries > 0 ? 'removed' : plan.file === 'missing' ? 'absent' : (plan.residualEntries > 0 || plan.tooLargeToBackUp) ? 'left' : 'absent';
    return { hooks, hooksPath: hooks === 'left' ? plan.path : null, removedEntries: plan.removedEntries, residualEntries: plan.residualEntries, entries: plan.entries };
  };
  /** Every connection of one project Stop watching would still do work on: active connections, plus one
   * revoked but not yet 'cleaned' from an earlier attempt this item interrupted (or a plain manual revoke).
   * A connection already fully 'stopped' is left out — it needs nothing more and a repeat is then a no-op.
   * Scoped to the caller's own owner AND workspace (never another owner's or workspace's same-repoId
   * connection), and bounded so one job can never be asked to work through an unreasonable connection count. */
  const stopSyncingTargets = (ownerId: string, state: TownStateSnapshot, repoId: string): RegisteredObservation[] => {
    if (!state.repositories.some(repo => repo.id === repoId)) throw new IdentityError('STOP_SYNCING_PROJECT_NOT_FOUND', 'Select a connected project.', 404);
    const scoped = registry.forProject(state.workspace.id, repoId).filter(record => record.ownerId === ownerId && stopSyncingProgressOf(state, record.connection.id)?.result !== 'stopped');
    if (scoped.length > STOP_SYNCING_CONNECTION_CAP) throw new IdentityError('STOP_SYNCING_CONNECTION_CAP', `Stop watching works on up to ${STOP_SYNCING_CONNECTION_CAP} connections still needing it at a time. Finish or revoke some individually first, then try again.`, 429);
    return scoped;
  };
  /** Builds a preview/job-seed status entirely from the durable record when one exists — this is what makes
   * a preview honest with no in-memory job at all (a restart, or simply a later preview): `hooks`/`hooksPath`/
   * `removedEntries`/`residualEntries` are left at their placeholder defaults here because the real GET route
   * always merges in a live, freshly recomputed stopSyncingHooksPreview() right after calling this (hook state
   * is always safe and cheap to recompute live from the real file, so it is never read from the durable record). */
  const stopSyncingSeed = (record: RegisteredObservation, state: TownStateSnapshot): StopSyncingConnectionStatus => {
    const progress = stopSyncingProgressOf(state, record.connection.id);
    return { connectionId: record.connection.id, provider: record.connection.provider, label: record.connection.label,
      hooks: 'absent', hooksPath: null, removedEntries: 0, residualEntries: 0,
      drain: progress?.drain ?? 'skipped', eventsDelivered: progress?.eventsDelivered ?? 0, eventsDiscarded: progress?.eventsDiscarded ?? 0, eventsRemaining: progress?.eventsRemaining ?? null,
      heldFromManager: progress?.heldFromManager ?? false, heldReportCount: progress?.heldReportCount ?? 0,
      revoked: record.connection.status === 'revoked', hidden: progress?.hidden ?? false, cleaned: progress?.step === 'cleaned', step: progress?.step ?? null, result: progress?.result ?? null };
  };
  /** H0-32: persists the FULL connection status (not just step/result) as this connection's durable
   * stopSyncingProgress entry, so a restart or a later preview can honestly reconstruct hooks/drain/held-report/
   * hide facts, not just fabricate defaults for them. `retryable` is derived and stored, not left to each
   * reader to recompute, so every reader agrees even across a restart. */
  const recordStopSyncingProgress = (store: Store, status: StopSyncingConnectionStatus) => {
    store.commit(`stop-syncing-progress:${status.connectionId}:${randomUUID()}`, (state, now) => {
      state.observation ??= { connections: [] };
      const list = state.observation.stopSyncingProgress ??= [];
      const entry: StopSyncingConnectionProgress = {
        connectionId: status.connectionId, provider: status.provider, label: status.label,
        step: status.step ?? 'entries-removed', result: status.result,
        hooks: status.hooks, hooksPath: status.hooksPath, removedEntries: status.removedEntries, residualEntries: status.residualEntries,
        drain: status.drain, eventsDelivered: status.eventsDelivered, eventsDiscarded: status.eventsDiscarded, eventsRemaining: status.eventsRemaining,
        heldFromManager: status.heldFromManager, heldReportCount: status.heldReportCount,
        revoked: status.revoked, hidden: status.hidden, cleaned: status.cleaned,
        retryable: status.result !== 'stopped', updatedAt: now,
      };
      const existing = list.find(item => item.connectionId === status.connectionId);
      if (existing) Object.assign(existing, entry); else list.push(entry);
      return 'observation.stop_syncing_progress';
    });
    stopSyncingStepHookForTests?.(status.connectionId, status.step ?? 'entries-removed');
  };
  /** D47 (H0-17 default): while automatic manager processing is on, report IDs the final drain saves stay
   * saved and fully readable, but are recorded here so a later, explicitly wired check can hold them from a
   * paid manager pass — see the field's own doc comment in contracts for the exact integration point this
   * item leaves ready and the handoff that still needs it. */
  const holdReportsFromManager = (store: Store, ids: readonly string[]) => {
    if (!ids.length) return;
    store.commit(`stop-syncing-hold:${randomUUID()}`, state => {
      state.observation ??= { connections: [] };
      const held = new Set(state.observation.heldFromManagerReportIds ?? []);
      for (const id of ids) held.add(id);
      state.observation.heldFromManagerReportIds = [...held];
      return 'observation.stop_syncing_reports_held';
    });
  };
  /** Runs every step for one connection, in order, checking `closing` (the service shutting down) at every
   * step boundary and never mid-step. Idempotent by construction (every step it calls already is: repeating
   * hook removal, neutralize or clean-up on already-finished work changes nothing), so a resumed connection
   * simply runs the same sequence again rather than trying to remember exactly where a previous, interrupted
   * attempt stopped — except a connection already revoked (this attempt or an earlier one, or a plain manual
   * revoke elsewhere), which skips straight to clean-up: a revoked connection can never receive a replayed
   * event, so a drain attempt would only report 'blocked' forever. */
  async function runConnectionStop(record: RegisteredObservation, options: { editFiles: boolean; discard: boolean; automatic: boolean; closing: () => boolean }): Promise<StopSyncingConnectionStatus> {
    const store = dependencies.workspace(record.ownerId, record.workspaceId);
    // H0-32: carry forward the connection's own prior durable outcome (if any) rather than resetting it to
    // zero/false/'skipped' on a resumed pass. Load-bearing for the "already revoked" branch below, which never
    // re-runs the drain and would otherwise silently erase a previous, genuinely real drain/held-report/hide
    // outcome every time this project's Stop watching is resumed or previewed again.
    const prior = stopSyncingProgressOf(store.snapshot().state, record.connection.id);
    const status: StopSyncingConnectionStatus = { connectionId: record.connection.id, provider: record.connection.provider, label: record.connection.label,
      hooks: 'absent', hooksPath: null, removedEntries: 0, residualEntries: 0,
      drain: prior?.drain ?? 'skipped', eventsDelivered: prior?.eventsDelivered ?? 0, eventsDiscarded: prior?.eventsDiscarded ?? 0, eventsRemaining: prior?.eventsRemaining ?? null,
      heldFromManager: prior?.heldFromManager ?? false, heldReportCount: prior?.heldReportCount ?? 0,
      revoked: record.connection.status === 'revoked', hidden: prior?.hidden ?? false, cleaned: false, step: null, result: null };
    const finishPartial = () => { status.result = 'partial'; recordStopSyncingProgress(store, status); return status; };

    if (!status.revoked) {
      // Step 1: entries-removed. Skipped (hooks left as 'left') when the owner chose "stop without editing
      // files"; also 'left' (never thrown further) when removal itself fails, so one connection's hook
      // trouble never blocks the rest of Stop watching for it or for the connections after it.
      // H0-32: "stop without editing files" is the owner's consent to leave a PROBLEM file alone, not a
      // blanket switch that must also skip a normal, safe removal for every OTHER connection in the same
      // job — and, on a resumed attempt, it must not overwrite a hooks outcome an earlier pass already
      // achieved for real (e.g. 'absent' after a prior attempt genuinely removed everything) with a
      // fabricated 'left'. A fresh, cheap dry run of THIS connection settles both: only skip when this
      // connection's own file would actually be refused right now.
      const skipEditing = record.connection.provider !== 'custom' && !options.editFiles
        && (await stopSyncingHooksPreview(record)).hooks === 'left';
      if (record.connection.provider === 'custom') status.hooks = 'unsupported';
      else if (skipEditing) { status.hooks = 'left'; status.hooksPath = observationSetup(record, dependencies.directory).configPath; }
      else {
        try {
          const removal = await changeHooks(record, dependencies.directory, dependencies.vault, true);
          status.removedEntries = removal.removedEntries; status.residualEntries = removal.residualEntries;
          status.hooks = removal.removed ? 'removed' : 'absent';
          if (removal.removed) {
            const plural = (count: number) => `${count} ${count === 1 ? 'entry' : 'entries'}`;
            try {
              store.commit(`hooks-removed:${randomUUID()}`, state => {
                state.activity.unshift({ id: randomUUID(), message: `Observation hooks removed for ${record.connection.provider} while stopping: ${plural(removal.removedEntries)} of Agent Town's taken out${removal.residualEntries ? `, ${plural(removal.residualEntries)} that look like Agent Town's left as they were` : ''}.`, createdAt: new Date().toISOString(), kind: 'system' });
                return 'observation.hooks_removed';
              });
            } catch { app.log.warn('Stop watching removed hook entries but the activity note could not be saved.'); }
          }
        } catch (error) {
          status.hooks = 'left'; status.hooksPath = observationSetup(record, dependencies.directory).configPath;
          app.log.warn({ code: error instanceof IdentityError ? error.code : (error as NodeJS.ErrnoException).code ?? 'unknown' }, 'Stop watching could not remove this connection\'s hook entries; they were left in place for manual review.');
        }
      }
      status.step = 'entries-removed';
      recordStopSyncingProgress(store, status);
      if (options.closing()) return finishPartial();

      // Step 2: neutralized — idempotent; a hook that fires after this finds nothing and exits quietly.
      await neutralizeConnection(dependencies.directory, record.connection.id);
      status.step = 'neutralized';
      recordStopSyncingProgress(store, status);
      if (options.closing()) return finishPartial();

      // Step 3: bounded final drain. Only the service closing ever cancels it (the owner's Cancel takes
      // effect between connections, never inside one connection's own bounded drain).
      const spool = spoolPath(dependencies.directory, record.connection.id);
      const pendingBefore = await countPendingSpoolEvents(record.connection.id) ?? 0;
      const reportsBefore = new Set(store.snapshot().state.handoffs.map(report => report.id));
      const drainResult = await finalDrainConnection({ directory: dependencies.directory, spool, record, store, receive: events => receive(record, events), cancelled: options.closing });
      status.drain = drainResult.outcome; status.eventsRemaining = drainResult.pendingEvents;
      status.eventsDelivered = Math.max(0, pendingBefore - (drainResult.pendingEvents ?? pendingBefore));
      if (options.automatic) {
        const newReportIds = store.snapshot().state.handoffs.filter(report => !reportsBefore.has(report.id)).map(report => report.id);
        if (newReportIds.length) { status.heldFromManager = true; status.heldReportCount = newReportIds.length; holdReportsFromManager(store, newReportIds); }
      }
      status.step = 'drained';
      recordStopSyncingProgress(store, status);
      // Safety rule: revoke and clean-up run only when the drain left 0 pending, or the owner chose Discard.
      const mayProceed = drainResult.outcome === 'drained' || (options.discard && (drainResult.outcome === 'blocked' || drainResult.outcome === 'timed-out'));
      if (!mayProceed) return finishPartial();

      // Step 4: revoke — registry first, then ONE state transaction that also hides this connection's
      // sessions (H0-12) and writes one audit note (counts and fixed words only; hideProject may add its own
      // separate, already-reviewed counts-only note about what left town, which this does not duplicate).
      registry.revoke(record.connection.id);
      status.revoked = true;
      const hookNote = status.hooks === 'removed' ? `${status.removedEntries} hook ${status.removedEntries === 1 ? 'entry' : 'entries'} removed`
        : status.hooks === 'left' ? 'hook entries left in place for manual review' : status.hooks === 'unsupported' ? 'no automatic hook to remove' : 'no hook entries to remove';
      const eventsNote = status.eventsDelivered ? `${status.eventsDelivered} queued ${status.eventsDelivered === 1 ? 'event' : 'events'} saved as ${status.eventsDelivered === 1 ? 'a report' : 'reports'}${status.heldFromManager ? ', held from automatic manager processing' : ''}` : 'no queued events';
      store.commit(`stop-syncing-revoke:${record.connection.id}:${randomUUID()}`, (state, now) => {
        const connection = state.observation?.connections.find(item => item.id === record.connection.id);
        if (connection) connection.status = 'revoked';
        for (const agent of state.agents) if (agent.observation?.connectionId === record.connection.id) agent.observation.freshness = 'stale';
        store.native.hideProject(record.connection.repoId, state, now);
        state.activity.unshift({ id: randomUUID(), message: `Stopped watching ${record.connection.provider}: ${hookNote}; ${eventsNote}.`, createdAt: now, kind: 'system' });
        state.activity = state.activity.slice(0, 500);
        return 'observation.stop_syncing_revoked';
      });
      // Reaching past the commit above without it throwing means store.native.hideProject(...) inside it
      // already ran — one atomic transaction, so this can never be "partially" hidden (H0-32).
      status.hidden = true;
      status.step = 'revoked';
      recordStopSyncingProgress(store, status);
    } else {
      // Already revoked (an earlier, interrupted Stop-watching attempt, or a plain manual revoke elsewhere):
      // any drain would be refused forever (a revoked connection can never receive), so only clean-up remains.
      // neutralize and a read-only hook re-check are still safe and idempotent to repeat. drain/eventsDelivered/
      // eventsDiscarded/eventsRemaining/heldFromManager/heldReportCount/hidden are deliberately left at their
      // prior-seeded values above (see `prior` at the top of this function): this branch never re-runs the
      // drain, so recomputing any of those here would only ever fabricate zeros/false over a genuinely real
      // earlier outcome (H0-32 defect #3).
      await neutralizeConnection(dependencies.directory, record.connection.id);
      const hooksInfo = await stopSyncingHooksPreview(record).catch(() => ({ hooks: 'left' as StopSyncingHooksOutcome, hooksPath: null, removedEntries: 0, residualEntries: 0, entries: [] }));
      status.hooks = hooksInfo.hooks; status.hooksPath = hooksInfo.hooksPath; status.removedEntries = hooksInfo.removedEntries; status.residualEntries = hooksInfo.residualEntries;
      // H0-32: registry.revoke() and the paired hide-state commit above are two non-atomic writes across
      // two different storage layers; a crash between them leaves a connection genuinely revoked but
      // never actually hidden from town, with no other code path that will ever call hideProject for it
      // again (stopSyncingTargets only revisits a connection while its result isn't 'stopped' yet, which
      // this branch is reachable through). hideProject is a safe no-op once nothing is left to hide
      // (hidePlan returns no rows), so retrying it here whenever the durable record isn't yet marked
      // hidden costs nothing when the original hide already succeeded, and repairs the rare case it did not.
      if (!status.hidden) {
        store.commit(`stop-syncing-hide-retry:${record.connection.id}:${randomUUID()}`, (state, now) => {
          store.native.hideProject(record.connection.repoId, state, now);
          return 'observation.stop_syncing_hide_retry';
        });
        status.hidden = true;
      }
      status.step = 'revoked';
      recordStopSyncingProgress(store, status);
    }
    if (options.closing()) return finishPartial();

    // Step 5: clean-up. The credential delete is best-effort: a failure here is logged with a fixed string
    // and never turns an otherwise-finished stop into an error (the connection is already revoked either way).
    try { await dependencies.vault.delete(`observation-${record.connection.id}`); }
    catch { app.log.warn('Stop watching revoked a connection but its stored credential could not be deleted.'); }
    let cleanup: Awaited<ReturnType<typeof cleanupConnectionFiles>>;
    try {
      cleanup = await cleanupConnectionFiles(dependencies.directory, record.connection.id, { discard: options.discard, residualEntries: status.residualEntries });
    } catch (error) {
      // H0-32: an unexpected clean-up failure (e.g. a locked file) must land in the same well-defined,
      // durably-retryable 'partial' state every earlier step already uses on failure — never an uncaught
      // exception that only the job-level catch sees (in-memory only, lost on restart) while the durable
      // record is left stuck at step 'revoked' with no explicit result.
      app.log.warn({ code: error instanceof IdentityError ? error.code : (error as NodeJS.ErrnoException).code ?? 'unknown' }, 'Stop watching revoked this connection but a later clean-up step failed; it stays retryable.');
      return finishPartial();
    }
    status.eventsDiscarded = cleanup.discardedEvents;
    status.cleaned = cleanup.cleaned;
    if (cleanup.cleaned) { status.step = 'cleaned'; status.eventsRemaining = 0; status.result = 'stopped'; }
    else { status.eventsRemaining = cleanup.pendingEvents; status.result = 'partial'; } // Not expected once revoked (see gating above); left safe rather than assumed.
    recordStopSyncingProgress(store, status);
    return status;
  }
  async function runStopSyncingJob(job: StopSyncingJob, targets: readonly RegisteredObservation[], options: { editFiles: boolean; discard: boolean; automatic: boolean }) {
    for (let index = 0; index < targets.length; index++) {
      if (closing) { job.status = 'partial'; return; }
      if (index > 0 && job.cancelRequested) { job.status = 'cancelled'; return; }
      job.connections[index] = await runConnectionStop(targets[index]!, { editFiles: options.editFiles, discard: options.discard, automatic: options.automatic, closing: () => closing });
    }
    job.status = job.connections.every(item => item.result === 'stopped') ? 'stopped' : job.cancelRequested ? 'cancelled' : 'partial';
  }
  const findStopSyncingJob = (workspaceId: string, operationId: string): StopSyncingJob | null =>
    [...stopSyncingJobs.values()].find(item => item.workspaceId === workspaceId && item.id === operationId) ?? null;

  app.get(STOP_SYNCING_PREFIX, async request => {
    const { ownerId, store } = dependencies.scoped(request);
    const parsed = stopSyncingPreviewQuerySchema.safeParse(request.query);
    if (!parsed.success) throw new IdentityError('INVALID_STOP_SYNCING', 'Select a connected local project.');
    const state = store.snapshot().state;
    const targets = stopSyncingTargets(ownerId, state, parsed.data.repoId);
    const connections = await Promise.all(targets.map(async (record): Promise<StopSyncingConnectionStatus> => {
      const [hooksInfo, pendingEvents] = await Promise.all([stopSyncingHooksPreview(record), countPendingSpoolEvents(record.connection.id)]);
      const seed = stopSyncingSeed(record, state);
      return { ...seed, ...hooksInfo, eventsRemaining: pendingEvents };
    }));
    return { repoId: parsed.data.repoId, connections, automaticManagerProcessing: stopSyncingAutomatic(state),
      reviewToken: stopSyncingReviewToken(state, parsed.data.repoId, targets.map(record => record.connection.id)) } satisfies StopSyncingPreview;
  });
  app.post(STOP_SYNCING_PREFIX, async (request, reply) => {
    const { ownerId, store } = dependencies.scoped(request);
    const parsed = stopSyncingRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new IdentityError('INVALID_STOP_SYNCING', 'Review Stop watching again before continuing.');
    const state = store.snapshot().state, workspaceId = state.workspace.id, key = `${workspaceId}:${parsed.data.repoId}`;
    const existing = stopSyncingJobs.get(key);
    if (existing && existing.status === 'running') return reply.code(202).send({ operationId: existing.id, repoId: parsed.data.repoId });
    const targets = stopSyncingTargets(ownerId, state, parsed.data.repoId);
    if (stopSyncingReviewToken(state, parsed.data.repoId, targets.map(record => record.connection.id)) !== parsed.data.reviewToken) throw new IdentityError('STOP_SYNCING_REVIEW_CHANGED', 'What Stop watching would do has changed. Review it again before continuing.', 409);
    const automatic = stopSyncingAutomatic(state);
    const job: StopSyncingJob = { id: randomUUID(), workspaceId, repoId: parsed.data.repoId, cancelRequested: false, status: 'running', connections: targets.map(record => stopSyncingSeed(record, state)), promise: Promise.resolve() };
    stopSyncingJobs.set(key, job);
    job.promise = serialized(key, () => runStopSyncingJob(job, targets, { editFiles: parsed.data.editFiles, discard: parsed.data.discard, automatic }))
      .catch(error => { job.status = 'partial'; app.log.warn({ code: error instanceof IdentityError ? error.code : 'unknown' }, 'Stop watching stopped early because of an unexpected error.'); });
    return reply.code(202).send({ operationId: job.id, repoId: parsed.data.repoId });
  });
  app.get(`${STOP_SYNCING_PREFIX}/:operationId`, async request => {
    const { store } = dependencies.scoped(request);
    const job = findStopSyncingJob(store.snapshot().state.workspace.id, (request.params as { operationId: string }).operationId);
    if (!job) throw new IdentityError('STOP_SYNCING_NOT_ACTIVE', 'This Stop watching operation is no longer active.', 404);
    return { operationId: job.id, repoId: job.repoId, status: job.status, connections: job.connections, cancellable: job.status === 'running' } satisfies StopSyncingOperation;
  });
  app.post(`${STOP_SYNCING_PREFIX}/:operationId/cancel`, async request => {
    const { store } = dependencies.scoped(request);
    const job = findStopSyncingJob(store.snapshot().state.workspace.id, (request.params as { operationId: string }).operationId);
    if (!job || job.status !== 'running') throw new IdentityError('STOP_SYNCING_NOT_ACTIVE', 'This Stop watching operation is no longer active.', 409);
    job.cancelRequested = true;
    return { cancellationRequested: true };
  });

  app.get(detectionPrefix, async request => {
    const { store } = dependencies.scoped(request);
    const repoId = (request.query as { repoId?: string }).repoId;
    if (!repoId) throw new IdentityError('INVALID_TOOL_DETECTION', 'Select a local project before detecting tools.');
    const { state, repo, localPath } = localRepo(store, repoId);
    const repoPath = await checkedRepoPath(localPath, state.discovery?.roots ?? []);
    const projectKey = `${state.workspace.id}:${repo.id}`;
    const [results, bridgeAvailable] = await Promise.all([
      Promise.all(detectedTools()
        .filter((tool): tool is NativeToolStatus & { provider: AutoDetectSurface } => (AUTO_DETECT_PROVIDERS as string[]).includes(tool.provider))
        .map(async (tool): Promise<ToolDetectionStatus> => {
          // Read fresh, per request, at response time (WS2-06): a request that started before another
          // request's apply or revoke finished must still answer with what is true right now — never
          // what was true when this tool's (possibly shared) discovery below began.
          const existing = activeToolConnection(state, repo.id, tool.provider);
          if (existing) {
            const latest = state.observation?.connections.find(item => item.id === existing.connection.id) ?? existing.connection;
            return { provider: tool.provider, label: tool.label, state: 'connected', sessionCount: null, sessionCountExact: true,
              connectionId: latest.id, connectionStatus: latest.status, lastEventAt: latest.lastEventAt, ...(latest.status === 'receiving' ? {} : { nextStep: activationStep(tool.provider) }), message: null };
          }
          const homePath = tool.defaultHomePath;
          if (!tool.detected || !homePath) return { provider: tool.provider, label: tool.label, state: 'not-installed', sessionCount: null, sessionCountExact: true, message: tool.message };
          // Only the discovery read/subprocess itself is expensive enough to share: keyed per tool, so
          // a second concurrent request for the same project reuses it instead of spawning another one,
          // while a later request (once this one finishes) always runs a fresh check.
          const toolKey = `${projectKey}:${tool.provider}`;
          let running = detecting.get(toolKey);
          if (!running) {
            running = (async (): Promise<ToolDetectionStatus> => {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 12000);
              try {
                const result = await discoverNativeSessions({ provider: tool.provider, homePath, repoPath, signal: controller.signal });
                if (result.status === 'available' && result.sessions.length > 0) return { provider: tool.provider, label: tool.label, state: 'found', sessionCount: result.sessions.length, sessionCountExact: !result.nextCursor, message: null };
                return { provider: tool.provider, label: tool.label, state: 'no-activity', sessionCount: result.status === 'available' ? 0 : null, sessionCountExact: result.status === 'available', message: result.status === 'available' ? null : result.message };
              } catch { return { provider: tool.provider, label: tool.label, state: 'no-activity', sessionCount: null, sessionCountExact: false, message: 'Local session discovery could not complete for this profile.' }; }
              finally { clearTimeout(timer); }
            })();
            detecting.set(toolKey, running);
            running.finally(() => { if (detecting.get(toolKey) === running) detecting.delete(toolKey); });
          }
          return running;
        })),
      hookBridgeAvailable(),
    ]);
    return { repoId: repo.id, tools: results, bridge: { available: bridgeAvailable } } satisfies ToolDetectionSnapshot;
  });
  app.post(`${detectionPrefix}/review`, async request => {
    const { ownerId, store } = dependencies.scoped(request);
    const parsed = toolDetectionReviewSchema.safeParse(request.body);
    if (!parsed.success) throw new IdentityError('INVALID_TOOL_DETECTION', 'Choose a project and at least one detected tool.');
    if (!(await hookBridgeAvailable())) throw new IdentityError('BRIDGE_MISSING', 'Agent Town\'s tracking helper is not built on this computer, so tracking cannot start yet. Build the service (npm run build) or start it with npm start, then try again.', 409);
    const { state, repo, localPath } = localRepo(store, parsed.data.repoId);
    await checkedRepoPath(localPath, state.discovery?.roots ?? []);
    dependencies.scoped(request);
    const tools = detectedTools();
    const active = activeProviders(state, repo.id), requested = parsed.data.providers;
    for (const provider of requested) if (activeToolConnection(state, repo.id, provider)) throw new IdentityError('CONNECTION_EXISTS', 'This tool and profile already have an active connection for this repository.', 409);
    // A tool blocked only by another LIVE connection is explained here, never refused (WS2-01): apply
    // is where a combination that would go silent is actually rejected, so review can instead offer
    // the safe choices. Never a "leftover on disk" refusal for something a live connection explains.
    const relevant = relevantOverlapConflicts([...active, ...requested], requested);
    const requestedSet = new Set<string>(requested);
    const blocked = new Set(relevant.flatMap(conflict => [conflict.provider, ...conflict.blockedBy]).filter(provider => requestedSet.has(provider)));
    const items = requested.filter(provider => !blocked.has(provider)).map(provider => {
      const tool = tools.find(item => item.provider === provider);
      const homePath = tool?.defaultHomePath;
      if (!tool?.detected || !homePath) throw new IdentityError('NATIVE_TOOL_NOT_DETECTED', `${tool?.label ?? provider} was not detected on this machine.`, 409);
      const connection: ObservationConnection = { id: randomUUID(), provider, repoId: repo.id, label: `${tool.label} (auto-detected)`, status: 'unverified', createdAt: new Date().toISOString(), lastEventAt: null, version: null, coverage: 'partial', droppedEvents: 0, droppedEventsExact: true };
      // Only when nothing live explains an overlapping file on disk does review refuse outright: a
      // leftover from a disconnected tool (or another project/workspace) still silences this callback.
      if (hookFilesOverlap(provider, connection.id, localPath)) throw new IdentityError('HOOK_OVERLAP', leftoverHookMessage, 409);
      const record: RegisteredObservation = { connection, ownerId, workspaceId: state.workspace.id, repoPath: localPath, nativeHome: homePath };
      const setup = observationSetup(record, dependencies.directory);
      return { provider, label: tool.label, connectionId: connection.id, configPath: setup.configPath, config: setup.config, nextStep: activationStep(provider) };
    });
    const conflicts: ToolDetectionConflict[] = relevant.map(conflict => ({ tool: conflict.provider, blockedBy: conflict.blockedBy, message: hookOverlapMessage([conflict]) }));
    const installed = tools.filter(tool => tool.detected && (AUTO_DETECT_PROVIDERS as string[]).includes(tool.provider)).map(tool => tool.provider as AutoDetectSurface);
    const recommendedTools = conflicts.length ? recommendToolSet(installed, requested, active) : undefined;
    return { repoId: repo.id, items, activeProviders: active, ...(conflicts.length ? { conflicts } : {}), ...(recommendedTools ? { recommendedTools } : {}) } satisfies ToolDetectionReview;
  });
  app.post(`${detectionPrefix}/apply`, async request => {
    const { ownerId, store } = dependencies.scoped(request);
    const parsed = toolDetectionApplySchema.safeParse(request.body);
    if (!parsed.success) throw new IdentityError('INVALID_TOOL_DETECTION', 'Choose at least one reviewed tool to connect.');
    if (!(await hookBridgeAvailable())) throw new IdentityError('BRIDGE_MISSING', 'Agent Town\'s tracking helper is not built on this computer, so tracking cannot start yet. Build the service (npm run build) or start it with npm start, then try again.', 409);
    const requested = localRepo(store, parsed.data.repoId);
    await checkedRepoPath(requested.localPath, requested.state.discovery?.roots ?? []);
    // The checks below and the registration they protect must not interleave with another apply for the same project.
    return serialized(`${requested.state.workspace.id}:${requested.repo.id}`, async () => {
      dependencies.scoped(request);
      const { state, repo, localPath } = localRepo(store, parsed.data.repoId);
      const alreadyActive = (provider: AutoDetectSurface) => !!activeToolConnection(state, repo.id, provider);
      const pending = parsed.data.items.filter(item => !alreadyActive(item.provider));
      // Refuse the whole request before writing anything if these hooks would make the bridge reject
      // events (Claude Code with Cursor or Copilot CLI): a connection that can never receive is worse
      // than no connection, because it looks configured.
      const selected = pending.map(item => item.provider);
      const overlaps = relevantOverlapConflicts([...activeProviders(state, repo.id), ...selected], selected);
      if (overlaps.length) throw new IdentityError('HOOK_OVERLAP', hookOverlapMessage(overlaps), 409);
      // The same question the bridge will ask on every event, answered from the files on disk: a leftover
      // hook from a revoked connection, or another workspace's connection, would silence this one too.
      if (pending.some(item => hookFilesOverlap(item.provider, item.connectionId, localPath))) throw new IdentityError('HOOK_OVERLAP', leftoverHookMessage, 409);
      const tools = detectedTools();
      const results: ToolDetectionApplyResult[] = [];
      for (const item of parsed.data.items) {
        const tool = tools.find(candidate => candidate.provider === item.provider);
        const homePath = tool?.defaultHomePath;
        if (alreadyActive(item.provider) || activeToolConnection(state, repo.id, item.provider)) { results.push({ provider: item.provider, connectionId: item.connectionId, applied: false, error: 'This tool already has an active connection for this project. Choose Recheck tools to see it.' }); continue; }
        if (!tool?.detected || !homePath) { results.push({ provider: item.provider, connectionId: item.connectionId, applied: false, error: `${tool?.label ?? item.provider} is no longer detected on this machine.` }); continue; }
        // A reviewed id must be new everywhere. Ids that already exist (in any workspace, in any letter case) would
        // otherwise share bridge files and credentials with the connection that owns them.
        if (registry.get(item.connectionId)) { results.push({ provider: item.provider, connectionId: item.connectionId, applied: false, error: 'This reviewed identifier is already in use. Review again to prepare a new one.' }); continue; }
        dependencies.scoped(request);
        const connection: ObservationConnection = { id: item.connectionId, provider: item.provider, repoId: repo.id, label: `${tool.label} (auto-detected)`, status: 'unverified', createdAt: new Date().toISOString(), lastEventAt: null, version: null, coverage: 'partial', droppedEvents: 0, droppedEventsExact: true };
        const record: RegisteredObservation = { connection, ownerId, workspaceId: state.workspace.id, repoPath: localPath, nativeHome: homePath };
        // registry.register runs first: a duplicate or retried apply then fails there, before this call
        // has created anything, so the rollback below can only ever undo what THIS call made. Everything
        // after it (bridge config, state entry, credential, hook file) is rolled back together on failure,
        // so a failed hook write can never leave a connection that looks configured but is not.
        // Commit keys are idempotency keys: a retry of the same reviewed id after a rollback must not be skipped as a repeat.
        const attempt = randomUUID();
        let registeredHere = false, statePushed = false;
        try {
          store.commit(`native-source:${randomUUID()}`, () => { const source = store.native.register(item.provider, homePath, `${tool.label} local profile`); connection.nativeSourceId = source.id; connection.sourceRevision = source.revision; connection.binding = 'declared'; return 'observation.native_source_registered'; });
          const token = randomBytes(32).toString('hex');
          registry.register(record, token);
          registeredHere = true;
          await writeBridgeConfig(record, dependencies.directory);
          store.commit(`connection-create:${connection.id}:${attempt}`, s => { s.observation ??= { connections: [] }; s.observation.connections.push(connection); return 'observation.registered'; });
          statePushed = true;
          await dependencies.vault.put(`observation-${connection.id}`, token);
          const changed = await changeHooks(record, dependencies.directory, dependencies.vault);
          try { store.commit(`hooks-applied:${randomUUID()}`, s => { s.activity.unshift({ id: randomUUID(), message: `Observation hooks applied for ${connection.provider}. Trigger a native session to verify receipt.`, createdAt: new Date().toISOString(), kind: 'system' }); return 'observation.hooks_applied'; }); }
          catch { app.log.warn('The hook was applied but its activity note could not be saved.'); }
          results.push({ provider: item.provider, connectionId: connection.id, applied: true, path: changed.path, nextStep: activationStep(item.provider) });
        } catch (error) {
          // Fixed strings and codes only: never a path, an id or a credential.
          app.log.warn({ provider: item.provider, code: error instanceof IdentityError ? error.code : (error as NodeJS.ErrnoException).code ?? 'unknown' }, 'A tool connection could not be completed and was rolled back.');
          if (statePushed) { try { store.commit(`connection-rollback:${connection.id}:${attempt}`, s => { if (s.observation) s.observation.connections = s.observation.connections.filter(entry => entry.id !== connection.id); return 'observation.registration_rolled_back'; }); } catch { app.log.warn('A failed connection could not be removed from saved state.'); } }
          if (registeredHere) {
            try { registry.discard(connection.id); } catch { app.log.warn('A failed connection could not be removed from the registry.'); }
            await dependencies.vault.delete(`observation-${connection.id}`).catch(() => undefined);
            await removeConnectionFiles(dependencies.directory, connection.id).catch(() => undefined);
          }
          results.push({ provider: item.provider, connectionId: connection.id, applied: false, error: error instanceof IdentityError ? error.message : 'This tool could not be connected.' });
        }
      }
      return { repoId: repo.id, results } satisfies ToolDetectionApplyResponse;
    });
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
    // Shares the spool-drain mutex with a connection's bounded final drain (H0-11, orchestrated by Stop
    // watching / H0-13): if a final drain currently holds it, this tick is skipped, same as when the
    // periodic loop was already busy with itself — the next tick tries again.
    const release = drainMutex.tryAcquire();
    if (!release) return;
    active = drain().catch(() => { app.log.warn('Observation replay could not read its local registry. Pending local files were retained.'); }).finally(() => { release(); active = null; });
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
  return { registry, receive, close: async () => {
    closing = true; native.close(); clearInterval(timer); clearInterval(staleTimer);
    // Every in-flight Stop-watching job sees `closing` at its next step boundary (never mid-step) and
    // returns; awaiting every job's promise here is what lets the real shutdown deadline (FD-06,
    // apps/service/src/shutdown.ts) treat this close() as finished instead of cutting it off.
    await Promise.allSettled([...stopSyncingJobs.values()].map(job => job.promise));
    await active; registry.close();
  } };
}
