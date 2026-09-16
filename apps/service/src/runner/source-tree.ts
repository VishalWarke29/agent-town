import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { checkedPath, isWithin } from '../discovery/paths.js';
import { WorkflowError } from '../workflow/index.js';
import { requireRuntimeSeparation } from './sandbox-boundary.js';

const ignoredDirectories = new Set(['node_modules', 'vendor', 'dist', 'build', 'out', 'target', 'coverage', '.cache', '.next', '.nuxt', '__pycache__', '.venv', 'venv']);
const privateDirectories = new Set(['.git', '.hg', '.svn', '.codex', '.claude', '.cursor', '.ssh', '.aws', '.azure', '.gnupg']);
const privateFiles = new Set(['.npmrc', '.pypirc', '.netrc', '_netrc', '.gitconfig', '.git-credentials']);
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const maxFileBytes = 8_000_000, maxTreeBytes = 64_000_000, maxEntries = 20_000;
// Nothing ever reclaims a run's execution source copy, so disk use grows without
// bound. Bound it the same way BackupScheduler bounds backups (ops/scheduler.ts,
// worktrees.ts's own pruneManagedWorktrees): an age window and a retained-count
// cap, whichever an entry reaches first.
const EXECUTION_TREE_RETENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // Matches BackupScheduler's default 7-day backup retention.
const MAX_RETAINED_EXECUTION_TREES = 200; // Matches RETAINED_AGENT_LIMIT, this workspace's retained run/agent cap.
const MIN_EXECUTION_TREE_PRUNE_AGE_MS = 60 * 60 * 1000; // A run's maxMinutes is capped at 15; a 4x margin before anything is ever a prune candidate.

/** Shared source policy. It cannot identify secrets disguised as ordinary source. */
export function protectedSourcePath(value: string): boolean {
  const parts = value.replaceAll('\\', '/').split('/');
  return parts.some(part => !part || part === '.' || part === '..' || /[:\u0000-\u001f]/u.test(part)
    || privateDirectories.has(part.toLowerCase()) || privateFiles.has(part.toLowerCase())
    || /^\.env(?:\.|$)/iu.test(part) || /(?:secret|credential|token)|\.(pem|key|pfx|p12|jks|keystore)$/iu.test(part)
    || /^(?:auth|session|history|transcript|cookie)(?:[._-]|$)/iu.test(part) || /^id_(rsa|dsa|ecdsa|ed25519)/iu.test(part));
}

interface SourceFile { bytes: Buffer; hash: string; mode: number }
export interface PreparedSourceTree {
  readonly worktree: string;
  readonly path: string;
  readonly baseline: ReadonlyMap<string, { hash: string; mode: number }>;
  readonly excludedEntries: number;
}
const prepared = new WeakSet<PreparedSourceTree>();
const sourceRoots = new Set<string>();

export function requireSourceTree(path: string): void {
  if (!sourceRoots.has(resolve(path))) throw new WorkflowError('source_boundary_required', 'Commands require an isolated source-only execution tree.', 503);
}

async function sourceFiles(root: string): Promise<{ files: Map<string, SourceFile>; excludedEntries: number }> {
  await checkedPath(root, [root]);
  const files = new Map<string, SourceFile>(), queue = [root];
  let count = 0, total = 0, excludedEntries = 0;
  while (queue.length) {
    const directory = queue.shift()!;
    const handle = await opendir(await checkedPath(directory, [root]));
    try { for await (const entry of handle) {
      if (++count > maxEntries) throw new WorkflowError('source_tree_limit', 'The source execution tree exceeds its entry limit.');
      const path = join(directory, entry.name), name = relative(root, path).replaceAll('\\', '/');
      if (protectedSourcePath(name) || entry.isDirectory() && ignoredDirectories.has(entry.name.toLowerCase())) { excludedEntries++; continue; }
      const info = await lstat(await checkedPath(path, [root]));
      if (info.isDirectory()) { queue.push(path); continue; }
      if (!info.isFile() || info.nlink !== 1 || info.size > maxFileBytes) throw new WorkflowError('source_tree_unsafe', 'Only bounded regular source files can enter or leave the execution tree. Links are not copied.');
      total += info.size;
      if (total > maxTreeBytes) throw new WorkflowError('source_tree_limit', 'The source execution tree exceeds its byte limit.');
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await file.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size !== info.size || before.ino !== info.ino || before.dev !== info.dev) throw new Error('Changed source');
        const bytes = Buffer.alloc(before.size + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        const after = await lstat(await checkedPath(path, [root]));
        if (bytesRead !== before.size || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.nlink !== 1) throw new Error('Changed source');
        const body = bytes.subarray(0, bytesRead);
        files.set(name, { bytes: body, hash: digest(body), mode: before.mode & 0o777 });
      } catch { throw new WorkflowError('source_tree_changed', 'Source files changed while being validated. The retained worktree was preserved.'); }
      finally { await file.close(); }
    } } finally { await handle.close().catch(() => undefined); }
  }
  return { files, excludedEntries };
}

