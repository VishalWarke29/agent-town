import { createHash } from 'node:crypto';
import { lstat, opendir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { inspectGitLayout, readGitState, type GitLayout } from './git';
import { canonicalizeRoot, checkedPath, isWithin, pathKey } from './paths';
import { classifyInstruction, isExcludedDirectory, isSecretName } from './policy';
import { localRepositoryId } from './local-project';
import {
  DEFAULT_DISCOVERY_LIMITS, DiscoveryError,
  type DiscoveredRepository, type DiscoveryIssue, type DiscoveryLimits, type DiscoveryOptions, type DiscoveryResult,
} from './types';

export { assertSafeProjectRoot, canonicalizeRoot, isWithin } from './paths';
export * from './types';
export { inspectLocalProject, localRepositoryId, type LocalProjectDirectory } from './local-project';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function discoveryLimits(overrides?: Partial<DiscoveryLimits>): DiscoveryLimits {
  const limits = { ...DEFAULT_DISCOVERY_LIMITS, ...overrides };
  for (const key of Object.keys(DEFAULT_DISCOVERY_LIMITS) as (keyof DiscoveryLimits)[]) {
    if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > DEFAULT_DISCOVERY_LIMITS[key]) {
      throw new DiscoveryError('invalid-limits');
    }
  }
  return limits;
}

interface Candidate {
  record: DiscoveredRepository;
  layout: GitLayout;
  unsafePaths: string[];
}

