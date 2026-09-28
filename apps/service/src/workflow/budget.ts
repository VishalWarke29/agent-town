import type { Handoff, TownState } from '@agent-town/contracts';
import { economyPolicySchema, workflowModelSchema, type WorkflowState, type WorkflowModel, type BudgetReservation, type WorkflowUsage, type ManagerExclusionReason } from '../../../../packages/contracts/src/workflow.js';

export class WorkflowError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 409) { super(message); this.name = 'WorkflowError'; }
}

export function initialWorkflow(): WorkflowState {
  return {
    schemaVersion: 1, connections: [], defaults: {}, reservations: [],
    policy: { paidEnabled: false, dailyBudgetMicroUsd: 0, managerDailyBudgetMicroUsd: 0, maxRunBudgetMicroUsd: 0, workerConcurrency: 1, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    manager: { config: { enabled: false, connectionId: null, model: null, maxOutputTokens: 800, maxInputTokens: 8000, requestBudgetMicroUsd: 0, automatic: false }, queueReportIds: [], jobs: [], versions: [], proposals: [], automaticStarts: [], baselineAt: null },
  };
}

export function workflowState(state: TownState): WorkflowState {
  if (state.workspace.mode !== 'private') throw new WorkflowError('private_workspace_required', 'Model connections and paid work require a private workspace.', 403);
  return state.workflow ??= initialWorkflow();
}

export function billingDay(now: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('-');
}

function safeAmount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000) throw new WorkflowError('amount_invalid', 'Use a finite nonnegative amount in integer micro-USD.', 400);
}

export function estimatedCost(model: WorkflowModel, usage: WorkflowUsage): number {
  const rates = workflowModelSchema.parse(model);
  for (const value of [usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, usage.cacheWriteTokens]) safeAmount(value);
  if (usage.cachedInputTokens + usage.cacheWriteTokens > usage.inputTokens) throw new WorkflowError('usage_invalid', 'Provider token categories could not be reconciled.');
  const uncached = usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens;
  const numerator = BigInt(uncached) * BigInt(rates.inputPerMillionMicroUsd) + BigInt(usage.outputTokens) * BigInt(rates.outputPerMillionMicroUsd)
    + BigInt(usage.cachedInputTokens) * BigInt(rates.cachedInputPerMillionMicroUsd) + BigInt(usage.cacheWriteTokens) * BigInt(rates.cacheWritePerMillionMicroUsd);
  const result = Number((numerator + 999_999n) / 1_000_000n);
  safeAmount(result);
  return result;
}

export function maximumRequestCost(model: WorkflowModel, inputTokens: number, outputTokens: number): number {
  // Do not assume cache hits. Include the most expensive possible input category.
  const upper = Math.max(model.inputPerMillionMicroUsd, model.cachedInputPerMillionMicroUsd, model.cacheWritePerMillionMicroUsd);
  return estimatedCost({ ...model, inputPerMillionMicroUsd: upper }, { inputTokens, outputTokens, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, source: 'provider-reported' });
}

export interface ReserveRequest {
  id: string; runId: string; purpose: 'manager' | 'worker'; connectionId: string;
  model: WorkflowModel; amountMicroUsd: number; runBudgetMicroUsd: number;
}

