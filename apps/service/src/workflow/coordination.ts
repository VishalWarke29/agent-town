import { createHash } from 'node:crypto';
import { hasCurrentSourceFingerprint, type CreateRunDraft, type RunnerTask, type TownState, type CoordinationIssue, type CoordinationPlan, type TaskCoordination } from '@agent-town/contracts';
import { buildWorkerContext } from './context.js';

const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
/** Exact normalized intent, not a semantic similarity or a proof of equivalent work. */
export function taskIntentFingerprint(draft: Pick<CreateRunDraft, 'repoId' | 'objective' | 'acceptanceCriteria'>): string {
  return createHash('sha256').update(JSON.stringify([draft.repoId, normalize(draft.objective), [...new Set(draft.acceptanceCriteria.map(normalize))].sort()])).digest('hex');
}

export const unfinishedTask = (task: RunnerTask): boolean => !task.archivedAt && ['draft', 'approved', 'running', 'awaiting_review'].includes(task.status);

/** Saved evidence only. Suggestions never authorize a run or establish billing/native readiness. */
export function buildCoordinationPlan(state: TownState): CoordinationPlan {
  const tasks = state.runner?.tasks ?? [];
  const runs = state.runner?.runs ?? [];
  const byId = new Map(tasks.map(task => [task.id, task]));
  const runByTask = new Map(runs.map(run => [run.taskId, run]));
  const activeRuns = runs.filter(run => run.status === 'starting' || run.status === 'running');
  const limit = state.workflow?.policy.workerConcurrency ?? 1;
  const available = Math.max(0, limit - activeRuns.length);
  const intents = new Map(tasks.map(task => [task.id, taskIntentFingerprint(task.draft)]));
  const fingerprints = new Map<string, RunnerTask[]>();
  for (const task of tasks.filter(unfinishedTask)) {
    const key = intents.get(task.id)!;
    const group = fingerprints.get(key) ?? [];
    group.push(task); fingerprints.set(key, group);
  }
  const normalizePath = (file: string) => file.replaceAll('\\', '/').toLowerCase();
  const fileOwners = new Map<string, Map<string, Set<string>>>();
  for (const run of runs) {
    const task = byId.get(run.taskId);
    if (!task || !unfinishedTask(task) || !['starting', 'running', 'awaiting_review'].includes(run.status)) continue;
    const repository = fileOwners.get(task.draft.repoId) ?? new Map<string, Set<string>>();
    for (const path of run.changedFiles) {
      const key = normalizePath(path), owners = repository.get(key) ?? new Set<string>();
      owners.add(task.id); repository.set(key, owners);
    }
    fileOwners.set(task.draft.repoId, repository);
  }
  // Defensive cycle detection also covers old or manually damaged saved data.
  const cyclic = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) { for (const member of path.slice(path.indexOf(id))) cyclic.add(member); return; }
    if (visited.has(id)) return;
    visiting.add(id); path.push(id);
    for (const dependency of byId.get(id)?.draft.dependencyTaskIds ?? []) if (byId.has(dependency)) visit(dependency);
    path.pop(); visiting.delete(id); visited.add(id);
  };
  for (const task of tasks) visit(task.id);
  const planned: TaskCoordination[] = tasks.map(task => {
    const dependencies = task.draft.dependencyTaskIds ?? [];
    const issues: CoordinationIssue[] = [];
    const issue = (code: CoordinationIssue['code'], severity: CoordinationIssue['severity'], message: string, related: string[] = [], evidence: string[] = []) => {
      issues.push({ code, severity, message: related.length > 20 ? `${message} Showing 20 of ${related.length} related tasks.` : message, relatedTaskIds: related.slice(0, 20), evidence: evidence.slice(0, 8) });
    };
    const run = runByTask.get(task.id);
    const active = run?.status === 'starting' || run?.status === 'running';
    let status: TaskCoordination['state'] = task.archivedAt ? 'closed' : active || task.status === 'approved' || task.status === 'running' ? 'active'
      : task.status === 'awaiting_review' ? 'human-review' : task.status === 'draft' ? 'reviewable' : 'closed';
    if (status === 'closed') return { taskId: task.id, repoId: task.draft.repoId, state: status, dependencyTaskIds: dependencies, issues };
    if (task.status === 'awaiting_review') issue('awaiting-review', 'block', 'The saved result needs a human decision. Acceptance does not merge its worktree.', [], run ? [`run:${run.id}`, ...(run.reportId ? [`report:${run.reportId}`] : [])] : []);
    if (cyclic.has(task.id)) issue('dependency-cycle', 'block', 'Saved prerequisites contain a cycle. Review these tasks before execution.', dependencies, [`task:${task.id}`]);
    const missing = dependencies.filter(id => !byId.has(id));
    if (missing.length) issue('dependency-missing', 'block', 'A prerequisite task is unavailable in this workspace.', missing);
    const waiting = dependencies.filter(id => byId.has(id) && byId.get(id)!.status !== 'accepted');
    if (waiting.length) issue('dependency-waiting', 'block', 'Every prerequisite requires human acceptance before approval.', waiting, waiting.slice(0, 8).map(id => `task:${id}:${byId.get(id)!.status}`));
    const unintegrated = dependencies.filter(id => {
      const prerequisite = byId.get(id), priorRun = runByTask.get(id);
      return prerequisite?.status === 'accepted' && (!priorRun || priorRun.changedFilesUnavailable === true || priorRun.changedFiles.length > 0)
        && (!prerequisite.integration || !hasCurrentSourceFingerprint(priorRun?.sourceFingerprint));
    });
    if (unintegrated.length) issue('integration-required', 'block', 'Accepted prerequisite changes need verified integration with current file-mode evidence. Unknown inventory or older evidence needs a new reviewed attempt; acceptance alone is insufficient.', unintegrated, unintegrated.slice(0, 8).map(id => `task:${id}:integration-unverified`));
    const duplicates = (fingerprints.get(intents.get(task.id)!) ?? []).filter(other => other.id !== task.id);
    if (duplicates.length) issue('duplicate-task', duplicates.some(other => other.status !== 'draft') ? 'block' : 'review', 'Another unfinished task has the same normalized objective and acceptance criteria in this repository.', duplicates.map(other => other.id), ['comparison:normalized-exact-intent']);
    if (task.status === 'draft') {
      const repository = state.repositories.find(repo => repo.id === task.draft.repoId);
      if (!repository?.localPath || repository.git?.availability !== 'available' || !repository.git.head) issue('repository-unavailable', 'block', 'A selected local repository and a current Git base are required.', [], [`repo:${task.draft.repoId}`]);
      else if (repository.git.head !== task.baseCommit) issue('base-changed', 'block', 'The saved Git base differs from this draft. Create and review a fresh draft.', [], [`draft-base:${task.baseCommit}`, `observed-base:${repository.git.head}`]);
      if (task.contextVersion !== state.manager.version) issue('stale-context', 'block', 'A newer shared brief exists. Create and review a fresh draft to pin it.', [], [`draft-context:${task.contextVersion}`, `current-context:${state.manager.version}`]);
      else if (dependencies.length) {
        let changed = true;
        try { changed = buildWorkerContext(state, task.draft) !== task.contextBrief; } catch { /* An unbuildable evidence bundle cannot establish a current draft. */ }
        if (changed) issue('stale-context', 'block', 'Prerequisite evidence changed or is unavailable. Create and review a fresh draft after acceptance.', dependencies, [`task:${task.id}`, 'comparison:pinned-prerequisite-evidence']);
      }
      const conflicting = activeRuns.filter(item => byId.get(item.taskId)?.draft.repoId === task.draft.repoId);
      if (conflicting.length) issue('repository-active', 'block', 'A managed run is active in this repository. Unknown file scope requires serialized approval.', conflicting.map(item => item.taskId), conflicting.map(item => `run:${item.id}`));
      if (!available) issue('capacity', 'block', 'The configured worker slots are occupied.', activeRuns.map(item => item.taskId), [`worker-limit:${limit}`, `active-runs:${activeRuns.length}`]);
    }
    if (run?.changedFiles.length) {
      const overlapping = new Set<string>();
      for (const path of run.changedFiles) {
        for (const otherId of fileOwners.get(task.draft.repoId)?.get(normalizePath(path)) ?? []) {
          if (otherId !== task.id) overlapping.add(otherId);
          if (overlapping.size >= 20) break;
        }
        if (overlapping.size >= 20) break;
      }
      const ids = [...overlapping];
      if (ids.length) issue('file-overlap', 'review', 'Saved changed-file paths overlap. This is a review signal, not a verified Git merge conflict. Related evidence is capped at 20 tasks.', ids, ids.map(id => `run:${runByTask.get(id)!.id}`));
    }
    if (status === 'reviewable' && issues.some(item => item.severity === 'block')) status = 'waiting';
    return { taskId: task.id, repoId: task.draft.repoId, state: status, dependencyTaskIds: dependencies, issues };
  });
  const suggestedTaskIds: string[] = [];
  const selectedRepos = new Set<string>();
  const selectedIntents = new Set<string>();
  const resultById = new Map(planned.map(task => [task.taskId, task]));
  for (const task of [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    if (suggestedTaskIds.length >= available) break;
    const intent = intents.get(task.id)!;
    if (resultById.get(task.id)?.state !== 'reviewable' || selectedRepos.has(task.draft.repoId) || selectedIntents.has(intent)) continue;
    suggestedTaskIds.push(task.id); selectedRepos.add(task.draft.repoId); selectedIntents.add(intent);
  }
  return { schemaVersion: 1, advisoryOnly: true, inferenceCalls: 0, contextVersion: state.manager.version,
    capacity: { limit, active: activeRuns.length, available }, tasks: planned, suggestedTaskIds };
}
