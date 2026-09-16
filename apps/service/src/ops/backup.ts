import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { TownState } from '@agent-town/contracts';
import { checkedPath, isWithin } from '../discovery/paths.js';
import { acquireDataDirectoryLock, OperationsError, safeLocalDirectory } from './lock.js';
import { projectRoot } from '../store.js';
import { backupCoverage, validBackupCoverage, type BackupCoverage } from './coverage.js';

type Kind = 'identity' | 'workspace' | 'observation' | 'telemetry';
export interface BackupManifest {
  format: 'agent-town-backup'; version: 1; createdAt: string;
  workspaces: { id: string; ownerId: string }[];
  files: { path: string; kind: Kind; bytes: number; sha256: string }[];
  credentialsExcluded: true; connectionsRequireReconnection: true; eventReplayReset: true;
  coverage?: BackupCoverage;
}
const MAX_DATABASE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const allowedTables: Record<Kind, Set<string>> = {
  identity: new Set(['identity_owners', 'private_workspaces']),
  workspace: new Set(['__drizzle_migrations', 'town_state', 'events', 'event_baseline', 'command_receipts', 'agent_archive', 'repository_archive', 'native_sources', 'native_sessions', 'native_session_aliases', 'sqlite_sequence']),
  observation: new Set(['observation_connections']), telemetry: new Set(['telemetry_sources']),
};
const primaryTable: Record<Kind, string> = { identity: 'identity_owners', workspace: 'town_state', observation: 'observation_connections', telemetry: 'telemetry_sources' };
const allowedColumns: Record<string, string[]> = {
  identity_owners: ['id', 'login', 'display_name', 'avatar_url', 'credential_ref', 'token_expires_at', 'verified_at'],
  private_workspaces: ['id', 'owner_id', 'name', 'kind', 'created_at'],
  town_state: ['id', 'cursor', 'data'], event_baseline: ['id', 'cursor', 'data'],
  events: ['cursor', 'source_id', 'fingerprint', 'type', 'occurred_at', 'data'],
  command_receipts: ['source_id', 'fingerprint', 'cursor', 'created_at', 'pinned'],
  agent_archive: ['id', 'repo_id', 'connection_id', 'session_id', 'parent_session_id', 'archived_at', 'data'],
  repository_archive: ['id', 'disconnected_at', 'data'],
  native_sources: ['id', 'provider', 'home_key', 'home_path', 'data'],
  native_sessions: ['id', 'source_id', 'native_id', 'repo_id', 'agent_id', 'data', 'agent_data'],
  native_session_aliases: ['alias_key', 'session_id'],
  __drizzle_migrations: ['id', 'hash', 'created_at'],
  observation_connections: ['id', 'workspace_id', 'owner_id', 'repo_path', 'token_hash', 'revoked', 'data'],
  telemetry_sources: ['id', 'owner_id', 'workspace_id', 'token_hash', 'revoked', 'data'],
};
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9-]{8,100}$/u.test(value);
const validOwner = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/u.test(value);

function validateState(value: unknown, workspaceId?: string): TownState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OperationsError('invalid-backup');
  const state = value as TownState;
  if (state.schemaVersion !== 1 || state.workspace?.mode !== 'private' || !validId(state.workspace.id)
    || workspaceId && state.workspace.id !== workspaceId || !Array.isArray(state.agents) || !Array.isArray(state.repositories)
    || !Array.isArray(state.handoffs) || !Array.isArray(state.activity) || !state.manager || typeof state.manager.version !== 'number') throw new OperationsError('invalid-backup');
  validateJsonTree(value);
  return state;
}

