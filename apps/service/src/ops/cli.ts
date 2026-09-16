import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createOfflineBackup, restoreOfflineBackup, validateBackup } from './backup.js';
import { applicationDataPaths, readLocalConfig } from '../config.js';
import { acquireDataDirectoryLock, OperationsError } from './lock.js';

const args = process.argv.slice(2);
const value = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
class RecoveryModeError extends Error {}
let release: (() => void) | undefined;
try {
  const backup = value('--backup'), restore = value('--restore'), to = value('--to'), verify = value('--verify');
  if ([backup, restore, verify].filter(Boolean).length !== 1 || restore && !to) throw new Error('Use --backup NEW_DIRECTORY, --verify BACKUP_DIRECTORY, or --restore BACKUP_DIRECTORY --to NEW_RUNTIME_DIRECTORY.');
  const config = readLocalConfig();
  if (config.mode === 'demo' && !verify) throw new RecoveryModeError('Demo mode has no private workspace backups. Select development or production for recovery.');
  const { privateDirectory } = applicationDataPaths(config.mode);
  if (restore && existsSync(resolve(to!))) throw new OperationsError('destination-exists');
  const destination = restore ? applicationDataPaths(config.mode, { env: { ...process.env, AGENT_TOWN_DATA_DIR: resolve(to!) } }).directory : undefined;
  if (restore && existsSync(privateDirectory)) release = acquireDataDirectoryLock(privateDirectory, 'restore');
  const manifest = backup ? await createOfflineBackup(privateDirectory, resolve(backup))
    : restore ? await restoreOfflineBackup(resolve(restore), destination!) : await validateBackup(resolve(verify!));
  process.stdout.write(`${backup ? 'Backup created' : restore ? 'Backup restored into a new data directory' : 'Backup verified'}: ${manifest.workspaces.length} private workspaces, ${manifest.files.length} database files.\n`);
  process.stdout.write('Credentials are excluded. Restored connections require reconnection; paid work stays disabled.\n');
  if (manifest.coverage) {
    const counts = manifest.coverage.excluded;
    const count = (value: { items: number; exact: boolean }) => value.exact ? `${value.items}` : `at least ${value.items} (full count unavailable)`;
    process.stdout.write(`Excluded items: pending spool ${count(counts.pendingSpool)}, worktrees ${count(counts.worktrees)}, execution copies ${count(counts.executionSources)}, external evidence ${count(counts.externalEvidence)}. Preserve these separately when needed.\n`);
  } else process.stdout.write('This older backup has no coverage counts. Pending spool, worktrees, execution copies and external evidence are excluded.\n');
  if (restore) process.stdout.write(`Set AGENT_TOWN_DATA_DIR to the selected new base directory and use -Mode ${config.mode} before starting Agent Town. Original data remains unchanged.\n`);
} catch (error) {
  process.stderr.write(`${error instanceof OperationsError || error instanceof RecoveryModeError ? error.message : 'The operation failed. Check the selected paths and command arguments. No live workspace was replaced.'}\n`);
  process.exitCode = 1;
} finally { release?.(); }
