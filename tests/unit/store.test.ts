import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../apps/service/src/store';
import { applyDemoCommand, initialState } from '../../apps/service/src/demo';
import { privateState } from '../../apps/service/src/workspaces';

const stores: Store[] = [];
const directories: string[] = [];
const open = (path = ':memory:') => { const store = new Store(path); stores.push(store); return store; };
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}agent-town-test-`)) throw new Error('Unsafe fixture cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('compact private storage', () => {
  const seed = () => privateState({ id: 'workspace-test', name: 'Private fixture', kind: 'personal' });

  it('keeps bounded patches small for growing and FIFO lists, while replay returns exact historical states', () => {
    const state = seed(); state.manager.brief = 'Preserved report context. '.repeat(10_000);
    const store = new Store(':memory:', state, { maxEvents: 8 }); stores.push(store);
    const snapshots = new Map<number, ReturnType<Store['snapshot']>>();
    for (let i = 0; i < 30; i++) {
      const result = store.commit(`activity-${i}`, current => {
        current.activity.push({ id: String(i), message: `Activity ${i}`, createdAt: new Date().toISOString(), kind: 'system' });
        current.activity = current.activity.slice(-5);
        return 'agent.updated';
      });
      snapshots.set(result.snapshot.cursor, result.snapshot);
    }
    const stats = store.diagnostics();
    expect(stats.events).toBeLessThanOrEqual(8);
    expect(stats.eventBytes).toBeLessThan(5000);
    expect(stats.snapshotBytes).toBeGreaterThan(200_000);
    expect(store.canReplay(0)).toBe(false);
    expect(() => store.replay(0)).toThrow('outside retained history');
    for (const event of store.replay(stats.replayAfter)) expect(event.state).toEqual(snapshots.get(event.cursor)!.state);
    expect(store.replay(store.snapshot().cursor)).toEqual([]);
    expect(store.canReplay(stats.replayAfter, 1)).toBe(false);
    expect(store.snapshot().state.manager.brief).toBe(state.manager.brief);
  });

  it('preserves protected receipts after history compaction and fails closed at their capacity', () => {
    const store = new Store(':memory:', seed(), { maxEvents: 2, maxReceipts: 4, maxPinnedReceipts: 2 }); stores.push(store);
    store.commit('paid-start', current => { current.manager.version = 1; return 'manager.processing'; }, 'approved-terms');
    for (let i = 0; i < 20; i++) store.commit(`observe-${i}`, () => 'agent.updated');
    expect(store.diagnostics().receipts).toBeLessThanOrEqual(4);
    expect(store.commit('paid-start', () => { throw new Error('Must not repeat paid state transition'); }, 'approved-terms').duplicate).toBe(true);
    store.commit('paid-finish', () => 'manager.processed');
    const before = store.snapshot();
    expect(() => store.commit('another-paid-start', () => 'manager.processing')).toThrow('protected action history limit');
    expect(store.snapshot()).toEqual(before);
    expect(store.snapshot().state.manager.version).toBe(1);
  });

  it('migrates a legacy snapshot journal using a consistent backup and retains retry protection', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-town-test-')); directories.push(directory);
    const path = join(directory, 'town.sqlite'), state = seed(); state.manager.version = 3; state.manager.brief = 'Saved manager history';
    const legacy = new Database(path);
    legacy.pragma('journal_mode = WAL'); legacy.pragma('wal_autocheckpoint = 0');
    legacy.exec(readFileSync(join(process.cwd(), 'apps/service/drizzle/0000_local_preview.sql'), 'utf8'));
    legacy.exec('CREATE TABLE __drizzle_migrations(id INTEGER PRIMARY KEY,hash TEXT NOT NULL,created_at NUMERIC)');
    legacy.prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,?)').run('legacy', 1789401600000);
    legacy.prepare('INSERT INTO town_state(id,cursor,data) VALUES(?,1,?)').run(state.workspace.id, JSON.stringify(state));
    legacy.prepare('INSERT INTO events(source_id,fingerprint,type,occurred_at,data) VALUES(?,?,?,?,?)').run('legacy-report', 'legacy-report', 'manager.processed', new Date().toISOString(), JSON.stringify(state));
    let store: Store;
    try { store = new Store(path, seed()); stores.push(store); } finally { legacy.close(); }
    expect(existsSync(`${path}.before-v2.bak`)).toBe(true);
    const backup = new Database(`${path}.before-v2.bak`, { readonly: true });
    try { expect((backup.prepare('SELECT cursor FROM town_state').get() as { cursor: number }).cursor).toBe(1); } finally { backup.close(); }
    expect(store!.snapshot().state).toEqual(state);
    expect(store!.canReplay(0)).toBe(false);
    expect(store!.commit('legacy-report', () => { throw new Error('No duplicate report'); }).duplicate).toBe(true);
    store!.commit('new-event', () => 'agent.updated');
    expect(store!.snapshot().cursor).toBe(2);
    expect(store!.replay(1)[0].state.manager.brief).toBe('Saved manager history');
  });

  it('does not turn a committed write into a failed command when a subscriber throws', () => {
    const store = new Store(':memory:', seed()); stores.push(store);
    store.subscribe(() => { throw new Error('Failed UI listener'); });
    expect(store.commit('saved', current => { current.manager.version = 1; return 'manager.processed'; }).duplicate).toBe(false);
    expect(store.snapshot().state.manager.version).toBe(1);
    expect(store.diagnostics().listenerFailures).toBe(1);
    expect(store.commit('saved', () => { throw new Error('Duplicate'); }).duplicate).toBe(true);
  });

  it.each(['partial', 'other-workspace', 'stale-cursor', 'different-state'])('refuses a %s pre-migration backup and preserves the original legacy history', kind => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-town-test-')); directories.push(directory);
    const path = join(directory, 'town.sqlite'), state = seed(), legacy = new Database(path);
    legacy.exec(readFileSync(join(process.cwd(), 'apps/service/drizzle/0000_local_preview.sql'), 'utf8'));
    legacy.exec('CREATE TABLE __drizzle_migrations(id INTEGER PRIMARY KEY,hash TEXT NOT NULL,created_at NUMERIC)');
    legacy.prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,?)').run('legacy', 1789401600000);
    legacy.prepare('INSERT INTO town_state(id,cursor,data) VALUES(?,1,?)').run(state.workspace.id, JSON.stringify(state));
    legacy.prepare('INSERT INTO events(source_id,fingerprint,type,occurred_at,data) VALUES(?,?,?,?,?)').run('protected-report', 'protected-report', 'report.saved', new Date().toISOString(), JSON.stringify(state));
    const backupPath = `${path}.before-v2.bak`;
    if (kind === 'partial') writeFileSync(backupPath, 'incomplete SQLite backup');
    else {
      legacy.prepare('VACUUM INTO ?').run(backupPath);
      const backup = new Database(backupPath);
      if (kind === 'other-workspace') backup.prepare('UPDATE town_state SET id=?').run('another-workspace');
      if (kind === 'stale-cursor') backup.prepare('UPDATE town_state SET cursor=0').run();
      if (kind === 'different-state') { state.manager.brief = 'Unrelated old state'; backup.prepare('UPDATE town_state SET data=?').run(JSON.stringify(state)); }
      backup.close();
    }
    legacy.close(); const originalBackup = readFileSync(backupPath);
    expect(() => new Store(path, seed())).toThrow('pre-migration backup');
    expect(readFileSync(backupPath)).toEqual(originalBackup);
    const preserved = new Database(path, { readonly: true });
    try {
      expect(preserved.pragma('user_version', { simple: true })).toBe(0);
      expect(preserved.prepare('SELECT source_id FROM events').all()).toEqual([{ source_id: 'protected-report' }]);
      expect(preserved.prepare("SELECT name FROM sqlite_master WHERE name='command_receipts'").get()).toBeUndefined();
    } finally { preserved.close(); }
  });

  it('migrates every receipt across multiple bounded batches and reuses a matching verified backup', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-town-test-')); directories.push(directory);
    const path = join(directory, 'town.sqlite'), state = seed(), legacy = new Database(path);
    legacy.exec(readFileSync(join(process.cwd(), 'apps/service/drizzle/0000_local_preview.sql'), 'utf8'));
    legacy.exec('CREATE TABLE __drizzle_migrations(id INTEGER PRIMARY KEY,hash TEXT NOT NULL,created_at NUMERIC)');
    legacy.prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,?)').run('legacy', 1789401600000);
    legacy.prepare('INSERT INTO town_state(id,cursor,data) VALUES(?,600,?)').run(state.workspace.id, JSON.stringify(state));
    const historical = JSON.stringify({ ...state, manager: { ...state.manager, brief: 'Historical context. '.repeat(1000) } });
    const insert = legacy.prepare('INSERT INTO events(source_id,fingerprint,type,occurred_at,data) VALUES(?,?,?,?,?)');
    legacy.transaction(() => { for (let i = 0; i < 600; i++) insert.run(`old-report-${i}`, `old-report-${i}`, 'report.saved', new Date().toISOString(), historical); })();
    legacy.prepare('VACUUM INTO ?').run(`${path}.before-v2.bak`); legacy.close();
    const hash = () => createHash('sha256').update(readFileSync(`${path}.before-v2.bak`)).digest('hex');
    const previousBackup = hash(), store = new Store(path, seed()); stores.push(store);
    expect(hash()).toBe(previousBackup);
    expect(store.diagnostics().receipts).toBe(600); expect(store.snapshot().cursor).toBe(600);
    for (const id of [0, 255, 256, 511, 599]) expect(store.commit(`old-report-${id}`, () => { throw new Error('Never repeat a report'); }).duplicate).toBe(true);
    expect(store.snapshot().state.manager.brief).toBe(state.manager.brief);
  });
});

describe('durable sample state', () => {
  it('starts paused and cannot be confused with a real account workspace', () => {
    const state = open().snapshot().state;
    expect(state.workspace.mode).toBe('demo');
    expect(state.simulation.running).toBe(false);
    expect(state.agents).toHaveLength(5);
  });

  it('saves reports across service restarts and deduplicates retried commands', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-town-test-')); directories.push(directory);
    const path = join(directory, 'preview.sqlite');
    const store = open(path);
    store.commit('report-1', (state, now) => applyDemoCommand(state, { action: 'handoff', agentId: 'milo' }, now));
    const saved = store.snapshot();
    stores.splice(stores.indexOf(store), 1); store.close();
    const restarted = open(path);
    expect(restarted.snapshot()).toEqual(saved);
    expect(restarted.commit('report-1', () => { throw new Error('Must not run twice'); }).duplicate).toBe(true);
    expect(restarted.snapshot().state.handoffs).toHaveLength(1);
  });

  it('rolls back state and event together if a transition fails', () => {
    const store = open();
    const before = store.snapshot();
    let published = false;
    store.subscribe(() => { published = true; });
    expect(() => store.commit('bad', state => { state.agents.length = 0; throw new Error('failed transition'); })).toThrow();
    expect(store.snapshot()).toEqual(before);
    expect(store.replay(0)).toEqual([]);
    expect(published).toBe(false);
  });

  it('publishes after commit and replays in cursor order', () => {
    const store = open();
    const seen: number[] = [];
    store.subscribe(event => { expect(store.snapshot().cursor).toBe(event.cursor); seen.push(event.cursor); });
    store.commit('one', state => { state.simulation.running = true; return 'demo.play'; });
    store.commit('two', state => { state.simulation.running = false; return 'demo.pause'; });
    expect(seen).toEqual([1, 2]);
    expect(store.replay(1).map(e => e.cursor)).toEqual([2]);
  });

  it('rejects an idempotency key reused for a different operation', () => {
    const store = open();
    store.commit('same-key', () => 'demo.play', 'play');
    expect(() => store.commit('same-key', () => 'demo.pause', 'pause')).toThrow('different command');
    expect(store.snapshot().cursor).toBe(1);
  });

  it('keeps saving, processing, context delivery and human acceptance separate', () => {
    const state = initialState();
    applyDemoCommand(state, { action: 'handoff', agentId: 'milo' }, '2026-09-14T10:00:00Z');
    expect(state.handoffs[0]!.status).toBe('saved');
    expect(state.manager.version).toBe(0);
    applyDemoCommand(state, { action: 'process', handoffId: state.handoffs[0]!.id }, '2026-09-14T10:01:00Z');
    expect(state.manager.version).toBe(1);
    expect(state.handoffs[0]!.delivery).toBe('unsupported');
    expect(state.agents[0]!.contextVersion).toBeNull();
    expect(state.agents[0]!.activity).toBe('review');
  });
});
