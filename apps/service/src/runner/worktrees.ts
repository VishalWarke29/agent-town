import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, realpath, opendir, readdir, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, resolve, join } from 'node:path';
import { hasCurrentSourceFingerprint, type Repository, type WorktreeEvidence } from '@agent-town/contracts';
import { checkedPath, isWithin } from '../discovery/paths.js';
import { inspectGitLayout, readGitState } from '../discovery/git.js';
import { DEFAULT_DISCOVERY_LIMITS } from '../discovery/types.js';
import { WorkflowError, sanitizeModelText } from '../workflow/index.js';
import { minimalEnvironment, resolveExecutable } from './rpc.js';
import { protectedSourcePath } from './source-tree.js';
import { requireRuntimeSeparation } from './sandbox-boundary.js';

const execute = promisify(execFile);
const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
// Nothing ever reclaims a run's Git worktree, so disk use grows without bound.
// Bound it the same way BackupScheduler bounds backups (ops/scheduler.ts): an
// age window and a retained-count cap, whichever an entry reaches first.
const WORKTREE_RETENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // Matches BackupScheduler's default 7-day backup retention.
const MAX_RETAINED_WORKTREES = 200; // Matches RETAINED_AGENT_LIMIT, this workspace's retained run/agent cap.
const MIN_WORKTREE_PRUNE_AGE_MS = 60 * 60 * 1000; // A run's maxMinutes is capped at 15; a 4x margin before anything is ever a prune candidate.

/** Best-effort, race-free reclamation. A run cannot last past its 15-minute
 * maxMinutes cap, so nothing newer than the safety margin above is ever a
 * candidate; only then does the age/count retention below apply. */
