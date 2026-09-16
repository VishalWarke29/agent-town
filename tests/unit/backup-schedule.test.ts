import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentityRegistry } from '../../apps/service/src/identity/registry';
import { Store } from '../../apps/service/src/store';
import { privateState } from '../../apps/service/src/workspaces';
import { initialState } from '../../apps/service/src/demo';
import { acquireDataDirectoryLock, BackupScheduler, createServiceBackup, restoreOfflineBackup, validateBackup } from '../../apps/service/src/ops';

const roots: string[] = [], cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
  for (const path of roots.splice(0)) {
    if (!resolve(path).startsWith(`${resolve(tmpdir())}${sep}agent-town-schedule-`)) throw new Error('Unsafe fixture cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-town-schedule-')); roots.push(root);
  const source = join(root, 'private'), destination = join(root, 'backups');
  const registry = new IdentityRegistry(join(source, 'app.sqlite'));
  registry.registerOwner({ id: '12345', login: 'fixture', displayName: 'Fixture', avatarUrl: null }, 'DO-NOT-COPY-CREDENTIAL', null);
  const workspace = registry.createWorkspace('12345', 'Fixture'); registry.close();
  const database = join(source, 'workspaces', workspace.id, 'town.sqlite');
  const store = new Store(database, privateState(workspace)); store.close();
  const release = acquireDataDirectoryLock(source); cleanup.push(release);
  return { root, source, destination, database, workspace, release };
}
function scheduler(item: ReturnType<typeof fixture>, now: () => number, retentionCopies = 2) {
  const value = new BackupScheduler({ sourceDirectory: item.source, destinationDirectory: item.destination, now, retentionCopies });
  cleanup.push(() => value.stop()); return value;
}