/** Best-effort, race-free reclamation, mirroring pruneManagedWorktrees in
 * worktrees.ts. A run cannot last past its 15-minute maxMinutes cap, so nothing
 * newer than the safety margin below is ever a candidate; a currently prepared
 * tree is also never touched regardless of age. */
async function pruneExecutionTrees(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const now = Date.now(), candidates: { name: string; age: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || sourceRoots.has(join(root, entry.name, 'source'))) continue;
    try { const info = await lstat(await checkedPath(join(root, entry.name), [root])); if (info.isDirectory()) candidates.push({ name: entry.name, age: now - info.mtimeMs }); }
    catch { /* Ignore an unsafe or already-changing entry; retried next time. */ }
  }
  candidates.sort((a, b) => b.age - a.age);
  const excess = Math.max(0, candidates.length - MAX_RETAINED_EXECUTION_TREES);
  for (const [index, candidate] of candidates.entries()) {
    if (candidate.age < MIN_EXECUTION_TREE_PRUNE_AGE_MS || (index >= excess && candidate.age <= EXECUTION_TREE_RETENTION_WINDOW_MS)) continue;
    try { await rm(await checkedPath(join(root, candidate.name), [root]), { recursive: true }); }
    catch { /* Best-effort; retried next time. */ }
  }
}

/** The agent receives no Git pointer, object database, private configuration or dependency cache. */
export async function prepareSourceTree(worktree: string, dataDirectory: string, runId: string): Promise<PreparedSourceTree> {
  if (!/^[A-Za-z0-9-]{1,80}$/u.test(runId)) throw new WorkflowError('source_tree_invalid', 'Invalid execution tree identifier.');
  requireRuntimeSeparation(worktree); requireRuntimeSeparation(dataDirectory);
  const original = await checkedPath(resolve(worktree), [resolve(worktree)]);
  const root = resolve(dataDirectory, 'execution');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await checkedPath(root, [resolve(dataDirectory)]);
  void pruneExecutionTrees(root).catch(() => undefined); // Opportunistic, never blocks starting this run.
  const path = resolve(root, runId, 'source');
  if (!isWithin(root, path) || isWithin(original, path) || isWithin(path, original)) throw new WorkflowError('source_tree_invalid', 'Source and retained worktree boundaries must be separate.');
  const snapshot = await sourceFiles(original);
  // A previous attempt is evidence. Never overwrite or reuse it.
  await mkdir(dirname(path), { mode: 0o700 });
  await mkdir(path, { mode: 0o700 });
  for (const [name, value] of snapshot.files) {
    const target = join(path, name);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await checkedPath(dirname(target), [path]);
    await writeFile(target, value.bytes, { flag: 'wx', mode: value.mode });
  }
  const baseline = new Map([...snapshot.files].map(([name, value]) => [name, { hash: value.hash, mode: value.mode }]));
  await writeFile(join(dirname(path), 'manifest.json'), JSON.stringify({ version: 1, runId, excludedEntries: snapshot.excludedEntries, files: [...baseline].map(([name, value]) => ({ name, ...value })) }), { flag: 'wx', mode: 0o600 });
  const result = Object.freeze({ worktree: original, path, baseline, excludedEntries: snapshot.excludedEntries });
  prepared.add(result); sourceRoots.add(path);
  return result;
}

/** Copy only reviewed-scope source changes back; protected originals stay untouched. */
export async function retainSourceChanges(tree: PreparedSourceTree): Promise<void> {
  if (!prepared.has(tree)) throw new WorkflowError('source_boundary_required', 'The source execution tree is not registered.');
  const output = await sourceFiles(tree.path);
  const current = await sourceFiles(tree.worktree);
  const changed = [...output.files].filter(([name, file]) => tree.baseline.get(name)?.hash !== file.hash || tree.baseline.get(name)?.mode !== file.mode);
  const removed = [...tree.baseline.keys()].filter(name => !output.files.has(name));
  // Validate all affected destinations before the first write. A person may have
  // edited the retained worktree while the agent was running in its separate tree.
  for (const name of [...changed.map(([name]) => name), ...removed]) {
    if (tree.baseline.get(name)?.hash !== current.files.get(name)?.hash || tree.baseline.get(name)?.mode !== current.files.get(name)?.mode) throw new WorkflowError('retained_worktree_changed', 'The retained worktree changed independently. Execution files remain available for manual comparison.');
  }
  for (const [name, value] of changed) {
    const target = resolve(tree.worktree, name);
    if (isAbsolute(name) || !isWithin(tree.worktree, target) || protectedSourcePath(name)) throw new WorkflowError('source_tree_invalid', 'Invalid source destination.');
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await checkedPath(dirname(target), [tree.worktree]);
    const temporary = join(dirname(target), `.agent-town-copy-${randomUUID()}`);
    try { await writeFile(temporary, value.bytes, { flag: 'wx', mode: value.mode }); await rename(temporary, target); }
    finally { await unlink(temporary).catch(() => undefined); }
  }
  for (const name of removed) await unlink(await checkedPath(join(tree.worktree, name), [tree.worktree]));
}

export function releaseSourceTree(tree: PreparedSourceTree): void {
  sourceRoots.delete(tree.path); prepared.delete(tree);
  // Keep source and manifest files after every outcome for manual recovery.
}