async function pruneManagedWorktrees(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const now = Date.now(), candidates: { name: string; age: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try { const info = await lstat(await checkedPath(join(root, entry.name), [root])); if (info.isDirectory()) candidates.push({ name: entry.name, age: now - info.mtimeMs }); }
    catch { /* Ignore an unsafe or already-changing entry; retried next time. */ }
  }
  candidates.sort((a, b) => b.age - a.age);
  const excess = Math.max(0, candidates.length - MAX_RETAINED_WORKTREES);
  for (const [index, candidate] of candidates.entries()) {
    if (candidate.age < MIN_WORKTREE_PRUNE_AGE_MS || (index >= excess && candidate.age <= WORKTREE_RETENTION_WINDOW_MS)) continue;
    try { await rm(await checkedPath(join(root, candidate.name), [root]), { recursive: true }); }
    catch { /* Best-effort; retried next time. */ }
  }
}
async function git(repo: string, arguments_: string[], gitDirectory?: string, excludedRoots: string[] = [repo]): Promise<string> {
  const executable = await resolveExecutable('git', excludedRoots);
  if (!executable) throw new WorkflowError('git_missing', 'Git is required for managed worktrees.', 503);
  try {
    const result = await execute(executable, ['--no-lazy-fetch', '--no-replace-objects', '--literal-pathspecs', '-c', `core.hooksPath=${nullFile}`, '-c', 'core.fsmonitor=false', '-c', `core.attributesFile=${nullFile}`, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', `--work-tree=${repo}`, ...(gitDirectory ? [`--git-dir=${gitDirectory}`] : []), '-C', repo, ...arguments_],
      { windowsHide: true, timeout: 30000, maxBuffer: 1_000_000, env: minimalEnvironment({ PATH: dirname(executable), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: nullFile, GIT_CONFIG_GLOBAL: nullFile, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: '', GIT_ATTR_NOSYSTEM: '1' }) });
    return result.stdout;
  } catch { throw new WorkflowError('worktree_git_failed', 'Git could not complete the isolated worktree operation. Existing work was preserved.', 502); }
}

export async function validatedRepository(repo: Repository, roots: string[]): Promise<{ path: string; head: string }> {
  if (repo.source !== 'local' || !repo.localPath || !roots.length) throw new WorkflowError('local_repository_required', 'Select a discovered local Git repository for managed execution.');
  const path = await checkedPath(repo.localPath, roots);
  requireRuntimeSeparation(path);
  const layout = await inspectGitLayout(path, roots, DEFAULT_DISCOVERY_LIMITS.maxMetadataFileBytes);
  if (!layout) throw new WorkflowError('repository_invalid', 'The selected repository is no longer a supported Git worktree.');
  let entries = 0; const deadline = Date.now() + DEFAULT_DISCOVERY_LIMITS.maxDurationMs;
  const status = await readGitState(path, roots, layout, DEFAULT_DISCOVERY_LIMITS, [], () => ++entries <= DEFAULT_DISCOVERY_LIMITS.maxEntries && Date.now() <= deadline);
  if (status.availability !== 'available' || !status.head) throw new WorkflowError('repository_unsafe', 'Git metadata is unavailable or unsafe for a managed worktree. Re-scan and review the repository.');
  return { path, head: status.head };
}

export async function createManagedWorktree(repo: string, baseCommit: string, dataDirectory: string, runId: string, selectedRoots: string[] = [repo]): Promise<{ path: string; branch: string }> {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseCommit) || !/^[A-Za-z0-9-]{1,80}$/.test(runId)) throw new WorkflowError('worktree_scope_invalid', 'Invalid commit or run identifier.');
  const root = resolve(dataDirectory, 'worktrees');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await checkedPath(root, [resolve(dataDirectory)]);
  void pruneManagedWorktrees(root).catch(() => undefined); // Opportunistic, never blocks starting this run.
  const path = resolve(root, runId);
  if (!isWithin(root, path) || path === root) throw new WorkflowError('worktree_path_invalid', 'Invalid managed worktree path.');
  try { await lstat(path); throw new WorkflowError('worktree_exists', 'This run already has a worktree. It will not be overwritten.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const branch = `agent-town/${runId}`;
  await git(repo, ['worktree', 'add', '--no-track', '-b', branch, path, baseCommit], undefined, [...selectedRoots, dataDirectory]);
  return { path: await realpath(path), branch };
}

export async function changedWorktreeFiles(path: string, repositoryPath: string, selectedRoots: string[], baseCommit?: string): Promise<string[]> {
  const roots = [...selectedRoots, path];
  const original = await inspectGitLayout(repositoryPath, selectedRoots, DEFAULT_DISCOVERY_LIMITS.maxMetadataFileBytes);
  const layout = await inspectGitLayout(path, roots, DEFAULT_DISCOVERY_LIMITS.maxMetadataFileBytes);
  if (!original?.commonDirectory || !layout?.directory || layout.issue || layout.commonDirectory !== original.commonDirectory || !isWithin(join(original.commonDirectory, 'worktrees'), layout.directory)) throw new WorkflowError('worktree_metadata_changed', 'The worktree Git pointer changed. File inventory is unavailable; retained files need review.');
  // Never let an unsandboxed Git status follow a worker-created junction or
  // execute a worker-supplied filter configuration during final inventory.
  const queue = [path]; let count = 0;
  while (queue.length) {
    const directory = queue.shift()!;
    const handle = await opendir(directory);
    try { for await (const entry of handle) {
      if (++count > 10000) throw new WorkflowError('worktree_inventory_limit', 'The worktree is too large for the bounded final inventory.');
      if (entry.name === '.git' && directory === path) continue;
      const target = await checkedPath(join(directory, entry.name), [path]);
      const info = await lstat(target);
      if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)) throw new WorkflowError('worktree_inventory_unsafe', 'A linked file prevents a safe final inventory.');
      if (info.isDirectory()) queue.push(target);
    } } finally { await handle.close().catch(() => undefined); }
  }
  let metadataEntries = 0;
  const status = await readGitState(path, roots, layout, DEFAULT_DISCOVERY_LIMITS, [], () => ++metadataEntries <= 10000);
  if (status.availability !== 'available') throw new WorkflowError('worktree_inventory_unsafe', 'Git metadata could not be safely verified after execution.');
  const output = await git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', '--no-renames'], layout.directory, roots);
  if (baseCommit && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseCommit)) throw new WorkflowError('evidence_scope_invalid', 'The saved base commit is invalid.');
  const committed = baseCommit ? await git(path, ['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', baseCommit, '--'], layout.directory, roots) : '';
  const files = [...new Set([...output.split('\0').filter(Boolean).map(line => line.slice(3)), ...committed.split('\0').filter(Boolean)])];
  if (files.length > 200 || files.some(value => value.length > 500 || /[\u0000-\u001f]/.test(value))) throw new WorkflowError('worktree_inventory_limit', 'The complete changed-file inventory exceeds the review limit. Review the retained worktree directly.');
  return files.map(value => sanitizeModelText(value));
}

