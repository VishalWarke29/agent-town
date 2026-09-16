import Database from 'better-sqlite3';
import { createHash, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { ObservationConnection } from '@agent-town/contracts';
import { IdentityError } from '../identity/index.js';

export interface RegisteredObservation { connection: ObservationConnection; workspaceId: string; ownerId: string; repoPath: string; nativeHome?: string }
interface Row { id: string; workspace_id: string; owner_id: string; repo_path: string; token_hash: string; revoked: number; data: string }
export class ObservationRegistry {
  private db: Database.Database;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path); this.db.pragma('journal_mode = WAL'); this.db.pragma('busy_timeout = 5000');
    this.db.exec('CREATE TABLE IF NOT EXISTS observation_connections (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, repo_path TEXT NOT NULL, token_hash TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL)');
  }
  register(record: RegisteredObservation, token: string) {
    // The route awaits credential protection after its early duplicate check.
    // Serialize this final check with insertion, including other registry handles.
    this.db.transaction(() => {
      const active = this.all();
      if (active.some(item => item.workspaceId === record.workspaceId && item.connection.repoId === record.connection.repoId && item.connection.provider === record.connection.provider && item.connection.nativeSourceId === record.connection.nativeSourceId)) throw new IdentityError('CONNECTION_EXISTS', 'This tool and profile already have an active connection for this repository.', 409);
      if (active.length >= 100) throw new IdentityError('CONNECTOR_CAPACITY', 'Use up to 100 active observation connections.', 429);
      this.db.prepare('INSERT INTO observation_connections(id,workspace_id,owner_id,repo_path,token_hash,data) VALUES (?,?,?,?,?,?)').run(record.connection.id, record.workspaceId, record.ownerId, record.repoPath, createHash('sha256').update(token).digest('hex'), JSON.stringify({ ...record.connection, ...(record.nativeHome ? { __nativeHome: record.nativeHome } : {}) }));
    }).immediate();
  }
  private map(row: Row): RegisteredObservation {
    const { __nativeHome, ...connection } = JSON.parse(row.data) as ObservationConnection & { __nativeHome?: string };
    return { connection: { ...connection, ...(row.revoked ? { status: 'revoked' as const } : {}) }, workspaceId: row.workspace_id, ownerId: row.owner_id, repoPath: row.repo_path, ...(__nativeHome ? { nativeHome: __nativeHome } : {}) };
  }
  bindSource(id: string, source: { id: string; revision: number; homePath: string }): RegisteredObservation {
    const record = this.get(id);
    if (!record || record.connection.status === 'revoked') throw new IdentityError('CONNECTION_REVOKED', 'Create a new connection before binding this profile.', 409);
    if (this.all().some(other => other.connection.id !== id && other.workspaceId === record.workspaceId && other.connection.repoId === record.connection.repoId && other.connection.nativeSourceId === source.id)) throw new IdentityError('CONNECTION_EXISTS', 'This profile already has a connection for this project.', 409);
    if (record.connection.nativeSourceId && record.connection.nativeSourceId !== source.id) throw new IdentityError('SOURCE_ALREADY_BOUND', 'Use a separate observation connection for a different native profile.', 409);
    record.connection = { ...record.connection, nativeSourceId: source.id, sourceRevision: source.revision, binding: 'declared' };
    record.nativeHome = source.homePath;
    this.db.prepare('UPDATE observation_connections SET data=? WHERE id=? AND revoked=0').run(JSON.stringify({ ...record.connection, __nativeHome: source.homePath }), id);
    return record;
  }
  get(id: string): RegisteredObservation | null {
    const row = this.db.prepare('SELECT * FROM observation_connections WHERE id=?').get(id) as Row | undefined;
    return row ? this.map(row) : null;
  }
  all(): RegisteredObservation[] { return (this.db.prepare('SELECT * FROM observation_connections WHERE revoked=0').all() as Row[]).map(row => this.map(row)); }
  authenticate(bearer: string | undefined): RegisteredObservation {
    const match = /^Bearer ([a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(bearer ?? '');
    if (!match) throw new IdentityError('CONNECTOR_AUTH_REQUIRED', 'A scoped observation credential is required.', 401);
    const row = this.db.prepare('SELECT * FROM observation_connections WHERE id=? AND revoked=0').get(match[1]) as Row | undefined;
    const supplied = createHash('sha256').update(match[2]!).digest();
    if (!row || !timingSafeEqual(Buffer.from(row.token_hash, 'hex'), supplied)) throw new IdentityError('CONNECTOR_AUTH_REQUIRED', 'This observation credential is unavailable.', 401);
    return this.map(row);
  }
  revoke(id: string) { this.db.prepare('UPDATE observation_connections SET revoked=1 WHERE id=?').run(id); }
  close() { this.db.close(); }
}
