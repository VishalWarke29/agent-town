import { existsSync, lstatSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { DbSchemaForeignKey, DbSchemaGroup, DbSchemaTable } from '@agent-town/contracts';

/** Columns never shown, by name or value, in the database visualizer, defense in depth on top of
 * this file only ever reading structure and counts. Mirrors the sensitivity ops/backup.ts already
 * assigns identity_owners.credential_ref/token_expires_at and the *_connections/*_sources token_hash
 * columns. Extend this list, not the SQL, if a future migration adds another credential-shaped column. */
const HIDDEN_COLUMNS = new Set(['credential_ref', 'token_expires_at', 'token_hash', 'home_path']);
const VALID_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

interface SqliteMasterRow { name: string; type: string }
interface TableInfoRow { name: string; type: string | null; notnull: number; pk: number }
interface ForeignKeyRow { table: string; from: string; to: string }

/** Read-only, structure-and-counts-only introspection of an already-open better-sqlite3 connection.
 * Never issues a write and never selects row content: only sqlite_master/PRAGMA metadata and COUNT(*).
 * Table/column names come from sqlite_master and PRAGMA, not request input, but are still validated
 * against a safe-identifier pattern before interpolation, since better-sqlite3 cannot parameterize
 * identifiers: an unexpected name is skipped rather than interpolated into SQL. */
export function introspectOpenDatabase(sqlite: Database.Database, label: string, fileKind: DbSchemaGroup['fileKind']): DbSchemaGroup {
  const tableRows = sqlite.prepare("SELECT name, type FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as SqliteMasterRow[];
  const tables: DbSchemaTable[] = [];
  const foreignKeys: DbSchemaForeignKey[] = [];
  for (const { name } of tableRows) {
    if (!VALID_IDENTIFIER.test(name)) continue;
    const columnRows = sqlite.prepare(`PRAGMA table_info("${name}")`).all() as TableInfoRow[];
    const visible = columnRows.filter(column => !HIDDEN_COLUMNS.has(column.name));
    let rowCount: number | null = null;
    try { rowCount = (sqlite.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n; } catch { rowCount = null; }
    tables.push({
      name,
      columns: visible.map(column => ({ name: column.name, type: column.type || 'text', notNull: column.notnull === 1, primaryKey: column.pk > 0 })),
      hiddenColumnCount: columnRows.length - visible.length,
      rowCount,
    });
    for (const fk of sqlite.prepare(`PRAGMA foreign_key_list("${name}")`).all() as ForeignKeyRow[]) {
      if (VALID_IDENTIFIER.test(fk.table)) foreignKeys.push({ fromTable: name, fromColumn: fk.from, toTable: fk.table, toColumn: fk.to });
    }
  }
  return { label, fileKind, tables, foreignKeys };
}

/** Opens a local SQLite file strictly readonly for introspection only, and only if it already
 * exists (never creates one). Returns null when the file is absent (e.g. observation/telemetry
 * databases are created lazily) so callers can degrade gracefully instead of failing. */
export function introspectReadOnlyFile(path: string, label: string, fileKind: DbSchemaGroup['fileKind']): DbSchemaGroup | null {
  if (!existsSync(path)) return null;
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) return null;
  const database = new Database(path, { readonly: true, fileMustExist: true, timeout: 1000 });
  try {
    database.pragma('trusted_schema = OFF');
    return introspectOpenDatabase(database, label, fileKind);
  } finally { database.close(); }
}
