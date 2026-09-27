/**
 * Single source of truth for the workspace database's schema versions.
 *
 * store.ts (opening/migrating a workspace database) and ops/backup.ts (validating
 * a backup's schema) both need to know, for a given SQLite `user_version`, which
 * tables must already exist and what the next `.before-vN.bak` migration-safety
 * copy should be named. Before this module existed both files hard-coded the
 * literals 2/3/4 separately, so a new migration had to be threaded through two
 * unrelated call sites by hand (see docs/records/storage-plan.md, owned by WS8-22).
 *
 * Adding a future migration means appending one entry here; store.ts and
 * backup.ts pick it up without further edits to their version literals.
 */

export interface SchemaVersionEntry {
  /** The `PRAGMA user_version` value this migration leaves the database at. */
  readonly version: number;
  /** The drizzle migration file (without extension) that introduces this version. */
  readonly migrationTag: string;
  /** Tables created by this migration, in addition to every earlier version's tables. */
  readonly tablesIntroduced: readonly string[];
}

/**
 * Ordered by version, ascending. Version 0 is the base schema from
 * 0000_local_preview.sql (town_state, events) and is implicit: every database
 * this registry recognizes has at least those two tables.
 *
 * NOTE for a future workstream adding a migration: append one entry, keep
 * `version` strictly greater than the previous entry's, and add the matching
 * SQL file plus a strictly-increasing `when` in
 * apps/service/drizzle/meta/_journal.json (checked by
 * tests/unit/migration-journal.test.ts). Do not edit a shipped entry.
 */
export const WORKSPACE_SCHEMA_VERSIONS: readonly SchemaVersionEntry[] = [
  { version: 2, migrationTag: '0001_compact_event_history', tablesIntroduced: ['event_baseline', 'command_receipts'] },
  { version: 3, migrationTag: '0002_agent_archive', tablesIntroduced: ['agent_archive', 'repository_archive'] },
  { version: 4, migrationTag: '0003_native_sessions', tablesIntroduced: ['native_sources', 'native_sessions', 'native_session_aliases'] },
];

/** The newest workspace schema version this build understands. A higher `user_version` is refused. */
export const LATEST_WORKSPACE_VERSION: number = WORKSPACE_SCHEMA_VERSIONS.at(-1)!.version;

/** Every `user_version` value a workspace database may legitimately report, including the implicit base version 0. */
export const WORKSPACE_SCHEMA_VERSION_NUMBERS: readonly number[] = [0, ...WORKSPACE_SCHEMA_VERSIONS.map(entry => entry.version)];

/**
 * The version an existing database's pre-migration safety copy should be named
 * after: the first version its migration run will pass through. A database
 * already at the latest version needs no copy (the caller checks that first).
 */
export function migrationBackupVersion(existingVersion: number): number {
  const next = WORKSPACE_SCHEMA_VERSIONS.find(entry => entry.version > existingVersion);
  return next ? next.version : existingVersion;
}

/** Every table a workspace database claiming this `user_version` must contain, cumulative across all earlier versions. */
export function tablesRequiredAtVersion(version: number): readonly string[] {
  return WORKSPACE_SCHEMA_VERSIONS.filter(entry => entry.version <= version).flatMap(entry => entry.tablesIntroduced);
}