/** Read-only, bounded discovery. The caller owns workspace authorization and persistence. */
export async function discoverRepositories(inputs: string[], options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const limits = discoveryLimits(options.limits);
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > limits.maxRoots) throw new DiscoveryError('invalid-root');
  const roots: string[] = [];
  for (const input of inputs) {
    const canonical = await canonicalizeRoot(input);
    if (!roots.some(root => pathKey(root) === pathKey(canonical))) roots.push(canonical);
  }
  roots.sort((a, b) => a.length - b.length || a.localeCompare(b));
  const scannedAt = new Date().toISOString();
  const deadline = Date.now() + limits.maxDurationMs;
  const issues = new Set<DiscoveryIssue>();
  const coverage: DiscoveryResult['coverage'] = { status: 'complete', issues: [], entriesVisited: 0, excludedEntries: 0, unsafeEntries: 0 };
  let traversalComplete = true;
  const candidates: Candidate[] = [];
  const takeEntry = () => {
    if (options.signal?.aborted) { issues.add('cancelled'); return false; }
    if (Date.now() >= deadline) { issues.add('time-limit'); return false; }
    if (coverage.entriesVisited >= limits.maxEntries) { issues.add('entry-limit'); return false; }
    coverage.entriesVisited++; return true;
  };
  const queue: { path: string; root: string; depth: number; candidate?: Candidate }[] = roots
    .filter(root => !roots.some(other => other !== root && isWithin(other, root)))
    .map(root => ({ path: root, root, depth: 0 }));

  while (queue.length) {
    if (!takeEntry()) { traversalComplete = false; break; }
    const item = queue.shift()!;
    try {
      await checkedPath(item.path, roots);
      const layout = await inspectGitLayout(item.path, roots, limits.maxMetadataFileBytes);
      let candidate = item.candidate;
      if (layout) {
        if (candidates.length >= limits.maxRepositories) { issues.add('repository-limit'); traversalComplete = false; break; }
        const record: DiscoveredRepository = {
          id: localRepositoryId(item.path), name: basename(item.path), canonicalPath: item.path,
          rootPath: item.root, kind: layout.kind, commonGitDirectory: layout.commonDirectory,
          git: { availability: 'unavailable', branch: null, head: null, changedFiles: null, untrackedFiles: null,
            scope: 'tracked-files', refreshedAt: scannedAt, reason: layout.issue },
          instructions: [], scannedAt, fingerprint: '',
        };
        candidate = { record, layout, unsafePaths: [] };
        candidates.push(candidate);
      }
      const directory = await opendir(item.path);
      try {
        for await (const entry of directory) {
          if (!takeEntry()) { traversalComplete = false; break; }
          const path = join(item.path, entry.name);
          if (entry.isSymbolicLink()) {
            coverage.unsafeEntries++; issues.add('unsafe-path');
            candidate?.unsafePaths.push(relative(candidate.record.canonicalPath, path));
            continue;
          }
          if (entry.isDirectory()) {
            if (isExcludedDirectory(entry.name) || isSecretName(entry.name)) { coverage.excludedEntries++; continue; }
            if (item.depth >= limits.maxDepth) { issues.add('depth-limit'); traversalComplete = false; continue; }
            queue.push({ path, root: item.root, depth: item.depth + 1, candidate });
          } else if (entry.isFile() && candidate) {
            const relativePath = relative(candidate.record.canonicalPath, path).replaceAll('\\', '/');
            const classification = classifyInstruction(relativePath);
            if (!classification) continue;
            if (candidate.record.instructions.length >= limits.maxInstructionsPerRepository) { issues.add('instruction-limit'); continue; }
            const stat = await lstat(await checkedPath(path, roots));
            if (!stat.isFile() || stat.isSymbolicLink()) { coverage.unsafeEntries++; issues.add('unsafe-path'); continue; }
            candidate.record.instructions.push({ ...classification, path: relativePath, bytes: stat.size,
              modifiedAt: stat.mtime.toISOString(), appliedToRun: false, contentRead: false });
          }
        }
      } finally { await directory.close().catch(() => undefined); }
    } catch {
      issues.add('unreadable-entry'); traversalComplete = false;
    }
  }

  for (const candidate of candidates) {
    if (traversalComplete && Date.now() < deadline && !options.signal?.aborted) {
      const remainingLimits = { ...limits, gitTimeoutMs: Math.max(1, Math.min(limits.gitTimeoutMs, deadline - Date.now())) };
      candidate.record.git = await readGitState(candidate.record.canonicalPath, roots, candidate.layout,
        remainingLimits, candidate.unsafePaths, takeEntry, options.signal);
    } else candidate.record.git.reason ??= options.signal?.aborted ? 'cancelled' : issues.has('time-limit') ? 'time-limit'
      : issues.has('depth-limit') ? 'depth-limit' : issues.has('repository-limit') ? 'repository-limit' : 'entry-limit';
    if (candidate.record.git.reason) issues.add(candidate.record.git.reason);
    candidate.record.instructions.sort((a, b) => a.path.localeCompare(b.path));
    const { refreshedAt: _refreshedAt, ...git } = candidate.record.git;
    candidate.record.fingerprint = hash(JSON.stringify({
      path: candidate.record.canonicalPath, root: candidate.record.rootPath, kind: candidate.record.kind,
      commonGitDirectory: candidate.record.commonGitDirectory, git, instructions: candidate.record.instructions,
    }));
  }
  if (queue.length) traversalComplete = false;
  const repositories = candidates.map(candidate => candidate.record).sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath));
  const previous = new Map((options.previous ?? []).map(repo => [repo.id, repo]));
  const current = new Map(repositories.map(repo => [repo.id, repo]));
  // A partial traversal must never cause the service to delete previously connected records.
  const removalConfirmed = traversalComplete && !issues.has('unsafe-path') && !issues.has('cancelled') && !issues.has('time-limit') && !issues.has('entry-limit');
  coverage.issues = [...issues].sort();
  coverage.status = coverage.issues.length ? 'partial' : 'complete';
  return {
    roots, repositories, coverage, scannedAt,
    delta: {
      added: repositories.filter(repo => !previous.has(repo.id)).map(repo => repo.id),
      changed: repositories.filter(repo => previous.has(repo.id) && previous.get(repo.id)!.fingerprint !== repo.fingerprint).map(repo => repo.id),
      removed: removalConfirmed ? [...previous.keys()].filter(id => !current.has(id)) : [], removalConfirmed,
    },
  };
}
