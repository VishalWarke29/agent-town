import { createHash, randomUUID } from 'node:crypto';
import { apiConnectionSchema, economyPolicySchema, managerConfigSchema, managerResultSchema, memoryActionSchema, reconcileUsageSchema, type ApiConnectionInput, type EconomyPolicy, type ManagerConfig, type WorkflowState, type WorkflowUsage, type ManagerJob, type ManagerQueueStatus } from '../../../../packages/contracts/src/workflow.js';
import { IdentityError, type CredentialVault } from '../identity/index.js';
import type { Store } from '../store.js';
import { WorkflowError, initialWorkflow, workflowState, queueManagerReports, maximumRequestCost, reserveOperation, settleReservation, markReservationUncertain, releaseReservation, estimatedCost } from './budget.js';
import { OfficialWorkflowProvider, ProviderRequestError, sanitizeModelText, type WorkflowProvider, type ManagerRequest, type ManagerResponse } from './provider.js';
import { buildManagerInput, uniqueReports } from './context.js';
import { taskIntentFingerprint, unfinishedTask } from './coordination.js';
import { applyMemoryAction, contextMemory, mergeManagerBlockers } from './memory.js';
import { managerQueueStatus, queueBasis } from './queue.js';

type Commit = ReturnType<Store['commit']>;
export interface WorkflowOptions { store: Store; vault: CredentialVault; provider?: WorkflowProvider; now?: () => number }
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const providerCredentialReference = (workspaceId: string, connectionId: string): string => {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(workspaceId) || !/^[A-Za-z0-9_-]{1,60}$/.test(connectionId)) throw new WorkflowError('credential_scope_invalid', 'Invalid workspace or connection scope.', 400);
  return `provider-${workspaceId}-${connectionId}`;
};

export class WorkflowService {
  private readonly store: Store;
  private readonly vault: CredentialVault;
  private readonly provider: WorkflowProvider;
  private readonly now: () => number;
  private readonly abort = new AbortController();
  private readonly connecting = new Set<string>();
  private processing = false;
  constructor(options: WorkflowOptions) { this.store = options.store; this.vault = options.vault; this.provider = options.provider ?? new OfficialWorkflowProvider(); this.now = options.now ?? Date.now; }
  private time(): string { return new Date(this.now()).toISOString(); }
  private checkOpen(): void { if (this.abort.signal.aborted) throw new WorkflowError('workflow_stopped', 'The workflow service is stopping.'); }
  state(): WorkflowState { return structuredClone(this.store.snapshot().state.workflow ?? initialWorkflow()); }
  queueStatus(): ManagerQueueStatus { return managerQueueStatus(this.store.snapshot().state, this.time()); }
  private persistQueueStatus(status: ManagerQueueStatus): void {
    const previous = this.store.snapshot().state.workflow?.manager.waitingStatus;
    if (previous && JSON.stringify({ ...previous, checkedAt: '' }) === JSON.stringify({ ...status, checkedAt: '' })) return;
    this.store.commit(`manager-wait:${randomUUID()}`, state => { workflowState(state).manager.waitingStatus = status; return 'manager.queue-status'; });
  }
  refreshQueueStatus(): ManagerQueueStatus { const status = this.queueStatus(); this.persistQueueStatus(status); return status; }
  updateMemory(raw: unknown, sourceId: string): Commit {
    const parsed = memoryActionSchema.safeParse(raw);
    if (!parsed.success) throw new WorkflowError('memory_action_invalid', 'Review the memory action, expected context version and source evidence.', 400);
    return this.store.commit(sourceId, (state, now) => applyMemoryAction(state, parsed.data, sourceId, now), fingerprint(parsed.data));
  }
  contextHistory() {
    const state = this.store.snapshot().state, manager = workflowState(state).manager;
    return { versions: manager.versions.map(version => ({ ...version, ...contextMemory(version) })), proposals: manager.proposals,
      deliveries: (state.runner?.runs ?? []).map(run => ({ runId: run.id, taskId: run.taskId, approvedContextVersion: run.contextVersion,
        status: run.contextDelivery, boundary: 'initial-request' as const,
        contextBrief: state.runner?.tasks.find(task => task.id === run.taskId)?.contextBrief ?? null,
        newerContextDelivery: 'unsupported' as const })) };
  }

