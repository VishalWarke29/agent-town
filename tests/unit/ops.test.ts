import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowModel } from '@agent-town/contracts';
import { IdentityRegistry } from '../../apps/service/src/identity/registry';
import { Store } from '../../apps/service/src/store';
import { privateState } from '../../apps/service/src/workspaces';
import { initialState } from '../../apps/service/src/demo';
import { initialWorkflow } from '../../apps/service/src/workflow/budget';
import { emptyTelemetryState } from '../../apps/service/src/telemetry/state';
import { acquireDataDirectoryLock, createOfflineBackup, restoreOfflineBackup, validateBackup, type BackupManifest } from '../../apps/service/src/ops';

const roots: string[] = [];
function temporary() { const path = mkdtempSync(join(tmpdir(), 'agent-town-ops-')); roots.push(path); return path; }
afterEach(() => {
  for (const path of roots.splice(0)) {
    if (!resolve(path).startsWith(`${resolve(tmpdir())}${sep}agent-town-ops-`)) throw new Error('Unsafe fixture cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
const model: WorkflowModel = { model: 'fixture', contextWindowTokens: 4096, inputPerMillionMicroUsd: 1, outputPerMillionMicroUsd: 1,
  cachedInputPerMillionMicroUsd: 1, cacheWritePerMillionMicroUsd: 1, priceSource: 'https://example.com/pricing', priceCheckedAt: '2026-09-14T00:00:00.000Z', qualityStatus: 'user-attested', qualityNote: 'Local fixture' };

function fixture() {
  const root = temporary(), source = join(root, 'private'), backup = join(root, 'backup'), restored = join(root, 'restored');
  const registry = new IdentityRegistry(join(source, 'app.sqlite'));
  registry.registerOwner({ id: '12345', login: 'fixture-owner', displayName: 'Fixture owner', avatarUrl: null }, 'credential-private-marker', null);
  registry.registerOwner({ id: '67890', login: 'other-owner', displayName: 'Other owner', avatarUrl: null }, 'credential-other-marker', null);
  const workspace = registry.createWorkspace('12345', 'Saved work'); registry.close();
  const state = privateState(workspace), now = '2026-09-14T00:00:00.000Z';
  state.agents = [initialState(now).agents[0]];
  state.agents[0].observation = { connectionId: 'native-source', sessionId: 'fixture-session', parentSessionId: null, lastSequence: 2, sourceTime: now, freshness: 'current', billing: 'unavailable' };
  state.workflow = initialWorkflow(); state.workflow.policy.paidEnabled = true; state.workflow.manager.config.enabled = true;
  state.workflow.connections = [{ id: 'api-fixture', provider: 'openai', mode: 'api', label: 'Fixture', status: 'verified', verifiedAt: now, createdAt: now, accountIdentity: 'unavailable', models: ['fixture'], capabilities: { manager: true, managedExecution: true } }];
  state.workflow.reservations = [{ id: 'budget-record', runId: 'run-fixture', purpose: 'worker', connectionId: 'api-fixture', provider: 'openai', mode: 'api', model,
    amountMicroUsd: 400, runBudgetMicroUsd: 400, actualMicroUsd: null, usage: null, status: 'reserved', day: '2026-09-14', createdAt: now, settledAt: null, settlementSource: null }];
  state.workflow.manager.jobs = [{ id: 'manager-job', reportIds: ['report-record'], connectionId: 'api-fixture', model: 'fixture', reservationId: 'budget-record', status: 'running', automatic: false, startedAt: now, completedAt: null, message: null }];
  state.runner = { schemaVersion: 1, tasks: [], subscriptions: [], subscriptionDefault: null, runs: [{ id: 'run-fixture', taskId: 'task-fixture', tool: 'openai-api', connectionId: 'api-fixture', mode: 'api', model: 'fixture', price: model, status: 'running', startedAt: now, finishedAt: null, worktreePath: null, branch: 'task/fixture', contextVersion: 2, contextDelivery: 'provider-acknowledged', providerRequests: 1, usage: null, message: null, changedFiles: [], reportId: null }] };
  state.telemetry = emptyTelemetryState(); state.telemetry.sources = [{ id: 'source-fixture', serviceId: 'source-fixture', repoId: 'repo-fixture', serviceName: 'fixture-service', createdAt: now, status: 'receiving', lastReceivedAt: now }];
  const database = join(source, 'workspaces', workspace.id, 'town.sqlite'), store = new Store(database, state);
  store.commit('saved-report', current => { current.manager.version = 2; current.manager.brief = 'Accepted design and saved context.'; current.handoffs.push({ id: 'report-record', agentId: state.agents[0].id, repoId: 'repo-fixture', summary: 'Saved report, preserved during recovery.', createdAt: now, status: 'saved', contextVersion: null, delivery: 'unsupported' }); return 'report.saved'; });
  store.close();
  const telemetry = new Database(join(source, 'telemetry.sqlite'));
  telemetry.exec('CREATE TABLE telemetry_sources(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,token_hash TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL)');
  telemetry.prepare('INSERT INTO telemetry_sources(id,owner_id,workspace_id,token_hash,data) VALUES(?,?,?,?,?)').run('source-fixture', '12345', workspace.id, 'secret-token-hash-marker', JSON.stringify(state.telemetry.sources[0])); telemetry.close();
  mkdirSync(join(source, 'credentials')); writeFileSync(join(source, 'credentials', 'key.dpapi'), 'must-never-be-copied');
  writeFileSync(join(source, 'unselected-repository.txt'), 'must-never-be-copied');
  return { root, source, backup, restored, workspace, database };
}

function reseal(directory: string, path: string) {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as BackupManifest;
  const file = manifest.files.find(file => file.path === path)!, bytes = readFileSync(join(directory, path));
  file.bytes = bytes.length; file.sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
}

describe('offline recovery', () => {
  it('preserves native identity and hidden sessions but requires profile review after restore', async () => {
    const item = fixture();
    const store = new Store(item.database, privateState(item.workspace));
    let sourceId = '', sessionId = '';
    try {
      store.commit('native-fixture', (state, now) => {
        state.repositories.push({ id: 'native-repo', name: 'Native', description: '', branch: 'Unavailable', language: '', color: '#888888', position: [1, 1], source: 'local', localPath: join(item.root, 'native-project') });
        const source = store.native.register('codex', join(item.root, 'native-home'), 'Native source'); sourceId = source.id;
        store.native.discover(source, 'native-repo', [{ nativeSessionId: 'native-session', title: 'Recover retained session work', nativeAgentName: 'Rowan', projectPath: join(item.root, 'native-project'), createdAt: now, updatedAt: now }], state, now);
        sessionId = store.native.page(state).items[0]!.id;
        store.native.visibility(sessionId, false, state);
        return 'observation.native_fixture';
      });
    } finally { store.close(); }
    await createOfflineBackup(item.source, item.backup);
    await validateBackup(item.backup); await restoreOfflineBackup(item.backup, item.restored);
    const restored = new Store(join(item.restored, 'private', 'workspaces', item.workspace.id, 'town.sqlite'), privateState(item.workspace));
    try {
      expect(restored.native.source(sourceId)?.source).toMatchObject({ status: 'needs-review', revision: 2 });
      expect(restored.native.page(restored.snapshot().state).items).toMatchObject([{ id: sessionId, title: 'Recover retained session work', nativeAgentName: 'Rowan', visible: false, activity: 'unknown' }]);
      expect(restored.native.detail(sessionId, restored.snapshot().state).observation).toBeUndefined();
      expect(restored.native.detail(sessionId, restored.snapshot().state).discovery?.title).toBe('Recover retained session work');
      expect(restored.native.detail(sessionId, restored.snapshot().state).discovery?.nativeAgentName).toBe('Rowan');
      expect(restored.snapshot().state.workflow!.policy.paidEnabled).toBe(false);
    } finally { restored.close(); }
  });
  it('preserves reports, context, receipts, usage and account ownership while excluding credentials and restarting nothing', async () => {
    const item = fixture(), original = readFileSync(item.database);
    const manifest = await createOfflineBackup(item.source, item.backup);
    expect(manifest.files).toHaveLength(3);
    expect(readFileSync(item.database)).toEqual(original);
    expect(readdirSync(item.backup).sort()).toEqual(['app.sqlite', 'manifest.json', 'telemetry.sqlite', 'workspaces']);
    for (const file of manifest.files) {
      const bytes = readFileSync(join(item.backup, file.path)).toString('utf8');
      expect(bytes).not.toContain('credential-private-marker'); expect(bytes).not.toContain('secret-token-hash-marker'); expect(bytes).not.toContain('must-never-be-copied');
    }
    await expect(validateBackup(item.backup)).resolves.toEqual(manifest);
    await restoreOfflineBackup(item.backup, item.restored);
    const registry = new IdentityRegistry(join(item.restored, 'private', 'app.sqlite'));
    try {
      expect(registry.credential('12345')).toBeNull();
      expect(registry.requireWorkspace('12345', item.workspace.id).ownerId).toBe('12345');
      expect(() => registry.requireWorkspace('67890', item.workspace.id)).toThrow('Workspace not found');
    } finally { registry.close(); }
    const store = new Store(join(item.restored, 'private', 'workspaces', item.workspace.id, 'town.sqlite'), privateState(item.workspace));
    try {
      const saved = store.snapshot().state;
      expect(saved.handoffs[0].summary).toContain('Saved report'); expect(saved.manager).toMatchObject({ version: 2, brief: 'Accepted design and saved context.' });
      expect(saved.workflow!.policy.paidEnabled).toBe(false); expect(saved.workflow!.connections[0].status).toBe('disconnected');
      expect(saved.workflow!.reservations[0]).toMatchObject({ amountMicroUsd: 400, actualMicroUsd: null, status: 'uncertain' });
      expect(saved.workflow!.manager.jobs[0].completedAt).toBeTruthy();
      expect(saved.runner!.runs[0]).toMatchObject({ status: 'interrupted', contextDelivery: 'provider-acknowledged' });
      expect(saved.runner!.runs[0].finishedAt).toBeTruthy(); expect(saved.agents[0].activity).toBe('offline'); expect(saved.agents[0].observation!.freshness).toBe('stale');
      expect(saved.telemetry!.sources![0].status).toBe('revoked');
      expect(store.canReplay(0)).toBe(false); expect(store.commit('saved-report', () => { throw new Error('Never repeat report'); }).duplicate).toBe(true);
    } finally { store.close(); }
    await expect(restoreOfflineBackup(item.backup, item.restored)).rejects.toMatchObject({ code: 'destination-exists' });
  });

  it('refuses backups of data locked by a live service and safely reclaims only dead process locks', async () => {
    const item = fixture(), release = acquireDataDirectoryLock(item.source);
    try {
      expect(() => acquireDataDirectoryLock(item.source)).toThrow('in use');
      await expect(createOfflineBackup(item.source, item.backup)).rejects.toMatchObject({ code: 'in-use' });
      expect(existsSync(item.backup)).toBe(false);
    } finally { release(); release(); }
    writeFileSync(join(item.source, '.agent-town.lock'), JSON.stringify({ pid: 2147483647 }));
    const reclaimed = acquireDataDirectoryLock(item.source); reclaimed();
    writeFileSync(join(item.source, '.agent-town.lock'), '{broken');
    expect(() => acquireDataDirectoryLock(item.source)).toThrow('in use');
  });

  it('rejects corruption, path traversal, and active state even when a changed file has a new checksum', async () => {
    const item = fixture(); await createOfflineBackup(item.source, item.backup);
    const path = `workspaces/${item.workspace.id}/town.sqlite`, database = new Database(join(item.backup, path));
    const row = database.prepare('SELECT data FROM town_state').get() as { data: string }, state = JSON.parse(row.data);
    state.workflow.policy.paidEnabled = true; database.prepare('UPDATE town_state SET data=?').run(JSON.stringify(state)); database.close(); reseal(item.backup, path);
    await expect(restoreOfflineBackup(item.backup, item.restored)).rejects.toMatchObject({ code: 'invalid-backup' });
    expect(existsSync(item.restored)).toBe(false);
    const manifest = JSON.parse(readFileSync(join(item.backup, 'manifest.json'), 'utf8')) as BackupManifest;
    manifest.files[0].path = '../app.sqlite'; writeFileSync(join(item.backup, 'manifest.json'), JSON.stringify(manifest));
    await expect(validateBackup(item.backup)).rejects.toMatchObject({ code: 'invalid-backup' });
    manifest.files[0].path = 'app.sqlite'; writeFileSync(join(item.backup, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(item.backup, 'app.sqlite'), Buffer.alloc(50));
    await expect(validateBackup(item.backup)).rejects.toMatchObject({ code: 'invalid-backup' });
  });

  it.each(['-wal', '-shm', '-journal'])('rejects an unlisted SQLite %s sidecar instead of restoring a different database view', async suffix => {
    const item = fixture(); await createOfflineBackup(item.source, item.backup);
    writeFileSync(join(item.backup, `app.sqlite${suffix}`), Buffer.alloc(0));
    await expect(validateBackup(item.backup)).rejects.toMatchObject({ code: 'invalid-backup' });
    await expect(restoreOfflineBackup(item.backup, item.restored)).rejects.toMatchObject({ code: 'invalid-backup' });
    expect(existsSync(item.restored)).toBe(false);
  });

  it('rejects a genuine WAL that hides paid-enabled main-file state from normal SQLite validation', async () => {
    const item = fixture(); await createOfflineBackup(item.source, item.backup);
    const path = `workspaces/${item.workspace.id}/town.sqlite`, database = new Database(join(item.backup, path));
    try {
      database.pragma('journal_mode=WAL'); database.pragma('wal_autocheckpoint=0');
      const state = JSON.parse((database.prepare('SELECT data FROM town_state').get() as { data: string }).data);
      state.workflow.policy.paidEnabled = true;
      database.prepare('UPDATE town_state SET data=?').run(JSON.stringify(state));
      database.prepare('UPDATE event_baseline SET data=?').run(JSON.stringify(state));
      database.pragma('wal_checkpoint(TRUNCATE)');
      state.workflow.policy.paidEnabled = false;
      database.prepare('UPDATE town_state SET data=?').run(JSON.stringify(state));
      database.prepare('UPDATE event_baseline SET data=?').run(JSON.stringify(state));
      reseal(item.backup, path);
      expect(JSON.parse((database.prepare('SELECT data FROM town_state').get() as { data: string }).data).workflow.policy.paidEnabled).toBe(false);
      expect(existsSync(join(item.backup, `${path}-wal`))).toBe(true);
      await expect(restoreOfflineBackup(item.backup, item.restored)).rejects.toMatchObject({ code: 'invalid-backup' });
      expect(existsSync(item.restored)).toBe(false);
    } finally { database.close(); }
  });

  it('rejects unsupported schema columns and SQLite triggers without changing original databases', async () => {
    const item = fixture(), database = new Database(item.database);
    database.exec('ALTER TABLE town_state ADD COLUMN provider_secret TEXT'); database.close();
    const original = readFileSync(item.database);
    await expect(createOfflineBackup(item.source, item.backup)).rejects.toMatchObject({ code: 'unsupported-schema' });
    expect(readFileSync(item.database)).toEqual(original); expect(existsSync(item.backup)).toBe(false);
    const second = fixture(), identity = new Database(join(second.source, 'app.sqlite'));
    identity.exec('CREATE TRIGGER unsafe_trigger AFTER UPDATE ON identity_owners BEGIN DELETE FROM private_workspaces; END'); identity.close();
    await expect(createOfflineBackup(second.source, second.backup)).rejects.toMatchObject({ code: 'unsupported-schema' });
    const third = fixture(), future = new Database(third.database); future.pragma('user_version=99'); future.close();
    await expect(createOfflineBackup(third.source, third.backup)).rejects.toMatchObject({ code: 'unsupported-schema' });
  });

  it('refuses junction destinations and blocks backups while external evidence is present', async () => {
    const item = fixture(), linked = join(item.root, 'linked');
    symlinkSync(item.source, linked, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => acquireDataDirectoryLock(linked)).toThrow('local directory');
    const evidence = join(item.source, 'workspaces', item.workspace.id, 'evidence'); mkdirSync(evidence); writeFileSync(join(evidence, 'report.txt'), 'External saved evidence');
    await expect(createOfflineBackup(item.source, item.backup)).rejects.toMatchObject({ code: 'external-evidence' });
    expect(existsSync(item.backup)).toBe(false);
    expect(readFileSync(join(evidence, 'report.txt'), 'utf8')).toBe('External saved evidence');
  });

  it('converts a legacy full-snapshot database only in the backup and preserves old idempotency', async () => {
    const item = fixture(), legacyPath = join(item.source, 'workspaces', item.workspace.id, 'town.sqlite');
    const old = new Database(legacyPath), state = JSON.parse((old.prepare('SELECT data FROM town_state').get() as { data: string }).data);
    old.exec('DROP TABLE events; DROP TABLE command_receipts; DROP TABLE event_baseline; DROP TABLE IF EXISTS agent_archive; DROP TABLE IF EXISTS repository_archive; DROP TABLE native_sources; DROP TABLE native_sessions; DROP TABLE native_session_aliases; DELETE FROM __drizzle_migrations WHERE created_at > 1789401600000; PRAGMA user_version=0');
    old.exec('CREATE TABLE events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,source_id TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,type TEXT NOT NULL,occurred_at TEXT NOT NULL,data TEXT NOT NULL)');
    old.prepare('INSERT INTO events(source_id,fingerprint,type,occurred_at,data) VALUES(?,?,?,?,?)').run('legacy-report', 'legacy-report', 'report.saved', new Date().toISOString(), JSON.stringify(state)); old.close();
    await createOfflineBackup(item.source, item.backup); await restoreOfflineBackup(item.backup, item.restored);
    const restored = new Store(join(item.restored, 'private', 'workspaces', item.workspace.id, 'town.sqlite'), privateState(item.workspace));
    try { expect(restored.commit('legacy-report', () => { throw new Error('Never repeat legacy report'); }).duplicate).toBe(true); }
    finally { restored.close(); }
    const unchanged = new Database(legacyPath, { readonly: true });
    try { expect(unchanged.pragma('user_version', { simple: true })).toBe(0); } finally { unchanged.close(); }
  });

  it('runs the actual CLI backup, verification and offline restore while rejecting a live data-directory lock', async () => {
    const item = fixture(), execute = promisify(execFile);
    const invoke = (...args: string[]) => execute(process.execPath, ['--import', 'tsx', 'apps/service/src/ops/cli.ts', ...args], {
      cwd: process.cwd(), windowsHide: true, timeout: 10000, env: { ...process.env, AGENT_TOWN_MODE: 'development', AGENT_TOWN_DATA_DIR: item.root },
    });
    expect((await invoke('--backup', item.backup)).stdout).toContain('Backup created: 1 private workspaces');
    expect((await invoke('--verify', item.backup)).stdout).toContain('Backup verified');
    const release = acquireDataDirectoryLock(item.source);
    try { await expect(invoke('--restore', item.backup, '--to', item.restored)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Stop Agent Town') }); }
    finally { release(); }
    expect(existsSync(item.restored)).toBe(false);
    expect((await invoke('--restore', item.backup, '--to', item.restored)).stdout).toContain('Backup restored');
    expect(existsSync(join(item.restored, 'private', 'app.sqlite'))).toBe(true);
  });

  it('restores and backs up the production scope without selecting development data, and refuses demo recovery', async () => {
    const item = fixture(), execute = promisify(execFile);
    await createOfflineBackup(item.source, item.backup);
    const invoke = (mode: string, base: string, ...args: string[]) => execute(process.execPath, ['--import', 'tsx', 'apps/service/src/ops/cli.ts', ...args], {
      cwd: process.cwd(), windowsHide: true, timeout: 10000, env: { ...process.env, AGENT_TOWN_MODE: mode, AGENT_TOWN_DATA_DIR: base },
    });
    const restored = await invoke('production', item.root, '--restore', item.backup, '--to', item.restored);
    expect(restored.stdout).toContain('-Mode production');
    expect(existsSync(join(item.restored, 'production', 'private', 'app.sqlite'))).toBe(true);
    expect(existsSync(join(item.restored, 'private'))).toBe(false);
    const second = join(item.root, 'production-backup');
    expect((await invoke('prod', item.restored, '--backup', second)).stdout).toContain('Backup created: 1 private workspaces');
    expect((await validateBackup(second)).workspaces).toHaveLength(1);
    await expect(invoke('demo', item.root, '--backup', join(item.root, 'demo-backup'))).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Demo mode has no private workspace backups') });
    expect(existsSync(join(item.root, 'demo-backup'))).toBe(false);
    expect(existsSync(join(item.root, 'demo'))).toBe(false);
    expect((await invoke('demo', item.root, '--verify', item.backup)).stdout).toContain('Backup verified');
  }, 20000);
});

it('doctor emits sanitized read-only diagnostics and makes no provider requests', async () => {
  const root = temporary(), marker = 'PRIVATE_DIAGNOSTIC_SECRET_MARKER';
  const result = await promisify(execFile)(process.execPath, ['scripts/doctor.mjs', '--json'], { cwd: process.cwd(), windowsHide: true, timeout: 15000,
    env: { ...process.env, AGENT_TOWN_MODE: 'development', AGENT_TOWN_DATA_DIR: join(root, marker), OPENAI_API_KEY: marker, ANTHROPIC_API_KEY: marker, AGENT_TOWN_PORT: '65520' } });
  const report = JSON.parse(result.stdout);
  expect(report.paidRequests).toBe(0); expect(report.checks.some((check: { name: string }) => check.name === 'Node')).toBe(true);
  expect(result.stdout).not.toContain(marker); expect(result.stdout).not.toContain(root); expect(result.stderr).toBe('');
  expect(readdirSync(root)).toEqual([]);
});
