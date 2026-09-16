import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareSourceTree, protectedSourcePath, releaseSourceTree, requireSourceTree, retainSourceChanges, type PreparedSourceTree } from '../../apps/service/src/runner/source-tree';
import { supportsRestrictedReads } from '../../apps/service/src/runner/sandbox-boundary';
import { verifySandboxBoundary } from '../../apps/service/src/runner/sandbox-probes';
import { executeWorkerTool } from '../../apps/service/src/runner/api-tools';
import type { RpcTransport } from '../../apps/service/src/runner/rpc';
import type { ExecutionInput } from '../../apps/service/src/runner/types';
import { NativeRunExecutor } from '../../apps/service/src/runner/native';
import { changedWorktreeFiles, createManagedWorktree } from '../../apps/service/src/runner/worktrees';

const execute = promisify(execFile), directories: string[] = [], trees: PreparedSourceTree[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-town-source-boundary-')); directories.push(directory);
  const worktree = join(directory, 'retained'), managed = join(directory, 'managed');
  await mkdir(worktree); await mkdir(managed);
  await writeFile(join(worktree, 'source.js'), 'export const value = 1;');
  return { directory, worktree, managed };
}
async function prepare(worktree: string, managed: string) { const tree = await prepareSourceTree(worktree, managed, 'run-fixture'); trees.push(tree); return tree; }
afterEach(async () => {
  for (const tree of trees.splice(0)) releaseSourceTree(tree);
  for (const path of directories.splice(0)) {
    const inside = relative(resolve(tmpdir()), resolve(path));
    if (!inside || inside.startsWith('..') || !inside.startsWith('agent-town-source-boundary-')) throw new Error('Unsafe test cleanup');
    await rm(path, { recursive: true, force: true });
  }
});

