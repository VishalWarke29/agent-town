import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { Store } from '../../apps/service/src/store';
import { introspectOpenDatabase, introspectReadOnlyFile } from '../../apps/service/src/db-visualizer';

describe('database visualizer introspection', () => {
  it('reads this workspace\'s own schema and counts, with no row content and no hidden columns for a plain table', () => {
    const store = new Store(':memory:');
    try {
      const group = store.dbSchemaGroup();
      expect(group.fileKind).toBe('workspace');
      const names = group.tables.map(table => table.name).sort();
      // A fresh workspace also carries drizzle's own migration-tracking table and the native-inventory
      // tables NativeInventory creates outside schema.ts; this asserts the four town-state tables schema.ts
      // declares are all found, not that they are the only tables a real workspace ever has.
      expect(names).toEqual(expect.arrayContaining(['command_receipts', 'event_baseline', 'events', 'town_state']));
      const townState = group.tables.find(table => table.name === 'town_state')!;
      expect(townState.rowCount).toBe(1);
      expect(townState.hiddenColumnCount).toBe(0);
      expect(townState.columns.map(column => column.name).sort()).toEqual(['cursor', 'data', 'id']);
      // schema.ts declares no foreign keys today; a future migration adding one should show up here, not be assumed away.
      expect(group.foreignKeys).toEqual([]);
    } finally { store.close(); }
  });

  it('never shows a known-sensitive column, by name or value, even though it still counts rows', () => {
    const database = new Database(':memory:');
    try {
      database.exec('CREATE TABLE identity_owners (id TEXT PRIMARY KEY, login TEXT, credential_ref TEXT, token_expires_at INTEGER)');
      database.prepare('INSERT INTO identity_owners VALUES (?,?,?,?)').run('owner-1', 'octocat', 'vault-ref-secret', 123);
      const group = introspectOpenDatabase(database, 'test identity', 'identity');
      const table = group.tables.find(t => t.name === 'identity_owners')!;
      expect(table.columns.map(c => c.name)).toEqual(['id', 'login']);
      expect(table.hiddenColumnCount).toBe(2);
      expect(table.rowCount).toBe(1);
      expect(JSON.stringify(group)).not.toContain('vault-ref-secret');
    } finally { database.close(); }
  });

  it('captures a real foreign key between two tables', () => {
    const database = new Database(':memory:');
    try {
      database.exec('CREATE TABLE identity_owners (id TEXT PRIMARY KEY)');
      database.exec('CREATE TABLE private_workspaces (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES identity_owners(id))');
      const group = introspectOpenDatabase(database, 'test identity', 'identity');
      expect(group.foreignKeys).toEqual([{ fromTable: 'private_workspaces', fromColumn: 'owner_id', toTable: 'identity_owners', toColumn: 'id' }]);
    } finally { database.close(); }
  });

  it('skips a table whose name is not a safe identifier instead of interpolating it into SQL', () => {
    const database = new Database(':memory:');
    try {
      // A quoted identifier can legally contain characters that would break naive string interpolation.
      database.exec('CREATE TABLE "evil""; DROP TABLE sqlite_master; --" (id TEXT)');
      database.exec('CREATE TABLE safe_table (id TEXT)');
      const group = introspectOpenDatabase(database, 'test', 'workspace');
      expect(group.tables.map(t => t.name)).toEqual(['safe_table']);
    } finally { database.close(); }
  });

  it('degrades gracefully to null when the file does not exist, instead of throwing', () => {
    expect(introspectReadOnlyFile('C:/definitely/not/a/real/path/nowhere.sqlite', 'missing', 'identity')).toBeNull();
  });
});
