import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { DiscoveryError } from './types';

export const pathKey = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;

export function isWithin(root: string, candidate: string): boolean {
  const remainder = relative(pathKey(root), pathKey(candidate));
  return remainder === '' || (!isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith(`..${sep}`));
}

function isLocalPath(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && isAbsolute(value)
    && !/[\u0000-\u001f]/u.test(value) && !value.startsWith('\\\\') && !value.startsWith('//')
    && (process.platform !== 'win32' || /^[a-z]:[\\/]/iu.test(value) && !value.slice(2).includes(':'));
}

async function noLinkedComponents(candidate: string): Promise<void> {
  let current = parse(candidate).root;
  for (const part of relative(current, candidate).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new DiscoveryError('unsafe-root');
  }
}

export async function canonicalizeRoot(input: string): Promise<string> {
  if (typeof input !== 'string' || !isLocalPath(input)) throw new DiscoveryError('invalid-root');
  const candidate = resolve(input);
  if (pathKey(candidate) === pathKey(parse(candidate).root) || pathKey(candidate) === pathKey(resolve(homedir()))) {
    throw new DiscoveryError('invalid-root');
  }
  try {
    await noLinkedComponents(candidate);
    if (!(await lstat(candidate)).isDirectory()) throw new DiscoveryError('unavailable-root');
    const canonical = await realpath(candidate);
    if (!isLocalPath(canonical)) throw new DiscoveryError('unsafe-root');
    return canonical;
  } catch (error) {
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError('unavailable-root');
  }
}

/** Recheck every component at use time. Links are rejected even when they point inside a root. */
export async function checkedPath(candidate: string, roots: readonly string[]): Promise<string> {
  const absolute = resolve(candidate);
  if (!isLocalPath(absolute) || !roots.some(root => isWithin(root, absolute))) throw new DiscoveryError('unsafe-root');
  await noLinkedComponents(absolute);
  const canonical = await realpath(absolute);
  if (!roots.some(root => isWithin(root, canonical)) || pathKey(canonical) !== pathKey(absolute)) {
    throw new DiscoveryError('unsafe-root');
  }
  return canonical;
}

/** Only tiny Git pointer/configuration files use this function. Source instructions never do. */
export async function readMetadataFile(candidate: string, roots: readonly string[], maxBytes: number): Promise<string> {
  const path = await checkedPath(candidate, roots);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink > 1 || before.size > maxBytes) throw new DiscoveryError('unsafe-root');
    const buffer = Buffer.alloc(Math.min(before.size + 1, maxBytes + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await lstat(await checkedPath(path, roots));
    if (bytesRead > maxBytes || before.ino !== after.ino || before.dev !== after.dev
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytesRead !== before.size) {
      throw new DiscoveryError('unsafe-root');
    }
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}
