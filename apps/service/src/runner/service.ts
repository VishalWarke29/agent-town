import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { allocateAgentHome, RETAINED_AGENT_LIMIT, type TownState, type Snapshot } from '@agent-town/contracts';
import { createRunDraftSchema, type CreateRunDraft, type RunnerState, type RunnerPreflight, type RunTool, type RunnerTask, type SubscriptionLoginStatus } from '../../../../packages/contracts/src/runner.js';
import type { WorkflowConnection } from '../../../../packages/contracts/src/workflow.js';
import type { CredentialVault } from '../identity/index.js';
import type { Store } from '../store.js';
import { WorkflowError, workflowState, reserveOperation, settleReservation, markReservationUncertain, releaseReservation, maximumRequestCost, providerCredentialReference, sanitizeModelText, taskIntentFingerprint, buildWorkerContext } from '../workflow/index.js';
import { NativeRunExecutor, accountFingerprint } from './native.js';
import { createManagedWorktree, validatedRepository, changedWorktreeFiles, inspectWorktreeEvidence, verifyIntegratedSource, sourceFingerprint, commitContains, requireCurrentSourceFingerprint } from './worktrees.js';
import type { ExecutionResult, RunExecutor } from './types.js';
import type { RpcTransport } from './rpc.js';
import { saveManagedRunReport } from '../workflow/reports.js';

