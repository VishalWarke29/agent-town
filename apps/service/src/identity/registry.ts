import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import Database from 'better-sqlite3';
import { IdentityError, type IdentityPrincipal, type PrivateWorkspace } from './types.js';

export function defaultApplicationDirectory(): string {
  const directory = process.env.LOCALAPPDATA;
  if (process.platform !== 'win32' || !directory || !isAbsolute(directory)) {
    throw new IdentityError('private_storage_unavailable', 'Private workspace storage requires a Windows user profile.', 503);
  }
  return join(directory, 'AgentTown');
}

interface OwnerRow { id: string; login: string; display_name: string; avatar_url: string | null; credential_ref: string | null; token_expires_at: number | null }
interface WorkspaceRow { id: string; owner_id: string; name: string; kind: 'personal' | 'company'; created_at: string }
const mapWorkspace = (row: WorkspaceRow): PrivateWorkspace => ({ id: row.id, ownerId: row.owner_id, name: row.name, kind: row.kind, createdAt: row.created_at });

/** Contains references, public identity, and ownership only; never credential values. */
export class IdentityRegistry {
  private readonly database: Database.Database;
  constructor(path = join(defaultApplicationDirectory(), 'app.sqlite')) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new Database(path);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('foreign_keys = ON');
    this.database.pragma('busy_timeout = 5000');
    const version = this.database.pragma('user_version', { simple: true });
    if (version !== 0 && version !== 1) { this.database.close(); throw new IdentityError('registry_version_unsupported', 'This identity database needs a newer Agent Town version.', 503); }
    this.database.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS identity_owners (
          id TEXT PRIMARY KEY, login TEXT NOT NULL, display_name TEXT NOT NULL, avatar_url TEXT,
          credential_ref TEXT, token_expires_at INTEGER, verified_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS private_workspaces (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES identity_owners(id), name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('personal', 'company')), created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS private_workspaces_owner ON private_workspaces(owner_id);
        PRAGMA user_version = 1;
      `);
    })();
  }

  registerOwner(principal: IdentityPrincipal, credentialRef: string, tokenExpiresAt: number | null): void {
    if (!/^[1-9][0-9]{0,19}$/.test(principal.id) || !/^[A-Za-z0-9_-]{10,160}$/.test(credentialRef)) throw new IdentityError('identity_invalid', 'A valid verified identity and credential reference are required.');
    this.database.prepare(`INSERT INTO identity_owners(id, login, display_name, avatar_url, credential_ref, token_expires_at, verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET login=excluded.login, display_name=excluded.display_name,
      avatar_url=excluded.avatar_url, credential_ref=excluded.credential_ref, token_expires_at=excluded.token_expires_at, verified_at=excluded.verified_at`)
      .run(principal.id, principal.login, principal.displayName, principal.avatarUrl, credentialRef, tokenExpiresAt, new Date().toISOString());
  }

  getOwner(ownerId: string): IdentityPrincipal | null {
    const row = this.database.prepare('SELECT * FROM identity_owners WHERE id = ?').get(ownerId) as OwnerRow | undefined;
    return row ? { id: row.id, login: row.login, displayName: row.display_name, avatarUrl: row.avatar_url } : null;
  }

  /** Local background services still validate each owner before opening a workspace. */
  listAllWorkspaces(): PrivateWorkspace[] {
    return (this.database.prepare('SELECT * FROM private_workspaces ORDER BY created_at').all() as WorkspaceRow[]).map(mapWorkspace);
  }

  credential(ownerId: string): { reference: string; expiresAt: number | null } | null {
    const row = this.database.prepare('SELECT * FROM identity_owners WHERE id = ?').get(ownerId) as OwnerRow | undefined;
    return row?.credential_ref ? { reference: row.credential_ref, expiresAt: row.token_expires_at } : null;
  }

  clearCredential(ownerId: string, expectedReference: string): void {
    this.database.prepare('UPDATE identity_owners SET credential_ref = NULL, token_expires_at = NULL WHERE id = ? AND credential_ref = ?').run(ownerId, expectedReference);
  }

  replaceCredential(ownerId: string, expectedReference: string, reference: string, expiresAt: number | null): boolean {
    if (!/^[A-Za-z0-9_-]{10,160}$/.test(reference)) throw new IdentityError('identity_invalid', 'Invalid protected credential reference.');
    return this.database.prepare('UPDATE identity_owners SET credential_ref = ?, token_expires_at = ? WHERE id = ? AND credential_ref = ?')
      .run(reference, expiresAt, ownerId, expectedReference).changes === 1;
  }

  listWorkspaces(ownerId: string): PrivateWorkspace[] {
    return (this.database.prepare('SELECT * FROM private_workspaces WHERE owner_id = ? ORDER BY created_at, id').all(ownerId) as WorkspaceRow[]).map(mapWorkspace);
  }

  createWorkspace(ownerId: string, name: string, kind: 'personal' | 'company' = 'personal'): PrivateWorkspace {
    const value = name.trim();
    if (!value || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value) || (kind !== 'personal' && kind !== 'company')) throw new IdentityError('workspace_invalid', 'Use a workspace name of 1 to 80 characters and a supported workspace type.');
    if (!this.getOwner(ownerId)) throw new IdentityError('identity_required', 'Sign in before creating a private workspace.', 401);
    if (this.listWorkspaces(ownerId).length >= 50) throw new IdentityError('workspace_limit', 'The local workspace limit is 50 per account.', 409);
    const workspace: PrivateWorkspace = { id: randomUUID(), ownerId, name: value, kind, createdAt: new Date().toISOString() };
    this.database.prepare('INSERT INTO private_workspaces(id, owner_id, name, kind, created_at) VALUES (?, ?, ?, ?, ?)').run(workspace.id, ownerId, value, kind, workspace.createdAt);
    return workspace;
  }

  requireWorkspace(ownerId: string, workspaceId: string): PrivateWorkspace {
    const row = this.database.prepare('SELECT * FROM private_workspaces WHERE id = ? AND owner_id = ?').get(workspaceId, ownerId) as WorkspaceRow | undefined;
    if (!row) throw new IdentityError('workspace_not_found', 'Workspace not found.', 404);
    return mapWorkspace(row);
  }

  close(): void { this.database.close(); }
}
