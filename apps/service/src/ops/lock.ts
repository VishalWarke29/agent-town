import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export interface DataScopeManifest { version: 1; mode: string; customBase: string | null; createdAt: string }

/**
 * Detects two different (mode, custom data base) combinations resolving to the
 * same physical directory (e.g. production with base B and development with
 * base B\production both landing on B\production\private) and refuses to
 * start rather than let two environments silently share one database.
 */
export function verifyDataScopeManifest(directory: string, scope: { mode: string; customBase: string | null }): void {
  const root = safeLocalDirectory(directory, true), path = join(root, '.agent-town-scope.json');
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify({ version: 1, mode: scope.mode, customBase: scope.customBase, createdAt: new Date().toISOString() } satisfies DataScopeManifest), { mode: 0o600 });
    return;
  }
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 4096) throw new Error(`Unexpected scope marker at ${path}. Remove it only if you understand why, then restart.`);
  let manifest: DataScopeManifest;
  try { manifest = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`The scope marker at ${path} is unreadable. Remove it only if you understand why, then restart.`); }
  if (manifest.mode !== scope.mode || manifest.customBase !== scope.customBase) {
    throw new Error(`This data directory (${root}) was previously used with application mode "${manifest.mode}"${manifest.customBase ? ` and data base "${manifest.customBase}"` : ''}, but this startup resolved mode "${scope.mode}"${scope.customBase ? ` and data base "${scope.customBase}"` : ''} to the same physical path. Refusing to start to avoid two environments silently sharing one database. Use a different AGENT_TOWN_DATA_DIR for one of them, or remove ${path} only if you are certain this reuse is intentional.`);
  }
}

export class OperationsError extends Error {
  /** `detail` adds file/process specifics after the fixed message; the message never carries data contents. */
  constructor(public readonly code: 'in-use' | 'unsafe-path' | 'invalid-backup' | 'destination-exists' | 'missing-data' | 'unsupported-schema' | 'backup-limit' | 'external-evidence', detail?: string) {
    super(`${{ 'in-use': 'Stop Agent Town before this operation. Its data directory is in use.',
      'unsafe-path': 'Use a local directory without symbolic links, junctions, or path traversal.',
      'invalid-backup': 'Backup validation failed. No live workspace was replaced.',
      'destination-exists': 'Choose a new destination directory. Existing files are never overwritten.',
      'missing-data': 'The selected Agent Town data directory is unavailable.',
      'unsupported-schema': 'The database schema or backup version is not supported by this release.',
      'backup-limit': 'This backup exceeds the supported file or size limits.',
      'external-evidence': 'External evidence files are present. This release backs up saved database records only; preserve the evidence separately before proceeding.' }[code]}${detail ? ` ${detail}` : ''}`);
    this.name = 'OperationsError';
  }
}

export function safeLocalDirectory(path: string, create = false): string {
  if (!isAbsolute(path) || path.startsWith('\\\\') || path.startsWith('//') || /[\u0000-\u001f]/u.test(path)) throw new OperationsError('unsafe-path');
  const absolute = resolve(path);
  if (absolute === parse(absolute).root) throw new OperationsError('unsafe-path');
  let current = parse(absolute).root;
  for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
    if (process.platform === 'win32' && part.includes(':')) throw new OperationsError('unsafe-path');
    current = join(current, part);
    if (existsSync(current)) {
      const info = lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new OperationsError('unsafe-path');
    } else if (create) mkdirSync(current, { mode: 0o700 });
    else throw new OperationsError('missing-data');
  }
  return realpathSync(absolute);
}

/** Windows recycles process IDs quickly, so a lock is only trusted when the process is also older than the lock. */
const CLOCK_SLACK_MS = 2000;

/** When the process began, or undefined when that cannot be established (the caller then keeps the lock). */
export function processStartTime(pid: number): number | undefined {
  if (pid === process.pid) return Date.now() - process.uptime() * 1000;
  if (process.platform !== 'win32') return undefined;
  try {
    const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const output = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
      { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const time = Date.parse(output.trim());
    return Number.isFinite(time) ? time : undefined;
  } catch { return undefined; }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (failure) { return (failure as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Shared by service startup and offline operations. A stale lock (dead process, or a recycled process ID) can be reclaimed. */
export function acquireDataDirectoryLock(directory: string, operation: 'service' | 'backup' | 'restore' = 'service', probeStartTime: (pid: number) => number | undefined = processStartTime): () => void {
  const root = safeLocalDirectory(directory, true), path = join(root, '.agent-town.lock');
  const nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const descriptor = openSync(path, 'wx', 0o600);
      try { writeFileSync(descriptor, JSON.stringify({ version: 1, pid: process.pid, operation, nonce, startedAt: new Date().toISOString() })); }
      catch (error) { closeSync(descriptor); throw error; }
      let released = false;
      return () => {
        if (released) return; released = true; closeSync(descriptor);
        try {
          const info = lstatSync(path);
          if (!info.isSymbolicLink() && JSON.parse(readFileSync(path, 'utf8')).nonce === nonce) unlinkSync(path);
        } catch { /* Another safe shutdown may already have released the lock. */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let guard: number | undefined;
      try {
        // Only one process may check and reclaim a stale lock at a time. A crashed
        // reclaimer leaves a fail-closed guard for manual offline inspection.
        try { guard = openSync(`${path}.reclaim`, 'wx', 0o600); }
        catch (failure) {
          if ((failure as NodeJS.ErrnoException).code === 'EEXIST') throw new OperationsError('in-use', `Another start may be in progress, or one was interrupted while clearing an old lock. Wait a few seconds; if Agent Town is not running, delete ${path}.reclaim and start again.`);
          throw failure;
        }
        const info = lstatSync(path);
        if (info.isSymbolicLink() || !info.isFile() || info.size > 4096) throw new OperationsError('in-use', `The lock file ${path} is not a plain file. If Agent Town is not running, delete it and start again.`);
        let record: { pid?: unknown; startedAt?: unknown } | null = null;
        try { record = JSON.parse(readFileSync(path, 'utf8')); } catch { /* Reported below as unreadable. */ }
        const pid = record?.pid;
        if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) throw new OperationsError('in-use', `The lock file ${path} is unreadable. If Agent Town is not running, delete it and start again.`);
        if (processIsAlive(pid)) {
          const started = typeof record?.startedAt === 'string' ? Date.parse(record.startedAt) : Number.NaN;
          const processStart = Number.isFinite(started) ? probeStartTime(pid) : undefined;
          // The real owner is always older than its own lock; a process that began later only reused the number.
          if (processStart === undefined || processStart - started <= CLOCK_SLACK_MS)
            throw new OperationsError('in-use', `It is held by process ${pid}${Number.isFinite(started) ? `, started ${record?.startedAt}` : ''} (${path}). If Agent Town is not running, delete that file and start again.`);
        }
        unlinkSync(path);
      } catch (failure) { if (failure instanceof OperationsError) throw failure; throw new OperationsError('in-use'); }
      finally { if (guard !== undefined) { closeSync(guard); unlinkSync(`${path}.reclaim`); } }
    }
  }
  throw new OperationsError('in-use');
}
