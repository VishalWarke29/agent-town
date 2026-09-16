import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalizeRoot, discoverRepositories } from '../../apps/service/src/discovery';

const execute = promisify(execFile);
let fixture: string;
const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: nullFile, GIT_CONFIG_SYSTEM: nullFile };
const git = (args: string[]) => execute('git', args, { env: gitEnv, windowsHide: true, timeout: 3000 });

beforeEach(async () => { fixture = await mkdtemp(join(tmpdir(), 'agent-town-discovery-')); });
afterEach(async () => {
  const resolved = resolve(fixture);
  if (!resolved.startsWith(`${resolve(tmpdir())}${process.platform === 'win32' ? '\\' : '/'}agent-town-discovery-`)) throw new Error('Unsafe fixture cleanup');
  await rm(resolved, { recursive: true, force: true });
});

async function repository(name = 'project') {
  const path = join(fixture, name);
  await mkdir(path, { recursive: true });
  await git(['init', '--initial-branch=main', path]);
  await writeFile(join(path, 'source.ts'), 'export const answer = 1;\n');
  await git(['-C', path, 'add', 'source.ts']);
  await git(['-C', path, '-c', 'user.name=Discovery Test', '-c', 'user.email=fixture@example.invalid',
    '-c', `core.hooksPath=${nullFile}`, 'commit', '--no-gpg-sign', '-m', 'Fixture']);
  return path;
}

