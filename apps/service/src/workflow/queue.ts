import { createHash } from 'node:crypto';
import type { ManagerQueueStatus, TownState } from '@agent-town/contracts';
import { billingDay, managerEligibility, maximumRequestCost, reserveOperation, WorkflowError, workflowState } from './budget.js';
import { buildManagerInput } from './context.js';

export function queueBasis(state: TownState, now: string): string {
  const workflow = workflowState(state);
  return createHash('sha256').update(JSON.stringify({ config: workflow.manager.config, policy: workflow.policy, baselineAt: workflow.manager.baselineAt ?? null,
    connections: workflow.connections, reservations: workflow.reservations, reports: state.handoffs, contextVersion: state.manager.version,
    jobs: workflow.manager.jobs.map(job => ({ id: job.id, status: job.status })), repositories: state.repositories.map(repo => repo.id),
    tasks: state.runner?.tasks.map(task => ({ id: task.id, draft: task.draft, status: task.status, contextVersion: task.contextVersion, baseCommit: task.baseCommit, integration: task.integration })),
    reportLinks: state.runner?.runs.map(run => ({ taskId: run.taskId, reportId: run.reportId })),
    day: billingDay(now, workflow.policy.timeZone) })).digest('hex');
}

/** Saved/local facts only. This is never a substitute for atomic dispatch gates. */
export function managerQueueStatus(state: TownState, now: string): ManagerQueueStatus {
  const workflow = workflowState(state), manager = workflow.manager, config = manager.config;
  const reports = state.handoffs.filter(report => report.status === 'saved').sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  // Computed once and attached to every returned status (MG-42): the client (ManagerQueue,
  // ManagerPanel) can then show an accurate eligible-vs-total count and a per-report reason
  // without a dedicated new endpoint or its own re-implementation of this selector.
  const { eligibleIds, excluded } = managerEligibility(state);
  const make = (status: ManagerQueueStatus['state'], code: string, message: string, retryAt: string | null = null): ManagerQueueStatus => ({
    state: status, code, message, reportIds: reports.map(report => report.id), pendingCount: reports.length, checkedAt: now, retryAt, inferenceCalls: 0, dispatchVerified: false, excluded,
  });
  if (manager.jobs.some(job => job.status === 'running')) return make('running', 'manager_running', 'A saved manager request is in progress. New reports remain queued for a later batch.');
  if (!reports.length) return make('idle', 'manager_no_reports', 'No saved reports are waiting. Opening this panel starts no model call.');
  if (!config.enabled || !workflow.policy.paidEnabled || !config.connectionId || !config.model) return make('waiting', 'manager_disabled', 'Reports are saved. Enable the manager with its reviewed account, model and limits to process them.');
  if (manager.jobs.some(job => job.status === 'uncertain') || workflow.reservations.some(reservation => reservation.purpose === 'manager' && reservation.status !== 'settled')) return make('waiting', 'manager_reconciliation_required', 'The previous manager request has unsettled usage. Reconcile it before another request.');
  if (manager.jobs.length >= 1000 || manager.versions.length >= 1000) return make('waiting', 'manager_capacity', 'Manager history is full. Review retention before more processing.');
  // An output-only reservation is a lower bound, sufficient to prove a known
  // local gate is closed. No token count, credential lookup or reservation is sent.
  try {
    reserveOperation(structuredClone(state), { id: 'queue-local-check', runId: 'queue-local-check', purpose: 'manager', connectionId: config.connectionId,
      model: config.model, amountMicroUsd: Math.max(1, maximumRequestCost(config.model, 0, config.maxOutputTokens)), runBudgetMicroUsd: config.requestBudgetMicroUsd }, now);
  } catch (error) { return error instanceof WorkflowError ? make('waiting', error.code, error.message) : make('waiting', 'manager_configuration_invalid', 'Review the saved manager configuration before processing.'); }
  const failed = new Set(manager.jobs.filter(job => job.status === 'failed').flatMap(job => job.reportIds));
  const retryable = reports.filter(report => !failed.has(report.id));
  if (!retryable.length) return make('waiting', 'manager_explicit_retry', 'Previous attempts failed. Review the saved operation and use the explicit paid action to retry; automatic retry is disabled.');
  const eligible = retryable.filter(report => eligibleIds.includes(report.id));
  if (!eligible.length) {
    // Every retryable report is in `excluded` (managerEligibility partitions every 'saved'
    // report into eligibleIds or excluded, and retryable is a subset of the saved reports).
    // Name the true reason instead of always blaming "older than baseline" (the bug this fixes):
    // one distinct message per single reason, and an honest "more than one reason" message when
    // the excluded reports do not all share the same one.
    const reasons = new Set(retryable.map(report => excluded.find(item => item.id === report.id)!.reason));
    if (reasons.size === 1) {
      const [reason] = reasons;
      if (reason === 'held-after-stop') return make('waiting', 'manager_held_after_stop', 'The saved reports are held after Stop watching. They stay out of both automatic and explicit processing until a held report is chosen by hand into a packet, or the connection is watched again.');
      if (reason === 'older-than-baseline') return make('waiting', 'manager_baseline_pending', 'The saved reports are older than when the manager started. They are excluded from processing until a reviewed way to include older reports exists; newer reports are unaffected.');
      if (reason === 'wrong-scope') return make('waiting', 'report_repository_missing', 'The saved reports reference a repository that is no longer connected. Review their evidence before processing.');
      if (reason === 'already-processing') return make('waiting', 'manager_already_processing', 'Every saved report is already claimed by another manager operation. Wait for it to finish or reconcile its outcome.');
    }
    return make('waiting', 'manager_reports_excluded', 'Saved reports are excluded from processing for more than one reason. Review each report below to see why it is held.');
  }
  try { if (buildManagerInput(state, [eligible[0]]).evidence.inputBytes > 100000) return make('waiting', 'manager_input_large', 'One report and the saved context exceed the byte bound. Review the evidence or context before processing.'); }
  catch (error) { return make('waiting', error instanceof WorkflowError ? error.code : 'manager_input_invalid', 'The saved report bundle needs review before processing.'); }
  const saved = manager.waitingStatus;
  // A transient wait releases itself once its backoff time passes, even with no other
  // change, so scheduling can retry without waiting for queueBasis to change.
  if (saved?.state === 'waiting' && saved.basisHash === queueBasis(state, now) && (!saved.retryAt || Date.parse(now) < Date.parse(saved.retryAt)))
    return { ...saved, checkedAt: now, reportIds: reports.map(report => report.id), pendingCount: reports.length };
  const start = Date.parse(eligible[0].createdAt) + 30000;
  if (Date.parse(now) < start) return make('waiting', 'manager_batch_waiting', 'Automatic processing is waiting for the 30-second report batch window. The explicit paid action can process eligible reports sooner.', new Date(start).toISOString());
  const starts = manager.automaticStarts.filter(value => Date.parse(now) - Date.parse(value) < 3600000).sort();
  if (starts.length >= 6) return make('waiting', 'manager_hourly_limit', 'Six automatic batches started this hour. Reports remain saved; the explicit paid action still requires all budget checks.', new Date(Date.parse(starts[0]) + 3600000).toISOString());
  return make('ready', 'manager_dispatch_checks', 'Reports are ready for the next scheduling check. Credentials, exact input size and remaining budget are rechecked before any inference. Worker prerequisite waits do not prevent summaries.');
}
