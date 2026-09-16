import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, open, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TownState } from '@agent-town/contracts';
import type { CreateRunDraft } from '../../packages/contracts/src/runner';
import type { WorkflowModel, WorkflowUsage } from '../../packages/contracts/src/workflow';
import { Store } from '../../apps/service/src/store';
import { initialWorkflow } from '../../apps/service/src/workflow/budget';
import { RunnerService, NativeRunExecutor, type RunExecutor, type ExecutionInput, type RpcTransport } from '../../apps/service/src/runner';
import { BoundedOpenAIWorker } from '../../apps/service/src/runner/openai-worker';
import { BoundedAnthropicWorker } from '../../apps/service/src/runner/anthropic-worker';
import { checkedWorktreeFile, sourceFingerprint } from '../../apps/service/src/runner/worktrees';
import { minimalEnvironment } from '../../apps/service/src/runner/rpc';
import { executeWorkerTool } from '../../apps/service/src/runner/api-tools';
import { prepareSourceTree, releaseSourceTree } from '../../apps/service/src/runner/source-tree';

const execute = promisify(execFile);
const key = 'sk-fixture_runner_credential_never_real';
const usage: WorkflowUsage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, source: 'provider-reported' };
const fixtures: { service: RunnerService; store: Store; directory: string }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.service.close(); fixture.store.close();
    const root = await realpath(tmpdir()), target = await realpath(fixture.directory), path = relative(root, target);
    if (!path || path.startsWith('..') || isAbsolute(path) || !target.includes('agent-town-runner-test-')) throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  }
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-town-runner-test-')), repo = join(directory, 'source');
  await mkdir(repo); await execute('git', ['init', '-q', repo]);
  await execute('git', ['-C', repo, 'config', 'user.name', 'Fixture']); await execute('git', ['-C', repo, 'config', 'user.email', 'fixture@example.test']);
  await writeFile(join(repo, 'source.ts'), 'export const value = 1;\n');
  await execute('git', ['-C', repo, 'add', 'source.ts']); await execute('git', ['-C', repo, 'commit', '-q', '-m', 'Fixture']);
  const workflow = initialWorkflow();
  workflow.policy = { paidEnabled: true, dailyBudgetMicroUsd: 1_000_000, managerDailyBudgetMicroUsd: 100_000, maxRunBudgetMicroUsd: 100_000, workerConcurrency: 1, timeZone: 'UTC' };
  workflow.connections.push({ id: 'connection-fixture', provider: 'openai', mode: 'api', label: 'Fixture account', status: 'verified', verifiedAt: new Date().toISOString(), createdAt: new Date().toISOString(), accountIdentity: 'unavailable', models: ['fixture-model'], capabilities: { manager: true, managedExecution: true } });
  const seed: TownState = { schemaVersion: 1, workspace: { id: 'fixture-workspace', name: 'Fixture', mode: 'private' }, discovery: { roots: [repo], candidates: [], operation: null }, workflow,
    repositories: [{ id: 'repo', name: 'Repo', description: '', language: 'TypeScript', branch: 'main', color: '#aaaaaa', position: [0, 0], source: 'local', localPath: repo }], agents: [], handoffs: [], activity: [], manager: { version: 1, brief: 'Preserve accepted decisions.', updatedAt: null }, simulation: { running: false, step: 0 } };
  const store = new Store(':memory:', seed);
  const executor: RunExecutor = { preflight: vi.fn(async tool => ({ tool, ready: true, checkedAt: new Date().toISOString(), checks: [{ name: 'Fixture transport', passed: true, message: 'Dependency-injected test fixture; no native sandbox claim.' }] })), subscription: vi.fn(), execute: vi.fn(async input => {
    const reservation = input.onRequestStart(100, input.draft.maxOutputTokens); input.onRequestComplete(reservation, usage);
    await writeFile(join(input.worktree, 'source.ts'), 'export const value = 2;\n'); input.onContextDelivered();
    return { outcome: 'review' as const, summary: `Changed source. Fixture check only. ${key}`, usage, providerRequests: 1 };
  }) };
  const service = new RunnerService({ store, dataDirectory: join(directory, 'data'), executor, vault: { available: true, put: vi.fn(), get: vi.fn(async () => key), delete: vi.fn() } });
  fixtures.push({ service, store, directory });
  const price: WorkflowModel = { model: 'fixture-model', contextWindowTokens: 16000, inputPerMillionMicroUsd: 1_000_000, outputPerMillionMicroUsd: 5_000_000, cachedInputPerMillionMicroUsd: 100_000, cacheWritePerMillionMicroUsd: 2_000_000, priceSource: 'https://example.test/pricing', priceCheckedAt: new Date().toISOString(), qualityStatus: 'user-attested', qualityNote: 'Fixture only; no model evaluation.' };
  const draft: CreateRunDraft = { dependencyTaskIds: [], repoId: 'repo', tool: 'openai-api', connectionId: 'connection-fixture', mode: 'api', objective: 'Update the source value.', acceptanceCriteria: ['Change only the source value.'], model: 'fixture-model', price, maxTurns: 2, maxOutputTokens: 500, maxMinutes: 1, budgetMicroUsd: 20000, acknowledgeSubscriptionLimits: false };
  const create = async (id = 'draft') => { await service.createDraft(draft, id); return service.status().tasks.at(-1)!; };
  return { directory, repo, store, service, executor, draft, create };
}

