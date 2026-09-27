import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { EXCLUDED_DIRECTORIES } from './policy';
import { DiscoveryError } from './types';

export const pathKey = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;

export function isWithin(root: string, candidate: string): boolean {
  const remainder = relative(pathKey(root), pathKey(candidate));
  return remainder === '' || (!isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith(`..${sep}`));
}

const sameOrAncestor = (parent: string, candidate: string) => pathKey(parent) === pathKey(candidate) || isWithin(parent, candidate);

/** An absolute path from a real Windows environment variable, or undefined when unset/relative
 * (never thrown on — a missing variable simply skips that one protected-location check). */
function envPath(name: string): string | undefined {
  const value = process.env[name];
  return value && isAbsolute(value) ? resolve(value) : undefined;
}

/**
 * One safe-root check for every folder the user gives Agent Town: `/roots`, `/projects/local`, the
 * folder picker and the multi-project list all resolve through canonicalizeRoot (and, defensively,
 * inspectLocalProject) before a folder becomes a discovery root or a connected project.
 *
 * Refuses Windows system and installed-application folders, the Users folder and other accounts'
 * profiles (a subfolder of the CURRENT account's own profile is still allowed), AppData folders,
 * Agent Town's own private data folder (its default location under %LOCALAPPDATA%, and any
 * AGENT_TOWN_DATA_DIR override), and a folder whose own name is reserved for build/dependency/tool
 * output (EXCLUDED_DIRECTORIES, which otherwise only prunes children during a scan).
 *
 * Windows-only: these are Windows-specific locations, and canonicalizeRoot's existing drive-root,
 * exact-home-folder and no-symlink checks already apply on every platform.
 */
export function assertSafeProjectRoot(canonical: string): void {
  if (process.platform !== 'win32') return;
  const windowsDirectory = envPath('WINDIR') ?? envPath('SystemRoot');
  if (windowsDirectory && sameOrAncestor(windowsDirectory, canonical)) throw new DiscoveryError('system-root');
  for (const name of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData']) {
    const directory = envPath(name);
    if (directory && sameOrAncestor(directory, canonical)) throw new DiscoveryError('program-files-root');
  }
  const home = resolve(homedir());
  const usersRoot = resolve(dirname(home));
  if (pathKey(canonical) === pathKey(usersRoot)) throw new DiscoveryError('user-profile-root');
  if (isWithin(usersRoot, canonical) && !sameOrAncestor(home, canonical)) throw new DiscoveryError('other-profile-root');
  const appData = envPath('APPDATA');
  if (appData && pathKey(canonical) === pathKey(appData)) throw new DiscoveryError('app-data-root');
  const localAppData = envPath('LOCALAPPDATA');
  if (localAppData) {
    if (pathKey(canonical) === pathKey(localAppData)) throw new DiscoveryError('app-data-root');
    if (sameOrAncestor(resolve(localAppData, 'AgentTown'), canonical)) throw new DiscoveryError('agent-town-data-root');
  }
  const townData = envPath('AGENT_TOWN_DATA_DIR');
  if (townData && sameOrAncestor(townData, canonical)) throw new DiscoveryError('agent-town-data-root');
  if (EXCLUDED_DIRECTORIES.has(basename(canonical).toLowerCase())) throw new DiscoveryError('excluded-name-root');
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
    assertSafeProjectRoot(canonical);
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