  async connectApi(raw: ApiConnectionInput, sourceId: string): Promise<Commit> {
    this.checkOpen();
    const parsed = apiConnectionSchema.safeParse(raw);
    if (!parsed.success) throw new WorkflowError('connection_invalid', 'Enter a supported provider, account label, and API key.', 400);
    const input = parsed.data;
    if (input.provider === 'anthropic' && (input.organizationId || input.projectId)) throw new WorkflowError('connection_scope_invalid', 'OpenAI organization and project IDs do not apply to Anthropic.', 400);
    const state = this.store.snapshot().state;
    const workflow = workflowState(state);
    const id = `conn-${fingerprint(sourceId).slice(0, 32)}`;
    const hash = fingerprint({ action: 'connection.add', input });
    if (workflow.connections.some(connection => connection.id === id)) return this.store.commit(sourceId, () => 'connection.verified', hash);
    if (workflow.connections.length >= 30 || this.connecting.size >= 4) throw new WorkflowError('connection_capacity', 'The local provider connection limit has been reached.');
    if (this.connecting.has(id)) throw new WorkflowError('connection_pending', 'This connection is already being verified.');
    if (!this.vault.available) throw new WorkflowError('vault_unavailable', 'Protected Windows credential storage is required.', 503);
    this.connecting.add(id);
    const reference = providerCredentialReference(state.workspace.id, id);
    let saveAttempted = false;
    try {
      const verified = await this.provider.verify(input, this.abort.signal);
      this.checkOpen();
      saveAttempted = true;
      await this.vault.put(reference, input.apiKey);
      this.checkOpen();
      const result = this.store.commit(sourceId, current => {
        const value = workflowState(current);
        if (value.connections.length >= 30) throw new WorkflowError('connection_capacity', 'The local provider connection limit has been reached.');
        const now = this.time();
        value.connections.push({ id, provider: input.provider, mode: 'api', label: sanitizeModelText(input.label, [input.apiKey]), status: 'verified', createdAt: now, verifiedAt: now,
          accountIdentity: 'unavailable', ...(input.organizationId ? { organizationId: input.organizationId } : {}), ...(input.projectId ? { projectId: input.projectId } : {}),
          models: verified.models, capabilities: { manager: true, managedExecution: false } });
        value.defaults[`${input.provider}:api`] ??= id;
        return 'connection.verified';
      }, hash);
      saveAttempted = false;
      return result;
    } catch (error) {
      // A vault can fail after writing. Remove the incomplete reference and
      // retain its safe storage error, without publishing a verified account.
      if (saveAttempted) await this.vault.delete(reference).catch(() => undefined);
      if (error instanceof WorkflowError || (saveAttempted && error instanceof IdentityError)) throw error;
      throw new WorkflowError('connection_failed', 'The provider connection could not be verified and saved.', 502);
    } finally { this.connecting.delete(id); }
  }

  async disconnect(connectionId: string, sourceId: string): Promise<Commit> {
    this.checkOpen();
    const result = this.store.commit(sourceId, state => {
      const value = workflowState(state);
      const connection = value.connections.find(item => item.id === connectionId);
      if (!connection) throw new WorkflowError('connection_not_found', 'Provider connection not found.', 404);
      if (value.reservations.some(item => item.connectionId === connectionId && item.status === 'reserved')) throw new WorkflowError('connection_in_use', 'Stop the active operation before disconnecting its billing connection.');
      connection.status = 'disconnected';
      if (value.manager.config.connectionId === connectionId) value.manager.config.enabled = false;
      // Retain the original default: removing it never switches which account pays.
      return 'connection.disconnected';
    }, fingerprint({ action: 'disconnect', connectionId }));
    await this.vault.delete(providerCredentialReference(result.snapshot.state.workspace.id, connectionId));
    return result;
  }

