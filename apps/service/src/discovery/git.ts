import { execFile } from 'node:child_process';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { checkedPath, isWithin, readMetadataFile } from './paths';
import { EXCLUDED_DIRECTORIES } from './policy';
import type { DiscoveryIssue, DiscoveryLimits, RepositoryGitState } from './types';

const executeFile = promisify(execFile);
const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null';

export interface GitLayout {
  directory: string | null;
  commonDirectory: string | null;
  kind: 'checkout' | 'worktree';
  issue: DiscoveryIssue | null;
}

export async function inspectGitLayout(repo: string, roots: string[], maxBytes: number): Promise<GitLayout | null> {
  const marker = join(repo, '.git');
  let info;
  try { info = await lstat(marker); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { directory: null, commonDirectory: null, kind: 'checkout', issue: 'unreadable-entry' };
  }
  const layout: GitLayout = { directory: null, commonDirectory: null, kind: info.isFile() ? 'worktree' : 'checkout', issue: null };
  try {
    await checkedPath(marker, roots);
    let gitDirectory = marker;
    if (info.isFile()) {
      const pointer = await readMetadataFile(marker, roots, Math.min(maxBytes, 4096));
      const match = /^gitdir: ([^\r\n\u0000]+)\r?\n?$/u.exec(pointer);
      if (!match) throw new Error('unsupported pointer');
      gitDirectory = resolve(repo, match[1]);
      if (!roots.some(root => isWithin(root, gitDirectory))) {
        layout.issue = 'external-git-directory'; return layout;
      }
    } else if (!info.isDirectory()) throw new Error('unsupported marker');
    layout.directory = await checkedPath(gitDirectory, roots);
    if (!(await lstat(layout.directory)).isDirectory()) throw new Error('unsupported directory');
    let common = layout.directory;
    try {
      const pointer = await readMetadataFile(join(layout.directory, 'commondir'), roots, Math.min(maxBytes, 4096));
      if (!/^[^\r\n\u0000]+\r?\n?$/u.test(pointer)) throw new Error('unsupported common directory');
      common = resolve(layout.directory, pointer.trim());
      if (!roots.some(root => isWithin(root, common))) { layout.issue = 'external-git-directory'; return layout; }
      common = await checkedPath(common, roots);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    layout.commonDirectory = common;
    return layout;
  } catch { layout.issue = 'unsupported-git-layout'; return layout; }
}

/** Reject configuration that could load other files or run filters. Never return its values. */
function configLooksSafe(contents: string): boolean {
  let section = '';
  for (const raw of contents.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.endsWith('\\')) return false;
    if (line.startsWith('[')) {
      const match = /^\[([a-z][a-z0-9-]*)(?:\s+"[^"\\\u0000-\u001f]*")?\]\s*(?:[#;].*)?$/iu.exec(line);
      if (!match) return false;
      section = match[1].toLowerCase();
      if (!['core', 'remote', 'branch', 'user', 'extensions', 'submodule'].includes(section)) return false;
    } else {
      const key = /^([a-z][a-z0-9-]*)\s*(?:=.*)?$/iu.exec(line)?.[1].toLowerCase();
      if (!section || !key) return false;
      if (section === 'extensions' && !['objectformat', 'worktreeconfig'].includes(key)) return false;
    }
  }
  return true;
}

async function executableForRoots(roots: string[]): Promise<string | null> {
  // Resolve an absolute executable before entering any repository. Windows otherwise searches cwd.
  const pathValue = Object.entries(process.env).find(([name]) => name.toUpperCase() === 'PATH')?.[1] ?? '';
  for (const directory of pathValue.split(delimiter)) {
    if (!isAbsolute(directory) || roots.some(root => isWithin(root, resolve(directory)))) continue;
    try {
      const candidate = await realpath(join(directory, process.platform === 'win32' ? 'git.exe' : 'git'));
      if (!roots.some(root => isWithin(root, candidate)) && (await lstat(candidate)).isFile()) return candidate;
    } catch { /* A missing PATH candidate is normal; never execute a repository-local fallback. */ }
  }
  return null;
}

function gitEnvironment(executable: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    const entry = Object.entries(process.env).find(([key]) => key.toUpperCase() === name.toUpperCase());
    if (entry?.[1]) env[name] = entry[1];
  }
  env.PATH = dirname(executable);
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_SYSTEM = nullFile;
  env.GIT_CONFIG_GLOBAL = nullFile;
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_NO_LAZY_FETCH = '1';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ALLOW_PROTOCOL = '';
  env.GIT_ATTR_NOSYSTEM = '1';
  env.LC_ALL = 'C';
  return env;
}