export function reserveOperation(state: TownState, request: ReserveRequest, now: string): BudgetReservation {
  const workflow = workflowState(state);
  const policy = economyPolicySchema.parse(workflow.policy);
  safeAmount(request.amountMicroUsd); safeAmount(request.runBudgetMicroUsd);
  if (!request.id || !request.runId || request.id.length > 120 || request.runId.length > 120) throw new WorkflowError('reservation_invalid', 'A stable operation and run ID are required.', 400);
  if (workflow.reservations.some(reservation => reservation.id === request.id)) throw new WorkflowError('reservation_conflict', 'This operation already has a reservation.');
  if (!policy.paidEnabled) throw new WorkflowError('paid_work_disabled', 'Enable paid work with explicit limits first.');
  const connection = workflow.connections.find(value => value.id === request.connectionId);
  if (!connection || connection.status !== 'verified' || connection.mode !== 'api') throw new WorkflowError('connection_unavailable', 'The selected billing connection is unavailable. Choose a connection explicitly; no fallback is allowed.');
  const model = workflowModelSchema.parse(request.model);
  if (!connection.models.includes(model.model)) throw new WorkflowError('model_unavailable', 'The selected model was not returned by this connection. Verify it before launch.');
  const priceAge = Date.parse(now) - Date.parse(model.priceCheckedAt);
  if (priceAge < -60_000 || priceAge > 30 * 86_400_000) throw new WorkflowError('price_stale', 'Review the model price record before starting paid work.');
  if (model.qualityStatus !== 'user-attested' || !model.qualityNote.trim()) throw new WorkflowError('quality_review_required', 'Record your model quality review before enabling paid work. Agent Town has not evaluated this model.');
  if (request.amountMicroUsd <= 0 || request.runBudgetMicroUsd <= 0 || request.runBudgetMicroUsd > policy.maxRunBudgetMicroUsd) throw new WorkflowError('run_budget_invalid', 'Use a positive run allowance within the workspace run limit.');
  const runReservations = workflow.reservations.filter(value => value.runId === request.runId);
  if (runReservations.some(value => value.connectionId !== request.connectionId || value.purpose !== request.purpose || value.runBudgetMicroUsd !== request.runBudgetMicroUsd || JSON.stringify(value.model) !== JSON.stringify(model))) throw new WorkflowError('run_billing_locked', 'A run cannot change its selected billing connection, allowance, or model.');
  if (runReservations.some(value => value.status === 'uncertain')) throw new WorkflowError('usage_uncertain', 'Reconcile the uncertain operation before scheduling more work for this run.');
  const held = (value: BudgetReservation) => value.status === 'settled' ? value.actualMicroUsd! : value.amountMicroUsd;
  // 4/5 avoids float rounding on the 80% early-warning threshold; still a plain > for the hard cap.
  const near = (sum: number, limit: number) => sum * 5 >= limit * 4;
  const runTotal = runReservations.reduce((sum, value) => sum + held(value), request.amountMicroUsd);
  if (runTotal > request.runBudgetMicroUsd) throw new WorkflowError('run_budget_reached', 'This request exceeds the remaining run allowance.');
  const day = billingDay(now, policy.timeZone);
  // Old unsettled requests still consume allowance after midnight; no daily reset escape.
  const dayReservations = workflow.reservations.filter(value => value.day === day || value.status !== 'settled');
  const dayTotal = dayReservations.reduce((sum, value) => sum + held(value), request.amountMicroUsd);
  if (dayTotal > policy.dailyBudgetMicroUsd) throw new WorkflowError('daily_budget_reached', 'The workspace daily budget has no room for this request.');
  const managerTotal = request.purpose === 'manager' ? dayReservations.filter(value => value.purpose === 'manager').reduce((sum, value) => sum + held(value), request.amountMicroUsd) : 0;
  if (request.purpose === 'manager' && managerTotal > policy.managerDailyBudgetMicroUsd) throw new WorkflowError('manager_budget_reached', 'The manager daily allowance has no room for this request.');
  const nearLimit = near(runTotal, request.runBudgetMicroUsd) || near(dayTotal, policy.dailyBudgetMicroUsd) || (request.purpose === 'manager' && near(managerTotal, policy.managerDailyBudgetMicroUsd));
  const active = workflow.reservations.filter(value => value.status !== 'settled' && value.purpose === request.purpose);
  const activeRuns = new Set(active.map(value => value.runId));
  const concurrency = request.purpose === 'manager' ? 1 : policy.workerConcurrency;
  if (active.some(value => value.runId === request.runId) || activeRuns.size >= concurrency) throw new WorkflowError('concurrency_reached', 'Wait for the active operation or reconcile its usage before scheduling another.');
  if (workflow.reservations.length >= 10_000) throw new WorkflowError('usage_capacity', 'The local usage ledger is full. Export and apply a reviewed retention policy before more paid work.');
  const result: BudgetReservation = { id: request.id, runId: request.runId, purpose: request.purpose, connectionId: connection.id, provider: connection.provider, mode: 'api', model: structuredClone(model), amountMicroUsd: request.amountMicroUsd, runBudgetMicroUsd: request.runBudgetMicroUsd, actualMicroUsd: null, usage: null, status: 'reserved', day, createdAt: now, settledAt: null, settlementSource: null, nearLimit };
  workflow.reservations.push(result);
  return result;
}

export function settleReservation(state: TownState, id: string, usage: WorkflowUsage | null, now: string): BudgetReservation {
  const reservation = workflowState(state).reservations.find(value => value.id === id);
  if (!reservation) throw new WorkflowError('reservation_not_found', 'Budget reservation not found.', 404);
  if (reservation.status === 'settled') throw new WorkflowError('reservation_settled', 'This reservation has already been settled.');
  if (usage === null) { reservation.status = 'uncertain'; return reservation; }
  reservation.actualMicroUsd = estimatedCost(reservation.model, usage);
  reservation.usage = structuredClone(usage);
  reservation.status = 'settled';
  reservation.settledAt = now;
  reservation.settlementSource = usage.source === 'user-reconciled' ? 'user-reconciled' : 'provider-usage';
  // Actual reported usage may exceed an estimate. Keep the real amount; future
  // reservations then fail the budget gate instead of hiding an overrun.
  return reservation;
}