type Commit = { duplicate: boolean; snapshot: Snapshot };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const active = (status: string) => status === 'starting' || status === 'running';
export function runnerState(state: TownState): RunnerState {
  if (state.workspace.mode !== 'private') throw new WorkflowError('private_workspace_required', 'Managed execution requires a private workspace.', 403);
  return state.runner ??= { schemaVersion: 1, tasks: [], runs: [], subscriptions: [], subscriptionDefault: null };
}
interface Login { rpc: RpcTransport; loginId: string; verificationUrl: string; userCode: string; completed: boolean; failed: boolean; expiresAt: number; timer: ReturnType<typeof setTimeout> }
type LoginPrompt = { connectionId: string; loginId: string; verificationUrl: string; userCode: string; expiresAt: string };
export class RunnerService {
  private readonly store: Store;
  private readonly vault: CredentialVault;
  private readonly executor: RunExecutor;
  private readonly directory: string;
  private readonly now: () => number;
  private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly logins = new Map<string, Login>();
  private readonly connectionAttempts = new Map<string, { label: string; promise: Promise<LoginPrompt> }>();
  private stopping = false;
  constructor(options: { store: Store; vault: CredentialVault; dataDirectory: string; executor?: RunExecutor; now?: () => number }) {
    this.store = options.store; this.vault = options.vault;
    const workspaceId = options.store.snapshot().state.workspace.id;
    if (!/^[A-Za-z0-9-]{1,100}$/.test(workspaceId)) throw new WorkflowError('workspace_path_invalid', 'The private workspace identifier is invalid.');
    this.directory = join(options.dataDirectory, 'managed', workspaceId);
    this.executor = options.executor ?? new NativeRunExecutor(this.directory); this.now = options.now ?? Date.now;
  }
  status(): RunnerState { return runnerState(this.store.snapshot().state); }
  async preflight(tool: RunTool, repoId?: string): Promise<RunnerPreflight> {
    const checked = await this.executor.preflight(tool);
    checked.checkedAt = new Date(this.now()).toISOString();
    if (repoId) {
      const state = this.store.snapshot().state;
      try { const repo = state.repositories.find(value => value.id === repoId); if (!repo) throw new Error(); await validatedRepository(repo, state.discovery?.roots ?? []); checked.checks.push({ name: 'Selected repository', passed: true, message: 'The selected local repository and its Git metadata are available.' }); }
      catch { checked.checks.push({ name: 'Selected repository', passed: false, message: 'Select and re-scan a supported local Git repository.' }); }
      checked.ready = checked.checks.every(value => value.passed);
    }
    return checked;
  }
  private connection(state: TownState, draft: CreateRunDraft): WorkflowConnection | null {
    if (draft.mode === 'subscription') {
      if (draft.tool !== 'codex' || !draft.acknowledgeSubscriptionLimits || draft.price !== null || draft.budgetMicroUsd !== 0 || draft.maxTurns !== 1) throw new WorkflowError('subscription_limits_required', 'Codex subscription requires acknowledgment of one outer turn, the deadline, and native allowance limits. It has no dollar ceiling.');
      const connection = runnerState(state).subscriptions.find(value => value.id === draft.connectionId);
      if (connection?.status !== 'verified' || !connection.accountFingerprint || !connection.models.includes(draft.model)) throw new WorkflowError('connection_unavailable', 'The selected Codex subscription or model is unavailable. No fallback will be used.');
      return null;
    }
    if (draft.tool === 'codex') throw new WorkflowError('native_codex_api_limits_unsupported', 'Native Codex API execution cannot enforce these request/output limits. Choose the separate OpenAI API worker.');
    if (!draft.price || draft.price.model !== draft.model || draft.budgetMicroUsd <= 0) throw new WorkflowError('run_price_required', 'Select an explicit API model, reviewed prices, and a positive run allowance.');
    const connection = workflowState(state).connections.find(value => value.id === draft.connectionId);
    if (connection?.status !== 'verified' || connection.mode !== 'api' || connection.provider !== (draft.tool === 'claude' || draft.tool === 'anthropic-api' ? 'anthropic' : 'openai') || !connection.models.includes(draft.model)) throw new WorkflowError('connection_unavailable', 'The selected API account or model is unavailable. No fallback will be used.');
    return connection;
  }
  async createDraft(raw: CreateRunDraft, sourceId: string): Promise<Commit> {
    if (this.stopping) throw new WorkflowError('service_stopping', 'The runner is stopping.');
    const draft = createRunDraftSchema.parse(raw), state = this.store.snapshot().state;
    if (/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/.test(JSON.stringify(draft))) throw new WorkflowError('draft_contains_credential', 'Remove credentials from the task and use a protected connection instead.', 400);
    if (state.manager.brief.length > 12000) throw new WorkflowError('context_too_large', 'The manager brief exceeds this worker context limit. Review and shorten the brief before drafting.');
    this.executor.validateDraft?.(draft);
    this.connection(state, draft);
    const existingId = `task-${hash(sourceId).slice(0, 32)}`;
    const existing = runnerState(state).tasks.find(value => value.id === existingId);
    if (existing) return this.store.commit(sourceId, () => 'runner.draft-created', JSON.stringify(draft));
    const repo = state.repositories.find(value => value.id === draft.repoId);
    if (!repo) throw new WorkflowError('repository_not_found', 'Select a local repository first.', 404);
    const validated = await validatedRepository(repo, state.discovery?.roots ?? []);
    return this.store.commit(sourceId, (current, now) => {
      this.connection(current, draft);
      const runner = runnerState(current);
      const proposal = draft.sourceProposalId ? workflowState(current).manager.proposals.find(value => value.id === draft.sourceProposalId && value.repoId === draft.repoId) : undefined;
      if (draft.sourceProposalId && !proposal) throw new WorkflowError('proposal_unavailable', 'The source proposal is unavailable for this repository. Review the draft source.');
      const previous = draft.revisionOf ? runner.tasks.find(value => value.id === draft.revisionOf) : undefined;
      if (draft.revisionOf && (!previous || ['approved', 'running', 'awaiting_review'].includes(previous.status))) throw new WorkflowError('revision_unavailable', 'Stop or review the earlier attempt before preparing a revision.');
      for (const dependencyId of draft.dependencyTaskIds) {
        if (dependencyId === existingId || !runner.tasks.some(value => value.id === dependencyId)) throw new WorkflowError('dependency_missing', 'Choose an existing task in this workspace as the prerequisite.');
      }
      if (runner.tasks.length >= 1000) throw new WorkflowError('runner_capacity', 'The task history is full. Apply a reviewed retention policy first.');
      if (current.manager.brief.length > 12000) throw new WorkflowError('context_too_large', 'The manager brief exceeds this worker context limit.');
      const task: RunnerTask = { id: existingId, draft, baseCommit: validated.head, contextVersion: current.manager.version, contextBrief: buildWorkerContext(current, draft), approvalHash: '', status: 'draft', createdAt: now, approvedAt: null, runId: null };
      if (proposal && 'sourceContextVersion' in proposal && typeof proposal.sourceContextVersion === 'number') task.sourceContextVersion = proposal.sourceContextVersion;
      // Draft revisions supersede only an unstarted draft; completed attempts stay immutable.
      if (previous?.status === 'draft') previous.archivedAt = now;
      task.approvalHash = hash({ draft, baseCommit: task.baseCommit, contextVersion: task.contextVersion, contextBrief: task.contextBrief, account: draft.mode === 'subscription' ? runner.subscriptions.find(value => value.id === draft.connectionId)?.accountFingerprint : draft.connectionId });
      runner.tasks.push(task);
      return 'runner.draft-created';
    }, JSON.stringify(draft));
  }
  async approve(taskId: string, approvalHash: string, sourceId: string): Promise<Commit> {
    if (this.stopping) throw new WorkflowError('service_stopping', 'The runner is stopping.');
    const state = this.store.snapshot().state, task = runnerState(state).tasks.find(value => value.id === taskId);
    if (!task) throw new WorkflowError('task_not_found', 'Task not found.', 404);
    if (task.archivedAt) throw new WorkflowError('task_archived', 'This draft is archived. Prepare a new revision before approval.');
    const fingerprint = JSON.stringify({ taskId, approvalHash });
    if (task.status !== 'draft') return this.store.commit(sourceId, () => { throw new WorkflowError('task_not_draft', 'This task has already left draft state. Create a new draft for another run.'); }, fingerprint);
    if (task.approvalHash !== approvalHash) throw new WorkflowError('approval_changed', 'Approve the exact current draft. Its scope or limits changed.');
    const repo = state.repositories.find(value => value.id === task.draft.repoId);
    if (!repo) throw new WorkflowError('repository_not_found', 'The selected repository is unavailable.');
    const validated = await validatedRepository(repo, state.discovery?.roots ?? []);
    if (validated.head !== task.baseCommit) throw new WorkflowError('repository_changed', 'The repository commit changed. Create and review a new draft.');
    for (const id of task.draft.dependencyTaskIds ?? []) {
      const dependency = runnerState(state).tasks.find(value => value.id === id);
      if (dependency?.integration) {
        const dependencyRepo = state.repositories.find(value => value.id === dependency.draft.repoId);
        if (!dependencyRepo) throw new WorkflowError('integration_unavailable', 'Reconnect the prerequisite repository to verify its integration.');
        const checkout = dependencyRepo.id === repo.id ? validated : await validatedRepository(dependencyRepo, state.discovery?.roots ?? []);
        if (!await commitContains(checkout.path, dependency.integration.commit, checkout.head, state.discovery?.roots ?? [])) throw new WorkflowError('integration_changed', 'A prerequisite repository no longer includes its verified integration commit. Review integration and prepare a new draft.');
      }
    }
    const preflight = await this.preflight(task.draft.tool, repo.id);
    if (!preflight.ready) throw new WorkflowError('runner_preflight_failed', preflight.checks.filter(value => !value.passed).map(value => value.message).join(' '), 503);
    const runId = `run-${randomUUID()}`;
    const committed = this.store.commit(sourceId, (current, now) => {
      const runner = runnerState(current), currentTask = runner.tasks.find(value => value.id === taskId)!;
      if (currentTask.archivedAt || currentTask.status !== 'draft' || currentTask.approvalHash !== approvalHash) throw new WorkflowError('approval_changed', 'The task changed while the startup checks ran.');
      this.executor.validateDraft?.(currentTask.draft);
      this.connection(current, currentTask.draft);
      if (current.manager.version !== currentTask.contextVersion) throw new WorkflowError('context_changed', 'The manager context changed. Create a new draft to review the latest context.');
      const policy = workflowState(current).policy;
      if (runner.runs.filter(value => active(value.status)).length >= policy.workerConcurrency) throw new WorkflowError('concurrency_reached', 'Another managed run is active. The limit covers the whole run, including time between requests.');
      if (current.agents.length >= RETAINED_AGENT_LIMIT) throw new WorkflowError('agent_capacity', 'This workspace has reached its retained agent limit. Review session history before starting more work.');
      allocateAgentHome(currentTask.draft.repoId, current.repositories, current.agents);
      for (const dependencyId of currentTask.draft.dependencyTaskIds ?? []) {
        const dependency = runner.tasks.find(value => value.id === dependencyId);
        if (dependency?.status !== 'accepted') throw new WorkflowError('dependency_waiting', 'Review and accept every prerequisite result before starting this task.');
        const priorRun = runner.runs.find(value => value.id === dependency.runId);
        if ((!priorRun || priorRun.changedFilesUnavailable || priorRun.changedFiles.length > 0) && !dependency.integration) throw new WorkflowError('integration_required', 'Verify each prerequisite’s committed changes before starting dependent work. Accepting a report does not integrate its code.');
        if (dependency.integration && (!priorRun || priorRun.changedFilesUnavailable || priorRun.changedFiles.length > 0)) requireCurrentSourceFingerprint(priorRun?.sourceFingerprint);
      }
      if ((currentTask.draft.dependencyTaskIds?.length ?? 0) > 0 && buildWorkerContext(current, currentTask.draft) !== currentTask.contextBrief) throw new WorkflowError('context_changed', 'Prerequisite evidence changed after this draft was saved. Create and review a fresh draft with the accepted results.');
      const intent = taskIntentFingerprint(currentTask.draft);
      if (runner.tasks.some(value => value.id !== taskId && ['approved', 'running', 'awaiting_review'].includes(value.status) && taskIntentFingerprint(value.draft) === intent)) throw new WorkflowError('duplicate_task', 'Matching work is already running or waiting for review. Review that result before paying for another attempt.');
      if (runner.runs.some(value => active(value.status) && runner.tasks.find(candidate => candidate.id === value.taskId)?.draft.repoId === currentTask.draft.repoId)) throw new WorkflowError('repository_active', 'Another managed task is using this repository. Wait for it to finish before starting another. Independent repositories can use the available worker slots.');
      if (task.draft.mode === 'api' && (!policy.paidEnabled || task.draft.budgetMicroUsd > policy.maxRunBudgetMicroUsd)) throw new WorkflowError('paid_work_disabled', 'Enable paid work and an adequate workspace run allowance before approval.');
      // Validate every pricing/budget gate before creating any paid process. This
      // throwaway copy does not consume money; each real request reserves below.
      if (task.draft.price) reserveOperation(structuredClone(current), { id: `probe-${runId}`, runId, purpose: 'worker', connectionId: task.draft.connectionId, model: task.draft.price, amountMicroUsd: maximumRequestCost(task.draft.price, 1, task.draft.maxOutputTokens), runBudgetMicroUsd: task.draft.budgetMicroUsd }, now);
      currentTask.status = 'approved'; currentTask.approvedAt = now; currentTask.runId = runId;
      runner.runs.push({ id: runId, taskId, tool: task.draft.tool, connectionId: task.draft.connectionId, mode: task.draft.mode, model: task.draft.model, price: task.draft.price, status: 'starting', startedAt: now, finishedAt: null, worktreePath: null, branch: null, contextVersion: task.contextVersion, contextDelivery: 'pending', providerRequests: 0, usage: null, message: 'Preparing the isolated worktree.', changedFiles: [], reportId: null });
      return 'runner.approved';
    }, fingerprint);
    if (!committed.duplicate) {
      const controller = new AbortController();
      const done = this.executeRun(runId, controller).catch(() => { /* A durable active run is recovered as interrupted on the next startup if its final save fails. */ }).finally(() => this.running.delete(runId));
      this.running.set(runId, { controller, done });
    }
    return committed;
  }
  private async executeRun(runId: string, controller: AbortController): Promise<void> {
    const task = this.status().tasks.find(value => value.runId === runId)!;
    let apiKey: string | null = null, result: ExecutionResult | null = null, path: string | null = null;
    const timer = setTimeout(() => controller.abort(), task.draft.maxMinutes * 60000); timer.unref();
    try {
      const state = this.store.snapshot().state, repo = state.repositories.find(value => value.id === task.draft.repoId)!;
      const validated = await validatedRepository(repo, state.discovery?.roots ?? []);
      if (validated.head !== task.baseCommit) throw new WorkflowError('repository_changed', 'The repository changed before worktree creation. Create a new draft.');
      const worktree = await createManagedWorktree(validated.path, task.baseCommit, this.directory, runId, state.discovery?.roots ?? []); path = worktree.path;
      if (controller.signal.aborted) throw new WorkflowError('run_cancelled', 'The run was cancelled during startup.');
      const connection = this.connection(this.store.snapshot().state, task.draft);
      if (connection) { apiKey = await this.vault.get(providerCredentialReference(state.workspace.id, connection.id)); if (!apiKey) throw new WorkflowError('credential_unavailable', 'The selected protected credential is unavailable.'); }
      this.store.commit(`${runId}:started`, (current, now) => {
        const runner = runnerState(current), run = runner.runs.find(value => value.id === runId)!;
        this.connection(current, task.draft);
        run.status = 'running'; run.worktreePath = worktree.path; run.branch = worktree.branch; run.message = 'Executing the approved task.'; if (run.mode === 'subscription') run.providerRequests = null;
        runner.tasks.find(value => value.id === task.id)!.status = 'running';
        current.agents.push({ id: runId, name: task.draft.tool === 'openai-api' ? 'OpenAI API worker' : task.draft.tool === 'anthropic-api' ? 'Anthropic API worker' : task.draft.tool === 'claude' ? 'Claude worker' : 'Codex worker', provider: task.draft.tool === 'claude' || task.draft.tool === 'anthropic-api' ? 'Claude' : 'Codex', role: 'Managed worker', repoId: repo.id, task: task.draft.objective, activity: 'working', color: repo.color, home: allocateAgentHome(repo.id, current.repositories, current.agents), updatedAt: now, files: [], evidence: 'Approved managed run started in an isolated worktree. Context acknowledgment is pending.', contextVersion: null });
        return 'runner.started';
      });
      let requestNumber = 0;
      result = await this.executor.execute({ runId, worktree: worktree.path, draft: task.draft, contextVersion: task.contextVersion, contextBrief: task.contextBrief, connection, apiKey, accountFingerprint: this.status().subscriptions.find(value => value.id === task.draft.connectionId)?.accountFingerprint ?? null, signal: controller.signal,
        onContextDelivered: () => { this.store.commit(`${runId}:context`, current => { const run = runnerState(current).runs.find(value => value.id === runId)!; run.contextDelivery = 'provider-acknowledged'; const agent = current.agents.find(value => value.id === runId); if (agent) { agent.contextVersion = task.contextVersion; agent.evidence = 'The execution adapter acknowledged the approved context at its native request boundary.'; } return 'runner.context-delivered'; }); },
        onRequestStart: (inputTokens, outputTokens) => {
          if (controller.signal.aborted || !task.draft.price) throw new WorkflowError('run_cancelled', 'The run cannot start another paid request.');
          if (requestNumber >= task.draft.maxTurns) throw new WorkflowError('worker_request_limit', 'The approved provider request count has been reached.');
          const id = `${runId}:request-${++requestNumber}`;
          this.store.commit(`${id}:reserve`, (current, now) => { this.connection(current, task.draft); reserveOperation(current, { id, runId, purpose: 'worker', connectionId: task.draft.connectionId, model: task.draft.price!, amountMicroUsd: maximumRequestCost(task.draft.price!, inputTokens, outputTokens), runBudgetMicroUsd: task.draft.budgetMicroUsd }, now); runnerState(current).runs.find(value => value.id === runId)!.providerRequests = requestNumber; return 'runner.budget-reserved'; });
          return id;
        },
        onRequestComplete: (id, usage) => { try { this.store.commit(`${id}:settle`, (current, now) => { settleReservation(current, id, usage, now); return usage ? 'runner.usage-settled' : 'runner.usage-uncertain'; }); } catch (error) { this.store.commit(`${id}:invalid-usage`, (current, now) => { markReservationUncertain(current, id, now); return 'runner.usage-uncertain'; }); throw error; } },
        onRequestRejected: id => { this.store.commit(`${id}:rejected`, (current, now) => { releaseReservation(current, id, now, 'provider-rejected'); return 'runner.request-rejected'; }); },
      });
    } catch (error) {
      result = { outcome: controller.signal.aborted ? 'cancelled' : 'failed', summary: error instanceof WorkflowError ? error.message : 'The worker stopped unexpectedly. Review the retained worktree and usage before another assignment.', usage: null, providerRequests: task.draft.mode === 'subscription' ? null : this.status().runs.find(value => value.id === runId)?.providerRequests ?? 0 };
    } finally {
      clearTimeout(timer);
      let files: string[] = [], changedFilesUnavailable = false, completedSourceFingerprint: string | null = null;
      if (path) try {
        const state = this.store.snapshot().state; const repo = state.repositories.find(value => value.id === task.draft.repoId); if (!repo?.localPath) throw new Error();
        files = await changedWorktreeFiles(path, repo.localPath, state.discovery?.roots ?? [], task.baseCommit);
        try { completedSourceFingerprint = await sourceFingerprint(path, repo.localPath, state.discovery?.roots ?? [], task.baseCommit); } catch { /* Unverifiable completion evidence cannot authorize integration. */ }
      } catch { changedFilesUnavailable = true; }
      const finished = result ?? { outcome: 'failed' as const, summary: 'The worker stopped without a final result.', usage: null, providerRequests: 0 };
      this.store.commit(`${runId}:finished`, (current, now) => {
        const runner = runnerState(current), run = runner.runs.find(value => value.id === runId)!;
        for (const reservation of workflowState(current).reservations.filter(value => value.runId === runId && value.status === 'reserved')) markReservationUncertain(current, reservation.id, now);
        run.status = this.stopping ? 'interrupted' : finished.outcome === 'review' ? 'awaiting_review' : finished.outcome;
        run.finishedAt = now; run.worktreePath ??= path; run.changedFiles = files; run.changedFilesUnavailable = changedFilesUnavailable; run.usage = finished.usage; run.providerRequests = finished.providerRequests;
        run.sourceFingerprint = completedSourceFingerprint;
        run.message = sanitizeModelText(finished.summary, apiKey ? [apiKey] : []).slice(0, 8000);
        runner.tasks.find(value => value.id === task.id)!.status = run.status;
        const agent = current.agents.find(value => value.id === runId);
        if (agent) { agent.activity = run.status === 'awaiting_review' ? 'reporting' : run.status === 'interrupted' ? 'offline' : run.status; agent.updatedAt = now; agent.files = files; agent.evidence = changedFilesUnavailable ? 'The worktree was retained; its changed-file inventory is unavailable.' : 'The worker ended. Its saved result is separate from manager processing and human acceptance.'; }
        saveManagedRunReport(current, run, task, now, `${runId}:finished`, !!path && !changedFilesUnavailable);
        return 'runner.finished';
      });
      apiKey = null;
    }
  }
  async cancel(runId: string, sourceId: string): Promise<Commit> {
    const committed = this.store.commit(sourceId, current => { const run = runnerState(current).runs.find(value => value.id === runId); if (!run) throw new WorkflowError('run_not_found', 'Run not found.', 404); if (!active(run.status)) throw new WorkflowError('run_not_active', 'This run has already stopped.'); run.message = 'Cancellation requested. Waiting for the supervised worker to stop.'; return 'runner.cancel-requested'; }, JSON.stringify({ runId }));
    this.running.get(runId)?.controller.abort();
    return committed;
  }
  archive(taskId: string, sourceId: string): Commit {
    return this.store.commit(sourceId, (current, now) => {
      const task = runnerState(current).tasks.find(value => value.id === taskId);
      if (!task) throw new WorkflowError('task_not_found', 'Task not found.', 404);
      if (['approved', 'running', 'awaiting_review'].includes(task.status)) throw new WorkflowError('task_in_use', 'Stop or review the task before archiving it.');
      task.archivedAt ??= now;
      return 'runner.task-archived';
    }, JSON.stringify({ taskId }));
  }
  async evidence(taskId: string, file: string) {
    const state = this.store.snapshot().state, task = runnerState(state).tasks.find(value => value.id === taskId);
    const run = task && runnerState(state).runs.find(value => value.id === task.runId);
    const repo = task && state.repositories.find(value => value.id === task.draft.repoId);
    if (!task || !run?.worktreePath || active(run.status) || !repo?.localPath) throw new WorkflowError('evidence_unavailable', 'Finish the run and retain its connected repository before inspecting source changes.');
    const checked = await validatedRepository(repo, state.discovery?.roots ?? []);
    return inspectWorktreeEvidence(run.worktreePath, checked.path, state.discovery?.roots ?? [], task.baseCommit, file);
  }
  async verifyIntegration(taskId: string, sourceId: string): Promise<Commit> {
    const state = this.store.snapshot().state, task = runnerState(state).tasks.find(value => value.id === taskId);
    const run = task && runnerState(state).runs.find(value => value.id === task.runId);
    const repo = task && state.repositories.find(value => value.id === task.draft.repoId);
    if (!task || task.status !== 'accepted' || !run?.worktreePath || !run.sourceFingerprint || run.changedFilesUnavailable || !repo) throw new WorkflowError('integration_unavailable', 'Accept a reviewed result with complete source evidence before verifying its integration.');
    requireCurrentSourceFingerprint(run.sourceFingerprint);
    const checked = await validatedRepository(repo, state.discovery?.roots ?? []);
    if (await sourceFingerprint(run.worktreePath, checked.path, state.discovery?.roots ?? [], task.baseCommit) !== run.sourceFingerprint) throw new WorkflowError('worktree_changed', 'The retained worktree changed after the worker finished. Its original source evidence no longer matches. Review a separate attempt; no integration was recorded.');
    const files = await verifyIntegratedSource(run.worktreePath, checked.path, state.discovery?.roots ?? [], task.baseCommit, checked.head);
    if ((await validatedRepository(repo, state.discovery?.roots ?? [])).head !== checked.head) throw new WorkflowError('repository_changed', 'The repository changed during integration verification. Check it again.');
    if (await sourceFingerprint(run.worktreePath, checked.path, state.discovery?.roots ?? [], task.baseCommit) !== run.sourceFingerprint) throw new WorkflowError('worktree_changed', 'The retained worktree changed during integration verification. No integration was recorded.');
    return this.store.commit(sourceId, (current, now) => {
      const saved = runnerState(current).tasks.find(value => value.id === taskId);
      if (saved?.status !== 'accepted' || saved.runId !== run.id) throw new WorkflowError('task_changed', 'The reviewed task changed during verification.');
      saved.integration = { commit: checked.head, files, verifiedAt: now };
      return 'runner.integration-verified';
    }, JSON.stringify({ taskId }));
  }
  review(taskId: string, decision: 'accepted' | 'changes_requested', sourceId: string): Commit {
    decision = z.enum(['accepted', 'changes_requested']).parse(decision);
    return this.store.commit(sourceId, current => { const task = runnerState(current).tasks.find(value => value.id === taskId); if (!task || task.status !== 'awaiting_review') throw new WorkflowError('review_unavailable', 'Only a completed task awaiting human review can be reviewed.'); task.status = decision; const agent = current.agents.find(value => value.id === task.runId); if (agent) agent.activity = decision === 'accepted' ? 'idle' : 'waiting'; return 'runner.reviewed'; }, JSON.stringify({ taskId, decision }));
  }
  async connectSubscription(label: string, sourceId: string): Promise<LoginPrompt> {
    label = z.string().trim().min(1).max(80).parse(label);
    const existing = this.connectionAttempts.get(sourceId);
    if (existing) { if (existing.label !== label) throw new WorkflowError('connection_action_conflict', 'This action identifier belongs to another connection label.'); return existing.promise; }
    if (this.connectionAttempts.size + this.logins.size >= 3) throw new WorkflowError('subscription_capacity', 'Finish pending sign-ins before creating another connection.');
    const promise = this.startSubscription(label, sourceId).finally(() => this.connectionAttempts.delete(sourceId));
    this.connectionAttempts.set(sourceId, { label, promise });
    return promise;
  }
  private async startSubscription(label: string, sourceId: string): Promise<LoginPrompt> {
    if (this.stopping) throw new WorkflowError('service_stopping', 'The runner is stopping.');
    label = z.string().trim().min(1).max(80).parse(label);
    const connectionId = `codex-${hash(sourceId).slice(0, 32)}`;
    const existing = this.logins.get(connectionId);
    if (existing) { this.store.commit(sourceId, () => 'runner.subscription-pending', JSON.stringify({ label })); return { connectionId, loginId: existing.loginId, verificationUrl: existing.verificationUrl, userCode: existing.userCode, expiresAt: new Date(existing.expiresAt).toISOString() }; }
    if (this.status().subscriptions.some(value => value.id === connectionId)) throw new WorkflowError('subscription_attempt_ended', 'Start a new connection attempt. This attempt has already ended.');
    if (this.logins.size >= 3 || this.status().subscriptions.length >= 50) throw new WorkflowError('subscription_capacity', 'Finish pending sign-ins before creating another connection.');
    const rpc = await this.executor.subscription(join(this.directory, 'codex', connectionId));
    try {
      if (this.stopping) throw new WorkflowError('service_stopping', 'The runner stopped during connection startup.');
      const login = z.object({ type: z.literal('chatgptDeviceCode'), loginId: z.string().min(1).max(200), verificationUrl: z.string().url(), userCode: z.string().min(1).max(80) }).parse(await rpc.request('account/login/start', { type: 'chatgptDeviceCode' }));
      const url = new URL(login.verificationUrl);
      if (url.origin !== 'https://auth.openai.com' || url.username || url.password) throw new WorkflowError('login_url_invalid', 'Codex returned an unexpected login address.');
      const timer = setTimeout(() => { void this.expireLogin(connectionId).catch(() => undefined); }, 10 * 60000); timer.unref();
      const pending: Login = { rpc, ...login, completed: false, failed: false, expiresAt: this.now() + 10 * 60000, timer };
      rpc.subscribe((method, raw) => {
        if (pending.failed) return;
        if (method === 'agent-town/transport-closed') { pending.completed = false; pending.failed = true; return; }
        if (method === 'account/login/completed') {
          const parsed = z.object({ loginId: z.string(), success: z.boolean() }).safeParse(raw);
          if (parsed.success && parsed.data.loginId === login.loginId) { pending.completed = parsed.data.success; pending.failed = !parsed.data.success; }
        }
      });
      this.store.commit(sourceId, (current, now) => { const runner = runnerState(current); if (runner.subscriptions.length >= 50) throw new WorkflowError('subscription_capacity', 'The subscription connection history is full.'); runner.subscriptions.push({ id: connectionId, label: sanitizeModelText(label), status: 'pending', createdAt: now, accountLabel: null, accountFingerprint: null, models: [] }); return 'runner.subscription-pending'; }, JSON.stringify({ label }));
      this.logins.set(connectionId, pending);
      return { connectionId, loginId: login.loginId, verificationUrl: login.verificationUrl, userCode: login.userCode, expiresAt: new Date(pending.expiresAt).toISOString() };
    } catch (error) { await rpc.close(); throw error; }
  }
  async subscriptionStatus(connectionId: string): Promise<SubscriptionLoginStatus> {
    const connection = this.status().subscriptions.find(value => value.id === connectionId);
    if (!connection) throw new WorkflowError('connection_not_found', 'Subscription connection not found.', 404);
    if (connection.status === 'verified') return { status: 'verified', message: null };
    if (connection.status === 'disconnected') return { status: 'disconnected', message: 'This connection was disconnected. Start a new sign-in to connect again.' };
    const login = this.logins.get(connectionId);
    if (!login || login.failed || this.now() >= login.expiresAt) { if (login) await this.expireLogin(connectionId); return { status: 'failed', message: 'The connection attempt ended. Start a new attempt.' }; }
    if (!login.completed) return { status: 'pending', message: 'Complete sign-in in the official Codex device flow.', prompt: { connectionId, verificationUrl: login.verificationUrl, userCode: login.userCode, expiresAt: new Date(login.expiresAt).toISOString() } };
    const parsed = z.object({ account: z.object({ type: z.literal('chatgpt'), email: z.string().nullable(), planType: z.string() }) }).parse(await login.rpc.request('account/read', { refreshToken: false }));
    const models = z.object({ data: z.array(z.object({ model: z.string() })).max(1000) }).parse(await login.rpc.request('model/list', {}));
    this.store.commit(`${connectionId}:verified`, current => { const runner = runnerState(current), saved = runner.subscriptions.find(value => value.id === connectionId)!; if (saved.status !== 'pending') throw new WorkflowError('connection_changed', 'The connection changed during sign-in.'); saved.status = 'verified'; saved.accountLabel = sanitizeModelText(parsed.account.email ?? parsed.account.planType).slice(0, 120); saved.accountFingerprint = accountFingerprint(parsed.account); saved.models = models.data.map(value => value.model); runner.subscriptionDefault ??= connectionId; return 'runner.subscription-verified'; });
    clearTimeout(login.timer); this.logins.delete(connectionId); await login.rpc.close();
    return { status: 'verified', message: null };
  }
  setSubscriptionDefault(connectionId: string, sourceId: string): Commit {
    return this.store.commit(sourceId, current => { const runner = runnerState(current); if (runner.subscriptions.find(value => value.id === connectionId)?.status !== 'verified') throw new WorkflowError('connection_unavailable', 'Select a verified subscription connection.'); runner.subscriptionDefault = connectionId; return 'runner.subscription-default'; }, JSON.stringify({ connectionId }));
  }
  async disconnectSubscription(connectionId: string, sourceId: string): Promise<Commit> {
    const result = this.store.commit(sourceId, current => { const runner = runnerState(current); if (runner.runs.some(value => value.connectionId === connectionId && active(value.status))) throw new WorkflowError('connection_in_use', 'Cancel the active run and wait for it to stop before disconnecting.'); const connection = runner.subscriptions.find(value => value.id === connectionId); if (!connection) throw new WorkflowError('connection_not_found', 'Connection not found.', 404); connection.status = 'disconnected'; return 'runner.subscription-disconnected'; }, JSON.stringify({ connectionId }));
    const pending = this.logins.get(connectionId); if (pending) clearTimeout(pending.timer); this.logins.delete(connectionId);
    const rpc = pending?.rpc ?? await this.executor.subscription(join(this.directory, 'codex', connectionId));
    try { if (pending) await rpc.request('account/login/cancel', { loginId: pending.loginId }); await rpc.request('account/logout', {}); } finally { await rpc.close(); }
    return result;
  }
  recoverInterrupted(): void {
    const state = this.status();
    if (!state.runs.some(value => active(value.status)) && !state.subscriptions.some(value => value.status === 'pending')) return;
    this.store.commit(`runner-recovery-${randomUUID()}`, (current, now) => { const runner = runnerState(current); for (const run of runner.runs.filter(value => active(value.status))) { run.status = 'interrupted'; run.finishedAt = now; run.message = 'The service stopped during execution. Work was retained; reconcile unknown usage before a new assignment.'; const task = runner.tasks.find(value => value.id === run.taskId); if (task) task.status = 'interrupted'; const agent = current.agents.find(value => value.id === run.id); if (agent) agent.activity = 'offline'; for (const reservation of workflowState(current).reservations.filter(value => value.runId === run.id && value.status === 'reserved')) markReservationUncertain(current, reservation.id, now); saveManagedRunReport(current, run, task, now, `${run.id}:interrupted-recovery`, false); } for (const connection of runner.subscriptions.filter(value => value.status === 'pending')) connection.status = 'failed'; return 'runner.recovered'; });
  }
  private async expireLogin(connectionId: string): Promise<void> {
    const login = this.logins.get(connectionId); if (!login) return;
    clearTimeout(login.timer); this.logins.delete(connectionId);
    try { this.store.commit(`${connectionId}:expired`, current => { const connection = runnerState(current).subscriptions.find(value => value.id === connectionId); if (connection?.status === 'pending') connection.status = 'failed'; return 'runner.subscription-expired'; }); }
    finally { await login.rpc.request('account/login/cancel', { loginId: login.loginId }).catch(() => undefined); await login.rpc.close(); }
  }
  async close(): Promise<void> { this.stopping = true; for (const value of this.running.values()) value.controller.abort(); await Promise.allSettled([...this.running.values()].map(value => value.done)); await Promise.allSettled([...this.connectionAttempts.values()].map(value => value.promise)); for (const value of this.logins.values()) clearTimeout(value.timer); await Promise.allSettled([...this.logins.values()].map(value => value.rpc.close())); this.logins.clear(); }
}