export async function checkedWorktreeFile(worktree: string, input: string, forWrite = false): Promise<string> {
  if (!input || input.length > 500 || isAbsolute(input) || input.includes(':') || /[\u0000-\u001f]/.test(input)) throw new WorkflowError('file_path_invalid', 'Use a relative file path inside the task worktree.', 400);
  const parts = input.replaceAll('\\', '/').split('/');
  if (protectedSourcePath(input)) throw new WorkflowError('file_path_denied', 'This file is outside the allowed source-file scope.', 403);
  const path = resolve(worktree, ...parts);
  if (!isWithin(worktree, path)) throw new WorkflowError('file_path_denied', 'The file must remain inside the worktree.', 403);
  try {
    const canonical = await checkedPath(path, [worktree]);
    const info = await lstat(canonical);
    if (!info.isFile() || info.nlink !== 1 || info.size > 128_000) throw new WorkflowError('file_scope_invalid', 'Only small regular source files are available to the worker.', 403);
    return canonical;
  } catch (error) {
    if (!forWrite || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await checkedPath(dirname(path), [worktree]);
    return path;
  }
}

/** Owner review only: bounded current source diff, never credentials/Git objects. */
export async function inspectWorktreeEvidence(path: string, repo: string, roots: string[], base: string, file: string): Promise<WorktreeEvidence> {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(base)) throw new WorkflowError('evidence_scope_invalid', 'The saved base commit is invalid.');
  // Validate the Git pointer and every materialized path before invoking Git.
  const changed = await changedWorktreeFiles(path, repo, roots, base);
  if (!changed.includes(file)) throw new WorkflowError('evidence_file_unavailable', 'This file is not in the current bounded changed-file inventory.');
  const target = await checkedWorktreeFile(path, file, true);
  const layout = await inspectGitLayout(path, [...roots, path], DEFAULT_DISCOVERY_LIMITS.maxMetadataFileBytes);
  if (!layout?.directory) throw new WorkflowError('evidence_scope_invalid', 'The worktree metadata could not be verified.');
  let text = await git(path, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', '--unified=3', base, '--', file], layout.directory, [...roots, path]);
  if (!text) {
    const content = await readFile(target);
    if (content.length > 128000 || content.includes(0)) throw new WorkflowError('evidence_file_unavailable', 'This binary or large file needs review in the retained worktree.');
    text = `Untracked source file: ${file}\n${content.toString('utf8')}`;
  }
  const sanitized = sanitizeModelText(text), truncated = sanitized.length > 64000;
  return { file, text: sanitized.slice(0, 64000), truncated, observedAt: new Date().toISOString(), fingerprint: createHash('sha256').update(sanitized).digest('hex'), source: 'current-worktree', message: 'Read from the retained worktree now. This is not a test result or proof of integration. Credential patterns are redacted; review the source locally if evidence is incomplete.' };
}

export async function commitContains(repo: string, ancestor: string, current: string, roots: string[]): Promise<boolean> {
  if (![ancestor, current].every(value => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value))) return false;
  try { await git(repo, ['merge-base', '--is-ancestor', ancestor, current], undefined, roots); return true; } catch { return false; }
}

type GitFileMode = '100644' | '100755';
interface GitModes { trustExecutableBit: boolean; index: Map<string, GitFileMode> }

/** Read the index without changing it. Chunk path arguments below Windows limits. */
async function sourceModes(worktree: string, roots: string[], files: string[]): Promise<GitModes> {
  const value = (await git(worktree, ['config', '--type=bool', '--default=true', '--get', 'core.fileMode'], undefined, [...roots, worktree])).trim();
  if (value !== 'true' && value !== 'false') throw new WorkflowError('source_mode_unavailable', 'The repository executable-file policy could not be verified.');
  const index = new Map<string, GitFileMode>();
  for (let start = 0; start < files.length; start += 20) {
    const paths = files.slice(start, start + 20);
    const output = await git(worktree, ['ls-files', '--stage', '-z', '--', ...paths], undefined, [...roots, worktree]);
    for (const record of output.split('\0').filter(Boolean)) {
      const match = /^(100644|100755) [a-f0-9]{40}(?:[a-f0-9]{24})? 0\t(.+)$/.exec(record);
      if (!match || !paths.includes(match[2]!) || index.has(match[2]!)) throw new WorkflowError('source_mode_unavailable', 'Only resolved regular Git source files have verifiable mode evidence.');
      index.set(match[2]!, match[1] as GitFileMode);
    }
  }
  return { trustExecutableBit: value === 'true', index };
}

