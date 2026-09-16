import { lstatSync, opendirSync } from 'node:fs';
import { join } from 'node:path';
import { OperationsError, safeLocalDirectory } from './lock.js';

export interface ExcludedCount { items: number; exact: boolean }
export interface BackupCoverage {
  capture: 'offline-locked' | 'service-turn';
  capturedAt: string;
  databasesIncluded: true;
  excluded: { pendingSpool: ExcludedCount; worktrees: ExcludedCount; executionSources: ExcludedCount; externalEvidence: ExcludedCount };
  sourceRepositoriesExcluded: true;
  credentialsExcluded: true;
}

/** Metadata only. Count immediate items at known application paths, never source bodies. */
export function backupCoverage(source: string, capture: BackupCoverage['capture']): BackupCoverage {
  const empty = (): ExcludedCount => ({ items: 0, exact: true });
  const excluded = { pendingSpool: empty(), worktrees: empty(), executionSources: empty(), externalEvidence: empty() };
  let budget = 10_000;
  const children = (path: string, count: ExcludedCount, visit: (name: string) => void) => {
    try {
      safeLocalDirectory(path);
      const directory = opendirSync(path);
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (--budget < 0) { count.exact = false; break; }
          // Never follow links, including junctions; their contents are unknown.
          const info = lstatSync(join(path, entry.name));
          if (info.isSymbolicLink()) { count.exact = false; continue; }
          visit(entry.name);
        }
      } finally { directory.closeSync(); }
    } catch (error) {
      // Missing optional directories mean zero. Permission/link/IO failures do not.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof OperationsError && error.code === 'missing-data')) count.exact = false;
    }
  };
  const items = (path: string, count: ExcludedCount) => children(path, count, () => count.items++);
  const spool = join(source, 'observation', 'spool');
  children(spool, excluded.pendingSpool, name => items(join(spool, name), excluded.pendingSpool));
  const managed = join(source, 'managed');
  children(managed, excluded.worktrees, name => {
    items(join(managed, name, 'worktrees'), excluded.worktrees);
    items(join(managed, name, 'execution'), excluded.executionSources);
  });
  if (!excluded.worktrees.exact) excluded.executionSources.exact = false;
  const workspaces = join(source, 'workspaces');
  children(workspaces, excluded.externalEvidence, name => items(join(workspaces, name, 'evidence'), excluded.externalEvidence));
  return { capture, capturedAt: new Date().toISOString(), databasesIncluded: true, excluded, sourceRepositoriesExcluded: true, credentialsExcluded: true };
}

export function validBackupCoverage(value: BackupCoverage): boolean {
  return !!value && ['offline-locked', 'service-turn'].includes(value.capture) && Number.isFinite(Date.parse(value.capturedAt))
    && value.databasesIncluded === true && value.sourceRepositoriesExcluded === true && value.credentialsExcluded === true
    && !!value.excluded && ['pendingSpool', 'worktrees', 'executionSources', 'externalEvidence'].every(key => {
      const count = value.excluded[key as keyof BackupCoverage['excluded']];
      return !!count && Number.isSafeInteger(count.items) && count.items >= 0 && count.items <= 10_000 && typeof count.exact === 'boolean';
    });
}