// These exercise real Windows Git processes and worktrees. Multiple verification
// passes take over 10 seconds even when their assertions succeed.
describe('managed run authorization and durable lifecycle', { timeout: 30000 }, () => {
  it('rejects managed work for a connected plain folder without initializing Git or starting a worker', async () => {
    const { service, store, directory, executor, draft } = await setup();
    const folder = join(directory, 'plain-project');
    await mkdir(folder);
    await writeFile(join(folder, 'source.ts'), 'export const observed = true;\n');
    store.commit('plain-folder-fixture', state => {
      state.discovery!.roots = [folder];
      Object.assign(state.repositories[0]!, { localPath: folder, selectedRoot: folder, projectKind: 'folder', branch: 'Not applicable', git: { availability: 'unavailable', head: null, changedFiles: null, untrackedFiles: null, reason: 'not-a-git-repository' } });
      return 'fixture.plain-folder';
    });
    const before = await readFile(join(folder, 'source.ts'), 'utf8');
    const preflight = await service.preflight('openai-api', 'repo');
    expect(preflight.ready).toBe(false);
    expect(preflight.checks).toContainEqual(expect.objectContaining({ name: 'Selected repository', passed: false }));
    await expect(service.createDraft(draft, 'plain-folder-draft')).rejects.toMatchObject({ code: 'repository_invalid' });
    expect(service.status().tasks).toEqual([]);
    expect(service.status().runs).toEqual([]);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(await readFile(join(folder, 'source.ts'), 'utf8')).toBe(before);
    await expect(readFile(join(folder, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('verifies committed integration separately and refuses changed retained source', async () => {
    const { service, create, repo } = await setup(), task = await create('integration-draft');
    await service.approve(task.id, task.approvalHash, 'integration-approved');
    await vi.waitFor(() => expect(service.status().runs[0]!.status).toBe('awaiting_review'), { timeout: 5000 });
    const run = service.status().runs[0]!;
    expect(run.sourceFingerprint).toMatch(/^v2:[a-f0-9]{64}$/);
    service.review(task.id, 'accepted', 'accepted-integration');
    await expect(service.verifyIntegration(task.id, 'premature-integration')).rejects.toMatchObject({ code: 'integration_not_verified' });
    await writeFile(join(repo, 'source.ts'), await readFile(join(run.worktreePath!, 'source.ts')));
    await execute('git', ['-C', repo, 'add', 'source.ts']); await execute('git', ['-C', repo, 'commit', '-q', '-m', 'Fixture integration performed by test owner']);
    await service.verifyIntegration(task.id, 'verified-integration');
    expect(service.status().tasks[0]!.integration).toMatchObject({ files: ['source.ts'] });
    expect(service.status().tasks[0]!.integration!.commit).not.toBe(task.baseCommit);
    await writeFile(join(run.worktreePath!, 'source.ts'), 'export const value = 999;\n');
    await expect(service.verifyIntegration(task.id, 'changed-evidence')).rejects.toMatchObject({ code: 'worktree_changed' });
  });
  it('rejects mode-only worker commits until the owner commits the same executable mode', async () => {
    const { service, create, repo, executor } = await setup();
    await execute('git', ['-C', repo, 'config', 'core.fileMode', 'false']);
    executor.execute = vi.fn(async (input: ExecutionInput) => {
      await execute('git', ['-C', input.worktree, 'update-index', '--chmod=+x', 'source.ts']);
      await execute('git', ['-C', input.worktree, 'commit', '-q', '-m', 'Fixture worker executable mode']);
      return { outcome: 'review' as const, summary: 'Fixture changed the Git executable bit only.', usage: null, providerRequests: 0 };
    });
    const task = await create('mode-only-draft'); await service.approve(task.id, task.approvalHash, 'mode-only-approved');
    await vi.waitFor(() => expect(service.status().runs[0]!.status).toBe('awaiting_review'), { timeout: 5000 });
    const run = service.status().runs[0]!;
    expect(run.changedFiles).toEqual(['source.ts']); expect(run.sourceFingerprint).toMatch(/^v2:/);
    expect(await readFile(join(run.worktreePath!, 'source.ts'))).toEqual(await readFile(join(repo, 'source.ts')));
    service.review(task.id, 'accepted', 'mode-only-reviewed');
    await expect(service.verifyIntegration(task.id, 'mode-only-not-integrated')).rejects.toMatchObject({ code: 'integration_not_verified' });
    expect(service.status().tasks[0]!.integration).toBeUndefined();
    await execute('git', ['-C', repo, 'update-index', '--chmod=+x', 'source.ts']);
    await execute('git', ['-C', repo, 'commit', '-q', '-m', 'Fixture owner integrates executable mode']);
    await service.verifyIntegration(task.id, 'mode-only-integrated');
    expect(service.status().tasks[0]!.integration?.files).toEqual(['source.ts']);
    expect(service.status().tasks[0]!.integration?.commit).not.toBe(task.baseCommit);
  });
  it('detects Git index mode tampering even when changed paths and source bytes stay the same', async () => {
    const { service, create, repo } = await setup();
    await execute('git', ['-C', repo, 'config', 'core.fileMode', 'false']);
    const task = await create('mode-tamper-draft'); await service.approve(task.id, task.approvalHash, 'mode-tamper-approved');
    await vi.waitFor(() => expect(service.status().runs[0]!.status).toBe('awaiting_review'), { timeout: 5000 });
    const run = service.status().runs[0]!, before = await readFile(join(run.worktreePath!, 'source.ts'));
    service.review(task.id, 'accepted', 'mode-tamper-reviewed');
    await execute('git', ['-C', run.worktreePath!, 'update-index', '--chmod=+x', 'source.ts']);
    expect(await readFile(join(run.worktreePath!, 'source.ts'))).toEqual(before);
    expect(await sourceFingerprint(run.worktreePath!, repo, [repo], task.baseCommit)).not.toBe(run.sourceFingerprint);
    await expect(service.verifyIntegration(task.id, 'mode-tamper-verify')).rejects.toMatchObject({ code: 'worktree_changed' });
  });
  it.skipIf(process.platform === 'win32')('includes an unstaged Unix owner executable-bit change in source evidence', async () => {
    const { service, create, repo } = await setup();
    await execute('git', ['-C', repo, 'config', 'core.fileMode', 'true']);
    const task = await create('unix-mode-draft'); await service.approve(task.id, task.approvalHash, 'unix-mode-approved');
    await vi.waitFor(() => expect(service.status().runs[0]!.status).toBe('awaiting_review'), { timeout: 5000 });
    const run = service.status().runs[0]!;
    await chmod(join(run.worktreePath!, 'source.ts'), 0o755);
    expect(await sourceFingerprint(run.worktreePath!, repo, [repo], task.baseCommit)).not.toBe(run.sourceFingerprint);
  });
  it.skipIf(process.platform !== 'win32')('refuses to infer Git executable modes from Windows stat when core.fileMode is true', async () => {
    const { service, create, repo } = await setup(), task = await create('unavailable-mode-draft');
    await service.approve(task.id, task.approvalHash, 'unavailable-mode-approved');
    await vi.waitFor(() => expect(service.status().runs[0]!.status).toBe('awaiting_review'), { timeout: 5000 });
    const run = service.status().runs[0]!;
    expect(run.sourceFingerprint).toMatch(/^v2:/);
    await execute('git', ['-C', repo, 'config', 'core.fileMode', 'true']);
    await expect(sourceFingerprint(run.worktreePath!, repo, [repo], task.baseCommit)).rejects.toMatchObject({ code: 'source_mode_unavailable' });
    expect(service.status().runs[0]!.sourceFingerprint).toBe(run.sourceFingerprint);
  });
  it('keeps legacy evidence readable but blocks re-verification and dependent approval without mode evidence', async () => {
    const { service, create, repo, store, draft, executor } = await setup(), task = await create('legacy-mode-draft');
    await service.approve(task.id, task.approvalHash, 'legacy-mode-approved');
    await vi.waitFor(() => expect(service.status().runs[0]!.status).toBe('awaiting_review'), { timeout: 5000 });
    const run = service.status().runs[0]!;
    service.review(task.id, 'accepted', 'legacy-mode-reviewed');
    await writeFile(join(repo, 'source.ts'), await readFile(join(run.worktreePath!, 'source.ts')));
    await execute('git', ['-C', repo, 'add', 'source.ts']); await execute('git', ['-C', repo, 'commit', '-q', '-m', 'Fixture owner integrates source']);
    await service.verifyIntegration(task.id, 'legacy-mode-integrated');
    const oldFingerprint = 'a'.repeat(64);
    store.commit('legacy-mode-fixture', state => { state.runner!.runs[0]!.sourceFingerprint = oldFingerprint; return 'fixture.legacy'; });
    const saved = structuredClone(service.status().tasks[0]!.integration);
    await expect(service.verifyIntegration(task.id, 'legacy-mode-reverify')).rejects.toMatchObject({ code: 'source_evidence_upgrade_required' });
    await service.createDraft({ ...draft, dependencyTaskIds: [task.id], objective: 'Use the accepted prerequisite.' }, 'legacy-mode-dependent');
    const dependent = service.status().tasks.at(-1)!;
    await expect(service.approve(dependent.id, dependent.approvalHash, 'legacy-mode-start')).rejects.toMatchObject({ code: 'source_evidence_upgrade_required' });
    expect(executor.execute).toHaveBeenCalledOnce();
    expect(service.status().runs[0]!.sourceFingerprint).toBe(oldFingerprint);
    expect(service.status().tasks[0]!.integration).toEqual(saved);
  });
  it('saves a revision with fresh approval while preserving and archiving the earlier unstarted draft', async () => {
    const { service, create, draft, executor } = await setup();
    const previous = await create('old-draft');
    await service.createDraft({ ...draft, objective: 'Revise the value and document it.', revisionOf: previous.id }, 'new-revision');
    const [old, revised] = service.status().tasks;
    expect(old!.draft).toEqual(previous.draft);
    expect(old!.archivedAt).toBeTruthy();
    expect(revised!.draft.revisionOf).toBe(previous.id);
    expect(revised!.approvalHash).not.toBe(previous.approvalHash);
    expect(revised!.approvedAt).toBeNull();
    await expect(service.approve(old!.id, old!.approvalHash, 'old-approval')).rejects.toMatchObject({ code: 'task_archived' });
    await expect(service.approve(revised!.id, previous.approvalHash, 'wrong-approval')).rejects.toMatchObject({ code: 'approval_changed' });
    expect(executor.execute).not.toHaveBeenCalled();
  });
  it('verifies Git-normalized Windows text and exact binary content without decoding blobs', async () => {
    const { service, create, repo, executor } = await setup();
    await execute('git', ['-C', repo, 'config', 'core.autocrlf', 'true']);
    const original = executor.execute;
    executor.execute = async input => {
      const result = await original(input);
      await writeFile(join(input.worktree, 'source.ts'), 'export const value = 2;\r\n');
      await writeFile(join(input.worktree, 'asset.bin'), Buffer.from([0, 255, 254, 13, 10, 128]));
      return result;
    };
    const task = await create('windows-integration');
    await service.approve(task.id, task.approvalHash, 'windows-approved');
    await vi.waitFor(() => expect(service.status().runs[0]!.status).toBe('awaiting_review'), { timeout: 5000 });
    const run = service.status().runs[0]!;
    service.review(task.id, 'accepted', 'windows-reviewed');
    for (const file of ['source.ts', 'asset.bin']) await writeFile(join(repo, file), await readFile(join(run.worktreePath!, file)));
    await execute('git', ['-C', repo, 'add', 'source.ts', 'asset.bin']);
    await execute('git', ['-C', repo, 'commit', '-q', '-m', 'Owner fixture integration']);
    await service.verifyIntegration(task.id, 'windows-verified');
    expect(service.status().tasks[0]!.integration!.files.sort()).toEqual(['asset.bin', 'source.ts']);
  });
  it('rejects cross-repository proposal references and records a valid source without launching work', async () => {
    const { service, store, draft, executor } = await setup();
    store.commit('proposal-fixture', state => { state.workflow!.manager.proposals.push({ id: 'proposal', sourceJobId: 'job', repoId: 'repo', title: 'Review source', acceptanceCriteria: ['Source checked'], status: 'proposed', createdAt: new Date().toISOString() }); return 'fixture'; });
    await expect(service.createDraft({ ...draft, sourceProposalId: 'other-proposal' }, 'bad-proposal')).rejects.toMatchObject({ code: 'proposal_unavailable' });
    await service.createDraft({ ...draft, sourceProposalId: 'proposal' }, 'valid-proposal');
    expect(service.status().tasks[0]!.draft.sourceProposalId).toBe('proposal');
    expect(executor.execute).not.toHaveBeenCalled();
    service.archive(service.status().tasks[0]!.id, 'archive-proposal');
    expect(service.status().tasks).toHaveLength(1);
  });
  it('refuses archiving or revising a result before its review', async () => {
    const { service, create, draft } = await setup();
    const task = await create('review-gate');
    await service.approve(task.id, task.approvalHash, 'start-review-gate');
    await vi.waitFor(() => expect(service.status().tasks[0]!.status).toBe('awaiting_review'), { timeout: 5000 });
    expect(() => service.archive(task.id, 'unsafe-archive')).toThrow('Stop or review');
    await expect(service.createDraft({ ...draft, revisionOf: task.id }, 'unsafe-revision')).rejects.toMatchObject({ code: 'revision_unavailable' });
    service.review(task.id, 'changes_requested', 'request-revision');
    await service.createDraft({ ...draft, revisionOf: task.id }, 'reviewed-revision');
    expect(service.status().tasks[0]!.status).toBe('changes_requested');
    expect(service.status().tasks[0]!.runId).toBeTruthy();
    expect(service.status().tasks[1]!.runId).toBeNull();
  });
  it('pins prerequisites and never launches missing or unaccepted dependencies', async () => {
    const { service, draft, create, executor, store } = await setup();
    await expect(service.createDraft({ ...draft, dependencyTaskIds: ['missing-task'] }, 'missing-dependency')).rejects.toMatchObject({ code: 'dependency_missing' });
    const prerequisite = await create('prerequisite');
    await service.createDraft({ ...draft, objective: 'Use the reviewed prerequisite.', dependencyTaskIds: [prerequisite.id] }, 'dependent');
    const dependent = service.status().tasks.at(-1)!;
    expect(dependent.draft.dependencyTaskIds).toEqual([prerequisite.id]);
    await expect(service.approve(dependent.id, dependent.approvalHash, 'too-early')).rejects.toMatchObject({ code: 'dependency_waiting' });
    expect(executor.execute).not.toHaveBeenCalled();
    expect(store.snapshot().state.workflow!.reservations).toHaveLength(0);
  });

  it('blocks repeated work awaiting review without consuming another provider request', async () => {
    const { service, create, executor } = await setup();
    const first = await create('first-intent');
    await service.approve(first.id, first.approvalHash, 'first-intent-approved');
    await vi.waitFor(() => expect(service.status().runs[0].status).toBe('awaiting_review'), { timeout: 5000 });
    const duplicate = await create('same-intent');
    await expect(service.approve(duplicate.id, duplicate.approvalHash, 'duplicate-approval')).rejects.toMatchObject({ code: 'duplicate_task' });
    expect(executor.execute).toHaveBeenCalledOnce();
  });

  it('serializes a repository even when two worker slots are permitted', async () => {
    const { service, store, draft, executor, create } = await setup();
    store.commit('two-slots', state => { state.workflow!.policy.workerConcurrency = 2; return 'policy.changed'; });
    executor.execute = vi.fn(async input => { await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true })); return { outcome: 'cancelled' as const, summary: 'Cancelled fixture.', usage, providerRequests: 0 }; });
    const first = await create('active-repo');
    await service.approve(first.id, first.approvalHash, 'active-repo-approved');
    await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledOnce(), { timeout: 5000 });
    await service.createDraft({ ...draft, objective: 'Perform a different task in this same repository.' }, 'repo-conflict');
    const other = service.status().tasks.at(-1)!;
    await expect(service.approve(other.id, other.approvalHash, 'conflicting-approval')).rejects.toMatchObject({ code: 'repository_active' });
    expect(executor.execute).toHaveBeenCalledOnce();
  });

  it('pins exact approval, creates an isolated worktree, saves the real result, and keeps review separate from acceptance', async () => {
    const { service, store, repo, create, executor } = await setup(), task = await create();
    expect(executor.execute).not.toHaveBeenCalled();
    await expect(service.approve(task.id, '0'.repeat(64), 'wrong')).rejects.toMatchObject({ code: 'approval_changed' });
    await service.approve(task.id, task.approvalHash, 'approve');
    await vi.waitFor(() => expect(service.status().runs[0].status).toBe('awaiting_review'), { timeout: 5000 });
    const run = service.status().runs[0];
    expect(await readFile(join(repo, 'source.ts'), 'utf8')).toContain('value = 1');
    expect(await readFile(join(run.worktreePath!, 'source.ts'), 'utf8')).toContain('value = 2');
    expect(run.changedFiles).toEqual(['source.ts']); expect(run.contextDelivery).toBe('provider-acknowledged');
    const evidence = await service.evidence(task.id, 'source.ts');
    expect(evidence.text).toContain('-export const value = 1;');
    expect(evidence.text).toContain('+export const value = 2;');
    expect(evidence.source).toBe('current-worktree');
    expect(evidence.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(join(run.worktreePath!, '.env'), 'PRIVATE_FIXTURE=not-a-real-secret');
    await expect(service.evidence(task.id, '.env')).rejects.toMatchObject({ code: 'file_path_denied' });
    expect(store.snapshot().state.handoffs[0]).toMatchObject({ status: 'saved', contextVersion: null });
    expect(store.snapshot().state.manager.version).toBe(1);
    expect(store.snapshot().state.agents[0].home.every(Number.isFinite)).toBe(true);
    expect(Math.abs(store.snapshot().state.agents[0].home[1])).toBeGreaterThan(2.65);
    expect(JSON.stringify(store.snapshot())).not.toContain(key);
    expect(store.snapshot().state.workflow!.reservations[0].status).toBe('settled');
    expect((await service.approve(task.id, task.approvalHash, 'approve')).duplicate).toBe(true);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    service.review(task.id, 'accepted', 'review');
    expect(service.status().tasks[0].status).toBe('accepted');
    expect(await readFile(join(repo, 'source.ts'), 'utf8')).toContain('value = 1');
  });
  it('blocks changed repository commits, stale context, disabled spending, and unsafe native API mode', async () => {
    const { service, store, draft, create, repo } = await setup(), task = await create();
    store.commit('context-change', state => { state.manager.version++; return 'context.changed'; });
    await expect(service.approve(task.id, task.approvalHash, 'approve-stale')).rejects.toMatchObject({ code: 'context_changed' });
    await expect(service.createDraft({ ...draft, tool: 'codex' }, 'native-api')).rejects.toMatchObject({ code: 'native_codex_api_limits_unsupported' });
    const second = await create('new-context');
    store.commit('spend-disabled', state => { state.workflow!.policy.paidEnabled = false; return 'policy.changed'; });
    await expect(service.approve(second.id, second.approvalHash, 'disabled')).rejects.toMatchObject({ code: 'paid_work_disabled' });
    await writeFile(join(repo, 'source.ts'), 'export const value = 3;\n'); await execute('git', ['-C', repo, 'add', 'source.ts']); await execute('git', ['-C', repo, 'commit', '-q', '-m', 'Changed fixture']);
    await expect(service.approve(second.id, second.approvalHash, 'changed-head')).rejects.toMatchObject({ code: 'repository_changed' });
    expect(service.status().runs).toHaveLength(0);
  });
  it('holds concurrency across settled requests and cancellation preserves the worktree', async () => {
    const { service, executor, create, store } = await setup();
    executor.execute = vi.fn(async input => { const reservation = input.onRequestStart(100, 500); input.onRequestComplete(reservation, usage); await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true })); return { outcome: 'cancelled' as const, summary: 'Cancelled fixture.', usage, providerRequests: 1 }; });
    const first = await create(); await service.approve(first.id, first.approvalHash, 'first');
    await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledOnce(), { timeout: 5000 });
    const second = await create('second'); await expect(service.approve(second.id, second.approvalHash, 'second-approve')).rejects.toMatchObject({ code: 'concurrency_reached' });
    const run = service.status().runs[0]; await service.cancel(run.id, 'cancel');
    await vi.waitFor(() => expect(service.status().runs[0].status).toBe('cancelled'), { timeout: 5000 });
    expect(await readFile(join(run.worktreePath!, 'source.ts'), 'utf8')).toContain('value = 1');
    expect(service.status().runs).toHaveLength(1);
    const report = store.snapshot().state.handoffs[0];
    expect(report?.details).toMatchObject({ outcome: 'cancelled', taskId: first.id, runId: run.id, contextVersionUsed: null });
    expect(report?.status).toBe('saved'); expect(service.status().tasks[0].status).toBe('cancelled');
    expect(store.snapshot().state.workflow!.manager.queueReportIds).toContain(report.id);
  });
  it('retains uncertain charges, enforces the service request limit, and never auto-retries', async () => {
    const { service, store, executor, draft } = await setup();
    executor.execute = vi.fn(async input => { input.onRequestStart(100, 500); throw new Error(`network ${key}`); });
    await service.createDraft({ ...draft, maxTurns: 1 }, 'draft'); const task = service.status().tasks[0]; await service.approve(task.id, task.approvalHash, 'approve');
    await vi.waitFor(() => expect(service.status().runs[0].status).toBe('failed'), { timeout: 5000 });
    expect(store.snapshot().state.workflow!.reservations[0].status).toBe('uncertain');
    expect(executor.execute).toHaveBeenCalledOnce(); expect(JSON.stringify(store.snapshot())).not.toContain(key);
    const reports = store.snapshot().state.handoffs;
    expect(reports).toHaveLength(1);
    expect(reports[0].details).toMatchObject({ outcome: 'failed', taskId: task.id, runId: service.status().runs[0].id, contextVersionUsed: null,
      checks: [{ result: 'unavailable', evidence: 'unavailable', reference: null }] });
    expect(reports[0].status).toBe('saved'); expect(store.snapshot().state.workflow!.manager.queueReportIds).toContain(reports[0].id);
  });
  it('marks unfinished persisted work interrupted at boot and blocks oversized context or secret-bearing tasks', async () => {
    const { service, store, draft, create } = await setup(); const task = await create();
    store.commit('interrupted-fixture', state => { state.runner!.runs.push({ id: 'prior-run', taskId: task.id, tool: draft.tool, mode: draft.mode, model: draft.model, price: draft.price, connectionId: draft.connectionId, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, worktreePath: null, branch: null, contextVersion: 1, contextDelivery: 'pending', providerRequests: 0, usage: null, message: null, changedFiles: [], reportId: null }); return 'fixture'; });
    service.recoverInterrupted(); expect(service.status().runs[0].status).toBe('interrupted');
    const recovered = store.snapshot().state.handoffs[0];
    expect(recovered.details).toMatchObject({ outcome: 'interrupted', taskId: task.id, runId: 'prior-run', files: { status: 'unavailable', paths: [] } });
    service.recoverInterrupted(); expect(store.snapshot().state.handoffs).toHaveLength(1);
    await expect(service.createDraft({ ...draft, objective: `Write ${key}` }, 'secret')).rejects.toMatchObject({ code: 'draft_contains_credential' });
    store.commit('long-context', state => { state.manager.brief = 'a'.repeat(12001); return 'fixture'; });
    await expect(service.createDraft(draft, 'long')).rejects.toMatchObject({ code: 'context_too_large' });
  });
  it('enforces the approved request count in the service even if an executor asks again', async () => {
    const { service, store, executor, draft } = await setup();
    executor.execute = vi.fn(async input => { const id = input.onRequestStart(100, 500); input.onRequestComplete(id, usage); input.onRequestStart(100, 500); throw new Error('Unreachable'); });
    await service.createDraft({ ...draft, maxTurns: 1 }, 'draft'); const task = service.status().tasks[0]; await service.approve(task.id, task.approvalHash, 'approve');
    await vi.waitFor(() => expect(service.status().runs[0].status).toBe('failed'), { timeout: 5000 });
    expect(store.snapshot().state.workflow!.reservations).toHaveLength(1);
    expect(service.status().runs[0].message).toContain('request count');
  });
  it('refuses an altered worktree Git pointer before running the final unsandboxed file inventory', async () => {
    const { service, executor, repo, create } = await setup();
    executor.execute = vi.fn(async input => { const marker = await open(join(input.worktree, '.git'), 'r+'); try { await marker.truncate(0); await marker.writeFile(`gitdir: ${join(repo, '.git')}\n`); } finally { await marker.close(); } return { outcome: 'review' as const, summary: 'Fixture modified its pointer.', usage: null, providerRequests: 0 }; });
    const task = await create(); await service.approve(task.id, task.approvalHash, 'approve');
    await vi.waitFor(() => expect(service.status().runs[0].status).toBe('awaiting_review'), { timeout: 5000 });
    expect(service.status().runs[0].changedFilesUnavailable).toBe(true);
    expect(service.status().runs[0].changedFiles).toEqual([]);
    expect(await readFile(join(repo, 'source.ts'), 'utf8')).toContain('value = 1');
  });
  it('verifies subscription login through its isolated native flow and never changes the first default on disconnect', async () => {
    const { service, executor, store } = await setup();
    let listener: (method: string, data: unknown) => void = () => undefined;
    const rpc = rpcFixture();
    rpc.subscribe = vi.fn(value => { listener = value; return () => undefined; });
    rpc.request = vi.fn(async method => method === 'account/login/start' ? { type: 'chatgptDeviceCode', loginId: 'login-fixture', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'FIXTURE-CODE' } : method === 'account/read' ? { account: { type: 'chatgpt', email: 'fixture@example.test', planType: 'plus' } } : method === 'model/list' ? { data: [{ model: 'fixture-model' }] } : {});
    executor.subscription = vi.fn(async () => rpc);
    const [login, duplicateLogin] = await Promise.all([service.connectSubscription('Subscription fixture', 'login'), service.connectSubscription('Subscription fixture', 'login')]);
    expect(duplicateLogin).toEqual(login); expect(executor.subscription).toHaveBeenCalledOnce();
    const pending = await service.subscriptionStatus(login.connectionId);
    expect(pending.status).toBe('pending');
    expect(pending.prompt).toMatchObject({ connectionId: login.connectionId, verificationUrl: login.verificationUrl, userCode: login.userCode, expiresAt: login.expiresAt });
    expect(Date.parse(login.expiresAt)).toBeGreaterThan(Date.now());
    expect(JSON.stringify(store.snapshot())).not.toContain('FIXTURE-CODE');
    expect((await service.subscriptionStatus(login.connectionId)).prompt).toEqual(pending.prompt);
    listener('account/login/completed', { loginId: 'login-fixture', success: true });
    expect(await service.subscriptionStatus(login.connectionId)).toEqual({ status: 'verified', message: null });
    expect(service.status().subscriptionDefault).toBe(login.connectionId);
    expect(JSON.stringify(service.status())).not.toContain('FIXTURE-CODE');
    await service.disconnectSubscription(login.connectionId, 'disconnect');
    expect(service.status().subscriptions[0].status).toBe('disconnected');
    expect((await service.subscriptionStatus(login.connectionId)).prompt).toBeUndefined();
    expect(service.status().subscriptionDefault).toBe(login.connectionId);
    expect(rpc.request).toHaveBeenCalledWith('account/logout', {});
    expect(JSON.stringify(vi.mocked(rpc.request).mock.calls)).not.toContain(key);
  });
  it('ends subscription sign-in when its native process closes and ignores late completion', async () => {
    const { service, executor } = await setup();
    let listener: (method: string, data: unknown) => void = () => undefined;
    const rpc = rpcFixture(); rpc.subscribe = vi.fn(value => { listener = value; return () => undefined; });
    rpc.request = vi.fn(async () => ({ type: 'chatgptDeviceCode', loginId: 'login', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'FIXTURE-CODE' }));
    executor.subscription = vi.fn(async () => rpc);
    const login = await service.connectSubscription('Fixture', 'process-closed');
    listener('agent-town/transport-closed', {});
    listener('account/login/completed', { loginId: 'login', success: true });
    expect(await service.subscriptionStatus(login.connectionId)).toEqual({ status: 'failed', message: 'The connection attempt ended. Start a new attempt.' });
    expect(service.status().subscriptions[0]).toMatchObject({ status: 'failed', models: [], accountFingerprint: null });
    expect(service.status().subscriptionDefault).toBeNull();
    expect((await service.subscriptionStatus(login.connectionId)).prompt).toBeUndefined();
    expect(rpc.request).not.toHaveBeenCalledWith('account/read', expect.anything());
    expect(rpc.request).not.toHaveBeenCalledWith('model/list', expect.anything());
    expect(rpc.close).toHaveBeenCalledOnce();
  });
  it('closes failed subscription attempts and rejects untrusted verification URLs without saving a connection', async () => {
    const { service, executor } = await setup();
    let listener: (method: string, data: unknown) => void = () => undefined;
    const rpc = rpcFixture(); rpc.subscribe = vi.fn(value => { listener = value; return () => undefined; });
    rpc.request = vi.fn(async () => ({ type: 'chatgptDeviceCode', loginId: 'login', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'CODE' })); executor.subscription = vi.fn(async () => rpc);
    const login = await service.connectSubscription('Fixture', 'failed'); listener('account/login/completed', { loginId: 'login', success: false });
    expect((await service.subscriptionStatus(login.connectionId)).status).toBe('failed'); expect(rpc.close).toHaveBeenCalled();
    expect(service.status().subscriptions[0].status).toBe('failed');
    rpc.request = vi.fn(async () => ({ type: 'chatgptDeviceCode', loginId: 'bad', verificationUrl: 'https://evil.example/device', userCode: 'CODE' }));
    await expect(service.connectSubscription('Other fixture', 'bad-url')).rejects.toMatchObject({ code: 'login_url_invalid' });
    expect(service.status().subscriptions).toHaveLength(1);
  });
});