  setDefault(connectionId: string, sourceId: string): Commit {
    return this.store.commit(sourceId, state => {
      const value = workflowState(state);
      const connection = value.connections.find(item => item.id === connectionId && item.status === 'verified');
      if (!connection) throw new WorkflowError('connection_unavailable', 'Choose a verified connection explicitly.');
      value.defaults[`${connection.provider}:${connection.mode}`] = connection.id;
      return 'connection.default.changed';
    }, fingerprint({ action: 'default', connectionId }));
  }

  configurePolicy(raw: EconomyPolicy, sourceId: string): Commit {
    const parsed = economyPolicySchema.safeParse(raw);
    if (!parsed.success) throw new WorkflowError('policy_invalid', 'Use finite daily/run limits, a manager allowance within the daily limit, and one or two workers.', 400);
    return this.store.commit(sourceId, state => {
      const value = workflowState(state);
      if (value.reservations.length && value.policy.timeZone !== parsed.data.timeZone) throw new WorkflowError('timezone_locked', 'The billing timezone cannot change after usage has been recorded.');
      value.policy = parsed.data;
      if (!value.policy.paidEnabled) value.manager.config.enabled = false;
      return 'workflow.policy.changed';
    }, fingerprint({ action: 'policy', input: parsed.data }));
  }

  configureManager(raw: ManagerConfig, sourceId: string): Commit {
    const parsed = managerConfigSchema.safeParse(raw);
    if (!parsed.success) throw new WorkflowError('manager_config_invalid', 'Review the manager connection, model, price record, and bounded limits.', 400);
    return this.store.commit(sourceId, state => {
      const workflow = workflowState(state);
      const input = parsed.data;
      const disableOnly = !input.enabled && JSON.stringify({ ...input, enabled: false }) === JSON.stringify({ ...workflow.manager.config, enabled: false });
      if (workflow.manager.jobs.some(job => job.status === 'running') && !disableOnly) throw new WorkflowError('manager_running', 'Wait for the current manager operation before changing its configuration. You can disable future summaries immediately.');
      if (input.enabled) {
        if (!input.connectionId || !input.model) throw new WorkflowError('manager_account_required', 'Choose a manager connection and model first.');
        if (!workflow.policy.paidEnabled || workflow.policy.managerDailyBudgetMicroUsd <= 0) throw new WorkflowError('manager_budget_required', 'Enable paid work and set a manager allowance first.');
        if (input.maxInputTokens > Math.min(32_000, Math.floor(input.model.contextWindowTokens * 0.25)) || input.maxInputTokens + input.maxOutputTokens > input.model.contextWindowTokens) throw new WorkflowError('manager_context_limit', 'Manager input must fit within one quarter of the model context window.');
        // Validate all scheduling gates on a disposable copy. No reservation is saved.
        const copy = structuredClone(state);
        reserveOperation(copy, { id: 'configuration-check', runId: 'configuration-check', purpose: 'manager', connectionId: input.connectionId, model: input.model,
          amountMicroUsd: maximumRequestCost(input.model, input.maxInputTokens, input.maxOutputTokens), runBudgetMicroUsd: input.requestBudgetMicroUsd }, this.time());
      }
      workflow.manager.config = input;
      queueManagerReports(state);
      return 'manager.configured';
    }, fingerprint({ action: 'manager.config', input: parsed.data }));
  }

