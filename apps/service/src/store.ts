import { mkdirSync, existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { type AgentHistoryDetail, type AgentHistoryPage, type AgentReportPage, type ArchivedAgent, type ArchivedRepository, type Repository, type Snapshot, type StateEvent, type TownState } from '@agent-town/contracts';
import { archiveReview } from './history-state.js';
import { IdentityError } from './identity/types.js';
import { CommandError, initialState } from './demo.js';
import { applyStatePatch, createStatePatch, type StatePatch } from './ops/patches.js';
import { NativeInventory } from './observation/native-inventory.js';

export const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
export interface StoreLimits { maxEvents: number; maxEventBytes: number; maxReceipts: number; maxPinnedReceipts: number }
const DEFAULT_LIMITS: StoreLimits = { maxEvents: 1000, maxEventBytes: 16 * 1024 * 1024, maxReceipts: 100_000, maxPinnedReceipts: 50_000 };
interface StateRow { cursor: number; data: string }
interface EventRow { cursor: number; source_id: string; fingerprint: string; type: string; occurred_at: string; data: string }
type ReceiptEventRow = Omit<EventRow, 'data'>;
const pinned = (type: string) => /report|handoff|context|usage|budget|approval|task|run|manager|connection|workflow|archive/u.test(type)
  || !/^(observation\.|agent\.|session\.|turn\.|tool\.|telemetry\.|inventory\.|discovery\.|demo\.)/u.test(type);

export class ReplayUnavailableError extends Error {
  constructor() { super('The event cursor is outside retained history. Fetch a fresh snapshot.'); this.name = 'ReplayUnavailableError'; }
}

export class Store {
  private sqlite: Database.Database;
  readonly native: NativeInventory;
  private listeners = new Set<(event: StateEvent) => void>();
  private workspaceId: string;
  private preview: boolean;
  private limits: StoreLimits;
  private closed = false;
  private listenerFailures = 0;

  constructor(path: string, seed: TownState = initialState(), limits: Partial<StoreLimits> = {}) {
    this.workspaceId = seed.workspace.id;
    this.preview = seed.workspace.mode === 'demo';
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    for (const name of Object.keys(DEFAULT_LIMITS) as (keyof StoreLimits)[]) {
      if (!Number.isSafeInteger(this.limits[name]) || this.limits[name] < 1 || this.limits[name] > DEFAULT_LIMITS[name]) throw new Error('Invalid storage limits.');
    }
    if (this.limits.maxPinnedReceipts > this.limits.maxReceipts) this.limits.maxPinnedReceipts = this.limits.maxReceipts;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const existed = path !== ':memory:' && existsSync(path);
    this.sqlite = new Database(path);
    this.native = new NativeInventory(this.sqlite, this.workspaceId);
    try {
      this.sqlite.pragma('journal_mode = WAL'); this.sqlite.pragma('busy_timeout = 5000'); this.sqlite.pragma('trusted_schema = OFF');
      const version = this.sqlite.pragma('user_version', { simple: true });
      if (typeof version !== 'number' || version > 4) throw new Error('This workspace database requires a newer Agent Town version.');
      // VACUUM INTO includes committed WAL data and does not copy a potentially stale main file.
      if (existed && version < 4) {
        const backup = `${path}.before-v${version < 2 ? 2 : version < 3 ? 3 : 4}.bak`;
        if (!existsSync(backup)) this.sqlite.prepare('VACUUM INTO ?').run(backup);
        this.verifyMigrationBackup(backup);
      }
      migrate(drizzle(this.sqlite), { migrationsFolder: `${projectRoot}/apps/service/drizzle` });
      this.sqlite.transaction(() => {
        const rows = this.sqlite.prepare('SELECT id FROM town_state').all() as { id: string }[];
        if (rows.some(row => row.id !== this.workspaceId)) throw new Error('This database belongs to a different workspace.');
        this.sqlite.prepare('INSERT OR IGNORE INTO town_state(id,cursor,data) VALUES(?,0,?)').run(this.workspaceId, JSON.stringify(seed));
        const row = this.currentRow();
        if (!this.sqlite.prepare('SELECT id FROM event_baseline WHERE id=?').get(this.workspaceId)) {
          // Historical full snapshots stay in the migration backup; receipts and durable current records stay live.
          const insert = this.sqlite.prepare('INSERT OR IGNORE INTO command_receipts(source_id,fingerprint,cursor,created_at,pinned) VALUES(?,?,?,?,?)');
          // Finish each bounded read before writing: better-sqlite3 does not
          // allow mutations while its iterator has an active query. Never fetch
          // legacy events.data, which may contain gigabytes of full snapshots.
          let after = -1;
          const receipts = this.sqlite.prepare('SELECT source_id,fingerprint,cursor,occurred_at,type FROM events WHERE cursor>? ORDER BY cursor LIMIT 256');
          for (;;) {
            const batch = receipts.all(after) as ReceiptEventRow[];
            if (!batch.length) break;
            for (const event of batch) insert.run(event.source_id, event.fingerprint, event.cursor, event.occurred_at, pinned(event.type) ? 1 : 0);
            after = batch.at(-1)!.cursor;
          }
          this.sqlite.prepare('INSERT INTO event_baseline(id,cursor,data) VALUES(?,?,?)').run(this.workspaceId, row.cursor, row.data);
          this.sqlite.prepare('DELETE FROM events').run();
        }
        this.pruneReceipts(new Date().toISOString());
        this.native.preserveLegacyAliases(JSON.parse(this.currentRow().data) as TownState);
      })();
      // Reclaim the legacy full-snapshot pages once. Later bounded journals reuse
      // their freed pages; ordinary commits never run this blocking rebuild.
      if (existed && version < 2) this.sqlite.exec('VACUUM');
    } catch (error) { this.sqlite.close(); throw error; }
  }

  private verifyMigrationBackup(path: string): void {
    let backup: Database.Database | undefined;
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error('Unsafe migration backup');
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try { lstatSync(`${path}${suffix}`); throw new Error('Migration backup has a sidecar'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      backup = new Database(path, { readonly: true, fileMustExist: true });
      backup.pragma('trusted_schema = OFF');
      if (backup.pragma('integrity_check', { simple: true }) !== 'ok'
        || backup.pragma('user_version', { simple: true }) !== this.sqlite.pragma('user_version', { simple: true })) throw new Error('Invalid migration backup');
      const schema = (database: Database.Database) => database.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
      if (JSON.stringify(schema(backup)) !== JSON.stringify(schema(this.sqlite))) throw new Error('Migration backup schema differs');
      const hasState = this.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='town_state'").get();
      if (hasState) {
        const read = (database: Database.Database) => database.prepare('SELECT id,cursor,data FROM town_state ORDER BY id').all();
        if (JSON.stringify(read(backup)) !== JSON.stringify(read(this.sqlite))) throw new Error('Migration backup state differs');
      }
      if (this.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").get()) {
        const count = (database: Database.Database) => database.prepare('SELECT count(*) AS count,max(cursor) AS cursor FROM events').get();
        if (JSON.stringify(count(backup)) !== JSON.stringify(count(this.sqlite))) throw new Error('Migration backup history differs');
      }
    } catch {
      throw new Error('The pre-migration backup is missing, invalid, or does not match this workspace. Migration stopped; preserve both files and inspect the backup before retrying.');
    } finally { backup?.close(); }
  }

  private currentRow(): StateRow { return this.sqlite.prepare('SELECT cursor,data FROM town_state WHERE id=?').get(this.workspaceId) as StateRow; }
  private baseline(): StateRow { return this.sqlite.prepare('SELECT cursor,data FROM event_baseline WHERE id=?').get(this.workspaceId) as StateRow; }

  snapshot(): Snapshot {
    const row = this.currentRow();
    return { cursor: row.cursor, state: JSON.parse(row.data) as TownState };
  }

  archiveAgent(id: string, reviewToken: string) {
    // A prior receipt must not turn an obsolete review into success after resume.
    const current = this.snapshot().state, live = current.agents.find(agent => agent.id === id);
    if (live && archiveReview(current, live).reviewToken !== reviewToken) throw new IdentityError('ARCHIVE_REVIEW_CHANGED', 'The session changed. Review its latest state before archiving.', 409);
    return this.commit(`agent-archive:${id}:${reviewToken}`, (state, now) => {
      if (state.workspace.mode !== 'private') throw new IdentityError('PRIVATE_WORKSPACE_REQUIRED', 'Only private sessions can be archived.');
      const agent = state.agents.find(agent => agent.id === id);
      if (!agent) throw new IdentityError('AGENT_NOT_FOUND', 'This live session is no longer available.', 404);
      const review = archiveReview(state, agent);
      if (review.reviewToken !== reviewToken) throw new IdentityError('ARCHIVE_REVIEW_CHANGED', 'The session changed. Review its latest state before archiving.', 409);
      if (!review.allowed) throw new IdentityError('AGENT_STILL_ACTIVE', review.reasons.join(' '), 409);
      const record: ArchivedAgent = { agent, repository: state.repositories.find(repo => repo.id === agent.repoId)!, archivedAt: now };
      this.sqlite.prepare('INSERT INTO agent_archive(id,repo_id,connection_id,session_id,parent_session_id,archived_at,data) VALUES(?,?,?,?,?,?,?)')
        .run(id, agent.repoId, agent.observation?.connectionId ?? null, agent.observation?.sessionId ?? null, agent.observation?.parentSessionId ?? null, now, JSON.stringify(record));
      state.agents = state.agents.filter(agent => agent.id !== id);
      state.history = { archivedAgents: this.archiveCount(), updatedAt: now };
      return 'agent.history_archived';
    });
  }

  private archiveCount(): number { return (this.sqlite.prepare('SELECT count(*) AS count FROM agent_archive').get() as { count: number }).count; }

  history(offset = 0, limit = 25): AgentHistoryPage {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid history page.');
    const rows = this.sqlite.prepare('SELECT data FROM agent_archive ORDER BY archived_at DESC,id LIMIT ? OFFSET ?').all(limit, offset) as { data: string }[];
    const items = rows.map(row => { const record = JSON.parse(row.data) as ArchivedAgent; return { id: record.agent.id, name: record.agent.name, provider: record.agent.provider, repoId: record.agent.repoId, repositoryName: record.repository.name, activity: record.agent.activity, updatedAt: record.agent.updatedAt, archivedAt: record.archivedAt }; });
    const total = this.archiveCount();
    return { items, total, nextOffset: offset + items.length < total ? offset + items.length : null };
  }

  historyDetail(id: string, offset = 0, limit = 25): AgentHistoryDetail {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid report history page.');
    const row = this.sqlite.prepare('SELECT data FROM agent_archive WHERE id=?').get(id) as { data: string } | undefined;
    if (!row) throw new IdentityError('HISTORY_NOT_FOUND', 'This archived session is unavailable. It may have resumed in the live town.', 404);
    const record = JSON.parse(row.data) as ArchivedAgent, state = this.snapshot().state;
    const runs = state.runner?.runs.filter(run => run.id === record.agent.id) ?? [];
    return { ...record, ...this.reportPage(state, record.agent.id, offset, limit), runs, tasks: state.runner?.tasks.filter(task => runs.some(run => run.taskId === task.id)) ?? [] };
  }

  agentReports(id: string, offset = 0, limit = 25): AgentReportPage {
    const state = this.snapshot().state;
    if (!state.agents.some(agent => agent.id === id) && !this.sqlite.prepare('SELECT id FROM agent_archive WHERE id=?').get(id)) {
      try { id = this.native.detail(id, state).id; }
      catch (error) {
        if (!(error instanceof IdentityError) || error.code !== 'NATIVE_SESSION_NOT_FOUND') throw error;
        throw new IdentityError('AGENT_NOT_FOUND', 'This session is unavailable.', 404);
      }
    }
    return this.reportPage(state, id, offset, limit);
  }

  private reportPage(state: TownState, id: string, offset: number, limit: number): AgentReportPage {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid report history page.');
    // Ingestion paths can prepend or append; report time and ID define one order.
    const reports = state.handoffs.filter(report => report.agentId === id)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.id.localeCompare(right.id));
    return { reports: reports.slice(offset, offset + limit), reportCount: reports.length, reportsNextOffset: offset + limit < reports.length ? offset + limit : null };
  }

  archivedObservation(connectionId: string, sessionId: string, parentSessionId: string | null): ArchivedAgent | undefined {
    const row = this.sqlite.prepare('SELECT data FROM agent_archive WHERE connection_id=? AND session_id=? AND parent_session_id IS ?').get(connectionId, sessionId, parentSessionId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as ArchivedAgent : undefined;
  }

  saveRepositoryHistory(repository: Repository, now: string): void {
    if (!this.sqlite.inTransaction) throw new Error('Repository history requires an active state transaction.');
    const record: ArchivedRepository = { repository, disconnectedAt: now };
    this.sqlite.prepare('INSERT INTO repository_archive(id,disconnected_at,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET disconnected_at=excluded.disconnected_at,data=excluded.data').run(repository.id, now, JSON.stringify(record));
  }

  repositoryHistory(id: string): ArchivedRepository {
    const row = this.sqlite.prepare('SELECT data FROM repository_archive WHERE id=?').get(id) as { data: string } | undefined;
    if (!row) throw new IdentityError('HISTORY_NOT_FOUND', 'This disconnected repository is unavailable.', 404);
    return JSON.parse(row.data) as ArchivedRepository;
  }

  /** Called only inside the observation commit: history and live state move atomically. */
  saveArchivedObservation(record: ArchivedAgent, state: TownState, now: string): void {
    if (!this.sqlite.inTransaction) throw new Error('Archive updates require an active state transaction.');
    if (state.agents.some(agent => agent.id === record.agent.id)) this.sqlite.prepare('DELETE FROM agent_archive WHERE id=?').run(record.agent.id);
    else this.sqlite.prepare('UPDATE agent_archive SET connection_id=?,session_id=?,parent_session_id=?,data=? WHERE id=?').run(record.agent.observation?.connectionId ?? null, record.agent.observation?.sessionId ?? null, record.agent.observation?.parentSessionId ?? null, JSON.stringify(record), record.agent.id);
    state.history = { archivedAgents: this.archiveCount(), updatedAt: now };
  }

  commit(sourceId: string, change: (state: TownState, now: string) => string, fingerprint = sourceId): { duplicate: boolean; snapshot: Snapshot } {
    const fingerprintHash = createHash('sha256').update(fingerprint).digest('hex');
    let committed: StateEvent | undefined;
    const duplicate = this.sqlite.transaction(() => {
      const existing = (this.sqlite.prepare('SELECT fingerprint FROM command_receipts WHERE source_id=?').get(sourceId)
        ?? this.sqlite.prepare('SELECT fingerprint FROM events WHERE source_id=?').get(sourceId)) as { fingerprint: string } | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprintHash && existing.fingerprint !== fingerprint) throw new CommandError('This action identifier was already used for a different command.');
        return true;
      }
      const row = this.currentRow();
      if (this.preview && row.cursor >= 10000) throw new CommandError('The preview event store is full. Start a separate preview using AGENT_TOWN_DATA_DIR.');
      const before = JSON.parse(row.data) as TownState;
      const state = structuredClone(before);
      const now = new Date().toISOString();
      const type = change(state, now);
      if (typeof type !== 'string' || !type || type.length > 160 || !sourceId || sourceId.length > 512
        || state.workspace.id !== this.workspaceId || state.workspace.mode !== before.workspace.mode) throw new CommandError('Invalid workspace transition.');
      if (pinned(type)) {
        const count = this.sqlite.prepare('SELECT count(*) AS count FROM command_receipts WHERE pinned=1').get() as { count: number };
        if (count.count >= this.limits.maxPinnedReceipts) throw new CommandError('The protected action history limit is reached. Existing reports and billing records are preserved; archive this workspace before starting more work.');
      }
      const data = JSON.stringify(state), savedState = JSON.parse(data) as TownState;
      const patch = JSON.stringify({ version: 1, patch: createStatePatch(before, savedState) });
      const saved = this.sqlite.prepare('INSERT INTO events(source_id,fingerprint,type,occurred_at,data) VALUES(?,?,?,?,?) RETURNING cursor')
        .get(sourceId, fingerprintHash, type, now, patch) as { cursor: number };
      this.sqlite.prepare('INSERT INTO command_receipts(source_id,fingerprint,cursor,created_at,pinned) VALUES(?,?,?,?,?)')
        .run(sourceId, fingerprintHash, saved.cursor, now, pinned(type) ? 1 : 0);
      this.sqlite.prepare('UPDATE town_state SET cursor=?,data=? WHERE id=?').run(saved.cursor, data, this.workspaceId);
      this.pruneHistory(); this.pruneReceipts(now);
      committed = { cursor: saved.cursor, state: savedState, type, occurredAt: now };
      return false;
    })();
    // Publish only after the state and its event are durable together.
    if (committed) for (const listener of this.listeners) {
      try { listener(committed); } catch { this.listeners.delete(listener); this.listenerFailures++; }
    }
    return { duplicate, snapshot: this.snapshot() };
  }

  replay(after: number, limit = 200): StateEvent[] {
    if (!this.canReplay(after)) throw new ReplayUnavailableError();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid replay limit.');
    if (after === this.currentRow().cursor) return [];
    let state = JSON.parse(this.baseline().data) as TownState;
    const result: StateEvent[] = [];
    for (const row of this.sqlite.prepare('SELECT * FROM events ORDER BY cursor').iterate() as Iterable<EventRow>) {
      state = this.applyEvent(state, row.data);
      if (row.cursor > after) result.push({ cursor: row.cursor, type: row.type, occurredAt: row.occurred_at, state: structuredClone(state) });
      if (result.length >= limit) break;
    }
    return result;
  }

  canReplay(after: number, maximumEvents?: number): boolean {
    if (!Number.isSafeInteger(after) || after < this.baseline().cursor || after > this.currentRow().cursor) return false;
    return maximumEvents === undefined || (Number.isSafeInteger(maximumEvents) && maximumEvents >= 0
      && (this.sqlite.prepare('SELECT count(*) AS count FROM events WHERE cursor>?').get(after) as { count: number }).count <= maximumEvents);
  }

  private applyEvent(state: TownState, data: string): TownState {
    const parsed = JSON.parse(data) as { version: number; patch: StatePatch[] };
    if (parsed.version !== 1 || !Array.isArray(parsed.patch)) throw new Error('The event journal is invalid. Restore a verified backup.');
    return applyStatePatch(state, parsed.patch);
  }

  private pruneReceipts(now: string): void {
    const cutoff = new Date(Date.parse(now) - 30 * 86_400_000).toISOString();
    this.sqlite.prepare('DELETE FROM command_receipts WHERE pinned=0 AND created_at < ?').run(cutoff);
    const total = (this.sqlite.prepare('SELECT count(*) AS count FROM command_receipts').get() as { count: number }).count;
    if (total > this.limits.maxReceipts) this.sqlite.prepare('DELETE FROM command_receipts WHERE source_id IN (SELECT source_id FROM command_receipts WHERE pinned=0 ORDER BY cursor LIMIT ?)').run(total - this.limits.maxReceipts);
  }

  private pruneHistory(): void {
    const rows = this.sqlite.prepare('SELECT cursor,length(CAST(data AS BLOB)) AS bytes FROM events ORDER BY cursor').all() as { cursor: number; bytes: number }[];
    let total = rows.reduce((sum, row) => sum + row.bytes, 0);
    if (rows.length <= this.limits.maxEvents && total <= this.limits.maxEventBytes) return;
    const targetCount = Math.floor(this.limits.maxEvents * 0.8), targetBytes = this.limits.maxEventBytes * 0.8;
    let remove = 0;
    while (remove < rows.length && (rows.length - remove > targetCount || total > targetBytes)) { total -= rows[remove].bytes; remove++; }
    const cutoff = rows[remove - 1].cursor;
    let state = JSON.parse(this.baseline().data) as TownState;
    for (const row of this.sqlite.prepare('SELECT data FROM events WHERE cursor<=? ORDER BY cursor').all(cutoff) as { data: string }[]) state = this.applyEvent(state, row.data);
    this.sqlite.prepare('UPDATE event_baseline SET cursor=?,data=? WHERE id=?').run(cutoff, JSON.stringify(state), this.workspaceId);
    this.sqlite.prepare('DELETE FROM events WHERE cursor<=?').run(cutoff);
  }

  diagnostics() {
    const history = this.sqlite.prepare('SELECT count(*) AS events,coalesce(sum(length(CAST(data AS BLOB))),0) AS eventBytes FROM events').get() as { events: number; eventBytes: number };
    return { storageVersion: this.sqlite.pragma('user_version', { simple: true }) as number, cursor: this.currentRow().cursor, replayAfter: this.baseline().cursor, ...history, archivedAgents: this.archiveCount(),
      receipts: (this.sqlite.prepare('SELECT count(*) AS count FROM command_receipts').get() as { count: number }).count,
      snapshotBytes: Buffer.byteLength(this.currentRow().data), listenerFailures: this.listenerFailures };
  }

  subscribe(listener: (event: StateEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() { if (this.closed) return; this.closed = true; this.listeners.clear(); this.sqlite.pragma('wal_checkpoint(PASSIVE)'); this.sqlite.close(); }
}