function validateJsonTree(value: unknown): void {
  let nodes = 0;
  const queue: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (queue.length) {
    const current = queue.pop()!;
    if (++nodes > 500_000 || current.depth > 64) throw new OperationsError('backup-limit');
    if (current.value && typeof current.value === 'object') {
      for (const [key, child] of Object.entries(current.value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new OperationsError('invalid-backup');
        queue.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

function archiveData(value: unknown): { agent: TownState['agents'][number]; repository: TownState['repositories'][number]; archivedAt: string } {
  validateJsonTree(value);
  const item = value as { agent: TownState['agents'][number]; repository: TownState['repositories'][number]; archivedAt: string };
  if (!item || !item.agent || !item.repository || typeof item.agent.id !== 'string' || typeof item.repository.id !== 'string'
    || item.agent.repoId !== item.repository.id || !Number.isFinite(Date.parse(item.archivedAt))) throw new OperationsError('invalid-backup');
  return item;
}

function openValidated(path: string | Buffer, kind: Kind, workspaceId?: string, readonly = true): Database.Database {
  let database: Database.Database | undefined;
  try {
    database = new Database(path, { readonly, fileMustExist: true });
    database.pragma('trusted_schema = OFF'); database.pragma('busy_timeout = 2000');
    const schema = database.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as { name: string; type: string; sql: string | null }[];
    if (schema.some(item => item.type === 'trigger' || item.type === 'view' || /CREATE\s+VIRTUAL\s+TABLE/iu.test(item.sql ?? '')
      || item.type === 'table' && !allowedTables[kind].has(item.name)) || !schema.some(item => item.name === primaryTable[kind])) throw new OperationsError('unsupported-schema');
    for (const table of schema.filter(item => item.type === 'table')) {
      const columns = database.prepare(`PRAGMA table_xinfo("${table.name}")`).all() as { name: string; hidden: number }[];
      const expected = allowedColumns[table.name];
      if (!expected || columns.length !== expected.length || columns.some(column => column.hidden !== 0 || !expected.includes(column.name))) throw new OperationsError('unsupported-schema');
    }
    const version = database.pragma('user_version', { simple: true });
    if (kind === 'workspace' ? version !== 0 && version !== 2 && version !== 3 && version !== 4 : kind === 'identity' ? version !== 1 : version !== 0) throw new OperationsError('unsupported-schema');
    if (kind === 'workspace' && (version === 3 || version === 4) && ['agent_archive', 'repository_archive', ...(version === 4 ? ['native_sources', 'native_sessions', 'native_session_aliases'] : [])].some(name => !schema.some(item => item.type === 'table' && item.name === name))) throw new OperationsError('unsupported-schema');
    if (database.pragma('integrity_check', { simple: true }) !== 'ok') throw new OperationsError('invalid-backup');
    if (kind === 'identity') {
      const owners = database.prepare('SELECT id FROM identity_owners').all() as { id: string }[];
      const workspaces = database.prepare('SELECT id,owner_id FROM private_workspaces').all() as { id: string; owner_id: string }[];
      if (owners.some(owner => !validOwner(owner.id)) || workspaces.some(workspace => !validId(workspace.id) || !owners.some(owner => owner.id === workspace.owner_id))) throw new OperationsError('invalid-backup');
    } else if (kind === 'workspace') {
      const rows = database.prepare('SELECT id,cursor,data FROM town_state').all() as { id: string; cursor: number; data: string }[];
      if (rows.length !== 1 || !Number.isSafeInteger(rows[0].cursor) || rows[0].cursor < 0 || rows[0].id !== workspaceId) throw new OperationsError('invalid-backup');
      validateState(JSON.parse(rows[0].data), workspaceId);
      if (version === 4) validateNativeInventory(database, JSON.parse(rows[0].data) as TownState);
      if (schema.some(table => table.name === 'agent_archive')) {
        for (const row of database.prepare('SELECT id,repo_id,connection_id,session_id,parent_session_id,archived_at,data FROM agent_archive').iterate() as Iterable<{ id: string; repo_id: string; connection_id: string | null; session_id: string | null; parent_session_id: string | null; archived_at: string; data: string }>) {
          const archive = archiveData(JSON.parse(row.data));
          if (archive.agent.id !== row.id || archive.repository.id !== row.repo_id || archive.archivedAt !== row.archived_at
            || (archive.agent.observation?.connectionId ?? null) !== row.connection_id || (archive.agent.observation?.sessionId ?? null) !== row.session_id
            || (archive.agent.observation?.parentSessionId ?? null) !== row.parent_session_id) throw new OperationsError('invalid-backup');
        }
      }
      if (schema.some(table => table.name === 'repository_archive')) {
        for (const row of database.prepare('SELECT id,disconnected_at,data FROM repository_archive').iterate() as Iterable<{ id: string; disconnected_at: string; data: string }>) {
          const item = JSON.parse(row.data) as { repository: TownState['repositories'][number]; disconnectedAt: string };
          validateJsonTree(item);
          if (!item?.repository || item.repository.id !== row.id || item.disconnectedAt !== row.disconnected_at || !Number.isFinite(Date.parse(item.disconnectedAt))) throw new OperationsError('invalid-backup');
        }
      }
    }
    return database;
  } catch (error) {
    database?.close();
    if (error instanceof OperationsError) throw error;
    throw new OperationsError('invalid-backup');
  }
}

function validateNativeInventory(database: Database.Database, state: TownState): void {
  const sources = new Map<string, { provider: string }>();
  for (const row of database.prepare('SELECT id,provider,home_key,home_path,data FROM native_sources').all() as Array<{ id: string; provider: string; home_key: string; home_path: string; data: string }>) {
    const value = JSON.parse(row.data); validateJsonTree(value);
    if (!validId(row.id) || value.id !== row.id || value.provider !== row.provider || !['codex', 'claude', 'cursor', 'copilot-cli', 'copilot-vscode', 'custom'].includes(row.provider)
      || !['ready', 'unavailable', 'needs-review'].includes(value.status) || !Number.isSafeInteger(value.revision) || value.revision < 1
      || !isAbsolute(row.home_path) || row.home_key !== (process.platform === 'win32' ? row.home_path.toLowerCase() : row.home_path)) throw new OperationsError('invalid-backup');
    sources.set(row.id, { provider: row.provider });
  }
  const ids = new Set(state.agents.map(agent => agent.id));
  for (const row of database.prepare('SELECT id FROM agent_archive').all() as { id: string }[]) ids.add(row.id);
  for (const row of database.prepare('SELECT * FROM native_sessions').all() as Array<{ id: string; source_id: string; native_id: string; repo_id: string; agent_id: string; data: string; agent_data: string | null }>) {
    const value = JSON.parse(row.data); validateJsonTree(value);
    if (value.id !== row.id || value.agentId !== row.agent_id || value.sourceId !== row.source_id || value.nativeSessionId !== row.native_id || value.repoId !== row.repo_id
      || sources.get(row.source_id)?.provider !== value.provider || typeof value.visible !== 'boolean' || !Number.isFinite(Date.parse(value.discoveredAt))) throw new OperationsError('invalid-backup');
    if (row.agent_data) { const agent = JSON.parse(row.agent_data); validateJsonTree(agent); if (agent.id !== row.agent_id || agent.repoId !== row.repo_id) throw new OperationsError('invalid-backup'); }
    ids.add(row.id);
  }
  for (const row of database.prepare('SELECT alias_key,session_id FROM native_session_aliases').all() as { alias_key: string; session_id: string }[]) {
    if (!ids.has(row.session_id) || row.alias_key.length > 2048) throw new OperationsError('invalid-backup');
    validateJsonTree(JSON.parse(row.alias_key));
  }
}

function restoredState(input: TownState, recoveredAt: string): TownState {
  const state = structuredClone(input);
  state.simulation.running = false;
  for (const agent of state.agents) {
    if (['working', 'testing', 'waiting', 'reporting', 'idle'].includes(agent.activity)) agent.activity = agent.discovery ? 'unknown' : 'offline';
    if (agent.observation) agent.observation.freshness = 'stale';
  }
  if (state.workflow) {
    state.workflow.policy.paidEnabled = false; state.workflow.manager.config.enabled = false;
    for (const connection of state.workflow.connections) connection.status = 'disconnected';
    for (const reservation of state.workflow.reservations) if (reservation.status === 'reserved') reservation.status = 'uncertain';
    for (const job of state.workflow.manager.jobs) if (job.status === 'running') { job.status = 'uncertain'; job.completedAt = recoveredAt; job.message = 'Backup recovery marked this request uncertain; this timestamp is recovery time, not provider completion. Reconcile usage before new work.'; }
  }
  for (const connection of state.observation?.connections ?? []) connection.status = 'revoked';
  for (const source of state.telemetry?.sources ?? []) source.status = 'revoked';
  for (const connection of state.runner?.subscriptions ?? []) connection.status = 'disconnected';
  for (const run of state.runner?.runs ?? []) if (['starting', 'running'].includes(run.status)) { run.status = 'interrupted'; run.finishedAt = recoveredAt; run.message = 'Backup recovery marked this run interrupted; this timestamp is recovery time, not worker completion. No process was restarted.'; }
  for (const task of state.runner?.tasks ?? []) if (['approved', 'running'].includes(task.status)) task.status = 'interrupted';
  if (state.discovery?.operation?.status === 'running') { state.discovery.operation.status = 'interrupted'; state.discovery.operation.finishedAt = recoveredAt; state.discovery.operation.message = 'Backup recovery time recorded. Refresh discovery when ready.'; }
  if (state.telemetry?.inventoryOperation?.status === 'running') { state.telemetry.inventoryOperation.status = 'interrupted'; state.telemetry.inventoryOperation.finishedAt = recoveredAt; state.telemetry.inventoryOperation.message = 'Backup recovery time recorded. Refresh API inventory when ready.'; }
  return state;
}

function sanitizeCopy(path: string, kind: Kind, workspaceId?: string): void {
  const database = openValidated(path, kind, workspaceId, false);
  try {
    database.pragma('secure_delete = ON');
    if (kind === 'workspace' && database.pragma('user_version', { simple: true }) === 0) {
      migrate(drizzle(database), { migrationsFolder: join(projectRoot, 'apps/service/drizzle') });
      const rows = database.prepare('SELECT source_id,fingerprint,cursor,occurred_at FROM events').all() as { source_id: string; fingerprint: string; cursor: number; occurred_at: string }[];
      const insert = database.prepare('INSERT OR IGNORE INTO command_receipts VALUES(?,?,?,?,1)');
      for (const row of rows) insert.run(row.source_id, createHash('sha256').update(row.fingerprint).digest('hex'), row.cursor, row.occurred_at);
    }
    database.transaction(() => {
      if (kind === 'identity') database.prepare('UPDATE identity_owners SET credential_ref=NULL,token_expires_at=NULL').run();
      else if (kind === 'workspace') {
        const row = database.prepare('SELECT cursor,data FROM town_state WHERE id=?').get(workspaceId) as { cursor: number; data: string };
        const data = JSON.stringify(restoredState(validateState(JSON.parse(row.data), workspaceId), new Date().toISOString()));
        database.prepare('UPDATE town_state SET data=? WHERE id=?').run(data, workspaceId);
        database.prepare('INSERT INTO event_baseline(id,cursor,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor,data=excluded.data').run(workspaceId, row.cursor, data);
        database.prepare('DELETE FROM events').run();
        if (database.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_archive' AND type='table'").get()) {
          const update = database.prepare('UPDATE agent_archive SET data=? WHERE id=?');
          for (const archived of database.prepare('SELECT id,data FROM agent_archive').all() as { id: string; data: string }[]) {
            const item = archiveData(JSON.parse(archived.data));
            if (item.agent.observation) item.agent.observation.freshness = 'stale';
            update.run(JSON.stringify(item), archived.id);
          }
        }
        if (database.prepare("SELECT 1 FROM sqlite_master WHERE name='native_sources' AND type='table'").get()) {
          for (const row of database.prepare('SELECT id,data FROM native_sources').all() as { id: string; data: string }[]) {
            const source = JSON.parse(row.data);
            database.prepare('UPDATE native_sources SET data=? WHERE id=?').run(JSON.stringify({ ...source, status: 'needs-review', message: 'Restored profile: verify its local folder before tracking.', revision: source.revision + 1 }), row.id);
          }
          for (const row of database.prepare('SELECT id,data,agent_data FROM native_sessions').all() as { id: string; data: string; agent_data: string | null }[]) {
            const session = JSON.parse(row.data), agent = row.agent_data ? JSON.parse(row.agent_data) : null;
            if (agent?.observation) agent.observation.freshness = 'stale';
            if (agent && ['working', 'testing', 'waiting', 'reporting', 'idle'].includes(agent.activity)) agent.activity = 'unknown';
            database.prepare('UPDATE native_sessions SET data=?,agent_data=? WHERE id=?').run(JSON.stringify({ ...session, activity: agent?.activity ?? 'unknown' }), agent ? JSON.stringify(agent) : null, row.id);
          }
        }
      } else {
        const table = primaryTable[kind];
        const rows = database.prepare(`SELECT id,data FROM ${table}`).all() as { id: string; data: string }[];
        const update = database.prepare(`UPDATE ${table} SET revoked=1,token_hash='',data=? WHERE id=?`);
        for (const row of rows) update.run(JSON.stringify({ ...JSON.parse(row.data), status: 'revoked' }), row.id);
      }
    })();
    database.pragma('wal_checkpoint(TRUNCATE)'); database.pragma('journal_mode = DELETE');
    database.exec('VACUUM');
  } finally { database.close(); }
}

function workspaceFromPath(path: string): string | undefined { return /^workspaces\/([a-zA-Z0-9-]{8,100})\/town\.sqlite$/u.exec(path)?.[1]; }
function allowedFile(path: string, kind: Kind): boolean {
  return kind === 'workspace' ? !!workspaceFromPath(path) : path === `${kind === 'identity' ? 'app' : kind}.sqlite`;
}

export async function createOfflineBackup(sourceDirectory: string, destinationDirectory: string): Promise<BackupManifest> {
  return createBackup(sourceDirectory, destinationDirectory, 'offline-locked');
}

/** Called only by the service holding this directory's live process lock. */
export async function createServiceBackup(sourceDirectory: string, destinationDirectory: string): Promise<BackupManifest> {
  return createBackup(sourceDirectory, destinationDirectory, 'service-turn');
}

type Candidate = { path: string; kind: Kind; bytes?: Buffer };
function serviceSnapshot(source: string): { workspaces: BackupManifest['workspaces']; candidates: Candidate[] } {
  // All service database mutations run on this JS thread. Do not add an await
  // between registry selection and the last serialization: that is the local
  // multi-database consistency boundary. SQLite serialization includes WAL data.
  try {
    const lockPath = join(source, '.agent-town.lock'), lockInfo = lstatSync(lockPath);
    if (!lockInfo.isFile() || lockInfo.isSymbolicLink() || lockInfo.nlink > 1 || lockInfo.size > 4096) throw new OperationsError('in-use');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number; operation: string };
    if (lock.pid !== process.pid || lock.operation !== 'service') throw new OperationsError('in-use');
  } catch { throw new OperationsError('in-use'); }
  let total = 0;
  const capture = (path: string, kind: Kind): Candidate => {
    const input = join(source, path);
    safeLocalDirectory(dirname(input));
    const info = lstatSync(input);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new OperationsError('unsafe-path');
    const database = new Database(input, { readonly: true, fileMustExist: true, timeout: 1000 });
    try {
      database.pragma('trusted_schema = OFF');
      const size = Number(database.pragma('page_count', { simple: true })) * Number(database.pragma('page_size', { simple: true }));
      if (!Number.isSafeInteger(size) || size < 1 || (total += size) > 128 * 1024 * 1024) throw new OperationsError('backup-limit');
      const bytes = database.serialize();
      if (bytes.length !== size) throw new OperationsError('invalid-backup');
      // SQLite's documented deserialize workaround: serialization already
      // contains the committed WAL view; the in-memory copy must use rollback
      // header modes. Never edit the live file or discard its WAL.
      // https://www.sqlite.org/c3ref/deserialize.html
      if (bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\0' || ![1, 2].includes(bytes[18]!) || ![1, 2].includes(bytes[19]!)) throw new OperationsError('invalid-backup');
      bytes[18] = 1; bytes[19] = 1;
      return { path, kind, bytes };
    } finally { database.close(); }
  };
  const identity = capture('app.sqlite', 'identity');
  const registry = openValidated(identity.bytes!, 'identity');
  let workspaces: BackupManifest['workspaces'];
  try { workspaces = registry.prepare('SELECT id,owner_id AS ownerId FROM private_workspaces ORDER BY id').all() as BackupManifest['workspaces']; }
  finally { registry.close(); }
  if (workspaces.length > 500) throw new OperationsError('backup-limit');
  const candidates: Candidate[] = [identity];
  for (const kind of ['observation', 'telemetry'] as const) if (existsSync(join(source, `${kind}.sqlite`))) candidates.push(capture(`${kind}.sqlite`, kind));
  for (const workspace of workspaces) if (existsSync(join(source, 'workspaces', workspace.id, 'town.sqlite'))) candidates.push(capture(`workspaces/${workspace.id}/town.sqlite`, 'workspace'));
  return { workspaces, candidates };
}

async function createBackup(sourceDirectory: string, destinationDirectory: string, capture: BackupCoverage['capture']): Promise<BackupManifest> {
  const source = safeLocalDirectory(sourceDirectory);
  const destination = resolve(destinationDirectory);
  if (!isAbsolute(destinationDirectory) || isWithin(source, destination) || isWithin(destination, source)) throw new OperationsError('unsafe-path');
  if (existsSync(destination)) throw new OperationsError('destination-exists');
  const release = capture === 'offline-locked' ? acquireDataDirectoryLock(source, 'backup') : () => {};
  const staging = `${destination}.pending-${randomUUID()}`;
  try {
    const coverage = backupCoverage(source, capture);
    const snapshot = capture === 'service-turn' ? serviceSnapshot(source) : null;
    let workspaces: BackupManifest['workspaces'];
    if (snapshot) workspaces = snapshot.workspaces;
    else {
      const identityPath = await checkedPath(join(source, 'app.sqlite'), [source]);
      const identity = openValidated(identityPath, 'identity');
      try { workspaces = identity.prepare('SELECT id,owner_id AS ownerId FROM private_workspaces ORDER BY id').all() as BackupManifest['workspaces']; }
      finally { identity.close(); }
    }
    if (workspaces.length > 500) throw new OperationsError('backup-limit');
    const candidates: Candidate[] = snapshot?.candidates ?? [{ path: 'app.sqlite', kind: 'identity' }];
    if (!snapshot) {
      for (const kind of ['observation', 'telemetry'] as const) if (existsSync(join(source, `${kind}.sqlite`))) candidates.push({ path: `${kind}.sqlite`, kind });
      for (const workspace of workspaces) if (existsSync(join(source, 'workspaces', workspace.id, 'town.sqlite'))) candidates.push({ path: `workspaces/${workspace.id}/town.sqlite`, kind: 'workspace' });
    }
    safeLocalDirectory(staging, true);
    const manifest: BackupManifest = { format: 'agent-town-backup', version: 1, createdAt: new Date().toISOString(), workspaces,
      files: [], credentialsExcluded: true, connectionsRequireReconnection: true, eventReplayReset: true, coverage };
    let total = 0;
    for (const candidate of candidates) {
      const input = await checkedPath(join(source, candidate.path), [source]);
      const info = await lstat(input);
      if (!info.isFile() || info.nlink > 1) throw new OperationsError('unsafe-path');
      if (info.size > MAX_DATABASE_BYTES || (total += info.size) > MAX_TOTAL_BYTES) throw new OperationsError('backup-limit');
      const output = join(staging, candidate.path); await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      if (candidate.bytes) {
        // Serialize into an in-memory SQLite connection before backup so WAL
        // header modes cannot require a missing sidecar in the published copy.
        const database = openValidated(candidate.bytes, candidate.kind, workspaceFromPath(candidate.path));
        try { await database.backup(output); } finally { database.close(); }
        candidate.bytes = undefined;
      } else {
        const database = openValidated(input, candidate.kind, workspaceFromPath(candidate.path));
        try { await database.backup(output); } finally { database.close(); }
      }
      sanitizeCopy(output, candidate.kind, workspaceFromPath(candidate.path));
      const bytes = await readFile(output);
      manifest.files.push({ path: candidate.path, kind: candidate.kind, bytes: bytes.length, sha256: digest(bytes) });
    }
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600, flush: true });
    await validateBackup(staging);
    await rename(staging, destination);
    return manifest;
  } finally { release(); }
}

export async function validateBackup(directory: string): Promise<BackupManifest> {
  const root = safeLocalDirectory(directory);
  try {
    const manifestPath = await checkedPath(join(root, 'manifest.json'), [root]);
    if ((await lstat(manifestPath)).size > 256_000) throw new OperationsError('backup-limit');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BackupManifest;
    if (manifest.format !== 'agent-town-backup' || manifest.version !== 1 || !manifest.credentialsExcluded || !manifest.connectionsRequireReconnection
      || !manifest.eventReplayReset || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 503
      || !Array.isArray(manifest.workspaces) || manifest.workspaces.length > 500
      || manifest.workspaces.some(workspace => !validId(workspace.id) || !validOwner(workspace.ownerId))
      || manifest.coverage !== undefined && !validBackupCoverage(manifest.coverage)) throw new OperationsError('invalid-backup');
    await validateBackupFiles(root, manifest);
    return manifest;
  } catch (error) { if (error instanceof OperationsError) throw error; throw new OperationsError('invalid-backup'); }
}

async function validateBackupFiles(root: string, manifest: BackupManifest): Promise<void> {
  try {
    const names = new Set<string>(); let total = 0;
    for (const file of manifest.files) {
      if (!file || typeof file.path !== 'string' || !['identity', 'workspace', 'observation', 'telemetry'].includes(file.kind)
        || !allowedFile(file.path, file.kind) || names.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 1
        || file.bytes > MAX_DATABASE_BYTES || (total += file.bytes) > MAX_TOTAL_BYTES || !/^[a-f0-9]{64}$/u.test(file.sha256)) throw new OperationsError('invalid-backup');
      names.add(file.path);
      const path = await checkedPath(join(root, file.path), [root]), info = await lstat(path);
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try { await lstat(`${path}${suffix}`); throw new OperationsError('invalid-backup'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (!info.isFile() || info.nlink > 1 || info.size !== file.bytes) throw new OperationsError('invalid-backup');
      const bytes = await readFile(path);
      if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new OperationsError('invalid-backup');
      const id = workspaceFromPath(file.path);
      if (id && !manifest.workspaces.some(workspace => workspace.id === id)) throw new OperationsError('invalid-backup');
      // Validate the exact bytes in the manifest. A concurrently added SQLite
      // sidecar can never change the database view that passes these checks.
      const database = openValidated(bytes, file.kind, id);
      try {
        if (file.kind === 'identity') {
          const rows = database.prepare('SELECT id,owner_id AS ownerId FROM private_workspaces ORDER BY id').all();
          if (JSON.stringify(rows) !== JSON.stringify(manifest.workspaces) || database.prepare('SELECT id FROM identity_owners WHERE credential_ref IS NOT NULL OR token_expires_at IS NOT NULL').get()) throw new OperationsError('invalid-backup');
        } else if (file.kind === 'workspace') {
          const row = database.prepare('SELECT cursor,data FROM town_state').get() as { cursor: number; data: string };
          const state = JSON.parse(row.data) as TownState;
          if (JSON.stringify(restoredState(state, manifest.createdAt)) !== JSON.stringify(state)
            || database.prepare('SELECT 1 FROM events LIMIT 1').get()) throw new OperationsError('invalid-backup');
          const baseline = database.prepare('SELECT cursor,data FROM event_baseline').all() as { cursor: number; data: string }[];
          if (baseline.length !== 1 || baseline[0].cursor !== row.cursor || baseline[0].data !== row.data) throw new OperationsError('invalid-backup');
          if (database.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_archive' AND type='table'").get()) {
            for (const archived of database.prepare('SELECT data FROM agent_archive').iterate() as Iterable<{ data: string }>) {
              const item = archiveData(JSON.parse(archived.data));
              if (item.agent.observation && item.agent.observation.freshness !== 'stale') throw new OperationsError('invalid-backup');
            }
          }
          if (database.prepare("SELECT 1 FROM sqlite_master WHERE name='native_sources' AND type='table'").get()) {
            for (const profile of database.prepare('SELECT data FROM native_sources').iterate() as Iterable<{ data: string }>) {
              if (JSON.parse(profile.data).status !== 'needs-review') throw new OperationsError('invalid-backup');
            }
            for (const row of database.prepare('SELECT agent_data FROM native_sessions WHERE agent_data IS NOT NULL').iterate() as Iterable<{ agent_data: string }>) {
              const agent = JSON.parse(row.agent_data) as TownState['agents'][number];
              if (agent.observation && agent.observation.freshness !== 'stale' || ['working', 'testing', 'waiting', 'reporting', 'idle'].includes(agent.activity)) throw new OperationsError('invalid-backup');
            }
          }
        } else {
          const table = primaryTable[file.kind];
          const rows = database.prepare(`SELECT owner_id,workspace_id,revoked,token_hash FROM ${table}`).all() as { owner_id: string; workspace_id: string; revoked: number; token_hash: string }[];
          if (rows.some(row => row.revoked !== 1 || row.token_hash !== '' || !manifest.workspaces.some(workspace => workspace.id === row.workspace_id && workspace.ownerId === row.owner_id))) throw new OperationsError('invalid-backup');
        }
      } finally { database.close(); }
    }
    if (!names.has('app.sqlite')) throw new OperationsError('invalid-backup');
  } catch (error) { if (error instanceof OperationsError) throw error; throw new OperationsError('invalid-backup'); }
}

/** Restore to a NEW runtime directory. The caller can select it with AGENT_TOWN_DATA_DIR. */
export async function restoreOfflineBackup(backupDirectory: string, destinationDirectory: string): Promise<BackupManifest> {
  const backup = safeLocalDirectory(backupDirectory), destination = resolve(destinationDirectory);
  if (!isAbsolute(destinationDirectory) || isWithin(backup, destination) || isWithin(destination, backup)) throw new OperationsError('unsafe-path');
  if (existsSync(destination)) throw new OperationsError('destination-exists');
  const manifest = await validateBackup(backup);
  const staging = `${destination}.pending-${randomUUID()}`;
  safeLocalDirectory(staging, true);
  const privateDirectory = join(staging, 'private'), release = acquireDataDirectoryLock(privateDirectory, 'restore');
  try {
    for (const file of manifest.files) {
      const input = await checkedPath(join(backup, file.path), [backup]), output = join(privateDirectory, file.path);
      await mkdir(dirname(output), { recursive: true, mode: 0o700 }); await copyFile(input, output);
      const bytes = await readFile(output);
      if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new OperationsError('invalid-backup');
    }
    // Recheck the copied schema, ownership, paid/recovery flags and checksums
    // before the new runtime directory becomes visible as a completed restore.
    await validateBackupFiles(privateDirectory, manifest);
    await writeFile(join(staging, 'restore-manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600, flush: true });
  } finally { release(); }
  await rename(staging, destination);
  return manifest;
}

/** Count evidence directories without traversing or copying arbitrary source/worktree content. */
export async function externalEvidencePresent(directory: string): Promise<boolean> {
  if (!existsSync(join(directory, 'workspaces'))) return false;
  const workspaces = await checkedPath(join(directory, 'workspaces'), [directory]);
  for (const entry of await readdir(workspaces, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new OperationsError('unsafe-path');
    const path = join(workspaces, entry.name, 'evidence');
    if (existsSync(path) && (await readdir(await checkedPath(path, [directory]))).length > 0) return true;
  }
  return false;
}