async function effectiveSourceMode(target: string, file: string, modes: GitModes, contentExists: boolean): Promise<GitFileMode | null> {
  let info;
  try { info = await lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!info && !contentExists) return null;
  if (!info || !contentExists || !info.isFile() || info.nlink !== 1) throw new WorkflowError('source_mode_changed', 'The retained source changed while its file mode was being verified.');
  // With core.fileMode=false Git preserves a tracked index mode and adds new
  // regular files as100644. Windows stat bits cannot establish executable mode.
  if (!modes.trustExecutableBit) return modes.index.get(file) ?? '100644';
  if (process.platform === 'win32') throw new WorkflowError('source_mode_unavailable', 'Executable-file metadata cannot be verified with core.fileMode=true on this Windows filesystem. Review the Git mode policy before another attempt.');
  // Git uses the owner executable bit, not every Unix permission bit.
  return info.mode & 0o100 ? '100755' : '100644';
}

export function requireCurrentSourceFingerprint(value: string | null | undefined): void {
  if (!hasCurrentSourceFingerprint(value)) throw new WorkflowError('source_evidence_upgrade_required', 'This saved run predates complete Git file-mode evidence. Its history is preserved; review a separate attempt before verifying integration or starting dependent work.');
}

export async function verifyIntegratedSource(worktree: string, repo: string, roots: string[], base: string, head: string): Promise<string[]> {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head)) throw new WorkflowError('integration_unavailable', 'The checkout commit is unavailable.');
  const files = await changedWorktreeFiles(worktree, repo, roots, base), deadline = Date.now() + 30000;
  const modes = await sourceModes(worktree, roots, files);
  for (const file of files) {
    if (Date.now() > deadline) throw new WorkflowError('integration_limit', 'Integration verification reached its time limit. Existing work was preserved.');
    const target = await checkedWorktreeFile(worktree, file, true);
    let expected: Buffer | null = null;
    try { expected = await readFile(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const expectedMode = await effectiveSourceMode(target, file, modes, expected !== null);
    const listing = await git(repo, ['ls-tree', '-z', head, '--', file], undefined, roots);
    let actualObject: string | null = null, actualMode: GitFileMode | null = null;
    if (listing) {
      const entry = /^(100644|100755) blob ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t[^\0]+\0$/.exec(listing);
      if (!entry) throw new WorkflowError('integration_unavailable', 'A changed path is not a regular committed source file.');
      actualMode = entry[1] as GitFileMode; actualObject = entry[2]!;
    }
    // Git canonicalizes text line endings when committing on Windows. Hash the
    // retained file using its validated repository attributes without writing an
    // object. Config validation rejects external filters before this operation.
    // Comparing blob identities also preserves binary bytes without UTF-8 loss.
    const expectedObject = expected === null ? null : (await git(worktree, ['hash-object', `--path=${file}`, '--', target], undefined, [...roots, worktree])).trim();
    if (expectedObject !== null && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(expectedObject)) throw new WorkflowError('integration_unavailable', 'Git could not verify the retained source content.');
    if (expectedObject !== actualObject || expectedMode !== actualMode) throw new WorkflowError('integration_not_verified', 'The retained content and Git file modes do not match the current committed checkout. Integrate and commit them yourself, then verify again. No files were changed.');
  }
  return files;
}

export async function sourceFingerprint(worktree: string, repo: string, roots: string[], base: string): Promise<string> {
  const files = (await changedWorktreeFiles(worktree, repo, roots, base)).sort(), hash = createHash('sha256').update(`git-source-v2:${base}`);
  const modes = await sourceModes(worktree, roots, files);
  for (const file of files) {
    const target = await checkedWorktreeFile(worktree, file, true);
    let content: Buffer | null = null;
    try { content = await readFile(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const mode = await effectiveSourceMode(target, file, modes, content !== null);
    hash.update(JSON.stringify({ file, mode, content: content === null ? null : createHash('sha256').update(content).digest('hex') }));
  }
  return `v2:${hash.digest('hex')}`;
}
