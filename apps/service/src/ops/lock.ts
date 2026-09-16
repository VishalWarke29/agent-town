import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export class OperationsError extends Error {
  constructor(public readonly code: 'in-use' | 'unsafe-path' | 'invalid-backup' | 'destination-exists' | 'missing-data' | 'unsupported-schema' | 'backup-limit' | 'external-evidence') {
    super({ 'in-use': 'Stop Agent Town before this operation. Its data directory is in use.',
      'unsafe-path': 'Use a local directory without symbolic links, junctions, or path traversal.',
      'invalid-backup': 'Backup validation failed. No live workspace was replaced.',
      'destination-exists': 'Choose a new destination directory. Existing files are never overwritten.',
      'missing-data': 'The selected Agent Town data directory is unavailable.',
      'unsupported-schema': 'The database schema or backup version is not supported by this release.',
      'backup-limit': 'This backup exceeds the supported file or size limits.',
      'external-evidence': 'External evidence files are present. This release backs up saved database records only; preserve the evidence separately before proceeding.' }[code]);
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

/** Shared by service startup and offline operations. A stale dead-process lock can be reclaimed. */
export function acquireDataDirectoryLock(directory: string, operation: 'service' | 'backup' | 'restore' = 'service'): () => void {
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
        guard = openSync(`${path}.reclaim`, 'wx', 0o600);
        const info = lstatSync(path);
        if (info.isSymbolicLink() || !info.isFile() || info.size > 4096) throw new OperationsError('in-use');
        const record = JSON.parse(readFileSync(path, 'utf8')) as { pid: number };
        if (!Number.isSafeInteger(record.pid) || record.pid <= 0) throw new OperationsError('in-use');
        try { process.kill(record.pid, 0); throw new OperationsError('in-use'); }
        catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') throw new OperationsError('in-use'); }
        unlinkSync(path);
      } catch (failure) { if (failure instanceof OperationsError) throw failure; throw new OperationsError('in-use'); }
      finally { if (guard !== undefined) { closeSync(guard); unlinkSync(`${path}.reclaim`); } }
    }
  }
  throw new OperationsError('in-use');
}
