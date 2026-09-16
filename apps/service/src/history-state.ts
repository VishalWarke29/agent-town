import { createHash } from 'node:crypto';
import type { Agent, AgentArchiveReview, RootRemovalReview, TownState } from '@agent-town/contracts';
import { IdentityError } from './identity/types.js';

export function archiveReview(state: TownState, agent: Agent): AgentArchiveReview {
  const repository = state.repositories.find(repo => repo.id === agent.repoId);
  const run = state.runner?.runs.find(run => run.id === agent.id);
  const task = run && state.runner?.tasks.find(task => task.id === run.taskId);
  const connection = agent.observation && state.observation?.connections.find(connection => connection.id === agent.observation!.connectionId);
  const reasons: string[] = [];
  if (!repository) reasons.push('Restore the selected repository metadata before archiving this session.');
  if (agent.observation) {
    if (!['offline', 'cancelled'].includes(agent.activity) && connection?.status !== 'revoked') reasons.push('Wait for the external session to end, or revoke its observation connection before archiving. A stale update alone does not prove it stopped.');
  } else if (agent.discovery) { /* Archiving metadata does not claim the native session stopped. */ }
  else if (!run || !task) reasons.push('This session has no verified terminal run record.');
  else if (run.status === 'running' || run.status === 'starting' || !run.finishedAt || ['draft', 'approved', 'running', 'awaiting_review'].includes(task.status)) reasons.push('Finish or cancel the managed run and review its result before archiving.');
  const reviewToken = createHash('sha256').update(JSON.stringify({ agent, repository, run, task, connectionStatus: connection?.status })).digest('hex');
  return { agentId: agent.id, name: agent.name, repositoryName: repository?.name ?? 'Unavailable repository', allowed: !reasons.length, reasons, reportCount: state.handoffs.filter(report => report.agentId === agent.id).length, reviewToken };
}

export function requireRepositoryRemovable(state: TownState, ids: Set<string>): void {
  if (state.agents.some(agent => ids.has(agent.repoId))) throw new IdentityError('REPOSITORY_IN_USE', 'Archive the ended sessions for this repository first. Active work must finish before it can be archived.', 409);
  if (state.observation?.connections.some(connection => ids.has(connection.repoId) && connection.status !== 'revoked')) throw new IdentityError('REPOSITORY_IN_USE', 'Remove installed observation hooks, then revoke the repository’s observation connections before disconnecting it.', 409);
  if (state.telemetry?.sources?.some(source => ids.has(source.repoId) && source.status !== 'revoked')) throw new IdentityError('REPOSITORY_IN_USE', 'Revoke the repository’s telemetry sources before disconnecting it.', 409);
  if (state.runner?.tasks.some(task => ids.has(task.draft.repoId) && (!task.archivedAt || ['approved', 'running', 'awaiting_review'].includes(task.status)))) throw new IdentityError('REPOSITORY_IN_USE', 'Review and archive the repository’s task drafts and attempts before disconnecting it.', 409);
  if (state.telemetry?.inventoryOperation?.status === 'running' && ids.has(state.telemetry.inventoryOperation.repoId)) throw new IdentityError('REPOSITORY_IN_USE', 'Wait for the source API scan to finish before disconnecting this repository.', 409);
}

export function rootRemovalReview(state: TownState, path: string): RootRemovalReview {
  if (!state.discovery?.roots.includes(path)) throw new IdentityError('ROOT_NOT_FOUND', 'Choose a currently allowed folder.', 404);
  const repositories = state.repositories.filter(repo => repo.selectedRoot === path);
  const reasons: string[] = [];
  try { requireRepositoryRemovable(state, new Set(repositories.map(repo => repo.id))); }
  catch (error) { if (error instanceof IdentityError) reasons.push(error.message); else throw error; }
  const reviewToken = createHash('sha256').update(JSON.stringify({ path, repositories, candidates: state.discovery.candidates.filter(repo => repo.selectedRoot === path).map(repo => repo.id) })).digest('hex');
  return { path, repositories: repositories.map(repo => ({ id: repo.id, name: repo.name })), allowed: !reasons.length, reasons, reviewToken };
}