describe('scheduled private database recovery', () => {
  it('requires the calling service process to own the live directory lock', async () => {
    const item = fixture(); item.release();
    await expect(createServiceBackup(item.source, join(item.destination, 'no-lock'))).rejects.toMatchObject({ code: 'in-use' });
    const release = acquireDataDirectoryLock(item.source, 'backup');
    try { await expect(createServiceBackup(item.source, join(item.destination, 'wrong-lock'))).rejects.toMatchObject({ code: 'in-use' }); }
    finally { release(); }
    expect(existsSync(item.destination)).toBe(false);
  });

  it('starts its due backup from the timer and waits for verification during shutdown', async () => {
    const item = fixture(); let now = Date.parse('2026-09-15T00:00:00Z'); const value = scheduler(item, () => now);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await value.start(); now += 60_000;
      await vi.advanceTimersByTimeAsync(60_000); await value.stop();
      expect(value.status()).toMatchObject({ state: 'succeeded', retainedCopies: 1, restoreVerifiedAt: '2026-09-15T00:01:00.000Z' });
    } finally { vi.useRealTimers(); }
  });

  it('captures live WAL changes before later service mutations and verifies a fresh restore without credentials', async () => {
    const item = fixture(), live = new Database(item.database); cleanup.push(() => { live.close(); });
    live.pragma('journal_mode = WAL'); live.pragma('wal_autocheckpoint = 0');
    const state = JSON.parse((live.prepare('SELECT data FROM town_state').get() as { data: string }).data);
    state.manager.brief = 'Committed WAL at capture';
    live.prepare('UPDATE town_state SET data=?').run(JSON.stringify(state));
    expect(existsSync(`${item.database}-wal`)).toBe(true);
    const backup = join(item.destination, 'live');
    const captured = createServiceBackup(item.source, backup);
    state.manager.brief = 'Changed after synchronous capture';
    live.prepare('UPDATE town_state SET data=?').run(JSON.stringify(state));
    const manifest = await captured;
    expect(manifest.coverage?.capture).toBe('service-turn');
    const restored = join(item.root, 'restored'); await restoreOfflineBackup(backup, restored);
    const copy = new Store(join(restored, 'private', 'workspaces', item.workspace.id, 'town.sqlite'), privateState(item.workspace));
    try { expect(copy.snapshot().state.manager.brief).toBe('Committed WAL at capture'); }
    finally { copy.close(); }
    expect((live.prepare('SELECT data FROM town_state').get() as { data: string }).data).toContain('Changed after synchronous capture');
    for (const file of manifest.files) expect(readFileSync(join(backup, file.path)).includes(Buffer.from('DO-NOT-COPY-CREDENTIAL'))).toBe(false);
    expect(existsSync(join(restored, 'private', '.agent-town.lock'))).toBe(false);
  });

  it('counts excluded spool, worktrees and execution copies without copying their contents', async () => {
    const item = fixture();
    for (const relative of ['observation/spool/connection/event.json', `managed/${item.workspace.id}/worktrees/run/source.txt`, `managed/${item.workspace.id}/execution/run/source/source.txt`]) {
      const parts = relative.split('/'), name = parts.pop()!; mkdirSync(join(item.source, ...parts), { recursive: true }); writeFileSync(join(item.source, ...parts, name), 'PRIVATE_EXCLUDED_MARKER');
    }
    const path = join(item.destination, 'coverage'), manifest = await createServiceBackup(item.source, path);
    expect(manifest.coverage?.excluded).toEqual({ pendingSpool: { items: 1, exact: true }, worktrees: { items: 1, exact: true }, executionSources: { items: 1, exact: true }, externalEvidence: { items: 0, exact: true } });
    expect(readdirSync(path).sort()).toEqual(['app.sqlite', 'manifest.json', 'workspaces']);
    for (const file of manifest.files) expect(readFileSync(join(path, file.path)).includes(Buffer.from('PRIVATE_EXCLUDED_MARKER'))).toBe(false);
    const unsafe = join(item.source, 'observation', 'spool', 'linked');
    symlinkSync(item.root, unsafe, process.platform === 'win32' ? 'junction' : 'dir');
    const second = await createServiceBackup(item.source, join(item.destination, 'linked-coverage'));
    expect(second.coverage?.excluded.pendingSpool.exact).toBe(false);
  });

  it('blocks scheduled backups while external evidence is present, leaving it untouched', async () => {
    const item = fixture(), evidence = join(item.source, 'workspaces', item.workspace.id, 'evidence');
    mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, 'report.txt'), 'PRIVATE_EXCLUDED_MARKER');
    const path = join(item.destination, 'blocked');
    await expect(createServiceBackup(item.source, path)).rejects.toMatchObject({ code: 'external-evidence' });
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(join(evidence, 'report.txt'), 'utf8')).toBe('PRIVATE_EXCLUDED_MARKER');
  });

  it('coalesces requests, persists command deduplication, runs when due and rotates only verified owned copies', async () => {
    const item = fixture(); let now = Date.parse('2026-09-15T00:00:00Z');
    const value = scheduler(item, () => now); await value.start();
    expect(value.status()).toMatchObject({ state: 'idle', nextDueAt: '2026-09-15T00:01:00.000Z' });
    const [first, same] = await Promise.all([value.runNow('request-first'), value.runNow('request-second')]);
    expect(first).toMatchObject({ state: 'succeeded', retainedCopies: 1, excludedItems: 0 }); expect(same.lastBackupId).toBe(first.lastBackupId);
    expect(readdirSync(item.destination).filter(name => name.startsWith('.restore-check-'))).toEqual([]);
    now += 1000; expect((await value.runNow('request-second')).lastBackupId).toBe(first.lastBackupId);
    await value.stop();
    const restarted = scheduler(item, () => now); await restarted.start();
    expect((await restarted.runNow('request-first')).lastBackupId).toBe(first.lastBackupId);
    const unrelated = join(item.destination, 'personal-notes'); mkdirSync(unrelated); writeFileSync(join(unrelated, 'keep.txt'), 'Keep me');
    now += 86_400_000; expect((await restarted.runIfDue()).retainedCopies).toBe(2);
    now += 86_400_000; const third = await restarted.runIfDue();
    expect(third).toMatchObject({ state: 'succeeded', retainedCopies: 2 });
    expect(existsSync(join(item.destination, first.lastBackupId!))).toBe(false);
    expect(readFileSync(join(unrelated, 'keep.txt'), 'utf8')).toBe('Keep me');
    expect(await validateBackup(join(item.destination, third.lastBackupId!))).toMatchObject({ credentialsExcluded: true });
    expect(JSON.stringify(third)).not.toContain(item.source); expect(JSON.stringify(third)).not.toContain('12345');
  });

  it('keeps old backups and added user files when rotation validation fails', async () => {
    const item = fixture(); let now = Date.parse('2026-09-15T00:00:00Z'); const value = scheduler(item, () => now, 1);
    const first = await value.runNow('first-backup');
    expect(first.state).toBe('succeeded');
    const note = join(item.destination, first.lastBackupId!, 'user-note.txt'); writeFileSync(note, 'Never remove');
    now += 86_400_000;
    const failure = await value.runNow('second-backup');
    expect(failure.state).toBe('failed'); expect(failure.lastSuccessAt).toBe(first.lastSuccessAt);
    expect(readFileSync(note, 'utf8')).toBe('Never remove');
    expect(readdirSync(item.destination).filter(name => name.startsWith('scheduled-'))).toHaveLength(2);
    expect(JSON.stringify(failure)).not.toContain(note);
    now += 86_400_000;
    expect((await value.runNow('third-backup')).state).toBe('failed');
    expect(readdirSync(item.destination).filter(name => name.startsWith('scheduled-'))).toHaveLength(2);
  });

  it('preserves invalid scheduler metadata, and disabled schedules create nothing', async () => {
    const item = fixture(), disabledPath = join(item.root, 'disabled');
    const disabled = new BackupScheduler({ sourceDirectory: item.source, destinationDirectory: disabledPath, enabled: false }); cleanup.push(() => disabled.stop());
    await disabled.start(); expect((await disabled.runNow()).state).toBe('disabled'); expect(existsSync(disabledPath)).toBe(false);
    mkdirSync(item.destination); const metadata = join(item.destination, 'schedule.json'); writeFileSync(metadata, 'User file that is not a schedule');
    const value = scheduler(item, Date.now); await value.start(); expect(value.status().state).toBe('failed');
    expect((await value.runNow('request-invalid')).state).toBe('failed');
    expect(readFileSync(metadata, 'utf8')).toBe('User file that is not a schedule');
    expect(readdirSync(item.destination)).toEqual(['schedule.json']);
  });

  it('preserves archived session and disconnected repository records as historical data', async () => {
    const item = fixture(), database = new Database(item.database), sample = initialState();
    const agent = sample.agents[0]!, repository = sample.repositories.find(repo => repo.id === agent.repoId)!, archivedAt = '2026-09-15T00:00:00Z';
    agent.observation = { connectionId: 'fixture-connection', sessionId: 'fixture-session', parentSessionId: null, lastSequence: 1, sourceTime: archivedAt, freshness: 'current', billing: 'unavailable' };
    database.prepare('INSERT INTO agent_archive VALUES(?,?,?,?,?,?,?)').run(agent.id, repository.id, agent.observation.connectionId, agent.observation.sessionId, null, archivedAt, JSON.stringify({ agent, repository, archivedAt }));
    database.prepare('INSERT INTO repository_archive VALUES(?,?,?)').run(repository.id, archivedAt, JSON.stringify({ repository, disconnectedAt: archivedAt })); database.close();
    const backup = join(item.destination, 'archives'); await createServiceBackup(item.source, backup);
    const output = new Database(join(backup, 'workspaces', item.workspace.id, 'town.sqlite'), { readonly: true });
    try {
      const saved = JSON.parse((output.prepare('SELECT data FROM agent_archive').get() as { data: string }).data);
      expect(saved.agent.activity).toBe(agent.activity); expect(saved.agent.observation.freshness).toBe('stale');
      expect(JSON.parse((output.prepare('SELECT data FROM repository_archive').get() as { data: string }).data).repository.id).toBe(repository.id);
    } finally { output.close(); }
  });
});
