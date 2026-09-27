/** Schema-only, read-only view of a local SQLite file: table/column shape, foreign keys and row
 * counts. Never carries row content. Columns matching a known-sensitive name (credential_ref,
 * token_hash, ...) are counted but omitted entirely, never shown even as a name. */
export interface DbSchemaColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
}
export interface DbSchemaForeignKey {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}
export interface DbSchemaTable {
  name: string;
  columns: DbSchemaColumn[];
  /** Columns that exist but are never shown (name or value), e.g. credential_ref, token_hash. */
  hiddenColumnCount: number;
  rowCount: number | null;
}
export interface DbSchemaGroup {
  /** Which local file this table group came from, in plain words for the UI, e.g. "This workspace's data". */
  label: string;
  fileKind: 'workspace' | 'identity';
  tables: DbSchemaTable[];
  foreignKeys: DbSchemaForeignKey[];
}
export interface DbSchemaSnapshot {
  scannedAt: string;
  groups: DbSchemaGroup[];
}
