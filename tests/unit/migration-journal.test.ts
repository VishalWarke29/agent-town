import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LATEST_WORKSPACE_VERSION, migrationBackupVersion, tablesRequiredAtVersion, WORKSPACE_SCHEMA_VERSIONS, WORKSPACE_SCHEMA_VERSION_NUMBERS } from '../../apps/service/src/storage-registry';
import { projectRoot } from '../../apps/service/src/store';

// drizzle-orm 0.45.2 applies a migration only when its journal `when` is
// strictly greater than the last applied one (drizzle-orm/dist/.../dialect.js,
// migrator branch); an out-of-order or duplicate `when` is silently skipped and
// leaves a database at the new user_version without its tables. This is the
// guard rail WS8-22 (one storage and migration plan) requires: every
// workstream that adds a table depends on this test staying green. See
// docs/records/storage-plan.md.
const drizzleDirectory = join(projectRoot, 'apps/service/drizzle');
interface JournalEntry { idx: number; version: string; when: number; tag: string; breakpoints: boolean }
interface Journal { version: string; dialect: string; entries: JournalEntry[] }
const journal = JSON.parse(readFileSync(join(drizzleDirectory, 'meta/_journal.json'), 'utf8')) as Journal;

// Pinned at the time each migration shipped. A shipped file must never change:
// editing history here would silently rewrite what already-migrated databases
// were told they received. Add a new line for a new migration; never edit one.
const SHIPPED_MIGRATION_HASHES: Record<string, string> = {
  '0000_local_preview': '9cd30fbb6c47bb82effdf27c6dd06ad6ff6b8a28eaa7c08cd0721cd34e4ffccd',
  '0001_compact_event_history': 'a05a04a853eea19d5f95bfdba2e6885d0db004c52bac00d9ed2a58319db1c79f',
  '0002_agent_archive': '0ec6775b4cd705682d8da42f9d7008a1e85f2b7bb7a321060e2c1905d4eb9650',
  '0003_native_sessions': '439a18d621bef4e9d2247fe6912efae5a57f1e531bdddfe0f5ba6088f7485b45',
};

describe('migration journal invariants (WS8-22)', () => {
  it('keeps every entry strictly increasing by idx and when, each pointing at a real SQL file', () => {
    let previousWhen = -Infinity;
    journal.entries.forEach((entry, index) => {
      expect(entry.idx, `entry ${index} has idx ${entry.idx}, expected ${index}`).toBe(index);
      expect(entry.when, `entry ${entry.tag} has when=${entry.when}, which is not strictly greater than the previous entry's ${previousWhen}. drizzle-orm silently skips a non-increasing entry, leaving the database at a new user_version without that migration's tables.`).toBeGreaterThan(previousWhen);
      previousWhen = entry.when;
      const file = join(drizzleDirectory, `${entry.tag}.sql`);
      expect(existsSync(file), `Journal entry '${entry.tag}' has no matching SQL file at ${file}.`).toBe(true);
    });
  });

  it('pins the hash of every shipped migration file so an edit to a released migration is caught', () => {
    for (const entry of journal.entries) {
      const expected = SHIPPED_MIGRATION_HASHES[entry.tag];
      expect(expected, `Journal tag '${entry.tag}' has no pinned hash in this test. A shipped migration file must never be edited; add a new migration instead, and pin its hash here once it ships.`).toBeDefined();
      const actual = createHash('sha256').update(readFileSync(join(drizzleDirectory, `${entry.tag}.sql`), 'utf8')).digest('hex');
      expect(actual, `Shipped migration '${entry.tag}.sql' no longer matches its pinned hash: its content changed after release. Add a new migration instead of editing a shipped one.`).toBe(expected);
    }
  });

  it('has one journal entry, in order, per registered workspace schema version', () => {
    const taggedVersions = WORKSPACE_SCHEMA_VERSIONS.map(entry => entry.migrationTag);
    const journalTags = journal.entries.map(entry => entry.tag).filter(tag => taggedVersions.includes(tag));
    expect(journalTags).toEqual(taggedVersions);
  });

  it('never lets store.ts hard-code the latest version literal again', () => {
    const source = readFileSync(join(projectRoot, 'apps/service/src/store.ts'), 'utf8');
    expect(source, "store.ts must derive the latest workspace version from storage-registry.ts, not the literal 4").not.toMatch(/version\s*>\s*4\b/);
    expect(source, "store.ts must derive the migration-backup threshold from storage-registry.ts, not 'version < 4'").not.toMatch(/version\s*<\s*4\b/);
    expect(source).toContain('LATEST_WORKSPACE_VERSION');
    expect(source).toContain('migrationBackupVersion');
  });

  it('generalises the pre-migration backup name to the actual next version, keeping legacy names', () => {
    expect(migrationBackupVersion(0)).toBe(2);
    expect(migrationBackupVersion(1)).toBe(2);
    expect(migrationBackupVersion(2)).toBe(3);
    expect(migrationBackupVersion(3)).toBe(4);
    // A database already at the latest version has no "next" migration; the caller never uses this in that case.
    expect(migrationBackupVersion(LATEST_WORKSPACE_VERSION)).toBe(LATEST_WORKSPACE_VERSION);
  });

  it('accumulates required tables per version the same way ops/backup.ts validates them', () => {
    expect(tablesRequiredAtVersion(0)).toEqual([]);
    expect(tablesRequiredAtVersion(2)).toEqual(['event_baseline', 'command_receipts']);
    expect(tablesRequiredAtVersion(3)).toEqual(['event_baseline', 'command_receipts', 'agent_archive', 'repository_archive']);
    expect(tablesRequiredAtVersion(4)).toEqual(['event_baseline', 'command_receipts', 'agent_archive', 'repository_archive', 'native_sources', 'native_sessions', 'native_session_aliases']);
    expect(WORKSPACE_SCHEMA_VERSION_NUMBERS).toEqual([0, 2, 3, 4]);
    expect(LATEST_WORKSPACE_VERSION).toBe(4);
  });
});
