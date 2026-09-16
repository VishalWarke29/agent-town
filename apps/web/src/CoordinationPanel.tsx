import { useEffect, useState } from 'react';
import type { CoordinationPlan, TownState } from '@agent-town/contracts';
import type { IdentityController } from './useIdentity';

export function CoordinationPanel({ state, identity }: { state: TownState; identity: IdentityController }) {
  const [plan, setPlan] = useState<CoordinationPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Ignore unrelated telemetry/animation events and unopened advice panels.
  const revision = expanded ? JSON.stringify([state.runner, state.manager, state.handoffs, state.workflow?.manager.versions.at(-1),
    state.repositories.map(repo => [repo.id, repo.localPath, repo.git]), state.workflow?.policy.workerConcurrency]) : '';
  useEffect(() => {
    if (!expanded) return;
    let disposed = false;
    setPlan(null); setError(null);
    void identity.read<CoordinationPlan>(`/workspaces/${encodeURIComponent(state.workspace.id)}/coordination`).then(result => {
      if (result?.schemaVersion !== 1 || result.advisoryOnly !== true || !Array.isArray(result.tasks) || !Array.isArray(result.suggestedTaskIds) || !result.capacity) throw new Error('Invalid coordination response');
      if (!disposed) setPlan(result);
    }).catch(() => { if (!disposed) setError('Task coordination is unavailable. Approval still checks the saved dependencies, repository, and limits.'); });
    return () => { disposed = true; };
  }, [identity.read, state.workspace.id, expanded, revision]);
  const tasks = state.runner?.tasks ?? [];
  const open = plan?.tasks.filter(task => task.state !== 'closed') ?? [];
  return <details className="workflow-details" onToggle={event => setExpanded(event.currentTarget.open)}><summary>Task coordination · zero AI calls</summary>
    {error ? <p className="form-error" role="status">{error}</p> : !plan ? <p className="muted" role="status">Checking saved task dependencies…</p> : <>
      <p className="muted small">{plan.capacity.active} active · {plan.capacity.available} of {plan.capacity.limit} worker slots available. Each new task still needs your approval.</p>
      {!open.length && <p className="empty">No open tasks. Add a draft to check dependencies and overlapping work.</p>}
      {open.map(task => <article className="observation-card" key={task.taskId}>
        <strong>{tasks.find(value => value.id === task.taskId)?.draft.objective ?? task.taskId}</strong>
        <p>{task.state.replaceAll('-', ' ')}{plan.suggestedTaskIds.includes(task.taskId) ? ' · suggested for your review' : ''}</p>
        {task.issues.length ? <ul>{task.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul> : <p className="muted small">No saved dependency or repository conflicts found. Execution checks still run at approval.</p>}
      </article>)}
      <p className="muted small">Independent repositories can use separate slots. Tasks in the same repository run one at a time. Accepting a prerequisite does not merge its changes; review the repository before drafting dependent work.</p>
    </>}
  </details>;
}