export function markReservationUncertain(state: TownState, id: string, now: string): BudgetReservation { return settleReservation(state, id, null, now); }

export function releaseReservation(state: TownState, id: string, now: string, reason: 'not-sent' | 'provider-rejected'): BudgetReservation {
  const reservation = workflowState(state).reservations.find(value => value.id === id);
  if (!reservation || reservation.status !== 'reserved') throw new WorkflowError('reservation_not_releasable', 'Only a known unsent or rejected reservation can be released.');
  reservation.status = 'settled'; reservation.actualMicroUsd = 0; reservation.usage = null; reservation.settledAt = now; reservation.settlementSource = reason;
  return reservation;
}

/**
 * The three checks eligibleForManager has always applied ('saved' status, the manager baseline,
 * and the Stop-watching hold), in the same order, factored out once so eligibleForManager and
 * managerEligibility (below) can never silently drift apart: managerEligibility calls this exact
 * function to decide the same three things, then reports which ONE excluded a report instead of
 * a plain boolean. Nothing else should call this directly.
 */
function savedReportBaseExclusion(report: Handoff, state: TownState): 'not-saved' | 'older-than-baseline' | 'held-after-stop' | null {
  if (report.status !== 'saved') return 'not-saved';
  const baseline = workflowState(state).manager.baselineAt;
  if (baseline && Date.parse(report.createdAt) < Date.parse(baseline)) return 'older-than-baseline';
  // H0-13 (Stop watching): while automatic manager processing is on, the final drain saves a
  // connection's last reports but holds them out of the automatic queue (D47's default); the
  // owner can still pick a held report by hand into a packet. H0-24 extends this same list.
  if (state.observation?.heldFromManagerReportIds?.includes(report.id)) return 'held-after-stop';
  return null;
}

/**
 * Whether a saved report may ever be queued for manager processing (automatic or explicit).
 * Used by queueManagerReports and managerQueueStatus so they never disagree about what is
 * actually eligible. Project-level exclusion (a future reviewed owner selection) does not
 * exist yet, so it excludes nothing here today.
 */
export function eligibleForManager(report: Handoff, state: TownState): boolean {
  return savedReportBaseExclusion(report, state) === null;
}

export interface ManagerEligibilityResult {
  eligibleIds: string[];
  excluded: { id: string; reason: ManagerExclusionReason }[];
}

/**
 * The richer selector behind the manager's saved-report queue status and its UI (MG-42): every
 * 'saved' report, split into what is eligible right now and what is excluded and why. Reuses
 * eligibleForManager's own three checks (via savedReportBaseExclusion) so a 'saved' report's
 * presence in eligibleIds can never disagree with eligibleForManager(report, state) — except for
 * the two ADDITIVE reasons below, which eligibleForManager has never covered and must keep not
 * covering, preserving its existing pass/fail semantics for every other caller:
 *  - 'already-processing': claimed by a running/uncertain/processed job. The same check
 *    queueManagerReports has always layered on top separately (heldReports, below).
 *  - 'wrong-scope': the report's repository is no longer connected. Today only checked
 *    separately, and inconsistently, by managerQueueStatus (the oldest "eligible" report only)
 *    and processManager (aborts the whole dispatch attempt if any selected candidate hits it).
 */
export function managerEligibility(state: TownState): ManagerEligibilityResult {
  const workflow = workflowState(state);
  const heldReports = new Set(workflow.manager.jobs.filter(job => job.status === 'running' || job.status === 'uncertain' || job.status === 'processed').flatMap(job => job.reportIds));
  const eligibleIds: string[] = [];
  const excluded: { id: string; reason: ManagerExclusionReason }[] = [];
  for (const report of state.handoffs) {
    if (report.status !== 'saved') continue;
    const base = savedReportBaseExclusion(report, state);
    if (base === 'older-than-baseline' || base === 'held-after-stop') { excluded.push({ id: report.id, reason: base }); continue; }
    if (heldReports.has(report.id)) { excluded.push({ id: report.id, reason: 'already-processing' }); continue; }
    if (!state.repositories.some(repo => repo.id === report.repoId)) { excluded.push({ id: report.id, reason: 'wrong-scope' }); continue; }
    eligibleIds.push(report.id);
  }
  return { eligibleIds, excluded };
}

export function queueManagerReports(state: TownState): void {
  const workflow = workflowState(state);
  const heldReports = new Set(workflow.manager.jobs.filter(job => job.status === 'running' || job.status === 'uncertain' || job.status === 'processed').flatMap(job => job.reportIds));
  workflow.manager.queueReportIds = [...new Set(state.handoffs.filter(report => eligibleForManager(report, state) && !heldReports.has(report.id)).map(report => report.id))];
}
