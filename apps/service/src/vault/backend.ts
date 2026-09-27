import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { VaultBackupSummary } from '@agent-town/contracts';
import { safeLocalDirectory } from '../ops/lock.js';
import { checkedPath, isWithin, pathKey } from '../discovery/paths.js';
import { VaultError } from './errors.js';

/** Local-folder vault backend (DR-061): the only backend today. A real hosted backend is a later,
 * additive implementation of this same directory-per-repo shape, not a redesign.
 * `label` and `fileCount`/`totalBytes` are plaintext (not secret — a project's own display name and
 * size) so a restoring second device can list what backups exist before it has the passphrase. */
export interface RepoVaultHeader {
  format: 'agent-town-vault'; version: 1; createdAt: string; label: string; fileCount: number; totalBytes: number;
  kdf: { name: 'scrypt'; saltHex: string; N: number; r: number; p: number };
}

const SAFE_SEGMENT = /^[a-zA-Z0-9_-]{1,100}$/;

/** Validated once, at "enable" time, and re-validated on every use since the folder may have moved,
 * been unmounted, or had its symlink-safety invalidated since. Never a UNC path (`safeLocalDirectory`
 * already refuses `\\`/`//`); a mapped drive letter works. */
export function validateVaultDirectory(path: string): string {
  if (!isAbsolute(path)) throw new VaultError('unsafe-destination');
  try { return safeLocalDirectory(path, true); } catch { throw new VaultError('unsafe-destination'); }
}

/** Validates a restore destination WITHOUT creating anything (unlike validateVaultDirectory, which
 * always creates its target) — PV-02 binds a restore's destination at preview time, before the owner
 * has committed to writing anything, so a preview must be able to inspect a path without side effects.
 * Mirrors safeLocalDirectory (ops/lock.ts) and canonicalizeRoot/checkedPath (discovery/paths.ts) for
 * the exact safety conventions already used elsewhere: absolute, non-UNC, no control characters, no
 * bare drive root, no drive-letter-in-a-later-segment trick, and no symlink anywhere in the existing
 * prefix. A path that doesn't exist yet is reported as empty (a brand-new destination is fine); a path
 * that does exist is realpath-canonicalized and rejected if that disagrees with the resolved input
 * (a symlink or case alias somewhere), then reported empty exactly when it has no entries. */
export function validateRestoreDestination(path: string): { canonical: string; exists: boolean; empty: boolean } {
  if (!isAbsolute(path) || path.startsWith('\\\\') || path.startsWith('//') || /[\u0000-\u001f]/u.test(path)) throw new VaultError('unsafe-destination');
  const absolute = resolve(path);
  if (pathKey(absolute) === pathKey(parse(absolute).root)) throw new VaultError('unsafe-destination');
  let current = parse(absolute).root;
  for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
    if (process.platform === 'win32' && part.includes(':')) throw new VaultError('unsafe-destination');
    current = join(current, part);
    if (existsSync(current)) {
      const info = lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new VaultError('unsafe-destination');
    }
  }
  if (!existsSync(absolute)) return { canonical: absolute, exists: false, empty: true };
  let canonical: string;
  try { canonical = realpathSync(absolute); } catch { throw new VaultError('unsafe-destination'); }
  if (pathKey(canonical) !== pathKey(absolute)) throw new VaultError('unsafe-destination');
  return { canonical, exists: true, empty: readdirSync(canonical).length === 0 };
}

/** When a chosen destination is refused for being nonempty, a nearby, not-yet-existing sibling name
 * for the owner to deliberately choose instead — never auto-selected, only suggested in the error
 * detail. */
