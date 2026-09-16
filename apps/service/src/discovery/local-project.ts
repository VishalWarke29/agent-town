import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { checkedPath, isWithin, pathKey } from './paths';
import { DiscoveryError } from './types';

/** Shared with Git discovery so initializing Git later cannot create a second house. */
export const localRepositoryId = (canonicalPath: string): string => `local-${createHash('sha256').update(pathKey(canonicalPath)).digest('hex').slice(0, 24)}`;

export interface LocalProjectDirectory {
  id: string;
  name: string;
  canonicalPath: string;
  rootPath: string;
  projectKind: 'folder' | 'git';
}

/** Inspect only an explicitly named directory and its Git marker; never traverse its contents. */
export async function inspectLocalProject(input: string, roots: readonly string[]): Promise<LocalProjectDirectory> {
  if (!isAbsolute(input)) throw new DiscoveryError('invalid-root');
  try {
    const canonicalPath = await checkedPath(input, roots);
    if (!(await lstat(canonicalPath)).isDirectory()) throw new DiscoveryError('unavailable-root');
    let projectKind: 'folder' | 'git' = 'folder';
    try { await lstat(join(canonicalPath, '.git')); projectKind = 'git'; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await checkedPath(canonicalPath, roots);
    const rootPath = roots.filter(root => isWithin(root, canonicalPath)).sort((a, b) => b.length - a.length)[0]!;
    return { id: localRepositoryId(canonicalPath), name: basename(canonicalPath), canonicalPath, rootPath, projectKind };
  } catch (error) {
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError('unavailable-root');
  }
}