  recoverInterrupted(): void {
    const saved = this.store.snapshot().state;
    if (saved.workspace.mode !== 'private') return;
    const running = saved.workflow?.manager.jobs.filter(job => job.status === 'running') ?? [];
    const queued = saved.handoffs.filter(report => report.status === 'saved').map(report => report.id);
    if (!running.length && !queued.length) return;
    this.store.commit(`workflow-recovery-${randomUUID()}`, state => {
      const workflow = workflowState(state);
      for (const job of workflow.manager.jobs.filter(item => item.status === 'running')) {
        job.status = 'uncertain'; job.message = 'The service stopped during this request. Reconcile the provider outcome before retrying.';
        markReservationUncertain(state, job.reservationId, this.time());
      }
      queueManagerReports(state);
      return 'manager.recovered';
    });
  }

  reconcile(reservationId: string, raw: WorkflowUsage, sourceId: string): Commit {
    const parsed = reconcileUsageSchema.safeParse(raw);
    if (!parsed.success) throw new WorkflowError('reconciliation_invalid', 'Provide the verified usage categories and mark them as user-reconciled.', 400);
    return this.store.commit(sourceId, state => {
      const value = workflowState(state);
      const reservation = value.reservations.find(item => item.id === reservationId);
      if (!reservation || reservation.status !== 'uncertain') throw new WorkflowError('reconciliation_not_pending', 'This operation is not awaiting usage reconciliation.');
      settleReservation(state, reservationId, parsed.data, this.time());
      const job = value.manager.jobs.find(item => item.reservationId === reservationId && item.status === 'uncertain');
      if (job) { job.status = 'failed'; job.completedAt = this.time(); job.message = 'Usage was reconciled manually. The last valid brief is preserved; another attempt needs explicit approval.'; }
      queueManagerReports(state);
      return 'usage.reconciled';
    }, fingerprint({ action: 'reconcile', reservationId, usage: parsed.data }));
  }