export function suggestRestoreSibling(canonical: string): string {
  const parent = dirname(canonical), name = basename(canonical);
  for (let attempt = 1; attempt <= 200; attempt++) {
    const candidate = join(parent, attempt === 1 ? `${name}-restore` : `${name}-restore-${attempt}`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(parent, `${name}-restore-${randomUUID().slice(0, 8)}`);
}

/** The operation's own staging root: a hidden folder inside the vault directory Agent Town already
 * owns and controls, never anywhere near the owner's chosen destination. `workspaceId` is re-checked
 * against SAFE_SEGMENT (already enforced by repoVaultDirectory for the same reason) before it is ever
 * used in a path. */
async function verifiedRestoreStagingRoot(vaultDirectory: string, workspaceId: string): Promise<string> {
  if (!SAFE_SEGMENT.test(workspaceId)) throw new VaultError('repo-not-found');
  const root = join(vaultDirectory, workspaceId, '.restore-staging');
  await mkdir(root, { recursive: true, mode: 0o700 });
  return checkedPath(root, [vaultDirectory]);
}

function operationStagingPath(root: string, operationId: string): string {
  if (!SAFE_SEGMENT.test(operationId)) throw new VaultError('vault-invalid');
  const staging = join(root, operationId);
  if (!isWithin(root, staging)) throw new VaultError('vault-invalid');
  return staging;
}

/** Wipes any stale partial staging left by an earlier interrupted attempt and recreates it clean —
 * simpler and safer than resuming partial staging, since backups are bounded (4 GiB total / 256 MiB
 * per file) and staging is a recovery-only code path, not the common case. Re-verifies the computed
 * path is actually inside the `.restore-staging` root before the recursive removal: this is the
 * literal enforcement of "cleanup may touch only the verified operation-owned staging directory,
 * never the destination or an unrelated folder." */
export async function resetRestoreStaging(vaultDirectory: string, workspaceId: string, operationId: string): Promise<string> {
  const root = await verifiedRestoreStagingRoot(vaultDirectory, workspaceId);
  const staging = operationStagingPath(root, operationId);
  if (existsSync(staging)) await rm(await checkedPath(staging, [root]), { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  return checkedPath(staging, [root]);
}

export async function removeRestoreStaging(vaultDirectory: string, workspaceId: string, operationId: string): Promise<void> {
  const root = await verifiedRestoreStagingRoot(vaultDirectory, workspaceId);
  const staging = operationStagingPath(root, operationId);
  if (!existsSync(staging)) return;
  await rm(await checkedPath(staging, [root]), { recursive: true, force: true });
}

function repoVaultDirectory(vaultDirectory: string, workspaceId: string, repoId: string): string {
  if (!SAFE_SEGMENT.test(workspaceId) || !SAFE_SEGMENT.test(repoId)) throw new VaultError('repo-not-found');
  return join(vaultDirectory, workspaceId, repoId);
}

export function vaultExists(vaultDirectory: string, workspaceId: string, repoId: string): boolean {
  return existsSync(join(repoVaultDirectory(vaultDirectory, workspaceId, repoId), 'header.json'));
}

/** Lists every backup under this owner's workspace namespace, by reading each subdirectory's
 * plaintext header only — no passphrase needed, nothing encrypted is touched. This is how a second
 * device finds what to restore before it has any local record of the project. */
export async function listVaults(vaultDirectory: string, workspaceId: string): Promise<VaultBackupSummary[]> {
  if (!SAFE_SEGMENT.test(workspaceId)) return [];
  const namespace = join(vaultDirectory, workspaceId);
  if (!existsSync(namespace)) return [];
  const summaries: VaultBackupSummary[] = [];
  for (const entry of await readdir(await checkedPath(namespace, [vaultDirectory]), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_SEGMENT.test(entry.name)) continue;
    try {
      const header = await readHeader(vaultDirectory, workspaceId, entry.name);
      summaries.push({ repoId: entry.name, label: header.label, createdAt: header.createdAt, fileCount: header.fileCount, totalBytes: header.totalBytes });
    } catch { /* A partially-written or foreign directory is skipped, not reported as a backup. */ }
  }
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function readHeader(vaultDirectory: string, workspaceId: string, repoId: string): Promise<RepoVaultHeader> {
  const directory = repoVaultDirectory(vaultDirectory, workspaceId, repoId);
  try {
    const path = await checkedPath(join(directory, 'header.json'), [vaultDirectory]);
    const header = JSON.parse(await readFile(path, 'utf8')) as RepoVaultHeader;
    if (header.format !== 'agent-town-vault' || header.version !== 1 || header.kdf?.name !== 'scrypt'
      || !/^[0-9a-f]{32}$/.test(header.kdf.saltHex)) throw new VaultError('vault-invalid');
    return header;
  } catch (error) { if (error instanceof VaultError) throw error; throw new VaultError('vault-missing'); }
}

export async function readManifestEnvelope(vaultDirectory: string, workspaceId: string, repoId: string): Promise<Buffer> {
  const directory = repoVaultDirectory(vaultDirectory, workspaceId, repoId);
  try { return await readFile(await checkedPath(join(directory, 'manifest.enc'), [vaultDirectory])); }
  catch { throw new VaultError('vault-invalid'); }
}

export async function readFileEnvelope(vaultDirectory: string, workspaceId: string, repoId: string, storageName: string): Promise<Buffer> {
  const directory = repoVaultDirectory(vaultDirectory, workspaceId, repoId);
  if (!/^[0-9a-f]{64}\.enc$/.test(storageName)) throw new VaultError('vault-invalid');
  try { return await readFile(await checkedPath(join(directory, 'files', storageName), [vaultDirectory])); }
  catch { throw new VaultError('vault-invalid'); }
}

/** Full replace, staged then swapped in atomically: every backup is a complete re-encryption of the
 * current selection (no incremental diffing yet — phase 6 of the plan, future work), so the safest
 * shape is "write the whole new vault beside the old one, then swap", never an in-place edit that
 * could leave a half-written vault if the process is interrupted mid-write. */
export async function writeRepoVault(
  vaultDirectory: string, workspaceId: string, repoId: string,
  header: RepoVaultHeader, manifestEnvelope: Buffer, files: { storageName: string; envelope: Buffer }[],
): Promise<void> {
  const directory = repoVaultDirectory(vaultDirectory, workspaceId, repoId);
  const staging = `${directory}.pending-${randomUUID()}`;
  await mkdir(join(staging, 'files'), { recursive: true, mode: 0o700 });
  try {
    await writeFile(join(staging, 'header.json'), JSON.stringify(header), { mode: 0o600 });
    await writeFile(join(staging, 'manifest.enc'), manifestEnvelope, { mode: 0o600 });
    for (const file of files) await writeFile(join(staging, 'files', file.storageName), file.envelope, { mode: 0o600 });
    const previous = `${directory}.previous-${randomUUID()}`;
    if (existsSync(directory)) await rename(directory, previous);
    await rename(staging, directory);
    if (existsSync(previous)) await rm(previous, { recursive: true, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error instanceof VaultError ? error : new VaultError('backup-limit');
  }
}
