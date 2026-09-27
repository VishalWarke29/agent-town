import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { describeBackupAllowlist } from '../../apps/service/src/ops/backup';
import { projectRoot } from '../../apps/service/src/store';

// WS8-13: the backup allowlist (ops/backup.ts:24-38) is a closed list. openValidated
// rejects any table or column it does not recognize with 'unsupported-schema', so a
// migration that adds storage without updating this allowlist makes every future
// backup of that database unrestorable (proved by the mutation check below). This
// file is the named guard rail: it fails loudly, with a fix-it message, the moment
// the allowlist and the real migrated schema drift apart.

const roots: string[] = [];
function migratedCopy(): Database.Database {
  const directory = mkdtempSync(join(tmpdir(), 'agent-town-backup-parity-'));
  roots.push(directory);
  const database = new Database(join(directory, 'town.sqlite'));
  migrate(drizzle(database), { migrationsFolder: join(projectRoot, 'apps/service/drizzle') });
  return database;
}
afterEach(() => {
  for (const directory of roots.splice(0)) {
    if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}agent-town-backup-parity-`)) throw new Error('Unsafe fixture cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Mirrors the exact introspection ops/backup.ts's openValidated performs, so this test sees precisely what backup validation sees. */
function realSchema(database: Database.Database): Map<string, Set<string>> {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  const result = new Map<string, Set<string>>();
  for (const { name } of tables) {
    const columns = database.prepare(`PRAGMA table_xinfo("${name}")`).all() as { name: string; hidden: number }[];
    result.set(name, new Set(columns.filter(column => column.hidden === 0).map(column => column.name)));
  }
  return result;
}

const REGISTRY_HINT = 'a new table or column must be added to the storage registry (WS8-22) and get a restore test';

/** Returns one description per table/column mismatch between the real schema and the backup allowlist (ops/backup.ts:24-38), or [] when they agree. */
function allowlistMismatches(schema: Map<string, Set<string>>): string[] {
  const { allowedTables, allowedColumns } = describeBackupAllowlist();
  const covered = new Set(Object.values(allowedTables).flatMap(set => [...set]));
  const mismatches: string[] = [];
  for (const [table, columns] of schema) {
    if (!covered.has(table)) { mismatches.push(`table '${table}' is not in any Kind's allowedTables`); continue; }
    const expected = allowedColumns[table];
    if (!expected) { mismatches.push(`table '${table}' has no allowedColumns entry`); continue; }
    const expectedSet = new Set(expected);
    const missing = [...columns].filter(column => !expectedSet.has(column));
    const extra = expected.filter(column => !columns.has(column));
    if (missing.length || extra.length) mismatches.push(`table '${table}' columns differ (schema has ${JSON.stringify([...columns])}, allowlist has ${JSON.stringify(expected)})`);
  }
  return mismatches;
}

describe('backup schema allowlist parity (WS8-13)', () => {
  it('keeps ops/backup.ts:24-38 in parity with every table and column the shipped migrations create', () => {
    const database = migratedCopy();
    try {
      const mismatches = allowlistMismatches(realSchema(database));
      if (mismatches.length) throw new Error(`Backup allowlist drift detected: ${mismatches.join('; ')}. ${REGISTRY_HINT}.`);
    } finally { database.close(); }
  });

  it('mutation check: an unregistered table is actually caught, proving the parity guard is not vacuous', () => {
    const database = migratedCopy();
    try {
      // Simulate a migration that added a table without updating the backup allowlist.
      database.exec('CREATE TABLE ws8_13_unregistered_probe (id TEXT PRIMARY KEY NOT NULL, secret TEXT NOT NULL)');
      const mismatches = allowlistMismatches(realSchema(database));
      expect(mismatches.some(message => message.includes('ws8_13_unregistered_probe'))).toBe(true);
      // The same message the real test above would throw, so a future reader sees the fix-it text in either place.
      expect(`${mismatches.join('; ')}. ${REGISTRY_HINT}.`).toContain(REGISTRY_HINT);
    } finally { database.close(); }
  });

  it('mutation check: an unregistered column on an existing table is also caught', () => {
    const database = migratedCopy();
    try {
      database.exec('ALTER TABLE town_state ADD COLUMN ws8_13_unregistered_column TEXT');
      const mismatches = allowlistMismatches(realSchema(database));
      expect(mismatches.some(message => message.includes('town_state') && message.includes('ws8_13_unregistered_column'))).toBe(true);
    } finally { database.close(); }
  });
});