  async processManager(sourceId: string, options: { automatic?: boolean } = {}): Promise<Commit> {
    this.checkOpen();
    if (this.processing) throw new WorkflowError('manager_running', 'The manager already has an operation in progress.');
    this.processing = true;
    let job: ManagerJob | undefined;
    let response: ManagerResponse | undefined;
    let requestStarted = false;
    try {
      const initial = this.store.snapshot().state;
      const workflow = workflowState(initial);
      const config = structuredClone(workflow.manager.config);
      const id = `manager-${fingerprint(sourceId).slice(0, 32)}`;
      const existing = workflow.manager.jobs.find(value => value.id === id);
      if (existing) return { duplicate: true, snapshot: this.store.snapshot() };
      if (!config.enabled || !workflow.policy.paidEnabled || !config.connectionId || !config.model) throw new WorkflowError('manager_disabled', 'Enable the manager with its connection, model, and allowance first.');
      const waiting = workflow.manager.waitingStatus;
      if (options.automatic && waiting?.basisHash && ['manager_input_large', 'credential_unavailable', 'model_capability_unverified'].includes(waiting.code)
        && waiting.basisHash === queueBasis(initial, this.time())) throw new WorkflowError(waiting.code, waiting.message);
      if (workflow.manager.jobs.some(value => value.status === 'running' || value.status === 'uncertain')) throw new WorkflowError('manager_reconciliation_required', 'Wait for the active request or reconcile its uncertain outcome.');
      if (workflow.reservations.some(value => value.purpose === 'manager' && value.status !== 'settled')) throw new WorkflowError('manager_reconciliation_required', 'The previous manager request still holds a budget reservation. Reconcile its usage first.');
      if (workflow.manager.jobs.length >= 1000 || workflow.manager.versions.length >= 1000) throw new WorkflowError('manager_capacity', 'The local manager history is full. Apply a reviewed retention policy before more processing.');
      const failedReports = new Set(workflow.manager.jobs.filter(value => value.status === 'failed').flatMap(value => value.reportIds));
      queueManagerReports(initial);
      const candidates = uniqueReports(initial.handoffs.filter(report => workflow.manager.queueReportIds.includes(report.id) && (!options.automatic || !failedReports.has(report.id)))).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      if (!candidates.length) throw new WorkflowError('manager_no_reports', 'There are no eligible saved reports to process.');
      if (options.automatic && this.now() - Date.parse(candidates[0].createdAt) < 30_000) throw new WorkflowError('manager_batch_waiting', 'Reports are saved while the 30-second batch window is open.');
      const starts = workflow.manager.automaticStarts.filter(value => this.now() - Date.parse(value) < 3_600_000);
      if (options.automatic && starts.length >= 6) throw new WorkflowError('manager_hourly_limit', 'Six automatic manager batches have run this hour. Reports remain saved.');
      const connection = workflow.connections.find(value => value.id === config.connectionId && value.status === 'verified');
      if (!connection) throw new WorkflowError('connection_unavailable', 'The selected manager connection is unavailable. No fallback is allowed.');
      const key = await this.vault.get(providerCredentialReference(initial.workspace.id, connection.id));
      if (!key) throw new WorkflowError('credential_unavailable', 'Reconnect the selected provider before paid work.');
      this.checkOpen();
      const previous = workflow.manager.versions.at(-1);
      const selected: typeof candidates = [];
      const makeInput = () => buildManagerInput(initial, selected, [key]);
      for (const report of candidates.slice(0, 20)) {
        if (!initial.repositories.some(repo => repo.id === report.repoId)) throw new WorkflowError('report_repository_missing', 'A saved report references an unavailable repository. Review it before processing.');
        selected.push(report);
        if (makeInput().evidence.inputBytes > 100_000) { selected.pop(); break; }
      }
      if (!selected.length) throw new WorkflowError('manager_input_large', 'The saved brief or report exceeds the input bound. Review it before processing.');
      let bundle = makeInput();
      let request: ManagerRequest = { model: config.model.model, input: bundle.input, maxOutputTokens: config.maxOutputTokens };
      let inputTokens = 0;
      let amount = 0;
      // At most five non-inference counts: 20 → 10 → 5 → 2 → 1.
      // Preserve queue order and full report bodies; budget checks still run atomically below.
      while (true) {
        inputTokens = await this.provider.countInput(connection, key, request, this.abort.signal);
        if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) throw new WorkflowError('manager_input_large', 'The provider could not establish the manager input bound. No inference was started.');
        let limitError: WorkflowError | undefined;
        if (inputTokens > config.maxInputTokens) limitError = new WorkflowError('manager_input_large', 'One report and the existing brief exceed the manager context allowance. No inference was started.');
        else {
          amount = maximumRequestCost(config.model, inputTokens, config.maxOutputTokens);
          try {
            reserveOperation(structuredClone(initial), { id, runId: id, purpose: 'manager', connectionId: connection.id, model: config.model,
              amountMicroUsd: amount, runBudgetMicroUsd: config.requestBudgetMicroUsd }, this.time());
          } catch (error) {
            if (!(error instanceof WorkflowError) || !['run_budget_reached', 'daily_budget_reached', 'manager_budget_reached'].includes(error.code)) throw error;
            limitError = error;
          }
        }
        if (!limitError) break;
        if (selected.length === 1) throw limitError;
        selected.splice(Math.max(1, Math.floor(selected.length / 2)));
        bundle = makeInput();
        request = { ...request, input: bundle.input };
      }
      this.checkOpen();
      const reportIds = selected.map(report => report.id);
      const startedAt = this.time();
      const saved = this.store.commit(`manager-start-${id}`, current => {
        const value = workflowState(current);
        if (JSON.stringify(value.manager.config) !== JSON.stringify(config) || current.manager.version !== initial.manager.version) throw new WorkflowError('manager_configuration_changed', 'Manager configuration or context changed. Review and retry.');
        if (selected.some(report => !current.handoffs.some(savedReport => savedReport.id === report.id && savedReport.status === 'saved' && fingerprint(savedReport) === fingerprint(report)))) throw new WorkflowError('manager_reports_changed', 'The selected reports changed before processing.');
        reserveOperation(current, { id, runId: id, purpose: 'manager', connectionId: connection.id, model: config.model!, amountMicroUsd: amount, runBudgetMicroUsd: config.requestBudgetMicroUsd }, startedAt);
        job = { id, reportIds, connectionId: connection.id, model: config.model!.model, reservationId: id, status: 'running', automatic: !!options.automatic, startedAt, completedAt: null, message: null,
          contextEvidence: { ...bundle.evidence, inputTokens } };
        value.manager.jobs.push(job);
        value.manager.automaticStarts = starts;
        if (options.automatic) value.manager.automaticStarts.push(startedAt);
        queueManagerReports(current);
        return 'manager.processing';
      }, fingerprint({ config, reportIds }));
      if (saved.duplicate) return saved;
      this.checkOpen();
      requestStarted = true;
      response = await this.provider.summarize(connection, key, request, this.abort.signal);
      // Preserve provider routing as an observation. A different returned model
      // cannot be silently priced using the original model's record.
      if (response.observedModel && response.observedModel !== config.model.model) response.usage = null;
      if (response.usage) { try { estimatedCost(config.model, response.usage); } catch { response.usage = null; } }
      let parsed: unknown;
      try { parsed = JSON.parse(response.text) as unknown; } catch { throw new WorkflowError('manager_result_invalid', 'The manager returned invalid structured output. The previous brief is preserved.'); }
      const result = managerResultSchema.safeParse(parsed);
      if (!result.success || !response.complete) throw new WorkflowError('manager_result_invalid', 'The manager result was incomplete or invalid. The previous brief is preserved.');
      const returnedIds = result.data.processedReportIds;
      if (new Set(returnedIds).size !== reportIds.length || returnedIds.length !== reportIds.length || returnedIds.some(value => !reportIds.includes(value))) throw new WorkflowError('manager_reports_invalid', 'The manager result did not account for the selected reports.');
      const affectedRepos = new Set(selected.map(report => report.repoId));
      if (result.data.repoBriefs.length !== affectedRepos.size || new Set(result.data.repoBriefs.map(repo => repo.repoId)).size !== affectedRepos.size || result.data.repoBriefs.some(repo => !affectedRepos.has(repo.repoId)) || result.data.proposals.some(proposal => !affectedRepos.has(proposal.repoId))) throw new WorkflowError('manager_scope_invalid', 'The manager result referenced unexpected repositories.');
      const memory = mergeManagerBlockers(previous, result.data.blockers, reportIds, initial.manager.version + 1, this.time(), [key]);
      return this.store.commit(`manager-finish-${id}`, current => {
        const value = workflowState(current);
        const currentJob = value.manager.jobs.find(item => item.id === id)!;
        if (currentJob.status !== 'running' || current.manager.version !== initial.manager.version) throw new WorkflowError('manager_context_changed', 'Context changed while the manager was working. Review the result manually.');
        settleReservation(current, id, response!.usage, this.time());
        currentJob.providerRequestId = response!.requestId; currentJob.observedModel = response!.observedModel ?? null;
        const version = current.manager.version + 1;
        const overview = sanitizeModelText(result.data.overview, [key]);
        const repoBriefs = new Map(previous?.repoBriefs.map(repo => [repo.repoId, repo]) ?? []);
        for (const repo of result.data.repoBriefs) repoBriefs.set(repo.repoId, { repoId: repo.repoId, brief: sanitizeModelText(repo.brief, [key]) });
        value.manager.versions.push({ version, previousVersion: current.manager.version, reportIds, overview, repoBriefs: [...repoBriefs.values()], blockers: memory.blockerRecords.filter(blocker => blocker.status === 'open').map(blocker => blocker.text), createdAt: this.time(), origin: 'manager', ...memory });
        current.manager = { version, brief: overview, updatedAt: this.time() };
        for (const report of current.handoffs.filter(item => reportIds.includes(item.id))) { report.status = 'processed'; report.contextVersion = version; }
        const proposedIntents = new Set(value.manager.proposals.map(proposal => taskIntentFingerprint({ repoId: proposal.repoId, objective: proposal.title, acceptanceCriteria: proposal.acceptanceCriteria })));
        for (const task of current.runner?.tasks.filter(unfinishedTask) ?? []) proposedIntents.add(taskIntentFingerprint(task.draft));
        currentJob.duplicateProposalsSkipped = 0;
        for (const proposal of result.data.proposals) {
          const title = sanitizeModelText(proposal.title, [key]);
          const acceptanceCriteria = proposal.acceptanceCriteria.map(item => sanitizeModelText(item, [key]));
          const intent = taskIntentFingerprint({ repoId: proposal.repoId, objective: title, acceptanceCriteria });
          if (proposedIntents.has(intent)) { currentJob.duplicateProposalsSkipped++; continue; }
          proposedIntents.add(intent);
          value.manager.proposals.push({ id: randomUUID(), sourceJobId: id, sourceContextVersion: version, repoId: proposal.repoId, title, acceptanceCriteria, status: 'proposed', createdAt: this.time() });
        }
        currentJob.status = 'processed'; currentJob.completedAt = this.time();
        currentJob.message = response!.usage ? null : 'The brief is saved, but provider usage is unavailable. The budget reservation remains held.';
        queueManagerReports(current);
        return 'manager.processed';
      });
    } catch (error) {
      if (job) {
        const uncertain = requestStarted && !response && (!(error instanceof ProviderRequestError) || error.outcome === 'uncertain');
        this.store.commit(`manager-failed-${job.id}`, state => {
          const currentJob = workflowState(state).manager.jobs.find(value => value.id === job!.id)!;
          if (currentJob.status !== 'running') return 'manager.failure.already-recorded';
          if (uncertain || (response && !response.usage)) markReservationUncertain(state, job!.reservationId, this.time());
          else if (response?.usage) settleReservation(state, job!.reservationId, response.usage, this.time());
          else releaseReservation(state, job!.reservationId, this.time(), requestStarted ? 'provider-rejected' : 'not-sent');
          currentJob.status = uncertain ? 'uncertain' : 'failed'; currentJob.completedAt = this.time();
          currentJob.providerRequestId = response?.requestId ?? null; currentJob.observedModel = response?.observedModel ?? null;
          currentJob.message = uncertain ? 'The provider outcome is unknown. Reconcile before retrying.' : 'The manager request failed validation or was rejected. The previous brief remains current.';
          queueManagerReports(state);
          return uncertain ? 'manager.uncertain' : 'manager.failed';
        });
      }
      else {
        const state = this.store.snapshot().state;
        const pending = state.handoffs.filter(report => report.status === 'saved');
        if (pending.length) {
          const status = managerQueueStatus(state, this.time());
          const code = error instanceof WorkflowError ? error.code : 'manager_dispatch_failed';
          const persistent = ['manager_input_large', 'credential_unavailable', 'model_capability_unverified', 'token_count_unavailable', 'provider_rejected', 'provider_unavailable', 'run_budget_reached', 'daily_budget_reached', 'manager_budget_reached', 'manager_dispatch_failed'].includes(code);
          this.persistQueueStatus({ ...status, state: 'waiting', code,
            message: error instanceof WorkflowError ? error.message : 'The pre-dispatch check failed. No inference was started; review the connection before retrying.',
            basisHash: persistent ? queueBasis(state, this.time()) : undefined,
          });
        }
      }
      if (error instanceof WorkflowError) throw error;
      throw new WorkflowError('manager_failed', 'The manager could not complete this operation. Inspect its saved status before retrying.', 502);
    } finally { this.processing = false; }
  }

  close(): void { this.abort.abort(); }
}