describe('source-only execution materialization', () => {
  it('keeps protected files and history outside source builds and copies back only source changes', async () => {
    const { worktree, managed } = await fixture();
    await mkdir(join(worktree, '.git', 'objects'), { recursive: true });
    await mkdir(join(worktree, '.claude'));
    await mkdir(join(worktree, 'node_modules'));
    await writeFile(join(worktree, '.env'), 'PRIVATE_FIXTURE_VALUE');
    await writeFile(join(worktree, '.git', 'objects', 'fixture'), 'OLD_PRIVATE_FIXTURE');
    await writeFile(join(worktree, '.claude', 'settings.json'), 'PRIVATE_SETTINGS_FIXTURE');
    await writeFile(join(worktree, 'node_modules', 'fixture.js'), 'cached dependency');
    await writeFile(join(worktree, 'removed.js'), 'old source');
    const tree = await prepare(worktree, managed);
    expect(tree.excludedEntries).toBe(4);
    for (const name of ['.env', '.git', '.claude', 'node_modules']) await expect(lstat(join(tree.path, name))).rejects.toMatchObject({ code: 'ENOENT' });
    // This checks ordinary fixture build compatibility, not OS sandbox isolation.
    await execute(process.execPath, ['-e', 'const fs=require("node:fs");fs.writeFileSync("source.js","export const value = 2;");fs.writeFileSync("test.js","console.log(2)");fs.unlinkSync("removed.js")'], { cwd: tree.path, windowsHide: true });
    await retainSourceChanges(tree);
    expect(await readFile(join(worktree, 'source.js'), 'utf8')).toBe('export const value = 2;');
    expect(await readFile(join(worktree, 'test.js'), 'utf8')).toBe('console.log(2)');
    await expect(lstat(join(worktree, 'removed.js'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(worktree, '.env'), 'utf8')).toBe('PRIVATE_FIXTURE_VALUE');
    expect(await readFile(join(worktree, '.git', 'objects', 'fixture'), 'utf8')).toBe('OLD_PRIVATE_FIXTURE');
    await expect(prepareSourceTree(worktree, managed, 'run-fixture')).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('rejects linked or hard-linked input files before copying them', async () => {
    const { worktree, managed, directory } = await fixture();
    const outside = join(directory, 'outside'); await mkdir(outside); await writeFile(join(outside, 'fixture.js'), 'outside fixture');
    await symlink(outside, join(worktree, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(prepareSourceTree(worktree, managed, 'run-junction')).rejects.toBeDefined();
    await rm(join(worktree, 'linked'));
    await link(join(outside, 'fixture.js'), join(worktree, 'linked.js'));
    await expect(prepareSourceTree(worktree, managed, 'run-hardlink')).rejects.toMatchObject({ code: 'source_tree_unsafe' });
  });

  it('rejects output links before modifying the retained worktree', async () => {
    const { worktree, managed, directory } = await fixture(), tree = await prepare(worktree, managed);
    await writeFile(join(tree.path, 'source.js'), 'changed source');
    await symlink(worktree, join(tree.path, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(retainSourceChanges(tree)).rejects.toBeDefined();
    expect(await readFile(join(worktree, 'source.js'), 'utf8')).toBe('export const value = 1;');
    expect(relative(directory, tree.path)).toContain('managed');
  });

  it('preserves independent retained edits and ignores generated protected files', async () => {
    const { worktree, managed } = await fixture(), tree = await prepare(worktree, managed);
    await writeFile(join(tree.path, 'new.js'), 'new source');
    await writeFile(join(tree.path, 'source.js'), 'worker source');
    await writeFile(join(tree.path, '.env'), 'worker generated data');
    await writeFile(join(worktree, 'source.js'), 'independent source');
    await expect(retainSourceChanges(tree)).rejects.toMatchObject({ code: 'retained_worktree_changed' });
    await expect(lstat(join(worktree, 'new.js'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(worktree, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(worktree, 'source.js'), 'utf8')).toBe('independent source');
  });

  it('bounds source input and excludes credential formats consistently', async () => {
    const { worktree, managed } = await fixture();
    for (const name of ['.npmrc', '.git-credentials', 'sub/.env.local', '.codex/auth.json', 'keys/private.key', 'auth.json', 'id_ed25519']) expect(protectedSourcePath(name)).toBe(true);
    expect(protectedSourcePath('src/app.ts')).toBe(false);
    await writeFile(join(worktree, 'large.bin'), Buffer.alloc(8_000_001));
    await expect(prepareSourceTree(worktree, managed, 'run-large')).rejects.toMatchObject({ code: 'source_tree_unsafe' });
  });

  it('preserves real Git review diffs while withholding tracked private files and old history', async () => {
    const { worktree: repository, managed } = await fixture();
    const git = async (args: string[]) => execute('git', ['-c', 'init.templateDir=', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-C', repository, ...args], { windowsHide: true });
    await git(['init']); await writeFile(join(repository, '.env'), 'TRACKED_PRIVATE_FIXTURE');
    await git(['add', 'source.js', '.env']);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--no-gpg-sign', '-m', 'Source fixture']);
    const commit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const retained = await createManagedWorktree(repository, commit, managed, 'run-fixture', [repository]);
    const tree = await prepare(retained.path, managed);
    await expect(execute('git', ['-C', tree.path, 'log', '-1'], { windowsHide: true, env: { ...process.env, GIT_DIR: '', GIT_WORK_TREE: '', GIT_CEILING_DIRECTORIES: managed } })).rejects.toBeDefined();
    await expect(lstat(join(tree.path, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(tree.path, 'source.js'), 'export const value = 3;');
    await retainSourceChanges(tree);
    expect(await changedWorktreeFiles(retained.path, repository, [repository])).toEqual(['source.js']);
    expect(await readFile(join(retained.path, '.env'), 'utf8')).toBe('TRACKED_PRIVATE_FIXTURE');
    expect(await readFile(join(repository, 'source.js'), 'utf8')).toBe('export const value = 1;');
  }, 15000);

  it('requires a registered source tree for every API tool including generic commands', async () => {
    const { worktree, managed } = await fixture();
    const rpc: RpcTransport = { request: vi.fn(async () => ({ exitCode: 0, stdout: 'fixture result', stderr: '' })), notify: vi.fn(), subscribe: vi.fn(() => () => undefined), close: vi.fn() };
    const input = { worktree, apiKey: null, signal: new AbortController().signal } as ExecutionInput;
    await executeWorkerTool('run_command', { argv: [process.execPath, '-e', 'console.log(1)'] }, input, rpc);
    expect(rpc.request).not.toHaveBeenCalled();
    const tree = await prepare(worktree, managed);
    await executeWorkerTool('read_file', { path: '.env' }, { ...input, worktree: tree.path }, rpc);
    expect(rpc.request).not.toHaveBeenCalled();
    await executeWorkerTool('run_command', { argv: [process.execPath, '-e', 'console.log(1)'] }, { ...input, worktree: tree.path }, rpc);
    expect(rpc.request).toHaveBeenCalledWith('command/exec', expect.objectContaining({ cwd: tree.path, sandboxPolicy: expect.objectContaining({ readOnlyAccess: expect.objectContaining({ includePlatformDefaults: false }) }) }), 35000);
    releaseSourceTree(tree); expect(() => requireSourceTree(tree.path)).toThrow('source-only');
  });
});

describe('native boundary capability and failure gates', () => {
  it('rejects protocols that cannot express read restrictions even if writable roots exist', () => {
    const policy = { properties: { type: { enum: ['workspaceWrite'] }, writableRoots: { type: 'array' } } };
    expect(supportsRestrictedReads({ definitions: { SandboxPolicy: { anyOf: [policy] } } })).toBe(false);
    expect(supportsRestrictedReads({ definitions: { SandboxPolicy: { anyOf: [{ properties: { ...policy.properties, readOnlyAccess: { properties: { type: { enum: ['restricted'] }, readableRoots: {}, includePlatformDefaults: {} } } } }] } } })).toBe(true);
  });

  it.each([17, 19])('blocks exposure or an inconclusive denial before inference (probe exit %s)', async exitCode => {
    const { worktree, managed } = await fixture();
    const request = vi.fn<RpcTransport['request']>().mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }).mockResolvedValue({ exitCode, stdout: '', stderr: '' });
    const rpc: RpcTransport = { request, notify: vi.fn(), subscribe: vi.fn(() => () => undefined), close: vi.fn() };
    await expect(verifySandboxBoundary(rpc, worktree, managed)).rejects.toMatchObject({ code: 'codex_source_isolation_missing' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(([method]) => method === 'command/exec')).toBe(true);
  });

  it('keeps native built-in tools blocked rather than treating command probes as proof', async () => {
    const { worktree, managed } = await fixture();
    const input = { worktree, draft: { tool: 'codex', mode: 'subscription' } } as ExecutionInput;
    await expect(new NativeRunExecutor(managed).execute(input)).rejects.toMatchObject({ code: 'native_source_boundary_unverified' });
  });
});