/** Git itself may read these trees, so reject pointer files and links before invoking it. */
async function safeGitMetadata(layout: GitLayout, roots: string[], limits: DiscoveryLimits, takeEntry: () => boolean): Promise<DiscoveryIssue | null> {
  if (!layout.directory || !layout.commonDirectory) return 'unsupported-git-layout';
  for (const directory of new Set([layout.directory, layout.commonDirectory])) {
    for (const filename of ['config', 'config.worktree']) {
      try {
        if (!configLooksSafe(await readMetadataFile(join(directory, filename), roots, limits.maxMetadataFileBytes))) return 'unsafe-git-config';
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'unsafe-git-config'; }
    }
    const queue = [directory];
    while (queue.length) {
      const current = queue.shift()!;
      await checkedPath(current, roots);
      const handle = await opendir(current);
      try {
        for await (const entry of handle) {
          if (!takeEntry()) return 'entry-limit';
          // These are not read by status with hooks and submodules disabled.
          if (['hooks', 'logs', 'modules', 'worktrees'].includes(entry.name) && current === layout.commonDirectory) continue;
          if (['alternates', 'http-alternates'].includes(entry.name)) return 'unsupported-git-layout';
          const path = join(current, entry.name);
          if (entry.isSymbolicLink()) return 'unsafe-path';
          // Git itself reads objects/refs when running status; confirm these top-level trees aren't links
          // without individually checking every loose object or ref, which can number in the thousands.
          if (['objects', 'refs'].includes(entry.name) && current === layout.commonDirectory) continue;
          const stat = await lstat(await checkedPath(path, roots));
          if (stat.isDirectory()) queue.push(path);
          else if (!stat.isFile()) return 'unsafe-path';
        }
      } finally { await handle.close().catch(() => undefined); }
    }
  }
  return null;
}

function excludedPathspecs(unsafePaths: string[]): string[] {
  const patterns = [...EXCLUDED_DIRECTORIES].flatMap(name => [`**/${name}/**`]);
  patterns.push('**/.env', '**/.env.*', '**/*.env', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.jks',
    '**/*credential*', '**/*secret*', '**/*token*', '**/auth.*', '**/id_rsa*', '**/id_ed25519*',
    '**/.claude/**', '**/.codex/**', '**/.cursor/**', '**/.github/**');
  return [...patterns.map(pattern => `:(glob,icase,exclude)${pattern}`),
    ...unsafePaths.map(path => `:(literal,exclude)${path.replaceAll('\\', '/')}`)];
}

export async function readGitState(
  repo: string, roots: string[], layout: GitLayout, limits: DiscoveryLimits,
  unsafePaths: string[], takeEntry: () => boolean, signal?: AbortSignal,
): Promise<RepositoryGitState> {
  const state: RepositoryGitState = {
    availability: 'unavailable', branch: null, head: null, changedFiles: null, untrackedFiles: null,
    scope: 'tracked-files', refreshedAt: new Date().toISOString(), reason: layout.issue,
  };
  if (layout.issue) return state;
  try {
    const issue = await safeGitMetadata(layout, roots, limits, takeEntry);
    if (issue) { state.reason = issue; return state; }
    const executable = await executableForRoots(roots);
    if (!executable) { state.reason = 'git-unavailable'; return state; }
    const env = gitEnvironment(executable);
    const commandDeadline = Date.now() + limits.gitTimeoutMs;
    const options = { env, windowsHide: true, timeout: limits.gitTimeoutMs, maxBuffer: limits.maxGitOutputBytes, signal };
    const version = await executeFile(executable, ['--version'], options);
    const numbers = /^git version (\d+)\.(\d+)/u.exec(version.stdout);
    if (!numbers || Number(numbers[1]) < 2 || Number(numbers[1]) === 2 && Number(numbers[2]) < 48) {
      state.reason = 'git-unavailable'; return state;
    }
    await checkedPath(repo, roots);
    await checkedPath(layout.directory!, roots);
    // Command-line settings override repo hooks, daemons, external files, automatic writes, and helper reads.
    const settings = [
      'core.fsmonitor=false', `core.hooksPath=${nullFile}`, `core.attributesFile=${nullFile}`,
      `core.excludesFile=${nullFile}`, 'core.bare=false', 'core.untrackedCache=false',
      'core.sparseCheckout=false', 'status.submoduleSummary=false', 'gc.auto=0', 'maintenance.auto=false',
      'diff.renames=false', `diff.orderFile=${nullFile}`, 'core.quotePath=true',
    ].flatMap(setting => ['-c', setting]);
    const args = [
      '--no-optional-locks', '--no-lazy-fetch', '--no-replace-objects', ...settings,
      `--git-dir=${layout.directory}`, `--work-tree=${repo}`, '-C', repo,
      'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=no', '--ignore-submodules=all', '--no-renames',
      '--', '.', ...excludedPathspecs(unsafePaths),
    ];
    if (args.join(' ').length > 28_000) { state.reason = 'entry-limit'; return state; }
    if (Date.now() >= commandDeadline) { state.reason = 'git-timeout'; return state; }
    const { stdout } = await executeFile(executable, args, { ...options, timeout: Math.max(1, commandDeadline - Date.now()) });
    let changed = 0;
    const records = stdout.split('\0');
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (record.startsWith('# branch.oid ')) {
        const oid = record.slice(13);
        if (/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(oid)) state.head = oid;
      } else if (record.startsWith('# branch.head ')) {
        const branch = record.slice(14);
        if (branch !== '(detached)' && branch.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(branch)) state.branch = branch;
      } else if (/^[12u] /u.test(record)) { changed++; if (record.startsWith('2 ')) i++; }
    }
    state.availability = 'available'; state.changedFiles = changed; state.reason = null;
    return state;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean };
    state.reason = signal?.aborted ? 'cancelled' : failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      ? 'git-output-limit' : failure.killed ? 'git-timeout' : 'git-unavailable';
    return state;
  }
}

export const gitRelativePath = (repo: string, path: string) => relative(repo, path).replaceAll('\\', '/');
