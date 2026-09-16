import type { HandoffDetails, ManagedRun, RunnerTask, TownState } from '@agent-town/contracts';
import { queueManagerReports } from './budget.js';
import { sanitizeModelText } from './provider.js';

/** Terminal outcomes are evidence, not human acceptance. Save even before an agent was created. */
export function saveManagedRunReport(state: TownState, run: ManagedRun, task: RunnerTask | undefined, now: string, sourceEventId: string, filesObserved: boolean): void {
  const repoId = task?.draft.repoId ?? state.agents.find(agent => agent.id === run.id)?.repoId;
  if (!repoId) return;
  run.reportId ??= `report-${run.id}`;
  if (state.handoffs.some(report => report.id === run.reportId)) return;
  const outcome: HandoffDetails['outcome'] = run.status === 'awaiting_review' ? 'ready-for-review' : run.status === 'cancelled' ? 'cancelled' : run.status === 'interrupted' ? 'interrupted' : 'failed';
  state.handoffs.push({ id: run.reportId, agentId: run.id, repoId, summary: sanitizeModelText(run.message ?? 'The managed run ended without a final response. Evidence is incomplete.'),
    createdAt: now, status: 'saved', contextVersion: null, delivery: 'unsupported',
    details: { outcome, taskId: run.taskId, runId: run.id, sourceEventId, occurredAt: run.finishedAt ?? now,
      contextVersionUsed: run.contextDelivery === 'provider-acknowledged' ? run.contextVersion : null,
      baseCommit: task?.baseCommit ?? null, branch: run.branch, worktreePath: run.worktreePath,
      files: { status: filesObserved ? 'observed' : 'unavailable', paths: filesObserved ? [...run.changedFiles] : [] },
      checks: [{ name: 'Worker check results', result: 'unavailable', evidence: 'unavailable', reference: null }],
      decisions: [], assumptions: [], remainingWork: outcome === 'ready-for-review' ? ['Human review and integration remain pending.'] : ['Review retained work and usage before approving another attempt.'],
      evidenceRefs: [sourceEventId, `run:${run.id}`, `task:${run.taskId}`],
      limitations: ['Worker prose is a reported claim; structured check results, decisions and assumptions were not supplied by this execution adapter.', ...(filesObserved ? [] : ['The changed-file inventory is unavailable.']), 'Saving or processing this report does not accept the task or integrate its worktree.'],
    } });
  queueManagerReports(state);
}