function rpcFixture(): RpcTransport {
  return { request: vi.fn(async () => ({ exitCode: 0, stdout: 'tool result', stderr: '' })), notify: vi.fn(), subscribe: vi.fn(() => () => undefined), close: vi.fn() };
}
function inputFixture(draft: CreateRunDraft, worktree: string, provider: 'openai' | 'anthropic' = 'openai'): ExecutionInput {
  draft = { ...draft, model: provider === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'gpt-5.4-mini-2026-03-17', price: draft.price ? { ...draft.price, model: provider === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'gpt-5.4-mini-2026-03-17' } : null };
  return { runId: 'run-fixture', worktree, draft, contextVersion: 1, contextBrief: 'Preserve tests.', connection: { id: 'fixture', provider, mode: 'api', label: 'fixture', status: 'verified', createdAt: '', verifiedAt: '', accountIdentity: 'unavailable', models: ['fixture-model'], capabilities: { manager: true, managedExecution: true } }, apiKey: key, accountFingerprint: null, signal: new AbortController().signal, onContextDelivered: vi.fn(), onRequestStart: vi.fn(() => 'reservation'), onRequestComplete: vi.fn(), onRequestRejected: vi.fn() };
}
describe('bounded provider and sandbox boundaries', () => {
  it('reserves before OpenAI inference, caps output, uses only official endpoints, and holds unknown usage', async () => {
    const { draft, repo } = await setup(), input = inputFixture(draft, repo), rpc = rpcFixture();
    const request = vi.fn<typeof fetch>(async (url, init) => { if (String(url).endsWith('input_tokens')) return Response.json({ input_tokens: 100 }); expect(input.onRequestStart).toHaveBeenCalledWith(100, 500); const body = JSON.parse(String(init!.body)); expect(body.max_output_tokens).toBe(500); expect(body.store).toBe(false); expect(init!.redirect).toBe('error'); return Response.json({ model: input.draft.model, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: `Done ${key}` }] }], usage: null }); });
    await expect(new BoundedOpenAIWorker(request).execute(input, rpc)).rejects.toMatchObject({ code: 'worker_usage_uncertain' });
    expect(input.onRequestComplete).toHaveBeenCalledWith('reservation', null);
    expect(request.mock.calls.every(([url]) => String(url).startsWith('https://api.openai.com/v1/'))).toBe(true);
    expect(rpc.request).not.toHaveBeenCalled();
  });
  it('bounds Anthropic messages, normalizes actual token categories, and reports completion without accepting a task', async () => {
    const { draft, repo } = await setup(), input = inputFixture({ ...draft, tool: 'anthropic-api' }, repo, 'anthropic');
    const request = vi.fn<typeof fetch>(async (url, init) => { if (String(url).endsWith('count_tokens')) return Response.json({ input_tokens: 100 }); expect(input.onRequestStart).toHaveBeenCalledOnce(); const body = JSON.parse(String(init!.body)); expect(body.max_tokens).toBe(500); expect(body.service_tier).toBe('standard_only'); return Response.json({ model: input.draft.model, stop_reason: 'end_turn', content: [{ type: 'text', text: `Report ${key}` }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } }); });
    const result = await new BoundedAnthropicWorker(request).execute(input, rpcFixture());
    expect(result.outcome).toBe('review'); expect(result.usage?.inputTokens).toBe(115); expect(result.summary).not.toContain(key);
    expect(input.onContextDelivered).toHaveBeenCalledOnce();
  });
  it('releases known rejected requests and does not retry network-uncertain requests', async () => {
    const { draft, repo } = await setup();
    for (const status of [401, 503]) {
      const input = inputFixture(draft, repo), request = vi.fn<typeof fetch>(async url => String(url).endsWith('input_tokens') ? Response.json({ input_tokens: 100 }) : new Response('', { status }));
      await expect(new BoundedOpenAIWorker(request).execute(input, rpcFixture())).rejects.toBeDefined();
      expect(request).toHaveBeenCalledTimes(2);
      if (status === 401) expect(input.onRequestRejected).toHaveBeenCalledWith('reservation'); else expect(input.onRequestComplete).toHaveBeenCalledWith('reservation', null);
    }
  });
  it('denies traversal, credentials and junction escape; uses sandboxed command/exec and preserves source text', async () => {
    const { draft, repo, directory } = await setup();
    const source = await prepareSourceTree(repo, join(directory, 'source-boundary'), 'run-fixture');
    await expect(checkedWorktreeFile(repo, '../outside.ts')).rejects.toMatchObject({ code: 'file_path_denied' });
    await expect(checkedWorktreeFile(repo, '.env')).rejects.toMatchObject({ code: 'file_path_denied' });
    const outside = join(directory, 'outside'); await mkdir(outside); await writeFile(join(outside, 'file.ts'), 'private');
    await symlink(outside, join(repo, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(checkedWorktreeFile(repo, 'linked/file.ts')).rejects.toBeDefined();
    const input = inputFixture(draft, source.path), rpc = rpcFixture(), content = 'const url = "https://example.test/?page=1";';
    await executeWorkerTool('write_file', { path: 'source.ts', content }, input, rpc);
    expect(rpc.request).toHaveBeenCalledWith('command/exec', expect.objectContaining({ command: expect.arrayContaining([content]), sandboxPolicy: expect.objectContaining({ networkAccess: false }) }), 35000);
    expect(JSON.stringify(vi.mocked(rpc.request).mock.calls)).not.toContain('process/');
    vi.mocked(rpc.request).mockClear(); await executeWorkerTool('write_file', { path: 'source.ts', content: key }, input, rpc); expect(rpc.request).not.toHaveBeenCalled();
    releaseSourceTree(source);
  });
  it('never inherits ambient provider credentials and keeps native Claude blocked without an every-request broker', async () => {
    const { directory } = await setup();
    expect(minimalEnvironment()).not.toHaveProperty('OPENAI_API_KEY'); expect(minimalEnvironment()).not.toHaveProperty('ANTHROPIC_API_KEY'); expect(minimalEnvironment()).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    const result = await new NativeRunExecutor(join(directory, 'native')).preflight('claude');
    expect(result.ready).toBe(false); expect(result.checks.find(value => value.name === 'SDK budget enforcement')?.passed).toBe(false);
  });
});