describe('selected-root repository discovery', () => {
  it('finds actual Git state and instruction metadata without changing the index or retaining source bodies', async () => {
    const repo = await repository();
    await mkdir(join(repo, '.claude', 'rules'), { recursive: true });
    await mkdir(join(repo, '.codex'), { recursive: true });
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'AGENTS.md'), 'PRIVATE INSTRUCTION BODY');
    await writeFile(join(repo, 'src', 'AGENTS.md'), 'NESTED PRIVATE BODY');
    await writeFile(join(repo, '.claude', 'rules', 'style.md'), 'PRIVATE CLAUDE RULE');
    await writeFile(join(repo, '.codex', 'config.toml'), 'api_key="PRIVATE CONFIG VALUE"');
    await writeFile(join(repo, 'source.ts'), 'export const answer = 2;\n');
    const indexPath = join(repo, '.git', 'index');
    const before = await readFile(indexPath);
    const beforeInfo = await lstat(indexPath);
    const result = await discoverRepositories([fixture]);
    expect(result.coverage).toMatchObject({ status: 'complete', issues: [] });
    expect(result.repositories).toHaveLength(1);
    const found = result.repositories[0];
    expect(found).toMatchObject({ name: 'project', kind: 'checkout', canonicalPath: await canonicalizeRoot(repo),
      git: { availability: 'available', branch: 'main', changedFiles: 1, untrackedFiles: null, scope: 'tracked-files' } });
    expect(found.git.head).toMatch(/^[a-f0-9]{40}$/u);
    expect(found.instructions.map(file => file.path)).toEqual(['.claude/rules/style.md', '.codex/config.toml', 'AGENTS.md', 'src/AGENTS.md']);
    expect(found.instructions.find(file => file.path === 'src/AGENTS.md')).toMatchObject({ scope: 'src', appliedToRun: false, contentRead: false });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(await readFile(indexPath)).toEqual(before);
    expect((await lstat(indexPath)).mtimeMs).toBe(beforeInfo.mtimeMs);
    expect(result.delta.added).toEqual([found.id]);
  });

  it('deduplicates overlapping roots and keeps nested repositories separate', async () => {
    const outer = await repository('outer');
    const nested = await repository('outer/nested');
    const result = await discoverRepositories([fixture, outer, fixture]);
    expect(result.roots).toHaveLength(2);
    expect(result.repositories.map(repo => repo.canonicalPath)).toEqual([await canonicalizeRoot(outer), await canonicalizeRoot(nested)]);
    expect(new Set(result.repositories.map(repo => repo.id)).size).toBe(2);
  });

  it('relates linked worktrees inside selected roots without collapsing checkouts', async () => {
    const main = await repository('main');
    const worktree = join(fixture, 'task');
    await git(['-C', main, 'worktree', 'add', '-b', 'task/test', worktree]);
    const result = await discoverRepositories([fixture]);
    expect(result.repositories).toHaveLength(2);
    const found = result.repositories.find(repo => repo.name === 'task')!;
    expect(found).toMatchObject({ kind: 'worktree', commonGitDirectory: join(await canonicalizeRoot(main), '.git'),
      git: { availability: 'available', branch: 'task/test', changedFiles: 0 } });
  });

  it('reports an external worktree pointer as unavailable without following it', async () => {
    const main = await repository('main');
    const selected = join(fixture, 'selected');
    await mkdir(selected);
    await git(['-C', main, 'worktree', 'add', '-b', 'task/external', join(selected, 'task')]);
    const result = await discoverRepositories([selected]);
    expect(result.repositories).toHaveLength(1);
    expect(result.repositories[0]).toMatchObject({ kind: 'worktree', commonGitDirectory: null,
      git: { availability: 'unavailable', reason: 'external-git-directory', changedFiles: null } });
  });

  it('skips dependencies, secrets and histories, including credential-like instruction filenames', async () => {
    const repo = await repository();
    await repository('project/node_modules/dependency');
    await mkdir(join(repo, '.claude', 'rules'), { recursive: true });
    await mkdir(join(repo, '.claude', 'sessions'), { recursive: true });
    await mkdir(join(repo, '.ssh'), { recursive: true });
    await writeFile(join(repo, '.claude', 'rules', 'secrets.md'), 'SECRET DO NOT READ');
    await writeFile(join(repo, '.claude', 'sessions', 'AGENTS.md'), 'HISTORY DO NOT READ');
    await writeFile(join(repo, '.ssh', 'AGENTS.md'), 'KEY DO NOT READ');
    await writeFile(join(repo, '.env'), 'PRIVATE ENVIRONMENT VALUE');
    const result = await discoverRepositories([fixture]);
    expect(result.repositories).toHaveLength(1);
    expect(result.repositories[0].instructions).toEqual([]);
    expect(result.coverage.excludedEntries).toBeGreaterThan(1);
    expect(JSON.stringify(result)).not.toMatch(/SECRET DO NOT READ|HISTORY DO NOT READ|KEY DO NOT READ|PRIVATE ENVIRONMENT VALUE/u);
  });

  it('rejects selected junctions and never descends through a discovered junction', async () => {
    const outside = await repository('outside');
    const selected = join(fixture, 'selected');
    await mkdir(selected);
    const link = join(selected, 'escape');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(canonicalizeRoot(link)).rejects.toMatchObject({ code: 'unsafe-root' });
    const result = await discoverRepositories([selected]);
    expect(result.repositories).toEqual([]);
    expect(result.coverage).toMatchObject({ status: 'partial', unsafeEntries: 1, issues: ['unsafe-path'] });
    expect(result.delta.removalConfirmed).toBe(false);
  });

  it('bounds directory traversal and does not infer repository removal from a partial scan', async () => {
    await repository();
    const previous = (await discoverRepositories([fixture])).repositories;
    const result = await discoverRepositories([fixture], { previous, limits: { maxEntries: 1 } });
    expect(result.coverage).toMatchObject({ status: 'partial', entriesVisited: 1 });
    expect(result.coverage.issues).toContain('entry-limit');
    expect(result.delta).toMatchObject({ removed: [], removalConfirmed: false });
    const cancelled = await discoverRepositories([fixture], { signal: AbortSignal.abort() });
    expect(cancelled.coverage.issues).toContain('cancelled');
  });

  it('does not spend the shared entry budget walking a repository\'s ordinary loose objects', async () => {
    const repo = await repository();
    const objectCount = 3000;
    let created = 0;
    for (let fanout = 0; fanout < 256 && created < objectCount; fanout++) {
      const dir = join(repo, '.git', 'objects', fanout.toString(16).padStart(2, '0'));
      await mkdir(dir, { recursive: true });
      for (let file = 0; file < Math.ceil(objectCount / 256) && created < objectCount; file++, created++) {
        await writeFile(join(dir, file.toString(16).padStart(38, '0')), Buffer.from([0x78, 0x01, 0x00]));
      }
    }
    const result = await discoverRepositories([fixture], { limits: { maxEntries: 2000 } });
    expect(result.coverage.status).toBe('complete');
    expect(result.coverage.entriesVisited).toBeLessThan(objectCount);
    expect(result.repositories).toHaveLength(1);
    expect(result.repositories[0].git).toMatchObject({ availability: 'available', branch: 'main', changedFiles: 0 });
  });

  it('uses metadata fingerprints for refresh, detects edits and confirms removal only after a full scan', async () => {
    const repo = await repository();
    await writeFile(join(repo, 'AGENTS.md'), 'One');
    const first = await discoverRepositories([fixture]);
    const unchanged = await discoverRepositories([fixture], { previous: first.repositories });
    expect(unchanged.delta).toMatchObject({ added: [], changed: [], removed: [], removalConfirmed: true });
    await writeFile(join(repo, 'AGENTS.md'), 'Two, with more metadata bytes');
    const changed = await discoverRepositories([fixture], { previous: unchanged.repositories });
    expect(changed.delta.changed).toEqual([first.repositories[0].id]);
    await rename(join(repo, '.git'), join(repo, '.git-disabled'));
    const removed = await discoverRepositories([fixture], { previous: changed.repositories });
    expect(removed.delta.removed).toEqual([first.repositories[0].id]);
    expect(removed.delta.removalConfirmed).toBe(true);
  });

  it.each(['include', 'filter "dangerous"'])('refuses unsafe Git configuration before executing repository-defined helpers: %s', async section => {
    const repo = await repository();
    const config = join(repo, '.git', 'config');
    const before = await readFile(config, 'utf8');
    await writeFile(config, `${before}\n[${section}]\n\tpath = ../outside-config\n\tprocess = echo PRIVATE RAW HELPER VALUE\n`);
    const result = await discoverRepositories([fixture]);
    expect(result.repositories[0].git).toMatchObject({ availability: 'unavailable', reason: 'unsafe-git-config', changedFiles: null });
    expect(JSON.stringify(result)).not.toContain('PRIVATE RAW HELPER VALUE');
    expect(createHash('sha256').update(await readFile(config)).digest('hex')).toBe(createHash('sha256').update(`${before}\n[${section}]\n\tpath = ../outside-config\n\tprocess = echo PRIVATE RAW HELPER VALUE\n`).digest('hex'));
  });

  it('disables repository fsmonitor commands and ignores ambient Git overrides', async () => {
    const repo = await repository();
    await git(['-C', repo, 'config', 'core.fsmonitor', 'echo UNTRUSTED FSMONITOR']);
    const oldDirectory = process.env.GIT_DIR;
    const oldConfigCount = process.env.GIT_CONFIG_COUNT;
    process.env.GIT_DIR = join(fixture, 'not-a-repo');
    process.env.GIT_CONFIG_COUNT = '1000';
    try {
      const result = await discoverRepositories([fixture]);
      expect(result.repositories[0].git).toMatchObject({ availability: 'available', branch: 'main', changedFiles: 0 });
    } finally {
      if (oldDirectory === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = oldDirectory;
      if (oldConfigCount === undefined) delete process.env.GIT_CONFIG_COUNT; else process.env.GIT_CONFIG_COUNT = oldConfigCount;
    }
  });

  it('excludes tracked secret files and linked directories from Git changed-file counts', async () => {
    const repo = await repository();
    await mkdir(join(repo, 'linked'));
    await writeFile(join(repo, '.env'), 'PRIVATE_VALUE=before');
    await writeFile(join(repo, 'linked', 'file.ts'), 'export const value = 1;');
    await git(['-C', repo, 'add', '.env', 'linked/file.ts']);
    await git(['-C', repo, '-c', 'user.name=Discovery Test', '-c', 'user.email=fixture@example.invalid',
      '-c', `core.hooksPath=${nullFile}`, 'commit', '--no-gpg-sign', '-m', 'Boundary fixture']);
    const outside = join(fixture, 'outside');
    await rename(join(repo, 'linked'), outside);
    await writeFile(join(outside, 'file.ts'), 'export const value = "EXTERNAL PRIVATE VALUE";');
    await symlink(outside, join(repo, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(repo, '.env'), 'PRIVATE_VALUE=after');
    const result = await discoverRepositories([repo]);
    expect(result.repositories[0].git).toMatchObject({ availability: 'available', changedFiles: 0 });
    expect(result.coverage.issues).toContain('unsafe-path');
    expect(JSON.stringify(result)).not.toContain('EXTERNAL PRIVATE VALUE');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_VALUE');
  });

  it('bounds instruction inventory and prevents a Git metadata link escape', async () => {
    const repo = await repository();
    await writeFile(join(repo, 'AGENTS.md'), 'one');
    await writeFile(join(repo, 'CLAUDE.md'), 'two');
    const capped = await discoverRepositories([repo], { limits: { maxInstructionsPerRepository: 1 } });
    expect(capped.repositories[0].instructions).toHaveLength(1);
    expect(capped.coverage.issues).toContain('instruction-limit');
    const outside = join(fixture, 'outside');
    await rename(join(repo, '.git', 'refs'), outside);
    await symlink(outside, join(repo, '.git', 'refs'), process.platform === 'win32' ? 'junction' : 'dir');
    const linked = await discoverRepositories([repo]);
    expect(linked.repositories[0].git).toMatchObject({ availability: 'unavailable', reason: 'unsafe-path', changedFiles: null });
  });

  it('rejects broad roots, relative paths, missing folders, and limit escalation', async () => {
    await expect(canonicalizeRoot('.')).rejects.toMatchObject({ code: 'invalid-root' });
    await expect(canonicalizeRoot(parse(fixture).root)).rejects.toMatchObject({ code: 'invalid-root' });
    await expect(canonicalizeRoot(join(fixture, 'missing'))).rejects.toMatchObject({ code: 'unavailable-root' });
    await expect(discoverRepositories([fixture], { limits: { maxEntries: 30_001 } })).rejects.toMatchObject({ code: 'invalid-limits' });
  });
});
