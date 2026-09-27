import { lstat, opendir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { VaultScanResult, VaultSecretFinding, VaultSelectionEntry } from '@agent-town/contracts';
import { checkedPath, readMetadataFile } from '../discovery/paths.js';
import { isExcludedDirectory, isSecretName } from '../discovery/policy.js';
import { findSecrets } from './secrets.js';

const BOUNDS = { maxFiles: 20_000, maxEntries: 200_000, maxTotalBytes: 4 * 1024 * 1024 * 1024, maxDurationMs: 60_000, maxDepth: 16, maxSecretScanBytes: 2_000_000 };

/** Unlike telemetry/inventory.ts's scanner (which skips gitignored content outright), Project Vault
 * exists specifically to back up files a plain `git clone` on a second machine would never bring
 * back — so a gitignored directory is still descended into; only its *files* carry the flag for the
 * caller to leave unselected by default. Build/dependency output (EXCLUDED_DIRECTORIES) is always
 * pruned regardless of gitignore state: those are never useful to back up. */
export async function scanProject(root: string, repoId: string): Promise<VaultScanResult> {
  const entries: VaultSelectionEntry[] = [];
  const findings: VaultSecretFinding[] = [];
  const issues = new Set<string>();
  let totalBytes = 0, fileCount = 0, scannedEntries = 0;
  const deadline = Date.now() + BOUNDS.maxDurationMs;
  const queue: { path: string; depth: number; rules: { base: string; matcher: Ignore }[] }[] = [{ path: root, depth: 0, rules: [] }];
  while (queue.length) {
    if (Date.now() >= deadline) { issues.add('time-limit'); break; }
    if (fileCount >= BOUNDS.maxFiles || scannedEntries >= BOUNDS.maxEntries || totalBytes >= BOUNDS.maxTotalBytes) { issues.add('scan-limit'); break; }
    const item = queue.shift()!;
    try {
      await checkedPath(item.path, [root]);
      if (item.path !== root) {
        try { await lstat(join(item.path, '.git')); issues.add('nested-repository-excluded'); continue; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const rules = [...item.rules];
      try {
        const content = await readMetadataFile(join(item.path, '.gitignore'), [root], 32_000);
        if (content.split('\n').length > 1000 || content.split('\n').some(line => line.length > 1024)) issues.add('ignore-rule-limit');
        else rules.push({ base: item.path, matcher: ignore().add(content) });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.add('unreadable-ignore-rules'); }
      const directory = await opendir(item.path);
      try {
        for await (const entry of directory) {
          if (++scannedEntries > BOUNDS.maxEntries || fileCount >= BOUNDS.maxFiles || Date.now() >= deadline) { issues.add(Date.now() >= deadline ? 'time-limit' : 'scan-limit'); break; }
          if (entry.name === '.git') continue;
          const path = join(item.path, entry.name);
          if (entry.isSymbolicLink()) { issues.add('linked-path-excluded'); continue; }
          let ignored = false;
          for (const rule of rules) {
            const result = rule.matcher.test(`${relative(rule.base, path).replaceAll('\\', '/')}${entry.isDirectory() ? '/' : ''}`);
            if (result.ignored) ignored = true; else if (result.unignored) ignored = false;
          }
          if (entry.isDirectory()) {
            if (isExcludedDirectory(entry.name)) continue;
            if (item.depth >= BOUNDS.maxDepth) { issues.add('depth-limit'); continue; }
            queue.push({ path, depth: item.depth + 1, rules });
            continue;
          }
          if (!entry.isFile()) continue;
          const info = await lstat(path);
          if (info.nlink > 1) { issues.add('unsafe-file-excluded'); continue; }
          const relativePath = relative(root, path).replaceAll('\\', '/');
          const sensitiveName = relativePath.split('/').some(isSecretName);
          fileCount++; totalBytes += info.size;
          entries.push({ path: relativePath, sizeBytes: info.size, gitignored: ignored, sensitiveName });
          if (info.size <= BOUNDS.maxSecretScanBytes) {
            try {
              const content = await readMetadataFile(path, [root], BOUNDS.maxSecretScanBytes);
              findings.push(...findSecrets(relativePath, content));
            } catch { issues.add('unreadable-file'); }
          } else if (sensitiveName) issues.add('sensitive-file-too-large-to-scan');
        }
      } finally { await directory.close().catch(() => undefined); }
    } catch { issues.add('unreadable-directory'); }
  }
  return { scannedAt: new Date().toISOString(), repoId, entries, findings, totalBytes, issues: [...issues].sort() };
}
